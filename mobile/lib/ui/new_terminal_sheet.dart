import 'package:flutter/material.dart';

import '../core/client.dart';
import '../core/models.dart';
import 'theme.dart';
import 'widgets.dart';

/// Start a new terminal on the PC: which workspace, which kind of agent, in
/// which folder (recent Claude Code projects are suggested), which mode.
Future<void> showNewTerminalSheet(BuildContext context, RelayClient client, String hostId, Snapshot snap) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (_) => _NewTerminalSheet(client: client, hostId: hostId, snap: snap),
  );
}

class _NewTerminalSheet extends StatefulWidget {
  const _NewTerminalSheet({required this.client, required this.hostId, required this.snap});
  final RelayClient client;
  final String hostId;
  final Snapshot snap;

  @override
  State<_NewTerminalSheet> createState() => _NewTerminalSheetState();
}

class _NewTerminalSheetState extends State<_NewTerminalSheet> {
  late String _spaceId = widget.snap.activeWorkspaceId ?? (widget.snap.workspaces.isEmpty ? '' : widget.snap.workspaces.first.id);
  String _type = 'claude';
  String _mode = '';
  final _cwd = TextEditingController();
  final _name = TextEditingController();
  List<String> _recent = [];
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.client.cmd(widget.hostId, 'term.presets').then((data) {
      if (!mounted || data is! Map) return;
      setState(() {
        _recent = (data['recentProjects'] as List? ?? const []).map((e) => e.toString()).toList();
        if (_cwd.text.isEmpty && _recent.isNotEmpty) _cwd.text = _recent.first;
      });
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _cwd.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    setState(() => _busy = true);
    final r = await guarded(context, () => widget.client.cmd(widget.hostId, 'term.create', {
          'spaceId': _spaceId,
          'type': _type,
          'cwd': _cwd.text.trim(),
          if (_name.text.trim().isNotEmpty) 'name': _name.text.trim(),
          if (_type == 'claude') 'mode': _mode,
        }));
    if (!mounted) return;
    setState(() => _busy = false);
    if (r is Map) {
      Navigator.pop(context);
      toast(context, 'Started ${r['name']}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 0, 18, 18 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          const Text('New terminal', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 14),
          DropdownButtonFormField<String>(
            initialValue: _spaceId.isEmpty ? null : _spaceId,
            decoration: const InputDecoration(labelText: 'Workspace'),
            items: [for (final ws in widget.snap.workspaces) DropdownMenuItem(value: ws.id, child: Text(ws.name))],
            onChanged: (v) => setState(() => _spaceId = v ?? _spaceId),
          ),
          const SizedBox(height: 14),
          Wrap(spacing: 8, children: [
            for (final t in const [('claude', 'Claude Code'), ('codex', 'Codex'), ('shell', 'Shell')])
              ChoiceChip(
                avatar: Text(TV.character(t.$1).glyph, style: TextStyle(color: TV.character(t.$1).color)),
                label: Text(t.$2),
                selected: _type == t.$1,
                onSelected: (_) => setState(() => _type = t.$1),
              ),
          ]),
          const SizedBox(height: 14),
          TextField(
            controller: _cwd,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
            decoration: const InputDecoration(labelText: 'Folder on the PC', hintText: 'empty = home folder'),
          ),
          if (_recent.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final p in _recent.take(6))
                ActionChip(
                  label: Text(p.split(RegExp(r'[\\/]')).where((s) => s.isNotEmpty).lastOrNull ?? p),
                  onPressed: () => setState(() => _cwd.text = p),
                ),
            ]),
          ],
          if (_type == 'claude') ...[
            const SizedBox(height: 14),
            DropdownButtonFormField<String>(
              initialValue: _mode,
              decoration: const InputDecoration(labelText: 'Permission mode'),
              items: const [
                DropdownMenuItem(value: '', child: Text('Ask each time (default)')),
                DropdownMenuItem(value: 'auto', child: Text('Auto — Claude vets each call')),
                DropdownMenuItem(value: 'acceptEdits', child: Text('Accept file edits')),
                DropdownMenuItem(value: 'plan', child: Text('Plan only')),
              ],
              onChanged: (v) => setState(() => _mode = v ?? ''),
            ),
          ],
          const SizedBox(height: 14),
          TextField(controller: _name, maxLength: 28, decoration: const InputDecoration(labelText: 'Name (optional)')),
          const SizedBox(height: 6),
          FilledButton(
            onPressed: _busy || _spaceId.isEmpty ? null : _create,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Start'),
          ),
        ]),
      ),
    );
  }
}
