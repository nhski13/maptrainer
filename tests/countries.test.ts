import { describe, it, expect } from 'vitest';
import { COUNTRY_PACKS, PACK_CITIES } from '../src/data/cities';
import {
  ALL_LOCATIONS,
  packByCode,
  packCities,
  packsByContinent,
  searchPacks,
} from '../src/data/countries';
import { LOCATIONS } from '../src/data/locations';
import { haversineKm } from '../src/core/geo';

const pack = (code: string) => packByCode.get(code)!;

describe('country pack dataset', () => {
  it('covers a broad set of countries', () => {
    expect(COUNTRY_PACKS.length).toBeGreaterThanOrEqual(100);
  });

  it('gives every pack a workable number of cities, never more than the cap', () => {
    for (const p of COUNTRY_PACKS) {
      const cities = packCities(p);
      expect(cities.length, p.code).toBeGreaterThanOrEqual(10);
      // 25 ranked, plus at most a capital that population alone would have cut.
      expect(cities.length, p.code).toBeLessThanOrEqual(26);
    }
  });

  it('resolves every ranked id', () => {
    const known = new Set(ALL_LOCATIONS.map((l) => l.id));
    for (const p of COUNTRY_PACKS) {
      for (const id of p.ranked) expect(known.has(id), `${p.code} → ${id}`).toBe(true);
      expect(new Set(p.ranked).size, p.code).toBe(p.ranked.length);
    }
  });

  it('has unique ids across the whole corpus', () => {
    const ids = ALL_LOCATIONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never duplicates a curated location as a pack city', () => {
    // A pack city sitting on top of a corpus entry would split one place's
    // spaced-repetition history in two. Collected rather than asserted
    // in-loop: this is 700k pairs, and one expect() each takes seconds.
    const collisions: string[] = [];
    for (const city of PACK_CITIES) {
      for (const loc of LOCATIONS) {
        if (haversineKm(city, loc) <= 1) collisions.push(`${city.id} vs ${loc.id}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('keeps the cities of a pack far enough apart to be separate questions', () => {
    // The scoring bullseye is 15 km; two targets closer than that are one tap.
    const tooClose: string[] = [];
    for (const p of COUNTRY_PACKS) {
      const cities = packCities(p);
      for (let i = 0; i < cities.length; i++) {
        for (let j = i + 1; j < cities.length; j++) {
          const d = haversineKm(cities[i], cities[j]);
          if (d <= 15) tooClose.push(`${p.code}: ${cities[i].id} vs ${cities[j].id}`);
        }
      }
    }
    expect(tooClose).toEqual([]);
  });

  it('files every city under its pack’s own country name', () => {
    for (const p of COUNTRY_PACKS) {
      for (const city of packCities(p)) {
        // US state capitals carry their state ("Alabama, USA"), so they are
        // matched on the suffix rather than the whole string.
        const ok = city.country === p.name || (p.code === 'US' && city.country.endsWith('USA'));
        expect(ok, `${p.code}: ${city.id} is "${city.country}"`).toBe(true);
      }
    }
  });

  it('has valid coordinates and tiers throughout', () => {
    for (const c of PACK_CITIES) {
      expect(c.lat, c.id).toBeGreaterThanOrEqual(-90);
      expect(c.lat, c.id).toBeLessThanOrEqual(90);
      expect(c.lon, c.id).toBeGreaterThanOrEqual(-180);
      expect(c.lon, c.id).toBeLessThanOrEqual(180);
      expect([1, 2, 3], c.id).toContain(c.tier);
    }
  });

  it('spot-checks pack coordinates against known cities', () => {
    const at = (id: string) => PACK_CITIES.find((c) => c.id === id)!;
    expect(haversineKm(at('chennai-in'), { lat: 13.0827, lon: 80.2707 })).toBeLessThan(15);
    expect(haversineKm(at('yokohama-jp'), { lat: 35.4437, lon: 139.638 })).toBeLessThan(15);
    expect(haversineKm(at('houston-us'), { lat: 29.7604, lon: -95.3698 })).toBeLessThan(15);
    expect(haversineKm(at('glasgow-gb'), { lat: 55.8617, lon: -4.2583 })).toBeLessThan(15);
  });
});

describe('pack ordering', () => {
  it('leads India with Mumbai and reuses the curated entries', () => {
    const cities = packCities(pack('IN'));
    expect(cities[0].name).toBe('Mumbai');
    expect(cities.map((c) => c.id)).toContain('new-delhi'); // not a second Delhi
  });

  it('trims to a limit but never drops the capital', () => {
    for (const code of ['AU', 'CI', 'US', 'IN']) {
      const short = packCities(pack(code), 5);
      expect(short.length).toBeLessThanOrEqual(6);
      expect(short.some((c) => c.tags.includes('capital')), code).toBe(true);
    }
  });

  it('returns the whole pack when the limit exceeds it', () => {
    const p = pack('IE');
    expect(packCities(p, 100)).toEqual(packCities(p));
  });
});

describe('country lookup', () => {
  it('finds countries by prefix, ahead of mid-word matches', () => {
    expect(searchPacks('ind')[0].code).toBe('IN');
    expect(searchPacks('united').map((p) => p.code)).toContain('GB');
  });

  it('ignores accents and case', () => {
    expect(searchPacks('cote').map((p) => p.code)).toContain('CI');
    expect(searchPacks('JAPAN').map((p) => p.code)).toContain('JP');
  });

  it('matches an ISO code exactly', () => {
    expect(searchPacks('br').map((p) => p.code)).toContain('BR');
  });

  it('returns nothing for an empty query', () => {
    expect(searchPacks('   ')).toEqual([]);
  });

  it('groups packs by continent without losing any', () => {
    const grouped = (
      ['europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania'] as const
    ).flatMap((c) => packsByContinent(c));
    expect(grouped.length).toBe(COUNTRY_PACKS.length);
  });
});
