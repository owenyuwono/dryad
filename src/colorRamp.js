// =============================================================================
// colorRamp.js — single source of truth for the pigment → [r,g,b] color ramp.
//
// pigment ∈ [0,1] maps the full HSL hue wheel (0→360°) with foliage-sensible
// saturation and lightness so leaves read as saturated at any hue.
//
// Pure ESM, no three.js dependency.
// =============================================================================

/**
 * HSL to RGB conversion.
 * h in [0,1] (0=red, 1/3=green, 2/3=blue), s and l in [0,1].
 * Returns [r, g, b] each in [0,1].
 */
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  function f(n) {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  }
  return [f(0), f(8), f(4)];
}

/**
 * pigmentToColor(pigment) -> [r, g, b]  — values in [0, 1].
 *
 * Full hue sweep: pigment 0→1 maps hue 0°→360° (full color wheel).
 * Saturation: 0.55 — vivid but not over-saturated.
 * Lightness:  0.42 — dark enough to read as foliage, bright enough at any hue.
 *
 * pigment is clamped to [0, 1] before lookup.
 */
export function pigmentToColor(pigment) {
  const p = pigment < 0 ? 0 : pigment > 1 ? 1 : pigment;
  return hslToRgb(p, 0.55, 0.42);
}
