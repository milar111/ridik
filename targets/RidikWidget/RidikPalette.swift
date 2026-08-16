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
 Depth, as four values — `depth` in `src/ui/theme.ts`, copied here the same way
 the cell ramp is.

 A widget cannot cast a shadow. On iOS the tile is composited by the home screen
 and on Android it is `RemoteViews`, which has no `elevation` it can colour. So
 everything that makes this family read as an object rather than as a printed
 card is drawn: a recessed track with a dark lip at its top and a light one at
 its floor, a highlight along the top of a lit cell, and one soft bloom in a
 corner of the tile.

 **The bloom is the only gradient anywhere in the family**, and it is local on
 purpose. A gradient across a whole tile is a wash, and a wash is what makes a
 surface look printed; a gradient across one corner reads as a light source,
 which is the idea the palette is named after. WIDGETS §1 still bans every other
 one.

 Dark needs roughly double the alpha: the same overlay over a near-black ground
 moves a fraction as far in perceived lightness as it does over linen.
 */
struct RidikDepth {
  /// The recess itself, and — doubled along its top edge — the lip of it.
  let well: Color
  /// The light edge at the bottom of a track, catching the same light.
  let wellFloor: Color
  /// Along the top of a lit cell, so it sits proud of its slot.
  let bevel: Color
  /// The corner bloom's centre. It fades to fully transparent, never to grey.
  let bloom: Color

  static let light = RidikDepth(
    well: Color(argb: 0x14000000),
    wellFloor: Color(argb: 0xB3FFFFFF),
    bevel: Color(argb: 0x66FFFFFF),
    bloom: Color(argb: 0x1FC7360F)
  )

  static let dark = RidikDepth(
    well: Color(argb: 0x38000000),
    wellFloor: Color(argb: 0x14FFFFFF),
    bevel: Color(argb: 0x26FFFFFF),
    bloom: Color(argb: 0x3DFF5A36)
  )
}

/**
 The "element" tokens from `src/ui/theme.ts`, as far as an extension can carry them.

 Two things do not survive the trip and the face is designed around their
 absence. Bricolage Grotesque and Martian Mono are registered at runtime by
 `expo-font` inside the app, so an extension that never runs that code has only
 the system faces: `.rounded` stands in for the human half and `.monospaced` for
 the instrument half, which keeps the one distinction the type pairing exists to
 make. And the home screen's live heat gradient is a listening state, not a
 surface — a widget is never listening, so it gets no field at all.

 Both schemes are here because a widget is drawn on the home screen, not inside
 the app, and it is handed whichever appearance the wallpaper and the system are
 using at the time.
 */
struct RidikPalette {
  /**
   The tile's ground, and why it is not the app's.

   The app is a saturated warm field because it is a hero screen — one surface,
   filling the phone, lit as though the microphone were the heat source. A
   widget is a guest on somebody else's home screen, sitting between other apps'
   tiles, and the same saturation there reads as shouting. Every well-made
   widget in the wild is pale for this reason.

   It also measures better: the ramp resolved against this tile separates a
   resting cell further from its own ground than the one resolved against the
   app's `bg` did. The tile being too saturated is what made empty widgets look
   washed out, and raising the ember was treating the symptom.
   */
  let tile: Color
  let text: Color
  let accent: Color

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
  /// The wells, bevels and bloom this scheme draws with. Never per ember: they
  /// are light, not colour, and the two platforms have to agree on them.
  let depth: RidikDepth

  /**
   The hottest level the month plate may fill a cell with.

   The plate is the one face in the family where text sits *on* a filled cell,
   and a darker ember's `mid` cannot stay light enough for a near-black numeral
   while its `hot` stays dark enough for linen. That is not a tuning problem: no
   ramp satisfies both at any alphas. So the darker embers cap the plate at `low`
   in **light** — busy and very busy read alike there, which is the price of the
   colour — and keep all four levels in dark, where the constraint does not
   exist. `ember` is the only one that never caps, which is why it is the default
   rather than merely the first.

   **`"3"` in every dark scheme**, which is not a cap at all: Android — where the
   cap is baked into a `drawable-night` resource — has never applied one there,
   and a cap here would have flattened a level the other platform draws.

   Today's hot cell is not load and is never capped; it carries `onHeat`.
   */
  let platePeak: Character

