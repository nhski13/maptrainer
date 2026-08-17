# MapTrainer 🌍

**Precision training for [MapTap.gg](https://maptap.gg) — become the GOAT MapTapper.**

MapTap is a daily geography game: rotate a 3D globe, tap where a city is, score
0–100 by how close you land. Beating your friends means three skills — pin
precision, speed under a clock, and coverage of the world's capitals, cities,
and US states. MapTrainer drills all three, and adds the thing MapTap doesn't
have: a **spaced-repetition engine that targets your weak spots**.

## Game modes

| Mode | Format | Trains for |
|---|---|---|
| **Classic** | 5 rounds, no clock | The Daily — pure precision |
| **Blitz** | 5 rounds, 20 s each | Versus / Gauntlet matches |
| **Survival** | Endless, shrinking clock (20 s → 6 s), 3 lives | Frontier survival runs |
| **Drill** | 10 rounds on a focused pool | Targeted weak-spot grinding |

Drill pools: World Capitals (asked as *"Find the capital of X"* to train
recall), Major Cities, US State Capitals, each continent, Deep Cuts (tier-3
obscurities), and Micronations & Tiny Targets.

## The weak-spot engine

Every guess updates an exponential moving average of your score and error
distance per location. Round selection then weights toward:

1. locations you score poorly on,
2. locations you've never seen,
3. locations going stale (fully "due" after a week).

The **Stats** tab shows per-continent skill, your 10 weakest locations, session
history, and a daily training streak. All data lives in `localStorage` — no
account, no server, no tracking.

## Scoring

Mirrors MapTap's model on both axes — see [`docs/scoring.md`](docs/scoring.md)
for the full derivation.

**Round multipliers.** MapTap's Daily multiplies the later, harder clues, so a
flawless five-clue run is exactly 1,000. The ladder is `×1 ×1 ×2 ×3 ×3` —
solved from 434 complete real MapTap games (per-round scores plus posted
totals, archived by a 12-player friend group in late 2025), where it
reproduces the total exactly in 94.2% of them against 6.5%
for the next-best candidate — and confirmed straight from the game, whose
reveal reads *"Round: 3 (medium - points doubled)"*. The ladder is really a
difficulty ladder: easy ×1, medium ×2, hard ×3, labelled that way in the HUD.
Classic and Blitz carry it; Survival and Drill score flat, mirroring Frontier
and Practice.

Because the multiplier rides on difficulty, Classic and Blitz queues run
easy → hard rather than shuffled: the ×3 rounds are the ones worth ×3.

**Distance curve.** `100 · (1 − d/20,015 km)^2.6` — the remaining fraction of
the way to the far side of the planet, raised to a power. Fitted to rounds
measured off MapTap's own reveal screen: **3,820 km → 58** and
**13,060 km → 6**. Those two agree on the exponent to within 0.09, and one
parameter reproduces both exactly.

| Error | 38 km | 500 km | 2,000 km | 3,820 km | 8,000 km | 13,060 km | 17,410 km |
|---|---|---|---|---|---|---|---|
| Score | 100 | 94 | 76 | **58** | 27 | **6** | 0 |

MapTap is much gentler than it looks — a miss the width of Germany barely
registers, and coast-to-coast across the USA is still a 58. The ~38 km bullseye
falls out of the formula rather than being bolted on. Distances are shown in km
*and* miles, since miles are what MapTap reports.

The far end is the weak spot: zero first appears at 17,410 km, but the furthest
measured round is Nicosia at 13,060 km, so everything past that is
extrapolation. A measured zero, with its distance, would pin it down.

Grades run F → GOAT and are computed on the multiplier-weighted percentage, so
blowing a ×3 round costs you a grade.

## Reviewing your guess

The reveal plays in two beats, because it has two things to say. First the
globe frames your tap *and* the answer together, with a dashed geodesic between
them and both ends labelled — that's how far off you were. Then it flies over to
the answer and zooms to city scale, dropping the pin as it lands — that's where
it actually was.

The globe stays live throughout: grab it at any point and the flight cancels
rather than fighting you, so you can drag, pinch and scroll all the way down to
Sentinel-2 detail. **Frame both** and **Zoom to answer** replay either beat.

The score is set as plain text over the globe, MapTap-style, rather than in a
panel — on a phone a panel at the bottom of the screen lands squarely on the
answer the reveal just flew to. It gets out of the way entirely on a tap of the
globe, a swipe down, **Esc**, or the **✕**, leaving just the number; tap that to
bring it back. The choice sticks for the rest of the session.

Tap in the wrong country and the reveal says which one you actually hit. That
comes from the same 110m outlines the globe draws, matched polygon-to-polygon
rather than by name, so a spelling difference between our list and Natural
Earth can never fake a wrong-country call. Countries too small to have an
outline at that resolution — Singapore, Malta, Monaco — simply say nothing.

Rounds accumulate. Every tap and answer stays on the globe, dimmed, for the
rest of the session, so by round five you can zoom out and see the whole run at
once — which is where the pattern in your misses actually shows up.

## Strategy notes (from the trenches)

- **Anchor off big shapes.** Find the country first, then the region, then commit.
- **Memorize the tiny nations** — Luxembourg, Malta, Singapore, the Pacific
  micro-states. They're free points for people who've drilled them and
  disasters for everyone else. That's what the *Micronations* pool is for.
- **Coastal cities hug the coast.** If the city is a port, pin the shoreline.
- **Trust your first instinct** — the data consistently punishes second-guessing.
- **Spend your time on rounds 4 and 5.** They're worth ×3 each — 60% of the
  board. Rushing them to bank an early ×1 is how good players lose Dailies.
- **Capitals aren't always the biggest dot**: Canberra not Sydney, Ankara not
  Istanbul, Bern not Zurich, Wellington not Auckland. Drill *World Capitals*
  in ask-by-country mode until these are automatic.

## Development

```bash
npm install
npm run dev      # local dev server
npm test         # vitest suite (57 tests)
npm run build    # typecheck + production build
```

Stack: Vite + TypeScript, WebGL-reprojected satellite imagery with `d3-geo`
vector borders overlaid, Web Audio synthesized sound effects. No backend, no
API keys, fully static — deploys to GitHub Pages on every push to `main`.

**Imagery pipeline** (matches MapTap+ Pro fidelity — their free tier caps at
tile zoom 8, Pro at 10):

- Base: NASA Blue Marble 4096×2048 (bundled, public domain) — instant paint,
  works offline.
- Detail: when zoomed past ~2.2×, Sentinel-2 cloudless tiles
  ([EOX s2maps.eu](https://s2maps.eu), CC BY-NC-SA 4.0, the same imagery
  family MapTap serves) stream in up to WGS84 zoom 10 (~76 m/px) and are
  composited over the base in the fragment shader. Offline or on tile
  failure the base texture simply stays — the game never breaks.

## Architecture

```
src/
  core/geo.ts       haversine distance, MapTap-calibrated scoring, grading
  core/srs.ts       spaced-repetition weighting + weighted sampling
  core/game.ts      session state machine + MapTap round multipliers
  core/storage.ts   localStorage stats, history, streaks
  data/locations.ts 300 locations: 194 capitals, 56 cities, 50 US states
  data/drills.ts    drill pool definitions
  globe/globe.ts    canvas globe: drag-rotate, pinch/scroll zoom, tap-to-pin
  main.ts           screens, HUD, timers, game loop
```
