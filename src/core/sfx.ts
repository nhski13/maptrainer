/**
 * Synthesized sound effects via Web Audio — zero assets, works offline.
 * Tiers match the reveal feedback: perfect / good / mid / bad / brutal.
 */

const MUTE_KEY = 'maptrainer.muted.v1';

let ctx: AudioContext | null = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';

function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  ctx ??= new AudioContext();
  // Browsers suspend contexts created before a user gesture.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMuted(): boolean {
  muted = !muted;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  return muted;
}

interface Note {
  /** Hz */
  freq: number;
  /** seconds from now */
  at: number;
  dur: number;
  /** 0–1 */
  gain?: number;
  type?: OscillatorType;
  /** glide to this frequency over the note's duration */
  glideTo?: number;
}

function play(notes: Note[]): void {
  if (muted) return;
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.setValueAtTime(n.freq, t0 + n.at);
    if (n.glideTo) osc.frequency.exponentialRampToValueAtTime(n.glideTo, t0 + n.at + n.dur);
    const peak = n.gain ?? 0.12;
    g.gain.setValueAtTime(0, t0 + n.at);
    g.gain.linearRampToValueAtTime(peak, t0 + n.at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.05);
  }
}

/** Rising major arpeggio + sparkle — the bullseye fanfare. */
export function sfxPerfect(): void {
  play([
    { freq: 523.25, at: 0, dur: 0.12, type: 'triangle' }, // C5
    { freq: 659.25, at: 0.09, dur: 0.12, type: 'triangle' }, // E5
    { freq: 783.99, at: 0.18, dur: 0.14, type: 'triangle' }, // G5
    { freq: 1046.5, at: 0.27, dur: 0.32, type: 'triangle', gain: 0.14 }, // C6
    { freq: 2093, at: 0.3, dur: 0.25, type: 'sine', gain: 0.05 }, // sparkle
  ]);
}

/** Pleasant two-note ding. */
export function sfxGood(): void {
  play([
    { freq: 587.33, at: 0, dur: 0.12, type: 'triangle' }, // D5
    { freq: 880, at: 0.1, dur: 0.28, type: 'triangle', gain: 0.13 }, // A5
  ]);
}

/** Neutral shrug-blip. */
export function sfxMid(): void {
  play([
    { freq: 440, at: 0, dur: 0.1, type: 'square', gain: 0.06 },
    { freq: 440, at: 0.14, dur: 0.14, type: 'square', gain: 0.05 },
  ]);
}

/** Descending womp. */
export function sfxBad(): void {
  play([
    { freq: 330, at: 0, dur: 0.16, type: 'sawtooth', gain: 0.07 },
    { freq: 262, at: 0.14, dur: 0.24, type: 'sawtooth', gain: 0.07 },
  ]);
}

/** Full sad trombone glissando — reserved for the truly lost. */
export function sfxBrutal(): void {
  play([
    { freq: 294, at: 0, dur: 0.22, type: 'sawtooth', gain: 0.08 },
    { freq: 277, at: 0.22, dur: 0.22, type: 'sawtooth', gain: 0.08 },
    { freq: 262, at: 0.44, dur: 0.2, type: 'sawtooth', gain: 0.08 },
    { freq: 247, at: 0.62, dur: 0.7, type: 'sawtooth', gain: 0.09, glideTo: 175 },
  ]);
}

/** Soft click when a pin is locked in. */
export function sfxLock(): void {
  play([{ freq: 1200, at: 0, dur: 0.05, type: 'square', gain: 0.04 }]);
}

/** Route a round score to its sound. */
export function sfxForScore(score: number): void {
  if (score >= 100) sfxPerfect();
  else if (score >= 80) sfxGood();
  else if (score >= 40) sfxMid();
  else if (score >= 10) sfxBad();
  else sfxBrutal();
}
