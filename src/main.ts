import './style.css';
import { LOCATIONS, CONTINENTS } from './data/locations';
import type { Location } from './data/types';
import { DRILLS, drillPool, type Drill } from './data/drills';
import { formatKm, grade, type LatLon } from './core/geo';
import {
  createSession,
  commitGuess,
  currentLocation,
  currentRound,
  timeLimitFor,
  totalScore,
  averageScore,
  MODE_CONFIG,
  SURVIVAL_LIVES,
  type ModeId,
  type Session,
  type RoundResult,
} from './core/game';
import { pickWeighted, updateStat, weakestLocations, type StatsMap } from './core/srs';
import {
  loadStats,
  saveStats,
  appendHistory,
  loadHistory,
  bumpStreak,
  loadStreak,
  resetAll,
} from './core/storage';
import { Globe } from './globe/globe';
import { pickQuip, GRADE_QUIPS } from './core/quips';
import { sfxForScore, sfxLock, isMuted, toggleMuted } from './core/sfx';

const app = document.querySelector<HTMLDivElement>('#app')!;

// ── app state ─────────────────────────────────────────────────────────
let stats: StatsMap = loadStats();
let session: Session | null = null;
let activeDrill: Drill = DRILLS[0];
let globe: Globe | null = null;
let timerHandle = 0;
let timerEndsAt = 0;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const MODES: { id: ModeId; name: string; desc: string; tag: string }[] = [
  {
    id: 'classic',
    name: 'Classic',
    desc: '5 rounds, no clock. Pure precision — the Daily format.',
    tag: '5 rounds',
  },
  {
    id: 'blitz',
    name: 'Blitz',
    desc: '5 rounds, 20 seconds each. Train for Versus matches.',
    tag: '20s / round',
  },
  {
    id: 'survival',
    name: 'Survival',
    desc: 'Endless run, shrinking clock, 3 lives. Frontier training.',
    tag: '3 lives',
  },
  {
    id: 'drill',
    name: 'Drill',
    desc: '10 rounds on a focused pool, weighted toward your weak spots.',
    tag: 'targeted',
  },
];

// ── helpers ───────────────────────────────────────────────────────────
function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function teardownGame(): void {
  clearInterval(timerHandle);
  globe?.destroy();
  globe = null;
  if (keyHandler) {
    window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
}

function setScreen(node: HTMLElement, nav: 'train' | 'stats' | null): void {
  teardownGame();
  app.innerHTML = '';
  app.appendChild(renderTopbar(nav));
  app.appendChild(node);
}

// ── topbar ────────────────────────────────────────────────────────────
function renderTopbar(active: 'train' | 'stats' | null): HTMLElement {
  const streak = loadStreak();
  const bar = el(`
    <div class="topbar">
      <div class="logo">Map<em>Trainer</em></div>
      <div class="streak-chip">🔥 ${streak.current}-day streak · best ${streak.best}</div>
      <div class="spacer"></div>
      <button class="nav-btn mute-btn" title="Toggle sound">${isMuted() ? '🔇' : '🔊'}</button>
      <button class="nav-btn ${active === 'train' ? 'active' : ''}" data-nav="train">Train</button>
      <button class="nav-btn ${active === 'stats' ? 'active' : ''}" data-nav="stats">Stats</button>
    </div>
  `);
  bar.querySelector('.mute-btn')!.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.textContent = toggleMuted() ? '🔇' : '🔊';
  });
  bar.querySelector('.logo')!.addEventListener('click', showMenu);
  bar.querySelector('[data-nav="train"]')!.addEventListener('click', showMenu);
  bar.querySelector('[data-nav="stats"]')!.addEventListener('click', showStats);
  return bar;
}

// ── menu ──────────────────────────────────────────────────────────────
function showMenu(): void {
  const screen = el(`
    <div class="screen">
      <div class="wrap">
        <h1>Become the GOAT MapTapper 🌍</h1>
        <p class="subtitle">
          Precision training for MapTap.gg — same globe, same scoring, plus a
          weak-spot engine MapTap doesn't have.
        </p>
        <h2>Game Modes</h2>
        <div class="mode-grid"></div>
        <h2>Drill Pool</h2>
        <p class="subtitle" style="margin-bottom:12px">
          Applies to Drill mode. ${LOCATIONS.length} locations loaded.
        </p>
        <div class="chip-row"></div>
      </div>
    </div>
  `);

  const grid = screen.querySelector('.mode-grid')!;
  for (const m of MODES) {
    const card = el(`
      <button class="mode-card">
        <div class="mode-name">${m.name}</div>
        <div class="mode-desc">${m.desc}</div>
        <span class="mode-tag">${m.tag}</span>
      </button>
    `);
    card.addEventListener('click', () => startGame(m.id));
    grid.appendChild(card);
  }

  const chips = screen.querySelector('.chip-row')!;
  for (const d of DRILLS) {
    const chip = el(
      `<button class="chip ${d.id === activeDrill.id ? 'selected' : ''}">${d.label} · ${drillPool(d).length}</button>`,
    );
    chip.addEventListener('click', () => {
      activeDrill = d;
      showMenu();
    });
    chips.appendChild(chip);
  }

  setScreen(screen, 'train');
}

