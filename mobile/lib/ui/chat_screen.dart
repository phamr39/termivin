import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import '../core/models.dart';
import 'chat_bubbles.dart';
import 'profile_screen.dart';
import 'term_actions.dart';
import 'terminal_screen.dart';
import 'theme.dart';
import 'widgets.dart';

/// A conversation, Telegram-style: DM with one terminal ("character") or a
/// workspace group. Prompts waiting on you appear as bot messages with inline
/// buttons; a pinned bar shows the task in progress.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.client, required this.chats, required this.hostId, required this.conv});
  final RelayClient client;
  final ChatModel chats;
  final String hostId;
  final Conversation conv;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _messages = <ChatMessage>[];
  final _input = TextEditingController();
  final _scroll = ScrollController();
  StreamSubscription? _sub;
  StreamSubscription? _progressSub;
  TurnProgress? _progress;
  bool _loading = true;
  bool _more = true;
  bool _sending = false;
  bool _showDown = false;
  int _newWhileUp = 0;
  String _mode = 'prompt'; // prompt | bus (DM only)
  String? _error;
  String? _busyKey;

  RelayClient get client => widget.client;
  bool get isGroup => widget.conv.kind == 'group';

  @override
  void initState() {
    super.initState();
    _sub = client.chatEvents.listen((e) {
      if (e.hostId != widget.hostId || e.conv != widget.conv.conv) return;
      setState(() {
        _merge(e.msg, isUpdate: e.isUpdate);
        if (_showDown && !e.isUpdate) _newWhileUp++;
      });
      _markRead();
    });
    if (!isGroup && widget.conv.termId != null) {
      _progress = client.progress['${widget.hostId}\u0000${widget.conv.termId}'];
      _progressSub = client.progressEvents.listen((p) {
        if (p.hostId != widget.hostId || p.termId != widget.conv.termId) return;
        setState(() => _progress = p.active ? p : null);
      });
    }
    _scroll.addListener(() {
      final down = _scroll.hasClients && _scroll.offset > 400;
      if (down != _showDown) setState(() => _showDown = down);
      if (!down && _newWhileUp > 0) setState(() => _newWhileUp = 0);
    });
    _input.addListener(() => setState(() {}));
    _load();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _progressSub?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _merge(ChatMessage m, {bool isUpdate = false}) {
    final i = _messages.indexWhere((x) => x.id == m.id);
    if (i != -1) {
      if (isUpdate) {
        _messages[i].state = m.state ?? _messages[i].state;
      } else {
        _messages[i] = m;
      }
    } else if (!isUpdate) {
      _messages.add(m);
      _messages.sort((a, b) => a.ts.compareTo(b.ts));
    }
  }

  Future<void> _load({bool older = false}) async {
    try {
      final data = await client.cmd(widget.hostId, 'chat.history', {
        'conv': widget.conv.conv,
        'limit': 60,
        if (older && _messages.isNotEmpty) 'before': _messages.first.ts,
      });
      final list = (data as List).whereType<Map<String, dynamic>>().map(ChatMessage.fromJson).toList();
      setState(() {
        for (final m in list) {
          _merge(m);
        }
        _more = list.length >= 60;
        _loading = false;
        _error = null;
      });
      _markRead();
    } on CmdError catch (e) {
      setState(() {
        _loading = false;
        _error = e.message;
      });
    }
  }

  void _markRead() {
    if (_messages.isEmpty) return;
    widget.chats.markRead(widget.conv.conv, _messages.last.ts);
  }

  Future<void> _send([String? preset]) async {
    final text = (preset ?? _input.text).trim();
    if (text.isEmpty) return;
    setState(() => _sending = true);
    final r = await guarded(context, () => client.cmd(widget.hostId, 'chat.send', {
          'conv': widget.conv.conv,
          'text': text,
          if (!isGroup) 'mode': _mode,
        }));
    if (!mounted) return;
    setState(() => _sending = false);
    if (r != null) {
      if (preset == null) _input.clear();
      if (r is Map && r['state'] == 'queued') toast(context, 'It is busy — your message goes in as soon as it is idle.');
      _toBottom();
    }
  }

  void _toBottom() {
    if (_scroll.hasClients) _scroll.animateTo(0, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
  }

  Future<void> _answer(AttentionItem a, PromptOption o) async {
    setState(() => _busyKey = o.key);
    await guarded(context, () => client.cmd(widget.hostId, 'approval.answer', {
          'termId': a.termId, 'approvalId': a.id, 'screenHash': a.screenHash, 'option': o.key, 'label': o.label,
        }), success: 'Sent "${o.label}"');
    if (mounted) setState(() => _busyKey = null);
  }

  Future<void> _action(AttentionItem a, String op) async {
    setState(() => _busyKey = op == 'bus.push' ? 'push' : 'restore');
    await guarded(context, () => client.cmd(widget.hostId, op, {'termId': a.termId}),
        success: op == 'bus.push' ? 'Nudged' : 'Resuming');
    if (mounted) setState(() => _busyKey = null);
  }

  void _openTerminal() {
    if (widget.conv.termId == null) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TerminalScreen(client: client, hostId: widget.hostId, termId: widget.conv.termId!),
    ));
  }

  void _openProfile() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ProfileScreen(client: client, chats: widget.chats, hostId: widget.hostId, conv: widget.conv),
    ));
  }

  // ----------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) {
        final host = client.hosts[widget.hostId];
        final online = client.state == ConnState.connected && (host?.online ?? false);
        final snap = client.snapshots[widget.hostId];
        final found = widget.conv.termId == null ? null : snap?.find(widget.conv.termId!);
        final term = found?.term;
        final ws = snap?.workspaces.where((w) => w.id == widget.conv.spaceId).firstOrNull;
        final pending = (client.attention[widget.hostId] ?? const <AttentionItem>[])
            .where((a) => isGroup ? a.spaceId == widget.conv.spaceId : a.termId == widget.conv.termId)
            .toList();
        final canSend = online && (host?.can('input') ?? false);
        final canApprove = online && (host?.can('approve') ?? false);

        return Scaffold(
          appBar: AppBar(
            titleSpacing: 0,
            title: InkWell(
              onTap: _openProfile,
              child: Row(children: [
                isGroup
                    ? GroupAvatar(name: widget.conv.title, size: 40)
                    : CharacterAvatar(type: term?.type ?? widget.conv.type, status: term?.status, size: 40),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(widget.conv.title, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                    _subtitle(term, ws),
                  ]),
                ),
              ]),
            ),
            actions: [
              if (!isGroup && widget.conv.termId != null)
                IconButton(tooltip: 'Terminal', icon: const Icon(Icons.terminal_rounded), onPressed: _openTerminal),
              if (found != null)
                IconButton(
                  icon: const Icon(Icons.more_vert_rounded),
                  onPressed: () => showTermActions(context, widget.hostId, found.ws, found.term),
                ),
            ],
          ),
          body: Column(children: [
            if (host != null && !host.online) ConnectionBanner(client: client),
            _pinnedBar(pending),
            Expanded(
              child: ChatWallpaper(
                child: Stack(children: [
                  _buildMessages(ws, pending, canApprove),
                  if (_showDown)
                    Positioned(
                      right: 12,
                      bottom: 12,
                      child: Badge(
                        isLabelVisible: _newWhileUp > 0,
                        label: Text('$_newWhileUp'),
                        backgroundColor: TV.badge,
                        child: FloatingActionButton.small(
                          heroTag: null,
                          backgroundColor: TV.header,
                          foregroundColor: TV.dim,
                          onPressed: _toBottom,
                          child: const Icon(Icons.keyboard_arrow_down_rounded),
                        ),
                      ),
                    ),
                ]),
              ),
            ),
            _composer(term, canSend, online),
          ]),
        );
      },
    );
  }

  Widget _subtitle(TermInfo? term, WorkspaceInfo? ws) {
    if (isGroup) {
      final all = ws?.terminals.where((t) => t.agent).toList() ?? const <TermInfo>[];
      final working = all.where((t) => t.status == 'working').length;
      final waiting = all.where((t) => t.status == 'approval').length;
      final parts = ['${all.length} member${all.length == 1 ? '' : 's'}', if (working > 0) '$working working', if (waiting > 0) '$waiting waiting'];
      return Text(parts.join(', '), style: const TextStyle(fontSize: 13.5, color: TV.dim));
    }
    if (_progress != null || term?.status == 'working') {
      return const _Typing(text: 'working');
    }
    final s = term?.status;
    final color = s == 'approval' ? TV.orange : s == 'idle' ? TV.accentBright : TV.dim;
    final label = switch (s) {
      'idle' => 'idle${term?.title != null ? ' · ${term!.title}' : ''}',
      'approval' => 'waiting for your approval',
      'exited' => 'stopped',
      'attached' => 'attached window',
      null => '',
      _ => 'not running',
    };
    return Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: color));
  }

  /// Telegram's pinned-message bar: the prompt waiting on you, or the task in
  /// progress.
  Widget _pinnedBar(List<AttentionItem> pending) {
    final approval = pending.where((a) => a.kind == 'approval').firstOrNull;
    final p = _progress;
    if (approval == null && p == null) return const SizedBox.shrink();
    final isApproval = approval != null;
    final title = isApproval ? 'Waiting for your approval' : 'Working${p!.steps > 0 ? ' · ${p.steps} steps' : ''}';
    final body = isApproval
        ? (approval.question.isNotEmpty ? approval.question : approval.excerpt)
        : (p!.last.isNotEmpty ? p.last : 'started ${ago(p.startedAt)}');
    return Material(
      color: TV.header,
      child: InkWell(
        onTap: _toBottom,
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 7),
          decoration: const BoxDecoration(border: Border(top: BorderSide(color: TV.border))),
          child: Row(children: [
            Container(width: 2.5, height: 34, color: isApproval ? TV.orange : TV.accentBright),
            const SizedBox(width: 9),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: TextStyle(color: isApproval ? TV.orange : TV.accentBright, fontSize: 13.5, fontWeight: FontWeight.w600)),
                Text(body, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13.5, color: TV.text, fontFamily: isApproval ? null : 'monospace')),
              ]),
            ),
            Icon(isApproval ? Icons.front_hand_rounded : Icons.push_pin_rounded, size: 18, color: TV.dim),
          ]),
        ),
      ),
    );
  }

  Widget _buildMessages(WorkspaceInfo? ws, List<AttentionItem> pending, bool canApprove) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null && _messages.isEmpty && pending.isEmpty) {
      return EmptyState(icon: Icons.cloud_off_rounded, title: 'Cannot load messages', body: _error);
    }
    if (_messages.isEmpty && pending.isEmpty) {
      return Center(
        child: Container(
          margin: const EdgeInsets.all(40),
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.28), borderRadius: BorderRadius.circular(16)),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(isGroup ? 'Workspace chat' : 'No messages here yet',
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15.5)),
            const SizedBox(height: 8),
            Text(
              isGroup
                  ? 'Messages here reach every agent in ${widget.conv.title} over its bus; their conversations show up here too.'
                  : 'Send a message — it is typed into ${widget.conv.title}\'s prompt when it is idle. When it finishes you get one summary of what it did.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: TV.dim, fontSize: 13.5, height: 1.35),
            ),
          ]),
        ),
      );
    }
    String? typeOf(String? id) => id == null ? null : ws?.terminals.where((t) => t.id == id).firstOrNull?.type;
    final items = _messages.reversed.toList();
    final extra = pending.length;
    return ListView.builder(
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      itemCount: extra + items.length + (_more ? 1 : 0),
      itemBuilder: (context, i) {
        if (i < extra) {
          final a = pending[extra - 1 - i];
          return AttentionBubble(
            item: a,
            type: typeOf(a.termId) ?? widget.conv.type,
            enabled: canApprove,
            busyKey: _busyKey,
            onOption: (o) => _answer(a, o),
            onAction: (op) => _action(a, op),
          );
        }
        final k = i - extra;
        if (k == items.length) {
          return Center(
            child: TextButton(onPressed: () => _load(older: true), child: const Text('Load earlier messages')),
          );
        }
        final m = items[k];
        final older = k + 1 < items.length ? items[k + 1] : null;
        final newer = k > 0 ? items[k - 1] : null;
        bool sameRun(ChatMessage? x) =>
            x != null && x.from == m.from && x.mine == m.mine && x.kind != 'system' && (x.ts - m.ts).abs() < 5 * 60 * 1000 &&
            DateUtils.isSameDay(DateTime.fromMillisecondsSinceEpoch(x.ts), DateTime.fromMillisecondsSinceEpoch(m.ts));
        final pos = RunPos(first: !sameRun(older), last: !sameRun(newer));
        final newDay = older == null ||
            !DateUtils.isSameDay(DateTime.fromMillisecondsSinceEpoch(older.ts), DateTime.fromMillisecondsSinceEpoch(m.ts));
        final type = typeOf(m.from) ?? (isGroup ? null : widget.conv.type);

        Widget bubble;
        if (m.kind == 'system' || m.role == 'system') {
          bubble = ServicePill(text: m.text);
        } else if (m.kind == 'tool') {
          bubble = ServicePill(text: m.text); // older history, before turns were summarized
        } else if (m.kind == 'image') {
          bubble = ImageBubble(
            msg: m, pos: pos, group: isGroup, type: m.from == 'pc' ? null : type,
            load: (id) => client.fetchMedia(widget.hostId, id),
          );
        } else if (m.kind == 'summary') {
          bubble = SummaryBubble(msg: m, pos: pos, group: isGroup, type: type, onOpenTerminal: isGroup ? null : _openTerminal);
        } else {
          bubble = TextBubble(
            msg: m, pos: pos, group: isGroup, type: type,
            onLongPress: () => _messageMenu(m),
          );
        }
        if (!newDay) return bubble;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [ServicePill(text: dayLabel(m.ts)), bubble]);
      },
    );
  }

  void _messageMenu(ChatMessage m) {
    showModalBottomSheet(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(Icons.copy_rounded),
            title: const Text('Copy'),
            onTap: () {
              Clipboard.setData(ClipboardData(text: m.text));
              Navigator.pop(sheet);
              toast(context, 'Copied');
            },
          ),
          if (!isGroup && m.mine)
            ListTile(
              leading: const Icon(Icons.replay_rounded),
              title: const Text('Send again'),
              onTap: () {
                Navigator.pop(sheet);
                _send(m.text);
              },
            ),
        ]),
      ),
    );
  }

  // ---------------------------------------------------------------- composer

  List<(String, String)> _commands(TermInfo? term) => [
        ('continue', 'Carry on where it stopped'),
        ('What is the status?', 'Ask for a progress update'),
        ('Summarize what you changed', 'A short recap of the work'),
        ('Take a screenshot of the result and send it to me with: termivin send owner --image <file>',
            'Ask for a screenshot to preview here'),
        ('Run the tests', 'Run the project\'s tests'),
        if (term?.type == 'claude') ...[
          ('/compact', 'Claude Code: compact the conversation'),
          ('/cost', 'Claude Code: show usage for this session'),
        ],
      ];

  // 📎 — what can be put into this chat from here.
  void _attachMenu() {
    showModalBottomSheet(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const CircleAvatar(backgroundColor: TV.accent, child: Icon(Icons.desktop_windows_rounded, color: Colors.white)),
            title: const Text('Screenshot of the PC screen'),
            subtitle: const Text('Captures the main display and posts it here'),
            onTap: () async {
              Navigator.pop(sheet);
              await guarded(context, () => client.cmd(widget.hostId, 'screen.capture', {'conv': widget.conv.conv}));
              _toBottom();
            },
          ),
          if (!isGroup)
            ListTile(
              leading: const CircleAvatar(backgroundColor: TV.green, child: Icon(Icons.photo_camera_back_rounded, color: Colors.white)),
              title: const Text('Ask the agent for a screenshot'),
              subtitle: const Text('It captures its result and sends the image back'),
              onTap: () {
                Navigator.pop(sheet);
                _send('Take a screenshot of the result and send it to me with: termivin send owner --image <file>');
              },
            ),
        ]),
      ),
    );
  }

  void _openMenu(TermInfo? term) {
    showModalBottomSheet(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(18, 0, 18, 8),
            child: Text('Quick messages', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          ),
          for (final (cmd, desc) in _commands(term))
            ListTile(
              dense: true,
              title: Text(cmd, style: const TextStyle(color: TV.link, fontSize: 15)),
              subtitle: Text(desc, style: const TextStyle(color: TV.dim)),
              onTap: () {
                Navigator.pop(sheet);
                _send(cmd);
              },
            ),
        ]),
      ),
    );
  }

  Widget _composer(TermInfo? term, bool canSend, bool online) {
    final isShell = !isGroup && term != null && !term.isAgent;
    final agent = !isGroup && !isShell;
    final hasText = _input.text.trim().isNotEmpty;
    final host = client.hosts[widget.hostId];
    final canCapture = online && (host?.can('manage') ?? false);
    final hint = !online
        ? 'PC offline'
        : !canSend
            ? 'This phone cannot send input'
            : isGroup
                ? 'Message everyone'
                : isShell
                    ? 'Command'
                    : _mode == 'bus' ? 'Bus mail' : 'Message';
    return Container(
      color: TV.panel,
      padding: EdgeInsets.fromLTRB(4, 4, 4, 4 + MediaQuery.of(context).padding.bottom),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        if (canCapture)
          IconButton(
            tooltip: 'Attach',
            onPressed: _attachMenu,
            icon: Transform.rotate(angle: 0.6, child: const Icon(Icons.attach_file_rounded, color: TV.dim)),
          ),
        if (agent && canSend)
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 6, right: 2),
            child: Material(
              color: TV.accent,
              borderRadius: BorderRadius.circular(8),
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => _openMenu(term),
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(Icons.menu_rounded, size: 18, color: Colors.white),
                    SizedBox(width: 3),
                    Text('Menu', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 13.5)),
                  ]),
                ),
              ),
            ),
          ),
        if (agent)
          IconButton(
            tooltip: _mode == 'prompt' ? 'Typed into its prompt — tap for bus mail' : 'Bus mail — tap to type into its prompt',
            onPressed: canSend ? () => setState(() => _mode = _mode == 'prompt' ? 'bus' : 'prompt') : null,
            icon: Icon(_mode == 'prompt' ? Icons.keyboard_return_rounded : Icons.mail_outline_rounded,
                color: _mode == 'prompt' ? TV.dim : TV.accentBright),
          ),
        Expanded(
          child: TextField(
            key: const Key('chat-input'),
            controller: _input,
            enabled: canSend && !_sending,
            minLines: 1,
            maxLines: 6,
            textCapitalization: TextCapitalization.sentences,
            style: const TextStyle(fontSize: 16),
            decoration: InputDecoration(
              hintText: hint,
              filled: false,
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
            ),
          ),
        ),
        IconButton(
          key: const Key('chat-send'),
          onPressed: canSend && !_sending && hasText ? _send : null,
          icon: _sending
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : Icon(Icons.send_rounded, color: hasText ? TV.accentBright : TV.faint),
        ),
      ]),
    );
  }
}

/// "working…" with animated dots, like Telegram's "typing…".
class _Typing extends StatefulWidget {
  const _Typing({required this.text});
  final String text;

  @override
  State<_Typing> createState() => _TypingState();
}

class _TypingState extends State<_Typing> {
  Timer? _t;
  int _n = 0;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 420), (_) => setState(() => _n = (_n + 1) % 4));
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Text('${widget.text}${'.' * _n}', style: const TextStyle(fontSize: 13.5, color: TV.accentBright));
}
