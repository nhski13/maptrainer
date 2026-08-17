# How MapTrainer's scoring mirrors MapTap.gg

MapTrainer only works as training if its numbers mean what MapTap's numbers
mean. This is the research behind `src/core/geo.ts` and `src/core/game.ts` —
what is measured, what is inferred, and what is still a judgement call.

## What MapTap does

The Daily is five clues. Each tap scores **0–100** on great-circle distance,
and the later, harder clues are **multiplied**, so a flawless run is exactly
**1,000**. Difficulty ramps across the five: clue 1 is a London, clue 5 is an
island nation in the middle of the Pacific. MapTap reports errors in **miles**
and labels each round by tier — its reveal reads
`Round: 3 (medium - points doubled)`.

## The multipliers: `[×1, ×1, ×2, ×3, ×3]` — measured

This is the part that was previously missing from MapTrainer entirely, and it
is not a guess.

`unarmedpuppy/maptapdat` is a third-party MapTap leaderboard that archives
players' shared results: per-round scores *and* the posted total, for every
game. That makes the multiplier ladder solvable — it is the integer vector
`m` satisfying `Σ mᵢ·scoreᵢ = total` across every game at once.

Searching all 4⁵ candidate vectors over the 434 complete games where every
round score is a valid 0–100:

| Candidate | Games reproduced exactly |
|---|---|
| **`[1, 1, 2, 3, 3]`** | **409 / 434 (94.2%)** |
| `[2, 1, 1, 3, 3]` | 28 / 434 (6.5%) |
| `[2, 1, 2, 2, 3]` | 20 / 434 (4.6%) |
| `[3, 1, 2, 1, 3]` | 19 / 434 (4.4%) |

The winner is unambiguous, it sums to 10 (× 100 = the documented 1,000-point
maximum), and it matches the reported shape — "the closing rounds count double
or triple". The 25 residual misses are transcription noise: that dataset is
scraped from pasted iMessage share text, and the same file contains rows whose
"round score" is over 100.

**Independently confirmed in-game.** A MapTap reveal screenshot states it
outright: `Round: 3 (medium - points doubled)`. Round 3 doubled is exactly what
the fit predicts, and the "medium" label shows the ladder is really a
difficulty ladder — easy ×1, medium ×2, hard ×3 — which is what
`difficultyFor()` now surfaces in the HUD.

Reproduce it with `npm test` (`tests/game.test.ts` → *MapTap round
multipliers*).

## The distance curve: fitted to measured rounds

MapTap does not publish its distance→score formula, but it prints both numbers
on its own reveal screen. Three such rounds:

| Round | Distance | Score | Build |
|---|---|---|---|
| Santa Monica, CA | 3,820 km | 58 | current (km, `Score: 58`) |
| Nicosia, Cyprus | 13,060 km | 6 | current (km, `Score: 6`) |
| Wolfsburg, Germany | 362 km (225 mi) | 92 | older (miles, `Score: 92%`) |

The curve is the remaining fraction of the way to the far side of the planet,
raised to a power — one free parameter:

```
score(d) = 100 · (1 − d / 20,015 km) ^ 2.6
```

**Why 2.6.** Solve each anchor for `k` on its own and the two current-build
rounds land on 2.572 and 2.662 — agreement to within 0.09, from two rounds
thousands of km apart. The window of `k` that rounds *both* to their reported
scores is **2.586–2.613**, and 2.6 sits mid-window. One parameter, two exact
hits.

**The Wolfsburg outlier.** That round wants `k = 4.57` and the model gives it
95 against a reported 92. It is from a visibly older build — miles instead of
km, and the score written as `92%` rather than `92`. A grid search over
two-parameter families (`(1−d/D)^k`, `exp(−(d/D)^p)`, `(1−(d/A)^a)^b`) found
nothing that fits all three better than ±2, so rather than contort the curve
around a stale point this fits the two consistent modern ones exactly and
carries the +3. A current-build round somewhere near 400 km would settle it.

| Error | 38 km | 500 km | 1,000 km | 2,000 km | 3,820 km | 8,000 km | 13,060 km | 17,410 km |
|---|---|---|---|---|---|---|---|---|
| Score | 100 | 94 | 88 | 76 | **58** | 27 | **6** | 0 |

**MapTap is much gentler than it looks**, and every model here has been far
too harsh. On the real 58-point Santa Monica round:

