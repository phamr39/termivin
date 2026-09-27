import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../core/models.dart';
import 'theme.dart';
import 'widgets.dart';

// Telegram-style chat pieces: bubbles with the time (and ✓✓) tucked inside,
// grouped runs, service pills, and "bot" messages with an inline keyboard.

MarkdownStyleSheet mdStyle(BuildContext context, {Color color = TV.text}) {
  final base = MarkdownStyleSheet.fromTheme(Theme.of(context));
  return base.copyWith(
    p: TextStyle(color: color, height: 1.35, fontSize: 15.5),
    h1: TextStyle(color: color, fontSize: 17, fontWeight: FontWeight.w700),
    h2: TextStyle(color: color, fontSize: 16.5, fontWeight: FontWeight.w700),
    h3: TextStyle(color: color, fontSize: 16, fontWeight: FontWeight.w700),
    strong: TextStyle(color: color, fontWeight: FontWeight.w700),
    listBullet: TextStyle(color: color, fontSize: 15.5),
    code: const TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFFE6C07B), backgroundColor: Colors.transparent),
    codeblockDecoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(8)),
    codeblockPadding: const EdgeInsets.all(10),
    blockquoteDecoration: const BoxDecoration(border: Border(left: BorderSide(color: TV.link, width: 3))),
    blockquotePadding: const EdgeInsets.only(left: 10),
    tableBorder: TableBorder.all(color: TV.faint.withValues(alpha: 0.5)),
    a: const TextStyle(color: TV.link),
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

/// Where a bubble sits in a run of messages from the same sender.
class RunPos {
  const RunPos({required this.first, required this.last});
  final bool first; // oldest of the run: show the sender name
  final bool last; // newest of the run: tail + avatar
}

/// Bubble shell: colour, corner shape with a tail on the last of a run,
/// optional avatar (groups) and an inline keyboard underneath.
class BubbleFrame extends StatelessWidget {
  const BubbleFrame({
    super.key,
    required this.out,
    required this.pos,
    required this.child,
    this.avatar,
    this.showAvatarSlot = false,
    this.keyboard,
    this.onLongPress,
    this.maxWidthFactor = 0.8,
  });
  final bool out;
  final RunPos pos;
  final Widget child;
  final Widget? avatar;
  final bool showAvatarSlot;
  final Widget? keyboard;
  final VoidCallback? onLongPress;
  final double maxWidthFactor;

  @override
  Widget build(BuildContext context) {
    const r = Radius.circular(16);
    const small = Radius.circular(5);
    final shape = BorderRadius.only(
      topLeft: out ? r : (pos.first ? r : small),
      bottomLeft: out ? r : (pos.last ? small : small),
      topRight: out ? (pos.first ? r : small) : r,
      bottomRight: out ? (pos.last ? small : small) : r,
    );
    final maxW = MediaQuery.of(context).size.width * maxWidthFactor;
    final bubble = Column(crossAxisAlignment: out ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
      GestureDetector(
        onLongPress: onLongPress,
        child: Container(
          constraints: BoxConstraints(maxWidth: maxW),
          padding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
          decoration: BoxDecoration(color: out ? TV.bubbleOut : TV.bubbleIn, borderRadius: shape),
          child: child,
        ),
      ),
      if (keyboard != null) ConstrainedBox(constraints: BoxConstraints(maxWidth: maxW), child: keyboard!),
    ]);
    return Padding(
      padding: EdgeInsets.only(top: pos.first ? 6 : 1.5, bottom: 1.5),
      child: Row(
        mainAxisAlignment: out ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!out && showAvatarSlot) ...[
            SizedBox(width: 34, child: pos.last ? avatar : null),
            const SizedBox(width: 6),
          ],
          Flexible(child: bubble),
          if (out) const SizedBox(width: 2),
        ],
      ),
    );
  }
}

/// "12:54 ✓✓" in the bubble's corner.
class BubbleTime extends StatelessWidget {
  const BubbleTime({super.key, required this.ts, this.out = false, this.state});
  final int ts;
  final bool out;
  final String? state;

  @override
  Widget build(BuildContext context) {
    final color = out ? const Color(0xFF7DA8D3) : TV.dim;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Text(clock(ts), style: TextStyle(fontSize: 11.5, color: color)),
      if (out && state != null) ...[
        const SizedBox(width: 3),
        Icon(state == 'queued' ? Icons.schedule_rounded : Icons.done_all_rounded, size: 15, color: const Color(0xFF7DB8F0)),
      ],
    ]);
  }
}

