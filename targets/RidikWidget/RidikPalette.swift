import SwiftUI

/**
 The "element" tokens from `src/ui/theme.ts`, as far as an extension can carry them.

 Two things do not survive the trip and the face is designed around their
 absence. Bricolage Grotesque and Martian Mono are registered at runtime by
 `expo-font` inside the app, so an extension that never runs that code has only
 the system faces: `.rounded` stands in for the human half and `.monospaced` for
 the instrument half, which keeps the one distinction the type pairing exists to
 make. And the home screen's live heat gradient is a listening state, not a
 surface — a widget is never listening, so it gets the cooled ground the rest of
 the app's screens sit on.

 Both schemes are here because a widget is drawn on the home screen, not inside
 the app, and it is handed whichever appearance the wallpaper and the system are
 using at the time.
 */
struct RidikPalette {
  let ground: Color
  let raised: Color
  let text: Color
  let accent: Color
  let danger: Color

  static let light = RidikPalette(
    ground: Color(rgb: 0xFFE8D4),
    raised: Color(rgb: 0xFFF7F0),
    text: Color(rgb: 0x2E1508),
    accent: Color(rgb: 0xC7360F),
    danger: Color(rgb: 0xBE2A18)
  )

  static let dark = RidikPalette(
    ground: Color(rgb: 0x1C0E06),
    raised: Color(rgb: 0x361F15),
    text: Color(rgb: 0xFFEEDF),
    accent: Color(rgb: 0xFF8253),
    danger: Color(rgb: 0xFF6F5C)
  )

  static func of(_ scheme: ColorScheme) -> RidikPalette {
    scheme == .dark ? .dark : .light
  }

  /// Heavier than it would be on white; this ground is a mid-tone.
  var secondaryText: Color { text.opacity(0.74) }
  var tertiaryText: Color { text.opacity(0.56) }
  /// The unfilled part of the habit ring and the hairline between the columns.
  var hairline: Color { text.opacity(0.14) }
}

extension Color {
  /// `0xRRGGBB`, so the constants read the same here as they do in `theme.ts`.
  init(rgb: UInt32) {
    self.init(
      .sRGB,
      red: Double((rgb >> 16) & 0xFF) / 255,
      green: Double((rgb >> 8) & 0xFF) / 255,
      blue: Double(rgb & 0xFF) / 255,
      opacity: 1
    )
  }
}

extension View {
  /**
   The widget's ground.

   `containerBackground` is iOS 17 and mandatory there — a widget built against
   the modern SDK that does not declare one is drawn on nothing. The app still
   supports 16.4, where the modifier does not exist and a plain background is
   both correct and all that is available.
   */
  @ViewBuilder
  func ridikGround(_ color: Color) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(color, for: .widget)
    } else {
      background(color)
    }
  }
}
