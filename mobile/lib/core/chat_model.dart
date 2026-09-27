import 'dart:async';

import 'package:flutter/foundation.dart';

import 'client.dart';
import 'models.dart';

/// Conversation list of the selected PC, kept fresh from chat events.
class ChatModel extends ChangeNotifier {
  ChatModel(this.client) {
    _sub = client.chatEvents.listen((e) {
      if (e.hostId != client.selectedHostId) return;
      _debounce?.cancel();
      _debounce = Timer(const Duration(milliseconds: 350), refresh);
    });
    client.addListener(_onClient);
  }

  final RelayClient client;
  StreamSubscription? _sub;
  Timer? _debounce;
  String? _hostId;
  ConnState? _lastState;

  List<Conversation> convs = [];
  bool loading = false;
  String? error;

  int get totalUnread => convs.fold(0, (n, c) => n + c.unread);

  void _onClient() {
    final hostChanged = client.selectedHostId != _hostId;
    final reconnected = client.state == ConnState.connected && _lastState != ConnState.connected;
    _lastState = client.state;
    if (hostChanged) {
      _hostId = client.selectedHostId;
      convs = [];
      notifyListeners();
    }
    if ((hostChanged || reconnected) && client.state == ConnState.connected) refresh();
  }

  Future<void> refresh() async {
    final hostId = client.selectedHostId;
    if (hostId == null || client.state != ConnState.connected || client.host?.online != true) return;
    loading = true;
    notifyListeners();
    try {
      final data = await client.cmd(hostId, 'chat.list');
      if (hostId != client.selectedHostId) return;
      convs = (data as List).whereType<Map<String, dynamic>>().map(Conversation.fromJson).toList();
      error = null;
    } on CmdError catch (e) {
      error = e.message;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> markRead(String conv, int ts) async {
    final hostId = client.selectedHostId;
    if (hostId == null) return;
    try {
      await client.cmd(hostId, 'chat.read', {'conv': conv, 'ts': ts});
    } catch (_) {}
    final i = convs.indexWhere((c) => c.conv == conv);
    if (i != -1 && convs[i].unread > 0) {
      final c = convs[i];
      convs[i] = Conversation(
        conv: c.conv, kind: c.kind, title: c.title, spaceId: c.spaceId, spaceName: c.spaceName,
        termId: c.termId, type: c.type, status: c.status, members: c.members, last: c.last, unread: 0,
      );
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _debounce?.cancel();
    client.removeListener(_onClient);
    super.dispose();
  }
}
