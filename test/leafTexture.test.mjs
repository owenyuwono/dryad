import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leafHalfWidth,
  clusterLeafCount,
  clusterLeafParams,
  makeLeafClusterTexture,
  superformulaPoint,
  superformulaOutline,
  pointInPolygon,
  growVenation,
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