/// Text and the time on one line when they fit, time wrapping under otherwise.
class _TextWithTime extends StatelessWidget {
  const _TextWithTime({required this.text, required this.time});
  final Widget text;
  final Widget time;

  @override
  Widget build(BuildContext context) => Wrap(
        alignment: WrapAlignment.end,
        crossAxisAlignment: WrapCrossAlignment.end,
        spacing: 8,
        children: [text, Padding(padding: const EdgeInsets.only(top: 3), child: time)],
      );
}

class SenderName extends StatelessWidget {
  const SenderName({super.key, required this.name, required this.color, this.suffix});
  final String name;
  final Color color;
  final String? suffix;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 2),
        child: Text.rich(TextSpan(children: [
          TextSpan(text: name, style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 14.5)),
          if (suffix != null) TextSpan(text: '  $suffix', style: const TextStyle(color: TV.dim, fontSize: 12.5)),
        ])),
      );
}

/// Ordinary message: owner (out), agent mail / bus traffic / desktop prompt (in).
class TextBubble extends StatelessWidget {
  const TextBubble({super.key, required this.msg, required this.pos, required this.group, this.type, this.onLongPress});
  final ChatMessage msg;
  final RunPos pos;
  final bool group;
  final String? type;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final m = msg;
    final out = m.mine || m.role == 'desktop';
    final senderColor = TV.character(type).color;
    final suffix = [
      if (m.kind == 'bus' && m.toName != null) '→ ${m.toName}',
      if (m.topic != null) '#${m.topic}',
      if (m.via == 'bus' && !m.mine) 'via bus',
    ].join(' ');
    final time = BubbleTime(ts: m.ts, out: out, state: m.mine ? m.state : null);
    return BubbleFrame(
      out: out,
      pos: pos,
      showAvatarSlot: group && !out,
      avatar: CharacterAvatar(type: type, size: 34),
      onLongPress: onLongPress,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        if (m.role == 'desktop' && pos.first) const SenderName(name: 'You', color: Color(0xFF9CC6EE), suffix: 'on the PC'),
        if (!out && pos.first && (group || suffix.isNotEmpty) && m.fromName != null)
          SenderName(name: m.fromName!, color: senderColor, suffix: suffix.isEmpty ? null : suffix),
        if (m.subject.isNotEmpty) Text(m.subject, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
        if (out)
          _TextWithTime(
            text: Text(m.text, style: const TextStyle(fontSize: 15.5, height: 1.3, color: Colors.white)),
            time: time,
          )
        else ...[
          MarkdownBody(data: m.text, styleSheet: mdStyle(context)),
          Align(alignment: Alignment.centerRight, child: time),
        ],
        if (m.state == 'queued')
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: Text('waiting until it is idle', style: TextStyle(fontSize: 11.5, color: Color(0xFF9CC6EE))),
          ),
      ]),
    );
  }
}

/// Inline keyboard row (Telegram bot buttons).
class InlineKeyboard extends StatelessWidget {
  const InlineKeyboard({super.key, required this.rows});
  final List<List<Widget>> rows;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 3),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Row(children: [
                for (var i = 0; i < row.length; i++) ...[
                  if (i > 0) const SizedBox(width: 3),
                  Expanded(child: row[i]),
                ],
              ]),
            ),
        ]),
      );
}

class InlineButton extends StatelessWidget {
  const InlineButton({super.key, required this.label, this.onTap, this.icon, this.color, this.busy = false});
  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final Color? color;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final fg = onTap == null ? TV.faint : (color ?? Colors.white);
    return Material(
      color: TV.inlineButton.withValues(alpha: 0.9),
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: busy ? null : onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 38),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          alignment: Alignment.center,
          child: busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : Row(mainAxisSize: MainAxisSize.min, children: [
                  if (icon != null) ...[Icon(icon, size: 16, color: fg), const SizedBox(width: 5)],
                  Flexible(
                    child: Text(label,
                        maxLines: 2, textAlign: TextAlign.center, overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: fg, fontSize: 14, fontWeight: FontWeight.w500)),
                  ),
                ]),
        ),
      ),
    );
  }
}

/// A finished turn: "✓ Done · 9s", the headline, and inline buttons for the
/// full reply and the step list.
class SummaryBubble extends StatefulWidget {
  const SummaryBubble({super.key, required this.msg, required this.pos, required this.group, this.type, this.onOpenTerminal});
  final ChatMessage msg;
  final RunPos pos;
  final bool group;
  final String? type;
  final VoidCallback? onOpenTerminal;