// ── game ──────────────────────────────────────────────────────────────
function buildQueue(mode: ModeId): Location[] {
  const now = Date.now();
  if (mode === 'drill') {
    return pickWeighted(drillPool(activeDrill), stats, MODE_CONFIG.drill.rounds, now);
  }
  if (mode === 'survival') {
    // Difficulty ramp: tier 1 → 2 → 3, weakness-weighted inside each band.
    const t1 = pickWeighted(LOCATIONS.filter((l) => l.tier === 1), stats, 8, now);
    const t2 = pickWeighted(LOCATIONS.filter((l) => l.tier === 2), stats, 12, now);
    const t3 = pickWeighted(LOCATIONS.filter((l) => l.tier === 3), stats, 40, now);
    return [...t1, ...t2, ...t3];
  }
  // classic & blitz: MapTap-like mix, mostly famous with a curveball or two.
  const easy = pickWeighted(LOCATIONS.filter((l) => l.tier === 1), stats, 2, now);
  const mid = pickWeighted(LOCATIONS.filter((l) => l.tier === 2), stats, 2, now);
  const hard = pickWeighted(LOCATIONS.filter((l) => l.tier === 3), stats, 1, now);
  return [...easy, ...mid, ...hard].sort(() => Math.random() - 0.5);
}

function startGame(mode: ModeId): void {
  const queue = buildQueue(mode);
  if (queue.length === 0) return;
  session = createSession(mode, queue);

  const screen = el(`
    <div class="screen game">
      <div class="globe-container"></div>
      <div class="hud-top">
        <div class="prompt-card">
          <div class="prompt-label"></div>
          <div class="prompt-name"></div>
          <div class="prompt-country"></div>
        </div>
        <div class="hud-meta">
          <span class="round-counter"></span>
          <span class="score-so-far"></span>
          <span class="timer" hidden></span>
          <span class="lives" hidden></span>
        </div>
      </div>
      <div class="hud-bottom">
        <button class="btn ghost reset-view">Reset view</button>
        <button class="btn primary lock-in" disabled>Lock In</button>
      </div>
    </div>
  `);

  const container = screen.querySelector<HTMLElement>('.globe-container')!;
  const lockBtn = screen.querySelector<HTMLButtonElement>('.lock-in')!;

  setScreen(screen, 'train');
  globe = new Globe(container, {
    onPin: () => {
      lockBtn.disabled = false;
    },
  });

  screen.querySelector('.reset-view')!.addEventListener('click', () => globe?.resetView());
  lockBtn.addEventListener('click', () => lockIn(screen));

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const next = document.querySelector<HTMLButtonElement>('.reveal-next');
      if (next) next.click();
      else if (!lockBtn.disabled) lockBtn.click();
    }
  };
  window.addEventListener('keydown', keyHandler);

  beginRound(screen);
}

