# How MapTrainer's scoring mirrors MapTap.gg

MapTrainer only works as training if its numbers mean what MapTap's numbers
mean. This is the research behind `src/core/geo.ts` and `src/core/game.ts` —
what is measured, what is inferred, and what is still a judgement call.

## What MapTap does

The Daily is five clues. Each tap scores **0–100** on great-circle distance,
and the later, harder clues are **multiplied**, so a flawless run is exactly
**1,000**. Difficulty ramps across the five: clue 1 is a London, clue 5 is an
island nation in the middle of the Pacific.

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

Reproduce it with `npm test` (`tests/game.test.ts` → *MapTap round
multipliers*).

## The distance curve: fitted, not measured

MapTap does not publish its distance→score formula, and no dataset pairs a
score with its error distance. What the archive *does* give is the shape of
the score distribution over **2,240 real rounds**:

| Round | mean | median | p10 | ≥90 | =100 | <50 |
|---|---|---|---|---|---|---|
| 1 | 94.4 | 96 | 89 | 88.4% | 10.7% | 0.4% |
| 2 | 92.9 | 96 | 84 | 81.7% | 5.6% | 0.7% |
| 3 | 85.9 | 93 | 64 | 64.5% | 4.9% | 6.5% |
| 4 | 76.7 | 84 | 41 | 39.7% | 1.3% | 14.3% |
| 5 | 68.4 | 76 | 24 | 27.0% | 0.2% | 21.0% |

Two things fall out of this, and both broke the old model:

**A flat 100 needs a real bullseye radius.** 5–11% of rounds score exactly
100. Under any smooth curve that rounds to the nearest integer, hitting 100
would require sub-3-km precision on a globe — far rarer than 1 in 10. So
MapTap must award a flat 100 inside some radius. `BULLSEYE_KM = 15` puts
round-1's perfect rate in the right place.

**The tail is fat.** About 15% of all rounds land in the 10–45 band. The old
curve, `100·exp(-(d-15)/400)`, is already at ~3 by 1,200 km and ~0 past
1,500 km, which squeezes that entire band into a narrow 640–1,210 km shell.
Real misses on a Pacific micronation are thousands of kilometres, and they
still score in the twenties.

A stretched exponential fixes both — flatter near the target, long-tailed
across oceans:

```
score(d) = 100 · exp( −((d − 15 km) / 1400 km) ^ 0.85 )     for d > 15 km
score(d) = 100                                              for d ≤ 15 km
```

| Error | 15 km | 50 km | 100 km | 250 km | 500 km | 1,000 km | 2,000 km | 5,000 km | 12,000 km |
|---|---|---|---|---|---|---|---|---|---|
| Score | 100 | 96 | 91 | 80 | 67 | 48 | 26 | 5 | 0 |

Read backwards, this says the median round-1 tap is ~33 km off and the median
round-5 tap is ~450 km off — plausible numbers for tapping a globe, which is
the sanity check that matters.

**Honest status: the ladder is measured, the curve is calibrated.** If someone
turns up a set of (distance, score) pairs from real games, `DECAY_SCALE_KM`
and `DECAY_SHAPE` are the two constants to refit; nothing else moves.

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
