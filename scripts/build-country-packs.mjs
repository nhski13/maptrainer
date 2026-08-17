/**
 * Regenerates src/data/cities.ts — the country training packs.
 *
 *   npm i --no-save all-the-cities city-timezones countries-list
 *   node scripts/build-country-packs.mjs
 *
 * Two independent open datasets go in, and a city only comes out if both
 * agree:
 *
 *   • SimpleMaps World Cities Basic (CC BY 4.0) — via the `city-timezones`
 *     package. Supplies the coordinates, the country, and the population that
 *     sets the ranking. Measured against the hand-curated corpus in
 *     locations.ts, its coordinates land a mean 2.7 km from ours.
 *   • GeoNames (CC BY 4.0) — via the `all-the-cities` package. Confirms the
 *     coordinates, and supplies the name.
 *
 * The cross-check is not ceremony. A candidate only ships if GeoNames also
 * puts a settlement at those coordinates — either one whose name agrees, or
 * one of comparable size. Population figures in gazetteers are sometimes
 * district totals pinned to a village that happens to share the city's name,
 * which lands a "city" hundreds of kilometres from where the app would teach
 * you it is; that is the one failure a training app cannot have.
 *
 * The name comes from GeoNames because SimpleMaps carries typos and
 * pre-rename spellings (Shenyeng, Nasik, Ft. Worth). Transliteration marks
 * are stripped from it — a player reads Surat, not Sūrat — but ordinary Latin
 * accents are left alone, so São Paulo and Zürich keep theirs.
 *
 * Cities within DEDUPE_KM of a higher-ranked one are folded away. On a globe
 * scored with a 15 km bullseye, a satellite town that close is not a separate
 * question — it is the same tap.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A candidate must be confirmed by the other dataset within this radius. */
const CONFIRM_KM = 25;
/**
 * Confirmation by size, when the two gazetteers spell the place differently:
 * a GeoNames city at least this fraction of the candidate's population sitting
 * within CONFIRM_KM is the same city under another name.
 */
const CONFIRM_POP_RATIO = 0.2;
/** Folded names this many edits apart are the same name, differently spelled. */
const NAME_EDIT_SLACK = 3;
/** Cities closer than this to a higher-ranked one are the same target. */
const DEDUPE_KM = 25;
/** Cities per pack. "Top 25" is the unit the mode is built around. */
const PACK_SIZE = 25;
/** Countries thinner than this don't make an interesting pack. */
const MIN_PACK = 10;

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

// ── names ─────────────────────────────────────────────────────────────
/** Comparison form: accent-free, punctuation-free, lowercase. */
const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Macron, breve, and the dots and bars below — the marks romanization adds to
 * non-Latin scripts, and the only ones no Latin-script language spells with.
 * Acutes, umlauts, tildes and cedillas survive, so Bogotá stays Bogotá.
 */
const TRANSLITERATION_MARKS = /[̣̤̮̰̱̄̆̇]/g;
const deromanize = (s) => s.normalize('NFD').replace(TRANSLITERATION_MARKS, '').normalize('NFC');

/** Levenshtein distance, capped — only used to ask "within a few edits?". */
function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, row[j]);
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Two spellings of one place: identical, one a substantial prefix of the other
 * ("New York" / "New York City"), or a few edits apart ("Shenyeng" /
 * "Shenyang"). The slack scales with length, because one edit is the whole
 * difference between Man and San but nothing at all between two ten-letter
 * romanizations. Callers only ever ask this about places already known to be
 * within CONFIRM_KM of each other, which is what keeps it honest.
 */
function sameName(a, b) {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 5 && long.startsWith(short) && short.length / long.length >= 0.6) return true;
  const cap = Math.min(NAME_EDIT_SLACK, Math.floor(short.length / 3));
  return cap > 0 && editDistance(a, b, cap) <= cap;
}

// ── the existing hand-curated corpus ──────────────────────────────────
// Parsed rather than imported: this script is plain ESM and locations.ts is
// TypeScript. The L(...) call shape there is fixed, so a regex is honest.
const LOC_RE =
  /L\(\s*(['"])(.*?)\1,\s*(['"])(.*?)\3,\s*(['"])(.*?)\5,\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(\d),\s*'([a-z-]+)',\s*\[(.*?)\]\s*\)/g;

function readLocations() {
  const src = readFileSync(join(root, 'src/data/locations.ts'), 'utf8');
  const out = [];
  for (const m of src.matchAll(LOC_RE)) {
    out.push({
      id: m[2],
      name: m[4],
      country: m[6],
      lat: Number(m[7]),
      lon: Number(m[8]),
      tier: Number(m[9]),
      continent: m[10],
      tags: [...m[11].matchAll(/'([a-z-]+)'/g)].map((t) => t[1]),
    });
  }
  if (out.length < 200) throw new Error(`parsed only ${out.length} locations — regex drifted`);
  return out;
}

