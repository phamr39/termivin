import 'package:flutter/material.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import '../core/models.dart';
import 'chat_screen.dart';
import 'theme.dart';
import 'widgets.dart';

/// Messenger view: each workspace is a group chat, each terminal a character
/// you can message directly.
class ChatListScreen extends StatelessWidget {
  const ChatListScreen({super.key, required this.client, required this.chats});
  final RelayClient client;
  final ChatModel chats;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([client, chats]),
      builder: (context, _) {
        if (client.host == null) {
          return const EmptyState(icon: Icons.forum_outlined, title: 'No PC selected');
        }
        if (chats.convs.isEmpty) {
          return RefreshIndicator(
            onRefresh: chats.refresh,
            child: ListView(children: [
              const SizedBox(height: 80),
              chats.loading
                  ? const Center(child: CircularProgressIndicator())
                  : EmptyState(
                      icon: Icons.forum_outlined,
                      title: client.host!.online ? 'No conversations yet' : 'PC offline',
                      body: chats.error ??
                          (client.host!.online
                              ? 'Workspaces and terminals on ${client.host!.name} show up here.'
                              : 'Chats load when ${client.host!.name} is back online.'),
                    ),
            ]),
          );
        }
        final bySpace = <String, List<Conversation>>{};
        for (final c in chats.convs) {
          bySpace.putIfAbsent(c.spaceId, () => []).add(c);
        }
        return RefreshIndicator(
          onRefresh: chats.refresh,
          child: ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              for (final list in bySpace.values) ...[
                for (final c in list) _ConvTile(client: client, chats: chats, conv: c),
                const Divider(indent: 72),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _ConvTile extends StatelessWidget {
  const _ConvTile({required this.client, required this.chats, required this.conv});
  final RelayClient client;
  final ChatModel chats;
  final Conversation conv;

  @override
  Widget build(BuildContext context) {
    final group = conv.kind == 'group';
    final last = conv.last;
    final working = conv.termId == null ? null : client.progress['${client.selectedHostId}\u0000${conv.termId}'];
    final preview = working != null
        ? 'working${working.steps > 0 ? ' · ${working.steps} steps' : ''}${working.last.isNotEmpty ? ' · ${working.last}' : ''}'
        : last == null
            ? (group ? '${conv.members.length} members' : 'Say hi to ${conv.title}')
            : '${last.mine ? 'You: ' : (group && last.fromName != null ? '${last.fromName}: ' : '')}${last.preview.replaceAll('\n', ' ')}';
    return ListTile(
      key: Key('conv-${conv.conv}'),
      contentPadding: EdgeInsets.fromLTRB(group ? 14 : 30, 2, 14, 2),
      leading: group
          ? GroupAvatar(members: conv.members, size: 44)
          : CharacterAvatar(type: conv.type, status: conv.status, size: 40),
      title: Row(children: [
        if (group) const Icon(Icons.tag_rounded, size: 16, color: TV.dim),
        Flexible(
          child: Text(conv.title,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontWeight: group ? FontWeight.w700 : FontWeight.w600, fontSize: group ? 15.5 : 14.5)),
        ),
        const Spacer(),
        if (last != null) Text(clock(last.ts), style: const TextStyle(color: TV.faint, fontSize: 11.5)),
      ]),
      subtitle: Row(children: [
        Expanded(
          child: Text(preview,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: working != null ? TV.accent : (conv.unread > 0 ? TV.text : TV.dim), fontSize: 13)),
        ),
        if (conv.unread > 0)
          Container(
            margin: const EdgeInsets.only(left: 8),
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
            decoration: BoxDecoration(color: TV.accent, borderRadius: BorderRadius.circular(10)),
            child: Text('${conv.unread}', style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700)),
          ),
      ]),
      onTap: () => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => ChatScreen(client: client, chats: chats, hostId: client.selectedHostId!, conv: conv),
      )),
    );
  }
}
