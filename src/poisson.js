// =============================================================================
// poisson.js — Poisson-disk (blue-noise) sampling, Bridson 2007.
//
// PURE + deterministic (no three.js, no DOM) → Node-testable. Used by the forest
// preview to scatter trees with natural, non-clumped, non-gridded spacing.
// =============================================================================

/**
 * poissonDisk({ width, height, minDist, rng, k, maxPoints }) -> [{x,y}, ...]
 *
 * Returns points in [0,width]x[0,height] whose pairwise distance is >= minDist.
 * Deterministic for a given rng() (pass a seeded mulberry32). k = candidate tries
 * per active point (Bridson default 30). maxPoints caps the count (Infinity = all).
 */
export function poissonDisk({ width, height, minDist, rng, k = 30, maxPoints = Infinity }) {
  if (!(minDist > 0) || !(width > 0) || !(height > 0) || typeof rng !== 'function') return [];
  if (maxPoints <= 0) return [];

  const cell = minDist / Math.SQRT2;
  const gw = Math.max(1, Math.ceil(width / cell));
  const gh = Math.max(1, Math.ceil(height / cell));
  const grid = new Int32Array(gw * gh).fill(-1);   // grid cell -> point index, -1 empty
  const pts = [];
  const active = [];
  const r2 = minDist * minDist;

  const cellOf = (x, y) => Math.floor(y / cell) * gw + Math.floor(x / cell);

  function fits(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let jy = Math.max(0, cy - 2); jy <= Math.min(gh - 1, cy + 2); jy++) {
      for (let jx = Math.max(0, cx - 2); jx <= Math.min(gw - 1, cx + 2); jx++) {
        const pi = grid[jy * gw + jx];
        if (pi < 0) continue;
        const dx = pts[pi].x - x, dy = pts[pi].y - y;
        if (dx * dx + dy * dy < r2) return false;
      }
    }
    return true;
  }
  function add(x, y) {
    const i = pts.length;
    pts.push({ x, y });
    grid[cellOf(x, y)] = i;
    active.push(i);
  }

  add(rng() * width, rng() * height);
  while (active.length && pts.length < maxPoints) {
    const ai = Math.floor(rng() * active.length);
    const p = pts[active[ai]];
    let placed = false;
    for (let t = 0; t < k; t++) {
      const ang = rng() * Math.PI * 2;
      const rad = minDist * (1 + rng());      // annulus [minDist, 2*minDist]
      const nx = p.x + Math.cos(ang) * rad;
      const ny = p.y + Math.sin(ang) * rad;
      if (fits(nx, ny)) {
        add(nx, ny);
        placed = true;
        if (pts.length >= maxPoints) break;
      }
    }
    if (!placed) active.splice(ai, 1);
  }
  return pts;
}
