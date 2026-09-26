import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../core/client.dart';
import 'theme.dart';
import 'widgets.dart';

/// First run (or "add another PC"): scan the QR from Termivin → Settings →
/// Remote, or paste the code. The relay address can be corrected here — the
/// PC may know the relay as localhost while the phone needs a LAN/public URL.
class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.client, this.addingHost = false});
  final RelayClient client;
  final bool addingHost;

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _code = TextEditingController();
  final _url = TextEditingController();
  final _name = TextEditingController(text: Platform.isIOS ? 'iPhone' : 'Android phone');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    _url.dispose();
    _name.dispose();
    super.dispose();
  }

  void _onCode(String text) {
    final parsed = PairingCode.parse(text);
    setState(() {
      _error = null;
      if (parsed != null) _url.text = parsed.url;
    });
  }

  Future<void> _scan() async {
    final value = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const _ScanPage()));
    if (value == null) return;
    _code.text = value;
    _onCode(value);
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData('text/plain');
    if (data?.text == null) return;
    _code.text = data!.text!.trim();
    _onCode(_code.text);
  }

  Future<void> _pair() async {
    final parsed = PairingCode.parse(_code.text);
    if (parsed == null) {
      setState(() => _error = 'That is not a Termivin pairing code (it starts with termivin://pair).');
      return;
    }
    final url = _url.text.trim().isEmpty ? parsed.url : _url.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.client.pair(PairingCode(url, parsed.token),
          deviceName: _name.text.trim().isEmpty ? 'Phone' : _name.text.trim(),
          platform: Platform.isIOS ? 'ios' : 'android');
      if (mounted && widget.addingHost) Navigator.of(context).pop(true);
    } on CmdError catch (e) {
      setState(() => _error = e.code == 'invalid_token'
          ? 'The code is invalid, expired (5 min) or already used. Show a new one on the PC.'
          : 'Could not pair: ${e.message}');
    } catch (e) {
      setState(() => _error = 'Cannot reach the relay at $url. Check the address and that the phone is on the same network or VPN.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: widget.addingHost ? AppBar(title: const Text('Add a PC')) : null,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 28, 22, 28),
          children: [
            if (!widget.addingHost) ...[
              Row(children: [
                Container(
                  width: 46,
                  height: 46,
                  decoration: BoxDecoration(color: TV.accent.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(12)),
                  alignment: Alignment.center,
                  child: const Text('›_', style: TextStyle(color: TV.accent, fontSize: 20, fontWeight: FontWeight.w800)),
                ),
                const SizedBox(width: 12),
                const Text('Termivin', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
              ]),
              const SizedBox(height: 18),
              const Text('Your terminals and AI agents, from your phone.',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              const Text(
                'On your PC open Termivin → ⚙ Settings → Remote → "Show pairing code", then scan it here. '
                'Everything goes through the relay you host; the PC keeps running the work.',
                style: TextStyle(color: TV.dim, height: 1.4),
              ),
              const SizedBox(height: 26),
            ],
            FilledButton.icon(
              onPressed: _busy ? null : _scan,
              icon: const Icon(Icons.qr_code_scanner_rounded),
              label: const Text('Scan pairing QR'),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
            ),
            const SizedBox(height: 18),
            const Row(children: [
              Expanded(child: Divider()),
              Padding(padding: EdgeInsets.symmetric(horizontal: 10), child: Text('or paste the code', style: TextStyle(color: TV.faint))),
              Expanded(child: Divider()),
            ]),
            const SizedBox(height: 18),
            TextField(
              key: const Key('pair-code'),
              controller: _code,
              onChanged: _onCode,
              minLines: 2,
              maxLines: 4,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              decoration: InputDecoration(
                labelText: 'Pairing code',
                hintText: 'termivin://pair?u=…&t=…',
                suffixIcon: IconButton(icon: const Icon(Icons.content_paste_rounded), onPressed: _paste, tooltip: 'Paste'),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('pair-url'),
              controller: _url,
              keyboardType: TextInputType.url,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              decoration: const InputDecoration(
                labelText: 'Relay address',
                helperText: 'Filled in from the code — change it if this phone reaches the relay by another address',
                hintText: 'https://relay.example.com',
              ),
            ),
            if (!widget.addingHost || widget.client.creds == null) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Name of this phone (shown on the PC)'),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(_error!, style: const TextStyle(color: TV.red)),
            ],
            const SizedBox(height: 20),
            FilledButton(
              key: const Key('pair-submit'),
              onPressed: _busy ? null : _pair,
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50), backgroundColor: TV.green),
              child: _busy
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Pair'),
            ),
            if (widget.client.state == ConnState.revoked) ...[
              const SizedBox(height: 16),
              Text(widget.client.lastError ?? '', style: const TextStyle(color: TV.orange)),
            ],
          ],
        ),
      ),
    );
  }
}

class _ScanPage extends StatefulWidget {
  const _ScanPage();

  @override
  State<_ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<_ScanPage> {
  bool _done = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan the code on your PC')),
      body: Stack(children: [
        MobileScanner(
          onDetect: (capture) {
            if (_done) return;
            for (final b in capture.barcodes) {
              final v = b.rawValue;
              if (v != null && PairingCode.parse(v) != null) {
                _done = true;
                Navigator.of(context).pop(v);
                return;
              }
            }
          },
          errorBuilder: (context, error) => EmptyState(
            icon: Icons.no_photography_rounded,
            title: 'Camera unavailable',
            body: 'Allow camera access, or go back and paste the code instead.\n(${error.errorCode.name})',
          ),
        ),
        Center(
          child: Container(
            width: 240,
            height: 240,
            decoration: BoxDecoration(border: Border.all(color: TV.accent, width: 3), borderRadius: BorderRadius.circular(18)),
          ),
        ),
      ]),
    );
  }
}
