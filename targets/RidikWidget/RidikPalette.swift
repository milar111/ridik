import SwiftUI

/**
 Which ember the payload was published in — the user's colour, from `settings`.

 A string on the wire and never colours: the app publishes the *name*, the widget
 resolves it against the launcher's own light/dark. Absent or unrecognised is the
 default, which is what a payload from an older build and a payload from a build
 that ships a fourth ember both look like from here.
 */
enum RidikEmber: String {
  case ember
  case kiln
  case rust

  static func named(_ raw: String?) -> RidikEmber {
    guard let raw, let known = RidikEmber(rawValue: raw) else { return .ember }
    return known
  }
}

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
  /**
   Dark only: a hairline inside the hot cell, so emission reads as glow.

   The same value for every ember, deliberately, and the same one Android uses.
   A 1pt hairline is read as *light* rather than as a colour, so tinting it per
   ember buys nothing and costs the two platforms agreeing — which they did not,
   until this was one value on one side and three on the other.
   */
  let rim: Color?
  /// Dark only: a tile border. A near-black tile on a dark wallpaper dissolves.
  let edge: Color?
  /**
   The hottest level the month plate may fill with — WIDGETS §4b.

   `"2"` on the light default and `"1"` on the darker embers, because the plate
   is the only place a numeral sits on a filled cell and a dark ember's mid cell
   is too dark to read one on. **`"3"` in every dark scheme**, which is not a
   cap at all: the constraint is a property of the sand ground, and Android —
   where the cap is baked into a `drawable-night` resource — has never applied
   one there. A cap here would have flattened a level the other platform draws.
   */

  /**
   The hottest level the month plate may fill a cell with.

   The plate is the one face in the family where text sits *on* a filled cell,
   and a darker ember's `mid` cannot stay light enough for a near-black numeral
   while its `hot` stays dark enough for linen. That is not a tuning problem: no
   ramp satisfies both on the sand ground at any alphas. So the darker embers cap
   the plate at `low` in **light** — busy and very busy read alike there, which
   is the price of the colour — and keep all four levels in dark, where the
   constraint does not exist. `ember` is the only one that never caps, which is
   why it is the default rather than merely the first.

   Today's hot cell is not load and is never capped; it carries `onHeat`.
   */
  let platePeak: Character

  /// A plate load level, held to what a numeral can still be read on.
  func plateLevel(_ level: Character) -> Character {
    level > platePeak ? platePeak : level
  }

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
    edge: nil,
    platePeak: "2"
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
    edge: Color(rgb: 0xFFD6B8).opacity(0.12),
    platePeak: "3"
  )

  /*
   The two darker embers.

   Every ramp value is copied from `embers` in `src/ui/theme.ts` and asserted
   against it by `widget-tokens.test.ts`, exactly as the default's is. What is
   *not* copied is anything the default holds by hand: `ground`, `raised`, `text`
   and `danger` do not change with the ember, and the dark tile `edge` is the
   same hairline on all three so the two platforms outline their tiles alike.

   `accent` is the ramp's own `hot` — the text-safe ember in light, the emitting
   one in dark — which is what the app resolves for these two as well. The
   default keeps its hand-drawn `#FF8253` instead, because that colour exists in
   no ramp and re-deriving it would move the look this app already ships.
   */

  static let kilnLight = RidikPalette(
    ground: Color(rgb: 0xFFE8D4),
    raised: Color(rgb: 0xFFF7F0),
    text: Color(rgb: 0x2E1508),
    accent: Color(rgb: 0xA82318),
    danger: Color(rgb: 0xBE2A18),
    heatCold: Color(rgb: 0xE8B3A1),
    heatLow: Color(rgb: 0xD48676),
    heatMid: Color(rgb: 0xBF5649),
    heatHot: Color(rgb: 0xA82318),
    onHeat: Color(rgb: 0xFFF7F0),
    rim: nil,
    edge: nil,
    // Kiln's `mid` is too dark for a near-black numeral on the sand ground.
    platePeak: "1"
  )

  static let kilnDark = RidikPalette(
    ground: Color(rgb: 0x1C0E06),
    raised: Color(rgb: 0x361F15),
    text: Color(rgb: 0xFFEEDF),
    accent: Color(rgb: 0xF04B3C),
    danger: Color(rgb: 0xFF6F5C),
    heatCold: Color(rgb: 0x551E15),
    heatLow: Color(rgb: 0x862C21),
    heatMid: Color(rgb: 0xB93B2E),
    heatHot: Color(rgb: 0xF04B3C),
    onHeat: Color(rgb: 0x1C0E06),
    // The glow hairline in the ember's own hue, from its light ramp's palest
    // cell. The default's `#FFB57E` is a hand-drawn value and stays with it.
    rim: Color(rgb: 0xFFB57E),
    edge: Color(rgb: 0xFFD6B8).opacity(0.12),
    platePeak: "3"
  )

  static let rustLight = RidikPalette(
    ground: Color(rgb: 0xFFE8D4),
    raised: Color(rgb: 0xFFF7F0),
    text: Color(rgb: 0x2E1508),
    accent: Color(rgb: 0x96341A),
    danger: Color(rgb: 0xBE2A18),
    heatCold: Color(rgb: 0xE3B7A2),
    heatLow: Color(rgb: 0xCA8E77),
    heatMid: Color(rgb: 0xB1634A),
    heatHot: Color(rgb: 0x96341A),
    onHeat: Color(rgb: 0xFFF7F0),
    rim: nil,
    edge: nil,
    platePeak: "1"
  )

  static let rustDark = RidikPalette(
    ground: Color(rgb: 0x1C0E06),
    raised: Color(rgb: 0x361F15),
    text: Color(rgb: 0xFFEEDF),
    accent: Color(rgb: 0xDE6038),
    danger: Color(rgb: 0xFF6F5C),
    heatCold: Color(rgb: 0x502414),
    heatLow: Color(rgb: 0x7D371F),
    heatMid: Color(rgb: 0xAC4B2B),
    heatHot: Color(rgb: 0xDE6038),
    onHeat: Color(rgb: 0x1C0E06),
    rim: Color(rgb: 0xFFB57E),
    edge: Color(rgb: 0xFFD6B8).opacity(0.12),
    platePeak: "3"
  )

  /**
   The palette a face draws in: the launcher's appearance, the payload's ember.

   Two different kinds of fact, and they arrive from two different places on
   purpose. The scheme is the system's and is never published — the launcher can
   be dark while the app is light — while the ember is a choice a person made,
   which nothing on this side could answer for.
   */
  static func of(scheme: ColorScheme, ember: String?) -> RidikPalette {
    let dark = scheme == .dark
    switch RidikEmber.named(ember) {
    case .ember: return dark ? .dark : .light
    case .kiln: return dark ? .kilnDark : .kilnLight
    case .rust: return dark ? .rustDark : .rustLight
    }
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
