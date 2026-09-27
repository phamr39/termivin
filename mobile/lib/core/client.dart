import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'models.dart';
import 'storage.dart';

enum ConnState { signedOut, connecting, connected, offline, revoked }

class CmdError implements Exception {
  CmdError(this.code);
  final String code;

  /// Human wording for the errors the relay / desktop send back.
  String get message => switch (code) {
        'host_offline' => 'The PC is offline — nothing was sent.',
        'prompt_changed' => 'The prompt changed on the PC. Look again before answering.',
        'no_prompt' => 'That prompt is no longer waiting.',
        'forbidden' => 'This phone is not allowed to do that (pairing scopes).',
        'busy' => 'The agent is busy — try again when it is idle.',
        'not_running' => 'The terminal is not running.',
        'timeout' => 'No answer from the PC.',
        'rate_limited' => 'Slow down — too many actions at once.',
        _ => code,
      };

  @override
  String toString() => message;
}

/// Parsed `termivin://pair?u=<relay url>&t=<token>` (or a bare URL + token).
class PairingCode {
  PairingCode(this.url, this.token);
  final String url;
  final String token;

  static PairingCode? parse(String text) {
    final t = text.trim();
    try {
      final uri = Uri.parse(t);
      if (uri.scheme == 'termivin') {
        final u = uri.queryParameters['u'];
        final tok = uri.queryParameters['t'];
        if (u != null && tok != null && u.isNotEmpty && tok.isNotEmpty) return PairingCode(u, tok);
      }
    } catch (_) {}
    try {
      final j = jsonDecode(t);
      if (j is Map && j['url'] is String && j['token'] is String) return PairingCode(j['url'], j['token']);
    } catch (_) {}
    return null;
  }
}

/// The phone's single connection to the relay: credentials, the device
/// WebSocket (auto-reconnect), per-host state, commands and terminal streams.
class RelayClient extends ChangeNotifier {
  RelayClient({CredentialStore? store}) : _store = store ?? CredentialStore();

  final CredentialStore _store;
  Credentials? creds;
  String? _accessToken;
  int _accessExp = 0;

  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  Timer? _retry;
  int _backoffMs = 1000;
  bool _disposed = false;

  ConnState state = ConnState.signedOut;
  String? lastError;
  String? deviceId;

  final Map<String, HostInfo> hosts = {};
  final Map<String, Snapshot> snapshots = {};
  final Map<String, List<AttentionItem>> attention = {};
  String? selectedHostId;

  final _pending = <String, Completer<dynamic>>{};
  int _cmdSeq = 0;
  final _rand = Random();

  final _chat = StreamController<ChatEvent>.broadcast();
  final _screens = StreamController<ScreenEvent>.broadcast();
  final _frames = StreamController<PtyFrame>.broadcast();
  final _progress = StreamController<TurnProgress>.broadcast();
  Stream<TurnProgress> get progressEvents => _progress.stream;
  /// Latest progress per "host\u0000term" — for screens opened mid-turn.
  final Map<String, TurnProgress> progress = {};
  Stream<ChatEvent> get chatEvents => _chat.stream;
  Stream<ScreenEvent> get screenEvents => _screens.stream;
  Stream<PtyFrame> get frames => _frames.stream;

  // Terminals currently open on this phone: re-subscribed after a reconnect.
  final Map<String, int?> _subs = {}; // "host\u0000term" -> last seq seen

  HostInfo? get host => selectedHostId == null ? null : hosts[selectedHostId];
  Snapshot? get snapshot => selectedHostId == null ? null : snapshots[selectedHostId];
  List<AttentionItem> get allAttention => [
        for (final e in attention.entries)
          for (final a in e.value) a
      ];

  // ---------------------------------------------------------------- lifecycle

  Future<void> init() async {
    creds = await _store.load();
    if (creds == null) {
      _set(ConnState.signedOut);
      return;
    }
    deviceId = creds!.deviceId;
    connect();
  }

  void _set(ConnState s, [String? err]) {
    state = s;
    lastError = err;
    if (!_disposed) notifyListeners();
  }

  String _httpBase(String url) => url.replaceAll(RegExp(r'/+$'), '');

