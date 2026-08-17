import './style.css';
import { LOCATIONS, CONTINENTS } from './data/locations';
import type { Location } from './data/types';
import { DRILLS, drillPool, type Drill } from './data/drills';
import {
  ALL_LOCATIONS,
  COUNTRY_PACKS,
  packCities,
  packsByContinent,
  searchPacks,
  type CountryPack,
} from './data/countries';
import { formatKm, formatDistance, grade, scoreEmoji, type LatLon } from './core/geo';
import {
  createSession,
  commitGuess,
  currentLocation,
  currentRound,
  currentMultiplier,
  difficultyFor,
  timeLimitFor,
  totalScore,
  totalPoints,
  maxPoints,
  scorePercent,
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
import { sessionAvg, lastNDays, weekOverWeek, recentTrend } from './core/progress';
import { sfxForScore, sfxLock, isMuted, toggleMuted } from './core/sfx';

const app = document.querySelector<HTMLDivElement>('#app')!;

// ── app state ─────────────────────────────────────────────────────────
let stats: StatsMap = loadStats();
let session: Session | null = null;
let activeDrill: Drill = DRILLS[0];
let activeCountry: CountryPack | null = null;
/** How much of a country's pack a run covers. */
let countryLimit = 25;
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
  {
    id: 'country',
    name: 'By Country',
    desc: `Learn one country at a time — its top 25 cities, quizzed or studied. ${COUNTRY_PACKS.length} countries.`,
    tag: 'study or quiz',
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
  app.classList.toggle('immersive', node.classList.contains('game'));
  app.appendChild(renderTopbar(nav));
  app.appendChild(node);
}

// ── topbar ────────────────────────────────────────────────────────────
function renderTopbar(active: 'train' | 'stats' | null): HTMLElement {
  const streak = loadStreak();
  const bar = el(`
    <div class="topbar">
      <div class="logo">Map<em>Trainer</em></div>
      <div class="streak-chip">🔥 <span class="streak-long">${streak.current}-day streak · best ${streak.best}</span><span class="streak-short">${streak.current}d · best ${streak.best}</span></div>
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
    // Every other mode can start immediately; a country run needs to know
    // which country first.
    card.addEventListener('click', () =>
      m.id === 'country' ? showCountryPicker() : startGame(m.id),
    );
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

// ── country training ──────────────────────────────────────────────────
/** Mean skill over the cities of a pack you've actually attempted. */
function packSkill(pack: CountryPack): { seen: number; total: number; avg: number | null } {
  const cities = packCities(pack);
  const seen = cities.filter((l) => stats[l.id]);
  return {
    seen: seen.length,
    total: cities.length,
    avg: seen.length ? seen.reduce((s, l) => s + stats[l.id].emaScore, 0) / seen.length : null,
  };
}

/** Country picker: search, or browse by continent. */
function showCountryPicker(): void {
  const screen = el(`
    <div class="screen">
      <div class="wrap">
        <h1>Train by Country</h1>
        <p class="subtitle">
          Pick a country and work through its biggest cities — quiz yourself, or
          study the map first. ${COUNTRY_PACKS.length} countries available.
        </p>
        <input class="country-search" type="search" placeholder="Search countries…"
               autocomplete="off" spellcheck="false" />
        <div class="country-results"></div>
      </div>
    </div>
  `);

  const results = screen.querySelector<HTMLElement>('.country-results')!;
  const search = screen.querySelector<HTMLInputElement>('.country-search')!;

  const button = (pack: CountryPack): HTMLElement => {
    const { seen, total } = packSkill(pack);
    const chip = el(`
      <button class="country-btn">
        <span class="c-name">${esc(pack.name)}</span>
        <span class="c-meta">${total} cities${seen ? ` · ${seen} seen` : ''}</span>
      </button>
    `);
    chip.addEventListener('click', () => showCountry(pack));
    return chip;
  };

  const paint = (): void => {
    results.innerHTML = '';
    const query = search.value.trim();
    if (query) {
      const hits = searchPacks(query);
      if (hits.length === 0) {
        results.appendChild(el(`<div class="empty-note">No country matches “${esc(query)}”.</div>`));
        return;
      }
      const grid = el(`<div class="country-grid"></div>`);
      for (const pack of hits) grid.appendChild(button(pack));
      results.appendChild(grid);
      return;
    }
    for (const cont of CONTINENTS) {
      const packs = packsByContinent(cont.id);
      if (packs.length === 0) continue;
      results.appendChild(el(`<h2>${cont.label}</h2>`));
      const grid = el(`<div class="country-grid"></div>`);
      for (const pack of packs) grid.appendChild(button(pack));
      results.appendChild(grid);
    }
  };

  search.addEventListener('input', paint);
  paint();
  setScreen(screen, 'train');
  search.focus();
}

/** The Quiz ⇄ Study toggle both country screens share. */
function countryToggle(pack: CountryPack, active: 'quiz' | 'study'): HTMLElement {
  const seg = el(`
    <div class="seg">
      <button class="seg-btn ${active === 'quiz' ? 'on' : ''}" data-seg="quiz">Quiz</button>
      <button class="seg-btn ${active === 'study' ? 'on' : ''}" data-seg="study">Study</button>
    </div>
  `);
  seg.querySelector('[data-seg="quiz"]')!.addEventListener('click', () => {
    if (active !== 'quiz') showCountry(pack);
  });
  seg.querySelector('[data-seg="study"]')!.addEventListener('click', () => {
    if (active !== 'study') showStudy(pack);
  });
  return seg;
}

/** A country's quiz side: choose how much of the pack to run, then go. */
function showCountry(pack: CountryPack): void {
  activeCountry = pack;
  const total = packCities(pack).length;
  const { seen, avg } = packSkill(pack);

  const screen = el(`
    <div class="screen">
      <div class="wrap">
        <button class="back-link">← All countries</button>
        <div class="country-head">
          <h1>${esc(pack.name)}</h1>
          <div class="seg-holder"></div>
        </div>
        <p class="subtitle">
          ${total} cities, most populous first — so the run ramps from the ones
          everyone knows to the ones that don't come for free.
        </p>
        <div class="tile-row">
          <div class="tile"><div class="t-value">${total}</div><div class="t-label">cities in pack</div></div>
          <div class="tile"><div class="t-value">${seen}</div><div class="t-label">seen before</div></div>
          <div class="tile"><div class="t-value">${avg === null ? '—' : Math.round(avg)}</div><div class="t-label">avg skill /100</div></div>
        </div>
        <h2>Session length</h2>
        <div class="chip-row length-row"></div>
        <div class="actions-row">
          <button class="btn primary start-country">Start Quiz</button>
          <button class="btn ghost study-instead">Study the map first</button>
        </div>
      </div>
    </div>
  `);

  screen.querySelector('.seg-holder')!.appendChild(countryToggle(pack, 'quiz'));
  screen.querySelector('.back-link')!.addEventListener('click', showCountryPicker);
  screen.querySelector('.study-instead')!.addEventListener('click', () => showStudy(pack));
  screen.querySelector('.start-country')!.addEventListener('click', () => startGame('country'));

  const lengths = screen.querySelector('.length-row')!;
  for (const n of [10, 25]) {
    if (n > total && n !== 25) continue;
    const label = n >= total ? `All ${total}` : `Top ${n}`;
    const chip = el(`<button class="chip ${countryLimit === n ? 'selected' : ''}">${label}</button>`);
    chip.addEventListener('click', () => {
      countryLimit = n;
      showCountry(pack);
    });
    lengths.appendChild(chip);
  }

  setScreen(screen, 'train');
}

/**
 * Study mode: the whole pack on the globe at once, with the list beside it.
 * No scoring, no clock — this is the "look at it until it sticks" half of
 * learning a country, which quizzing alone never does.
 */
function showStudy(pack: CountryPack): void {
  activeCountry = pack;
  const cities = packCities(pack);

  const screen = el(`
    <div class="screen game study">
      <div class="globe-container"></div>
      <div class="hud-top">
        <div class="study-head">
          <button class="back-link">←</button>
          <div class="study-title">${esc(pack.name)}<span>${cities.length} cities</span></div>
          <div class="seg-holder"></div>
        </div>
      </div>
      <div class="study-panel">
        <div class="study-hint">Tap a city to fly there · drag and pinch to explore</div>
        <div class="study-list"></div>
        <div class="study-actions">
          <button class="btn ghost frame-all">Show all</button>
          <button class="btn primary quiz-now">Quiz me on these</button>
        </div>
      </div>
      <div class="attribution">
        NASA Blue Marble · <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (CC BY-NC-SA 4.0)
      </div>
    </div>
  `);

  screen.querySelector('.seg-holder')!.appendChild(countryToggle(pack, 'study'));
  screen.querySelector('.back-link')!.addEventListener('click', showCountryPicker);
  screen.querySelector('.quiz-now')!.addEventListener('click', () => showCountry(pack));

  const list = screen.querySelector<HTMLElement>('.study-list')!;
  const rows: HTMLElement[] = [];
  cities.forEach((city, i) => {
    const st = stats[city.id];
    const row = el(`
      <button class="study-row">
        <span class="s-rank">${i + 1}</span>
        <span class="s-name">${esc(city.name)}</span>
        <span class="s-skill">${st ? `${Math.round(st.emaScore)}` : ''}</span>
      </button>
    `);
    row.addEventListener('click', () => select(i));
    rows.push(row);
    list.appendChild(row);
  });

  const container = screen.querySelector<HTMLElement>('.globe-container')!;
  setScreen(screen, 'train');
  globe = new Globe(container);

  const markers = cities.map((c) => ({ lat: c.lat, lon: c.lon, label: c.name }));
  let selected = -1;

  function select(i: number): void {
    selected = i;
    rows.forEach((r, n) => r.classList.toggle('on', n === i));
    globe?.setMarkers(markers, i);
    const city = cities[i];
    globe?.prefetchAround(city);
    globe?.focusOn(city, Globe.CITY_ZOOM);
    rows[i].scrollIntoView({ block: 'nearest' });
  }

  const panel = screen.querySelector<HTMLElement>('.study-panel')!;

  function showAll(): void {
    selected = -1;
    rows.forEach((r) => r.classList.remove('on'));
    globe?.setMarkers(markers, -1);
    // On a phone the list is a sheet across the bottom of the globe rather
    // than a column beside it; tell the framing how much it hides.
    const sheet = panel.getBoundingClientRect();
    const covers = sheet.width > container.clientWidth * 0.8 ? sheet.height + 16 : 0;
    globe?.frameAll(cities, covers);
  }

  screen.querySelector('.frame-all')!.addEventListener('click', showAll);
  showAll();

  keyHandler = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    select((selected + step + cities.length) % cities.length);
  };
  window.addEventListener('keydown', keyHandler);
}

// ── game ──────────────────────────────────────────────────────────────
function buildQueue(mode: ModeId): Location[] {
  const now = Date.now();
  if (mode === 'country') {
    return activeCountry ? packCities(activeCountry, countryLimit) : [];
  }
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
  // Classic & blitz: the MapTap Daily shape — a famous opener, a curveball
  // closer. Deliberately NOT shuffled: MapTap ramps difficulty across the five
  // clues and hangs the ×2/×3 multipliers on the late ones, so the hard
  // locations have to land in the rounds that are worth the most.
  const easy = pickWeighted(LOCATIONS.filter((l) => l.tier === 1), stats, 2, now);
  const mid = pickWeighted(LOCATIONS.filter((l) => l.tier === 2), stats, 2, now);
  const hard = pickWeighted(LOCATIONS.filter((l) => l.tier === 3), stats, 1, now);
  return [...easy, ...mid, ...hard];
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
          <span class="prompt-label"></span>
          <span class="prompt-name"></span>
          <span class="prompt-country"></span>
        </div>
        <div class="hud-meta">
          <span class="round-counter"></span>
          <span class="multiplier" hidden></span>
          <span class="score-so-far"></span>
          <span class="timer" hidden></span>
          <span class="lives" hidden></span>
        </div>
      </div>
      <div class="hud-bottom">
        <button class="btn ghost reset-view">Reset view</button>
        <button class="btn primary lock-in" disabled>Lock In</button>
      </div>
      <div class="attribution">
        NASA Blue Marble · <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (CC BY-NC-SA 4.0)
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
  // Pull the answer's satellite imagery in the background while the round is
  // being played, so the reveal's zoom lands sharp instead of unblurring after
  // it arrives. Nothing is given away — every location's coordinates are in
  // the bundle already, and the prompt names the place.
  globe.prefetchAround(loc);
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

  // The multiplier is the whole strategy of a MapTap Daily — show it before
  // the tap, not after, so a ×3 round gets the attention it deserves.
  // MapTap labels the round by difficulty and states the multiplier next to
  // it — "Round: 3 (medium - points doubled)". Same here.
  const mult = currentMultiplier(session);
  const difficulty = difficultyFor(session.mode, currentRound(session));
  const multEl = screen.querySelector<HTMLElement>('.multiplier')!;
  multEl.hidden = !difficulty;
  multEl.textContent = difficulty ? `${difficulty} ×${mult}` : '';
  multEl.classList.toggle('hot', mult >= 3);

  const cap = maxPoints(session);
  screen.querySelector('.score-so-far')!.innerHTML = session.mode === 'survival'
    ? `Score <strong>${totalPoints(session)}</strong>`
    : `Score <strong>${totalPoints(session)}</strong>/${cap}`;

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

  // The globe stays live through the reveal — you can drag, pinch and zoom
  // right down to Sentinel-2 detail to study where the answer actually was.
  // Globe.handleTap ignores taps while a reveal is up, so the pin is safe.
  sfxLock();
  globe.showReveal(
    guess,
    { lat: result.location.lat, lon: result.location.lon },
    result.location.name,
  );
  showRevealCard(screen, result);
  sfxForScore(result.score);
}

function showRevealCard(screen: HTMLElement, r: RoundResult): void {
  screen.querySelector('.hud-bottom')?.setAttribute('hidden', '');
  const cls = r.score >= 80 ? 'good' : r.score >= 40 ? 'mid' : 'bad';
  const detail = r.guess
    ? `${formatDistance(r.errorKm)} from ${esc(r.location.name)}`
    : `Time's up — no pin placed`;
  const isOver = session!.finished;
  const quip = pickQuip(r.score, !r.guess);
  // With a multiplier in play, the raw score and the points are different
  // numbers and both matter — show the arithmetic rather than one or other.
  const scoreLine =
    r.multiplier > 1
      ? `+${r.points}<span class="reveal-math">${r.score} × ${r.multiplier}</span>`
      : `+${r.points}`;
  const card = el(`
    <div class="reveal-card">
      <div class="reveal-score ${cls}">${scoreLine}</div>
      <div class="reveal-detail">${detail}</div>
      <div class="reveal-quip">${esc(quip)}</div>
      <div class="reveal-hint">Drag, pinch or scroll to inspect the answer</div>
      <div class="reveal-actions">
        <button class="btn ghost reveal-frame">Frame both</button>
        <button class="btn ghost reveal-zoom">Zoom to answer</button>
        <button class="btn primary reveal-next">${isOver ? 'See Results' : 'Next Round'}</button>
      </div>
    </div>
  `);
  card.querySelector('.reveal-frame')!.addEventListener('click', () => globe?.frameReveal());
  card.querySelector('.reveal-zoom')!.addEventListener('click', () => globe?.flyToAnswer());
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

  const points = totalPoints(s);
  const cap = maxPoints(s);

  appendHistory({
    mode: s.mode,
    when: Date.now(),
    rounds: s.results.length,
    totalScore: totalScore(s), // raw 0–100 sum: keeps the trend charts on scale
    points,
    maxPoints: cap,
    avgErrorKm: avgErr,
  });
  bumpStreak();

  // Graded on the multiplier-weighted percentage, so a blown ×3 round hurts.
  const pct = scorePercent(s);
  const g = grade(pct);
  // MapTap's own share format: the total out of 1,000 and an emoji per round.
  // A country run is named by its country — "MapTrainer country" tells nobody
  // whether you just cleared India or Iceland.
  const label = s.mode === 'country' && activeCountry ? activeCountry.name : s.mode;
  const shareText =
    `MapTrainer ${label} — ${points}/${cap} 🌍\n` +
    s.results.map((r) => scoreEmoji(r.score)).join('') +
    `\navg ${Math.round(avg)}/100 · grade ${g}`;

  const screen = el(`
    <div class="screen">
      <div class="wrap">
        <div class="result-hero">
          <div class="result-grade">${g}</div>
          <div class="result-quip">${esc(GRADE_QUIPS[g] ?? '')}</div>
          <div class="result-points"><strong>${points}</strong><span>/${cap}</span></div>
          <div class="result-total">
            ${s.results.length} rounds · avg ${Math.round(avg)}/100 ·
            avg error ${formatKm(avgErr)}
          </div>
        </div>
        <div class="round-list"></div>
        <div class="actions-row">
          <button class="btn primary again">Train Again</button>
          ${s.mode === 'country' && activeCountry ? '<button class="btn ghost study-again">Study the Misses</button>' : ''}
          <button class="btn ghost share">Copy Result</button>
          <button class="btn ghost menu">Menu</button>
        </div>
      </div>
    </div>
  `);

  const list = screen.querySelector('.round-list')!;
  for (const r of s.results) {
    const tone =
      r.score >= 80 ? 'var(--good)' : r.score >= 40 ? 'var(--accent-2)' : 'var(--bad)';
    list.appendChild(
      el(`
        <div class="round-row">
          <div class="r-name">${esc(r.location.name)} <span>${esc(r.location.country)}</span></div>
          <div class="r-km">${r.guess ? formatDistance(r.errorKm) : 'no pin'}</div>
          <div class="r-score" style="color:${tone}">${r.score}</div>
          <div class="r-mult ${r.multiplier > 1 ? 'on' : ''}">×${r.multiplier}</div>
          <div class="r-points">${r.points}</div>
        </div>
      `),
    );
  }

  const mode = s.mode;
  const country = activeCountry;
  screen.querySelector('.again')!.addEventListener('click', () => startGame(mode));
  screen.querySelector('.menu')!.addEventListener('click', showMenu);
  screen
    .querySelector('.study-again')
    ?.addEventListener('click', () => country && showStudy(country));
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
  // The whole corpus, not just the drill pool: a country run's cities are
  // just as much a part of your history as the capitals are.
  const attempted = ALL_LOCATIONS.filter((l) => stats[l.id]);

  const screen = el(`
    <div class="screen">
      <div class="wrap">
        <h1>Your Training Stats</h1>
        <p class="subtitle">Progress across ${history.length} sessions.</p>
        <div class="tile-row"></div>
        <h2>Progress</h2>
        <div class="progress-tiles tile-row"></div>
        <div class="trend-holder"></div>
        <h2>Last 14 Days</h2>
        <div class="activity-holder"></div>
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
    tile(`${attempted.length}/${ALL_LOCATIONS.length}`, 'locations seen'),
  );
  tiles.appendChild(tile(`${streak.current}🔥`, `streak (best ${streak.best})`));

  // ── progress: deltas, trend chart, activity strip ──────────────────
  const fmtDelta = (d: number): string => `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
  const deltaColor = (d: number | null): string =>
    d === null ? 'var(--ink-2)' : d >= 0 ? 'var(--good)' : 'var(--bad)';

  const wow = weekOverWeek(history);
  const trend = recentTrend(history);
  const pTiles = screen.querySelector('.progress-tiles')!;
  const pTile = (value: string, label: string, color = 'var(--ink)'): HTMLElement =>
    el(`<div class="tile"><div class="t-value" style="color:${color}">${value}</div><div class="t-label">${label}</div></div>`);
  pTiles.appendChild(
    pTile(wow.thisWeek !== null ? wow.thisWeek.toFixed(0) : '—', 'avg score, last 7 days'),
  );
  pTiles.appendChild(
    pTile(
      wow.delta !== null ? fmtDelta(wow.delta) : '—',
      'vs the week before',
      deltaColor(wow.delta),
    ),
  );
  pTiles.appendChild(
    pTile(
      trend !== null ? `${fmtDelta(trend)} ${trend >= 0 ? '📈' : '📉'}` : '—',
      'last 10 sessions trend',
      deltaColor(trend),
    ),
  );

  const trendHolder = screen.querySelector('.trend-holder')!;
  const recent = history.slice(-30);
  if (recent.length < 2) {
    trendHolder.appendChild(
      el(`<div class="empty-note">Play a couple of sessions and your score trend appears here.</div>`),
    );
  } else {
    // Session-by-session average score, oldest → newest.
    const W = 720;
    const H = 150;
    const PAD = { l: 30, r: 14, t: 10, b: 18 };
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const x = (i: number): number => PAD.l + (recent.length === 1 ? 0 : (i / (recent.length - 1)) * iw);
    const y = (v: number): number => PAD.t + (1 - v / 100) * ih;
    const pts = recent.map((s, i) => ({ x: x(i), y: y(sessionAvg(s)), s }));
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const dots = pts
      .map(
        (p) => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="var(--accent)">
          <title>${new Date(p.s.when).toLocaleDateString()} · ${p.s.mode} · ${Math.round(sessionAvg(p.s))}/100</title>
        </circle>`,
      )
      .join('');
    const last = pts[pts.length - 1];
    const gridLines = [0, 50, 100]
      .map(
        (v) => `
        <line x1="${PAD.l}" y1="${y(v)}" x2="${W - PAD.r}" y2="${y(v)}" stroke="rgba(120,170,255,0.12)" stroke-width="1"/>
        <text x="${PAD.l - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink-3)">${v}</text>`,
      )
      .join('');
    trendHolder.appendChild(
      el(`
        <div class="trend-card">
          <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average score per session, last ${recent.length} sessions">
            ${gridLines}
            <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
            ${dots}
            <text x="${Math.min(last.x + 8, W - 4)}" y="${Math.max(last.y - 8, 10)}" font-size="11" font-weight="700" fill="var(--ink)">${Math.round(sessionAvg(last.s))}</text>
          </svg>
        </div>
      `),
    );
  }

  const activityHolder = screen.querySelector('.activity-holder')!;
  const days = lastNDays(history, 14);
  const maxRounds = Math.max(1, ...days.map((d) => d.rounds));
  const activity = el(`<div class="activity-strip"></div>`);
  for (const d of days) {
    const hPct = d.rounds === 0 ? 0 : Math.max(12, (d.rounds / maxRounds) * 100);
    const weekday = 'SMTWTFS'[new Date(`${d.day}T12:00:00`).getDay()];
    activity.appendChild(
      el(`
        <div class="activity-day" title="${d.day} · ${d.rounds} rounds${d.rounds ? ` · avg ${Math.round(d.avgScore)}` : ''}">
          <div class="activity-bar-track">
            <div class="activity-bar" style="height:${hPct}%"></div>
          </div>
          <div class="activity-label">${weekday}</div>
        </div>
      `),
    );
  }
  activityHolder.appendChild(activity);
  const playedDays = days.filter((d) => d.rounds > 0).length;
  activityHolder.appendChild(
    el(`<p class="activity-note">${playedDays}/14 days trained${playedDays >= 10 ? ' — the grind is real 🐐' : playedDays >= 5 ? ' — building the habit' : playedDays > 0 ? ' — streaks win championships' : ''}</p>`),
  );

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
  const weakest = weakestLocations(ALL_LOCATIONS, stats, 10);
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
// Land straight in a Classic game — the globe is the front door.
// Menu stays one tap away via the logo or "Train".
startGame('classic');
