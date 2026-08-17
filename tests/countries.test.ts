import { describe, it, expect } from 'vitest';
import { countryAt, misplacedCountry } from '../src/core/countries';
import { LOCATIONS } from '../src/data/locations';

const TEHRAN = { lat: 35.6892, lon: 51.389 };
const ASHGABAT = { lat: 37.9601, lon: 58.3261 };
const MID_PACIFIC = { lat: 0, lon: -150 };

describe('countryAt', () => {
  it('resolves a point to its country', () => {
    expect(countryAt(TEHRAN)?.name).toBe('Iran');
    expect(countryAt(ASHGABAT)?.name).toBe('Turkmenistan');
  });

  it('returns null over open ocean', () => {
    expect(countryAt(MID_PACIFIC)).toBeNull();
  });

  it('spells out the abbreviated and article-taking names', () => {
    expect(countryAt({ lat: 39.0, lon: -98.5 })?.name).toBe('the United States');
    expect(countryAt({ lat: 52.1, lon: 5.3 })?.name).toBe('the Netherlands');
    expect(countryAt({ lat: 43.9, lon: 17.7 })?.name).toBe('Bosnia and Herzegovina');
  });
});

describe('misplacedCountry', () => {
  it('names the country a wrong guess landed in', () => {
    expect(misplacedCountry(ASHGABAT, TEHRAN)).toBe('Turkmenistan');
  });

  it('stays quiet when the guess is in the right country', () => {
    // Isfahan is 340 km from Tehran — a big miss, but still Iran.
    expect(misplacedCountry({ lat: 32.65, lon: 51.67 }, TEHRAN)).toBeNull();
  });

  it('stays quiet with no guess, or over water', () => {
    expect(misplacedCountry(null, TEHRAN)).toBeNull();
    expect(misplacedCountry(MID_PACIFIC, TEHRAN)).toBeNull();
  });

  it('stays quiet when the target is too small for the 110m outlines', () => {
    // Singapore has no polygon at this resolution — no polygon, no verdict.
    expect(misplacedCountry({ lat: 3.14, lon: 101.69 }, { lat: 1.3521, lon: 103.8198 })).toBeNull();
  });

  it('never calls a location wrong against its own coordinates', () => {
    for (const l of LOCATIONS) {
      expect(misplacedCountry({ lat: l.lat, lon: l.lon }, { lat: l.lat, lon: l.lon })).toBeNull();
    }
  });
});
