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

  /**
   The cell ramp — one ember at four opacities, already resolved.

   Every graphic in the family is built from a cell filled with one of these.
   Resolved rather than composited here because the identical four values have
   to exist in `src/ui/theme.ts` and in the Android plugin's colour XML, and
   "the same alpha over the same ground" is a promise three languages would each
   have to keep separately. `widget-tokens.test.ts` asserts all three agree.

   `hot` is spent once per drawing, always on the single most urgent thing. That
   cap is what keeps saturated orange to a percent or two of any tile.
   */
  let heatCold: Color
  let heatLow: Color
  let heatMid: Color
  let heatHot: Color
  /// The ink that goes *on* `heatHot`, where `text` measures 3.2:1 and must not.
  let onHeat: Color
  /// Dark only: a hairline inside the hot cell, so emission reads as glow.
  let rim: Color?
  /// Dark only: a tile border. A near-black tile on a dark wallpaper dissolves.
  let edge: Color?

  static let light = RidikPalette(
    ground: Color(rgb: 0xFFE8D4),
    raised: Color(rgb: 0xFFF7F0),
    text: Color(rgb: 0x2E1508),
    accent: Color(rgb: 0xC7360F),
    danger: Color(rgb: 0xBE2A18),
    heatCold: Color(rgb: 0xF2BFA7),
    heatLow: Color(rgb: 0xE59679),
    heatMid: Color(rgb: 0xD86B4A),
    heatHot: Color(rgb: 0xC7360F),
    onHeat: Color(rgb: 0xFFF7F0),
    rim: nil,
    edge: nil
  )

  static let dark = RidikPalette(
    ground: Color(rgb: 0x1C0E06),
    raised: Color(rgb: 0x361F15),
    text: Color(rgb: 0xFFEEDF),
    accent: Color(rgb: 0xFF8253),
    danger: Color(rgb: 0xFF6F5C),
    heatCold: Color(rgb: 0x501F11),
    heatLow: Color(rgb: 0x84311C),
    heatMid: Color(rgb: 0xBB4328),
    // Note: `heat.core`, not `accent`. The accent is the text-safe darkened
    // one; this is the vivid core, and it only ever appears as a fill.
    heatHot: Color(rgb: 0xFF5A36),
    onHeat: Color(rgb: 0x1C0E06),
    rim: Color(rgb: 0xFFB57E),
    // `#1FFFD6B8` — the same warm hairline the Android plugin writes, alpha and
    // all. A neutral white at the same opacity reads as a bug next to this
    // palette, and it outlined the two platforms' tiles differently. Written as
    // an `rgb:` literal like every other token so the token test can read it.
    edge: Color(rgb: 0xFFD6B8).opacity(0.12)
  )

  static func of(_ scheme: ColorScheme) -> RidikPalette {
    scheme == .dark ? .dark : .light
  }

  /// Heavier than it would be on white; this ground is a mid-tone.
  var secondaryText: Color { text.opacity(0.74) }
  var tertiaryText: Color { text.opacity(0.56) }
  /// The hairline between columns. There is no ring left to unfill.
  var hairline: Color { text.opacity(0.14) }

  /// A heat character from the payload — `'0'` … `'3'` — as a fill.
  func heat(_ level: Character) -> Color {
    switch level {
    case "1": return heatLow
    case "2": return heatMid
    case "3": return heatHot
    default: return heatCold
    }
  }

  /// Ink that stays legible on a given level. Inverts on `hot`, and only there.
  func ink(on level: Character) -> Color {
    level == "3" ? onHeat : text
  }
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

/**
 The ground, and the one border that only exists in dark.

 A near-black tile on a dark photo wallpaper dissolves into it, so dark draws a
 1pt edge and light draws none. `ContainerRelativeShape` is what makes that a
 hairline along the tile's own rounded corners rather than a rectangle inside
 it: the extension is not told the corner radius, and the launcher's is not a
 constant.
 */
private struct RidikTileGround: View {
  let palette: RidikPalette

  var body: some View {
    ZStack {
      palette.ground
      if let edge = palette.edge {
        ContainerRelativeShape().strokeBorder(edge, lineWidth: 1)
      }
    }
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
  func ridikGround(_ palette: RidikPalette) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(for: .widget) { RidikTileGround(palette: palette) }
    } else {
      background(RidikTileGround(palette: palette))
    }
  }
}
