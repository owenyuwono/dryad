import { pigmentToColor } from './colorRamp.js';
import { mulberry32 } from './rng.js';

// ---------------------------------------------------------------------------
// leafHalfWidth — cubic bezier half-width profile (unchanged).
// ---------------------------------------------------------------------------

export function leafHalfWidth(t, breadth) {
  const A = 0.15 + breadth * 0.35;
  return A * Math.sin(Math.PI * Math.pow(t, 0.68));
}

// ---------------------------------------------------------------------------
// Color helpers — pure math, no DOM.
// ---------------------------------------------------------------------------

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  function f(n) {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  }
  return [f(0), f(8), f(4)];
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

// ---------------------------------------------------------------------------
// Superformula — pure math, Node-safe.
// ---------------------------------------------------------------------------

export function superformulaPoint(theta, params) {
  const { m, n1, n2, n3, a = 1, b = 1 } = params;
  const t = m * theta / 4;
  const cosT = Math.abs(Math.cos(t) / a);
  const sinT = Math.abs(Math.sin(t) / b);
  const inner = Math.pow(cosT, n2) + Math.pow(sinT, n3);
  if (inner === 0) return { x: 0, y: 0 };
  const r = Math.pow(inner, -1 / n1);
  if (!isFinite(r)) return { x: 0, y: 0 };
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

export function superformulaOutline(params, steps = 120) {
  const { axialStretch = 2, serration = 0, serrationFreq = 10, xScale = 1 } = params;

  // 1. Sample raw points
  const raw = [];
  for (let i = 0; i < steps; i++) {
    const theta = (2 * Math.PI * i) / steps;
    const pt = superformulaPoint(theta, params);
    raw.push({ x: pt.x, y: pt.y * axialStretch });
  }

  // 2. Find tip (max y) and base (min y)
  let tipIdx = 0, baseIdx = 0;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].y > raw[tipIdx].y) tipIdx = i;
    if (raw[i].y < raw[baseIdx].y) baseIdx = i;
  }
  const tip = raw[tipIdx];
  const base = raw[baseIdx];

  // 3. Rotate so tip-base axis aligns with +Y (tip up)
  const dx = base.x - tip.x;
  const dy = base.y - tip.y;
  const rotAngle = Math.atan2(dx, dy); // angle to align tip→base with +y
  const cos = Math.cos(rotAngle);
  const sin = Math.sin(rotAngle);
  const rotated = raw.map(p => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }));

  // 4. Find new y extents after rotation
  let minY = Infinity, maxY = -Infinity;
  for (const p of rotated) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // 5. Translate base to y=0, scale so tip is at y=1; apply xScale to width
  const leafLen = maxY - minY;
  if (leafLen === 0) return rotated; // degenerate
  const normalized = rotated.map(p => ({
    x: (p.x / leafLen) * xScale,
    y: (p.y - minY) / leafLen,
  }));

  // 6. Apply serration along outward normals
  if (serration > 0) {
    const N = normalized.length;
    for (let i = 0; i < N; i++) {
      const prev = normalized[(i - 1 + N) % N];
      const next = normalized[(i + 1) % N];
      // outward normal = perpendicular to edge, pointing away from centroid (x=0)
      const edgeDx = next.x - prev.x;
      const edgeDy = next.y - prev.y;
      const len = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
      // Rotate edge 90° for normal
      let nx = -edgeDy / len;
      let ny = edgeDx / len;
      // Ensure outward (away from center x=0)
      if (nx * normalized[i].x < 0) { nx = -nx; ny = -ny; }
      const amp = serration * Math.sin((i * 2 * Math.PI * serrationFreq) / N);
      normalized[i] = { x: normalized[i].x + nx * amp, y: normalized[i].y + ny * amp };
    }
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// pointInPolygon — ray casting, Node-safe.
// ---------------------------------------------------------------------------

export function pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersects =
      ((yi > py) !== (yj > py)) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Space colonization veins — Node-safe.
// ---------------------------------------------------------------------------

export function growVenation(outline, params, rng) {
  const {
    nSources = 80,
    step = 0.04,
    influenceRadius = 0.25,
    killRadius = 0.06,
    maxIter = 300,
  } = params;

  const nodes = [{ x: 0, y: 0, parentIdx: -1, depth: 0 }];
  const edges = [];

  // Bounding box of outline
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // Scatter sources inside outline via rejection sampling
  const sources = [];
  for (let s = 0; s < nSources; s++) {
    let placed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const sx = minX + rng() * (maxX - minX);
      const sy = minY + rng() * (maxY - minY);
      if (pointInPolygon(sx, sy, outline)) {
        sources.push({ x: sx, y: sy });
        placed = true;
        break;
      }
    }
    if (!placed) {
      // fallback: use outline centroid area
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      if (pointInPolygon(cx, cy, outline)) {
        sources.push({ x: cx, y: cy });
      }
    }
  }

  const ir2 = influenceRadius * influenceRadius;
  const kr2 = killRadius * killRadius;

  for (let iter = 0; iter < maxIter; iter++) {
    if (sources.length === 0) break;

    // Accumulate growth directions
    const growDir = nodes.map(() => ({ x: 0, y: 0, count: 0 }));

    for (const src of sources) {
      let bestDist2 = ir2;
      let bestJ = -1;
      for (let j = 0; j < nodes.length; j++) {
        const ddx = src.x - nodes[j].x;
        const ddy = src.y - nodes[j].y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestJ = j;
        }
      }
      if (bestJ >= 0) {
        const ddx = src.x - nodes[bestJ].x;
        const ddy = src.y - nodes[bestJ].y;
        const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        growDir[bestJ].x += ddx / len;
        growDir[bestJ].y += ddy / len;
        growDir[bestJ].count++;
      }
    }

    // Grow new nodes
    const nBefore = nodes.length;
    for (let j = 0; j < nBefore; j++) {
      if (growDir[j].count === 0) continue;
      const len = Math.sqrt(growDir[j].x * growDir[j].x + growDir[j].y * growDir[j].y) || 1;
      const dx = (growDir[j].x / len) * step;
      const dy = (growDir[j].y / len) * step;
      const nx = nodes[j].x + dx;
      const ny = nodes[j].y + dy;
      if (pointInPolygon(nx, ny, outline)) {
        const newIdx = nodes.length;
        nodes.push({ x: nx, y: ny, parentIdx: j, depth: nodes[j].depth + 1 });
        edges.push({ from: j, to: newIdx });
      }
    }

    // Remove killed sources
    for (let si = sources.length - 1; si >= 0; si--) {
      const src = sources[si];
      for (const node of nodes) {
        const ddx = src.x - node.x;
        const ddy = src.y - node.y;
        if (ddx * ddx + ddy * ddy < kr2) {
          sources.splice(si, 1);
          break;
        }
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Leaf cluster shape math — pure, importable in Node without document.
// ---------------------------------------------------------------------------

export function clusterLeafParams(seed, count) {
  const rng = mulberry32(seed);

  const spreadRad = (200 / 180) * Math.PI;
  const step = spreadRad / (count - 1);
  const baseAngle = -spreadRad / 2;

  return Array.from({ length: count }, (_, i) => {
    const jitter = (rng() - 0.5) * (step * 0.35);
    const angle = baseAngle + i * step + jitter;
    const ox = (rng() - 0.5) * 0.32;
    const oy = rng() * 0.14;
    const scale = 0.60 + rng() * 0.40;
    const hueDelta = (rng() - 0.5) * (20 / 360);
    const lightDelta = (rng() - 0.5) * 0.18;
    return { angle, ox, oy, scale, hueDelta, lightDelta };
  });
}

export function clusterLeafCount(seed) {
  const rng = mulberry32(seed ^ 0xDEADBEEF);
  return 5 + Math.floor(rng() * 4);
}

// ---------------------------------------------------------------------------
// Internal helpers for variant params and leaf drawing.
// ---------------------------------------------------------------------------

/**
 * Derive superformula base params from the 5 leaf-shape genes.
 * All genes are [0,1].
 *
 * Gene → param mappings:
 *   leafWidth    → xScale: [0.4, 1.6]  post-normalization x-scale; 0=narrow, 1=broad.
 *                  (width is via xScale applied AFTER y-normalization so it scales
 *                  the whole outline uniformly.)
 *   leafLength   → axialStretch: [1.0, 4.0] at zero lobing; pulled toward 1.1 at full
 *                  lobing so high-lobing leaves are palmate (roughly as wide as long).
 *   leafTip      → n1 base: [0.4, 2.5] — low=pointed/acuminate, high=rounded/obtuse.
 *                  At high leafLobing, n1 is additionally reduced to sharpen lobe tips
 *                  (maple lobes are acute).
 *   leafSerration→ serration: [0, 0.12]; serrationFreq: [6, 18]. At high leafLobing
 *                  the serration amplitude is boosted so lobe edges get maple-like teeth.
 *   leafLobing   → m: [2, 5]  (2 = simple ovate; 5 = palmate)
 *                  n2/n3: ramp from 4 (smooth ovate) → 14 (deep-sinus maple) as lobing rises.
 *                  Deep sinuses emerge because high n2/n3 pull the radial minima (between
 *                  lobes) far toward the origin while the lobe tips stay near r=1.
 *
 * Default (simple ovate): leafLobing=0 → m=2, n2=n3=4, axialStretch driven by leafLength,
 *   serration unmodified — identical to the previous behaviour at leafLobing=0.
 *
 * Maple region: leafLobing=1 → m=5, n2=n3=14, n1 sharper, axialStretch≈1.1 (wide),
 *   serration boosted by ~2×.
 */
export function leafBaseParams(genes) {
  const { leafWidth = 0.5, leafLength = 0.45, leafTip = 0.4, leafSerration = 0, leafLobing = 0 } = genes;

  // Lobe count: 2 (ovate) → 5 (5-lobed palmate maple)
  const m = 2 + leafLobing * 3;

  // Superformula exponents — the key to sinus depth.
  // At leafLobing=0: n2=n3=4 → smooth ovate (unchanged).
  // At leafLobing=1: n2=n3=14 → the superformula cos/sin terms are raised to a high power,
  // which makes the radial minima (inter-lobe valleys) collapse deeply toward the center
  // while the lobe maxima (cos/sin≈1 sectors) stay near r=1.  This gives maple-depth sinuses.
  const n2 = 4 + leafLobing * 10;
  const n3 = 4 + leafLobing * 10;

  // Lobe-tip sharpness.  Base n1 from leafTip gene.  As lobing rises we reduce n1 further
  // (sharper superformula tip) so the individual lobe apices are acute (maple-like pointed).
  // At leafLobing=0 the reduction is 0, so simple leaves are unaffected.
  const n1Base = 0.4 + leafTip * 2.1;            // [0.4, 2.5]
  const n1 = n1Base * (1 - leafLobing * 0.35);   // at full lobing: ×0.65 → sharper lobe tips

  const a = 1.0;
  const b = 1.0;

  // Palmate proportions: a real maple is roughly as wide as long.
  // At leafLobing=0 axialStretch is fully driven by leafLength [1.0,4.0].
  // At leafLobing=1 it is pulled toward 1.1 so the outline is near-circular before xScale.
  const axialStretchBase = 1.0 + leafLength * 3.0;  // [1.0, 4.0]
  const axialStretch = axialStretchBase * (1 - leafLobing * 0.72) + 1.1 * leafLobing * 0.72;

  // Width: unchanged — xScale is the post-normalisation horizontal scale.
  const xScale = 0.4 + leafWidth * 1.2;             // [0.4, 1.6]

  // Serration: boost amplitude on lobe edges at high lobing (maple teeth).
  // At leafLobing=0 the boost is 0, preserving the existing simple-leaf behaviour.
  const serrationBoost = 1 + leafLobing * 1.8;      // [1×, 2.8×]
  const serration     = leafSerration * 0.12 * serrationBoost;
  const serrationFreq = 6 + leafSerration * 12;

  return { m, n1, n2, n3, a, b, axialStretch, xScale, serration, serrationFreq };
}

function leafVariantParams(baseParams, rng) {
  return {
    m:             baseParams.m,
    n1:            baseParams.n1 * (0.85 + rng() * 0.30),
    n2:            baseParams.n2 * (0.80 + rng() * 0.40),
    n3:            baseParams.n3 * (0.80 + rng() * 0.40),
    a:             baseParams.a,
    b:             baseParams.b + (rng() - 0.5) * 0.3,
    axialStretch:  baseParams.axialStretch * (0.85 + rng() * 0.30),
    xScale:        baseParams.xScale,
    serration:     baseParams.serration,
    serrationFreq: baseParams.serrationFreq,
  };
}

function toI(v) {
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

function drawLeaf(ctx, cx, cy, leafH, angle, fillColor, veinColor, outline, venation) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // Scale: x → point.x * leafH * 0.5, y → -point.y * leafH (tip up).
  // Width is controlled via superformula params (leafBaseParams), not a post-scale.
  const scaled = outline.map(p => ({
    x: p.x * leafH * 0.5,
    y: -p.y * leafH,
  }));

  // Draw filled polygon with linear gradient base→tip
  ctx.beginPath();
  ctx.moveTo(scaled[0].x, scaled[0].y);
  for (let i = 1; i < scaled.length; i++) {
    ctx.lineTo(scaled[i].x, scaled[i].y);
  }
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, -leafH);
  // base (y=0) slightly lighter/more yellow-green, tip darker
  grad.addColorStop(0, lightenColor(fillColor, 0.12));
  grad.addColorStop(1, fillColor);
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw veins
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = veinColor;
  ctx.lineCap = 'round';
  for (const edge of venation.edges) {
    const fromNode = venation.nodes[edge.from];
    const toNode = venation.nodes[edge.to];
    const fx = fromNode.x * leafH * 0.5;
    const fy = -fromNode.y * leafH;
    const tx = toNode.x * leafH * 0.5;
    const ty = -toNode.y * leafH;
    ctx.lineWidth = Math.max(0.4, leafH * 0.012 * Math.pow(0.6, toNode.depth * 0.25));
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.restore();
}

// Lighten a CSS rgb(...) color by adding amount to lightness in HSL space.
function lightenColor(cssColor, amount) {
  // Parse "rgb(r,g,b)"
  const m = cssColor.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) return cssColor;
  const r = parseInt(m[1]) / 255;
  const g = parseInt(m[2]) / 255;
  const b = parseInt(m[3]) / 255;
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, s, Math.min(1, l + amount));
  return `rgb(${toI(nr)},${toI(ng)},${toI(nb)})`;
}

// ---------------------------------------------------------------------------
// Needle fascicle helpers — pure math, Node-safe.
// ---------------------------------------------------------------------------

/**
 * Derive per-needle params for a fascicle spray.
 * Returns an array of { angle, length, width } for `count` needles.
 * Needles splay symmetrically around straight-up (angle=0 = pointing +Y),
 * with slight jitter so it looks organic.
 *
 * @param {number} seed  - integer seed (from genome structuralSeed or similar)
 * @param {number} count - number of needles (8–20)
 * @returns {{ angle: number, length: number, width: number }[]}
 */
export function needleFascicleParams(seed, count) {
  const rng = mulberry32(seed ^ 0xC0FE1111);   // isolated sub-stream; no side-effects

  // Tight splay arc: needles fan across 35° centred on +Y — narrow spiky fascicle, not a broad fan
  const spreadRad = (35 / 180) * Math.PI;
  const step = spreadRad / (count - 1);
  const baseAngle = -spreadRad / 2;

  return Array.from({ length: count }, (_, i) => {
    const jitter   = (rng() - 0.5) * step * 0.4;
    const angle    = baseAngle + i * step + jitter;
    const length   = 0.82 + rng() * 0.18;   // relative to card height [0.82, 1.00] — long spikes filling card
    const width    = 0.012 + rng() * 0.010;  // relative to card height [0.012, 0.022]
    return { angle, length, width };
  });
}

/**
 * Draw a needle fascicle (pine/spruce style) on the canvas.
 * All needles share a common base at (cx, cy) and splay upward.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx        - base x (attachment point)
 * @param {number} cy        - base y (attachment point)
 * @param {number} cardH     - canvas card height in pixels (needles scale to this)
 * @param {string} fillColor - CSS color for needles
 * @param {{ angle: number, length: number, width: number }[]} needles
 */
function drawNeedleFascicle(ctx, cx, cy, cardH, fillColor, needles) {
  ctx.save();

  // A short shared basal sheath: a small dark cylinder at the base.
  const sheathH  = cardH * 0.06;
  const sheathW  = cardH * 0.04;
  ctx.fillStyle  = lightenColor(fillColor, -0.10);  // slightly darker
  ctx.beginPath();
  ctx.ellipse(cx, cy - sheathH / 2, sheathW / 2, sheathH / 2, 0, 0, 2 * Math.PI);
  ctx.fill();

  // Draw each needle as a very thin, tapered bezier curve.
  for (const needle of needles) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(needle.angle);           // angle=0 points straight up (+Y before canvas flip)

    const nLen  = cardH * needle.length;
    const nHalf = cardH * needle.width / 2;

    // Needle shape: tapered — full width at base, zero at tip.
    ctx.beginPath();
    ctx.moveTo(0, 0);                   // base left
    ctx.lineTo(-nHalf, 0);
    // Cubic to tip — slight curve outward then in
    ctx.bezierCurveTo(-nHalf * 0.8, -nLen * 0.4, -nHalf * 0.3, -nLen * 0.75, 0, -nLen);
    ctx.bezierCurveTo( nHalf * 0.3, -nLen * 0.75,  nHalf * 0.8, -nLen * 0.4,  nHalf, 0);
    ctx.closePath();

    // Gradient: slightly lighter at base, colour at tip
    const grad = ctx.createLinearGradient(0, 0, 0, -nLen);
    grad.addColorStop(0, lightenColor(fillColor, 0.08));
    grad.addColorStop(1, fillColor);
    ctx.fillStyle = grad;
    ctx.fill();

    // Midrib — a very fine line for the vein
    ctx.strokeStyle = lightenColor(fillColor, 0.15);
    ctx.lineWidth   = Math.max(0.3, nHalf * 0.4);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -nLen);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Palm frond (pinnate) helpers — pure math, Node-safe.
// ---------------------------------------------------------------------------

/**
 * Derive per-leaflet params for a pinnate palm frond.
 * Returns an array of { t, angle, length } for `count` leaflets along a central rachis.
 *   t      - position along rachis [0=base, 1=tip]
 *   angle  - outward splay angle from rachis (positive = right side; negative = left side)
 *   length - relative leaflet length [0, 1], longest near mid-rachis, shorter at base/tip
 *
 * Uses XOR salt 0xF40DF00D — distinct from needle (0xC0FE1111) and broadleaf (0xDEADBEEF).
 *
 * @param {number} seed  - integer seed
 * @param {number} count - total leaflet count (both sides combined; must be even)
 * @returns {{ t: number, angle: number, length: number }[]}
 */
export function frondLeafletParams(seed, count) {
  const rng = mulberry32(seed ^ 0xF40DF00D);   // isolated sub-stream; no side-effects

  // Leaflets are arranged as pairs: one right (+angle), one left (-angle) per pair.
  // t values spread from near-base (0.08) to near-tip (0.92), with slight jitter.
  const pairCount = Math.floor(count / 2);
  const tStep = 0.84 / (pairCount - 1);   // spread from t=0.08 to t=0.92
  const baseT = 0.08;

  // Base splay angle for leaflets from rachis: ~70° with slight organic jitter
  const baseSplay = (70 / 180) * Math.PI;

  const leaflets = [];
  for (let i = 0; i < pairCount; i++) {
    const tJitter = (rng() - 0.5) * tStep * 0.3;
    const t = Math.max(0.02, Math.min(0.98, baseT + i * tStep + tJitter));

    // Length envelope: bell curve peaking near the mid-rachis (t≈0.5).
    // Leaflets at the base and tip are shorter than those in the middle.
    const envelope = Math.sin(Math.PI * t);   // 0 at ends, 1 at center
    const lengthJitter = (rng() - 0.5) * 0.12;
    const length = Math.max(0.05, Math.min(1.0, 0.55 + envelope * 0.45 + lengthJitter));

    // Splay angle: slight variation per pair so frond looks organic
    const splayJitter = (rng() - 0.5) * (15 / 180) * Math.PI;
    const angle = baseSplay + splayJitter;

    // Right leaflet (+angle)
    leaflets.push({ t, angle: +angle, length });
    // Left leaflet (−angle) — separate jitter for slight asymmetry
    const leftJitter = (rng() - 0.5) * (8 / 180) * Math.PI;
    leaflets.push({ t, angle: -(angle + leftJitter), length });
  }

  return leaflets;
}

/**
 * Draw a pinnate palm frond on the canvas.
 * A curved, tapering central rachis runs from base (cx,cy) toward the tip,
 * with many thin leaflets branching off both sides at a swept-back angle.
 * Leaflets are longest near the mid-rachis and shorter toward base and tip.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx        - base x (attachment point)
 * @param {number} cy        - base y (attachment point)
 * @param {number} cardW     - card width in pixels
 * @param {number} cardH     - card height in pixels
 * @param {string} fillColor - CSS color for frond
 * @param {{ t: number, angle: number, length: number }[]} leaflets
 */
function drawPalmFrond(ctx, cx, cy, cardW, cardH, fillColor, leaflets) {
  ctx.save();

  // Rachis: a gently curved, tapering line from base to tip.
  // Base width ≈ 3% of cardW; tapers to a point at tip.
  // The rachis curves slightly to the right to give a natural droop (like a real palm frond).
  const rachisLen = cardH * 0.90;
  const tipX = cx + cardW * 0.06;   // slight rightward lean at tip
  const tipY = cy - rachisLen;

  // Control point for the bezier curve: one-third of the way up, slightly left to create
  // a gentle S-curve that reads as the weight of the frond bowing outward then upward.
  const cpX = cx - cardW * 0.04;
  const cpY = cy - rachisLen * 0.5;

  // Helper: evaluate the quadratic bezier at t ∈ [0,1]
  function bezierPt(t) {
    const mt = 1 - t;
    return {
      x: mt * mt * cx + 2 * mt * t * cpX + t * t * tipX,
      y: mt * mt * cy + 2 * mt * t * cpY + t * t * tipY,
    };
  }

  // Helper: tangent direction (un-normalized) at bezier t
  function bezierTangent(t) {
    const mt = 1 - t;
    return {
      x: 2 * (mt * (cpX - cx) + t * (tipX - cpX)),
      y: 2 * (mt * (cpY - cy) + t * (tipY - cpY)),
    };
  }

  // Draw rachis as a filled tapered shape (stem — dark version of fill color)
  const rachisColor = lightenColor(fillColor, -0.12);
  const rachisBaseW = cardW * 0.025;

  ctx.beginPath();
  // Left edge of rachis base, sweep to tip, right edge back to base
  const steps = 24;
  // Build left edge
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = bezierPt(t);
    const tan = bezierTangent(t);
    const len = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
    const nx = -tan.y / len;  // normal pointing left
    const ny =  tan.x / len;
    const hw = rachisBaseW * (1 - t * 0.9);  // taper to 10% at tip
    if (i === 0) ctx.moveTo(pt.x + nx * hw, pt.y + ny * hw);
    else ctx.lineTo(pt.x + nx * hw, pt.y + ny * hw);
  }
  // Right edge (reverse)
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const pt = bezierPt(t);
    const tan = bezierTangent(t);
    const len = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
    const nx = tan.y / len;   // normal pointing right
    const ny = -tan.x / len;
    const hw = rachisBaseW * (1 - t * 0.9);
    ctx.lineTo(pt.x + nx * hw, pt.y + ny * hw);
  }
  ctx.closePath();
  ctx.fillStyle = rachisColor;
  ctx.fill();

  // Draw each leaflet as a thin tapered blade.
  // Leaflet base attaches to the rachis at parameter t; it extends in the direction
  // tangent-to-rachis rotated by the splay angle, swept back (away from tip direction).
  for (const leaflet of leaflets) {
    const pt   = bezierPt(leaflet.t);
    const tan  = bezierTangent(leaflet.t);
    const tanLen = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
    // Angle of tangent from vertical (rachis direction)
    const rachisAngle = Math.atan2(tan.x / tanLen, -tan.y / tanLen);

    // Leaflet direction: rachis tangent + splay angle (leaflet.angle already encodes sign)
    const leafletAngle = rachisAngle + leaflet.angle;

    // Maximum leaflet length scales with rachis length; envelope already in [0.05,1]
    const maxLeafletLen = rachisLen * 0.42;
    const leafletLen    = maxLeafletLen * leaflet.length;
    const leafletBaseW  = Math.max(1.5, leafletLen * 0.055);   // half-width at base

    // Direction vector for leaflet
    const dx = Math.sin(leafletAngle);
    const dy = -Math.cos(leafletAngle);

    ctx.save();
    ctx.translate(pt.x, pt.y);

    // Perpendicular to leaflet for width taper
    const perpX = -dy;
    const perpY =  dx;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-perpX * leafletBaseW, -perpY * leafletBaseW);
    // Bezier to tip — slight curve for natural look
    const midX = dx * leafletLen * 0.55 - perpX * leafletBaseW * 0.25;
    const midY = dy * leafletLen * 0.55 - perpY * leafletBaseW * 0.25;
    ctx.quadraticCurveTo(midX, midY, dx * leafletLen, dy * leafletLen);
    ctx.quadraticCurveTo(
      dx * leafletLen * 0.55 + perpX * leafletBaseW * 0.25,
      dy * leafletLen * 0.55 + perpY * leafletBaseW * 0.25,
      perpX * leafletBaseW, perpY * leafletBaseW
    );
    ctx.closePath();

    // Slight gradient from lighter base to leaf color at tip
    const gx0 = 0;
    const gy0 = 0;
    const gx1 = dx * leafletLen;
    const gy1 = dy * leafletLen;
    const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    grad.addColorStop(0, lightenColor(fillColor, 0.10));
    grad.addColorStop(1, fillColor);
    ctx.fillStyle = grad;
    ctx.fill();

    // Thin midrib line
    ctx.strokeStyle = lightenColor(fillColor, 0.18);
    ctx.lineWidth   = Math.max(0.3, leafletBaseW * 0.3);
    ctx.globalAlpha = 0.50;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(dx * leafletLen, dy * leafletLen);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Public API — cluster texture.
