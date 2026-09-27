import 'package:flutter/material.dart';

import '../core/client.dart';
import 'theme.dart';

/// The round "character" avatar of a terminal, with its live status dot.
class CharacterAvatar extends StatelessWidget {
  const CharacterAvatar({super.key, required this.type, this.status, this.size = 40, this.name});
  final String? type;
  final String? status;
  final double size;
  final String? name;

  @override
  Widget build(BuildContext context) {
    final c = TV.character(type);
    // Telegram-style: a filled gradient disc, white glyph, and a small
    // "online" dot while the terminal runs.
    final running = status == 'idle' || status == 'working' || status == 'approval';
    return SizedBox(
      width: size,
      height: size,
      child: Stack(clipBehavior: Clip.none, children: [
        Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color.lerp(c.color, Colors.white, 0.18)!, c.color],
            ),
          ),
          alignment: Alignment.center,
          child: Text(c.glyph,
              style: TextStyle(color: Colors.white, fontSize: size * 0.4, fontWeight: FontWeight.w700, height: 1.05)),
        ),
        if (running)
          Positioned(
            right: size * 0.01,
            bottom: size * 0.01,
            child: StatusDot(status: status, size: (size * 0.28).clamp(9, 16).toDouble(), ring: true),
          ),
      ]),
    );
  }
}

/// A workspace's avatar: its initials on a peer colour, like a Telegram group.
class GroupAvatar extends StatelessWidget {
  const GroupAvatar({super.key, required this.name, this.size = 40});
  final String name;
  final double size;

  static String initials(String name) {
    final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return '#';
    if (words.length == 1) return words.first.substring(0, words.first.length >= 2 ? 2 : 1).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final color = TV.peerColor(name);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color.lerp(color, Colors.white, 0.18)!, color],
        ),
      ),
      alignment: Alignment.center,
      child: Text(initials(name),
          style: TextStyle(color: Colors.white, fontSize: size * 0.36, fontWeight: FontWeight.w700)),
    );
  }
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.status, this.size = 9, this.ring = false});
  final String? status;
  final double size;
  final bool ring;

  @override
  Widget build(BuildContext context) {
    final color = TV.status(status);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color,
        border: ring ? Border.all(color: TV.bg, width: 2) : null,
        boxShadow: (status == 'working' || status == 'approval')
            ? [BoxShadow(color: color.withValues(alpha: 0.6), blurRadius: 6)]
            : null,
      ),
    );
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.status});
  final String? status;

  @override
  Widget build(BuildContext context) {
    final color = TV.status(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(20)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        StatusDot(status: status, size: 7),
        const SizedBox(width: 5),
        Text(TV.statusLabel(status), style: TextStyle(color: color, fontSize: 11.5, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

/// Banner shown while the relay or the PC is unreachable: everything on
/// screen is the last known state, and actions are disabled.
class ConnectionBanner extends StatelessWidget {
  const ConnectionBanner({super.key, required this.client});
  final RelayClient client;

  @override
  Widget build(BuildContext context) {
    String? text;
    Color color = TV.orange;
    if (client.state == ConnState.connecting) {
      text = 'Connecting to the relay…';
    } else if (client.state == ConnState.offline) {
      text = client.lastError ?? 'Relay unreachable — retrying';
    } else if (client.state == ConnState.revoked) {
      text = client.lastError;
      color = TV.red;
    } else if (client.host != null && !client.host!.online) {
      text = '${client.host!.name} is offline — showing data from ${ago(client.host!.lastSeen)}. Actions are disabled.';
    }
    if (text == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      color: color.withValues(alpha: 0.14),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      child: Row(children: [
        Icon(Icons.cloud_off_rounded, size: 16, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: TextStyle(color: color, fontSize: 12.5))),
      ]),
    );
  }
}

String ago(int? ms) {
  if (ms == null) return 'unknown';
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
  if (d.inSeconds < 45) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  return '${d.inDays} d ago';
}

String clock(int ms) {
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  final hm = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  if (t.year == now.year && t.month == now.month && t.day == now.day) return hm;
  return '${t.day}/${t.month} $hm';
}

void toast(BuildContext context, String text, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(text),
      backgroundColor: error ? TV.red.withValues(alpha: 0.95) : null,
      duration: Duration(milliseconds: error ? 3500 : 1800),
    ));
}

/// Runs a command and reports failures as a snackbar.
Future<T?> guarded<T>(BuildContext context, Future<T> Function() fn, {String? success}) async {
  try {
    final r = await fn();
    if (success != null && context.mounted) toast(context, success);
    return r;
  } on CmdError catch (e) {
    if (context.mounted) toast(context, e.message, error: true);
  } catch (e) {
    if (context.mounted) toast(context, e.toString(), error: true);
  }
  return null;
}

/// A button that only fires after being held — for destructive actions.
class HoldButton extends StatefulWidget {
  const HoldButton({super.key, required this.label, required this.onConfirmed, this.color = TV.red, this.icon});
  final String label;
  final VoidCallback onConfirmed;
  final Color color;
  final IconData? icon;

  @override
  State<HoldButton> createState() => _HoldButtonState();
}

class _HoldButtonState extends State<HoldButton> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))
    ..addStatusListener((s) {
      if (s == AnimationStatus.completed) {
        widget.onConfirmed();
        _c.reset();
      }
    });

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTapDown: (_) => _c.forward(),
      onTapUp: (_) => _c.reverse(),
      onTapCancel: () => _c.reverse(),
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) => Container(
          height: 44,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: widget.color.withValues(alpha: 0.6)),
            gradient: LinearGradient(colors: [
              widget.color.withValues(alpha: 0.35),
              widget.color.withValues(alpha: 0.35),
              Colors.transparent,
              Colors.transparent,
            ], stops: [0, _c.value, _c.value, 1]),
          ),
          alignment: Alignment.center,
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (widget.icon != null) Icon(widget.icon, size: 18, color: widget.color),
            if (widget.icon != null) const SizedBox(width: 6),
            Text(_c.isAnimating || _c.value > 0 ? 'Keep holding…' : 'Hold to ${widget.label}',
                style: TextStyle(color: widget.color, fontWeight: FontWeight.w600)),
          ]),
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.body});
  final IconData icon;
  final String title;
  final String? body;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 44, color: TV.faint),
          const SizedBox(height: 12),
          Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600), textAlign: TextAlign.center),
          if (body != null) ...[
            const SizedBox(height: 6),
            Text(body!, style: const TextStyle(color: TV.dim, fontSize: 13), textAlign: TextAlign.center),
          ],
        ]),
      ),
    );
  }
}
