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

`unarmedpuppy/maptapdat` is a dashboard someone built to track their friend
group's MapTap scores, scraped from pasted iMessage share texts. It records
per-round scores *and* the posted total for every game.

**Know what this is before leaning on it: 12 players, 82 days, 2025-09-19 to
2025-12-09, 2,994 usable rounds.** One social circle, and nine months old at
time of writing. It is strong evidence for *structural* facts that a small
sample still pins down exactly — the multiplier ladder below — and weak
evidence for anything distributional, because scoring may have changed since
and twelve people are not the player base.

Recording both the per-round scores and the posted total is what makes the
multiplier ladder solvable: it is the integer vector `m` satisfying
`Σ mᵢ·scoreᵢ = total` across every game at once.

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

## The distance curve: fitted to six measured rounds

MapTap does not publish its distance→score formula, but it prints both numbers
on its own reveal screen. Six such rounds have now been read off it:

| Round | Distance | Score | Reported on |
|---|---|---|---|
| Wolfsburg, Germany | 362 km (225 mi) | 92 | miles, `Score: 92%` |
| Fairbanks, Alaska | 538 km (334 mi) | 89 | `MapTap #788`, miles, `Score: 89 (x2)` |
| Samarkand, Uzbekistan | 541 km (336 mi) | 89 | `MapTap #788`, miles, `Score: 89 (x3)` |
| Karakorum, Mongolia | 1,022 km (635 mi) | 80 | `MapTap #788`, miles, `Score: 80 (x3)` |
| Santa Monica, CA | 3,820 km | 58 | `MapTap #786`, km, `Score: 58` |
| Nicosia, Cyprus | 13,060 km | 6 | `MapTap #786`, km, `Score: 6` |

The curve fitted to them is

```
score(d) = 100 · (1 − ((d − 40 km) / 14,300 km) ^ 0.65)
```

| Round | MapTap | this curve | previous curve `(1−d/20015)^2.6` |
|---|---|---|---|
| Wolfsburg | 92 | **92** ✅ | 95 |
| Fairbanks | 89 | **89** ✅ | 93 |
| Samarkand | 89 | **89** ✅ | 93 |
| Karakorum | 80 | 82 | 87 |
| Santa Monica | 58 | **58** ✅ | 58 ✅ |
| Nicosia | 6 | **6** ✅ | 6 ✅ |

### Why the family had to change, not just the exponent

Version 1.6 fitted `100 · (1 − d/20,015)^k` on the two `#786` rounds, which
agreed with each other on `k ≈ 2.6` to within 0.09. It also carried a known
outlier: Wolfsburg at 362 km wanted `k = 4.57` and got scored 95 against a
reported 92. That was written up as unexplained, possibly a different mode or
units setting, with the note that *a third round near 400 km would settle
whether the curve or the outlier is wrong*.

Three such rounds arrived (`MapTap #788`, above), and they settled it against
the curve. Solve each round for its own `k` under the old family:

| Round | 362 km | 538 km | 541 km | 1,022 km | 3,820 km | 13,060 km |
|---|---|---|---|---|---|---|
| implied `k` | 4.57 | 4.28 | 4.26 | 4.26 | 2.57 | 2.66 |

Four near rounds cluster at `k ≈ 4.3`, two far rounds at `k ≈ 2.6`. No single
`k` serves both, and no choice of the second parameter rescues it: a grid over
`(1 − d/D)^k` with `D` free bottoms out at max error 6, and `exp(−(d/a)^p)` at
7. Wolfsburg was never an outlier — it was the first sight of the near half of
a curve the old family had the wrong shape for.

The family that does work makes **points lost** the power law, rather than
points kept:

```
lost(d) = 100 · (d / D) ^ p        with p < 1
```

A sublinear exponent is what reconciles the two halves. Doubling a small error
costs much less than double, so the curve can be strict at 500 km (11 points
gone) and still generous at 3,820 km (only 42 gone) — the exact combination
the old family could not express.

### How tightly the two constants are pinned

Fitting `D` and `p` jointly on all six rounds, the window that keeps five of
them exact with the sixth within 2 is narrow: **`D` 14,205–14,430 km, `p`
0.6485–0.6520**. `D = 14,300`, `p = 0.65` sits inside it.

Leave-one-out is the real test, and it is reassuring — drop any single round,
refit, and both constants barely move:

