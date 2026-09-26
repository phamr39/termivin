import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../core/models.dart';
import 'theme.dart';
import 'widgets.dart';

MarkdownStyleSheet _md(BuildContext context, {Color color = TV.text}) {
  final base = MarkdownStyleSheet.fromTheme(Theme.of(context));
  return base.copyWith(
    p: TextStyle(color: color, height: 1.4, fontSize: 14.5),
    h1: TextStyle(color: color, fontSize: 17, fontWeight: FontWeight.w700),
    h2: TextStyle(color: color, fontSize: 16, fontWeight: FontWeight.w700),
    h3: TextStyle(color: color, fontSize: 15, fontWeight: FontWeight.w700),
    listBullet: TextStyle(color: color),
    code: const TextStyle(fontFamily: 'monospace', fontSize: 12.5, backgroundColor: TV.bg, color: Color(0xFFE6C07B)),
    codeblockDecoration: BoxDecoration(color: TV.bg, borderRadius: BorderRadius.circular(8), border: Border.all(color: TV.border)),
    codeblockPadding: const EdgeInsets.all(10),
    blockquoteDecoration: BoxDecoration(border: const Border(left: BorderSide(color: TV.faint, width: 3)), color: TV.panel),
    tableBorder: TableBorder.all(color: TV.border),
    a: const TextStyle(color: TV.accent),
  );
}

String duration(num? ms) {
  if (ms == null) return '';
  final s = (ms / 1000).round();
  if (s < 60) return '${s}s';
  final m = s ~/ 60;
  if (m < 60) return '${m}m ${s % 60}s';
  return '${m ~/ 60}h ${m % 60}m';
}

/// One finished turn of an agent's work: a headline, what it did, and the
/// full reply / step list on demand.
class SummaryBubble extends StatefulWidget {
  const SummaryBubble({super.key, required this.msg, this.type});
  final ChatMessage msg;
  final String? type;

  @override
  State<SummaryBubble> createState() => _SummaryBubbleState();
}

class _SummaryBubbleState extends State<SummaryBubble> {
  bool _full = false;
  bool _steps = false;

  @override
  Widget build(BuildContext context) {
    final m = widget.msg;
    final c = TV.character(widget.type);
    final st = m.stats;
    final chips = <(IconData, String)>[
      if ((st['edit'] ?? 0) > 0) (Icons.edit_outlined, '${st['edit']} edit${st['edit'] == 1 ? '' : 's'}'),
      if ((st['command'] ?? 0) > 0) (Icons.play_arrow_rounded, '${st['command']} command${st['command'] == 1 ? '' : 's'}'),
      if ((st['read'] ?? 0) > 0) (Icons.search_rounded, '${st['read']} read${st['read'] == 1 ? '' : 's'}'),
      if (st['durationMs'] != null) (Icons.timer_outlined, duration(st['durationMs'] as num?)),
    ];
    final longReply = m.text.trim() != m.headline.trim() && m.text.length > m.headline.length + 20;
    final statusColor = m.interrupted || st['exited'] == true ? TV.orange : TV.green;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        CharacterAvatar(type: widget.type, size: 28),
        const SizedBox(width: 8),
        Flexible(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.84),
            child: Container(
              padding: const EdgeInsets.fromLTRB(12, 9, 12, 7),
              decoration: BoxDecoration(
                color: TV.raised,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(14), topRight: Radius.circular(14),
                  bottomLeft: Radius.circular(4), bottomRight: Radius.circular(14),
                ),
                border: Border.all(color: c.color.withValues(alpha: 0.35)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Icon(m.interrupted ? Icons.pause_circle_outline_rounded : Icons.check_circle_rounded, size: 15, color: statusColor),
                  const SizedBox(width: 5),
                  Text(m.interrupted ? 'Stopped' : (st['exited'] == true ? 'Exited' : 'Done'),
                      style: TextStyle(color: statusColor, fontSize: 12, fontWeight: FontWeight.w700)),
                  if (m.prompt.isNotEmpty) ...[
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text('· ${m.prompt.replaceAll('\n', ' ')}',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: TV.faint, fontSize: 12)),
                    ),
                  ],
                ]),
                const SizedBox(height: 6),
                if (m.mono)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(color: TV.bg, borderRadius: BorderRadius.circular(8)),
                    child: SelectableText(
                      _full ? m.text : _tail(m.text, 6),
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
                    ),
                  )
                else if (_full)
                  MarkdownBody(data: m.text, selectable: true, styleSheet: _md(context))
                else
                  Text(m.headline.isNotEmpty ? m.headline : m.text,
                      style: const TextStyle(fontSize: 14.5, height: 1.4, fontWeight: FontWeight.w500)),
                if (chips.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Wrap(spacing: 10, runSpacing: 4, children: [
                    for (final (icon, label) in chips)
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        Icon(icon, size: 13, color: TV.dim),
                        const SizedBox(width: 3),
                        Text(label, style: const TextStyle(color: TV.dim, fontSize: 12)),
                      ]),
                  ]),
                ],
                if (_steps && m.steps.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: 8),
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(color: TV.bg, borderRadius: BorderRadius.circular(8)),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      for (final s in m.steps)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 1.5),
                          child: Text(s, maxLines: 2, overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: TV.dim)),
                        ),
                    ]),
                  ),
                Row(children: [
                  if (longReply || (m.mono && m.text.split('\n').length > 6))
                    _Link(label: _full ? 'Less' : (m.mono ? 'Full output' : 'Full reply'), onTap: () => setState(() => _full = !_full)),
                  if (m.steps.isNotEmpty)
                    _Link(label: _steps ? 'Hide steps' : '${m.steps.length} step${m.steps.length == 1 ? '' : 's'}',
                        onTap: () => setState(() => _steps = !_steps)),
                  const Spacer(),
                  InkWell(
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: m.text));
                      toast(context, 'Copied');
                    },
                    child: const Padding(padding: EdgeInsets.all(4), child: Icon(Icons.copy_rounded, size: 14, color: TV.faint)),
                  ),
                  const SizedBox(width: 6),
                  Text(clock(m.ts), style: const TextStyle(fontSize: 10.5, color: TV.faint)),
                ]),
              ]),
            ),
          ),
        ),
      ]),
    );
  }

  static String _tail(String text, int n) {
    final lines = text.split('\n');
    return lines.length <= n ? text : lines.sublist(lines.length - n).join('\n');
  }
}

