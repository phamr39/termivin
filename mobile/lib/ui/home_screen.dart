import 'dart:async';

import 'package:flutter/material.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import '../core/models.dart';
import 'activity_screen.dart';
import 'chat_screen.dart';
import 'inbox_screen.dart';
import 'new_terminal_sheet.dart';
import 'pair_screen.dart';
import 'scope.dart';
import 'system_screen.dart';
import 'term_actions.dart';
import 'theme.dart';
import 'widgets.dart';
import 'workspaces_screen.dart';

/// Telegram-style home: one chat list with folder tabs (All · Needs you ·
/// one per workspace), a drawer that switches PCs like accounts, search,
/// and a pencil button for a new terminal.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.client, required this.chats});
  final RelayClient client;
  final ChatModel chats;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  String _folder = 'all';
  bool _searching = false;
  final _search = TextEditingController();

  RelayClient get client => widget.client;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _search.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      client.resume();
      widget.chats.refresh();
    }
  }

  String _title() {
    return switch (client.state) {
      ConnState.connecting => 'Connecting…',
      ConnState.offline => 'Waiting for network…',
      ConnState.revoked => 'Pairing revoked',
      _ => client.host == null
          ? 'Termivin'
          : (client.host!.online ? client.host!.name : '${client.host!.name} · offline'),
    };
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([client, widget.chats]),
      builder: (context, _) {
        final snap = client.snapshot;
        final needs = client.attention[client.selectedHostId]?.length ?? 0;
        final folders = <({String id, String label, int badge})>[
          (id: 'all', label: 'All', badge: widget.chats.totalUnread),
          (id: 'needs', label: 'Needs you', badge: needs),
          for (final ws in snap?.workspaces ?? const <WorkspaceInfo>[])
            (id: ws.id, label: ws.name, badge: widget.chats.convs.where((c) => c.spaceId == ws.id).fold(0, (n, c) => n + c.unread)),
        ];
        if (!folders.any((f) => f.id == _folder)) _folder = 'all';
        final index = folders.indexWhere((f) => f.id == _folder);

        return DefaultTabController(
          key: ValueKey(folders.map((f) => f.id).join(',')),
          length: folders.length,
          initialIndex: index,
          child: Scaffold(
            drawer: _AppDrawer(client: client),
            appBar: AppBar(
              title: _searching
                  ? TextField(
                      controller: _search,
                      autofocus: true,
                      decoration: const InputDecoration(
                          hintText: 'Search', filled: false, border: InputBorder.none, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none),
                      onChanged: (_) => setState(() {}),
                    )
                  : Row(children: [
                      if (client.state == ConnState.connecting || client.state == ConnState.offline) ...[
                        const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                        const SizedBox(width: 10),
                      ],
                      Flexible(child: Text(_title(), overflow: TextOverflow.ellipsis)),
                    ]),
              actions: [
                IconButton(
                  icon: Icon(_searching ? Icons.close_rounded : Icons.search_rounded),
                  onPressed: () => setState(() {
                    _searching = !_searching;
                    _search.clear();
                  }),
                ),
              ],
              bottom: PreferredSize(
                preferredSize: const Size.fromHeight(46),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: TabBar(
                    isScrollable: true,
                    onTap: (i) => setState(() => _folder = folders[i].id),
                    tabs: [
                      for (final f in folders)
                        Tab(
                          height: 44,
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            Text(f.label),
                            if (f.badge > 0) ...[
                              const SizedBox(width: 6),
                              _Badge(count: f.badge, color: f.id == 'needs' ? TV.orange : TV.badge),
                            ],
                          ]),
                        ),
                    ],
                  ),
                ),
              ),
            ),
            body: Column(children: [
              if (client.host != null && !client.host!.online && client.state == ConnState.connected)
                ConnectionBanner(client: client),
              Expanded(
                child: _folder == 'needs'
                    ? InboxScreen(client: client)
                    : _ChatList(client: client, chats: widget.chats, folder: _folder, query: _searching ? _search.text : ''),
              ),
            ]),
            floatingActionButton: snap != null && client.host!.online && client.host!.can('manage')
                ? FloatingActionButton(
                    key: const Key('new-terminal'),
                    tooltip: 'New terminal',
                    onPressed: () => showNewTerminalSheet(context, client, client.selectedHostId!, snap),
                    child: const Icon(Icons.edit_rounded),
                  )
                : null,
          ),
        );
      },
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.count, this.color = TV.badge});
  final int count;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        constraints: const BoxConstraints(minWidth: 20),
        height: 20,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(10)),
        alignment: Alignment.center,
        child: Text('$count', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.white)),
      );
}

// ---------------------------------------------------------------- chat list

class _ChatList extends StatelessWidget {
  const _ChatList({required this.client, required this.chats, required this.folder, required this.query});
  final RelayClient client;
  final ChatModel chats;
  final String folder;
  final String query;