// ── sources ───────────────────────────────────────────────────────────
const simplemaps = require('city-timezones').cityMapping.filter(
  (c) => c.iso2 && c.pop > 0 && Number.isFinite(c.lat) && Number.isFinite(c.lng),
);
const geonames = require('all-the-cities');
const { countries: countryMeta } = require('countries-list');

/**
 * GeoNames bucketed onto a 1° grid, so confirming a candidate reads a handful
 * of cells instead of walking 135,000 rows.
 */
const geoGrid = new Map();
const cell = (lat, lon) => `${Math.floor(lat)}|${Math.floor(lon)}`;
for (const g of geonames) {
  const lon = g.loc.coordinates[0];
  const lat = g.loc.coordinates[1];
  const key = cell(lat, lon);
  let bucket = geoGrid.get(key);
  if (!bucket) geoGrid.set(key, (bucket = []));
  bucket.push({ name: g.name, country: g.country, lat, lon, pop: g.population });
}

function geoNear(c) {
  const here = { lat: c.lat, lon: c.lng };
  const out = [];
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      for (const g of geoGrid.get(cell(c.lat + dLat, c.lng + dLon)) ?? []) {
        if (g.country === c.iso2 && km(here, g) <= CONFIRM_KM) out.push(g);
      }
    }
  }
  return out;
}

/**
 * Confirm a candidate against GeoNames and settle on its name.
 *
 * A name match is the strong signal and wins outright. Failing that, a
 * GeoNames city of comparable size at the same coordinates confirms the
 * position — the two gazetteers simply disagree on what to call it, and the
 * larger record's name is the one worth showing.
 */
function resolve(c) {
  const near = geoNear(c);
  if (near.length === 0) return null;
  const wanted = [fold(c.city), fold(c.city_ascii || c.city)];
  const named = near.filter((g) => wanted.some((w) => sameName(w, fold(g.name))));
  if (named.length > 0) {
    return named.reduce((a, b) => (b.pop > a.pop ? b : a)).name;
  }
  const biggest = near.reduce((a, b) => (b.pop > a.pop ? b : a));
  return biggest.pop >= c.pop * CONFIRM_POP_RATIO ? biggest.name : null;
}

const CONTINENT_BY_CODE = {
  EU: 'europe',
  AS: 'asia',
  AF: 'africa',
  NA: 'north-america',
  SA: 'south-america',
  OC: 'oceania',
};

// ── build ─────────────────────────────────────────────────────────────
const locations = readLocations();

/**
 * Which country each existing corpus entry belongs to, resolved by standing
 * it next to the SimpleMaps city nearest it. That keeps the display names in
 * the packs identical to the ones already in locations.ts ("DR Congo", not
 * "Congo (Kinshasa)") without a hand-maintained alias table, and it files the
 * US state capitals under the United States, which their `country` string
 * ("Alabama, USA") does not say.
 */
function isoForLocation(loc) {
  let best = null;
  let bestKm = Infinity;
  for (const c of simplemaps) {
    const d = km(loc, { lat: c.lat, lon: c.lng });
    if (d < bestKm) {
      bestKm = d;
      best = c;
    }
  }
  return bestKm <= CONFIRM_KM ? best.iso2 : null;
}

const isoOf = new Map(); // location id → ISO 3166-1 alpha-2
for (const loc of locations) {
  const iso = isoForLocation(loc);
  if (iso) isoOf.set(loc.id, iso);
}

/** Display name and continent for a country, preferring the corpus's own. */
function countryIdentity(iso) {
  const capital = locations.find(
    (l) => isoOf.get(l.id) === iso && l.tags.includes('capital'),
  );
  if (capital) return { name: capital.country, continent: capital.continent };
  const meta = countryMeta[iso];
  const continent = CONTINENT_BY_CODE[meta?.continent];
  if (!meta || !continent) return null;
  return { name: meta.name, continent };
}

const byIso = new Map();
for (const c of simplemaps) {
  const name = resolve(c);
  if (!name) continue;
  let list = byIso.get(c.iso2);
  if (!list) byIso.set(c.iso2, (list = []));
  list.push({ ...c, resolvedName: deromanize(name) });
}

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const usedIds = new Set(locations.map((l) => l.id));
const packCities = [];
const packs = [];

