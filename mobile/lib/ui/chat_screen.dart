import 'dart:async';

import 'package:flutter/material.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import '../core/models.dart';
import 'approval_card.dart';
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
    _load();
  }

  @override
  void dispose() {
    _sub?.cancel();
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

  Future<void> _send() async {
    final text = _input.text.trim();
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
        _input.clear();
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
            : 'Your message is typed into its prompt when it is idle. Its replies and tool steps appear here.',
      );
    }
    final items = _messages.reversed.toList();
    return ListView.builder(
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
      itemCount: items.length + (_more ? 1 : 0),
      itemBuilder: (context, i) {
        if (i == items.length) {
          return Center(
            child: TextButton(onPressed: () => _load(older: true), child: const Text('Load earlier')),
          );
        }
        final m = items[i];
        final prev = i + 1 < items.length ? items[i + 1] : null;
        final showName = isGroup && !m.mine && (prev == null || prev.from != m.from || prev.mine);
        return _Bubble(msg: m, showName: showName, typeOf: (id) => ws?.terminals.where((t) => t.id == id).firstOrNull?.type);
      },
    );
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

class _Bubble extends StatelessWidget {
  const _Bubble({required this.msg, required this.showName, required this.typeOf});
  final ChatMessage msg;
  final bool showName;
  final String? Function(String id) typeOf;

  @override
  Widget build(BuildContext context) {
    final m = msg;
    if (m.kind == 'system' || m.role == 'system') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(color: TV.panel, borderRadius: BorderRadius.circular(10)),
            child: Text('${m.text} · ${clock(m.ts)}', style: const TextStyle(color: TV.dim, fontSize: 12)),
          ),
        ),
      );
    }
    if (m.kind == 'tool') {
      return Padding(
        padding: const EdgeInsets.only(left: 38, top: 2, bottom: 2, right: 40),
        child: Text(m.text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: TV.faint)),
      );
    }
    final mine = m.mine;
    final desktop = m.role == 'desktop';
    final right = mine || desktop;
    final bg = mine ? TV.accent.withValues(alpha: 0.9) : desktop ? TV.border : TV.raised;
    final header = [
      if (showName && m.fromName != null) m.fromName!,
      if (m.kind == 'bus' && m.toName != null) '→ ${m.toName}',
      if (m.topic != null) '#${m.topic}',
      if (desktop) 'typed on the PC',
      if (m.via == 'bus' && !mine) 'via bus',
    ].join('  ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: right ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!right) ...[
            CharacterAvatar(type: m.from == null ? null : typeOf(m.from!), size: 28),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
              child: Container(
                padding: const EdgeInsets.fromLTRB(11, 8, 11, 6),
                decoration: BoxDecoration(
                  color: bg,
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(14),
                    topRight: const Radius.circular(14),
                    bottomLeft: Radius.circular(right ? 14 : 4),
                    bottomRight: Radius.circular(right ? 4 : 14),
                  ),
                  border: right ? null : Border.all(color: TV.border),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (header.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 3),
                      child: Text(header,
                          style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w700,
                              color: mine ? Colors.white70 : TV.character(m.from == null ? null : typeOf(m.from!)).color)),
                    ),
                  if (m.subject.isNotEmpty)
                    Text(m.subject, style: const TextStyle(fontWeight: FontWeight.w700)),
                  SelectableText(m.text, style: TextStyle(color: mine ? Colors.white : TV.text, height: 1.35)),
                  const SizedBox(height: 3),
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    Text(clock(m.ts), style: TextStyle(fontSize: 10.5, color: mine ? Colors.white60 : TV.faint)),
                    if (mine && m.state != null) ...[
                      const SizedBox(width: 4),
                      Icon(m.state == 'queued' ? Icons.schedule_rounded : Icons.done_all_rounded,
                          size: 13, color: Colors.white70),
                      if (m.state == 'queued')
                        const Text(' waiting for idle', style: TextStyle(fontSize: 10.5, color: Colors.white70)),
                    ],
                  ]),
                ]),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
