import 'package:flutter/material.dart';

import '../core/client.dart';
import '../core/models.dart';
import 'chat_screen.dart';
import 'scope.dart';
import 'terminal_screen.dart';
import 'theme.dart';
import 'widgets.dart';

Conversation dmFor(WorkspaceInfo ws, TermInfo t) => Conversation(
      conv: 'dm:${t.id}', kind: 'dm', title: t.name, spaceId: ws.id, spaceName: ws.name,
      termId: t.id, type: t.type, status: t.status,
    );

void openChat(BuildContext context, String hostId, WorkspaceInfo ws, TermInfo t) {
  final scope = AppScope.of(context);
  Navigator.of(context).push(MaterialPageRoute(
    builder: (_) => ChatScreen(client: scope.client, chats: scope.chats, hostId: hostId, conv: dmFor(ws, t)),
  ));
}

void openTerminal(BuildContext context, String hostId, String termId) {
  Navigator.of(context).push(MaterialPageRoute(
    builder: (_) => TerminalScreen(client: AppScope.of(context).client, hostId: hostId, termId: termId),
  ));
}

const _modes = [
  ('', 'Ask each time', 'Default — every tool call asks'),
  ('auto', 'Auto', 'Claude vets each call itself — for long unattended runs'),
  ('acceptEdits', 'Accept file edits', 'Edits go through, commands still ask'),
  ('plan', 'Plan only', 'Reads and plans, changes nothing'),
];

/// Lifecycle actions for one terminal — the phone's version of the pane ⋯ menu.
Future<void> showTermActions(BuildContext context, String hostId, WorkspaceInfo ws, TermInfo t, {bool fromTerminal = false}) {
  final client = AppScope.of(context).client;
  final host = client.hosts[hostId];
  final online = client.state == ConnState.connected && (host?.online ?? false);
  final manage = online && (host?.can('manage') ?? false);
  final running = t.running;

  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (sheet) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ListTile(
            leading: CharacterAvatar(type: t.type, status: t.status, size: 40),
            title: Text(t.name, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text('${ws.name} · ${TV.statusLabel(t.status)}${t.cwd.isNotEmpty ? '\n${t.cwd}' : ''}'),
            isThreeLine: t.cwd.isNotEmpty,
          ),
          const Divider(),
          if (!t.external) ...[
            if (t.agent) ListTile(
              leading: const Icon(Icons.chat_bubble_outline_rounded),
              title: const Text('Chat'),
              onTap: () {
                Navigator.pop(sheet);
                openChat(context, hostId, ws, t);
              },
            ),
            if (!fromTerminal)
              ListTile(
                leading: const Icon(Icons.terminal_rounded),
                title: const Text('Open terminal'),
                onTap: () {
                  Navigator.pop(sheet);
                  openTerminal(context, hostId, t.id);
                },
              ),
          ],
          if (manage && !t.external) ...[
            if (running)
              ListTile(
                leading: const Icon(Icons.restart_alt_rounded, color: TV.accent),
                title: const Text('Restart (keep session)'),
                subtitle: Text(t.restoreCommand.isNotEmpty ? 'Runs: ${t.restoreCommand}' : 'Starts it again with its resume command'),
                onTap: () async {
                  Navigator.pop(sheet);
                  await guarded(context, () => client.cmd(hostId, 'term.restart', {'termId': t.id}), success: 'Restarting ${t.name}');
                },
              )
            else
              ListTile(
                leading: const Icon(Icons.play_arrow_rounded, color: TV.green),
                title: const Text('Resume'),
                subtitle: Text(t.restoreCommand.isNotEmpty ? t.restoreCommand : 'Start the terminal'),
                onTap: () async {
                  Navigator.pop(sheet);
                  await guarded(context, () => client.cmd(hostId, 'term.restore', {'termId': t.id}), success: 'Starting ${t.name}');
                },
              ),
            if (t.isAgent && running)
              ListTile(
                leading: const Icon(Icons.mark_email_unread_outlined),
                title: const Text('Nudge to check bus mail'),
                subtitle: Text(t.pendingMail > 0 ? '${t.pendingMail} unread message(s)' : 'Types "termivin recv" when it is idle'),
                onTap: () async {
                  Navigator.pop(sheet);
                  await guarded(context, () => client.cmd(hostId, 'bus.push', {'termId': t.id}), success: 'Nudged');
                },
              ),
            if (t.type == 'claude')
              ListTile(
                leading: const Icon(Icons.shield_outlined),
                title: const Text('Permission mode'),
                subtitle: Text(_modes.firstWhere((m) => m.$1 == t.permissionMode, orElse: () => _modes.first).$2),
                onTap: () {
                  Navigator.pop(sheet);
                  _pickMode(context, client, hostId, t);
                },
              ),
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('Rename'),
              onTap: () {
                Navigator.pop(sheet);
                _rename(context, client, hostId, t);
              },
            ),
            if (running)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                child: HoldButton(
                  label: 'stop the process',
                  icon: Icons.stop_rounded,
                  onConfirmed: () async {
                    Navigator.pop(sheet);
                    await guarded(context, () => client.cmd(hostId, 'term.stop', {'termId': t.id}), success: 'Stopped ${t.name}');
                  },
                ),
              ),
          ],
          if (!online)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('The PC is offline — actions come back when it reconnects.', style: TextStyle(color: TV.dim)),
            ),
        ]),
      ),
    ),
  );
}

Future<void> _rename(BuildContext context, RelayClient client, String hostId, TermInfo t) async {
  final ctl = TextEditingController(text: t.name);
  final name = await showDialog<String>(
    context: context,
    builder: (d) => AlertDialog(
      title: const Text('Rename terminal'),
      content: TextField(controller: ctl, autofocus: true, maxLength: 28),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(d, ctl.text.trim()), child: const Text('Rename')),
      ],
    ),
  );
  if (name == null || name.isEmpty || !context.mounted) return;
  await guarded(context, () => client.cmd(hostId, 'term.rename', {'termId': t.id, 'name': name}), success: 'Renamed');
}

Future<void> _pickMode(BuildContext context, RelayClient client, String hostId, TermInfo t) async {
  var restart = true;
  final mode = await showModalBottomSheet<String>(
    context: context,
    builder: (sheet) => StatefulBuilder(
      builder: (sheet, setSheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const ListTile(title: Text('Permission mode', style: TextStyle(fontWeight: FontWeight.w700))),
          for (final m in _modes)
            ListTile(
              leading: Icon(m.$1 == t.permissionMode ? Icons.radio_button_checked : Icons.radio_button_off,
                  color: m.$1 == t.permissionMode ? TV.accent : TV.dim),
              title: Text(m.$2),
              subtitle: Text(m.$3),
              onTap: () => Navigator.pop(sheet, m.$1),
            ),
          if (t.running)
            SwitchListTile(
              value: restart,
              onChanged: (v) => setSheet(() => restart = v),
              title: const Text('Restart now to apply (session kept)'),
            ),
        ]),
      ),
    ),
  );
  if (mode == null || !context.mounted) return;
  await guarded(context, () => client.cmd(hostId, 'term.mode', {'termId': t.id, 'mode': mode, 'restart': restart}),
      success: 'Permission mode updated');
}