  @override
  Widget build(BuildContext context) {
    if (client.host == null) {
      return const EmptyState(icon: Icons.forum_outlined, title: 'No PC paired');
    }
    final hostId = client.selectedHostId!;
    final attention = client.attention[hostId] ?? const <AttentionItem>[];
    final waiting = {for (final a in attention) if (a.termId != null) a.termId!: a};
    final q = query.trim().toLowerCase();

    final rows = chats.convs.where((c) {
      if (folder != 'all' && c.spaceId != folder) return false;
      if (q.isEmpty) return true;
      return c.title.toLowerCase().contains(q) ||
          c.spaceName.toLowerCase().contains(q) ||
          (c.last?.preview.toLowerCase().contains(q) ?? false);
    }).toList()
      ..sort((a, b) {
        // pinned: waiting on you, then working, then by last activity
        int rank(Conversation c) {
          if (c.termId != null && waiting.containsKey(c.termId)) return 0;
          if (c.termId != null && client.progress['$hostId\u0000${c.termId}'] != null) return 1;
          return 2;
        }
        final r = rank(a).compareTo(rank(b));
        if (r != 0) return r;
        return (b.last?.ts ?? 0).compareTo(a.last?.ts ?? 0);
      });

    if (rows.isEmpty) {
      return RefreshIndicator(
        onRefresh: chats.refresh,
        child: ListView(children: [
          const SizedBox(height: 90),
          chats.loading
              ? const Center(child: CircularProgressIndicator())
              : EmptyState(
                  icon: Icons.forum_outlined,
                  title: q.isNotEmpty ? 'Nothing found' : (client.host!.online ? 'No chats yet' : 'PC offline'),
                  body: chats.error ??
                      (q.isNotEmpty
                          ? null
                          : client.host!.online
                              ? 'Terminals on ${client.host!.name} appear here — tap ✎ to start one.'
                              : 'Chats load when ${client.host!.name} is back online.'),
                ),
        ]),
      );
    }
    return RefreshIndicator(
      onRefresh: chats.refresh,
      child: ListView.builder(
        itemCount: rows.length,
        itemBuilder: (context, i) => _ChatRow(
          client: client,
          chats: chats,
          conv: rows[i],
          waiting: rows[i].termId == null ? null : waiting[rows[i].termId],
          showSpace: folder == 'all',
        ),
      ),
    );
  }
}

class _ChatRow extends StatelessWidget {
  const _ChatRow({required this.client, required this.chats, required this.conv, this.waiting, this.showSpace = false});
  final RelayClient client;
  final ChatModel chats;
  final Conversation conv;
  final AttentionItem? waiting;
  final bool showSpace;

  @override
  Widget build(BuildContext context) {
    final hostId = client.selectedHostId!;
    final group = conv.kind == 'group';
    final snap = client.snapshot;
    final term = conv.termId == null ? null : snap?.find(conv.termId!)?.term;
    final status = term?.status ?? conv.status;
    final working = conv.termId == null ? null : client.progress['$hostId\u0000${conv.termId}'];
    final last = conv.last;

    // Preview line, Telegram-like: live state first, then the last message.
    Widget preview;
    if (waiting != null) {
      preview = Text(
        waiting!.kind == 'approval'
            ? '⚠ Waiting for approval${waiting!.question.isNotEmpty ? ': ${waiting!.question}' : ''}'
            : waiting!.kind == 'exited' ? '✖ Stopped unexpectedly' : '✉ ${waiting!.excerpt}',
        maxLines: 1, overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: TV.orange, fontSize: 14.5),
      );
    } else if (working != null) {
      preview = _TypingText(text: working.last.isNotEmpty ? 'working · ${working.last}' : 'working');
    } else if (last == null) {
      preview = Text(group ? '${conv.members.length} member${conv.members.length == 1 ? '' : 's'}' : (term?.summary.isNotEmpty == true ? term!.summary : 'No messages yet'),
          maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: TV.dim, fontSize: 14.5));
    } else {
      final who = last.mine
          ? 'You'
          : last.role == 'desktop'
              ? 'You (PC)'
              : group ? (last.fromName ?? '') : '';
      preview = Text.rich(
        TextSpan(children: [
          if (who.isNotEmpty) TextSpan(text: '$who: ', style: TextStyle(color: last.mine ? TV.link : TV.text)),
          TextSpan(text: last.preview.replaceAll('\n', ' ')),
        ]),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: TV.dim, fontSize: 14.5),
      );
    }

    return InkWell(
      key: Key('conv-${conv.conv}'),
      onTap: () => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => ChatScreen(client: client, chats: chats, hostId: hostId, conv: conv),
      )),
      onLongPress: () {
        final found = conv.termId == null ? null : snap?.find(conv.termId!);
        if (found != null) showTermActions(context, hostId, found.ws, found.term);
      },
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 7, 12, 7),
        child: Row(children: [
          group ? GroupAvatar(name: conv.title, size: 54) : CharacterAvatar(type: conv.type, status: status, size: 54),
          const SizedBox(width: 12),
          Expanded(
            child: Container(
              padding: const EdgeInsets.only(bottom: 9, top: 2),
              decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: TV.divider))),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  if (group) const Padding(padding: EdgeInsets.only(right: 4), child: Icon(Icons.groups_rounded, size: 17, color: TV.text)),
                  Expanded(
                    child: Text.rich(
                      TextSpan(children: [
                        TextSpan(text: conv.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: TV.text)),
                        if (showSpace && !group && conv.spaceName.isNotEmpty)
                          TextSpan(text: '  ${conv.spaceName}', style: const TextStyle(fontSize: 12.5, color: TV.faint)),
                      ]),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (last != null && last.mine && last.state != null)
                    Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: Icon(last.state == 'queued' ? Icons.schedule_rounded : Icons.done_all_rounded, size: 16, color: TV.accentBright),
                    ),
                  if (last != null) Text(clock(last.ts), style: const TextStyle(color: TV.dim, fontSize: 12.5)),
                ]),
                const SizedBox(height: 4),
                Row(children: [
                  Expanded(child: preview),
                  if (waiting != null)
                    const Padding(padding: EdgeInsets.only(left: 8), child: _Badge(count: 1, color: TV.orange))
                  else if (conv.unread > 0)
                    Padding(padding: const EdgeInsets.only(left: 8), child: _Badge(count: conv.unread)),
                ]),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

