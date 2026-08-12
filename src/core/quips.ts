/**
 * The trash-talk engine. We don't geoshame. (We absolutely geoshame.)
 */

export type QuipTier = 'perfect' | 'good' | 'mid' | 'bad' | 'brutal';

export function tierForScore(score: number): QuipTier {
  if (score >= 100) return 'perfect';
  if (score >= 80) return 'good';
  if (score >= 40) return 'mid';
  if (score >= 10) return 'bad';
  return 'brutal';
}

export const QUIPS: Record<QuipTier, string[]> = {
  perfect: [
    'Bullseye. The GOAT walks among us. 🐐',
    'Surgical. Your friends should be scared.',
    'That pin has a mailing address.',
    'Absolutely disgusting precision. Keep it up.',
    'MapTap pros hate this one trick.',
    'You just out-GPSed a GPS.',
  ],
  good: [
    'Clean hit. That would score big on MapTap.',
    'Sharp. A few more like that and it’s over for your group chat.',
    'Solid tap. The globe respects you.',
    'Right neighborhood. Wrong street. Still bragging rights.',
    'That’s a paycheck tap. Reliable, professional.',
  ],
  mid: [
    'That’s… regionally accurate.',
    'Close enough to smell it. Not close enough to score.',
    'The vibes were right. The kilometers were not.',
    'Right country energy, wrong city execution.',
    'A diplomatic answer: not wrong, not right.',
    'Somewhere, a local is laughing at your pin.',
  ],
  bad: [
    'We don’t geoshame here. But man, that’s bad.',
    'You’ll never make it with scores like that.',
    'That pin landed in a different biome.',
    'Geography teachers everywhere just felt a disturbance.',
    'Your pin needs a passport for where it ended up.',
    'Bold of you to invent a new location for that city.',
    'The tectonic plates moved less than your guess.',
  ],
  brutal: [
    'Wrong hemisphere. WRONG. HEMISPHERE.',
    'That guess has its own time zone. Several, actually.',
    'NASA called. Even they couldn’t see that from space.',
    'A dart thrown by a blindfolded toddler scores higher.',
    'The globe was RIGHT THERE.',
    'That’s not a miss, that’s an expedition.',
    'Somewhere between "lost tourist" and "flat earther."',
  ],
};

/** Extra salt for timeouts — no pin at all. */
export const TIMEOUT_QUIPS: string[] = [
  'No pin? The globe was RIGHT THERE.',
  'The clock won. The clock always wins against the unprepared.',
  'Analysis paralysis: 0 points. Decisiveness: also would’ve been 0. Probably.',
  'You had one job. Tap. The. Globe.',
];

/** End-of-session lines keyed by grade. */
export const GRADE_QUIPS: Record<string, string> = {
  GOAT: 'GOAT status. Go collect your MapTap crown. 👑',
  S: 'S-tier. Your friends are about to have a bad week.',
  A: 'A-tier. Dangerous. One drill away from S.',
  B: 'B-tier. Respectable. Not feared. Yet.',
  C: 'C-tier. The middle of the pack is warm and comfortable, isn’t it?',
  D: 'D-tier. The good news: massive room for growth.',
  F: 'F. We don’t geoshame, but the scoreboard does.',
};

export function pickQuip(score: number, timedOut: boolean, rng: () => number = Math.random): string {
  if (timedOut) return TIMEOUT_QUIPS[Math.floor(rng() * TIMEOUT_QUIPS.length)];
  const pool = QUIPS[tierForScore(score)];
  return pool[Math.floor(rng() * pool.length)];
}