  @override
  State<SummaryBubble> createState() => _SummaryBubbleState();
}

class _SummaryBubbleState extends State<SummaryBubble> {
  bool _full = false;
  bool _steps = false;

  static String _tail(String text, int n) {
    final lines = text.split('\n');
    return lines.length <= n ? text : lines.sublist(lines.length - n).join('\n');
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.msg;
    final st = m.stats;
    final stopped = m.interrupted || st['exited'] == true;
    final facts = [
      if ((st['edit'] ?? 0) > 0) '✎ ${st['edit']}',
      if ((st['command'] ?? 0) > 0) '▶ ${st['command']}',
      if ((st['read'] ?? 0) > 0) '🔎 ${st['read']}',
      if (st['durationMs'] != null) duration(st['durationMs'] as num?),
    ].join('  ·  ');
    final longReply = m.text.trim() != m.headline.trim() && m.text.length > m.headline.length + 20;
    final moreOutput = m.mono && m.text.split('\n').length > 8;

    final buttons = <Widget>[
      if (longReply || moreOutput)
        InlineButton(
          label: _full ? 'Show less' : (m.mono ? 'Full output' : 'Full reply'),
          icon: _full ? Icons.unfold_less_rounded : Icons.article_outlined,
          onTap: () => setState(() => _full = !_full),
        ),
      if (m.steps.isNotEmpty)
        InlineButton(
          label: _steps ? 'Hide steps' : 'Steps (${m.steps.length})',
          icon: Icons.list_alt_rounded,
          onTap: () => setState(() => _steps = !_steps),
        ),
      if (widget.onOpenTerminal != null)
        InlineButton(label: 'Terminal', icon: Icons.terminal_rounded, onTap: widget.onOpenTerminal),
    ];

    return BubbleFrame(
      out: false,
      pos: widget.pos,
      showAvatarSlot: widget.group,
      avatar: CharacterAvatar(type: widget.type, size: 34),
      maxWidthFactor: 0.86,
      onLongPress: () {
        Clipboard.setData(ClipboardData(text: m.text));
        toast(context, 'Copied');
      },
      keyboard: buttons.isEmpty ? null : InlineKeyboard(rows: [buttons]),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        if (widget.group && widget.pos.first && m.fromName != null)
          SenderName(name: m.fromName!, color: TV.character(widget.type).color),
        Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(stopped ? Icons.pause_circle_filled_rounded : Icons.check_circle_rounded, size: 16, color: stopped ? TV.orange : TV.green),
          const SizedBox(width: 5),
          Text(m.interrupted ? 'Stopped' : (st['exited'] == true ? 'Exited' : 'Done'),
              style: TextStyle(color: stopped ? TV.orange : TV.green, fontWeight: FontWeight.w700, fontSize: 13.5)),
          if (facts.isNotEmpty)
            Flexible(
              child: Text('  ·  $facts', maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: TV.dim, fontSize: 12.5)),
            ),
        ]),
        if (m.prompt.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(top: 5),
            padding: const EdgeInsets.only(left: 8),
            decoration: const BoxDecoration(border: Border(left: BorderSide(color: TV.link, width: 2.5))),
            child: Text(m.prompt.replaceAll('\n', ' '),
                maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: TV.dim, fontSize: 13)),
          ),
        const SizedBox(height: 6),
        if (m.mono)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(8)),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SelectableText(_full ? m.text : _tail(m.text, 8),
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35)),
            ),
          )
        else if (_full)
          MarkdownBody(data: m.text, selectable: true, styleSheet: mdStyle(context))
        else
          Text(m.headline.isNotEmpty ? m.headline : m.text, style: const TextStyle(fontSize: 15.5, height: 1.35)),
        if (_steps && m.steps.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(8)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final s in m.steps)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 1.5),
                  child: Text(s, maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: TV.dim)),
                ),
            ]),
          ),
        Align(alignment: Alignment.centerRight, child: BubbleTime(ts: m.ts)),
      ]),
    );
  }
}

/// A prompt waiting on the owner, shown as a bot message with its options
/// as inline buttons — answering goes through the same verified path as the
/// inbox (the PC checks the prompt is still on screen).
class AttentionBubble extends StatelessWidget {
  const AttentionBubble({
    super.key,
    required this.item,
    required this.onOption,
    required this.onAction,
    this.type,
    this.enabled = true,
    this.busyKey,
  });
  final AttentionItem item;
  final void Function(PromptOption) onOption;
  final void Function(String op) onAction; // 'bus.push' | 'term.restore'
  final String? type;
  final bool enabled;
  final String? busyKey;

