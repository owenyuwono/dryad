import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leafHalfWidth,
  leafBaseParams,
  clusterLeafCount,
  clusterLeafParams,
  makeLeafClusterTexture,
  superformulaPoint,
  superformulaOutline,
  pointInPolygon,
  growVenation,
  pinnateVenation,
  frondLeafletParams,
  leafWidthFactor,
  leafLengthFactor,
} from '../src/leafTexture.js';

test('leafHalfWidth is 0 at base (t=0) for all breadths', () => {
  for (const b of [0, 0.3, 0.7, 1]) {
    assert.strictEqual(leafHalfWidth(0, b), 0);
  }
});

test('leafHalfWidth is 0 at tip (t=1) for all breadths', () => {
  for (const b of [0, 0.3, 0.7, 1]) {
    assert.ok(Math.abs(leafHalfWidth(1, b)) < 1e-10, `expected ~0 at t=1, b=${b}`);
  }
});

test('leafHalfWidth is broader at breadth=1 than breadth=0 at midpoint', () => {
  assert.ok(leafHalfWidth(0.5, 1) > leafHalfWidth(0.5, 0));
});

test('leafHalfWidth has an interior peak > 0', () => {
  const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const maxVal = Math.max(...samples.map(t => leafHalfWidth(t, 0.5)));
  assert.ok(maxVal > 0, 'expected peak > 0 in interior');
});

test('module imports cleanly in Node without document', () => {
  assert.ok(true);
});

test('leafHalfWidth peak is in interior, not at endpoints', () => {
  const ts = Array.from({length: 99}, (_, i) => (i + 1) / 100);
  const vals = ts.map(t => ({ t, w: leafHalfWidth(t, 0.5) }));
  const peak = vals.reduce((a, b) => a.w > b.w ? a : b);
  assert.ok(peak.t > 0.05 && peak.t < 0.95, `peak should be interior, got t=${peak.t}`);
});

// ---------------------------------------------------------------------------
// makeLeafClusterTexture — Node-safe (pure math) tests
// ---------------------------------------------------------------------------

test('makeLeafClusterTexture returns null gracefully in Node (no document)', () => {
  assert.strictEqual(typeof document, 'undefined');
  const result = makeLeafClusterTexture({ pigment: 0.4, breadth: 0.5, seed: 1 });
  assert.strictEqual(result, null);
});

test('clusterLeafCount returns 5–8 for any seed', () => {
  for (const seed of [0, 1, 7, 42, 999, 0xFFFFFF]) {
    const n = clusterLeafCount(seed);
    assert.ok(n >= 5 && n <= 8, `expected 5–8, got ${n} for seed ${seed}`);
  }
});

test('clusterLeafCount is deterministic for the same seed', () => {
  for (const seed of [1, 17, 256]) {
    assert.strictEqual(clusterLeafCount(seed), clusterLeafCount(seed));
  }
});

test('clusterLeafParams returns an array matching clusterLeafCount', () => {
  for (const seed of [1, 2, 99]) {
    const count = clusterLeafCount(seed);
    const params = clusterLeafParams(seed, count);
    assert.strictEqual(params.length, count);
  }
});

test('clusterLeafParams is deterministic from the same seed', () => {
  const seed = 42;
  const count = clusterLeafCount(seed);
  const a = clusterLeafParams(seed, count);
  const b = clusterLeafParams(seed, count);
  for (let i = 0; i < count; i++) {
    assert.strictEqual(a[i].angle, b[i].angle, `angle mismatch at leaf ${i}`);
    assert.strictEqual(a[i].scale, b[i].scale, `scale mismatch at leaf ${i}`);
    assert.strictEqual(a[i].hueDelta, b[i].hueDelta, `hueDelta mismatch at leaf ${i}`);
  }
});

test('clusterLeafParams fan spans at least 100° total (left to right)', () => {
  for (const seed of [1, 7, 31]) {
    const count = clusterLeafCount(seed);
    const params = clusterLeafParams(seed, count);
    const angles = params.map(p => p.angle);
    const spanDeg = (Math.max(...angles) - Math.min(...angles)) * (180 / Math.PI);
    assert.ok(spanDeg >= 100, `fan span ${spanDeg.toFixed(1)}° too narrow for seed ${seed}`);
  }
});

test('clusterLeafParams all scales in [0.6, 1.0]', () => {
  const seed = 5;
  const count = clusterLeafCount(seed);
  const params = clusterLeafParams(seed, count);
  for (const p of params) {
    assert.ok(p.scale >= 0.60 && p.scale <= 1.00, `scale ${p.scale} out of range`);
  }
});

test('clusterLeafParams hueDelta within ±10° (±10/360 turns)', () => {
  const limit = 10 / 360 + 1e-9;
  const seed = 13;
  const count = clusterLeafCount(seed);
  const params = clusterLeafParams(seed, count);
  for (const p of params) {
    assert.ok(Math.abs(p.hueDelta) <= limit, `hueDelta ${p.hueDelta} exceeds ±10°`);
  }
});

