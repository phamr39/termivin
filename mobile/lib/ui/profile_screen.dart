import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import '../core/models.dart';
import 'chat_screen.dart';
import 'term_actions.dart';
import 'terminal_screen.dart';
import 'theme.dart';
import 'widgets.dart';

/// Telegram-style info page for a terminal (big avatar, action buttons,
/// details) or a workspace group (members).
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.client, required this.chats, required this.hostId, required this.conv});
  final RelayClient client;
  final ChatModel chats;
  final String hostId;
  final Conversation conv;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) {
        final snap = client.snapshots[hostId];
        final host = client.hosts[hostId];
        final online = client.state == ConnState.connected && (host?.online ?? false);
        final manage = online && (host?.can('manage') ?? false);
        if (conv.kind == 'group') {
          final ws = snap?.workspaces.where((w) => w.id == conv.spaceId).firstOrNull;
          return _GroupProfile(client: client, chats: chats, hostId: hostId, conv: conv, ws: ws);
        }
        final found = conv.termId == null ? null : snap?.find(conv.termId!);
        final t = found?.term;
        return Scaffold(
          body: CustomScrollView(slivers: [
            SliverAppBar(
              pinned: true,
              expandedHeight: 230,
              actions: [
                if (found != null)
                  IconButton(
                    icon: const Icon(Icons.more_vert_rounded),
                    onPressed: () => showTermActions(context, hostId, found.ws, found.term),
                  ),
              ],
              flexibleSpace: FlexibleSpaceBar(
                titlePadding: const EdgeInsetsDirectional.only(start: 56, bottom: 14),
                title: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(conv.title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  Text(TV.statusLabel(t?.status), style: TextStyle(fontSize: 12, color: TV.status(t?.status))),
                ]),
                background: Container(
                  color: TV.header,
                  alignment: Alignment.center,
                  padding: const EdgeInsets.only(bottom: 40),
                  child: CharacterAvatar(type: t?.type ?? conv.type, status: t?.status, size: 96),
                ),
              ),
            ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                child: Row(children: [
                  _BigButton(icon: Icons.chat_bubble_rounded, label: 'Chat', onTap: () => Navigator.of(context).pop()),
                  _BigButton(
                    icon: Icons.terminal_rounded,
                    label: 'Terminal',
                    onTap: conv.termId == null
                        ? null
                        : () => Navigator.of(context).push(MaterialPageRoute(
                              builder: (_) => TerminalScreen(client: client, hostId: hostId, termId: conv.termId!),
                            )),
                  ),
                  if (t != null && t.running)
                    _BigButton(
                      icon: Icons.restart_alt_rounded,
                      label: 'Restart',
                      onTap: manage ? () => guarded(context, () => client.cmd(hostId, 'term.restart', {'termId': t.id}), success: 'Restarting') : null,
                    )
                  else
                    _BigButton(
                      icon: Icons.play_arrow_rounded,
                      label: 'Resume',
                      onTap: manage && t != null && !t.external
                          ? () => guarded(context, () => client.cmd(hostId, 'term.restore', {'termId': t.id}), success: 'Starting')
                          : null,
                    ),
                  _BigButton(
                    icon: Icons.stop_rounded,
                    label: 'Stop',
                    color: TV.red,
                    onTap: manage && t != null && t.running && found != null
                        ? () => showTermActions(context, hostId, found.ws, found.term)
                        : null,
                  ),
                ]),
              ),
            ),
            if (t != null)
              SliverToBoxAdapter(
                child: _Section(children: [
                  if (t.title != null) _Info(icon: Icons.bookmark_outline_rounded, label: 'Session', value: t.title!),
                  if (t.summary.isNotEmpty) _Info(icon: Icons.short_text_rounded, label: 'Doing', value: t.summary, mono: true),
                  _Info(icon: Icons.folder_outlined, label: 'Folder', value: t.cwd.isEmpty ? 'home' : t.cwd, mono: true, copy: true),
                  _Info(icon: Icons.category_outlined, label: 'Type', value: switch (t.type) {
                    'claude' => 'Claude Code',
                    'codex' => 'Codex',
                    'shell' || 'cmd' => 'Shell',
                    _ => t.type,
                  }),
                  if (t.type == 'claude')
                    _Info(icon: Icons.shield_outlined, label: 'Permission mode', value: switch (t.permissionMode) {
                      'auto' => 'Auto',
                      'acceptEdits' => 'Accept file edits',
                      'plan' => 'Plan only',
                      _ => 'Ask each time',
                    }),
                  if (t.restoreCommand.isNotEmpty) _Info(icon: Icons.replay_rounded, label: 'Resume command', value: t.restoreCommand, mono: true),
                  if (t.pendingMail > 0) _Info(icon: Icons.mark_email_unread_outlined, label: 'Unread bus mail', value: '${t.pendingMail}'),
                  _Info(icon: Icons.workspaces_outline, label: 'Workspace', value: found!.ws.name),
                ]),
              ),
            if (found != null)
              SliverToBoxAdapter(
                child: _Section(children: [
                  ListTile(
                    leading: const Icon(Icons.tune_rounded),
                    title: const Text('Manage — rename, permission mode, nudge…'),
                    onTap: () => showTermActions(context, hostId, found.ws, found.term),
                  ),
                ]),
              ),
            const SliverToBoxAdapter(child: SizedBox(height: 40)),
          ]),
        );
      },
    );
  }
}