  /// A plate load level, held to what a numeral can still be read on.
  func plateLevel(_ level: Character) -> Character {
    level > platePeak ? platePeak : level
  }

  static let light = RidikPalette(
    tile: Color(rgb: 0xFFF7F1),
    text: Color(rgb: 0x2E1508),
    accent: Color(rgb: 0xC7360F),
    heatCold: Color(rgb: 0xF2CBBD),
    heatLow: Color(rgb: 0xE59E89),
    heatMid: Color(rgb: 0xD86F52),
    heatHot: Color(rgb: 0xC7360F),
    onHeat: Color(rgb: 0xFFF7F1),
    rim: nil,
    edge: nil,
    depth: .light,
    platePeak: "2"
  )

  static let dark = RidikPalette(
    tile: Color(rgb: 0x17100C),
    text: Color(rgb: 0xFFEEDF),
    accent: Color(rgb: 0xFF8253),
    heatCold: Color(rgb: 0x4F2216),
    heatLow: Color(rgb: 0x82321F),
    heatMid: Color(rgb: 0xB84329),
    // Note: `heat.core`, not `accent`. The accent is the text-safe darkened
    // one; this is the vivid core, and it only ever appears as a fill.
    heatHot: Color(rgb: 0xFF5A36),
    onHeat: Color(rgb: 0x17100C),
    rim: Color(rgb: 0xFFB57E),
    // `#1FFFD6B8` — the same warm hairline the Android plugin writes, alpha and
    // all. A neutral white at the same opacity reads as a bug next to this
    // palette, and it outlined the two platforms' tiles differently. Written as
    // an `rgb:` literal like every other token so the token test can read it.
    edge: Color(rgb: 0xFFD6B8).opacity(0.12),
    depth: .dark,
    platePeak: "3"
  )

  /*
   The two darker embers.

   Every ramp value is copied from `embers` in `src/ui/theme.ts` and asserted
   against it by `widget-tokens.test.ts`, exactly as the default's is. What is
   *not* copied is anything the default holds by hand: `tile`, `text` and the
   `depth` set do not change with the ember, and the dark tile `edge` is the same
   hairline on all three so the two platforms outline their tiles alike.

   `accent` is the ramp's own `hot` — the text-safe ember in light, the emitting
   one in dark — which is what the app resolves for these two as well. The
   default keeps its hand-drawn `#FF8253` instead, because that colour exists in
   no ramp and re-deriving it would move the look this app already ships.
   */

  static let kilnLight = RidikPalette(
    tile: Color(rgb: 0xFFF7F1),
    text: Color(rgb: 0x2E1508),
    accent: Color(rgb: 0xA82318),
    heatCold: Color(rgb: 0xEAC4BD),
    heatLow: Color(rgb: 0xD6928A),
    heatMid: Color(rgb: 0xC15F56),
    heatHot: Color(rgb: 0xA82318),
    onHeat: Color(rgb: 0xFFF7F1),
    rim: nil,
    edge: nil,
    depth: .light,
    // Kiln's `mid` is too dark for a near-black numeral on the pale tile.
    platePeak: "1"
  )

  static let kilnDark = RidikPalette(
    tile: Color(rgb: 0x17100C),
    text: Color(rgb: 0xFFEEDF),
    accent: Color(rgb: 0xF04B3C),
    heatCold: Color(rgb: 0x4f1f18),
    heatLow: Color(rgb: 0x822D24),
    heatMid: Color(rgb: 0xB83C30),
    heatHot: Color(rgb: 0xF04B3C),
    onHeat: Color(rgb: 0x17100C),
    // The glow hairline. The default's `#FFB57E` is a hand-drawn value and every
    // ember shares it — see the note on `rim`.
    rim: Color(rgb: 0xFFB57E),
    edge: Color(rgb: 0xFFD6B8).opacity(0.12),
    depth: .dark,
    platePeak: "3"
  )

  static let rustLight = RidikPalette(
    tile: Color(rgb: 0xFFF7F1),
    text: Color(rgb: 0x2E1508),
    accent: Color(rgb: 0x96341A),
    heatCold: Color(rgb: 0xE4C5BA),
    heatLow: Color(rgb: 0xCA9585),
    heatMid: Color(rgb: 0xB16651),
    heatHot: Color(rgb: 0x96341A),
    onHeat: Color(rgb: 0xFFF7F1),
    rim: nil,
    edge: nil,
    depth: .light,
    platePeak: "1"
  )

