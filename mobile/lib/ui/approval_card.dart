import 'package:flutter/material.dart';

import '../core/client.dart';
import '../core/models.dart';
import 'theme.dart';
import 'widgets.dart';

/// One item of the inbox: a waiting permission prompt (with the exact options
/// read from the PC's screen), an unanswered question between agents, or a
/// terminal that exited abnormally.
class AttentionCard extends StatefulWidget {
  const AttentionCard({
    super.key,
    required this.client,
    required this.hostId,
    required this.item,
    this.onOpenTerminal,
    this.compact = false,
  });
  final RelayClient client;
  final String hostId;
  final AttentionItem item;
  final VoidCallback? onOpenTerminal;
  final bool compact;

  @override
  State<AttentionCard> createState() => _AttentionCardState();
}

class _AttentionCardState extends State<AttentionCard> {
  String? _busyKey;

  HostInfo? get host => widget.client.hosts[widget.hostId];
  bool get online => widget.client.state == ConnState.connected && (host?.online ?? false);

  Future<void> _answer(PromptOption o) async {
    setState(() => _busyKey = o.key);
    await guarded(context, () => widget.client.cmd(widget.hostId, 'approval.answer', {
          'termId': widget.item.termId,
          'approvalId': widget.item.id,
          'screenHash': widget.item.screenHash,
          'option': o.key,
          'label': o.label,
        }), success: 'Sent "${o.label}"');
    if (mounted) setState(() => _busyKey = null);
  }

  Future<void> _run(String key, String op, String done) async {
    setState(() => _busyKey = key);
    await guarded(context, () => widget.client.cmd(widget.hostId, op, {'termId': widget.item.termId}), success: done);
    if (mounted) setState(() => _busyKey = null);
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final snap = widget.client.snapshots[widget.hostId];
    final where = item.termId == null ? null : snap?.find(item.termId!);
    final color = switch (item.kind) { 'approval' => TV.orange, 'exited' => TV.red, _ => TV.accent };
    final canApprove = online && (host?.can('approve') ?? false);
    final canManage = online && (host?.can('manage') ?? false);

    return Card(
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border(left: BorderSide(color: color, width: 3)),
        ),
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            CharacterAvatar(type: where?.term.type, status: where?.term.status, size: 34),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(item.title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                Text(
                  [
                    if (where != null) where.ws.name,
                    if (widget.client.hosts.length > 1) host?.name ?? '',
                    ago(item.since),
                  ].where((s) => s.isNotEmpty).join(' · '),
                  style: const TextStyle(color: TV.dim, fontSize: 12),
                ),
              ]),
            ),
            if (widget.onOpenTerminal != null && item.termId != null)
              IconButton(
                tooltip: 'Open terminal',
                icon: const Icon(Icons.terminal_rounded, size: 20),
                onPressed: widget.onOpenTerminal,
              ),
          ]),
          const SizedBox(height: 10),
          if (item.kind == 'approval') ...[
            Text(item.question.isNotEmpty ? item.question : 'Waiting for your approval',
                style: const TextStyle(fontWeight: FontWeight.w600)),
            if (item.excerpt.isNotEmpty) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: TV.bg, borderRadius: BorderRadius.circular(8), border: Border.all(color: TV.border)),
                child: Text(item.excerpt, style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.35)),
              ),
            ],
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final o in item.options)
                _OptionButton(
                  option: o,
                  // Colour by meaning, not position: a trust dialog lists "No" first.
                  primary: o == item.options.firstWhere((x) => _yes.hasMatch(x.label), orElse: () => item.options.first),
                  negative: _no.hasMatch(o.label),
                  busy: _busyKey == o.key,
                  onPressed: canApprove && _busyKey == null ? () => _answer(o) : null,
                ),
            ]),
            if (!canApprove)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(online ? 'This phone cannot approve (pairing scope).' : 'PC offline — cannot answer now.',
                    style: const TextStyle(color: TV.faint, fontSize: 12)),
              ),
          ] else if (item.kind == 'ask') ...[
            Text(item.excerpt, maxLines: widget.compact ? 2 : 5, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: canApprove && _busyKey == null ? () => _run('push', 'bus.push', 'Nudged — it will check its mail') : null,
              icon: const Icon(Icons.mark_email_unread_outlined, size: 18),
              label: const Text('Nudge to read mail'),
            ),
          ] else if (item.kind == 'exited') ...[
            Text('Stopped unexpectedly (${item.excerpt}).', style: const TextStyle(color: TV.dim)),
            const SizedBox(height: 10),
            FilledButton.tonalIcon(
              onPressed: canManage && _busyKey == null ? () => _run('restore', 'term.restore', 'Restarting') : null,
              icon: const Icon(Icons.replay_rounded, size: 18),
              label: const Text('Resume session'),
            ),
          ],
        ]),
      ),
    );
  }
}

final _yes = RegExp(r'^(yes|approve|allow|proceed|accept|run|always|continue|trust|confirm)\b', caseSensitive: false);
final _no = RegExp(r'^(no|deny|reject|cancel|exit)\b', caseSensitive: false);

class _OptionButton extends StatelessWidget {
  const _OptionButton({required this.option, required this.primary, required this.negative, required this.busy, this.onPressed});
  final PromptOption option;
  final bool primary;
  final bool negative;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final child = busy
        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
        : Text(option.label, maxLines: 2, overflow: TextOverflow.ellipsis);
    if (primary) {
      return FilledButton(
        key: Key('opt-${option.key}'),
        onPressed: onPressed,
        style: FilledButton.styleFrom(backgroundColor: TV.green),
        child: child,
      );
    }
    return OutlinedButton(
      key: Key('opt-${option.key}'),
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(foregroundColor: negative ? TV.red : TV.text),
      child: child,
    );
  }
}
