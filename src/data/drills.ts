import type { Location } from './types';
import { LOCATIONS } from './locations';

export interface Drill {
  id: string;
  label: string;
  /** When true, the prompt reads "Capital of X" to train capital recall. */
  askByCountry?: boolean;
  filter: (l: Location) => boolean;
}

export const DRILLS: Drill[] = [
  { id: 'everything', label: 'Everything', filter: () => true },
  {
    id: 'world-capitals',
    label: 'World Capitals',
    askByCountry: true,
    filter: (l) => l.tags.includes('capital'),
  },
  { id: 'major-cities', label: 'Major Cities', filter: (l) => l.tags.includes('city') },
  { id: 'us-states', label: 'US State Capitals', filter: (l) => l.tags.includes('us-state') },
  { id: 'europe', label: 'Europe', filter: (l) => l.continent === 'europe' },
  { id: 'asia', label: 'Asia', filter: (l) => l.continent === 'asia' },
  { id: 'africa', label: 'Africa', filter: (l) => l.continent === 'africa' },
  {
    id: 'americas',
    label: 'Americas',
    filter: (l) => l.continent === 'north-america' || l.continent === 'south-america',
  },
  { id: 'oceania', label: 'Oceania & Islands', filter: (l) => l.continent === 'oceania' || l.tags.includes('island') },
  { id: 'deep-cuts', label: 'Deep Cuts (Tier 3)', filter: (l) => l.tier === 3 },
  { id: 'micro', label: 'Micronations & Tiny Targets', filter: (l) => l.tags.includes('micro') },
];

export function drillPool(drill: Drill): Location[] {
  return LOCATIONS.filter(drill.filter);
}
