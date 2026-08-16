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
totals), where it reproduces the total exactly in 94.2% of them against 6.5%
for the next-best candidate. Classic and Blitz carry it; Survival and Drill
score flat, mirroring Frontier and Practice.

Because the multiplier rides on difficulty, Classic and Blitz queues run
easy → hard rather than shuffled: the ×3 rounds are the ones worth ×3.

**Distance curve.** 100 points inside a 15 km bullseye, then a stretched
exponential — `100·exp(−((d−15)/1400)^0.85)`. That's ~96 at 50 km, 91 at
100 km, 67 at 500 km, 48 at 1,000 km, 26 at 2,000 km, zero by 12,000 km.
MapTap's exact formula is unpublished, so this is calibrated against the score
distribution of 2,240 real rounds; the headline correction over the old
`exp(−d/400)` model is the **tail**, which has to stay fat — ~15% of real
rounds land in the 10–45 band, and misses that big are thousands of km, not
hundreds.

Grades run F → GOAT and are computed on the multiplier-weighted percentage, so
blowing a ×3 round costs you a grade.

## Reviewing your guess

The globe stays live after you lock in. The reveal drops a dashed geodesic
between your tap and the answer, labels both ends, and hangs the error
distance on the middle of the line — then hands the controls straight back, so
you can drag, pinch and scroll all the way down to Sentinel-2 detail and see
exactly what you missed and by how much. **Frame both** snaps the view back to
fit the pair; a tight guess frames itself right on top of the city.

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
