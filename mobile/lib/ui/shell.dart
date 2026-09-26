import 'package:flutter/material.dart';

import '../core/chat_model.dart';
import '../core/client.dart';
import 'activity_screen.dart';
import 'chat_list_screen.dart';
import 'inbox_screen.dart';
import 'system_screen.dart';
import 'theme.dart';
import 'widgets.dart';
import 'workspaces_screen.dart';

/// The five tabs: Inbox · Chat · Workspaces · Activity · System.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.client, required this.chats});
  final RelayClient client;
  final ChatModel chats;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) widget.client.resume();
  }

  static const _titles = ['Inbox', 'Chat', 'Workspaces', 'Activity', 'System'];

  @override
  Widget build(BuildContext context) {
    final client = widget.client;
    return ListenableBuilder(
      listenable: Listenable.merge([client, widget.chats]),
      builder: (context, _) {
        final inbox = client.allAttention.length;
        final unread = widget.chats.totalUnread;
        final host = client.host;
        return Scaffold(
          appBar: AppBar(
            title: Row(children: [
              Text(_titles[_tab], style: const TextStyle(fontWeight: FontWeight.w700)),
              const Spacer(),
              if (host != null) _HostPicker(client: client),
            ]),
          ),
          body: Column(children: [
            ConnectionBanner(client: client),
            Expanded(
              child: IndexedStack(index: _tab, children: [
                InboxScreen(client: client),
                ChatListScreen(client: client, chats: widget.chats),
                WorkspacesScreen(client: client),
                ActivityScreen(client: client, chats: widget.chats),
                SystemScreen(client: client),
              ]),
            ),
          ]),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (i) {
              setState(() => _tab = i);
              if (i == 1 || i == 3) widget.chats.refresh();
            },
            destinations: [
              NavigationDestination(
                icon: Badge(isLabelVisible: inbox > 0, label: Text('$inbox'), backgroundColor: TV.orange,
                    child: const Icon(Icons.inbox_outlined)),
                selectedIcon: Badge(isLabelVisible: inbox > 0, label: Text('$inbox'), backgroundColor: TV.orange,
                    child: const Icon(Icons.inbox_rounded)),
                label: 'Inbox',
              ),
              NavigationDestination(
                icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.forum_outlined)),
                selectedIcon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.forum_rounded)),
                label: 'Chat',
              ),
              const NavigationDestination(
                  icon: Icon(Icons.space_dashboard_outlined), selectedIcon: Icon(Icons.space_dashboard_rounded), label: 'Workspaces'),
              const NavigationDestination(icon: Icon(Icons.timeline_rounded), label: 'Activity'),
              const NavigationDestination(icon: Icon(Icons.tune_rounded), label: 'System'),
            ],
          ),
        );
      },
    );
  }
}

class _HostPicker extends StatelessWidget {
  const _HostPicker({required this.client});
  final RelayClient client;

  @override
  Widget build(BuildContext context) {
    final host = client.host!;
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: TV.raised, borderRadius: BorderRadius.circular(20), border: Border.all(color: TV.border)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.circle, size: 9, color: host.online && client.state == ConnState.connected ? TV.green : TV.faint),
        const SizedBox(width: 6),
        Text(host.name, style: const TextStyle(fontSize: 13)),
        if (client.hosts.length > 1) const Icon(Icons.arrow_drop_down_rounded, size: 18),
      ]),
    );
    if (client.hosts.length < 2) return chip;
    return PopupMenuButton<String>(
      onSelected: client.selectHost,
      itemBuilder: (_) => [
        for (final h in client.hosts.values)
          PopupMenuItem(
            value: h.id,
            child: Row(children: [
              Icon(Icons.circle, size: 9, color: h.online ? TV.green : TV.faint),
              const SizedBox(width: 8),
              Text(h.name),
            ]),
          ),
      ],
      child: chip,
    );
  }
}
