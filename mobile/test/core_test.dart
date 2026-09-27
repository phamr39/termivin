import 'package:flutter_test/flutter_test.dart';
import 'package:termivin_mobile/core/client.dart';
import 'package:termivin_mobile/core/models.dart';

void main() {
  group('PairingCode', () {
    test('parses the termivin:// link the desktop shows', () {
      final c = PairingCode.parse('termivin://pair?u=http%3A%2F%2F192.168.1.20%3A8787&t=abc_DEF-123');
      expect(c, isNotNull);
      expect(c!.url, 'http://192.168.1.20:8787');
      expect(c.token, 'abc_DEF-123');
    });

    test('accepts surrounding whitespace and the JSON form', () {
      expect(PairingCode.parse('  termivin://pair?u=https%3A%2F%2Frelay.example.com&t=x \n')?.url, 'https://relay.example.com');
      expect(PairingCode.parse('{"url":"https://r.example","token":"t1"}')?.token, 't1');
    });

    test('rejects anything else', () {
      expect(PairingCode.parse('https://example.com'), isNull);
      expect(PairingCode.parse('termivin://pair?u=x'), isNull);
      expect(PairingCode.parse(''), isNull);
    });
  });

  group('models', () {
    test('snapshot finds terminals across workspaces', () {
      final s = Snapshot.fromJson({
        'activeWorkspaceId': 'w2',
        'workspaces': [
          {'id': 'w1', 'name': 'Riverside', 'terminals': [{'id': 't1', 'name': 'TermiFast', 'type': 'claude', 'status': 'approval'}]},
          {'id': 'w2', 'name': 'Ocean Park', 'terminals': [{'id': 't2', 'name': 'TermiEco', 'type': 'codex', 'status': 'idle'}]},
        ],
        'topics': [],
      });
      expect(s.find('t2')!.ws.name, 'Ocean Park');
      expect(s.find('t1')!.term.running, isTrue);
      expect(s.find('nope'), isNull);
      expect(s.allTerminals.length, 2);
    });

    test('attention items keep their prompt options', () {
      final a = AttentionItem.fromJson({
        'id': 't1:abcd', 'kind': 'approval', 'title': 'TermiFast', 'termId': 't1',
        'question': 'Do you want to proceed?', 'screenHash': 'abcd',
        'options': [{'key': '1', 'label': 'Yes'}, {'key': '2', 'label': 'No'}],
      });
      expect(a.options.map((o) => o.label), ['Yes', 'No']);
      expect(a.screenHash, 'abcd');
    });

    test('tolerates missing and mistyped fields', () {
      final t = TermInfo.fromJson({'id': 'x', 'pendingMail': 2.0, 'external': 'yes'});
      expect(t.name, 'Terminal');
      expect(t.pendingMail, 2);
      expect(t.external, isFalse);
      final m = ChatMessage.fromJson({'id': 'm', 'text': 'hi', 'role': 'owner'});
      expect(m.mine, isTrue);
    });
  });

  test('command errors read as sentences', () {
    expect(CmdError('prompt_changed').message, contains('prompt changed'));
    expect(CmdError('something_new').message, 'something_new');
  });
}
