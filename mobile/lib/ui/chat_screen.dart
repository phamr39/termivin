import 'dart:async';

import 'package:flutter/material.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import '../core/models.dart';
import 'approval_card.dart';
import 'chat_bubbles.dart';
import 'terminal_screen.dart';
import 'theme.dart';
import 'widgets.dart';

/// A conversation: DM with one terminal ("character") or a workspace group.
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
  String _mode = 'prompt'; // prompt | bus (DM only)
  String? _error;

  RelayClient get client => widget.client;
  bool get isGroup => widget.conv.kind == 'group';

  @override
  void initState() {
    super.initState();
    _sub = client.chatEvents.listen((e) {
      if (e.hostId != widget.hostId || e.conv != widget.conv.conv) return;
      setState(() => _merge(e.msg, isUpdate: e.isUpdate));
      _markRead();
    });
    if (!isGroup && widget.conv.termId != null) {
      _progress = client.progress['${widget.hostId}\u0000${widget.conv.termId}'];
      _progressSub = client.progressEvents.listen((p) {
        if (p.hostId != widget.hostId || p.termId != widget.conv.termId) return;
        setState(() => _progress = p.active ? p : null);
      });
    }
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
    if (mounted) {
      setState(() => _sending = false);
      if (r != null) {
        if (preset == null) _input.clear();
        if (r is Map && r['state'] == 'queued') {
          toast(context, 'It is busy — the message goes in as soon as it is idle.');
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) {
        final host = client.hosts[widget.hostId];
        final online = client.state == ConnState.connected && (host?.online ?? false);
        final snap = client.snapshots[widget.hostId];
        final term = widget.conv.termId == null ? null : snap?.find(widget.conv.termId!)?.term;
        final ws = snap?.workspaces.where((w) => w.id == widget.conv.spaceId).firstOrNull;
        final pending = (client.attention[widget.hostId] ?? const [])
            .where((a) => a.kind == 'approval' && (isGroup ? a.spaceId == widget.conv.spaceId : a.termId == widget.conv.termId))
            .toList();
        final canSend = online && (host?.can('input') ?? false);

        return Scaffold(
          appBar: AppBar(
            titleSpacing: 0,
            title: Row(children: [
              isGroup
                  ? GroupAvatar(members: [for (final t in ws?.terminals ?? const <TermInfo>[]) {'type': t.type}], size: 36)
                  : CharacterAvatar(type: term?.type ?? widget.conv.type, status: term?.status, size: 36),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(widget.conv.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  Text(
                    isGroup
                        ? '${ws?.terminals.length ?? widget.conv.members.length} characters · workspace'
                        : '${TV.statusLabel(term?.status)}${term != null && term.summary.isNotEmpty ? ' · ${term.summary}' : ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: isGroup ? TV.dim : TV.status(term?.status)),
                  ),
                ]),
              ),
            ]),
            actions: [
              if (!isGroup && widget.conv.termId != null)
                IconButton(
                  tooltip: 'Open terminal',
                  icon: const Icon(Icons.terminal_rounded),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => TerminalScreen(client: client, hostId: widget.hostId, termId: widget.conv.termId!),
                  )),
                ),
            ],
          ),
          body: Column(children: [
            ConnectionBanner(client: client),
            Expanded(child: _buildMessages(ws)),
            for (final a in pending.take(2))
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
                child: AttentionCard(client: client, hostId: widget.hostId, item: a, compact: true),
              ),
            _buildComposer(term, canSend, online),
          ]),
        );
      },
    );
  }

  Widget _buildMessages(WorkspaceInfo? ws) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null && _messages.isEmpty) {
      return EmptyState(icon: Icons.cloud_off_rounded, title: 'Cannot load messages', body: _error);
    }
    if (_messages.isEmpty) {
      return EmptyState(
        icon: isGroup ? Icons.groups_2_outlined : Icons.chat_bubble_outline_rounded,
        title: isGroup ? 'Workspace chat' : 'Talk to ${widget.conv.title}',
        body: isGroup
            ? 'Messages here reach every agent in the workspace over its bus. Agent-to-agent traffic shows up here too.'
            : 'Your message is typed into its prompt when it is idle. While it works you see its progress; when it finishes, one summary of what it did lands here.',
      );
    }
    final items = _messages.reversed.toList();
    final progress = _progress;
    final extra = (progress != null ? 1 : 0);
    String? typeOf(String? id) => id == null ? null : ws?.terminals.where((t) => t.id == id).firstOrNull?.type;
    return ListView.builder(
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
      itemCount: items.length + extra + (_more ? 1 : 0),
      itemBuilder: (context, i) {
        if (progress != null && i == 0) {
          return ProgressBubble(progress: progress, name: widget.conv.title, type: typeOf(widget.conv.termId) ?? widget.conv.type);
        }
        final k = i - extra;
        if (k == items.length) {
          return Center(child: TextButton(onPressed: () => _load(older: true), child: const Text('Load earlier')));
        }
        final m = items[k];
        final prev = k + 1 < items.length ? items[k + 1] : null;
        final newDay = prev == null || !_sameDay(prev.ts, m.ts);
        final showName = isGroup && !m.mine && (prev == null || prev.from != m.from || prev.mine);
        final bubble = m.kind == 'summary'
            ? SummaryBubble(msg: m, type: typeOf(m.from) ?? widget.conv.type)
            : TextBubble(msg: m, showName: showName, type: typeOf(m.from) ?? (isGroup ? null : widget.conv.type));
        if (!newDay) return bubble;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [DaySeparator(ts: m.ts), bubble]);
      },
    );
  }

  static bool _sameDay(int a, int b) {
    final x = DateTime.fromMillisecondsSinceEpoch(a), y = DateTime.fromMillisecondsSinceEpoch(b);
    return x.year == y.year && x.month == y.month && x.day == y.day;
  }

  Widget _buildComposer(TermInfo? term, bool canSend, bool online) {
    final isShell = !isGroup && term != null && !term.isAgent;
    final hint = !online
        ? 'PC offline'
        : !canSend
            ? 'This phone cannot send input'
            : isGroup
                ? 'Message everyone in ${widget.conv.title}'
                : isShell
                    ? 'Run a command in ${widget.conv.title}'
                    : _mode == 'prompt'
                        ? 'Ask ${widget.conv.title}…'
                        : 'Leave a note in its bus inbox…';
    return Container(
      decoration: const BoxDecoration(color: TV.panel, border: Border(top: BorderSide(color: TV.border))),
      padding: EdgeInsets.fromLTRB(10, 8, 10, 8 + MediaQuery.of(context).padding.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (!isGroup && !isShell)
          Align(
            alignment: Alignment.centerLeft,
            child: SegmentedButton<String>(
              style: const ButtonStyle(visualDensity: VisualDensity.compact),
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: 'prompt', label: Text('Prompt'), icon: Icon(Icons.keyboard_return_rounded, size: 16)),
                ButtonSegment(value: 'bus', label: Text('Bus mail'), icon: Icon(Icons.mail_outline_rounded, size: 16)),
              ],
              selected: {_mode},
              onSelectionChanged: (s) => setState(() => _mode = s.first),
            ),
          ),
        if (!isGroup && !isShell) const SizedBox(height: 6),
        if (!isGroup && !isShell && canSend && _mode == 'prompt')
          SizedBox(
            height: 34,
            child: ListView(scrollDirection: Axis.horizontal, children: [
              for (final q in const ['continue', 'What is the status?', 'Summarize what you changed', 'Run the tests'])
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ActionChip(
                    visualDensity: VisualDensity.compact,
                    label: Text(q, style: const TextStyle(fontSize: 12.5)),
                    onPressed: _sending ? null : () => _send(q),
                  ),
                ),
            ]),
          ),
        if (!isGroup && !isShell && canSend && _mode == 'prompt') const SizedBox(height: 6),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(
            child: TextField(
              key: const Key('chat-input'),
              controller: _input,
              enabled: canSend && !_sending,
              minLines: 1,
              maxLines: 5,
              textInputAction: TextInputAction.newline,
              decoration: InputDecoration(hintText: hint, isDense: true),
            ),
          ),
          const SizedBox(width: 8),
          IconButton.filled(
            key: const Key('chat-send'),
            onPressed: canSend && !_sending ? _send : null,
            icon: _sending
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.send_rounded),
          ),
        ]),
      ]),
    );
  }
}