function beginRound(screen: HTMLElement): void {
  if (!session || !globe) return;
  const loc = currentLocation(session);
  if (!loc) return;

  globe.clearReveal();
  globe.setPin(null);
  globe.interactive = true;
  screen.querySelector<HTMLButtonElement>('.lock-in')!.disabled = true;

  const askByCountry =
    session.mode === 'drill' && activeDrill.askByCountry && loc.tags.includes('capital');
  screen.querySelector('.prompt-label')!.textContent = askByCountry ? 'Find the capital of' : 'Find';
  screen.querySelector('.prompt-name')!.textContent = askByCountry ? loc.country : loc.name;
  screen.querySelector('.prompt-country')!.textContent = askByCountry ? '' : loc.country;

  const roundsTotal =
    session.mode === 'survival' ? '∞' : String(Math.min(session.queue.length, MODE_CONFIG[session.mode].rounds));
  screen.querySelector('.round-counter')!.innerHTML =
    `Round <strong>${currentRound(session) + 1}</strong>/${roundsTotal}`;
  screen.querySelector('.score-so-far')!.innerHTML = `Score <strong>${totalScore(session)}</strong>`;

  const livesEl = screen.querySelector<HTMLElement>('.lives')!;
  if (session.mode === 'survival') {
    livesEl.hidden = false;
    livesEl.textContent = '❤️'.repeat(session.lives) + '🖤'.repeat(SURVIVAL_LIVES - session.lives);
  }

  const limit = timeLimitFor(session);
  const timerEl = screen.querySelector<HTMLElement>('.timer')!;
  clearInterval(timerHandle);
  if (limit !== null) {
    timerEl.hidden = false;
    timerEndsAt = Date.now() + limit * 1000;
    const tick = (): void => {
      const left = Math.max(0, (timerEndsAt - Date.now()) / 1000);
      timerEl.textContent = `⏱ ${left.toFixed(1)}s`;
      timerEl.classList.toggle('low', left <= 5);
      if (left <= 0) {
        clearInterval(timerHandle);
        lockIn(screen); // auto-commit whatever pin is placed (or none)
      }
    };
    tick();
    timerHandle = window.setInterval(tick, 100);
  } else {
    timerEl.hidden = true;
  }
}

function lockIn(screen: HTMLElement): void {
  if (!session || !globe) return;
  clearInterval(timerHandle);
  const guess: LatLon | null = globe.getPin();
  const result = commitGuess(session, guess);

  // record stats
  stats[result.location.id] = updateStat(
    stats[result.location.id],
    result.score,
    Number.isFinite(result.errorKm) ? result.errorKm : 20000,
    Date.now(),
  );
  saveStats(stats);

  globe.interactive = false;
  sfxLock();
  globe.showReveal(guess, { lat: result.location.lat, lon: result.location.lon });
  showRevealCard(screen, result);
  sfxForScore(result.score);
}

function showRevealCard(screen: HTMLElement, r: RoundResult): void {
  screen.querySelector('.hud-bottom')?.setAttribute('hidden', '');
  const cls = r.score >= 80 ? 'good' : r.score >= 40 ? 'mid' : 'bad';
  const detail = r.guess
    ? `${formatKm(r.errorKm)} from ${esc(r.location.name)}`
    : `Time's up — no pin placed`;
  const isOver = session!.finished;
  const quip = pickQuip(r.score, !r.guess);
  const card = el(`
    <div class="reveal-card">
      <div class="reveal-score ${cls}">+${r.score}</div>
      <div class="reveal-detail">${detail}</div>
      <div class="reveal-quip">${esc(quip)}</div>
      <button class="btn primary reveal-next">${isOver ? 'See Results' : 'Next Round'}</button>
    </div>
  `);
  card.querySelector('.reveal-next')!.addEventListener('click', () => {
    card.remove();
    screen.querySelector('.hud-bottom')?.removeAttribute('hidden');
    if (isOver) finishSession();
    else beginRound(screen);
  });
  screen.appendChild(card);
}

// ── results ───────────────────────────────────────────────────────────
function finishSession(): void {
  if (!session) return;
  const s = session;
  const avg = averageScore(s);
  const validErrors = s.results.filter((r) => Number.isFinite(r.errorKm));
  const avgErr = validErrors.length
    ? validErrors.reduce((sum, r) => sum + r.errorKm, 0) / validErrors.length
    : 0;

  appendHistory({
    mode: s.mode,
    when: Date.now(),
    rounds: s.results.length,
    totalScore: totalScore(s),
    avgErrorKm: avgErr,
  });
  bumpStreak();

  const g = grade(avg);
  const shareText =
    `MapTrainer ${s.mode} — ${totalScore(s)} pts over ${s.results.length} rounds ` +
    `(avg ${Math.round(avg)}/100, grade ${g}) 🌍`;

  const screen = el(`
    <div class="screen">
      <div class="wrap">
        <div class="result-hero">
          <div class="result-grade">${g}</div>
          <div class="result-quip">${esc(GRADE_QUIPS[g] ?? '')}</div>
          <div class="result-total">
            <strong>${totalScore(s)}</strong> pts · ${s.results.length} rounds ·
            avg error ${formatKm(avgErr)}
          </div>
        </div>
        <div class="round-list"></div>
        <div class="actions-row">
          <button class="btn primary again">Train Again</button>
          <button class="btn ghost share">Copy Result</button>
          <button class="btn ghost menu">Menu</button>
        </div>
      </div>
    </div>
  `);

  const list = screen.querySelector('.round-list')!;
  for (const r of s.results) {
    list.appendChild(
      el(`
        <div class="round-row">
          <div class="r-name">${esc(r.location.name)} <span>${esc(r.location.country)}</span></div>
          <div class="r-km">${r.guess ? formatKm(r.errorKm) : 'no pin'}</div>
          <div class="r-score" style="color:${r.score >= 80 ? 'var(--good)' : r.score >= 40 ? 'var(--accent-2)' : 'var(--bad)'}">${r.score}</div>
        </div>
      `),
    );
  }

  const mode = s.mode;
  screen.querySelector('.again')!.addEventListener('click', () => startGame(mode));
  screen.querySelector('.menu')!.addEventListener('click', showMenu);
  screen.querySelector('.share')!.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(shareText);
      (e.currentTarget as HTMLButtonElement).textContent = 'Copied!';
    } catch {
      /* clipboard unavailable */
    }
  });

  session = null;
  setScreen(screen, 'train');
}

