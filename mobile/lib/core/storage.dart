import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Credentials for the relay, kept in the platform keychain / keystore.
class Credentials {
  Credentials({required this.relayUrl, required this.deviceId, required this.refreshToken, this.deviceName = ''});
  final String relayUrl;
  final String deviceId;
  final String refreshToken;
  final String deviceName;

  Credentials copyWith({String? refreshToken}) => Credentials(
        relayUrl: relayUrl,
        deviceId: deviceId,
        refreshToken: refreshToken ?? this.refreshToken,
        deviceName: deviceName,
      );

  Map<String, dynamic> toJson() => {
        'relayUrl': relayUrl,
        'deviceId': deviceId,
        'refreshToken': refreshToken,
        'deviceName': deviceName,
      };

  static Credentials? fromJson(Map<String, dynamic> j) {
    final url = j['relayUrl'], id = j['deviceId'], rt = j['refreshToken'];
    if (url is! String || id is! String || rt is! String) return null;
    return Credentials(relayUrl: url, deviceId: id, refreshToken: rt, deviceName: (j['deviceName'] as String?) ?? '');
  }
}

class CredentialStore {
  static const _key = 'termivin.credentials';
  final _storage = const FlutterSecureStorage();

  Future<Credentials?> load() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw == null) return null;
      return Credentials.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save(Credentials c) => _storage.write(key: _key, value: jsonEncode(c.toJson()));

  Future<void> clear() => _storage.delete(key: _key);
}