test('clusterLeafParams lightDelta within ±9%', () => {
  const limit = 0.09 + 1e-9;
  const seed = 77;
  const count = clusterLeafCount(seed);
  const params = clusterLeafParams(seed, count);
  for (const p of params) {
    assert.ok(Math.abs(p.lightDelta) <= limit, `lightDelta ${p.lightDelta} exceeds ±9%`);
  }
});

test('different seeds produce different clusterLeafParams', () => {
  const countA = clusterLeafCount(1);
  const countB = clusterLeafCount(2);
  const count = Math.min(countA, countB);
  const a = clusterLeafParams(1, count);
  const b = clusterLeafParams(2, count);
  const anyDiffers = a.some((la, i) => la.angle !== b[i].angle || la.scale !== b[i].scale);
  assert.ok(anyDiffers, 'seeds 1 and 2 should produce different leaf params');
});

// ---------------------------------------------------------------------------
// New tests: superformula, pointInPolygon, growVenation
// ---------------------------------------------------------------------------

test('superformulaPoint returns finite x,y for valid params', () => {
  const params = { m:2, n1:1, n2:4, n3:8, a:1, b:1, axialStretch:2, serration:0 };
  const pt = superformulaPoint(0, params);
  assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
});

test('superformulaOutline returns closed non-degenerate polygon', () => {
  const params = { m:2, n1:1, n2:4, n3:8, a:1, b:1, axialStretch:2, serration:0 };
  const outline = superformulaOutline(params, 120);
  assert.ok(outline.length >= 10);
  const xs = outline.map(p => p.x);
  const ys = outline.map(p => p.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.1, 'outline should have width');
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.1, 'outline should have height');
});

test('superformulaOutline base is near y=0 and tip is near y=1 (normalized)', () => {
  const params = { m:2, n1:1, n2:4, n3:8, a:1, b:1, axialStretch:2, serration:0 };
  const outline = superformulaOutline(params, 120);
  const ys = outline.map(p => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  assert.ok(minY <= 0.05, `base should be near y=0, got minY=${minY.toFixed(3)}`);
  assert.ok(maxY >= 0.95, `tip should be near y=1, got maxY=${maxY.toFixed(3)}`);
});

test('per-leaf param perturbation produces different outlines for different seeds', async () => {
  const { mulberry32 } = await import('../src/rng.js');
  const rng1 = mulberry32(1);
  const rng2 = mulberry32(999);
  const base = { m:2, n1:1, n2:4, n3:8, a:1, b:1 };
  function variantParams(base, rng) {
    return { ...base,
      n1: base.n1 * (0.85 + rng() * 0.30),
      n2: base.n2 * (0.80 + rng() * 0.40),
      n3: base.n3 * (0.80 + rng() * 0.40),
      b: 1 + (rng() - 0.5) * 0.3,
      axialStretch: 1.8 + rng() * 0.6,
      serration: rng() * 0.08,
    };
  }
  const p1 = variantParams(base, rng1);
  const p2 = variantParams(base, rng2);
  const o1 = superformulaOutline(p1, 60);
  const o2 = superformulaOutline(p2, 60);
  const anyDiff = o1.some((pt, i) => Math.abs(pt.x - o2[i].x) > 0.001 || Math.abs(pt.y - o2[i].y) > 0.001);
  assert.ok(anyDiff, 'different seeds must produce different outlines');
});

test('pointInPolygon correctly identifies inside/outside a square', () => {
  const square = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  assert.ok(pointInPolygon(0.5, 0.5, square), 'center should be inside');
  assert.ok(!pointInPolygon(2, 2, square), 'outside point should not be inside');
});

test('growVenation returns root node at leaf base', async () => {
  const { mulberry32 } = await import('../src/rng.js');
  const outline = [
    {x:-0.3,y:0}, {x:0.3,y:0}, {x:0.3,y:1}, {x:-0.3,y:1}
  ];
  const params = { nSources:20, step:0.1, influenceRadius:0.4, killRadius:0.15, maxIter:50 };
  const rng = mulberry32(42);
  const { nodes, edges } = growVenation(outline, params, rng);
  assert.ok(nodes.length >= 1, 'should have at least root node');
  assert.ok(Math.abs(nodes[0].x) < 0.01, 'root should be at x=0');
  assert.ok(Math.abs(nodes[0].y) < 0.01, 'root should be at y=0');
  assert.strictEqual(nodes[0].parentIdx, -1, 'root should have parentIdx -1');
});

test('growVenation produces multiple branches (non-trivial tree)', async () => {
  const { mulberry32 } = await import('../src/rng.js');
  const outline = [
    {x:-0.3,y:0},{x:0.3,y:0},{x:0.3,y:1},{x:-0.3,y:1}
  ];
  const params = { nSources:40, step:0.06, influenceRadius:0.35, killRadius:0.1, maxIter:200 };
  const rng = mulberry32(7);
  const { nodes, edges } = growVenation(outline, params, rng);
  assert.ok(nodes.length > 5, `expected >5 nodes, got ${nodes.length}`);
  assert.ok(edges.length > 4, `expected >4 edges, got ${edges.length}`);
});

test('growVenation is deterministic with same rng seed', async () => {
  const { mulberry32 } = await import('../src/rng.js');
  const outline = [
    {x:-0.3,y:0},{x:0.3,y:0},{x:0.2,y:0.6},{x:0,y:1},{x:-0.2,y:0.6}
  ];
  const params = { nSources:30, step:0.07, influenceRadius:0.3, killRadius:0.1, maxIter:100 };
  const run1 = growVenation(outline, params, mulberry32(13));
  const run2 = growVenation(outline, params, mulberry32(13));
  assert.strictEqual(run1.nodes.length, run2.nodes.length, 'node count should match');
  assert.strictEqual(run1.edges.length, run2.edges.length, 'edge count should match');
  assert.ok(
    run1.nodes.every((n, i) => Math.abs(n.x - run2.nodes[i].x) < 1e-12 && Math.abs(n.y - run2.nodes[i].y) < 1e-12),
    'all node positions should match'
  );
});

test('growVenation nodes are all within bounding box of outline', async () => {
  const { mulberry32 } = await import('../src/rng.js');
  const outline = [
    {x:-0.3,y:0},{x:0.3,y:0},{x:0.2,y:0.6},{x:0,y:1},{x:-0.2,y:0.6}
  ];
  const params = { nSources:30, step:0.07, influenceRadius:0.3, killRadius:0.1, maxIter:100 };
  const { nodes } = growVenation(outline, params, mulberry32(55));
  for (const n of nodes) {
    assert.ok(n.x >= -0.5 && n.x <= 0.5, `node x=${n.x.toFixed(3)} out of range`);
    assert.ok(n.y >= -0.1 && n.y <= 1.1, `node y=${n.y.toFixed(3)} out of range`);
  }
});

// ---------------------------------------------------------------------------
// Shape gene tests — leafBaseParams and superformulaOutline driven by genes
// ---------------------------------------------------------------------------

function makeOutline(genes, steps = 120) {
  const params = leafBaseParams(genes);
  return superformulaOutline(params, steps);
}

function outlineWidth(outline) {
  const xs = outline.map(p => p.x);
  return Math.max(...xs) - Math.min(...xs);
}

function outlineHeight(outline) {
  const ys = outline.map(p => p.y);
  return Math.max(...ys) - Math.min(...ys);
}

function aspectRatio(outline) {
  return outlineWidth(outline) / outlineHeight(outline);
}

// leafWidth↑ → broader (larger width-to-length aspect ratio)
test('leafWidth↑ → wider aspect ratio (monotonically)', () => {
  const levels = [0.1, 0.3, 0.5, 0.7, 0.9];
  const ratios = levels.map(w => aspectRatio(makeOutline({ leafWidth: w, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 0 })));
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(ratios[i] > ratios[i-1], `leafWidth ${levels[i-1]}→${levels[i]}: ratio should increase, got ${ratios[i-1].toFixed(4)}→${ratios[i].toFixed(4)}`);
  }
});

