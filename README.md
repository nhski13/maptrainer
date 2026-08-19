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
| **By Country** | One country's top 25 cities, quizzed or studied | Learning a country properly |

Drill pools: World Capitals (asked as *"Find the capital of X"* to train
recall), Major Cities, US State Capitals, each continent, Deep Cuts (tier-3
obscurities), and Micronations & Tiny Targets.

## Training by country

Pick India and you get its 25 biggest cities, most populous first — the run
ramps from Mumbai to Visakhapatnam instead of shuffling the two together.
**Top 10** trims it to a quick session, and the capital is never trimmed away.
120 countries have packs; the thinner ones run 10–20 cities rather than 25.

**Study mode** is the other half, because quizzing yourself on something you've
never seen isn't learning. Toggle it and the whole pack lands on the globe at
once — every city dotted and labelled, the country framed to fit, the list
beside it. Tap a city and the globe flies there and zooms to street scale;
arrow keys walk the list. Labels go down biggest-city-first and any that would
collide is dropped, so zooming in is what brings the rest back. Nothing is
scored, nothing is timed, and *Quiz me on these* is one tap away. On a phone
the list is a sheet across the bottom, so it folds away — tap or swipe down its
grip, press Escape, or just tap the map — leaving a single bar that names the
city you're looking at and brings the list back when you tap it.

Country packs reuse the curated corpus rather than duplicating it — India's
pack points at the same `mumbai` entry every other mode uses, so a city's
history is one history no matter where you meet it.

### Where the cities come from

Two open gazetteers, and a city only ships if both agree:

- **[SimpleMaps World Cities Basic](https://simplemaps.com/data/world-cities)**
  (CC BY 4.0) — coordinates, country and population. Measured against this
  repo's hand-curated corpus, its coordinates land a mean 2.7 km from ours.
- **[GeoNames](https://www.geonames.org/)** (CC BY 4.0) — confirmation and
  names. A candidate ships only if GeoNames also puts a settlement there, of
  the same name or of comparable size, within 25 km.

The cross-check earns its keep. Gazetteer population figures are sometimes
district totals pinned to a village that happens to share the city's name — one
such record would have taught Gorakhpur 811 km from Gorakhpur. Names come from
GeoNames because SimpleMaps carries typos and pre-rename spellings (*Shenyeng*,
*Nasik*, *Ft. Worth*); transliteration marks are stripped from them, so you get
Surat rather than Sūrat while São Paulo and Zürich keep their accents. Cities
within 25 km of a higher-ranked one are folded away — closer than the scoring
bullseye is not a separate question.

Regenerate with `node scripts/build-country-packs.mjs` (see the script header
for the three packages it wants), then `node scripts/backfill-populations.mjs`
to re-add the population column.

Populations are GeoNames' — the city itself, not its metro area. That is the
figure that stays comparable across 2,800 cities: Paris reads 2.1M next to
Lyon's 0.5M rather than 13M next to 1.7M, and the reader is never left guessing
which definition a given line was written to. 2,611 of 2,630 entries resolve;
the rest carry no figure rather than a guessed one, and the reveal card just
omits the line.

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

**Distance curve.** `100 · (1 − ((d − 40 km) / 14,300 km)^0.65)` — points
*lost* grow as a sublinear power of the error, past a metro-sized bullseye.
Two fitted constants, six rounds measured off MapTap's own reveal screen, five
reproduced exactly:

| Error | 40 km | 362 km | 538 km | 1,022 km | 2,000 km | 3,820 km | 8,000 km | 13,060 km | 14,340 km |
|---|---|---|---|---|---|---|---|---|---|
| Score | 100 | **92** | **89** | 82 (**80**) | 73 | **58** | 32 | **6** | 0 |

MapTap is gentle in the middle and less so at the ends than it looks — a miss
the width of Germany costs about 8 points, but coast-to-coast across the USA is
still a 58. Distances are shown in miles, since miles are what MapTap reports;
the curve above is stated in km because that is what the app measures and
scores in internally.

Two weak spots, both honest: the 40 km bullseye is inferred from how often real
rounds score exactly 100, not measured — no anchor lies closer than 362 km. And
zero first appears at 14,340 km against a furthest measured round of 13,060 km,
so the last 1,280 km is extrapolation. A measured round inside 200 km, or a
measured zero with its distance, would settle each.

Grades run F → GOAT and are computed on the multiplier-weighted percentage, so
blowing a ×3 round costs you a grade.

## Reviewing your guess

The reveal plays in two beats, because it has two things to say. First the
globe frames your tap *and* the answer together, with a dashed geodesic between
them, both ends labelled, and the error distance hung on the middle of the
line — that's how far off you were. Then it flies over to the answer and zooms
to city scale, dropping the pin as it lands — that's where it actually was.

The globe stays live throughout: grab it at any point and the flight cancels
rather than fighting you, so you can drag, pinch and scroll all the way down to
Sentinel-2 detail. **Frame both** and **Zoom to answer** replay either beat.

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
npm test         # vitest suite (112 tests)
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
- Each detail patch is seeded from the one it replaces, so crossing a zoom
  band never shows less than what was already on screen, and patches fade out
  on the way back to globe scale rather than being cut.
- A moving view fetches as it moves — including a tile band beyond the edges a
  drag is heading for — and re-centres its patch on what it has, rather than
  waiting for the gesture to end and then discovering it has nothing.

**Vector overlay**: country borders from
[world-atlas](https://github.com/topojson/world-atlas) at 1:110m, and — inside
the United States — state lines at 1:10m, faded in between 1.6× and 2.8× zoom.
Regenerate the state mesh with `node scripts/build-state-lines.mjs` (see the
script header). It ships as interior boundaries only: coastlines and the
Canadian and Mexican frontiers are the country layer's job, and dropping them
is three quarters of the source by point count.

## Architecture

```
src/
  core/geo.ts       haversine distance, MapTap-calibrated scoring, grading
  core/srs.ts       spaced-repetition weighting + weighted sampling
  core/game.ts      session state machine + MapTap round multipliers
  core/storage.ts   localStorage stats, history, streaks
  data/locations.ts 300 curated locations: capitals, major cities, US states
  data/cities.ts    generated country packs: 120 countries, 2,330 more cities
  data/countries.ts pack resolution, country search
  data/drills.ts    drill pool definitions
  data/state-lines.ts generated US state boundary mesh (interior lines only)
  globe/globe.ts    canvas globe: drag-rotate, pinch/scroll zoom, tap-to-pin
  main.ts           screens, HUD, timers, game loop
```
