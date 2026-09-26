import 'package:flutter/material.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import '../core/models.dart';
import 'theme.dart';
import 'widgets.dart';

/// Timeline across the workspaces of the selected PC: what the agents said to
/// each other, what they reported to you, what you sent.
class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key, required this.client, required this.chats});
  final RelayClient client;
  final ChatModel chats;

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  List<({Conversation conv, ChatMessage msg})> _items = [];
  bool _loading = false;
  String? _loadedFor;

  @override
  void initState() {
    super.initState();
    widget.chats.addListener(_maybeLoad);
    _maybeLoad();
  }

  @override
  void dispose() {
    widget.chats.removeListener(_maybeLoad);
    super.dispose();
  }

  void _maybeLoad() {
    final key = '${widget.client.selectedHostId}:${widget.chats.convs.length}:${widget.chats.convs.map((c) => c.last?.ts ?? 0).fold(0, (a, b) => a > b ? a : b)}';
    if (key != _loadedFor && widget.chats.convs.isNotEmpty) {
      _loadedFor = key;
      _load();
    }
  }

  Future<void> _load() async {
    final hostId = widget.client.selectedHostId;
    if (hostId == null) return;
    setState(() => _loading = true);
    final out = <({Conversation conv, ChatMessage msg})>[];
    final convs = widget.chats.convs.where((c) => c.last != null).toList();
    for (final c in convs) {
      try {
        final data = await widget.client.cmd(hostId, 'chat.history', {'conv': c.conv, 'limit': 25});
        for (final m in (data as List).whereType<Map<String, dynamic>>()) {
          final msg = ChatMessage.fromJson(m);
          if (msg.kind == 'tool') continue;
          out.add((conv: c, msg: msg));
        }
      } catch (_) {}
    }
    out.sort((a, b) => b.msg.ts.compareTo(a.msg.ts));
    if (mounted) {
      setState(() {
        _items = out.take(150).toList();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) {
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(children: [
          const SizedBox(height: 80),
          _loading
              ? const Center(child: CircularProgressIndicator())
              : const EmptyState(
                  icon: Icons.timeline_rounded,
                  title: 'No activity yet',
                  body: 'Messages between agents, reports to you and your own messages appear here.',
                ),
        ]),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: _items.length,
        separatorBuilder: (_, __) => const Divider(indent: 64),
        itemBuilder: (context, i) {
          final it = _items[i];
          final m = it.msg;
          final who = m.mine ? 'You' : (m.fromName ?? it.conv.title);
          final to = m.kind == 'bus' ? ' → ${m.toName ?? ''}' : (m.mine ? ' → ${it.conv.title}' : '');
          return ListTile(
            leading: m.mine
                ? const CircleAvatar(backgroundColor: TV.accent, child: Icon(Icons.person_rounded, color: Colors.white))
                : CharacterAvatar(type: it.conv.type ?? _typeOf(m.from), size: 38),
            title: Text('$who$to', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
            subtitle: Text(m.preview, maxLines: 3, overflow: TextOverflow.ellipsis),
            trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text(clock(m.ts), style: const TextStyle(color: TV.faint, fontSize: 11.5)),
              Text(it.conv.kind == 'group' ? '#${it.conv.title}' : it.conv.spaceName,
                  style: const TextStyle(color: TV.faint, fontSize: 11)),
            ]),
          );
        },
      ),
    );
  }

  String? _typeOf(String? termId) {
    if (termId == null) return null;
    return widget.client.snapshot?.find(termId)?.term.type;
  }
}