// leafLength↑ → taller → smaller aspect ratio (more height relative to width)
test('leafLength↑ → smaller aspect ratio (taller leaf, monotonically)', () => {
  const levels = [0.1, 0.3, 0.5, 0.7, 0.9];
  const ratios = levels.map(l => aspectRatio(makeOutline({ leafWidth: 0.5, leafLength: l, leafTip: 0.4, leafSerration: 0, leafLobing: 0 })));
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(ratios[i] < ratios[i-1], `leafLength ${levels[i-1]}→${levels[i]}: aspect should decrease (taller leaf), got ${ratios[i-1].toFixed(4)}→${ratios[i].toFixed(4)}`);
  }
});

// leafTip↑ → rounder tip (more width near y=1)
test('leafTip↑ → rounder tip (more width near y=1)', () => {
  const levels = [0.1, 0.3, 0.5, 0.7, 0.9];
  function tipWidth(genes) {
    const outline = makeOutline(genes, 120);
    const tipPts = outline.filter(p => p.y > 0.9);
    if (tipPts.length === 0) return 0;
    return Math.max(...tipPts.map(p => Math.abs(p.x)));
  }
  const widths = levels.map(t => tipWidth({ leafWidth: 0.5, leafLength: 0.45, leafTip: t, leafSerration: 0, leafLobing: 0 }));
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] > widths[i-1], `leafTip ${levels[i-1]}→${levels[i]}: tip width should increase, got ${widths[i-1].toFixed(4)}→${widths[i].toFixed(4)}`);
  }
});

// leafSerration↑ → more edge undulation (perimeter arc-length increases)
test('leafSerration↑ → longer perimeter arc-length (monotonically)', () => {
  function perimeterLength(outline) {
    let len = 0;
    const N = outline.length;
    for (let i = 0; i < N; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % N];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      len += Math.sqrt(dx*dx + dy*dy);
    }
    return len;
  }
  const levels = [0.0, 0.25, 0.5, 0.75, 1.0];
  const perims = levels.map(s => perimeterLength(makeOutline({ leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: s, leafLobing: 0 }, 120)));
  for (let i = 1; i < perims.length; i++) {
    assert.ok(perims[i] > perims[i-1], `leafSerration ${levels[i-1]}→${levels[i]}: perimeter should increase, got ${perims[i-1].toFixed(4)}→${perims[i].toFixed(4)}`);
  }
});