| dropped | refit `D` | refit `p` | worst error on the five kept |
|---|---|---|---|
| Wolfsburg | 14,250 | 0.628 | 1 |
| Fairbanks | 14,250 | 0.628 | 1 |
| Samarkand | 14,250 | 0.628 | 1 |
| Karakorum | 14,180 | 0.663 | **0** |
| Santa Monica | 14,250 | 0.627 | 1 |
| Nicosia | 15,170 | 0.616 | 1 |

No round is carrying the fit. Only Nicosia — the sole anchor past 3,820 km, and
so the only one holding the far end down — moves `D` by more than 1%, and even
then by 6%. Compare the old one-parameter fit, where removing either `#786`
round moved the exponent from 2.6 to over 4.

Dropping Karakorum makes the remaining five exact, which is the sense in which
it is the misfit round rather than the curve being wrong there — but at 2
points off it is not worth a third fitted constant to chase.

| Error | 40 km | 100 km | 362 km | 538 km | 1,022 km | 2,000 km | 3,820 km | 8,000 km | 13,060 km | 14,340 km |
|---|---|---|---|---|---|---|---|---|---|---|
| Score | 100 | 97 | **92** | **89** | 82 (**80**) | 73 | **58** | 32 | **6** | 0 |

### The bullseye is now assumed, not emergent

The `− 40 km` in the numerator is the one number here that is **not** fitted,
and it is the weakest claim in this document.

The nearest measured round is Wolfsburg at 362 km, so nothing in the anchor
set constrains the first few hundred km at all: refitting with the grace
radius fixed anywhere from 0 to 80 km changes the residuals by less than a
point. The anchors cannot see it.

It is set from a different piece of evidence instead — the archive below,
where 5–11% of rounds score exactly 100. The bare curve pays 100 only inside
~4 km, which no plausible distribution of taps on a phone-sized globe reaches
one round in ten. Some plateau has to exist; 40 km is metro-area scale, and
it is close to the ~38 km the old curve happened to produce.

This is a step down in rigour from v1.6, where the bullseye fell out of the
curve for free. It is honest about which way the evidence points: the six
anchors demand the new family, and the new family does not produce a bullseye
on its own. **A measured round inside 200 km is the most valuable missing data
point now** — it would pin the plateau down, and it is exactly the range a
trainer spends most of its life in.

### Where zero lands

Zero now arrives at **14,340 km** rather than 17,410 km. That is a shorter
extrapolation than before, not a longer one: the furthest measured round is
Nicosia at 13,060 km scoring 6, so the curve is being read only 1,280 km past
its last anchor instead of 4,350 km.

It does mean more of the globe scores zero — about 19% of the surface, against
4% under the old curve. Against the 2025 archive that is defensible rather
than settled: 0.47% of all rounds scored exactly 0, rising to 2.08% on round
5, and under this curve a round-5 p10 of 24 points corresponds to a 9,400 km
miss, so a 2% tail past 14,340 km sits on a sensible continuation of the same
distribution. Those zeroes were earned under whatever curve was live in 2025,
so they cannot be converted into distances directly.

**Honest status: the ladder is measured and confirmed; the curve's two
constants are fitted on six rounds spanning 362–13,060 km and survive
leave-one-out; the 40 km bullseye is inferred from the archive's rate of
perfect rounds and is not measured.**

### For reference: the score distribution

From the 2,994 usable rounds in the 12-player archive described above —
context for the curve, not an input to it, and possibly from an older scoring
regime.

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
- **Distances are shown in miles** on the reveal and the results rows, because
  that is the unit MapTap reports and four of the six anchors above are mileage
  figures. Scoring still runs on kilometers internally; the conversion happens
  where the text is drawn.
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
- Per-round score archive — [unarmedpuppy/maptapdat](https://github.com/unarmedpuppy/maptapdat):
  12 players, 2025-09-19 to 2025-12-09, 2,994 usable rounds, scraped from
  iMessage share texts
- Measured (distance, score) rounds and the `Round: 3 (medium - points
  doubled)` label — in-game reveal screenshots supplied by the user:
  2026-08-16 (MapTap #786, distances in km; plus the Wolfsburg round shown in
  miles) and 2026-08-18 (MapTap #788, distances in miles — Samarkand,
  Karakorum, Fairbanks, the three that forced the refit)
