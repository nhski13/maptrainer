# Changelog

## 1.10.0 — 2026-08-19

- **State lines for the United States.** Interior state boundaries at 1:10m,
  faded in between 1.6x and 2.8x zoom — absent on the whole globe, where
  forty-nine extra outlines across a couple of hundred pixels is a smudge, and
  fully there by the time the view is close enough for a state to be worth
  telling apart from a country. They sit under the national borders: thinner,
  dimmer, and drawn from the same projection, so they register against the
  satellite imagery exactly as the country borders do.

  Only the interior mesh ships. An arc a state doesn't share with another state
  is coastline or an international frontier, which the world border layer
  already draws — a second copy at a second resolution would put two lines
  where there is one border. Alaska and Hawaii border no other state, so what
  is left is the lower 48, and the renderer skips the path entirely in one
  comparison when that cap can't be on the near hemisphere.

  Source is the Census Bureau's cartographic boundaries via `us-atlas` (ISC),
  pre-built by `scripts/build-state-lines.mjs` into a delta-encoded mesh:
  11 kB gzipped rather than the 38 kB the full topology would have cost, for
  the same lines. Points are quantised to 1e-4 degrees (~11 m), an order of
  magnitude finer than a 1:10m boundary claims to know.
- **Zooming no longer flashes.** Crossing a detail zoom band threw away the
  sharp imagery already on screen: the incoming patch started life as nothing
  but the upscaled Blue Marble base, so the globe went sharp, blurry, sharp
  every time the tile level changed — and again on every throttled repaint
  while the new tiles streamed in.

  A new patch is now seeded from the one it replaces, reprojected into its own
  bounds, before any tiles land. The worst a half-loaded patch can look is
  exactly what it replaced, and each tile that arrives is an improvement on
  that rather than a recovery from a step backwards. Instrumented against a
  stubbed tile server, a zoom from 3x to 20x went from a base-texture frame at
  every band crossing to none at all.
- **Patches fade out, too.** Zooming back past the detail threshold used to
  drop the texture the instant the zoom crossed it — a hard cut from sharp
  imagery to blurry, which is the same flash the fade-in exists to avoid, run
  backwards. It now fades over the same 180 ms and is only released once it is
  invisible; zooming back in mid-fade catches it and brings it up again.

## 1.9.0 — 2026-08-18

- **The distance curve is refitted, and this time the shape changed, not just
  a number.** Three new rounds read off MapTap's reveal screen (Samarkand
  336 mi → 89, Karakorum 635 mi → 80, Fairbanks 334 mi → 89, all from
  `MapTap #788`) landed exactly where the old curve was weakest: close in. The
  old model scored them 93, 87 and 93. It had a known outlier in the same
  range — Wolfsburg, 225 mi → 92, scored 95 — and the new rounds show that was
  never an outlier at all, but the first sight of a part of the curve the old
  family had the wrong shape for.

  Scoring is now `100 · (1 − ((d − 40 km) / 14,300 km)^0.65)`: **points lost**
  follow a sublinear power of the error, rather than points kept following a
  power of the remaining distance to the antipode. That is the only form
  tested that can be strict at 500 km and generous at 3,820 km at once. It
  reproduces five of the six measured rounds exactly, worst error 2, and
  survives leave-one-out — against a worst error of 7 for the old curve.

  In practice: near misses cost more than they used to (500 km was 94, now
  89), the middle of the range is barely touched, and zero now arrives at
  14,340 km instead of 17,410 km — 1,280 km past the furthest measured round
  rather than 4,350 km past it.
- **The bullseye is now an explicit 40 km rather than a side effect.** The new
  curve on its own only pays 100 inside about 4 km, which cannot explain the
  5–11% of real rounds that score exactly 100, so the plateau is stated rather
  than hoped for. It is the least certain number in the model and is labelled
  that way in both `src/core/geo.ts` and `docs/scoring.md`: no measured round
  lies closer than 362 km, and any radius from 0 to 80 km fits the anchors
  equally well.
- `docs/scoring.md` gains the full refit — all six anchors, why the family had
  to change, the fitted window for both constants, and a leave-one-out table.

## 1.8.3 — 2026-08-18

- **Miles only.** Every distance the app shows — the reveal card, the chip on
  the miss line, the round list, the average error on the results screen and
  the per-city "avg miss" in Stats — is now written in miles alone. The reveal
  used to print both units side by side ("131 km · 81.6 mi"), which is two
  numbers for one fact and neither of them is the one MapTap reports back to
  you. Distances are still measured and scored in kilometers internally; the
  conversion happens where the text is drawn.