  static final _yes = RegExp(r'^(yes|approve|allow|proceed|accept|run|always|continue|trust|confirm)\b', caseSensitive: false);
  static final _no = RegExp(r'^(no|deny|reject|cancel|exit)\b', caseSensitive: false);

  @override
  Widget build(BuildContext context) {
    final i = item;
    List<List<Widget>> rows;
    if (i.kind == 'approval') {
      final opts = i.options;
      final short = opts.length <= 2 && opts.every((o) => o.label.length < 14);
      Widget b(PromptOption o) => InlineButton(
            label: o.label,
            busy: busyKey == o.key,
            color: _yes.hasMatch(o.label) ? const Color(0xFF8FE08E) : _no.hasMatch(o.label) ? const Color(0xFFFF8A80) : null,
            onTap: enabled ? () => onOption(o) : null,
          );
      rows = short ? [opts.map(b).toList()] : [for (final o in opts) [b(o)]];
    } else if (i.kind == 'ask') {
      rows = [[InlineButton(label: 'Nudge to read mail', icon: Icons.mark_email_unread_outlined, busy: busyKey == 'push', onTap: enabled ? () => onAction('bus.push') : null)]];
    } else {
      rows = [[InlineButton(label: 'Resume session', icon: Icons.replay_rounded, busy: busyKey == 'restore', onTap: enabled ? () => onAction('term.restore') : null)]];
    }
    final title = switch (i.kind) {
      'approval' => 'Needs your approval',
      'ask' => 'Waiting for a reply',
      _ => 'Stopped unexpectedly',
    };
    return BubbleFrame(
      out: false,
      pos: const RunPos(first: true, last: true),
      maxWidthFactor: 0.9,
      keyboard: InlineKeyboard(rows: rows),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(i.kind == 'approval' ? Icons.front_hand_rounded : i.kind == 'ask' ? Icons.mark_email_unread_rounded : Icons.error_rounded,
              size: 16, color: TV.orange),
          const SizedBox(width: 6),
          Text(title, style: const TextStyle(color: TV.orange, fontWeight: FontWeight.w700, fontSize: 14)),
        ]),
        const SizedBox(height: 5),
        if (i.question.isNotEmpty) Text(i.question, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w500, height: 1.3)),
        if (i.excerpt.isNotEmpty) ...[
          const SizedBox(height: 6),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(8)),
            child: Text(i.excerpt, style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.35)),
          ),
        ],
        if (!enabled)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('PC offline or this phone lacks the scope', style: TextStyle(color: TV.faint, fontSize: 12)),
          ),
        Align(alignment: Alignment.centerRight, child: BubbleTime(ts: i.since ?? DateTime.now().millisecondsSinceEpoch)),
      ]),
    );
  }
}

/// A photo, Telegram-style: the image fills the bubble, the time sits on it
/// (or under the caption); tap for the full-screen viewer.
class ImageBubble extends StatefulWidget {
  const ImageBubble({
    super.key,
    required this.msg,
    required this.pos,
    required this.group,
    required this.load,
    this.type,
  });
  final ChatMessage msg;
  final RunPos pos;
  final bool group;
  final Future<Uint8List> Function(String id) load;
  final String? type;

  @override
  State<ImageBubble> createState() => _ImageBubbleState();
}

class _ImageBubbleState extends State<ImageBubble> {
  Future<Uint8List>? _bytes;

