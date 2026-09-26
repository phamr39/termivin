import 'dart:async';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../core/client.dart';
import '../core/models.dart';
import 'approval_card.dart';
import 'term_actions.dart';
import 'theme.dart';
import 'widgets.dart';

/// Live view of one terminal on the PC. Read-only by default — quick-reply
/// keys cover prompts; free typing needs the "input" scope and a tap on ⌨.
/// The phone never resizes the PC's terminal: it renders at the PC's size
/// and scrolls sideways.
class TerminalScreen extends StatefulWidget {
  const TerminalScreen({super.key, required this.client, required this.hostId, required this.termId});
  final RelayClient client;
  final String hostId;
  final String termId;

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late Terminal _term;
  final _focus = FocusNode();
  final _hScroll = ScrollController();
  StreamSubscription? _screenSub;
  StreamSubscription? _frameSub;
  int _expected = 0; // next output seq we should see
  bool _haveScreen = false;
  bool _stopped = false;
  bool _writing = false;
  bool _keyboard = false;
  double _font = 11;
  int _cols = 80;
  int _rows = 24;

  RelayClient get client => widget.client;

  @override
  void initState() {
    super.initState();
    _term = _newTerminal();
    _screenSub = client.screenEvents.listen((e) {
      if (e.hostId != widget.hostId || e.termId != widget.termId) return;
      _applyScreen(e);
    });
    _frameSub = client.frames.listen((f) {
      if (f.hostId != widget.hostId || f.termId != widget.termId || !_haveScreen) return;
      _applyFrame(f);
    });
    client.subscribe(widget.hostId, widget.termId);
  }

  Terminal _newTerminal() => Terminal(
        maxLines: 5000,
        onOutput: (data) {
          // Replies the emulator itself generates while parsing PC output
          // (cursor reports etc.) must not be sent back — the PC's own
          // terminal already answered them.
          if (_writing || !_keyboard) return;
          client.cmd(widget.hostId, 'term.input', {'termId': widget.termId, 'data': data}).catchError((_) => null);
        },
      );

  void _write(String data) {
    _writing = true;
    try {
      _term.write(data);
    } finally {
      _writing = false;
    }
  }

  void _applyScreen(ScreenEvent e) {
    setState(() {
      _term = _newTerminal();
      _cols = e.cols;
      _rows = e.rows;
      _term.resize(e.cols, e.rows);
      _write(e.data);
      _expected = e.seq;
      _haveScreen = true;
      _stopped = e.stopped;
    });
  }

  void _applyFrame(PtyFrame f) {
    final end = f.seq + f.data.length;
    if (end <= _expected) return; // already have it
    if (f.seq > _expected) {
      // Missed output (e.g. reconnect): ask for a fresh screen.
      _haveScreen = false;
      client.unsubscribe(widget.hostId, widget.termId);
      client.subscribe(widget.hostId, widget.termId);
      return;
    }
    _write(f.data.substring(_expected - f.seq));
    _expected = end;
    if (_stopped) setState(() => _stopped = false);
  }

  @override
  void dispose() {
    _screenSub?.cancel();
    _frameSub?.cancel();
    client.unsubscribe(widget.hostId, widget.termId);
    _focus.dispose();
    _hScroll.dispose();
    super.dispose();
  }

  Future<void> _keys(List<String> keys) async {
    await guarded(context, () => client.cmd(widget.hostId, 'term.keys', {'termId': widget.termId, 'keys': keys}));
  }