| Model | Scored it |
|---|---|
| v1.3 `100·exp(−(d−15)/400)` | 8 |
| v1.4 `100·exp(−((d−15)/1400)^0.85)` | 17 |
| v1.5 `100·(1 − d/20015)^4.6` | 38 |
| **v1.6 `100·(1 − d/20015)^2.6`** | **58** ✅ |

Two things fall out of the form rather than being bolted on:

- **The bullseye is emergent** — everything inside ~38 km rounds to a flat 100,
  with no piecewise branch. Some radius of this order is required, because
  5–11% of real rounds score exactly 100 and no smooth curve produces that.
- **Zero is reachable but has to be earned.** The score first rounds to 0 at
  **17,410 km** — 87% of the way around the planet. Players do post zeroes, so
  the curve has to bottom out inside the range of real misses, but not before.

**Honest status: the ladder is measured and confirmed; the curve rests on two
consistent measured points plus one older outlier.** `SCORE_EXPONENT` is the
only constant that moves if more rounds turn up.

### For reference: the score distribution

From 2,240 real rounds in the archive — context for the curve, not an input
to it.

| Round | mean | median | p10 | ≥90 | =100 | <50 |
|---|---|---|---|---|---|---|
| 1 | 94.4 | 96 | 89 | 88.4% | 10.7% | 0.4% |
| 2 | 92.9 | 96 | 84 | 81.7% | 5.6% | 0.7% |
| 3 | 85.9 | 93 | 64 | 64.5% | 4.9% | 6.5% |
| 4 | 76.7 | 84 | 41 | 39.7% | 1.3% | 14.3% |
| 5 | 68.4 | 76 | 24 | 27.0% | 0.2% | 21.0% |

Weighted by the multipliers, the average archived player finishes around
**794/1000** — a B on MapTrainer's ladder, which is where a typical daily
player should land.

## Which modes carry multipliers

| MapTrainer mode | Multipliers | Mirrors |
|---|---|---|
| Classic (5 rounds) | `×1 ×1 ×2 ×3 ×3` → /1000 | the Daily |
| Blitz (5 rounds, 20 s) | `×1 ×1 ×2 ×3 ×3` → /1000 | Versus / Gauntlet |
| Survival | flat ×1 | Frontier — escalates via clock and pool, not the scoreboard |
| Drill (10 rounds) | flat ×1 | Practice — gates XP on 90%+ per location, where a multiplier would blur the threshold |

Because the multiplier rides on difficulty, Classic and Blitz queues are
ordered easy → hard rather than shuffled: two tier-1 locations, two tier-2,
one tier-3, so the ×3 rounds are the ones actually worth ×3.

## Knock-on effects

- **Grades** are computed on the multiplier-weighted percentage
  (`scorePercent`), not the flat average — fumbling a ×3 round should cost a
  grade.
- **Stats and trend charts** stay on the raw 0–100 scale. `SessionSummary`
  keeps `totalScore` as the sum of unweighted round scores and adds `points` /
  `maxPoints` alongside, so history written before multipliers existed still
  charts correctly.
- **Distances show km and miles** on the reveal and the results rows, because
  MapTap reports miles and the anchor above is a mileage figure.
- **Share text** uses MapTap's format: the total out of 1,000 plus one emoji
  per round. The emoji bands in `scoreEmoji` are read off the emoji→score
  ranges observed in the same archive (🎯/🔥 at 95+, down through 🧊 in the
  teens and 😭 near zero).

## Sources

- Score range, five clues, multipliers on the later rounds, 1,000-point total,
  difficulty ramp — [TechCrunch](https://techcrunch.com/2026/06/18/maptap-a-daily-geography-game-is-my-new-wordle/),
  [Playlin](https://playlin.io/game/map-tap/),
  [Qiaeru](https://qiaeru.com/en/blog/2026/06/18/maptap-guessing-the-world-one-tap-at-a-time/)
- Game modes (Daily, Versus, Frontier, Practice, Adventures) —
  [maptap.gg](https://maptap.gg/), [App Store](https://apps.apple.com/us/app/maptap-gg/id6755205355)
- Per-round score archive (524 games, 3,108 rows) —
  [unarmedpuppy/maptapdat](https://github.com/unarmedpuppy/maptapdat)
- Measured (distance, score) rounds and the `Round: 3 (medium - points
  doubled)` label — in-game reveal screenshots supplied by the user,
  2026-08-16 (MapTap #786 and one older build)
