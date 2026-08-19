export type Continent =
  | 'europe'
  | 'asia'
  | 'africa'
  | 'north-america'
  | 'south-america'
  | 'oceania';

/** 1 = famous, 2 = solid geography knowledge, 3 = deep-cut. */
export type Tier = 1 | 2 | 3;

export type Tag = 'capital' | 'city' | 'us-state' | 'island' | 'micro';

export interface Location {
  /** Stable id used as the spaced-repetition key. Never change existing ids. */
  id: string;
  /** What the player must find, e.g. "Tokyo". */
  name: string;
  /** Country (or "USA" for states). */
  country: string;
  lat: number;
  lon: number;
  tier: Tier;
  continent: Continent;
  tags: Tag[];
  /**
   * City population, from GeoNames — the city itself, not its metro area.
   * Optional because a handful of the remoter entries have no figure in any
   * gazetteer, and a made-up number would be worse than a missing one.
   */
  pop?: number;
}