## 1.8.2 — 2026-08-18

- **Country borders read a little more clearly.** Over the satellite imagery
  and on the vector fallback alike, the border lines were thin and dim enough
  to disappear against busy terrain. They are now a touch wider and a touch
  brighter — still a hairline rather than an outline, but one you can follow
  without hunting for it. The satellite border colour is now a `--border-sat`
  variable alongside `--border`, so both are tunable from one place.

## 1.8.1 — 2026-08-18

- **Study mode's city list can be put away.** On a phone the list is a sheet
  across the bottom of the globe, and it was covering the half of the country
  you had just asked to look at with no way to move it. It now has a grip:
  tap it, swipe it down, or press Escape and the list folds to a single bar,
  which then names whichever city you were reading about. Tapping the map
  itself does the same thing — reaching past an overlay to touch what's under
  it is a statement about the overlay. Swipe the bar back up, tap it, or press
  an arrow key to bring the list back.
- Folding the sheet away re-frames the country into the space that just opened
  up, rather than leaving it hunched above where the sheet used to be.

## 1.8.0 — 2026-08-17

- **Train by country.** Pick India and work through its top 25 cities, or any
  of the other 119 countries. A country run is as long as its pack, ordered
  most populous first, so the session ramps from Mumbai to Visakhapatnam
  rather than shuffling the two together. **Top 10** trims it to a quick run,
  and the capital is never trimmed away: a top-10 of
  Australia without Canberra would be a strange thing to hand someone.
- **A study mode, because quizzing something you've never seen isn't
  learning.** Toggle *Study* and the whole pack lands on the globe at once —
  every city dotted and labelled, the country framed to fit, the list beside
  it. Tap any city and the globe flies there and zooms to street scale; arrow
  keys walk the list. Labels are placed biggest-city-first and any that would
  collide are dropped, so zooming in is what brings the rest of them back.
  Nothing is scored and nothing is timed — this is the half of learning a
  country that a quiz can't do, and *Quiz me on these* is one tap away.
- **2,330 new cities, 120 countries.** Cross-checked between two open
  gazetteers rather than taken from either: coordinates and populations from
  SimpleMaps World Cities Basic, names from GeoNames, and a city only ships if
  both put it in the same place. That check is not ceremony — gazetteer
  populations are sometimes district totals pinned to a village that shares the
  city's name — one such record would have taught Gorakhpur 811 km from
  Gorakhpur. Cities within 25 km of a higher-ranked one are folded away, since
  closer than the scoring bullseye is not a separate question.
- Country packs reuse the curated corpus rather than duplicating it: India's
  pack points at the existing `mumbai`, so your history for a city is the same
  history whichever mode you meet it in. The Stats tab now counts the whole
  corpus, and the weakest-locations table can finally surface a city you only
  ever met in a country run.
- The globe grew a labelled-marker layer, a `frameAll` that fits a set of
  points, and — on phones, where the city list becomes a sheet across the
  bottom — framing that aims above the sheet instead of behind it.

## 1.7.0 — 2026-08-17

- **The globe fetches its detail imagery before you ask for it.** Zooming used
  to be a cold start every single time: the view had to come to a complete
  stop, wait out a 280 ms settle, and then pull a whole 30–60 tile patch off
  the network before anything sharpened. Now the tiles for the first two zoom
  levels are already on their way ~150 ms after the globe appears, and the
  level below whatever you're looking at is fetched while you look at it. In a
  stubbed 250 ms-latency browser run, the first zoom-in went from 25 tiles of
  waiting to **zero** — the sharp version is simply there on the next frame.
- **Anything already in cache skips the settle entirely.** Detail now runs at
  two speeds: a warm level is composited and swapped in on the current frame,
  and only work that still needs the network waits for the view to stop. The
  settle itself is down to 150 ms.
- **The reveal's zoom lands sharp.** The round's answer is pre-fetched at the
  exact zoom the fly-to settles at, during the round, so the camera arrives on
  imagery that's already there instead of unblurring after it stops. (Nothing
  is given away — every location's coordinates ship in the bundle, and the
  prompt names the place.) The framing beat before it gets the same treatment
  the moment your guess is locked in.
- **A patch that's still loading now sharpens instead of blinking.** Patches
  start as an upscaled crop of the Blue Marble base and fill in tile by tile,
  so you see detail arrive progressively. One tile that 404s costs one blurry
  square; it used to throw the entire patch away.
- Tile cache is LRU rather than FIFO, so pre-fetching can't evict the tiles
  you're currently looking at, and duplicate requests for the same tile now
  share one fetch. Pre-fetching backs off entirely on Save-Data and 2G.

