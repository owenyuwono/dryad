// =============================================================================
// STAGE 1 — PlanetEnvelope struct (the physics context for life)
// =============================================================================
// { gravity: 0.1–3.0, medium: 'air'|'water'|'dense_air',
//   energy: 'predation'|'photo'|'chemo', biochem: 'carbon'|'silicon',
//   light: [0,1] default 0.6 — phototrophic light flux; 0 = dim world, 1 = bright world. Drives leaf area & tier count.
//   sunAngle: [0,1] default 0.25 — sun elevation; 0 = overhead, 1 = low/oblique on the horizon. Drives lightDir + phototropic lean.
//   wind: [0,1] default 0.2 — ambient wind / fluid drag severity; 0 = calm, 1 = strong. Drives plant height, sturdiness & streamlining.
//   aridity: [0,1] default 0.35 — dryness; 0 = lush/wet, 1 = arid. Drives succulence. }
// This is just a plain object — the UI builds and mutates it.
//
// FLORA PHASE: energy is locked to 'photo' and biochem to 'carbon'. Silicon
// biochem and fauna energy modes (predation/chemo) are parked until a later phase.
