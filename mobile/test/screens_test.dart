// Screenshots of the main screens with fake data — a quick visual check of
// the UI without an emulator. Only runs when asked:
//   SCREENSHOTS=1 flutter test --update-goldens test/screens_test.dart
// PNGs land in test/goldens/.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:termivin_mobile/core/chat_model.dart';
import 'package:termivin_mobile/core/client.dart';
import 'package:termivin_mobile/core/models.dart';
import 'package:termivin_mobile/core/storage.dart';
import 'package:termivin_mobile/ui/chat_screen.dart';
import 'package:termivin_mobile/ui/home_screen.dart';
import 'package:termivin_mobile/ui/profile_screen.dart';
import 'package:termivin_mobile/ui/scope.dart';
import 'package:termivin_mobile/ui/theme.dart';

final _run = Platform.environment.containsKey('SCREENSHOTS');
final _now = DateTime.now().millisecondsSinceEpoch;
int _ago(int min) => _now - min * 60000;

class _FakeClient extends RelayClient {
  _FakeClient() : super(store: CredentialStore()) {
    creds = Credentials(relayUrl: 'https://relay.example.com', deviceId: 'd1', refreshToken: 'x', deviceName: 'Pixel');
    state = ConnState.connected;
    deviceId = 'd1';
    hosts['h1'] = HostInfo(id: 'h1', name: 'Office PC', online: true, scopes: ['view', 'approve', 'input', 'manage']);
    hosts['h2'] = HostInfo(id: 'h2', name: 'Home laptop', online: false, lastSeen: _ago(90), scopes: ['view']);
    selectedHostId = 'h1';
    snapshots['h1'] = Snapshot.fromJson({
      'activeWorkspaceId': 'w1',
      'workspaces': [
        {'id': 'w1', 'name': 'Riverside', 'terminals': [
          {'id': 't1', 'name': 'TermiPearl', 'type': 'claude', 'status': 'approval', 'cwd': 'D:\\work\\api', 'summary': 'Editing src/auth/session.ts', 'permissionMode': 'acceptEdits', 'restoreCommand': 'claude --continue --permission-mode acceptEdits', 'title': 'Fix the flaky login test'},
          {'id': 't2', 'name': 'TermiFast', 'type': 'claude', 'status': 'working', 'cwd': 'D:\\work\\web'},
          {'id': 't3', 'name': 'TermiEco', 'type': 'codex', 'status': 'idle', 'cwd': 'D:\\work\\web'},
          {'id': 't4', 'name': 'TermiUni', 'type': 'shell', 'status': 'idle', 'cwd': 'D:\\work\\api'},
        ]},
        {'id': 'w2', 'name': 'Ocean Park', 'terminals': [
          {'id': 't5', 'name': 'TermiSafari', 'type': 'claude', 'status': 'saved', 'cwd': 'D:\\work\\docs'},
        ]},
      ],
      'topics': [{'id': 'tp', 'name': 'deploys', 'spaceId': 'w1', 'rep': 'TermiFast'}],
    });
    attention['h1'] = [
      AttentionItem.fromJson({
        'id': 't1:abcd', 'kind': 'approval', 'title': 'TermiPearl', 'termId': 't1', 'spaceId': 'w1', 'since': _ago(1),
        'question': 'Do you want to proceed?', 'excerpt': 'Bash command\nnpm run migrate -- --prod', 'screenHash': 'abcd',
        'options': [{'key': '1', 'label': 'Yes'}, {'key': '2', 'label': "Yes, and don't ask again"}, {'key': '3', 'label': 'No'}],
      }),
    ];
    progress['h1\u0000t2'] = TurnProgress('h1', 't2', true, startedAt: _ago(1), steps: 4, last: '▶ npm test -- login');
  }