class _Link extends StatelessWidget {
  const _Link({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(0, 6, 14, 2),
          child: Text(label, style: const TextStyle(color: TV.accent, fontSize: 12.5, fontWeight: FontWeight.w600)),
        ),
      );
}

/// "TermiPearl is working · 4 steps · ▶ npm test" — live, replaced by the
/// summary when the turn ends.
class ProgressBubble extends StatefulWidget {
  const ProgressBubble({super.key, required this.progress, required this.name, this.type});
  final TurnProgress progress;
  final String name;
  final String? type;

  @override
  State<ProgressBubble> createState() => _ProgressBubbleState();
}

class _ProgressBubbleState extends State<ProgressBubble> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.progress;
    final since = p.startedAt == null ? null : DateTime.now().millisecondsSinceEpoch - p.startedAt!;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        CharacterAvatar(type: widget.type, status: 'working', size: 28),
        const SizedBox(width: 8),
        Flexible(
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
            decoration: BoxDecoration(
              color: TV.accent.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: TV.accent.withValues(alpha: 0.35)),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(mainAxisSize: MainAxisSize.min, children: [
                const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.8, color: TV.accent)),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    '${widget.name} is working${p.steps > 0 ? ' · ${p.steps} step${p.steps == 1 ? '' : 's'}' : ''}${since != null ? ' · ${duration(since)}' : ''}',
                    style: const TextStyle(color: TV.accent, fontSize: 12.5, fontWeight: FontWeight.w600),
                  ),
                ),
              ]),
              if (p.last.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(p.last, maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: TV.dim)),
              ],
            ]),
          ),
        ),
      ]),
    );
  }
}

/// Plain chat bubble (owner, agent-to-owner mail, bus traffic, desktop prompts).
class TextBubble extends StatelessWidget {
  const TextBubble({super.key, required this.msg, required this.showName, this.type});
  final ChatMessage msg;
  final bool showName;
  final String? type;

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
      // Older history, before turns were summarized.
      return Padding(
        padding: const EdgeInsets.only(left: 38, top: 1, bottom: 1, right: 40),
        child: Text(m.text, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: TV.faint)),
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
            CharacterAvatar(type: type, size: 28),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
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
                              color: mine ? Colors.white70 : TV.character(type).color)),
                    ),
                  if (m.subject.isNotEmpty) Text(m.subject, style: const TextStyle(fontWeight: FontWeight.w700)),
                  if (right)
                    SelectableText(m.text, style: TextStyle(color: mine ? Colors.white : TV.text, height: 1.35))
                  else
                    MarkdownBody(data: m.text, selectable: true, styleSheet: _md(context)),
                  const SizedBox(height: 3),
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    Text(clock(m.ts), style: TextStyle(fontSize: 10.5, color: mine ? Colors.white60 : TV.faint)),
                    if (mine && m.state != null) ...[
                      const SizedBox(width: 4),
                      Icon(m.state == 'queued' ? Icons.schedule_rounded : Icons.done_all_rounded, size: 13, color: Colors.white70),
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

/// "Today", "Yesterday", "Mon 21/9" between messages of different days.
class DaySeparator extends StatelessWidget {
  const DaySeparator({super.key, required this.ts});
  final int ts;

  @override
  Widget build(BuildContext context) {
    final d = DateTime.fromMillisecondsSinceEpoch(ts);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    final diff = today.difference(day).inDays;
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    final label = diff == 0 ? 'Today' : diff == 1 ? 'Yesterday' : '${names[d.weekday - 1]} ${d.day}/${d.month}';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(children: [
        const Expanded(child: Divider()),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Text(label, style: const TextStyle(color: TV.faint, fontSize: 11.5, fontWeight: FontWeight.w600)),
        ),
        const Expanded(child: Divider()),
      ]),
    );
  }
}
