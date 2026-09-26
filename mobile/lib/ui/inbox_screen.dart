import 'package:flutter/material.dart';

import '../core/client.dart';
import 'approval_card.dart';
import 'terminal_screen.dart';
import 'theme.dart';
import 'widgets.dart';

/// Everything that needs a human, across all paired PCs.
class InboxScreen extends StatelessWidget {
  const InboxScreen({super.key, required this.client});
  final RelayClient client;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) {
        final entries = [
          for (final e in client.attention.entries)
            for (final item in e.value) (hostId: e.key, item: item)
        ]..sort((a, b) {
            // approvals first, then the oldest
            final pa = a.item.kind == 'approval' ? 0 : 1, pb = b.item.kind == 'approval' ? 0 : 1;
            if (pa != pb) return pa - pb;
            return (a.item.since ?? 0).compareTo(b.item.since ?? 0);
          });
        final offline = client.hosts.values.where((h) => !h.online).toList();
        if (entries.isEmpty && offline.isEmpty) {
          return const EmptyState(
            icon: Icons.check_circle_outline_rounded,
            title: 'All clear',
            body: 'Nothing is waiting for you. Approvals, unanswered questions and crashed terminals show up here.',
          );
        }
        return ListView(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 24),
          children: [
            for (final h in offline)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Card(
                  child: ListTile(
                    leading: const Icon(Icons.power_off_rounded, color: TV.red),
                    title: Text('${h.name} is offline'),
                    subtitle: Text('Last seen ${ago(h.lastSeen)}. Keep the PC awake and Termivin open to manage it.'),
                  ),
                ),
              ),
            for (final e in entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: AttentionCard(
                  key: ValueKey('${e.hostId}/${e.item.id}'),
                  client: client,
                  hostId: e.hostId,
                  item: e.item,
                  onOpenTerminal: e.item.termId == null
                      ? null
                      : () => Navigator.of(context).push(MaterialPageRoute(
                            builder: (_) => TerminalScreen(client: client, hostId: e.hostId, termId: e.item.termId!),
                          )),
                ),
              ),
          ],
        );
      },
    );
  }
}