// ── stats ─────────────────────────────────────────────────────────────
function showStats(): void {
  const history = loadHistory();
  const streak = loadStreak();
  const attempted = LOCATIONS.filter((l) => stats[l.id]);

  const screen = el(`
    <div class="screen">
      <div class="wrap">
        <h1>Your Training Stats</h1>
        <p class="subtitle">Progress across ${history.length} sessions.</p>
        <div class="tile-row"></div>
        <h2>Skill by Continent</h2>
        <div class="continent-bars"></div>
        <h2>Weakest Locations — drill these</h2>
        <div class="weak-holder"></div>
        <button class="danger-link reset-data">Reset all training data</button>
      </div>
    </div>
  `);

  const tiles = screen.querySelector('.tile-row')!;
  const totalRounds = history.reduce((s, h) => s + h.rounds, 0);
  const meanScore = attempted.length
    ? attempted.reduce((s, l) => s + stats[l.id].emaScore, 0) / attempted.length
    : 0;
  const tile = (value: string, label: string): HTMLElement =>
    el(`<div class="tile"><div class="t-value">${value}</div><div class="t-label">${label}</div></div>`);
  tiles.appendChild(tile(String(history.length), 'sessions'));
  tiles.appendChild(tile(String(totalRounds), 'rounds played'));
  tiles.appendChild(tile(attempted.length ? `${Math.round(meanScore)}` : '—', 'avg skill /100'));
  tiles.appendChild(
    tile(`${attempted.length}/${LOCATIONS.length}`, 'locations seen'),
  );
  tiles.appendChild(tile(`${streak.current}🔥`, `streak (best ${streak.best})`));

  const bars = screen.querySelector('.continent-bars')!;
  if (attempted.length === 0) {
    bars.appendChild(el(`<div class="empty-note">Play a session and your per-continent skill shows up here.</div>`));
  } else {
    for (const cont of CONTINENTS) {
      const pool = attempted.filter((l) => l.continent === cont.id);
      if (pool.length === 0) continue;
      const avg = pool.reduce((s, l) => s + stats[l.id].emaScore, 0) / pool.length;
      bars.appendChild(
        el(`
          <div class="bar-row">
            <div class="b-label">${cont.label}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round(avg)}%"></div></div>
            <div class="b-value">${Math.round(avg)}</div>
          </div>
        `),
      );
    }
  }

  const holder = screen.querySelector('.weak-holder')!;
  const weakest = weakestLocations(LOCATIONS, stats, 10);
  if (weakest.length === 0) {
    holder.appendChild(el(`<div class="empty-note">No data yet — go play.</div>`));
  } else {
    const table = el(`
      <table class="weak-table">
        <thead><tr><th>Location</th><th>Where</th><th style="text-align:right">Skill</th><th style="text-align:right">Avg miss</th></tr></thead>
        <tbody></tbody>
      </table>
    `);
    const tbody = table.querySelector('tbody')!;
    for (const l of weakest) {
      const st = stats[l.id];
      tbody.appendChild(
        el(`
          <tr>
            <td>${esc(l.name)}</td>
            <td>${esc(l.country)}</td>
            <td class="num">${Math.round(st.emaScore)}</td>
            <td class="num">${formatKm(st.emaErrorKm)}</td>
          </tr>
        `),
      );
    }
    holder.appendChild(table);
  }

  screen.querySelector('.reset-data')!.addEventListener('click', () => {
    if (confirm('Wipe all MapTrainer stats, history, and streaks?')) {
      resetAll();
      stats = loadStats();
      showStats();
    }
  });

  setScreen(screen, 'stats');
}

// ── boot ──────────────────────────────────────────────────────────────
showMenu();