// ---------------------------------------------------------------------------

export function makeLeafClusterTexture({
  pigment, breadth = 0.5, seed = 1, resolution = 'high',
  leafWidth = 0.5, leafLength = 0.45, leafTip = 0.4,
  leafSerration = 0.0, leafLobing = 0.0, needleLeaf = 0, frondLeaf = 0,
}) {
  if (typeof document === 'undefined') {
    return null;
  }

  const SIZE = resolution === 'low' ? 256 : 512;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);

  const [baseR, baseG, baseB] = pigmentToColor(pigment);
  const [baseH, baseS, baseL] = rgbToHsl(baseR, baseG, baseB);

  // ---------------------------------------------------------------------------
  // Context-parameterized draw helpers.
  // All module-level draw functions (drawLeaf, drawNeedleFascicle, drawPalmFrond)
  // already accept an explicit ctx argument, so we can redirect them to any canvas.
  // ---------------------------------------------------------------------------

  function _drawBroadleafOn(target) {
    const baseParams = leafBaseParams({ leafWidth, leafLength, leafTip, leafSerration, leafLobing });

    const count  = clusterLeafCount(seed);
    const leaves = clusterLeafParams(seed, count);

    const attachX = SIZE / 2;
    const attachY = SIZE - 8;
    const leafH   = SIZE * 0.55;

    const drawOrder = [...leaves]
      .map((l, i) => ({ ...l, i }))
      .sort((a, b) => Math.abs(b.angle) - Math.abs(a.angle));

    for (const leaf of drawOrder) {
      const leafIdx    = leaf.i;
      const variantRng = mulberry32((seed * 1009 + leafIdx * 37) >>> 0);
      const vp         = leafVariantParams(baseParams, variantRng);
      const outline    = superformulaOutline(vp, 120);
      const venation   = growVenation(
        outline,
        { nSources: 60, step: 0.04, influenceRadius: 0.25, killRadius: 0.06, maxIter: 200 },
        mulberry32((seed * 31 + leafIdx * 7) >>> 0)
      );

      const h = ((baseH + leaf.hueDelta) % 1 + 1) % 1;
      const l = Math.max(0.05, Math.min(0.95, baseL + leaf.lightDelta));
      const [lr, lg, lb] = hslToRgb(h, baseS, l);
      const [vr, vg, vb] = hslToRgb(h, baseS, Math.min(1, l + 0.20));

      const fillColor   = `rgb(${toI(lr)},${toI(lg)},${toI(lb)})`;
      const veinColor   = `rgb(${toI(vr)},${toI(vg)},${toI(vb)})`;
      const bx          = attachX + leaf.ox * SIZE;
      const by          = attachY - leaf.oy * SIZE;
      const scaledLeafH = leafH * leaf.scale;

      drawLeaf(target, bx, by, scaledLeafH, leaf.angle, fillColor, veinColor, outline, venation);
    }
  }

  function _drawNeedlesOn(target) {
    const needles  = needleFascicleParams(seed, 10);
    const cardH    = SIZE * 0.80;
    const attachX  = SIZE / 2;
    const attachY  = SIZE - 8;

    const needleH  = ((baseH + 0.01) % 1 + 1) % 1;
    const needleL  = Math.min(0.55, Math.max(0.08, baseL - 0.04));
    const [nr, ng, nb] = hslToRgb(needleH, baseS, needleL);

    drawNeedleFascicle(target, attachX, attachY, cardH, `rgb(${toI(nr)},${toI(ng)},${toI(nb)})`, needles);
  }

  function _drawFrondOn(target) {
    const leaflets = frondLeafletParams(seed, 20);
    const attachX  = SIZE / 2;
    const attachY  = SIZE - 8;

    const frondH   = ((baseH - 0.01 + 1) % 1);
    const frondL   = Math.min(0.60, Math.max(0.10, baseL + 0.02));
    const [fr, fg, fb] = hslToRgb(frondH, baseS, frondL);

    drawPalmFrond(target, attachX, attachY, SIZE, SIZE, `rgb(${toI(fr)},${toI(fg)},${toI(fb)})`, leaflets);
  }

  // ---------------------------------------------------------------------------
  // Helper: draw a layer to a scratch canvas, then stamp onto main at `alpha`.
  // Used only for blend values strictly between 0 and 1 — pure-endpoint paths
  // draw directly to avoid any drawImage compositing artefacts.
  // ---------------------------------------------------------------------------
  function _stampAt(drawFn, alpha) {
    const scratch  = document.createElement('canvas');
    scratch.width  = SIZE;
    scratch.height = SIZE;
    drawFn(scratch.getContext('2d'));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Dispatch:
  //   needleLeaf===0 && frondLeaf===0  → broadleaf directly (byte-identical).
  //   needleLeaf===1                   → needles directly (byte-identical).
  //   frondLeaf===1  (needleLeaf===0)  → frond directly (byte-identical).
  //   0 < needleLeaf < 1               → crossfade: broadleaf + needles via scratch.
  //   0 < frondLeaf  < 1               → crossfade: broadleaf + frond via scratch.
  //
  // Precedence: needleLeaf wins over frondLeaf when both > 0.
  // ---------------------------------------------------------------------------

  if (needleLeaf === 0 && frondLeaf === 0) {
    // Pure broadleaf — no changes to any draw call paths.
    _drawBroadleafOn(ctx);

  } else if (needleLeaf === 1) {
    // Pure needle — draw directly, byte-identical to the old needleLeaf > 0.5 path.
    _drawNeedlesOn(ctx);

  } else if (needleLeaf > 0) {
    // Blend: broadleaf at (1-needleLeaf), needles at needleLeaf.
    _stampAt(sctx => _drawBroadleafOn(sctx), 1 - needleLeaf);
    _stampAt(sctx => _drawNeedlesOn(sctx),   needleLeaf);

  } else if (frondLeaf === 1) {
    // Pure frond — draw directly, byte-identical to the old frondLeaf > 0.5 path.
    _drawFrondOn(ctx);

  } else {
    // frondLeaf > 0 && frondLeaf < 1: blend broadleaf + frond.
    _stampAt(sctx => _drawBroadleafOn(sctx), 1 - frondLeaf);
    _stampAt(sctx => _drawFrondOn(sctx),     frondLeaf);
  }

  return { source: canvas, width: SIZE, height: SIZE };
}

