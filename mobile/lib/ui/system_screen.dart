import 'package:flutter/material.dart';

import '../core/client.dart';
import 'pair_screen.dart';
import 'theme.dart';
import 'widgets.dart';

/// PCs, paired phones, the audit trail, and this phone's own pairing.
class SystemScreen extends StatefulWidget {
  const SystemScreen({super.key, required this.client});
  final RelayClient client;

  @override
  State<SystemScreen> createState() => _SystemScreenState();
}

class _SystemScreenState extends State<SystemScreen> {
  List<Map<String, dynamic>>? _devices;
  List<Map<String, dynamic>>? _audit;
  String? _loadedFor;

  RelayClient get client => widget.client;

  Future<void> _load() async {
    final hostId = client.selectedHostId;
    final host = client.host;
    if (hostId == null || host == null || !host.online || !host.can('manage')) return;
    _loadedFor = hostId;
    try {
      final d = await client.cmd(hostId, 'relay.devices');
      final a = await client.cmd(hostId, 'relay.audit', {'limit': 40});
      if (!mounted) return;
      setState(() {
        _devices = (d as List).whereType<Map<String, dynamic>>().toList();
        _audit = (a as List).whereType<Map<String, dynamic>>().toList();
      });
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) {
        if (client.state == ConnState.connected && client.selectedHostId != null && _loadedFor != client.selectedHostId) {
          WidgetsBinding.instance.addPostFrameCallback((_) => _load());
        }
        return RefreshIndicator(
          onRefresh: _load,
          child: ListView(padding: const EdgeInsets.fromLTRB(12, 8, 12, 32), children: [
            _section('PCs'),
            for (final h in client.hosts.values)
              Card(
                child: ListTile(
                  leading: Icon(Icons.computer_rounded, color: h.online ? TV.green : TV.faint),
                  title: Text(h.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text('${h.online ? 'online' : 'offline · last seen ${ago(h.lastSeen)}'}\ncan: ${h.scopes.join(', ')}'),
                  isThreeLine: true,
                  trailing: client.selectedHostId == h.id ? const Icon(Icons.check_circle_rounded, color: TV.accent) : null,
                  onTap: () => client.selectHost(h.id),
                ),
              ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => PairScreen(client: client, addingHost: true),
              )),
              icon: const Icon(Icons.add_link_rounded),
              label: const Text('Add another PC'),
            ),
            if (_devices != null) ...[
              _section('Phones paired with ${client.host?.name ?? 'this PC'}'),
              for (final d in _devices!)
                Card(
                  child: ListTile(
                    leading: Icon(Icons.smartphone_rounded, color: d['online'] == true ? TV.green : TV.faint),
                    title: Text('${d['name']}${d['deviceId'] == client.deviceId ? '  (this phone)' : ''}'),
                    subtitle: Text('${d['platform'] ?? ''} · ${(d['scopes'] as List? ?? []).join(', ')} · seen ${ago(d['lastSeen'] as int?)}'),
                    trailing: d['deviceId'] == client.deviceId
                        ? null
                        : IconButton(
                            tooltip: 'Revoke',
                            icon: const Icon(Icons.block_rounded, color: TV.red),
                            onPressed: () async {
                              final ok = await showDialog<bool>(
                                context: context,
                                builder: (dctx) => AlertDialog(
                                  title: Text('Revoke ${d['name']}?'),
                                  content: const Text('It is disconnected right away and has to be paired again.'),
                                  actions: [
                                    TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('Cancel')),
                                    FilledButton(
                                      style: FilledButton.styleFrom(backgroundColor: TV.red),
                                      onPressed: () => Navigator.pop(dctx, true),
                                      child: const Text('Revoke'),
                                    ),
                                  ],
                                ),
                              );
                              if (ok != true || !context.mounted) return;
                              await guarded(context, () => client.cmd(client.selectedHostId!, 'relay.revoke', {'deviceId': d['deviceId']}));
                              _load();
                            },
                          ),
                  ),
                ),
            ],
            if (_audit != null && _audit!.isNotEmpty) ...[
              _section('Recent actions (audit)'),
              Card(
                child: Column(children: [
                  for (final a in _audit!.take(25))
                    ListTile(
                      dense: true,
                      leading: Icon(
                        a['ok'] == 0 ? Icons.error_outline_rounded : Icons.check_rounded,
                        size: 18,
                        color: a['ok'] == 0 ? TV.red : TV.dim,
                      ),
                      title: Text('${a['op']}${a['error'] != null ? ' — ${a['error']}' : ''}',
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5)),
                      subtitle: Text('${clock((a['ts'] as num).toInt())} · ${a['device_id'] ?? 'PC'}',
                          style: const TextStyle(fontSize: 11.5)),
                    ),
                ]),
              ),
            ],
            _section('This phone'),
            Card(
              child: Column(children: [
                ListTile(
                  leading: const Icon(Icons.hub_outlined),
                  title: const Text('Relay'),
                  subtitle: Text(client.creds?.relayUrl ?? '—', style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5)),
                ),
                ListTile(
                  leading: Icon(Icons.circle, size: 14, color: client.state == ConnState.connected ? TV.green : TV.orange),
                  title: Text(switch (client.state) {
                    ConnState.connected => 'Connected',
                    ConnState.connecting => 'Connecting…',
                    ConnState.offline => 'Offline — retrying',
                    ConnState.revoked => 'Revoked',
                    ConnState.signedOut => 'Signed out',
                  }),
                  subtitle: Text('${client.creds?.deviceName ?? ''} · ${client.deviceId ?? ''}'),
                ),
              ]),
            ),
            const SizedBox(height: 14),
            HoldButton(
              label: 'unpair this phone',
              icon: Icons.logout_rounded,
              onConfirmed: () => client.signOut(),
            ),
          ]),
        );
      },
    );
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 18, 4, 8),
        child: Text(title.toUpperCase(),
            style: const TextStyle(fontSize: 11.5, letterSpacing: 0.8, fontWeight: FontWeight.w700, color: TV.faint)),
      );
}