  double _charWidth() {
    final tp = TextPainter(
      text: TextSpan(text: 'MMMMMMMMMM', style: TextStyle(fontFamily: 'monospace', fontSize: _font)),
      textDirection: TextDirection.ltr,
    )..layout();
    return tp.width / 10;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) {
        final host = client.hosts[widget.hostId];
        final online = client.state == ConnState.connected && (host?.online ?? false);
        final found = client.snapshots[widget.hostId]?.find(widget.termId);
        final t = found?.term;
        final pending = (client.attention[widget.hostId] ?? const <AttentionItem>[])
            .where((a) => a.kind == 'approval' && a.termId == widget.termId)
            .toList();
        final canKeys = online && (host?.can('approve') ?? false);
        final canType = online && (host?.can('input') ?? false);
        final width = _cols * _charWidth() + 12;

        return Scaffold(
          appBar: AppBar(
            titleSpacing: 0,
            title: Row(children: [
              CharacterAvatar(type: t?.type, status: t?.status, size: 32),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(t?.name ?? 'Terminal', style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
                  Text('${TV.statusLabel(t?.status)} · $_cols×$_rows',
                      style: TextStyle(fontSize: 11.5, color: TV.status(t?.status))),
                ]),
              ),
            ]),
            actions: [
              IconButton(
                tooltip: 'Smaller',
                icon: const Icon(Icons.text_decrease_rounded),
                onPressed: () => setState(() => _font = (_font - 1).clamp(7, 20)),
              ),
              IconButton(
                tooltip: 'Larger',
                icon: const Icon(Icons.text_increase_rounded),
                onPressed: () => setState(() => _font = (_font + 1).clamp(7, 20)),
              ),
              if (found != null)
                IconButton(
                  icon: const Icon(Icons.more_vert_rounded),
                  onPressed: () => showTermActions(context, widget.hostId, found.ws, found.term, fromTerminal: true),
                ),
            ],
          ),
          body: Column(children: [
            ConnectionBanner(client: client),
            Expanded(
              child: Container(
                color: const Color(0xFF0B0E11),
                child: !_haveScreen
                    ? const Center(child: CircularProgressIndicator())
                    : Stack(children: [
                        Scrollbar(
                          controller: _hScroll,
                          child: SingleChildScrollView(
                            controller: _hScroll,
                            scrollDirection: Axis.horizontal,
                            child: SizedBox(
                              width: width,
                              child: TerminalView(
                                _term,
                                key: ValueKey(_term),
                                focusNode: _focus,
                                autoResize: false,
                                readOnly: !_keyboard,
                                autofocus: _keyboard,
                                padding: const EdgeInsets.all(6),
                                textStyle: TerminalStyle(fontSize: _font, fontFamily: 'monospace'),
                                theme: _theme,
                                keyboardType: TextInputType.text,
                              ),
                            ),
                          ),
                        ),
                        if (_stopped)
                          Positioned.fill(
                            child: Container(
                              color: Colors.black54,
                              alignment: Alignment.center,
                              child: Column(mainAxisSize: MainAxisSize.min, children: [
                                const Text('Not running', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                                const SizedBox(height: 10),
                                FilledButton.icon(
                                  onPressed: online && (host?.can('manage') ?? false)
                                      ? () => guarded(context, () => client.cmd(widget.hostId, 'term.restore', {'termId': widget.termId}))
                                      : null,
                                  icon: const Icon(Icons.play_arrow_rounded),
                                  label: const Text('Resume'),
                                ),
                              ]),
                            ),
                          ),
                      ]),
              ),
            ),
            for (final a in pending.take(1))
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
                child: AttentionCard(client: client, hostId: widget.hostId, item: a, compact: true),
              ),
            _QuickKeys(
              enabled: canKeys,
              keyboard: _keyboard,
              canType: canType,
              onKeys: _keys,
              onToggleKeyboard: () {
                setState(() => _keyboard = !_keyboard);
                if (_keyboard) {
                  Future.delayed(const Duration(milliseconds: 50), () => _focus.requestFocus());
                } else {
                  _focus.unfocus();
                }
              },
            ),
          ]),
        );
      },
    );
  }

  static final _theme = TerminalTheme(
    cursor: const Color(0xFFD8DEE6),
    selection: const Color(0x664E9AF5),
    foreground: const Color(0xFFD8DEE6),
    background: const Color(0xFF0B0E11),
    black: const Color(0xFF1B2027),
    red: const Color(0xFFE05D5D),
    green: const Color(0xFF3FB26F),
    yellow: const Color(0xFFE8A13C),
    blue: const Color(0xFF4E9AF5),
    magenta: const Color(0xFFB48CE8),
    cyan: const Color(0xFF4EC9D8),
    white: const Color(0xFFD8DEE6),
    brightBlack: const Color(0xFF5C6773),
    brightRed: const Color(0xFFFF7B7B),
    brightGreen: const Color(0xFF5FD38D),
    brightYellow: const Color(0xFFF5C26B),
    brightBlue: const Color(0xFF7DB7FF),
    brightMagenta: const Color(0xFFD2B0FF),
    brightCyan: const Color(0xFF7FE3EE),
    brightWhite: const Color(0xFFFFFFFF),
    searchHitBackground: const Color(0xFFE8A13C),
    searchHitBackgroundCurrent: const Color(0xFF3FB26F),
    searchHitForeground: const Color(0xFF101418),
  );
}

class _QuickKeys extends StatelessWidget {
  const _QuickKeys({
    required this.enabled,
    required this.keyboard,
    required this.canType,
    required this.onKeys,
    required this.onToggleKeyboard,
  });
  final bool enabled;
  final bool keyboard;
  final bool canType;
  final void Function(List<String>) onKeys;
  final VoidCallback onToggleKeyboard;

  static const _keys = [
    ('Esc', 'esc'), ('⏎', 'enter'), ('1', '1'), ('2', '2'), ('3', '3'), ('y', 'y'), ('n', 'n'),
    ('↑', 'up'), ('↓', 'down'), ('⇧Tab', 'shift+tab'), ('Tab', 'tab'), ('^C', 'ctrl+c'), ('←', 'left'), ('→', 'right'),
  ];

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(color: TV.panel, border: Border(top: BorderSide(color: TV.border))),
      padding: EdgeInsets.fromLTRB(6, 6, 6, 6 + MediaQuery.of(context).padding.bottom),
      child: Row(children: [
        IconButton(
          tooltip: canType ? 'Keyboard' : 'This phone cannot type (pairing scope)',
          isSelected: keyboard,
          onPressed: canType ? onToggleKeyboard : null,
          icon: const Icon(Icons.keyboard_alt_outlined),
        ),
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [
              for (final k in _keys)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: OutlinedButton(
                    key: Key('key-${k.$2}'),
                    onPressed: enabled ? () => onKeys([k.$2]) : null,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(44, 38),
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      foregroundColor: k.$2 == 'ctrl+c' ? TV.red : TV.text,
                    ),
                    child: Text(k.$1, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                  ),
                ),
            ]),
          ),
        ),
      ]),
    );
  }
}
