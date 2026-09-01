#!/usr/bin/env python3
"""
The app mark, and every asset cut from it.

    python3 scripts/icons.py

One file owns the geometry so the seven assets cannot drift apart. They were
seven unrelated PNGs before, inherited from the scaffold — a blue chevron on
pale blue with the construction guides still visible in it, which was the only
thing in the product that disagreed with its own design language.

## The mark

Five heat cells, the fourth burning. It is not a metaphor for the app, it *is*
the app: the same primitive every widget face is built from, at the same four
levels the payload travels in (`heat` in `src/ui/theme.ts`, `HeatCell` in the
Swift, `ridik_heat_*` in the Android drawables). Put it beside a Ridik widget
and they are visibly one object. The tall cell is the next thing — the one
question the whole product exists to answer.

Every colour here is quoted from `theme.ts`. Nothing is a neutral grey, because
a true grey next to this palette reads as a bug.

## Why the sizes differ per asset

- **`icon.png`** is the mark on its ground. iOS masks it to a squircle and never
  crops further, so it can run to the full 63% of the canvas.
- **The adaptive pair** is cropped by the launcher to a *circle*, and the mask
  is smaller than the canvas: 108dp of art, 72dp of it visible, 66dp
  guaranteed. The mark's furthest ink is 352 units from centre at full size
  against a 341 mask, so it would lose the outer caps on a round-icon launcher
  — `FOREGROUND_SCALE` brings that to 303, inside the 313 that is *guaranteed*
  rather than merely usually visible.
- **`android-icon-monochrome.png`** is flattened to one colour by the themed
  icon engine and by `expo-notifications`, which read the alpha and throw the
  rest away. This mark survives that because the fourth cell is taller, not
  just hotter: the reading is carried by geometry as well as by heat.

## What is deliberately not here

No text. A wordmark at 48dp is a smear, and the strip is already unique enough
to carry the shelf.
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw

# --------------------------------------------------------------------- paint

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ASSETS = os.path.join(ROOT, 'assets')
LOGO = os.path.join(ASSETS, 'logo')

#: `colors.bg`-adjacent linen. The ground everything in this app sits on.
LINEN = '#FFF7F1'
#: `colors.text`'s neighbour — a warm near-black, never `#000`.
INK = '#17100C'

#: `heat.light` from `src/ui/theme.ts`, in the order a day runs: quiet, warming,
#: busy, **the next thing**, clear again.
CELLS = ['#F2CBBD', '#E59E89', '#D86F52', '#C7360F', '#F2CBBD']
HOT = 3

#: `heat.dark.cold`, and the only dark-scheme colour any of this needs. The icon
#: is one fixed tile on every phone, but the *splash* is drawn on the app's own
#: ground and follows the system: a pale `#F2CBBD` cell handed to a dark-mode
#: launch pops to `#4F2216` the instant `SplashCurtain` takes over, which is a
#: seam exactly where the whole point was to have none.
COLD_DARK = '#4F2216'
#: `colors.bg` in dark. `app.config.ts` states it too, for the splash's ground.
INK_BG = '#17100C'

# ------------------------------------------------------------------ geometry

SIZE = 1024
#: Supersample, then LANCZOS down. `rounded_rectangle` has no antialiasing of
#: its own and a stadium cap drawn at 1:1 is visibly stepped at icon sizes.
SS = 4

CELL_W = 104
GAP = 32
CELL_H = 356
HOT_H = 540
COUNT = len(CELLS)

_TOTAL = COUNT * CELL_W + (COUNT - 1) * GAP
X0 = (SIZE - _TOTAL) // 2

#: The adaptive icon's circular mask, with the 66dp safe zone cleared rather
#: than merely met. See the module docstring.
FOREGROUND_SCALE = 0.86


def _cells(scale: float = 1.0, cold: bool = False):
    """Every cell as (x0, y0, x1, y1), scaled about the canvas centre. `cold`
    is the mark before it has come up to temperature: no cell has risen yet."""
    out = []
    for index in range(COUNT):
        height = CELL_H if cold else (HOT_H if index == HOT else CELL_H)
        x0 = X0 + index * (CELL_W + GAP)
        y0 = (SIZE - height) // 2
        box = (x0, y0, x0 + CELL_W, y0 + height)
        if scale != 1.0:
            mid = SIZE / 2
            box = tuple(mid + (value - mid) * scale for value in box)
        out.append(box)
    return out


def render(path: str, size: int, *, ground: str | None, mono: str | None = None,
           scale: float = 1.0, cells: bool = True, cold: bool = False) -> None:
    """One asset. `ground` None leaves the tile transparent; `mono` overrides
    every cell with a single colour for the flattened layers; `cells` False is
    the adaptive background, which is a flat ground and nothing else."""
    canvas = size * SS
    ratio = canvas / SIZE
    image = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0) if ground is None else ground)
    draw = ImageDraw.Draw(image)
    for index, (x0, y0, x1, y1) in enumerate(_cells(scale, cold) if cells else []):
        box = (x0 * ratio, y0 * ratio, x1 * ratio, y1 * ratio)
        # Radius is half the width: these are stadiums, which is what a heat
        # cell is everywhere else in the app.
        fill = mono or (cold if isinstance(cold, str) else CELLS[0] if cold else CELLS[index])
        draw.rounded_rectangle(box, radius=(CELL_W / 2) * ratio, fill=fill)
    image.resize((size, size), Image.LANCZOS).save(path)
    print(f'  {os.path.relpath(path, ROOT):46} {size}x{size}')


def svg(path: str, *, ground: str | None, mono: str | None = None, scale: float = 1.0,
        cold: bool = False) -> None:
    """The editable master. Same numbers, so it can never disagree."""
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" '
        f'width="{SIZE}" height="{SIZE}">',
        '  <!-- Generated by scripts/icons.py — edit that, not this. -->',
    ]
    if ground:
        parts.append(f'  <rect width="{SIZE}" height="{SIZE}" fill="{ground}"/>')
    for index, (x0, y0, x1, y1) in enumerate(_cells(scale, cold)):
        parts.append(
            f'  <rect x="{x0:g}" y="{y0:g}" width="{x1 - x0:g}" height="{y1 - y0:g}" '
            f'rx="{(x1 - x0) / 2:g}" fill="{mono or (CELLS[0] if cold else CELLS[index])}"/>'
        )
    parts.append('</svg>\n')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(parts))
    print(f'  {os.path.relpath(path, ROOT):46} master')


def main() -> None:
    os.makedirs(LOGO, exist_ok=True)

    print('PNG')
    # iOS and the store listing. Masked to a squircle, never cropped further.
    render(os.path.join(ASSETS, 'icon.png'), SIZE, ground=LINEN)
    # The adaptive pair. `backgroundImage` is a flat ground so the launcher's
    # own parallax has something to move the foreground against.
    render(os.path.join(ASSETS, 'android-icon-background.png'), SIZE, ground=LINEN, cells=False)
    render(os.path.join(ASSETS, 'android-icon-foreground.png'), SIZE, ground=None,
           scale=FOREGROUND_SCALE)
    # Themed icons and the notification tray, both of which keep only the alpha.
    render(os.path.join(ASSETS, 'android-icon-monochrome.png'), SIZE, ground=None, mono=INK,
           scale=FOREGROUND_SCALE)
    # The splash is the mark **cold** — five even cells, none of them lit. It is
    # the only asset that is not the finished logo, and deliberately: it is the
    # first frame of `SplashCurtain`, which warms these five and stands the
    # fourth up over the second the app takes to open. Ship the finished mark
    # here and the launch plays backwards — the tile arrives hot, resets to
    # cold, and heats a second time.
    render(os.path.join(ASSETS, 'splash-icon.png'), SIZE, ground=None, cold=True)
    render(os.path.join(ASSETS, 'splash-icon-dark.png'), SIZE, ground=None, cold=COLD_DARK)
    render(os.path.join(ASSETS, 'favicon.png'), 64, ground=LINEN)

    print('SVG')
    svg(os.path.join(LOGO, 'ridik-icon.svg'), ground=LINEN)
    svg(os.path.join(LOGO, 'ridik-mark.svg'), ground=None)
    svg(os.path.join(LOGO, 'ridik-mono.svg'), ground=None, mono=INK)
    svg(os.path.join(LOGO, 'ridik-cold.svg'), ground=None, cold=True)


if __name__ == '__main__':
    main()