## 1.6.0 — 2026-08-16

- **Refit the curve again, on two more measured rounds** — and this time two
  independent anchors agree. From MapTap's own reveal screen:
  **3,820 km → 58** (Santa Monica) and **13,060 km → 6** (Nicosia). Solved
  separately they give k = 2.572 and 2.662, and a single exponent of **2.6**
  reproduces both exactly. The curve is now `100·(1 − d/20,015 km)^2.6`.

  Every model so far has been far too harsh. On that real 58-point round:

  | Model | Scored it |
  |---|---|
  | v1.3 | 8 |
  | v1.4 | 17 |
  | v1.5 | 38 |
  | **v1.6** | **58** ✅ |

  Zero is now reachable — the score first rounds to 0 at **17,410 km**, 87% of
  the way around the planet, which matches players actually posting zeroes.
  The bullseye widens to ~38 km, still emergent from the formula.

  The Wolfsburg round (362 km → 92, reported the same day but on a
  different-looking screen — miles, and the score written as "92%") remains an
  outlier the model puts at 95. No two-parameter family tested fits all three
  better than ±2, so the two rounds that agree with each other win. Detail in
  `docs/scoring.md`.
- **The reveal now flies the globe to the answer.** It used to stop at the
  midpoint between your tap and the target, so the globe never actually
  travelled to the place you were looking for. Now the reveal plays in two
  beats: frame both points so the geodesic shows the miss, then fly over to the
  answer, zoom to city scale, and drop the pin as it lands.
- Touching the globe cancels the pending fly-to instead of yanking the view
  away mid-drag. **Frame both** and **Zoom to answer** replay either beat.

## 1.5.0 — 2026-08-16

- **Refit the distance curve on a measured MapTap round.** A reveal screenshot
  from the game — Wolfsburg, *"Score: 92% Distance: 225 miles"* — pins the
  curve exactly. 1.4.0 scored that same round **74**, and 1.3.x scored it
  **42**: both were far too harsh, which is why good guesses lost points and
  far-off guesses collapsed into the twenties. The curve is now
  `100·(1 − d/20,015 km)^4.6`, whose single free parameter the anchor fixes
  (`k = ln 0.92 / ln(1 − 362.1/20015) = 4.567`, admissible range 4.28–4.86).

  | Error | 100 km | 362 km | 1,000 km | 3,000 km | 5,000 km |
  |---|---|---|---|---|---|
  | was (1.4.0) | 91 | 74 | 48 | 15 | 5 |
  | now | 98 | **92** | 79 | 47 | 27 |

  The ~22 km bullseye and the exact zero at antipodal range now fall out of the
  formula instead of being bolted on as special cases.
- **The `[×1 ×1 ×2 ×3 ×3]` ladder is confirmed in-game.** The same screenshot
  reads *"Round: 3 (medium - points doubled)"* — exactly what 1.4.0's fit
  predicted from the score archive, from an independent source.
- The HUD now labels rounds the way MapTap does — `easy ×1`, `medium ×2`,
  `hard ×3` — rather than showing a bare multiplier.
- Reveal and results rows show distance in km **and** miles, since miles are
  the unit MapTap reports errors in.

## 1.4.0 — 2026-08-16

- **Scoring now mirrors MapTap properly — including the round multipliers.**
  MapTap's Daily multiplies the later, harder clues so a flawless five-clue run
  is exactly 1,000; MapTrainer was scoring a flat /500 and missing the entire
  strategic layer. The ladder `×1 ×1 ×2 ×3 ×3` was solved from 434 complete
  real MapTap games (per-round scores plus posted totals) — it reproduces the
  posted total exactly in 94.2% of them, against 6.5% for the next-best
  candidate. Classic and Blitz carry it; Survival and Drill stay flat,
  mirroring Frontier and Practice. Full derivation in `docs/scoring.md`.
- Classic/Blitz queues are no longer shuffled — they run easy → hard, so the
  ×3 rounds are the ones that are actually worth ×3.
- Grades are computed on the multiplier-weighted percentage: blow a ×3 round
  and it costs you a grade. The multiplier is shown in the HUD *before* the
  tap, the reveal shows the arithmetic (`33 × 3`), and results break out
  score / multiplier / points per round.
- **Recalibrated the distance curve against 2,240 real MapTap rounds.** The
  old `exp(−d/400)` decay was at ~0 by 1,200 km, which can't produce the 10–45
  band that ~15% of real rounds land in. Replaced with a stretched exponential,
  `100·exp(−((d−15)/1400)^0.85)`: same 15 km bullseye, gentler near field
  (91 at 100 km), and a fat tail that only reaches zero at antipodal range.
