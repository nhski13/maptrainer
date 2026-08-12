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

Mirrors MapTap's distance-based model: **100 points inside a 15 km bullseye**,
then exponential decay (~81 at 100 km, ~38 at 400 km, near zero past 1,200 km).
MapTap's exact formula is unpublished; constants are tuned to match its
published feedback examples. Grades run F → GOAT (97+ average).

## Strategy notes (from the trenches)

- **Anchor off big shapes.** Find the country first, then the region, then commit.
- **Memorize the tiny nations** — Luxembourg, Malta, Singapore, the Pacific
  micro-states. They're free points for people who've drilled them and
  disasters for everyone else. That's what the *Micronations* pool is for.
- **Coastal cities hug the coast.** If the city is a port, pin the shoreline.
- **Trust your first instinct** — the data consistently punishes second-guessing.
- **Capitals aren't always the biggest dot**: Canberra not Sydney, Ankara not
  Istanbul, Bern not Zurich, Wellington not Auckland. Drill *World Capitals*
  in ask-by-country mode until these are automatic.

## Development

```bash
npm install
npm run dev      # local dev server
npm test         # vitest suite (34 tests)
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
  core/geo.ts       haversine distance, MapTap-style scoring, grading
  core/srs.ts       spaced-repetition weighting + weighted sampling
  core/game.ts      session state machine for all four modes
  core/storage.ts   localStorage stats, history, streaks
  data/locations.ts 300 locations: 194 capitals, 56 cities, 50 US states
  data/drills.ts    drill pool definitions
  globe/globe.ts    canvas globe: drag-rotate, pinch/scroll zoom, tap-to-pin
  main.ts           screens, HUD, timers, game loop
```