  final Map<String, List<Map<String, dynamic>>> histories = {
    'dm:t1': [
      {'id': 'm1', 'ts': _ago(80), 'role': 'owner', 'kind': 'text', 'text': 'Fix the flaky login test', 'state': 'delivered'},
      {'id': 'm2', 'ts': _ago(76), 'role': 'agent', 'kind': 'summary', 'from': 't1', 'fromName': 'TermiPearl',
        'text': '## Fixed\n\nThe test raced the session cookie. I now wait for the redirect before asserting. All **42** login tests pass.\n\n- `test/login.spec.ts`: await the redirect',
        'headline': 'The test raced the session cookie. I now wait for the redirect before asserting. All 42 login tests pass.',
        'prompt': 'Fix the flaky login test', 'steps': ['📄 Read test/login.spec.ts', '✎ Edit test/login.spec.ts', '▶ npm test -- login'],
        'stats': {'edit': 1, 'command': 1, 'read': 1, 'durationMs': 41000}},
      {'id': 'm3', 'ts': _ago(3), 'role': 'owner', 'kind': 'text', 'text': 'Great. Now run the migration on prod', 'state': 'delivered'},
    ],
    'ws:w1': [
      {'id': 'g1', 'ts': _ago(30), 'role': 'agent', 'kind': 'bus', 'from': 't2', 'fromName': 'TermiFast', 'toName': 'TermiEco', 'text': 'Is the users API schema final? I am wiring the form.'},
      {'id': 'g2', 'ts': _ago(29), 'role': 'agent', 'kind': 'bus', 'from': 't3', 'fromName': 'TermiEco', 'toName': 'TermiFast', 'text': 'Yes — `email` is now required. Pushed in a3f9.'},
      {'id': 'g3', 'ts': _ago(28), 'role': 'agent', 'kind': 'bus', 'from': 't3', 'fromName': 'TermiEco', 'toName': 'TermiFast', 'text': 'Ping me when the form is done.'},
      {'id': 'g4', 'ts': _ago(5), 'role': 'owner', 'kind': 'text', 'text': 'Stand-up in 5 minutes, please post a status.', 'state': 'delivered'},
    ],
  };

  List<Map<String, dynamic>> convs() {
    Map<String, dynamic>? last(String c) => histories[c]?.last;
    return [
      {'conv': 'ws:w1', 'kind': 'group', 'title': 'Riverside', 'spaceId': 'w1', 'members': [<String, dynamic>{}, <String, dynamic>{}, <String, dynamic>{}, <String, dynamic>{}], 'last': last('ws:w1'), 'unread': 3},
      {'conv': 'dm:t1', 'kind': 'dm', 'title': 'TermiPearl', 'spaceId': 'w1', 'spaceName': 'Riverside', 'termId': 't1', 'type': 'claude', 'status': 'approval', 'last': last('dm:t1'), 'unread': 0},
      {'conv': 'dm:t2', 'kind': 'dm', 'title': 'TermiFast', 'spaceId': 'w1', 'spaceName': 'Riverside', 'termId': 't2', 'type': 'claude', 'status': 'working',
        'last': {'id': 'x', 'ts': _ago(12), 'role': 'agent', 'kind': 'summary', 'headline': 'Signup form wired to the new API', 'text': ''}, 'unread': 1},
      {'conv': 'dm:t3', 'kind': 'dm', 'title': 'TermiEco', 'spaceId': 'w1', 'spaceName': 'Riverside', 'termId': 't3', 'type': 'codex', 'status': 'idle',
        'last': {'id': 'y', 'ts': _ago(28), 'role': 'agent', 'kind': 'text', 'text': 'Ping me when the form is done.'}, 'unread': 2},
      {'conv': 'ws:w2', 'kind': 'group', 'title': 'Ocean Park', 'spaceId': 'w2', 'members': [<String, dynamic>{}], 'unread': 0},
      {'conv': 'dm:t5', 'kind': 'dm', 'title': 'TermiSafari', 'spaceId': 'w2', 'spaceName': 'Ocean Park', 'termId': 't5', 'type': 'claude', 'status': 'saved',
        'last': {'id': 'w', 'ts': _ago(60 * 26), 'role': 'agent', 'kind': 'summary', 'headline': 'Docs site rebuilt, 3 broken links fixed', 'text': ''}, 'unread': 0},
    ];
  }

  @override
  Future<dynamic> cmd(String hostId, String op, [Map<String, dynamic> args = const {}]) async {
    if (op == 'chat.list') return convs();
    if (op == 'chat.history') return histories[args['conv']] ?? [];
    return {};
  }

  @override
  Future<void> init() async {}
}

