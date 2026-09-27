import 'package:flutter/material.dart';

/// Palette modelled on Telegram's night theme, with Termivin's status colours.
class TV {
  // surfaces
  static const bg = Color(0xFF17212B); // window, chat list
  static const chatBg = Color(0xFF0E1621); // behind the bubbles
  static const header = Color(0xFF242F3D); // app bars
  static const raised = Color(0xFF1E2C3A); // sheets, cards
  static const panel = Color(0xFF17212B); // composer, tab strips
  static const border = Color(0xFF0B1219);
  static const divider = Color(0xFF101A23);
  // bubbles
  static const bubbleIn = Color(0xFF182533);
  static const bubbleOut = Color(0xFF2B5278);
  static const inlineButton = Color(0xFF1F3549);
  // text
  static const text = Color(0xFFF5F5F5);
  static const dim = Color(0xFF708499);
  static const faint = Color(0xFF56687A);
  static const link = Color(0xFF6AB3F3);
  static const accent = Color(0xFF5288C1);
  static const accentBright = Color(0xFF64B5EF);
  static const badge = Color(0xFF4C9CE2);
  static const badgeMuted = Color(0xFF3F4E5C);
  // status
  static const green = Color(0xFF4FAE4E);
  static const orange = Color(0xFFE0A33E);
  static const red = Color(0xFFE5534B);
  static const purple = Color(0xFFA695E7);

  static Color status(String? s) => switch (s) {
        'working' => accentBright,
        'idle' => green,
        'approval' => orange,
        'exited' => red,
        'attached' => purple,
        _ => faint,
      };

  static String statusLabel(String? s) => switch (s) {
        'working' => 'working',
        'idle' => 'idle',
        'approval' => 'needs approval',
        'exited' => 'exited',
        'attached' => 'attached window',
        _ => 'not running',
      };

  /// A terminal's "character": colour + glyph by type. U+FE0E asks for the
  /// text form — Android otherwise draws ✳ and ⚙ as colour emoji.
  static ({Color color, String glyph}) character(String? type) => switch (type) {
        'claude' => (color: const Color(0xFFD97757), glyph: '✳︎'),
        'codex' => (color: const Color(0xFF19C37D), glyph: '◆︎'),
        'shell' || 'cmd' => (color: const Color(0xFF65AADD), glyph: '›_'),
        'custom' => (color: const Color(0xFFA695E7), glyph: '⚙︎'),
        'external' => (color: orange, glyph: '⧉'),
        _ => (color: const Color(0xFF708499), glyph: '›_'),
      };

  /// Telegram's peer colours, for workspace (group) avatars and names.
  static const peer = [
    Color(0xFFE17076), Color(0xFFFAA774), Color(0xFFA695E7), Color(0xFF7BC862),
    Color(0xFF6EC9CB), Color(0xFF65AADD), Color(0xFFEE7AAE),
  ];
  static Color peerColor(String key) {
    var h = 0;
    for (final c in key.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return peer[h % peer.length];
  }

  static ThemeData theme() {
    final base = ThemeData.dark(useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: bg,
      colorScheme: const ColorScheme.dark(
        primary: accentBright,
        secondary: accentBright,
        surface: raised,
        error: red,
        onPrimary: Colors.white,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: header,
        foregroundColor: text,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(fontSize: 19, fontWeight: FontWeight.w600, color: text),
      ),
      drawerTheme: const DrawerThemeData(backgroundColor: bg),
      cardTheme: CardThemeData(
        color: raised,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      dividerTheme: const DividerThemeData(color: divider, space: 1, thickness: 1),
      tabBarTheme: const TabBarThemeData(
        labelColor: accentBright,
        unselectedLabelColor: dim,
        indicatorColor: accentBright,
        dividerColor: Colors.transparent,
        labelStyle: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
        unselectedLabelStyle: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w500),
        tabAlignment: TabAlignment.start,
      ),
      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: accent,
        foregroundColor: Colors.white,
        shape: CircleBorder(),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: raised,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: accent)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        hintStyle: const TextStyle(color: faint),
      ),
      listTileTheme: const ListTileThemeData(iconColor: dim),
      snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: raised,
          contentTextStyle: TextStyle(color: text)),
      bottomSheetTheme: const BottomSheetThemeData(backgroundColor: raised, showDragHandle: true),
      popupMenuTheme: const PopupMenuThemeData(color: raised),
      dialogTheme: const DialogThemeData(backgroundColor: raised),
      chipTheme: base.chipTheme.copyWith(backgroundColor: raised, side: BorderSide.none),
    );
  }
}
