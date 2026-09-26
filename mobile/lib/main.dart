import 'package:flutter/material.dart';

import 'core/chat_model.dart';
import 'core/client.dart';
import 'ui/pair_screen.dart';
import 'ui/scope.dart';
import 'ui/shell.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final client = RelayClient();
  final chats = ChatModel(client);
  client.init();
  runApp(TermivinApp(client: client, chats: chats));
}

class TermivinApp extends StatelessWidget {
  const TermivinApp({super.key, required this.client, required this.chats});
  final RelayClient client;
  final ChatModel chats;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      client: client,
      chats: chats,
      child: MaterialApp(
        title: 'Termivin',
        debugShowCheckedModeBanner: false,
        theme: TV.theme(),
        home: ListenableBuilder(
          listenable: client,
          builder: (context, _) => client.creds == null
              ? PairScreen(client: client)
              : HomeShell(client: client, chats: chats),
        ),
      ),
    );
  }
}