Future<void> _loadFonts() async {
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    for (final f in files) {
      final file = File(f);
      if (file.existsSync()) loader.addFont(Future.value(ByteData.view(file.readAsBytesSync().buffer)));
    }
    await loader.load();
  }
  // flutter_tester lives in <flutter>/bin/cache/artifacts/engine/<platform>/
  final artifacts = File(Platform.resolvedExecutable).parent.parent.parent.path;
  final fonts = '$artifacts/material_fonts';
  await load('Roboto', ['$fonts/roboto-regular.ttf', '$fonts/roboto-medium.ttf', '$fonts/roboto-bold.ttf']);
  await load('MaterialIcons', ['$fonts/materialicons-regular.otf']);
  await load('monospace', ['C:/Windows/Fonts/consola.ttf']);
  // glyphs Roboto lacks (✳ ◆ ✎ ▶ …)
  await load('Segoe UI Symbol', ['C:/Windows/Fonts/seguisym.ttf']);
}

Widget _app(RelayClient client, ChatModel chats, Widget home) {
  final theme = TV.theme();
  return AppScope(
    client: client,
    chats: chats,
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      // The test engine has no system font: point every themed style at the
      // loaded Roboto (on a device the platform font is used).
      theme: theme.copyWith(
        textTheme: theme.textTheme.apply(fontFamily: 'Roboto', fontFamilyFallback: ['Segoe UI Symbol']),
        appBarTheme: theme.appBarTheme.copyWith(
          titleTextStyle: theme.appBarTheme.titleTextStyle!.copyWith(fontFamily: 'Roboto', fontFamilyFallback: ['Segoe UI Symbol']),
          toolbarTextStyle: const TextStyle(fontFamily: 'Roboto', fontFamilyFallback: ['Segoe UI Symbol']),
        ),
        tabBarTheme: theme.tabBarTheme.copyWith(
          labelStyle: theme.tabBarTheme.labelStyle!.copyWith(fontFamily: 'Roboto'),
          unselectedLabelStyle: theme.tabBarTheme.unselectedLabelStyle!.copyWith(fontFamily: 'Roboto'),
        ),
      ),
      home: DefaultTextStyle.merge(style: const TextStyle(fontFamilyFallback: ['Segoe UI Symbol']), child: home),
    ),
  );
}

Future<void> _shot(WidgetTester tester, Widget w, String name) async {
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  await tester.pumpWidget(w);
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$name.png'));
}

void main() {
  setUpAll(_loadFonts);

  testWidgets('home — chat list', (tester) async {
    final client = _FakeClient();
    final chats = ChatModel(client)..convs = client.convs().map(Conversation.fromJson).toList();
    await _shot(tester, _app(client, chats, HomeScreen(client: client, chats: chats)), 'home');
  }, skip: !_run);

  testWidgets('chat — DM with a summary and a waiting approval', (tester) async {
    final client = _FakeClient();
    final chats = ChatModel(client);
    final conv = Conversation.fromJson(client.convs()[1]);
    await _shot(tester, _app(client, chats, ChatScreen(client: client, chats: chats, hostId: 'h1', conv: conv)), 'chat_dm');
  }, skip: !_run);

  testWidgets('chat — DM while the agent works', (tester) async {
    final client = _FakeClient();
    client.attention['h1'] = [];
    final chats = ChatModel(client);
    final conv = Conversation.fromJson(client.convs()[2]);
    await _shot(tester, _app(client, chats, ChatScreen(client: client, chats: chats, hostId: 'h1', conv: conv)), 'chat_working');
  }, skip: !_run);

  testWidgets('chat — workspace group', (tester) async {
    final client = _FakeClient();
    final chats = ChatModel(client);
    final conv = Conversation.fromJson(client.convs()[0]);
    await _shot(tester, _app(client, chats, ChatScreen(client: client, chats: chats, hostId: 'h1', conv: conv)), 'chat_group');
  }, skip: !_run);

  testWidgets('profile — terminal', (tester) async {
    final client = _FakeClient();
    final chats = ChatModel(client);
    final conv = Conversation.fromJson(client.convs()[1]);
    await _shot(tester, _app(client, chats, ProfileScreen(client: client, chats: chats, hostId: 'h1', conv: conv)), 'profile');
  }, skip: !_run);
}
