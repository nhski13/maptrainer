/**
 * Which country a point lands in, resolved against the same 110m Natural Earth
 * polygons the globe draws.
 *
 * Comparing a guess to the answer goes id-to-id rather than by name, on
 * purpose: our location list and Natural Earth disagree about plenty of
 * spellings ("United States" vs "United States of America"), and a name
 * mismatch would fire a "wrong country" toast on a perfectly good guess. Two
 * ids drawn from one dataset can only differ when the countries really do.
 *
 * The 110m set has 177 countries — the microstates (Singapore, Malta, Monaco,
 * Vatican) have no polygon at this resolution. Callers get `null` there, same
 * as for open ocean, and are expected to stay quiet rather than guess.
 */
import { geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import worldData from 'world-atlas/countries-110m.json';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { LatLon } from './geo';

const world = worldData as unknown as Topology<{ countries: GeometryCollection }>;
const countries = feature(world, world.objects.countries).features;

/**
 * Natural Earth abbreviates names to fit them inside map outlines, and carries
 * a couple that have since been renamed. A toast is a sentence, so spell them
 * out — including the definite article, which English insists on for a
 * handful of them ("this is the Netherlands", not "this is Netherlands").
 */
const DISPLAY_NAME: Record<string, string> = {
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Central African Rep.': 'the Central African Republic',
  Congo: 'the Republic of the Congo',
  'Dem. Rep. Congo': 'the Democratic Republic of the Congo',
  'Dominican Rep.': 'the Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea',
  eSwatini: 'Eswatini',
  'Falkland Is.': 'the Falkland Islands',
  'Fr. S. Antarctic Lands': 'the French Southern and Antarctic Lands',
  Macedonia: 'North Macedonia',
  'N. Cyprus': 'Northern Cyprus',
  'S. Sudan': 'South Sudan',
  'Solomon Is.': 'the Solomon Islands',
  'United States of America': 'the United States',
  'W. Sahara': 'Western Sahara',
};

/** Countries whose plain Natural Earth name still wants a "the" in front. */
const TAKES_ARTICLE = new Set([
  'Bahamas',
  'Gambia',
  'Netherlands',
  'Philippines',
  'United Arab Emirates',
  'United Kingdom',
]);

export interface Country {
  /** Numeric ISO 3166-1 code, as carried by the topology. */
  id: string;
  /** Ready to drop into a sentence, article included where one is needed. */
  name: string;
}

/** The country containing `p`, or null for ocean and sub-110m territories. */
export function countryAt(p: LatLon): Country | null {
  for (const f of countries) {
    if (geoContains(f, [p.lon, p.lat])) {
      const raw = String((f.properties as { name?: string })?.name ?? '');
      if (!raw) return null;
      return {
        id: String(f.id ?? raw),
        name: DISPLAY_NAME[raw] ?? (TAKES_ARTICLE.has(raw) ? `the ${raw}` : raw),
      };
    }
  }
  return null;
}

/**
 * The country a guess landed in, when that is demonstrably not the country the
 * answer is in. Null means "no story worth telling": no guess, open ocean, a
 * target too small to have a polygon, or a guess in the right country.
 */
export function misplacedCountry(guess: LatLon | null, target: LatLon): string | null {
  if (!guess) return null;
  const answer = countryAt(target);
  const tapped = countryAt(guess);
  if (!answer || !tapped || answer.id === tapped.id) return null;
  return tapped.name;
}