  @override
  void initState() {
    super.initState();
    final media = widget.msg.media;
    if (media != null) _bytes = widget.load(media.id);
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.msg;
    final media = m.media;
    final width = MediaQuery.of(context).size.width * 0.72;
    final aspect = (media?.aspect ?? 1.6).clamp(0.5, 2.2);
    final time = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.45), borderRadius: BorderRadius.circular(10)),
      child: Text(clock(m.ts), style: const TextStyle(fontSize: 11.5, color: Colors.white)),
    );
    final picture = FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (context, snap) {
        if (snap.hasData) {
          return GestureDetector(
            onTap: () => Navigator.of(context).push(PageRouteBuilder(
              opaque: false,
              pageBuilder: (_, __, ___) => ImageViewer(bytes: snap.data!, title: m.fromName ?? '', subtitle: clock(m.ts), caption: m.text),
              transitionsBuilder: (_, a, __, child) => FadeTransition(opacity: a, child: child),
            )),
            child: Hero(tag: 'img-${m.id}', child: Image.memory(snap.data!, fit: BoxFit.cover, gaplessPlayback: true)),
          );
        }
        return Container(
          color: Colors.black.withValues(alpha: 0.25),
          alignment: Alignment.center,
          child: snap.hasError
              ? Column(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.broken_image_outlined, color: TV.dim),
                  TextButton(
                    onPressed: media == null ? null : () => setState(() => _bytes = widget.load(media.id)),
                    child: const Text('Retry'),
                  ),
                ])
              : const SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.4)),
        );
      },
    );
    return BubbleFrame(
      out: false,
      pos: widget.pos,
      showAvatarSlot: widget.group,
      avatar: CharacterAvatar(type: widget.type, size: 34),
      maxWidthFactor: 0.76,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        if (widget.group && widget.pos.first && m.fromName != null)
          SenderName(name: m.fromName!, color: TV.character(widget.type).color),
        ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: SizedBox(
            width: width,
            child: AspectRatio(
              aspectRatio: aspect.toDouble(),
              child: Stack(fit: StackFit.expand, children: [
                picture,
                if (m.text.isEmpty) Positioned(right: 6, bottom: 6, child: time),
              ]),
            ),
          ),
        ),
        if (m.text.isNotEmpty) ...[
          const SizedBox(height: 5),
          _TextWithTime(text: Text(m.text, style: const TextStyle(fontSize: 15.5, height: 1.3)), time: BubbleTime(ts: m.ts)),
        ],
      ]),
    );
  }
}

/// Full-screen photo: pinch to zoom, drag down or tap × to close.
class ImageViewer extends StatelessWidget {
  const ImageViewer({super.key, required this.bytes, required this.title, required this.subtitle, this.caption = ''});
  final Uint8List bytes;
  final String title;
  final String subtitle;
  final String caption;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black.withValues(alpha: 0.6),
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w600)),
          Text(subtitle, style: const TextStyle(fontSize: 13, color: TV.dim)),
        ]),
      ),
      body: Stack(children: [
        Positioned.fill(
          child: InteractiveViewer(
            minScale: 1,
            maxScale: 6,
            child: Center(child: Image.memory(bytes, fit: BoxFit.contain)),
          ),
        ),
        if (caption.isNotEmpty)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              color: Colors.black.withValues(alpha: 0.6),
              padding: EdgeInsets.fromLTRB(16, 12, 16, 12 + MediaQuery.of(context).padding.bottom),
              child: Text(caption, style: const TextStyle(fontSize: 15)),
            ),
          ),
      ]),
    );
  }
}

/// Centered translucent pill — dates and service messages.
class ServicePill extends StatelessWidget {
  const ServicePill({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 4),
            decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.28), borderRadius: BorderRadius.circular(14)),
            child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w500)),
          ),
        ),
      );
}

String dayLabel(int ts) {
  final d = DateTime.fromMillisecondsSinceEpoch(ts);
  final now = DateTime.now();
  final diff = DateTime(now.year, now.month, now.day).difference(DateTime(d.year, d.month, d.day)).inDays;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Yesterday';
  return d.year == now.year ? '${months[d.month - 1]} ${d.day}' : '${months[d.month - 1]} ${d.day}, ${d.year}';
}

/// The chat wallpaper: Telegram's dark blue with a faint doodle of Termivin
/// glyphs.
class ChatWallpaper extends StatelessWidget {
  const ChatWallpaper({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => CustomPaint(painter: _DoodlePainter(), child: child);
}

class _DoodlePainter extends CustomPainter {
  static const _glyphs = ['✳', '›_', '◆', '⚙', '{ }', '#', '✓', '⌘'];

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(
      Offset.zero & size,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF0E1621), Color(0xFF111D2B), Color(0xFF0E1621)],
        ).createShader(Offset.zero & size),
    );
    const step = 74.0;
    var k = 0;
    for (double y = 18; y < size.height; y += step) {
      for (double x = (y ~/ step).isOdd ? 40 : 6; x < size.width; x += step) {
        final tp = TextPainter(
          text: TextSpan(
            text: _glyphs[k++ % _glyphs.length],
            style: TextStyle(color: Colors.white.withValues(alpha: 0.035), fontSize: 20, fontWeight: FontWeight.w700),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        tp.paint(canvas, Offset(x, y));
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
