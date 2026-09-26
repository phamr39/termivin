import 'package:flutter/material.dart';

/// Termivin's desktop palette (src/renderer/styles.css), dark by default.
class TV {
  static const bg = Color(0xFF101418);
  static const raised = Color(0xFF171C22);
  static const panel = Color(0xFF14181D);
  static const border = Color(0xFF262D36);
  static const text = Color(0xFFD8DEE6);
  static const dim = Color(0xFF8B95A3);
  static const faint = Color(0xFF5C6773);
  static const accent = Color(0xFF4E9AF5);
  static const green = Color(0xFF3FB26F);
  static const orange = Color(0xFFE8A13C);
  static const red = Color(0xFFE05D5D);
  static const purple = Color(0xFFB48CE8);

  static Color status(String? s) => switch (s) {
        'working' => accent,
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

  /// A terminal's "character": colour + glyph by type, as on the desktop.
  static ({Color color, String glyph}) character(String? type) => switch (type) {
        'claude' => (color: const Color(0xFFD97757), glyph: '✳'),
        'codex' => (color: const Color(0xFF19C37D), glyph: '◆'),
        'shell' || 'cmd' => (color: const Color(0xFF4E9AF5), glyph: '›_'),
        'custom' => (color: const Color(0xFFB48CE8), glyph: '⚙'),
        'external' => (color: orange, glyph: '⧉'),
        _ => (color: const Color(0xFF8B95A3), glyph: '›_'),
      };

  static ThemeData theme() {
    final base = ThemeData.dark(useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: bg,
      colorScheme: const ColorScheme.dark(
        primary: accent,
        secondary: accent,
        surface: raised,
        error: red,
        onPrimary: Colors.white,
      ),
      appBarTheme: const AppBarTheme(backgroundColor: bg, elevation: 0, scrolledUnderElevation: 0, centerTitle: false),
      cardTheme: CardThemeData(
        color: raised,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: const BorderSide(color: border)),
      ),
      dividerTheme: const DividerThemeData(color: border, space: 1, thickness: 1),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: panel,
        indicatorColor: accent.withValues(alpha: 0.18),
        labelTextStyle: WidgetStateProperty.all(const TextStyle(fontSize: 11.5)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: panel,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: border)),
        enabledBorder:
            OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: border)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      ),
      snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
      bottomSheetTheme: const BottomSheetThemeData(backgroundColor: raised, showDragHandle: true),
    );
  }
}
