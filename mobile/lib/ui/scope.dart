import 'package:flutter/widgets.dart';

import '../core/chat_model.dart';
import '../core/client.dart';

/// App-wide objects, reachable from any screen.
class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.client, required this.chats, required super.child});
  final RelayClient client;
  final ChatModel chats;

  static AppScope of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!;

  @override
  bool updateShouldNotify(AppScope oldWidget) => client != oldWidget.client || chats != oldWidget.chats;
}