// leafSkew moves the widest point along the blade (asymmetry), identity at 0.5
test('leafSkew: 0.5 is symmetric identity; <0.5 moves the widest point toward the base', () => {
  function widestY(genes) {
    const outline = makeOutline(genes, 240);
    let maxAbsX = -1, yAtMax = 0;
    for (const p of outline) {
      if (Math.abs(p.x) > maxAbsX) { maxAbsX = Math.abs(p.x); yAtMax = p.y; }
    }
    return yAtMax;   // normalized height of the widest point (0=base, 1=tip)
  }
  const base = { leafWidth: 0.6, leafLength: 0.3, leafTip: 0.35, leafSerration: 0, leafLobing: 0 };
  const symY = widestY({ ...base, leafSkew: 0.5 });
  const lowY = widestY({ ...base, leafSkew: 0.28 });
  assert.ok(Math.abs(symY - 0.5) < 0.12, `leafSkew=0.5 widest point should sit near mid-blade, got ${symY.toFixed(3)}`);
  assert.ok(lowY < symY - 0.08, `leafSkew=0.28 should move the widest point toward the base: ${lowY.toFixed(3)} vs ${symY.toFixed(3)}`);
});

test('leafSkew=0.5 is byte-identical to omitting it (true identity)', () => {
  const base = { leafWidth: 0.6, leafLength: 0.3, leafTip: 0.35, leafSerration: 0.3, leafLobing: 0.2 };
  assert.deepStrictEqual(makeOutline({ ...base }, 120), makeOutline({ ...base, leafSkew: 0.5 }, 120));
});

// pinnate venation: midrib (depth 0, on the x≈0 axis) + symmetric secondary pairs
test('pinnateVenation builds a central midrib spanning base→tip', () => {
  const outline = makeOutline({ leafWidth: 0.6, leafLength: 0.3, leafTip: 0.35, leafSerration: 0.4, leafLobing: 0 }, 200);
  const ven = pinnateVenation(outline, { pairs: 8 });
  const midrib = ven.nodes.filter(n => n.depth === 0);
  assert.ok(midrib.length >= 3, `expected a midrib chain, got ${midrib.length} nodes`);
  for (const n of midrib) assert.ok(Math.abs(n.x) < 1e-9, `midrib node off-axis: x=${n.x}`);
  const ys = midrib.map(n => n.y);
  const span = Math.max(...ys) - Math.min(...ys);
  assert.ok(span > 0.5, `midrib should span most of the blade height, got ${span.toFixed(3)}`);
});

test('pinnateVenation secondaries come in symmetric ±x pairs', () => {
  const outline = makeOutline({ leafWidth: 0.6, leafLength: 0.3, leafTip: 0.35, leafSerration: 0.4, leafLobing: 0 }, 200);
  const ven = pinnateVenation(outline, { pairs: 7 });
  const tips = ven.nodes.filter(n => n.depth === 3);
  const right = tips.filter(n => n.x > 0).map(n => +n.x.toFixed(6)).sort();
  const left  = tips.filter(n => n.x < 0).map(n => +(-n.x).toFixed(6)).sort();
  assert.equal(right.length, left.length, 'equal number of left/right secondary tips');
  assert.ok(right.length >= 5, `expected secondary pairs, got ${right.length}`);
  assert.deepStrictEqual(right, left, 'secondary tips should mirror across the midrib');
});

test('pinnateVenation is deterministic (no rng) and all nodes finite', () => {
  const outline = makeOutline({ leafWidth: 0.5, leafLength: 0.4, leafTip: 0.4, leafSerration: 0.2, leafLobing: 0 }, 160);
  const a = pinnateVenation(outline, { pairs: 8 });
  const b = pinnateVenation(outline, { pairs: 8 });
  assert.deepStrictEqual(a, b);
  for (const n of a.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), 'finite node');
});

// leafLobing↑ → more lobe maxima in outline x-width
test('leafLobing↑ → more lobe maxima in outline x-width', () => {
  function countXMaxima(outline) {
    const xs = outline.map(p => Math.abs(p.x));
    let count = 0;
    const N = xs.length;
    for (let i = 1; i < N - 1; i++) {
      if (xs[i] > xs[i-1] && xs[i] > xs[i+1]) count++;
    }
    return count;
  }
  const lo = countXMaxima(makeOutline({ leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 0.0 }, 120));
  const hi = countXMaxima(makeOutline({ leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 1.0 }, 120));
  assert.ok(hi > lo, `leafLobing: high lobing maxima count ${hi} should exceed low ${lo}`);
});

// determinism: same genes → identical outline
test('superformulaOutline is deterministic: same genes → identical outline', () => {
  const genes = { leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0.3, leafLobing: 0.2 };
  const o1 = makeOutline(genes, 120);
  const o2 = makeOutline(genes, 120);
  assert.deepStrictEqual(o1, o2, 'outline should be identical for same gene inputs');
});

// ---------------------------------------------------------------------------
// Maple-region tests — high leafLobing produces palmate maple-like shape
// ---------------------------------------------------------------------------

/**
 * Compute the raw superformula radii for a given gene set.
 * Works directly on the un-rotated polar form so lobe/sinus counting is unambiguous.
 */
