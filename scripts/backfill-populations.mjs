/**
 * Adds (or refreshes) the population on every entry in src/data/locations.ts
 * and src/data/cities.ts.
 *
 *   npm i --no-save all-the-cities
 *   node scripts/backfill-populations.mjs
 *
 * The figure is GeoNames' (CC BY 4.0), which is the city's own population —
 * the administrative unit that carries the name — not its metropolitan area.
 * That is the number an encyclopedia gives for a city, and it is the one that
 * stays comparable across 2,800 of them: Paris is 2.1M next to Lyon's 0.5M
 * rather than 13M next to 1.7M, and the reader is not left guessing which
 * definition each line was written to. It is also already the source of the
 * names in both files, so a player reading "Surat, pop. 2.9M" is reading one
 * gazetteer rather than two stitched together.
 *
 * Matching is by position first: a candidate must sit within MATCH_KM of the
 * coordinates the corpus already carries. Among those, a name match wins; if
 * none of them is spelled recognisably the same, the largest settlement at
 * those coordinates is taken instead, which is the case where the two sources
 * simply disagree on what to call the place. Anything that resolves to nothing
 * is left without a population rather than guessed at — the field is optional
 * precisely so a miss can stay a miss.
 *
 * Rewrites both files in place, appending the number as the last argument of
 * each L(...) / C(...) call, and replacing one that is already there.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A GeoNames record must be this close to be the same place. */
const MATCH_KM = 25;
/** Folded names this many edits apart are the same name, differently spelled. */
const NAME_EDIT_SLACK = 3;

// ── geo ───────────────────────────────────────────────────────────────
const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
function km(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

// ── names (same comparison the pack builder uses) ─────────────────────
const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

function sameName(a, b) {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 5 && long.startsWith(short) && short.length / long.length >= 0.6) return true;
  const cap = Math.min(NAME_EDIT_SLACK, Math.floor(short.length / 3));
  return cap > 0 && editDistance(a, b, cap) <= cap;
}

// ── GeoNames, bucketed onto a 1-degree grid ───────────────────────────
const geonames = require('all-the-cities');
const grid = new Map();
const cell = (lat, lon) => `${Math.floor(lat)}|${Math.floor(lon)}`;
for (const g of geonames) {
  if (!(g.population > 0)) continue; // a record with no figure is no answer
  const lon = g.loc.coordinates[0];
  const lat = g.loc.coordinates[1];
  const key = cell(lat, lon);
  let bucket = grid.get(key);
  if (!bucket) grid.set(key, (bucket = []));
  bucket.push({ name: g.name, lat, lon, pop: g.population });
}

/** GeoNames population for a corpus entry, or null if nothing matches. */
function populationOf(entry) {
  const near = [];
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      for (const g of grid.get(cell(entry.lat + dLat, entry.lon + dLon)) ?? []) {
        if (km(entry, g) <= MATCH_KM) near.push(g);
      }
    }
  }
  if (near.length === 0) return null;
  const wanted = fold(entry.name);
  const named = near.filter((g) => sameName(wanted, fold(g.name)));
  const pool = named.length > 0 ? named : near;
  return pool.reduce((a, b) => (b.pop > a.pop ? b : a)).pop;
}

// ── rewrite ───────────────────────────────────────────────────────────
/**
 * Both files declare their rows through a fixed-shape helper call, so the
 * arguments can be read and rewritten positionally. `tail` is everything after
 * the coordinates, with an optional population already on the end.
 */
const CALL_RE =
  /(\b[LC]\(\s*(['"])(.*?)\2,\s*(['"])(.*?)\4,\s*(['"])(.*?)\6,\s*(-?[\d.]+),\s*(-?[\d.]+),\s*)([^)]*?)(\s*)\)/g;

function backfill(relPath, minRows) {
  const path = join(root, relPath);
  const src = readFileSync(path, 'utf8');
  let rows = 0;
  let hits = 0;
  const misses = [];
  const out = src.replace(CALL_RE, (whole, head, _q1, id, _q2, name, _q3, _country, lat, lon, tail, gap) => {
    rows++;
    // Drop a population already on the end, so re-running is idempotent.
    const args = tail.replace(/,\s*\d+\s*$/, '');
    const pop = populationOf({ name, lat: Number(lat), lon: Number(lon) });
    if (pop === null) {
      misses.push(`${id} (${name})`);
      return `${head}${args}${gap})`;
    }
    hits++;
    return `${head}${args}, ${pop}${gap})`;
  });
  if (rows < minRows) throw new Error(`${relPath}: matched only ${rows} rows — the call shape drifted`);
  writeFileSync(path, out);
  console.log(`${relPath}: ${hits}/${rows} resolved`);
  if (misses.length > 0) {
    console.log(`  no GeoNames settlement within ${MATCH_KM} km of ${misses.length}:`);
    for (const m of misses) console.log(`    ${m}`);
  }
}

backfill('src/data/locations.ts', 250);
backfill('src/data/cities.ts', 2000);