// ---------------------------------------------------------------------------
// makeLeafTexture — single leaf, browser-only (original behavior preserved).
// ---------------------------------------------------------------------------

export function makeLeafTexture({ breadth, pigment }) {
  if (typeof document === 'undefined') {
    throw new Error('makeLeafTexture: document is not defined (browser-only)');
  }

  const width = 128;
  const height = 256;
  const cx = width / 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const [r, g, b] = pigmentToColor(pigment);

  for (let y = 0; y < height; y++) {
    const t = 1.0 - y / (height - 1);
    const hw = leafHalfWidth(t, breadth) * (width / 2);
    if (hw < 0.5) continue;
    const gradientFactor = 0.75 + 0.25 * t;
    const pr = Math.round(r * 255 * gradientFactor);
    const pg = Math.round(g * 255 * gradientFactor);
    const pb = Math.round(b * 255 * gradientFactor);
    ctx.fillStyle = `rgba(${pr},${pg},${pb},255)`;
    ctx.fillRect(cx - hw, y, hw * 2, 1);
  }

  ctx.globalCompositeOperation = 'source-atop';

  const veinR = Math.round(r * 255 * 0.55);
  const veinG = Math.round(g * 255 * 0.55);
  const veinB = Math.round(b * 255 * 0.55);
  const veinColor = `rgb(${veinR},${veinG},${veinB})`;

  ctx.fillStyle = veinColor;
  for (let y = 0; y < height; y++) {
    const t = 1.0 - y / (height - 1);
    const hw = leafHalfWidth(t, breadth) * (width / 2);
    if (hw < 0.5) continue;
    ctx.fillRect(cx, y, 1, 1);
  }

  ctx.strokeStyle = veinColor;
  ctx.lineWidth = 0.8;

  for (let i = 0; i < 5; i++) {
    const tVein = 0.15 + i * 0.15;
    const yVein = Math.round((1 - tVein) * (height - 1));
    const hwVein = leafHalfWidth(tVein, breadth) * (width / 2);

    ctx.beginPath();
    ctx.moveTo(cx, yVein);
    ctx.lineTo(cx + hwVein * 0.85, yVein - hwVein * 0.55);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, yVein);
    ctx.lineTo(cx - hwVein * 0.85, yVein - hwVein * 0.55);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'source-over';

  return { source: canvas, width, height };
}