function rawRadii(genes, steps = 720) {
  const params = leafBaseParams(genes);
  const { m, n1, n2, n3, a = 1, b = 1 } = params;
  const radii = [];
  for (let i = 0; i < steps; i++) {
    const theta = (2 * Math.PI * i) / steps;
    const t = m * theta / 4;
    const cosT = Math.abs(Math.cos(t) / a);
    const sinT = Math.abs(Math.sin(t) / b);
    const inner = Math.pow(cosT, n2) + Math.pow(sinT, n3);
    const r = inner === 0 ? 0 : Math.pow(inner, -1 / n1);
    radii.push(Number.isFinite(r) ? r : 0);
  }
  return radii;
}

/** Smooth a circular array with a 5-sample box filter to eliminate sampling noise. */
function smooth5(arr) {
  const N = arr.length;
  return arr.map((_, i) => {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += arr[(i + d + N) % N];
    return s / 5;
  });
}

/** Count local peaks in a (smoothed) circular signal. */
function countPeaks(arr) {
  const N = arr.length;
  let count = 0;
  for (let i = 0; i < N; i++) {
    const prev = arr[(i - 1 + N) % N];
    const next = arr[(i + 1) % N];
    if (arr[i] > prev && arr[i] > next) count++;
  }
  return count;
}

/** min(r) / max(r) ratio — 1.0 = no sinus; near 0 = deep maple sinuses. */
function sinusDepthRatio(radii) {
  const maxR = Math.max(...radii);
  const minR = Math.min(...radii);
  return minR / maxR;
}

test('maple: high leafLobing → 5 radial lobe peaks', () => {
  const genes = { leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 1.0 };
  const peaks = countPeaks(smooth5(rawRadii(genes)));
  assert.strictEqual(peaks, 5, `expected 5 lobe peaks for leafLobing=1, got ${peaks}`);
});

test('maple: sinus depth increases monotonically with leafLobing', () => {
  const levels = [0.0, 0.25, 0.5, 0.75, 1.0];
  const ratios = levels.map(l => sinusDepthRatio(rawRadii({ leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: l })));
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(
      ratios[i] < ratios[i - 1],
      `sinus depth ratio should decrease (deeper sinuses) as leafLobing rises: ${levels[i-1]}→${levels[i]} got ${ratios[i-1].toFixed(4)}→${ratios[i].toFixed(4)}`
    );
  }
});

test('maple: high leafLobing sinus depth ratio < 0.02 (deep maple notches)', () => {
  const genes = { leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 1.0 };
  const ratio = sinusDepthRatio(rawRadii(genes));
  assert.ok(ratio < 0.02, `expected deep sinuses (ratio<0.02) at leafLobing=1, got ${ratio.toFixed(5)}`);
});

test('maple: low leafLobing (0) sinus depth ratio > 0.45 (smooth ovate, no deep notches)', () => {
  const genes = { leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 0.0 };
  const ratio = sinusDepthRatio(rawRadii(genes));
  assert.ok(ratio > 0.45, `expected smooth ovate (ratio>0.45) at leafLobing=0, got ${ratio.toFixed(5)}`);
});

test('maple: high leafLobing → lobe tips are pointed (n1 decreases with lobing)', () => {
  // Lower n1 in the superformula → sharper/more pointed lobe apices.
  const low  = leafBaseParams({ leafLobing: 0.0 });
  const high = leafBaseParams({ leafLobing: 1.0 });
  assert.ok(high.n1 < low.n1, `n1 should decrease with leafLobing: ${low.n1.toFixed(3)} → ${high.n1.toFixed(3)}`);
});

test('maple: high leafLobing → wider aspect ratio (palmate proportions)', () => {
  // A palmate leaf is roughly as wide as tall; at lobing=0 the outline is tall and narrow.
  const lo = aspectRatio(makeOutline({ leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 0.0 }));
  const hi = aspectRatio(makeOutline({ leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 1.0 }));
  assert.ok(hi > lo * 2, `high-lobing aspect ratio (${hi.toFixed(3)}) should be at least 2× wider than low-lobing (${lo.toFixed(3)})`);
});

test('maple: leafSerration boosts are additive with leafLobing (teeth on lobe edges)', () => {
  // At high lobing, serration amplitude is boosted — perimeter of serrated+lobed > lobed alone.
  const lobedOnly     = leafBaseParams({ leafLobing: 1.0, leafSerration: 0.5 });
  const lobedSerrated = leafBaseParams({ leafLobing: 1.0, leafSerration: 1.0 });
  assert.ok(
    lobedSerrated.serration > lobedOnly.serration,
    `higher leafSerration should increase serration at high lobing: ${lobedOnly.serration.toFixed(4)} → ${lobedSerrated.serration.toFixed(4)}`
  );
  // The boost factor means serration is larger at high lobing vs low lobing for same gene value
  const lowLobing  = leafBaseParams({ leafLobing: 0.0, leafSerration: 0.5 });
  const highLobing = leafBaseParams({ leafLobing: 1.0, leafSerration: 0.5 });
  assert.ok(
    highLobing.serration > lowLobing.serration,
    `serration amplitude at high lobing (${highLobing.serration.toFixed(4)}) should exceed low lobing (${lowLobing.serration.toFixed(4)}) for same leafSerration gene`
  );
});

