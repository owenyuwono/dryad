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
  const { axialStretch = 2, serration = 0, serrationFreq = 10, xScale = 1,
          skewGamma = 1 } = params;

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

  // 5b. Vertical skew — move the widest point along the midrib (leafSkew gene).
  //     A monotonic y-warp y' = y^skewGamma repositions the widest part of the
  //     blade without changing its width-at-height: skewGamma=1 is identity
  //     (symmetric ovate); skewGamma>1 pulls the widest point toward the BASE
  //     and stretches the upper blade into an acuminate (drawn-out) tip — the
  //     ovate, base-heavy silhouette of birch/most broadleaves; skewGamma<1
  //     gives an obovate (widest near the tip) leaf. y stays in [0,1].
  if (skewGamma !== 1) {
    for (let i = 0; i < normalized.length; i++) {
      normalized[i].y = Math.pow(normalized[i].y, skewGamma);
    }
  }

  // 6. Apply serration as small OUTWARD marginal teeth.
  //
  //   Teeth are sized as a FRACTION of the leaf's half-width (scale-invariant)
  //   and clamped so they never exceed ~⅓ of it — an absolute amplitude would
  //   shred a narrow/elongated leaf (whose half-width may be < the tooth size)
  //   into a self-intersecting scatter. They are outward-only (a toothed margin,
  //   not a wavy ripple) and fade to zero toward the tip/base (|x|→0) so the
  //   apex stays sharp. Neighbours are read from an UNMODIFIED copy so one
  //   displaced point never feeds into the next (no cascading distortion).
  if (serration > 0) {
    const N = normalized.length;
    let nMinX = Infinity, nMaxX = -Infinity;
    for (const p of normalized) {
      if (p.x < nMinX) nMinX = p.x;
      if (p.x > nMaxX) nMaxX = p.x;
    }
    const halfW = Math.max(1e-3, (nMaxX - nMinX) / 2);
    // Deeper, clearly-visible teeth ("ridges") — still a safe fraction of the
    // half-width so a narrow leaf can't be shredded (the old absolute-size bug).
    const toothDepth = Math.min(0.30, serration * 3.5) * halfW;
    const src = normalized.map(p => ({ x: p.x, y: p.y }));
    for (let i = 0; i < N; i++) {
      const prev = src[(i - 1 + N) % N];
      const next = src[(i + 1) % N];
      const cur  = src[i];
      // outward normal = edge rotated 90°, flipped to point away from the x=0 axis
      const edgeDx = next.x - prev.x;
      const edgeDy = next.y - prev.y;
      const len = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
      let nx = -edgeDy / len;
      let ny =  edgeDx / len;
      if (nx * cur.x < 0) { nx = -nx; ny = -ny; }
      const tooth    = Math.max(0, Math.sin((i * 2 * Math.PI * serrationFreq) / N));
      const edgeFade = Math.min(1, Math.abs(cur.x) / halfW);  // 0 on axis → 1 at widest
      const amp = toothDepth * tooth * edgeFade;
      normalized[i] = { x: cur.x + nx * amp, y: cur.y + ny * amp };
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
// Pinnate venation — a straight central midrib (base→tip) with secondary veins
// branching off in pairs and sweeping outward-and-up toward the margin. This is
// the venation of a real birch/elm/most broadleaves (space-colonization gives a
// dendritic web that doesn't read as pinnate). Pure + Node-safe (no rng — the
// pattern is deterministic from the outline). Returns the same {nodes, edges}
// shape growVenation does (depth drives drawLeaf's vein line-width: midrib=0,
// secondaries=2, tertiaries=3), so drawLeaf consumes it unchanged.
// ---------------------------------------------------------------------------

export function pinnateVenation(outline, { pairs = 9 } = {}) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of outline) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const H = (maxY - minY) || 1;
  const band = (H / (pairs + 2)) * 0.75;

  // Half-width of the blade at height y (max |x| of outline points in a y-band).
  function halfWidthAt(y) {
    let w = 0;
    for (const p of outline) {
      if (Math.abs(p.y - y) <= band) { const ax = Math.abs(p.x); if (ax > w) w = ax; }
    }
    return w;
  }

  const nodes = [];
  const edges = [];

  // Midrib: base → tip along the central axis (x=0).
  const midSteps = pairs + 1;
  const midIdx = [];
  for (let i = 0; i <= midSteps; i++) {
    const t = i / midSteps;
    nodes.push({ x: 0, y: minY + t * H, depth: 0 });
    const idx = nodes.length - 1;
    if (i > 0) edges.push({ from: midIdx[i - 1], to: idx });
    midIdx.push(idx);
  }

  // Secondary vein pairs from interior midrib nodes, sweeping up toward the apex.
  for (let k = 1; k <= pairs; k++) {
    const mi = midIdx[k];
    const my = nodes[mi].y;
    const tt = (my - minY) / H;                  // 0 at base → 1 at tip
    const hw = halfWidthAt(my);
    if (hw < 1e-4) continue;
    const ex = hw * 0.82;                          // reach most of the way to the margin
    const ey = my + (maxY - my) * (0.12 + 0.20 * (1 - tt));  // lower veins angle up more
    // Mid-point node so the vein reads as a gentle two-segment sweep, not a spoke.
    const mx = ex * 0.5;
    const midY = my + (ey - my) * 0.55;
    const ri = nodes.length; nodes.push({ x:  mx, y: midY, depth: 2 });
    const re = nodes.length; nodes.push({ x:  ex, y: ey,   depth: 3 });
    edges.push({ from: mi, to: ri }, { from: ri, to: re });
    const li = nodes.length; nodes.push({ x: -mx, y: midY, depth: 2 });
    const le = nodes.length; nodes.push({ x: -ex, y: ey,   depth: 3 });
    edges.push({ from: mi, to: li }, { from: li, to: le });
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
  const { leafWidth = 0.5, leafLength = 0.45, leafTip = 0.4, leafSerration = 0, leafLobing = 0,
          leafSkew = 0.5 } = genes;

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
  const serrationFreq = 8 + leafSerration * 24;   // finer, more numerous teeth (birch is finely serrate)

  // Skew: leafSkew 0.5 = symmetric (identity). The widest point is moved to the
  // normalized height `leafSkew` via the warp y' = y^skewGamma, where
  // skewGamma = log(leafSkew)/log(0.5) (so leafSkew=0.5 → 1.0 = no-op).
  // Clamped away from the endpoints to keep the exponent finite.
  const skewClamped = Math.max(0.08, Math.min(0.92, leafSkew));
  const skewGamma = Math.log(skewClamped) / Math.log(0.5);

  return { m, n1, n2, n3, a, b, axialStretch, xScale, serration, serrationFreq, skewGamma };
}

// ---------------------------------------------------------------------------
// Card-aspect factors — the single-leaf RENDER path carries width:length on the
// leaf CARD's aspect (leafMesh.setLeafAspect), not the sprite, so leafWidth and
// leafLength scale independent axes. These pure functions are the single source
// for that mapping (used by viewer.js + forest.js; Node-testable).
//
//   leafWidthFactor:  card X-scale (breadth). Reuses the OLD sprite xScale curve
//     (0.4 + leafWidth·1.2) so the default genome (leafWidth 0.5 → 1.0) renders at
//     the same width as before — width simply moved from the sprite to the card.
//   leafLengthFactor: card Y-scale (length). Identity (≈1.0) at the default
//     leafLength 0.45, growing with the gene. Previously leafLength only narrowed
//     the leaf (it could not change rendered length because the sprite is
//     self-normalized to fill the card height); now it stretches the card's Y.
//
// Both are clamped > 0 (setLeafAspect also guards) so a degenerate factor can't
// collapse a card to zero area.
// ---------------------------------------------------------------------------

export function leafWidthFactor(leafWidth = 0.5) {
  return 0.4 + leafWidth * 1.2;   // [0.4, 1.6]; 1.0 at the default 0.5
}

export function leafLengthFactor(leafLength = 0.45) {
  return 0.55 + leafLength * 1.0; // [0.55, 1.55]; ≈1.0 at the default 0.45
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
    skewGamma:     baseParams.skewGamma,   // carry the leafSkew warp into every cluster leaf
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

    // Fan spread angle (used only when frondFan > 0): evenly distribute leaflets across
    // a broad radial fan — center (~4.5°) → edge (~85°) — so the rachis-collapsed
    // palmate form reads as a Washingtonia-style fan. At frondFan=0 it is never used.
    const fanSpan = pairCount > 1 ? i / (pairCount - 1) : 0;
    const fanA    = 0.08 + fanSpan * 1.40;   // ~4.5° (center) → ~85° (edge), radians

    // Right leaflet (+angle)
    leaflets.push({ t, angle: +angle, length, fanAngle: +fanA });
    // Left leaflet (−angle) — separate jitter for slight asymmetry
    const leftJitter = (rng() - 0.5) * (8 / 180) * Math.PI;
    leaflets.push({ t, angle: -(angle + leftJitter), length, fanAngle: -fanA });
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
function drawPalmFrond(ctx, cx, cy, cardW, cardH, fillColor, leaflets, frondFan = 0) {
  ctx.save();

  // frondFan: 0 = pinnate FEATHER (leaflets spread along the rachis — coconut), 1 = palmate
  // FAN (rachis collapses to a short petiole and leaflets radiate from the base — Washingtonia).
  // At frondFan=0 every expression below reduces to the original feather frond (byte-identical).
  //
  // Rachis: a gently curved, tapering line from base to tip.
  // The rachis curves slightly to the right to give a natural droop (like a real palm frond).
  const fullRachisLen = cardH * 0.90;                       // basis for leaflet length (fan blades stay long)
  const rachisLen = fullRachisLen * (1 - frondFan * 0.85);  // drawn rachis collapses to a petiole as it fans
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
    // Converge the attachment point toward the base (t→0) as the frond fans (palmate).
    const tEff = leaflet.t * (1 - frondFan);
    const pt   = bezierPt(tEff);
    const tan  = bezierTangent(tEff);
    const tanLen = Math.sqrt(tan.x * tan.x + tan.y * tan.y) || 1;
    // Angle of tangent from vertical (rachis direction)
    const rachisAngle = Math.atan2(tan.x / tanLen, -tan.y / tanLen);

    // Blend the splay: feather = swept-back leaflet.angle; fan = even radial fanAngle.
    // (fanAngle falls back to leaflet.angle for any older params array lacking it.)
    const fanA     = leaflet.fanAngle !== undefined ? leaflet.fanAngle : leaflet.angle;
    const angleEff = leaflet.angle * (1 - frondFan) + fanA * frondFan;
    const leafletAngle = rachisAngle + angleEff;

    // Leaflet length: feather uses the bell envelope; fan blades are long + ~uniform.
    // Based on the FULL rachis so fan blades don't shrink with the collapsed petiole.
    const maxLeafletLen = fullRachisLen * 0.42;
    const lengthEff     = leaflet.length * (1 - frondFan) + 0.92 * frondFan;
    const leafletLen    = maxLeafletLen * lengthEff;
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
  leafSerration = 0.0, leafLobing = 0.0, leafSkew = 0.5, leafDivision = 0, frondFan = 0,
  leafMode = 'single',
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
  // The module-level draw functions (drawLeaf, drawPalmFrond) already accept an
  // explicit ctx argument, so we can redirect them to any canvas.
  // ---------------------------------------------------------------------------

  function _drawBroadleafOn(target) {
    const baseParams = leafBaseParams({ leafWidth, leafLength, leafTip, leafSerration, leafLobing, leafSkew });

    // ----- CLUSTER / CROSSED mode: a sprig of several leaves painted into ONE -----
    // sprite. Far fewer instances/triangles because each foliage anchor stays a
    // single card (expandClumpsToLeaves passes through). 'crossed' uses the SAME
    // multi-leaf sprite as 'cluster' — it just renders K=3 criss-crossed copies of
    // that card per anchor (SpeedTree-style), decided in foliage.js / the viewer.
    // Width here still comes from the sprite (xScale); card-aspect width is only
    // applied in 'single' mode (one leaf per card), so cluster/crossed sprigs are
    // not stretched.
    if (leafMode === 'cluster' || leafMode === 'crossed') {
      const count  = clusterLeafCount(seed);
      const leaves = clusterLeafParams(seed, count);
      const attachX = SIZE / 2;
      const attachY = SIZE - 8;
      const leafH   = SIZE * 0.55;
      const drawOrder = [...leaves]
        .map((l, i) => ({ ...l, i }))
        .sort((a, b) => Math.abs(b.angle) - Math.abs(a.angle));
      for (const leaf of drawOrder) {
        const variantRng = mulberry32((seed * 1009 + leaf.i * 37) >>> 0);
        const vp         = leafVariantParams(baseParams, variantRng);
        const outline    = superformulaOutline(vp, 120);
        const veinPairs  = Math.max(6, Math.min(9, Math.round((vp.serrationFreq ?? 10) * 0.4)));
        const venation   = pinnateVenation(outline, { pairs: veinPairs });
        const h = ((baseH + leaf.hueDelta) % 1 + 1) % 1;
        const l = Math.max(0.05, Math.min(0.95, baseL + leaf.lightDelta));
        const [lr, lg, lb] = hslToRgb(h, baseS, l);
        const [vr, vg, vb] = hslToRgb(h, baseS, Math.min(1, l + 0.20));
        const fillColor = `rgb(${toI(lr)},${toI(lg)},${toI(lb)})`;
        const veinColor = `rgb(${toI(vr)},${toI(vg)},${toI(vb)})`;
        const bx = attachX + leaf.ox * SIZE;
        const by = attachY - leaf.oy * SIZE;
        drawLeaf(target, bx, by, leafH * leaf.scale, leaf.angle, fillColor, veinColor, outline, venation);
      }
      return;
    }

    // ----- SINGLE-LEAF mode (default): ONE leaf per card, the shape-IS-the- -----
    // texture model. Canopy density comes from many single-leaf cards (foliage
    // clumps fanned out by expandClumpsToLeaves).
    //
    // CARD-ASPECT WIDTH: width:length is now carried by the leaf CARD's aspect
    // ratio (leafMesh.setLeafAspect — leafWidth → card X, leafLength → card Y), so
    // the two genes scale independent axes. To avoid applying width TWICE, the
    // single-leaf sprite is drawn at UNIT xScale (the leaf fills the square sprite
    // shape-only); the card then stretches it. axialStretch is left in the sprite —
    // it only changes the leaf SILHOUETTE (pointier/blunter), not its rendered
    // length, because the outline is self-normalized to fill the card height.
    const singleParams = { ...baseParams, xScale: 1 };
    const outline = superformulaOutline(singleParams, 160);

    // Fit the single leaf to fill the card: base at bottom-centre, tip up. leafH
    // is bounded by BOTH the card height and width so a broad leaf doesn't clip.
    let minX = Infinity, maxX = -Infinity;
    for (const p of outline) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
    const wExtent = Math.max(0.02, maxX - minX);          // outline y is already 0..1
    const leafH = Math.min(SIZE * 0.92, (SIZE * 0.92) / (wExtent * 0.5));
    const cx = SIZE / 2;
    const cy = SIZE - SIZE * 0.05;                        // base near the bottom edge

    const veinPairs = Math.max(6, Math.min(9, Math.round((baseParams.serrationFreq ?? 10) * 0.4)));
    const venation  = pinnateVenation(outline, { pairs: veinPairs });

    const [lr, lg, lb] = hslToRgb(baseH, baseS, baseL);
    const [vr, vg, vb] = hslToRgb(baseH, baseS, Math.min(1, baseL + 0.20));
    const fillColor = `rgb(${toI(lr)},${toI(lg)},${toI(lb)})`;
    const veinColor = `rgb(${toI(vr)},${toI(vg)},${toI(vb)})`;

    drawLeaf(target, cx, cy, leafH, 0, fillColor, veinColor, outline, venation);
  }

  function _drawFrondOn(target) {
    // Leaflet/division count is driven by leafLobing (reusing the existing "division"
    // slider for fronds instead of a new gene): 8 (low) → 24 (high) leaflets, kept even
    // for left/right pairs. frondFan then morphs feather (along rachis) ↔ palmate fan.
    const frondCount = 2 * Math.round(4 + leafLobing * 8);   // 8..24
    const leaflets = frondLeafletParams(seed, frondCount);
    const attachX  = SIZE / 2;
    const attachY  = SIZE - 8;

    const frondH   = ((baseH - 0.01 + 1) % 1);
    const frondL   = Math.min(0.60, Math.max(0.10, baseL + 0.02));
    const [fr, fg, fb] = hslToRgb(frondH, baseS, frondL);

    drawPalmFrond(target, attachX, attachY, SIZE, SIZE, `rgb(${toI(fr)},${toI(fg)},${toI(fb)})`, leaflets, frondFan);
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
  // Dispatch on the single leafDivision axis (0 = simple blade, 1 = compound frond):
  //   leafDivision <= 0  → simple blade directly (a NEEDLE is this with leafWidth→0).
  //   leafDivision >= 1  → compound frond directly.
  //   0 < leafDivision < 1 → crossfade simple blade + frond via scratch.
  // (The old discrete needle-fascicle path is gone — a needle is a narrow blade.)
  // ---------------------------------------------------------------------------

  if (leafDivision <= 0) {
    _drawBroadleafOn(ctx);

  } else if (leafDivision >= 1) {
    _drawFrondOn(ctx);

  } else {
    _stampAt(sctx => _drawBroadleafOn(sctx), 1 - leafDivision);
    _stampAt(sctx => _drawFrondOn(sctx),     leafDivision);
  }

  // Derive a tangent-space NORMAL MAP from the finished sprite so leaf surface
  // detail (midrib, veins, blade gradient, silhouette edge) catches light instead
  // of every card shading dead-flat. Height ≈ luminance inside the alpha cutout
  // (veins are drawn lighter → ridges); Sobel gradient → normal; alpha carried
  // over so the cutout matches the colour map exactly. Guarded: if the canvas
  // backend has no pixel access (test mocks / headless), skip it gracefully.
  let normal = null;
  try {
    normal = buildLeafNormalMap(canvas, SIZE, LEAF_NORMAL_STRENGTH);
  } catch (_) {
    normal = null;
  }

  return { source: canvas, normal, width: SIZE, height: SIZE };
}

// Tangent-space normal-map strength (Sobel gradient gain). Higher = deeper relief.
const LEAF_NORMAL_STRENGTH = 2.5;

/**
 * buildLeafNormalMap(srcCanvas, SIZE, strength) -> HTMLCanvasElement
 *
 * Tangent-space normal map from the colour sprite's luminance height field,
 * masked by the sprite alpha. Browser-only (uses canvas pixel access).
 */
function buildLeafNormalMap(srcCanvas, SIZE, strength) {
  const sctx = srcCanvas.getContext('2d');
  const src = sctx.getImageData(0, 0, SIZE, SIZE).data;

  // Height field: luminance where the sprite is opaque, 0 outside (so the
  // silhouette edge produces an inward-curling normal).
  const h = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = src[i * 4 + 3] / 255;
    const lum = (0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2]) / 255;
    h[i] = a > 0.03 ? lum : 0;
  }

  const out = document.createElement('canvas');
  out.width = SIZE;
  out.height = SIZE;
  const octx = out.getContext('2d');
  const oimg = octx.createImageData(SIZE, SIZE);
  const od = oimg.data;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const xl = h[y * SIZE + (x > 0 ? x - 1 : x)];
      const xr = h[y * SIZE + (x < SIZE - 1 ? x + 1 : x)];
      const yu = h[(y > 0 ? y - 1 : y) * SIZE + x];
      const yd = h[(y < SIZE - 1 ? y + 1 : y) * SIZE + x];
      let nx = (xl - xr) * strength;
      let ny = (yd - yu) * strength;   // +Y up in tangent space
      let nz = 1.0;
      const inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      od[i * 4]     = Math.round((nx * inv * 0.5 + 0.5) * 255);
      od[i * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      od[i * 4 + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      od[i * 4 + 3] = src[i * 4 + 3];   // carry alpha cutout
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
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