- Share text uses MapTap's format — total out of 1,000 plus an emoji per
  round, with bands read off the same archive.
- **The globe stays live after you lock in.** Previously the reveal froze it,
  so there was no way to check your work. Now you can drag, pinch and scroll
  through the reveal — right down to Sentinel-2 detail — to see where the
  answer actually was.
- The reveal draws a labelled dashed geodesic from your tap to the target with
  the error distance pinned to the middle of the line, and auto-frames the
  pair on reveal; a **Frame both** button snaps back to that framing after you
  wander. A tight guess frames itself right on the city.

## 1.3.1 — 2026-08-12

- City name in the prompt pill is never truncated — the pill grows to fit it
  and the round/score pill wraps to a second line if space runs out. Verified
  against the dataset's longest prompt (Kingstown · St. Vincent and the
  Grenadines) at 375 px. The country line is what ellipsizes now, not the ask.
- Fixed the phantom gap inside the prompt pill: empty parts (e.g. the blank
  country line in capital drills) no longer contribute a flex gap.

## 1.3.0 — 2026-08-12

- **Progress tracking**: Stats now answers "am I improving?" — score-trend
  line chart over the last 30 sessions (hover a dot for date/mode/score),
  last-14-days training activity strip, 7-day average with week-over-week
  delta, and a last-10-sessions trend signal.
- **Globe-first layout**: landing straight into a Classic game — the menu is
  one tap away via the logo/Train. Game view is now edge-to-edge: the app
  fills the full dynamic viewport (100dvh + safe-area insets, extends under
  the mobile URL bar), the top bar floats over the globe, and the HUD is a
  single horizontal strip (prompt pill left, round/score pill right).

## 1.2.1 — 2026-08-12

- Mobile top bar fix: streak chip no longer wraps to five lines on phones —
  compact `🔥 Nd · best N` label under 560 px, tighter nav spacing, no more
  clipped Stats button.

## 1.2.0 — 2026-08-12

- **MapTap+ Pro-tier zoom fidelity.** Reverse-engineered MapTap's imagery
  stack: they serve a Sentinel-2 tile pyramid (free tier caps at zoom 8,
  MapTap+ at zoom 10). MapTrainer now streams the same imagery family — EOX
  s2cloudless WGS84 tiles — up to **zoom 10 (~76 m/px)** as a regional detail
  patch composited over the Blue Marble base in the shader, with wrap-aware
  bounds (antimeridian targets like Fiji work) and a 180 ms fade-in.
- Max globe zoom deepened 14× → 48× (~2.5° across the viewport — MapTap+
  `minDistance` parity). Tile cache (400 tiles), settle-debounced fetching,
  and graceful fallback: offline or tile failure just keeps the base texture.
- Imagery attribution line on the game screen (EOX CC BY-NC-SA 4.0).

## 1.1.0 — 2026-08-12

- **Satellite globe**: NASA Blue Marble imagery (public domain, bundled —
  still zero external requests) reprojected onto the orthographic sphere in a
  WebGL fragment shader, with limb shading and vector country borders overlaid.
  Falls back to the flat vector style if WebGL is unavailable.
- **Sound effects**: synthesized via Web Audio (no audio assets) — rising
  fanfare for bullseyes, sad trombone for wrong-hemisphere disasters, tiers in
  between. Mute toggle in the top bar, persisted.
- **Trash-talk engine**: 35+ tiered quips on every reveal ("We don't geoshame
  here. But man, that's bad.") plus grade-specific lines on the results screen.

## 1.0.0 — 2026-08-11

Initial release.

- Canvas-rendered rotatable 3D globe (orthographic) with drag, scroll/pinch
  zoom, and tap-to-pin — the MapTap.gg interaction model.
- Four modes: Classic (5 rounds), Blitz (20 s rounds), Survival (shrinking
  clock, 3 lives), and Drill (10 rounds, weakness-weighted).
- 300-location corpus: 194 world capitals, 56 major cities, all 50 US state
  capitals, tiered by difficulty.
- MapTap-style distance scoring: 100 inside 15 km, exponential decay after.
- Spaced-repetition weak-spot engine with per-location EMAs, staleness
  weighting, and exploration bonus for unseen locations.
- Stats dashboard: per-continent skill, weakest-10 table, session history,
  daily training streak.
- 34-test vitest suite covering geodesy, scoring, SRS, session logic, and
  dataset integrity (unique ids, valid coordinates, 50-state coverage).
- GitHub Pages deploy workflow.
