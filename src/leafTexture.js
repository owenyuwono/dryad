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
// Public API — cluster texture.
// ---------------------------------------------------------------------------

export function makeLeafClusterTexture({
  pigment, breadth = 0.5, seed = 1, resolution = 'high',
  leafWidth = 0.5, leafLength = 0.45, leafTip = 0.4,
  leafSerration = 0.0, leafLobing = 0.0,
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

  // Derive superformula base params from the 5 leaf-shape genes.
  // Width/length/tip/serration/lobing are all encoded in the params; no post X-scale.
  const baseParams = leafBaseParams({ leafWidth, leafLength, leafTip, leafSerration, leafLobing });

  const count = clusterLeafCount(seed);
  const leaves = clusterLeafParams(seed, count);

  const attachX = SIZE / 2;
  const attachY = SIZE - 8;
  const leafH = SIZE * 0.55;

  const drawOrder = [...leaves]
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => Math.abs(b.angle) - Math.abs(a.angle));

  for (const leaf of drawOrder) {
    const leafIdx = leaf.i;
    const variantRng = mulberry32((seed * 1009 + leafIdx * 37) >>> 0);
    const variantParams = leafVariantParams(baseParams, variantRng);

    const outline = superformulaOutline(variantParams, 120);
    const venation = growVenation(
      outline,
      { nSources: 60, step: 0.04, influenceRadius: 0.25, killRadius: 0.06, maxIter: 200 },
      mulberry32((seed * 31 + leafIdx * 7) >>> 0)
    );

    const h = ((baseH + leaf.hueDelta) % 1 + 1) % 1;
    const l = Math.max(0.05, Math.min(0.95, baseL + leaf.lightDelta));
    const [lr, lg, lb] = hslToRgb(h, baseS, l);
    const [vr, vg, vb] = hslToRgb(h, baseS, Math.min(1, l + 0.20));

    const fillColor = `rgb(${toI(lr)},${toI(lg)},${toI(lb)})`;
    const veinColor = `rgb(${toI(vr)},${toI(vg)},${toI(vb)})`;

    const bx = attachX + leaf.ox * SIZE;
    const by = attachY - leaf.oy * SIZE;
    const scaledLeafH = leafH * leaf.scale;

    drawLeaf(ctx, bx, by, scaledLeafH, leaf.angle, fillColor, veinColor, outline, venation);
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
