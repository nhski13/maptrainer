# Changelog

## 1.1.0 — 2026-08-12

- **Satellite globe**: NASA Blue Marble imagery (public domain, bundled —
  still zero external requests) reprojected onto the orthographic sphere in a
  WebGL fragment shader, with limb shading and vector country borders overlaid.
  Falls back to the flat vector style if WebGL is unavailable.
- **Sound effects**: synthesized via Web Audio (no audio assets) — rising
  fanfare for bullseyes, sad trombone for wrong-hemisphere disasters, tiers in
  between. Mute toggle in the top bar, persisted.
- **Trash-talk engine**: 35+ tiered quips on every reveal ("We don't geoshame
  here. But man, that's bad.") plus grade-specific lines on the results screen.

## 1.0.0 — 2026-08-11

Initial release.

- Canvas-rendered rotatable 3D globe (orthographic) with drag, scroll/pinch
  zoom, and tap-to-pin — the MapTap.gg interaction model.
- Four modes: Classic (5 rounds), Blitz (20 s rounds), Survival (shrinking
  clock, 3 lives), and Drill (10 rounds, weakness-weighted).
- 300-location corpus: 194 world capitals, 56 major cities, all 50 US state
  capitals, tiered by difficulty.
- MapTap-style distance scoring: 100 inside 15 km, exponential decay after.
- Spaced-repetition weak-spot engine with per-location EMAs, staleness
  weighting, and exploration bonus for unseen locations.
- Stats dashboard: per-continent skill, weakest-10 table, session history,
  daily training streak.
- 34-test vitest suite covering geodesy, scoring, SRS, session logic, and
  dataset integrity (unique ids, valid coordinates, 50-state coverage).
- GitHub Pages deploy workflow.