test('maple: simple-ovate (leafLobing=0) outline is smooth — no radial peaks besides the 2 expected', () => {
  const genes = { leafWidth: 0.5, leafLength: 0.45, leafTip: 0.4, leafSerration: 0, leafLobing: 0.0 };
  const peaks = countPeaks(smooth5(rawRadii(genes)));
  // A simple ovate (m=2) has exactly 2 peaks (left and right of tip in the superformula)
  assert.strictEqual(peaks, 2, `expected 2 peaks for simple ovate (leafLobing=0), got ${peaks}`);
});

test('maple: determinism — same genes → identical leafBaseParams and outline', () => {
  const genes = { leafWidth: 0.6, leafLength: 0.3, leafTip: 0.5, leafSerration: 0.4, leafLobing: 1.0 };
  const p1 = leafBaseParams(genes);
  const p2 = leafBaseParams(genes);
  assert.deepStrictEqual(p1, p2, 'leafBaseParams should be deterministic');
  const o1 = makeOutline(genes, 360);
  const o2 = makeOutline(genes, 360);
  assert.deepStrictEqual(o1, o2, 'outline should be deterministic for maple genes');
});

// ---------------------------------------------------------------------------
// makeLeafClusterTexture dispatch (leafDivision) — Node guards + helper purity.
// (The old needle-fascicle path was removed: a needle is now a narrow broadleaf.)
// ---------------------------------------------------------------------------

test('makeLeafClusterTexture returns null in Node regardless of leafDivision (no document)', () => {
  assert.strictEqual(typeof document, 'undefined');
  assert.strictEqual(makeLeafClusterTexture({ pigment: 0.4, breadth: 0.5, seed: 1, leafDivision: 0 }), null);
  assert.strictEqual(makeLeafClusterTexture({ pigment: 0.4, breadth: 0.5, seed: 1, leafDivision: 1 }), null);
});

test('clusterLeafParams is a pure function of (seed, count)', () => {
  const seed  = 77;
  const count = clusterLeafCount(seed);
  const pA    = clusterLeafParams(seed, count);
  const pB    = clusterLeafParams(seed, count);
  assert.deepStrictEqual(pA, pB, 'broadleaf cluster params must be deterministic for the same seed');
});

// ---------------------------------------------------------------------------
// frondLeaf gene tests — frondLeafletParams pure-math assertions
// ---------------------------------------------------------------------------

test('frondLeafletParams returns the requested leaflet count', () => {
  for (const count of [8, 12, 16, 20]) {
    const leaflets = frondLeafletParams(42, count);
    assert.strictEqual(leaflets.length, count, `expected ${count} leaflets`);
  }
});

test('frondLeafletParams each leaflet has finite t/angle/length', () => {
  const leaflets = frondLeafletParams(7, 20);
  for (const l of leaflets) {
    assert.ok(Number.isFinite(l.t),      `t must be finite, got ${l.t}`);
    assert.ok(Number.isFinite(l.angle),  `angle must be finite, got ${l.angle}`);
    assert.ok(Number.isFinite(l.length), `length must be finite, got ${l.length}`);
  }
});

test('frondLeafletParams t values are in [0, 1]', () => {
  const leaflets = frondLeafletParams(13, 20);
  for (const l of leaflets) {
    assert.ok(l.t >= 0 && l.t <= 1, `t ${l.t} out of [0, 1]`);
  }
});

test('frondLeafletParams length values are in (0, 1]', () => {
  const leaflets = frondLeafletParams(99, 20);
  for (const l of leaflets) {
    assert.ok(l.length > 0 && l.length <= 1.0, `length ${l.length} out of (0, 1]`);
  }
});

test('frondLeafletParams leaflets span both sides (positive and negative angles)', () => {
  const leaflets = frondLeafletParams(5, 20);
  const hasPositive = leaflets.some(l => l.angle > 0);
  const hasNegative = leaflets.some(l => l.angle < 0);
  assert.ok(hasPositive, 'must have right-side leaflets (angle > 0)');
  assert.ok(hasNegative, 'must have left-side leaflets (angle < 0)');
});

test('frondLeafletParams is deterministic for the same seed', () => {
  const a = frondLeafletParams(55, 20);
  const b = frondLeafletParams(55, 20);
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(a[i].t,      b[i].t,      `t mismatch at leaflet ${i}`);
    assert.strictEqual(a[i].angle,  b[i].angle,  `angle mismatch at leaflet ${i}`);
    assert.strictEqual(a[i].length, b[i].length, `length mismatch at leaflet ${i}`);
  }
});

test('frondLeafletParams different seeds → different params', () => {
  const a = frondLeafletParams(1, 20);
  const b = frondLeafletParams(2, 20);
  const anyDiffers = a.some((l, i) => l.t !== b[i].t || l.angle !== b[i].angle);
  assert.ok(anyDiffers, 'seeds 1 and 2 should produce different frond leaflet params');
});

