# Shot list

Every image the README wants, with what has to be in frame. Nothing here has
been taken yet — the interface is still moving, and a screenshot of a screen
that is about to change is worse than none.

**How to use this:** take a shot, save it at the path in the first column, then
find the matching `<!-- SHOT: id -->` block in `README.md` and delete the two
comment markers around the image line. The README is written so that each one
slots in without any other edit.

## Before you shoot

- **Seed the database first.** `npm run seed` builds a realistic day — a
  timetable, a trip, a robotics project, a dependency chain, a buffered meeting,
  streaks, spending, people and promises. Empty screens photograph badly and
  misrepresent the app.
- **Both platforms, matched.** The repo's rule is that the two platforms look
  the same. Any shot that shows a difference is either a bug to fix or a shot to
  retake — do not paper over it in the README.
- **iPhone 17 Pro and a Pixel-class AVD**, both at 3x, both in light mode unless
  the row says otherwise.
- **Hide the dev overlays.** A debug build shows the LogBox toast
  ("Open debugger to view warnings") along the bottom. Dismiss it before every
  shot, or build release.
- **Status bar:** set a clean time. `xcrun simctl status_bar booted override
  --time 9:41 --batteryLevel 100 --cellularBars 4` on iOS; on Android use demo
  mode (`adb shell settings put global sysui_demo_allowed 1`).
- **No real personal data.** Everything in frame should come from the seed.

| Save as | Where it is | What must be in frame |
| --- | --- | --- |
| `hero.png` | `app/index.tsx` — home, at rest | The whole point of the product in one image: the ember field with the dark mic disc at its centre, `TAP TO SPEAK · HOLD TO TYPE` beneath it, and the next thing on the calendar in the top left. Seed so "NEXT" shows a real event with a time and a room, not "Nothing left today". Portrait, full bleed, no device frame. |
| `home-listening.png` | Home, mid-utterance | The same screen while it is listening: the travelling ring around the disc, and the caption replaced by a partial transcript. Catch it with a real sentence half-recognised — "remind me to call Ivo at" — so it is obviously live rather than staged. |
| `receipt.png` | Home, after a multi-intent turn | The receipt card, showing several actions from one sentence, each with its own result line and the undo affordance. This is the app's safety model made visible and is the single most important image in the README. Use the three-part utterance from the top of the README so the text and the picture agree. |
| `hold-to-type.png` | Home, mid-hold | The collar closing onto the mic disc partway through a long press — the frame that shows the gesture is being counted. Take it around 300 ms in; the whole animation is 550 ms. |
| `sheet-typing.png` | The voice sheet, keyboard up | Typing instead of speaking. Must show the sheet and the keyboard as one continuous surface — the sheet's top corners go square while the keyboard is up, and the shot exists partly to prove that. |
| `briefing.png` | `/briefing` | The morning briefing: Today / Tomorrow / This week, the three summary lines, and the Play button with its duration. Seed a day with a class, an overdue task and a habit streak so all three lines say something. |
| `today.png` | `/today` | The day as a single scroll — classes, calendar with a travel block visibly in front of an event, what is due. The travel block is the thing to make legible; it is the feature people do not expect. |
| `tasks-graph.png` | `/tasks`, the dependency view | A real DAG: blocked work greyed behind what unlocks it. Use the seed's assembly chain (frame printed → servos arrive → assembly). |
| `notes.png` | `/notes` | Structured notes with a checklist section and the tag strip. Show FTS search open with a query typed and results, since search is otherwise invisible. |
| `paywall.png` | `/plans`, not subscribed | The two tier cards with the Monthly/Yearly toggle set to Yearly, the Save badge, and the per-month price with "billed yearly as … up front" underneath. Include the top-up card at the bottom of the frame if it fits. |
| `plan-active.png` | `/plans`, subscribed | The subscribed state: tier name, billing-period badge, and the Included row stating the monthly allowance. Do not use a sandbox purchase for this if a real one is available — the "Sandbox" badge will be in frame and looks unfinished. |
| `consent.png` | `/consent` | The first-run disclosure, scrolled so at least "Stays on this phone" and "Goes to Google" are both readable, with Allow and "Use Ridik offline" visible. This is the screen that carries the privacy claim and is worth showing in full. |
| `widgets-ios.png` | iOS home screen | Two or three widget faces placed together — Today, Agenda and Habits reads best. Real data, from the seed. |
| `widgets-android.png` | Android home screen | The same faces on Android, arranged the same way, for the side-by-side. |
| `dark.png` | Any of the above, dark mode | One image proving the palette is designed twice rather than inverted. Home or Today. Pair it with its light twin in the README's two-up. |
| `menu.png` | `/menu` | Everything the app can do, on one page. This is how a reader understands the scope without a feature list. |

## Two-ups

Three places in the README put two images side by side in a table. Both halves
have to be shot at the same size or the row looks broken:

- `widgets-ios.png` + `widgets-android.png`
- `hero.png` + `dark.png`
- `home-listening.png` + `receipt.png`