class _GroupProfile extends StatelessWidget {
  const _GroupProfile({required this.client, required this.chats, required this.hostId, required this.conv, required this.ws});
  final RelayClient client;
  final ChatModel chats;
  final String hostId;
  final Conversation conv;
  final WorkspaceInfo? ws;

  @override
  Widget build(BuildContext context) {
    final members = ws?.terminals ?? const <TermInfo>[];
    final topics = (client.snapshots[hostId]?.topics ?? const []).where((t) => t['spaceId'] == conv.spaceId).toList();
    return Scaffold(
      body: CustomScrollView(slivers: [
        SliverAppBar(
          pinned: true,
          expandedHeight: 220,
          flexibleSpace: FlexibleSpaceBar(
            titlePadding: const EdgeInsetsDirectional.only(start: 56, bottom: 14),
            title: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(conv.title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              Text('${members.length} members', style: const TextStyle(fontSize: 12, color: TV.dim)),
            ]),
            background: Container(
              color: TV.header,
              alignment: Alignment.center,
              padding: const EdgeInsets.only(bottom: 40),
              child: GroupAvatar(name: conv.title, size: 92),
            ),
          ),
        ),
        if (topics.isNotEmpty)
          SliverToBoxAdapter(
            child: _Section(title: 'Topics', children: [
              for (final t in topics)
                ListTile(
                  leading: const Icon(Icons.tag_rounded),
                  title: Text('#${t['name']}'),
                  subtitle: Text(t['rep'] != null ? 'represented by ${t['rep']}' : 'no representative'),
                ),
            ]),
          ),
        SliverToBoxAdapter(
          child: _Section(title: '${members.length} members', children: [
            for (final m in members)
              ListTile(
                leading: CharacterAvatar(type: m.external ? 'external' : m.type, status: m.status, size: 42),
                title: Text(m.name),
                subtitle: Text(
                  m.status == 'working' ? 'working' : TV.statusLabel(m.status),
                  style: TextStyle(color: m.status == 'working' || m.status == 'idle' ? TV.accentBright : TV.dim),
                ),
                onTap: m.external || ws == null
                    ? null
                    : () => Navigator.of(context).pushReplacement(MaterialPageRoute(
                          builder: (_) => ChatScreen(client: client, chats: chats, hostId: hostId, conv: dmFor(ws!, m)),
                        )),
              ),
          ]),
        ),
        const SliverToBoxAdapter(child: SizedBox(height: 40)),
      ]),
    );
  }
}

class _BigButton extends StatelessWidget {
  const _BigButton({required this.icon, required this.label, this.onTap, this.color});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final fg = onTap == null ? TV.faint : (color ?? TV.accentBright);
    return Expanded(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Material(
          color: TV.raised,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Column(children: [
                Icon(icon, color: fg),
                const SizedBox(height: 4),
                Text(label, style: TextStyle(color: fg, fontSize: 12.5, fontWeight: FontWeight.w500)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.children, this.title});
  final List<Widget> children;
  final String? title;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(top: 10),
        color: TV.raised,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (title != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
              child: Text(title!, style: const TextStyle(color: TV.accentBright, fontWeight: FontWeight.w600, fontSize: 14.5)),
            ),
          ...children,
        ]),
      );
}

class _Info extends StatelessWidget {
  const _Info({required this.icon, required this.label, required this.value, this.mono = false, this.copy = false});
  final IconData icon;
  final String label;
  final String value;
  final bool mono;
  final bool copy;

  @override
  Widget build(BuildContext context) => ListTile(
        leading: Icon(icon),
        title: Text(value, style: TextStyle(fontFamily: mono ? 'monospace' : null, fontSize: mono ? 14 : 15.5)),
        subtitle: Text(label, style: const TextStyle(color: TV.dim, fontSize: 13)),
        onLongPress: () {
          Clipboard.setData(ClipboardData(text: value));
          toast(context, 'Copied');
        },
        trailing: copy
            ? IconButton(
                icon: const Icon(Icons.copy_rounded, size: 18),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: value));
                  toast(context, 'Copied');
                },
              )
            : null,
      );
}