test('frondLeafletParams uses an isolated rng sub-stream (different from broadleaf)', () => {
  // Same seed: the frond and broadleaf sub-streams must be independent (different salts).
  const seed       = 42;
  const count      = 20;
  const frond      = frondLeafletParams(seed, count);
  const broadCount = clusterLeafCount(seed);
  const broadleaf  = clusterLeafParams(seed, broadCount);

  assert.notStrictEqual(frond[0].t, broadleaf[0].angle,
    'frond and broadleaf rng sub-streams must be independent');
});

test('makeLeafClusterTexture returns null in Node for the compound-frond path (no document)', () => {
  assert.strictEqual(typeof document, 'undefined');
  const result = makeLeafClusterTexture({ pigment: 0.4, breadth: 0.5, seed: 1, leafDivision: 1 });
  assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// Continuous blend tests — mock canvas approach.
//
// makeLeafClusterTexture is browser-only (returns null when document is absent).
// To test the blend logic in Node, we inject a minimal document/canvas mock that:
//  - records every (globalAlpha, drawImage) call pair so we can verify blend alphas.
//  - no-ops all draw primitives (fill, stroke, etc.) so the function completes cleanly.
//
// What we assert: for 0 < gene < 1, the alpha passed to drawImage for the
// "overlay" layer (needle or frond) equals the gene value, and increases
// monotonically across the sample set {0.25, 0.5, 0.75}.  At gene=0 (pure
// broadleaf) _stampAt is never called at all (direct draw, no drawImage stamp).
// At gene=1 (pure overlay) _stampAt is again not called (direct draw).
// This proves there is no discontinuous cliff at the midpoint.
// ---------------------------------------------------------------------------

/**
 * Build a minimal canvas/context mock that records globalAlpha at the moment
 * drawImage is called.  Returns { globalDoc, capturedAlphas }.
 * capturedAlphas is populated in-place after the function runs.
 */
function makeCanvasMock() {
  const capturedAlphas = [];

  // Minimal 2D context stub
  function makeCtxStub() {
    const stub = {
      _alpha: 1,
      get globalAlpha() { return this._alpha; },
      set globalAlpha(v) { this._alpha = v; },
      // Capture alpha at the moment drawImage is invoked
      drawImage(_src, _x, _y) { capturedAlphas.push(this._alpha); },
      // No-op draw primitives — covers everything called by drawLeaf,
      // drawNeedleFascicle, drawPalmFrond, and the _stampAt harness.
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      quadraticCurveTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      fillRect() {},
      ellipse() {},
      translate() {},
      rotate() {},
      scale() {},
      createLinearGradient() {
        return { addColorStop() {} };
      },
      get strokeStyle() { return ''; },
      set strokeStyle(_v) {},
      get fillStyle() { return ''; },
      set fillStyle(_v) {},
      get lineWidth() { return 1; },
      set lineWidth(_v) {},
      get lineCap() { return 'butt'; },
      set lineCap(_v) {},
      get globalCompositeOperation() { return 'source-over'; },
      set globalCompositeOperation(_v) {},
    };
    return stub;
  }

  // Minimal canvas stub — getContext always returns a fresh ctx stub so each
  // canvas (main + scratch) has its own alpha tracker.
  function makeCanvasStub() {
    const ctxStub = makeCtxStub();
    return {
      width: 0,
      height: 0,
      getContext(_type) { return ctxStub; },
    };
  }

  const globalDoc = {
    createElement(tag) {
      if (tag === 'canvas') return makeCanvasStub();
      throw new Error(`mock document.createElement: unsupported tag "${tag}"`);
    },
  };

  return { globalDoc, capturedAlphas };
}

/**
 * Run makeLeafClusterTexture with a mock document injected as a global.
 * Returns the array of globalAlpha values captured at each drawImage call.
 */
async function runWithMock(args) {
  // We need to temporarily define `document` in global scope so the module
  // branch `typeof document === 'undefined'` returns false.
  // Node modules use `globalThis`; we set and delete it around the call.
  const { globalDoc, capturedAlphas } = makeCanvasMock();
  globalThis.document = globalDoc;
  try {
    makeLeafClusterTexture(args);
  } finally {
    delete globalThis.document;
  }
  return capturedAlphas;
}

// ---------------------------------------------------------------------------
// leafDivision blend tests — simple blade (0) ↔ compound frond (1), via mock canvas
// ---------------------------------------------------------------------------

test('leafDivision blend: overlay alpha increases monotonically (no 0.5 cliff)', async () => {
  // At intermediate leafDivision the compound-frond overlay is stamped via drawImage
  // at globalAlpha = leafDivision, over the simple blade at (1 - leafDivision).
  const levels = [0.25, 0.5, 0.75];
  const overlayAlphas = [];
  for (const d of levels) {
    const alphas = await runWithMock({ pigment: 0.35, seed: 7, leafDivision: d });
    assert.strictEqual(alphas.length, 2,
      `leafDivision=${d}: expected 2 drawImage stamps, got ${alphas.length}`);
    assert.ok(Math.abs(alphas[0] - (1 - d)) < 1e-10,
      `leafDivision=${d}: blade stamp alpha should be ${1-d}, got ${alphas[0]}`);
    assert.ok(Math.abs(alphas[1] - d) < 1e-10,
      `leafDivision=${d}: frond stamp alpha should be ${d}, got ${alphas[1]}`);
    overlayAlphas.push(alphas[1]);
  }
  for (let i = 1; i < overlayAlphas.length; i++) {
    assert.ok(overlayAlphas[i] > overlayAlphas[i - 1],
      `frond overlay alpha not monotone: ${overlayAlphas[i - 1]} → ${overlayAlphas[i]}`);
  }
  assert.ok(overlayAlphas[1] > overlayAlphas[0] && overlayAlphas[1] < overlayAlphas[2],
    'leafDivision=0.5 overlay alpha must be strictly between the 0.25 and 0.75 values');
});

test('leafDivision=0: simple blade — no drawImage stamps (drawn directly)', async () => {
  const alphas = await runWithMock({ pigment: 0.35, seed: 7, leafDivision: 0 });
  assert.strictEqual(alphas.length, 0,
    'leafDivision=0 must not call drawImage — simple blade drawn directly onto main ctx');
});

test('leafDivision=1: compound frond — no drawImage stamps (drawn directly)', async () => {
  const alphas = await runWithMock({ pigment: 0.35, seed: 7, leafDivision: 1 });
  assert.strictEqual(alphas.length, 0,
    'leafDivision=1 must not call drawImage — frond drawn directly onto main ctx');
});

// ---------------------------------------------------------------------------
// Determinism + broadleaf-helper purity for the merged leafDivision dispatch.
// ---------------------------------------------------------------------------

test('leafDivision=0 → simple-blade path: cluster leaf params are pure/deterministic', () => {
  const seed  = 42;
  const count = clusterLeafCount(seed);
  const pA    = clusterLeafParams(seed, count);
  const pB    = clusterLeafParams(seed, count);
  assert.deepStrictEqual(pA, pB,
    'simple-blade cluster params must be deterministic for the same seed');
});

test('leafDivision blend determinism: same args produce same alpha stamps', async () => {
  const args = { pigment: 0.35, seed: 11, leafDivision: 0.5 };
  const run1 = await runWithMock(args);
  const run2 = await runWithMock(args);
  assert.deepStrictEqual(run1, run2,
    'leafDivision blend alpha stamps must be identical for identical inputs (determinism)');
});

// ---------------------------------------------------------------------------
// Card-aspect factors — leafWidth → card X, leafLength → card Y, DECOUPLED.
//
// These are the single-leaf RENDER path's width:length mapping (applied by
// leafMesh.setLeafAspect). The independence the genes lost (both collapsing onto
// the same axis because the sprite was self-normalized) is restored here: width
// drives ONLY the X factor and length ONLY the Y factor.
// ---------------------------------------------------------------------------

test('leafWidthFactor: ≈1.0 at the default leafWidth (0.5), monotonically increasing', () => {
  assert.ok(Math.abs(leafWidthFactor(0.5) - 1.0) < 1e-9, `default should be ~1.0, got ${leafWidthFactor(0.5)}`);
  const levels = [0.0, 0.25, 0.5, 0.75, 1.0];
  for (let i = 1; i < levels.length; i++) {
    assert.ok(leafWidthFactor(levels[i]) > leafWidthFactor(levels[i - 1]),
      `leafWidthFactor should increase with leafWidth at ${levels[i]}`);
  }
});

test('leafLengthFactor: ≈1.0 at the default leafLength (0.45), monotonically increasing', () => {
  assert.ok(Math.abs(leafLengthFactor(0.45) - 1.0) < 1e-9, `default should be ~1.0, got ${leafLengthFactor(0.45)}`);
  const levels = [0.0, 0.25, 0.45, 0.7, 1.0];
  for (let i = 1; i < levels.length; i++) {
    assert.ok(leafLengthFactor(levels[i]) > leafLengthFactor(levels[i - 1]),
      `leafLengthFactor should increase with leafLength at ${levels[i]}`);
  }
});

test('card aspect decouples width and length (each gene drives only its own axis)', () => {
  // leafLength changes the Y (length) factor but NOT the X (width) factor:
  const wAtShort = leafWidthFactor(0.5);
  const wAtLong  = leafWidthFactor(0.5);          // width gene fixed
  assert.strictEqual(wAtShort, wAtLong, 'width factor must be independent of length');
  assert.ok(leafLengthFactor(0.9) > leafLengthFactor(0.1), 'length gene drives the Y factor');

  // leafWidth changes the X (width) factor but NOT the Y (length) factor:
  const lAtNarrow = leafLengthFactor(0.45);
  const lAtWide   = leafLengthFactor(0.45);       // length gene fixed
  assert.strictEqual(lAtNarrow, lAtWide, 'length factor must be independent of width');
  assert.ok(leafWidthFactor(0.9) > leafWidthFactor(0.1), 'width gene drives the X factor');

  // Both factors are strictly positive (no zero-area cards).
  for (const v of [0, 0.5, 1]) {
    assert.ok(leafWidthFactor(v) > 0 && leafLengthFactor(v) > 0);
  }
});

test('card aspect factors are pure/deterministic', () => {
  assert.strictEqual(leafWidthFactor(0.3), leafWidthFactor(0.3));
  assert.strictEqual(leafLengthFactor(0.7), leafLengthFactor(0.7));
});