  static let rustDark = RidikPalette(
    tile: Color(rgb: 0x17100C),
    text: Color(rgb: 0xFFEEDF),
    accent: Color(rgb: 0xDE6038),
    heatCold: Color(rgb: 0x492417),
    heatLow: Color(rgb: 0x783721),
    heatMid: Color(rgb: 0xAA4B2D),
    heatHot: Color(rgb: 0xDE6038),
    onHeat: Color(rgb: 0x17100C),
    rim: Color(rgb: 0xFFB57E),
    edge: Color(rgb: 0xFFD6B8).opacity(0.12),
    depth: .dark,
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

  /// Heavier than it would be on white; this ground is still a warm one.
  var secondaryText: Color { text.opacity(0.74) }
  var tertiaryText: Color { text.opacity(0.56) }

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

  /// `0xAARRGGBB` — the shape `depth` is written in, alpha first, so a token can
  /// be compared to `theme.ts` and to the Android colour XML by eye.
  init(argb: UInt32) {
    self.init(
      .sRGB,
      red: Double((argb >> 16) & 0xFF) / 255,
      green: Double((argb >> 8) & 0xFF) / 255,
      blue: Double(argb & 0xFF) / 255,
      opacity: Double((argb >> 24) & 0xFF) / 255
    )
  }
}

/**
 The ground: a pale tile, one corner bloom, and the border that only exists in dark.

 **The bloom is the whole reason the ground is allowed to be this quiet.** A flat
 pale rectangle is a card; a pale rectangle with a single soft warm light in one
 corner is a lit surface, and the cells on it read as marks on something rather
 than as a picture of a grid. It is radial, centred off the top-left corner, and
 reaches about seven tenths of the tile's width before it has faded out — it must
 never become a wash, which is the failure mode the whole family is avoiding.

 It fades to its own hue at zero alpha rather than to `.clear`. `.clear` is white
 with no alpha, and interpolating toward it drags a grey haze through the middle
 of the ramp — visible as a dirty halo on the dark tile.

 A near-black tile on a dark photo wallpaper dissolves into it, so dark draws a
 1pt edge and light draws none. `ContainerRelativeShape` is what makes that a
 hairline along the tile's own rounded corners rather than a rectangle inside
 it: the extension is not told the corner radius, and the launcher's is not a
 constant.
 */
private struct RidikTileGround: View {
  let palette: RidikPalette

  var body: some View {
    GeometryReader { proxy in
      ZStack {
        palette.tile

        // Seven tenths of the tile's *shorter* side, not its width. A medium
        // tile is 305 × 131, and seven tenths of 305 is a radius half again as
        // long as the tile is tall — the bloom would reach every corner and
        // become exactly the full-tile wash this is here instead of.
        RadialGradient(
          gradient: Gradient(colors: [palette.depth.bloom, palette.depth.bloom.opacity(0)]),
          center: .topLeading,
          startRadius: 0,
          endRadius: max(min(proxy.size.width, proxy.size.height), 1) * 0.7
        )

        if let edge = palette.edge {
          ContainerRelativeShape().strokeBorder(edge, lineWidth: 1)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
    }
  }
}

/// How much of the tile is deliberately spent on nothing.
enum RidikTileMetrics {
  /**
   The margin this family adds inside the system's own.

   WidgetKit already insets a widget's content by about 12 points; Apple's own
   tiles sit closer to 18, and the difference is most of why a 32-cell strip
   running from edge to edge read as cramped. The extra is spent sideways only:
   a medium tile is 305 × 131 and the height is the scarce axis — every point
   taken off the top comes straight out of the graphic, while there is slack at
   the sides on every face in the family.
   */
  static let sideInset: CGFloat = 6
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

  /**
   The air between the tile's edge and the face.

   Content margins arrived in iOS 17; before that a widget's content ran to the
   edge of the tile unless it padded itself, so the whole inset is drawn by hand
   there and only the extra is added on top of the system's.
   */
  @ViewBuilder
  func ridikTilePadding() -> some View {
    if #available(iOS 17.0, *) {
      padding(.horizontal, RidikTileMetrics.sideInset)
    } else {
      padding(.horizontal, 18).padding(.vertical, 14)
    }
  }
}