/// "working…" with animated dots, in the accent colour — Telegram's "typing…".
class _TypingText extends StatefulWidget {
  const _TypingText({required this.text});
  final String text;

  @override
  State<_TypingText> createState() => _TypingTextState();
}

class _TypingTextState extends State<_TypingText> {
  Timer? _t;
  int _n = 0;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 420), (_) => setState(() => _n = (_n + 1) % 4));
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text('${widget.text}${'.' * _n}',
      maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: TV.accentBright, fontSize: 14.5));
}

// ---------------------------------------------------------------- drawer

class _AppDrawer extends StatefulWidget {
  const _AppDrawer({required this.client});
  final RelayClient client;

  @override
  State<_AppDrawer> createState() => _AppDrawerState();
}

class _AppDrawerState extends State<_AppDrawer> {
  bool _accounts = false;

  void _open(String title, Widget body) {
    Navigator.of(context).pop();
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => Scaffold(appBar: AppBar(title: Text(title)), body: body),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final client = widget.client;
    final host = client.host;
    return Drawer(
      child: ListView(padding: EdgeInsets.zero, children: [
        Container(
          color: TV.header,
          padding: EdgeInsets.fromLTRB(18, MediaQuery.of(context).padding.top + 18, 12, 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            GroupAvatar(name: host?.name ?? 'Termivin', size: 64),
            const SizedBox(height: 14),
            InkWell(
              onTap: () => setState(() => _accounts = !_accounts),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(host?.name ?? 'No PC', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(client.creds?.relayUrl ?? '', style: const TextStyle(color: TV.dim, fontSize: 13)),
                  ]),
                ),
                Icon(_accounts ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: TV.dim),
              ]),
            ),
          ]),
        ),
        if (_accounts) ...[
          for (final h in client.hosts.values)
            ListTile(
              leading: Stack(clipBehavior: Clip.none, children: [
                GroupAvatar(name: h.name, size: 36),
                if (h.online) const Positioned(right: -1, bottom: -1, child: StatusDot(status: 'idle', size: 11, ring: true)),
              ]),
              title: Text(h.name),
              subtitle: Text(h.online ? 'online' : 'last seen ${ago(h.lastSeen)}', style: const TextStyle(fontSize: 12.5)),
              trailing: h.id == client.selectedHostId ? const Icon(Icons.check_circle_rounded, color: TV.accentBright) : null,
              onTap: () {
                client.selectHost(h.id);
                Navigator.of(context).pop();
              },
            ),
          ListTile(
            leading: const Icon(Icons.add_rounded),
            title: const Text('Add PC'),
            onTap: () {
              Navigator.of(context).pop();
              Navigator.of(context).push(MaterialPageRoute(builder: (_) => PairScreen(client: client, addingHost: true)));
            },
          ),
          const Divider(),
        ],
        ListTile(
          leading: const Icon(Icons.space_dashboard_outlined),
          title: const Text('Workspaces'),
          onTap: () => _open('Workspaces', WorkspacesScreen(client: client)),
        ),
        ListTile(
          leading: const Icon(Icons.timeline_rounded),
          title: const Text('Activity'),
          onTap: () => _open('Activity', ActivityScreen(client: client, chats: AppScope.of(context).chats)),
        ),
        ListTile(
          leading: const Icon(Icons.settings_outlined),
          title: const Text('Settings'),
          subtitle: const Text('PCs, paired phones, audit, unpair', style: TextStyle(fontSize: 12.5)),
          onTap: () => _open('Settings', SystemScreen(client: client)),
        ),
        const Divider(),
        const Padding(
          padding: EdgeInsets.fromLTRB(18, 12, 18, 18),
          child: Text('Termivin — your terminals and AI agents, from your phone.', style: TextStyle(color: TV.faint, fontSize: 12.5)),
        ),
      ]),
    );
  }
}