  Uri _wsUri() {
    final u = Uri.parse(_httpBase(creds!.relayUrl));
    return u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws', path: '${u.path}/ws/device');
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body, {String? bearer, String? base}) async {
    final res = await http
        .post(
          Uri.parse('${_httpBase(base ?? creds!.relayUrl)}$path'),
          headers: {'content-type': 'application/json', if (bearer != null) 'authorization': 'Bearer $bearer'},
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 15));
    Map<String, dynamic> json;
    try {
      json = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      json = {'error': 'bad_response'};
    }
    if (res.statusCode != 200) throw CmdError((json['error'] ?? 'http_${res.statusCode}').toString());
    return json;
  }

  /// Refresh tokens rotate on every use — the new one is persisted before
  /// anything else happens, or the phone would lock itself out.
  Future<void> _ensureAccess() async {
    if (_accessToken != null && DateTime.now().millisecondsSinceEpoch < _accessExp - 60000) return;
    final json = await _post('/api/token/refresh', {'refreshToken': creds!.refreshToken});
    creds = creds!.copyWith(refreshToken: json['refreshToken'] as String);
    await _store.save(creds!);
    _accessToken = json['accessToken'] as String;
    _accessExp = (json['expiresAt'] as num).toInt();
  }

  Future<void> pair(PairingCode code, {required String deviceName, required String platform}) async {
    // Already paired with this relay: add the new PC to the same device.
    if (creds != null && _httpBase(creds!.relayUrl) == _httpBase(code.url)) {
      await _ensureAccess();
      await _post('/api/devices/pair', {'token': code.token}, bearer: _accessToken);
      _accessToken = null;
      _reconnectNow();
      return;
    }
    final json = await _post('/api/devices/pair', {'token': code.token, 'name': deviceName, 'platform': platform},
        base: code.url);
    creds = Credentials(
      relayUrl: _httpBase(code.url),
      deviceId: json['deviceId'] as String,
      refreshToken: json['refreshToken'] as String,
      deviceName: deviceName,
    );
    await _store.save(creds!);
    deviceId = creds!.deviceId;
    _accessToken = json['accessToken'] as String;
    _accessExp = (json['expiresAt'] as num).toInt();
    selectedHostId = json['hostId'] as String?;
    _reconnectNow();
  }

  Future<void> signOut() async {
    _closeSocket();
    await _store.clear();
    creds = null;
    _accessToken = null;
    hosts.clear();
    snapshots.clear();
    attention.clear();
    _subs.clear();
    selectedHostId = null;
    _set(ConnState.signedOut);
  }

  void _reconnectNow() {
    _backoffMs = 1000;
    _closeSocket();
    connect();
  }

  /// Called when the app comes back to the foreground.
  void resume() {
    if (creds != null && state != ConnState.connected && state != ConnState.revoked) _reconnectNow();
  }

  Future<void> connect() async {
    if (creds == null || _disposed) return;
    _retry?.cancel();
    _set(ConnState.connecting);
    try {
      await _ensureAccess();
    } on CmdError catch (e) {
      if (e.code == 'invalid_refresh') {
        _set(ConnState.revoked, 'This phone was revoked or its pairing expired. Pair it again.');
        return;
      }
      _set(ConnState.offline, 'Relay unreachable (${e.message})');
      return _scheduleRetry();
    } catch (e) {
      _set(ConnState.offline, 'Relay unreachable');
      return _scheduleRetry();
    }
    try {
      final ch = WebSocketChannel.connect(_wsUri());
      _ch = ch;
      await ch.ready.timeout(const Duration(seconds: 10));
      _sub = ch.stream.listen(_onData, onDone: () => _onClosed(ch), onError: (_) => _onClosed(ch));
      ch.sink.add(jsonEncode({'t': 'auth', 'token': _accessToken}));
    } catch (e) {
      _set(ConnState.offline, 'Relay unreachable');
      _scheduleRetry();
    }
  }

  void _onClosed(WebSocketChannel ch) {
    if (_ch != ch) return;
    _ch = null;
    _sub?.cancel();
    for (final c in _pending.values) {
      if (!c.isCompleted) c.completeError(CmdError('host_offline'));
    }
    _pending.clear();
    if (ch.closeCode == 4003) {
      // Auth refused: the access token might just be stale — retry once fresh.
      _accessToken = null;
    }
    if (_disposed || creds == null) return;
    _set(ConnState.offline, state == ConnState.connected ? 'Connection lost — reconnecting' : lastError);
    _scheduleRetry();
  }

  void _scheduleRetry() {
    _retry?.cancel();
    final delay = _backoffMs + _rand.nextInt(400);
    _backoffMs = min(30000, _backoffMs * 2);
    _retry = Timer(Duration(milliseconds: delay), connect);
  }

  void _closeSocket() {
    _retry?.cancel();
    final ch = _ch;
    _ch = null;
    _sub?.cancel();
    try {
      ch?.sink.close();
    } catch (_) {}
  }

  void _send(Map<String, dynamic> msg) {
    try {
      _ch?.sink.add(jsonEncode(msg));
    } catch (_) {}
  }

  // ---------------------------------------------------------------- inbound

  void _onData(dynamic data) {
    if (data is String) {
      Map<String, dynamic> msg;
      try {
        msg = jsonDecode(data) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      _onMessage(msg);
    } else if (data is List<int>) {
      _onFrame(data is Uint8List ? data : Uint8List.fromList(data));
    }
  }

  void _onFrame(Uint8List b) {
    try {
      var o = 0;
      final hl = b[o++];
      final hostId = utf8.decode(b.sublist(o, o + hl));
      o += hl;
      final tl = b[o++];
      final termId = utf8.decode(b.sublist(o, o + tl));
      o += tl;
      final seq = ByteData.sublistView(b, o, o + 4).getUint32(0);
      o += 4;
      final text = utf8.decode(b.sublist(o), allowMalformed: true);
      final key = '$hostId\u0000$termId';
      if (_subs.containsKey(key)) _subs[key] = seq + text.length;
      _frames.add(PtyFrame(hostId, termId, seq, text));
    } catch (_) {}
  }

  void _onMessage(Map<String, dynamic> msg) {
    final hostId = msg['hostId'] as String?;
    switch (msg['t']) {
      case 'ready':
        _backoffMs = 1000;
        deviceId = msg['deviceId'] as String?;
        hosts.clear();
        for (final h in (msg['hosts'] as List? ?? const [])) {
          final info = HostInfo.fromJson(h as Map<String, dynamic>);
          hosts[info.id] = info;
        }
        if (selectedHostId == null || !hosts.containsKey(selectedHostId)) {
          selectedHostId = hosts.isEmpty ? null : hosts.keys.first;
        }
        _set(ConnState.connected);
        for (final key in _subs.keys) {
          final parts = key.split('\u0000');
          _send({'t': 'sub', 'hostId': parts[0], 'termId': parts[1], 'lastSeq': _subs[key]});
        }
        break;
      case 'snapshot':
        if (hostId == null || msg['data'] is! Map) break;
        snapshots[hostId] = Snapshot.fromJson(msg['data'] as Map<String, dynamic>, stale: msg['stale'] == true);
        notifyListeners();
        break;
      case 'attention':
        if (hostId == null) break;
        attention[hostId] = (msg['items'] as List? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(AttentionItem.fromJson)
            .toList();
        notifyListeners();
        break;
      case 'host':
        final h = hosts[hostId];
        if (h != null) {
          h.online = msg['online'] == true;
          h.lastSeen = msg['lastSeen'] as int?;
          if (!h.online) snapshots[hostId]?.stale = true;
          notifyListeners();
        }
        break;
      case 'host.removed':
        hosts.remove(hostId);
        snapshots.remove(hostId);
        attention.remove(hostId);
        if (selectedHostId == hostId) selectedHostId = hosts.isEmpty ? null : hosts.keys.first;
        notifyListeners();
        break;
      case 'event':
        _onEvent(hostId ?? '', msg['kind'] as String? ?? '', msg['data']);
        break;
      case 'cmd.result':
        final c = _pending.remove(msg['id']);
        if (c != null && !c.isCompleted) {
          if (msg['ok'] == true) {
            c.complete(msg['data']);
          } else {
            c.completeError(CmdError((msg['error'] ?? 'failed').toString()));
          }
        }
        break;
      case 'error':
        final c = _pending.remove(msg['ref']);
        if (c != null && !c.isCompleted) c.completeError(CmdError((msg['error'] ?? 'failed').toString()));
        break;
    }
  }

  void _onEvent(String hostId, String kind, dynamic data) {
    if (data is! Map<String, dynamic>) return;
    if (kind == 'chat') {
      final m = data['msg'];
      if (m is Map<String, dynamic>) {
        _chat.add(ChatEvent(hostId, data['conv'] as String? ?? '', ChatMessage.fromJson(m), isUpdate: m['update'] == true));
      }
    } else if (kind == 'progress') {
      final termId = data['termId'] as String? ?? '';
      final p = TurnProgress(hostId, termId, data['active'] == true,
          startedAt: (data['startedAt'] as num?)?.toInt(),
          steps: (data['steps'] as num?)?.toInt() ?? 0,
          last: data['last'] as String? ?? '');
      if (p.active) {
        progress['$hostId\u0000$termId'] = p;
      } else {
        progress.remove('$hostId\u0000$termId');
      }
      _progress.add(p);
      notifyListeners(); // chat list shows who is working
    } else if (kind == 'screen') {
      final termId = data['termId'] as String? ?? '';
      final seq = (data['seq'] as num?)?.toInt() ?? 0;
      final key = '$hostId\u0000$termId';
      if (_subs.containsKey(key)) _subs[key] = seq;
      _screens.add(ScreenEvent(hostId, termId, seq, (data['cols'] as num?)?.toInt() ?? 80,
          (data['rows'] as num?)?.toInt() ?? 24, data['data'] as String? ?? '',
          stopped: data['stopped'] == true));
    }
  }

  // ---------------------------------------------------------------- outbound

  String _newId() => '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${_rand.nextInt(1 << 30).toRadixString(36)}-${++_cmdSeq}';

  /// Runs an operation on a PC. Throws [CmdError].
  Future<dynamic> cmd(String hostId, String op, [Map<String, dynamic> args = const {}]) {
    if (_ch == null || state != ConnState.connected) return Future.error(CmdError('host_offline'));
    final id = _newId();
    final c = Completer<dynamic>();
    _pending[id] = c;
    _send({'t': 'cmd', 'id': id, 'hostId': hostId, 'op': op, 'args': args});
    return c.future.timeout(const Duration(seconds: 25), onTimeout: () {
      _pending.remove(id);
      throw CmdError('timeout');
    });
  }

  // Images from the PC, downloaded in chunks and kept for the session.
  final Map<String, Uint8List> _media = {};
  final Map<String, Future<Uint8List>> _mediaLoading = {};

  Future<Uint8List> fetchMedia(String hostId, String id) {
    final key = '$hostId/$id';
    final cached = _media[key];
    if (cached != null) return Future.value(cached);
    return _mediaLoading[key] ??= () async {
      try {
        final parts = BytesBuilder(copy: false);
        var offset = 0;
        for (var i = 0; i < 200; i++) {
          final r = await cmd(hostId, 'media.get', {'id': id, 'offset': offset});
          final bytes = base64Decode(r['data'] as String);
          parts.add(bytes);
          offset += bytes.length;
          if (r['done'] == true || bytes.isEmpty) break;
        }
        final data = parts.takeBytes();
        _media[key] = data;
        if (_media.length > 40) _media.remove(_media.keys.first);
        return data;
      } finally {
        _mediaLoading.remove(key);
      }
    }();
  }

  void subscribe(String hostId, String termId) {
    final key = '$hostId\u0000$termId';
    _subs[key] = null;
    _send({'t': 'sub', 'hostId': hostId, 'termId': termId});
  }

  void unsubscribe(String hostId, String termId) {
    _subs.remove('$hostId\u0000$termId');
    _send({'t': 'unsub', 'hostId': hostId, 'termId': termId});
  }

  void selectHost(String id) {
    selectedHostId = id;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _closeSocket();
    _chat.close();
    _screens.close();
    _frames.close();
    _progress.close();
    super.dispose();
  }
}

