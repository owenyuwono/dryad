// =============================================================================
// colorRamp.js — single source of truth for the pigment → [r,g,b] color ramp.
//
// Matches the shader pigment ramp and genome.js speciesColor anchors exactly.
// Pure ESM, no three.js dependency.
// =============================================================================

/**
 * Ramp anchor table: [t, r, g, b] (r/g/b in 0..255).
 * Exported so shaders and tests can validate against the same constants.
 */
export const RAMP_ANCHORS = Object.freeze([
  [0.00,  46, 166, 140],   // teal
  [0.45,  71, 158,  46],   // green
  [0.70, 133, 153,  20],   // olive
  [1.00, 184, 107,  15],   // warm gold
]);

/**
 * pigmentToColor(pigment) -> [r, g, b]  — values in [0, 1].
 *
 * Piecewise-linear interpolation over RAMP_ANCHORS.
 * pigment is clamped to [0, 1] before lookup.
 */
export function pigmentToColor(pigment) {
  const p = pigment < 0 ? 0 : pigment > 1 ? 1 : pigment;

  // Find the two anchors that bracket p.
  let lo = RAMP_ANCHORS[0];
  let hi = RAMP_ANCHORS[RAMP_ANCHORS.length - 1];
  for (let i = 0; i < RAMP_ANCHORS.length - 1; i++) {
    if (p >= RAMP_ANCHORS[i][0] && p <= RAMP_ANCHORS[i + 1][0]) {
      lo = RAMP_ANCHORS[i];
      hi = RAMP_ANCHORS[i + 1];
      break;
    }
  }

  const span = hi[0] - lo[0];
  const t = span < 1e-10 ? 0 : (p - lo[0]) / span;

  return [
    (lo[1] + t * (hi[1] - lo[1])) / 255,
    (lo[2] + t * (hi[2] - lo[2])) / 255,
    (lo[3] + t * (hi[3] - lo[3])) / 255,
  ];
}
