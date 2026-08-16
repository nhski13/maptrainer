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

## The distance curve: one measured anchor

MapTap does not publish its distance→score formula. It does, however, print
both numbers on its own reveal screen, and one such round pins the curve down:

> **Wolfsburg, Germany** — Round: 3 (medium - points doubled) —
> **Score: 92%  Distance: 225 miles**

225 miles is 362.1 km. **A miss the width of Germany scores 92.** That single
fact is worth more than any amount of distribution-fitting, and it condemned
both earlier models outright:

| Model | Scores the Wolfsburg round |
|---|---|
| v1.3 `100·exp(−(d−15)/400)` | **42** |
| v1.4 `100·exp(−((d−15)/1400)^0.85)` | **74** |
| v1.5 `100·(1 − d/20015)^4.6` | **92** ✅ |

The current curve is the remaining fraction of the way to the far side of the
planet, raised to a power:

```
score(d) = 100 · (1 − d / 20,015 km) ^ 4.6
```

It has one free parameter, and the anchor fixes it:
`k = ln(0.92) / ln(1 − 362.1/20015) = 4.567`. MapTap rounds miles to the unit
and the score to a whole percent, so the anchor really pins `k` to
**[4.28, 4.86]**; **4.6** sits mid-window and reproduces the observed 92.

| Error | 22 km | 100 km | 362 km | 500 km | 1,000 km | 2,000 km | 3,000 km | 5,000 km | 10,000 km | 20,015 km |
|---|---|---|---|---|---|---|---|---|---|---|
| Score | 100 | 98 | **92** | 89 | 79 | 62 | 47 | 27 | 4 | 0 |

Three things fall out of the form itself, none of which had to be bolted on:

- **The bullseye is emergent.** Everything inside ~21.7 km rounds to a flat
  100 — no piecewise branch. That matters, because 5–11% of real rounds score
  exactly 100, which no smooth curve produces without a radius of roughly this
  size. v1.3 and v1.4 both had to hard-code one.
- **Zero means antipodal.** The score reaches 0 exactly at 20,015 km and
  nowhere earlier. The earlier models were effectively at zero by 1,200 km and
  12,000 km respectively, which is why a genuinely far-off guess used to return
  a derisory score instead of the 30–50 MapTap actually awards.
- **It is monotonic and smooth everywhere**, so there is no seam where a metre
  of extra error costs a visible chunk of points.

Sanity-check it backwards against the archive's distribution: a round-1 median
of 96 implies a typical ~177 km miss on a famous city, a round-5 median of 76
implies ~1,160 km on an obscure one, and the round-5 10th percentile of 24
implies ~5,340 km. Those are believable numbers for tapping a globe with a
finger, which is the check that matters.

**Honest status: the ladder is measured and confirmed, the curve rests on a
single measured point.** One anchor fixes one parameter exactly, but it cannot
verify the *shape*. More reveal screenshots — especially one very close guess
and one very bad one — would either confirm the exponent or refit it;
`SCORE_EXPONENT` is the only constant that would move.

### For reference: the score distribution

From 2,240 real rounds in the archive. This is what the curve is sanity-checked
against, not what it is fitted to.

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
- The Wolfsburg anchor and the `Round: 3 (medium - points doubled)` label —
  in-game reveal screenshot supplied by the user, 2026-08-16
