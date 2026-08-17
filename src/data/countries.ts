/**
 * Country training: resolving a pack into the cities you actually play.
 *
 * A pack in cities.ts is a ranked list of ids, not of locations, because the
 * two corpora overlap. Mumbai was already hand-curated in locations.ts long
 * before the packs existed, so India's pack points at `mumbai` rather than
 * carrying a second copy — one id, one spaced-repetition history, whichever
 * mode you meet the city in.
 */
import type { Location } from './types';
import { LOCATIONS } from './locations';
import { COUNTRY_PACKS, PACK_CITIES, type CountryPack } from './cities';

export { COUNTRY_PACKS, type CountryPack };

/** Everything the app can ask you to find: the curated corpus plus the packs. */
export const ALL_LOCATIONS: Location[] = [...LOCATIONS, ...PACK_CITIES];

const locationById = new Map(ALL_LOCATIONS.map((l) => [l.id, l]));

export const packByCode = new Map(COUNTRY_PACKS.map((p) => [p.code, p]));

/**
 * A pack's cities, most populous first — the order the quiz plays them in,
 * which makes the run ramp from the ones everyone knows to the ones that
 * separate a geographer from a tourist.
 *
 * `limit` trims the tail, but never the capital: a top-10 of India that
 * dropped New Delhi would be a strange thing to hand someone.
 */
export function packCities(pack: CountryPack, limit = Infinity): Location[] {
  const all = pack.ranked.map((id) => locationById.get(id)).filter((l): l is Location => !!l);
  if (all.length <= limit) return all;
  const kept = all.slice(0, limit);
  if (!kept.some((l) => l.tags.includes('capital'))) {
    const capital = all.find((l) => l.tags.includes('capital'));
    if (capital) kept.push(capital);
  }
  return kept;
}

/** Packs for a continent, alphabetical — how the picker is laid out. */
export function packsByContinent(continent: Location['continent']): CountryPack[] {
  return COUNTRY_PACKS.filter((p) => p.continent === continent).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

const searchable = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Country search. Accent-blind, so "cote" finds Côte d'Ivoire, and
 * prefix matches sort above mid-word ones so "ind" leads with India rather
 * than burying it under British Indian Ocean spellings.
 */
export function searchPacks(query: string): CountryPack[] {
  const q = searchable(query.trim());
  if (!q) return [];
  const hits: { pack: CountryPack; rank: number }[] = [];
  for (const pack of COUNTRY_PACKS) {
    const name = searchable(pack.name);
    if (name.startsWith(q)) hits.push({ pack, rank: 0 });
    else if (name.includes(q)) hits.push({ pack, rank: 1 });
    else if (searchable(pack.code) === q) hits.push({ pack, rank: 2 });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.pack.name.localeCompare(b.pack.name))
    .map((h) => h.pack);
}
