import 'package:flutter/material.dart';

import '../core/client.dart';
import '../core/models.dart';
import 'new_terminal_sheet.dart';
import 'term_actions.dart';
import 'theme.dart';
import 'widgets.dart';

/// PC → workspaces → terminal cards, sorted by what needs attention.
class WorkspacesScreen extends StatelessWidget {
  const WorkspacesScreen({super.key, required this.client});
  final RelayClient client;

  static int _rank(String s) => switch (s) {
        'approval' => 0,
        'exited' => 1,
        'working' => 2,
        'idle' => 3,
        'attached' => 5,
        _ => 4,
      };

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) {
        final snap = client.snapshot;
        final hostId = client.selectedHostId;
        if (snap == null || hostId == null) {
          return EmptyState(
            icon: Icons.dns_outlined,
            title: client.host == null ? 'No PC paired' : 'Waiting for ${client.host!.name}',
            body: client.host == null ? null : 'Its workspaces appear once it has connected to the relay.',
          );
        }
        final host = client.host!;
        final canManage = client.state == ConnState.connected && host.online && host.can('manage');
        return Stack(children: [
          ListView(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 96),
            children: [
              _Summary(snap: snap),
              for (final ws in snap.workspaces) _WorkspaceCard(hostId: hostId, ws: ws, active: ws.id == snap.activeWorkspaceId),
            ],
          ),
          if (canManage)
            Positioned(
              right: 16,
              bottom: 16,
              child: FloatingActionButton.extended(
                key: const Key('new-terminal'),
                onPressed: () => showNewTerminalSheet(context, client, hostId, snap),
                icon: const Icon(Icons.add_rounded),
                label: const Text('Terminal'),
              ),
            ),
        ]);
      },
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.snap});
  final Snapshot snap;

  @override
  Widget build(BuildContext context) {
    final counts = <String, int>{};
    for (final x in snap.allTerminals) {
      counts[x.term.status] = (counts[x.term.status] ?? 0) + 1;
    }
    Widget tile(String label, int n, Color c) => Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(color: TV.raised, borderRadius: BorderRadius.circular(10), border: Border.all(color: TV.border)),
            child: Column(children: [
              Text('$n', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: n > 0 ? c : TV.faint)),
              Text(label, style: const TextStyle(fontSize: 11.5, color: TV.dim)),
            ]),
          ),
        );
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(children: [
        tile('need you', counts['approval'] ?? 0, TV.orange),
        const SizedBox(width: 8),
        tile('working', counts['working'] ?? 0, TV.accent),
        const SizedBox(width: 8),
        tile('idle', counts['idle'] ?? 0, TV.green),
        const SizedBox(width: 8),
        tile('stopped', (counts['saved'] ?? 0) + (counts['exited'] ?? 0), TV.faint),
      ]),
    );
  }
}

class _WorkspaceCard extends StatefulWidget {
  const _WorkspaceCard({required this.hostId, required this.ws, required this.active});
  final String hostId;
  final WorkspaceInfo ws;
  final bool active;

  @override
  State<_WorkspaceCard> createState() => _WorkspaceCardState();
}

class _WorkspaceCardState extends State<_WorkspaceCard> {
  bool _open = true;

  @override
  Widget build(BuildContext context) {
    final terms = [...widget.ws.terminals]
      ..sort((a, b) => WorkspacesScreen._rank(a.status).compareTo(WorkspacesScreen._rank(b.status)));
    final needs = terms.where((t) => t.status == 'approval').length;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: Column(children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
              child: Row(children: [
                Expanded(
                  child: Text(widget.ws.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                ),
                if (needs > 0)
                  Container(
                    margin: const EdgeInsets.only(right: 8),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(color: TV.orange.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(10)),
                    child: Text('$needs waiting', style: const TextStyle(color: TV.orange, fontSize: 12, fontWeight: FontWeight.w600)),
                  ),
                Text('${terms.where((t) => t.running).length}/${terms.length}', style: const TextStyle(color: TV.dim)),
                Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: TV.dim),
              ]),
            ),
          ),
          if (_open)
            for (final t in terms) ...[
              const Divider(height: 1),
              _TermRow(hostId: widget.hostId, ws: widget.ws, t: t),
            ],
          if (_open && terms.isEmpty)
            const Padding(padding: EdgeInsets.all(14), child: Text('No terminals', style: TextStyle(color: TV.faint))),
        ]),
      ),
    );
  }
}

class _TermRow extends StatelessWidget {
  const _TermRow({required this.hostId, required this.ws, required this.t});
  final String hostId;
  final WorkspaceInfo ws;
  final TermInfo t;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      key: Key('term-${t.id}'),
      onTap: t.external ? null : () => openTerminal(context, hostId, t.id),
      onLongPress: () => showTermActions(context, hostId, ws, t),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 4, 10),
        child: Row(children: [
          CharacterAvatar(type: t.external ? 'external' : t.type, status: t.status, size: 38),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(
                  child: Text(t.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14.5)),
                ),
                const SizedBox(width: 8),
                StatusChip(status: t.status),
              ]),
              const SizedBox(height: 3),
              Text(
                t.summary.isNotEmpty ? t.summary : (t.cwd.isNotEmpty ? t.cwd : TV.statusLabel(t.status)),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: TV.dim),
              ),
            ]),
          ),
          if (t.pendingMail > 0)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Badge(label: Text('${t.pendingMail}'), child: const Icon(Icons.mail_outline_rounded, size: 20, color: TV.dim)),
            ),
          IconButton(
            icon: const Icon(Icons.more_vert_rounded, color: TV.dim),
            onPressed: () => showTermActions(context, hostId, ws, t),
          ),
        ]),
      ),
    );
  }
}