for (const [iso, candidates] of [...byIso].sort((a, b) => a[0].localeCompare(b[0]))) {
  const identity = countryIdentity(iso);
  if (!identity) continue;

  const corpus = locations.filter((l) => isoOf.get(l.id) === iso);
  candidates.sort((a, b) => b.pop - a.pop);

  const taken = []; // {lat, lon} of everything already in the pack
  const ranked = []; // ids, most populous first
  const fresh = []; // pack-only cities, in the order they were emitted

  for (const c of candidates) {
    if (ranked.length >= PACK_SIZE) break;
    const here = { lat: c.lat, lon: c.lng };
    if (taken.some((t) => km(here, t) < DEDUPE_KM)) continue;

    // Already hand-curated? Then this rank belongs to the existing entry —
    // its id carries the player's spaced-repetition history.
    const existing = corpus.find((l) => km(here, l) < DEDUPE_KM);
    if (existing) {
      taken.push(existing);
      ranked.push(existing.id);
      continue;
    }

    const stem = `${slug(c.resolvedName)}-${iso.toLowerCase()}`;
    let id = stem;
    for (let n = 2; usedIds.has(id); n++) id = `${stem}-${n}`;
    usedIds.add(id);

    const tier = c.pop >= 2_000_000 ? 1 : c.pop >= 400_000 ? 2 : 3;
    const city = {
      id,
      name: c.resolvedName,
      country: identity.name,
      lat: Number(c.lat.toFixed(3)),
      lon: Number(c.lng.toFixed(3)),
      tier,
      continent: identity.continent,
    };
    taken.push(here);
    ranked.push(id);
    fresh.push(city);
  }

  if (ranked.length < MIN_PACK) continue;

  // A capital is the one city everyone expects to find in its country's pack,
  // so it goes in even when population alone would leave it out — Canberra,
  // Abuja and Yamoussoukro are the whole reason this rule exists.
  const capital = corpus.find((l) => l.tags.includes('capital'));
  if (capital && !ranked.includes(capital.id)) ranked.push(capital.id);

  packCities.push(...fresh);
  packs.push({ code: iso, ...identity, ranked });
}

// ── emit ──────────────────────────────────────────────────────────────
const q = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

const cityLines = packCities
  .map(
    (c) =>
      `  C(${q(c.id)}, ${q(c.name)}, ${q(c.country)}, ${c.lat}, ${c.lon}, ${c.tier}, '${c.continent}'),`,
  )
  .join('\n');

const packLines = packs
  .map((p) => {
    const ids = p.ranked.map(q).join(', ');
    const wrapped =
      ids.length <= 88
        ? `[${ids}]`
        : `[\n${p.ranked.map((id) => `    ${q(id)},`).join('\n')}\n  ]`;
    return `  P('${p.code}', ${q(p.name)}, '${p.continent}', ${wrapped}),`;
  })
  .join('\n');

const totalRanked = packs.reduce((n, p) => n + p.ranked.length, 0);

const out = `import type { Location } from './types';

/**
 * Country training packs: the top ${PACK_SIZE} cities of each country, ranked by
 * population, plus the capital whenever population alone would leave it out.
 *
 * GENERATED FILE — do not edit by hand. Rebuild with:
 *   npm i --no-save all-the-cities city-timezones countries-list
 *   node scripts/build-country-packs.mjs
 *
 * ${packs.length} countries · ${totalRanked} ranked cities · ${packCities.length} new to the corpus.
 *
 * Sources, both CC BY 4.0: coordinates and populations come from SimpleMaps
 * World Cities Basic, names from GeoNames. Every city here was confirmed by
 * both — GeoNames had to place a settlement of the same name, or of
 * comparable size, within ${CONFIRM_KM} km of the SimpleMaps coordinates — and
 * candidates that failed were dropped rather than guessed at. Cities within
 * ${DEDUPE_KM} km of a higher-ranked one are folded away: closer than the scoring
 * bullseye is not a separate question.
 *
 * Ids in \`ranked\` may point at either of two places: entries already in
 * locations.ts (referenced by their existing id, so the player's history for
 * Mumbai stays Mumbai's) or the cities defined below. Resolve them through
 * countries.ts rather than assuming.
 */

const C = (
  id: string,
  name: string,
  country: string,
  lat: number,
  lon: number,
  tier: Location['tier'],
  continent: Location['continent'],
): Location => ({ id, name, country, lat, lon, tier, continent, tags: ['city'] });

/** Cities that exist only for country packs — the long tail below the corpus. */
export const PACK_CITIES: Location[] = [
${cityLines}
];

export interface CountryPack {
  /** ISO 3166-1 alpha-2. */
  code: string;
  /** Display name, identical to the \`country\` field of its locations. */
  name: string;
  continent: Location['continent'];
  /** City ids, most populous first. A trailing id may be an added capital. */
  ranked: string[];
}

const P = (
  code: string,
  name: string,
  continent: Location['continent'],
  ranked: string[],
): CountryPack => ({ code, name, continent, ranked });

export const COUNTRY_PACKS: CountryPack[] = [
${packLines}
];
`;

writeFileSync(join(root, 'src/data/cities.ts'), out);
console.log(
  `${packs.length} packs · ${totalRanked} ranked cities · ${packCities.length} new entries`,
);
