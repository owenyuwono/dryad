// =============================================================================
// inspectorPanels.test.mjs — pure-layer tests for the part-inspector dock.
//
// The 2D draw functions and the bark swatch (barkSwatch.js, WebGL) are
// render-only and USER-VERIFIED. What IS testable here is the PURE sampling
// math the panels are built on + the registry bookkeeping, plus the structural
// guarantee that this module imports no three.js (so it stays Node-loadable).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  leafSilhouettePoints,
  crossSectionPoints,
  pigmentRampColors,
  createInspectorRegistry,
} from '../src/inspectorPanels.js';
import { pigmentToColor } from '../src/colorRamp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// leafSilhouettePoints — pure, deterministic, finite.
// ---------------------------------------------------------------------------

test('leafSilhouettePoints returns `steps` finite points', () => {
  const pts = leafSilhouettePoints({ leafWidth: 0.5, leafLength: 0.45, leafLobing: 0 }, 120);
  assert.equal(pts.length, 120);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `non-finite point ${JSON.stringify(p)}`);
  }
});

test('leafSilhouettePoints is deterministic (no rng) — same genes twice → deep-equal', () => {
  const genes = { leafWidth: 0.7, leafLength: 0.6, leafTip: 0.5, leafSerration: 0.2, leafLobing: 0.4 };
  assert.deepStrictEqual(leafSilhouettePoints(genes, 96), leafSilhouettePoints(genes, 96));
});

test('leafSilhouettePoints: lobing changes the outline (maple ≠ ovate)', () => {
  const ovate = leafSilhouettePoints({ leafLobing: 0 }, 120);
  const maple = leafSilhouettePoints({ leafLobing: 1 }, 120);
  const diff = ovate.some((p, i) => Math.abs(p.x - maple[i].x) > 1e-6 || Math.abs(p.y - maple[i].y) > 1e-6);
  assert.ok(diff, 'leafLobing=0 and leafLobing=1 should yield different outlines');
});

// ---------------------------------------------------------------------------
// crossSectionPoints — identity circle at rest; flatness/ribbing deform.
// ---------------------------------------------------------------------------

test('crossSectionPoints: ribbing=0 flatness=0 → unit circle (all radius ≈ 1)', () => {
  const pts = crossSectionPoints({ ribbing: 0, ribCount: 10, flatness: 0 }, 180);
  assert.equal(pts.length, 180);
  for (const p of pts) {
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - 1) < 1e-9, `point off unit circle: ${Math.hypot(p.x, p.y)}`);
  }
});

test('crossSectionPoints: flatness squashes the x-axis (max|x| < max|y|)', () => {
  const pts = crossSectionPoints({ ribbing: 0, ribCount: 10, flatness: 0.8 }, 180);
  const maxX = Math.max(...pts.map((p) => Math.abs(p.x)));
  const maxY = Math.max(...pts.map((p) => Math.abs(p.y)));
  assert.ok(maxX < maxY, `expected flattened section: maxX=${maxX} maxY=${maxY}`);
});

test('crossSectionPoints: ribbing introduces sub-unit radii (flutes)', () => {
  const pts = crossSectionPoints({ ribbing: 1, ribCount: 8, flatness: 0 }, 240);
  const minR = Math.min(...pts.map((p) => Math.hypot(p.x, p.y)));
  assert.ok(minR < 0.999, `expected flutes cutting inward, minR=${minR}`);
});

test('crossSectionPoints is deterministic', () => {
  const opts = { ribbing: 0.5, ribCount: 12, flatness: 0.3 };
  assert.deepStrictEqual(crossSectionPoints(opts, 100), crossSectionPoints(opts, 100));
});

// ---------------------------------------------------------------------------
// pigmentRampColors — endpoints + length.
// ---------------------------------------------------------------------------

test('pigmentRampColors: length N, endpoints match pigmentToColor(0)/(1)', () => {
  const cols = pigmentRampColors(64);
  assert.equal(cols.length, 64);
  assert.deepStrictEqual(cols[0], pigmentToColor(0));
  assert.deepStrictEqual(cols[63], pigmentToColor(1));
  for (const c of cols) {
    assert.equal(c.length, 3);
    for (const ch of c) assert.ok(ch >= 0 && ch <= 1, `channel out of [0,1]: ${ch}`);
  }
});

test('pigmentRampColors(1) handles the divide-by-zero edge (single column)', () => {
  assert.deepStrictEqual(pigmentRampColors(1), [pigmentToColor(0)]);
});

// ---------------------------------------------------------------------------
// createInspectorRegistry — bookkeeping + error isolation.
// ---------------------------------------------------------------------------

test('registry.refresh passes {genome, resolved} from the getters to every panel', () => {
  const genome = { pigment: 0.2 };
  const resolved = { pigment: 0.2, foliage: {} };
  const seen = [];
  const reg = createInspectorRegistry({ getGenome: () => genome, getResolved: () => resolved });
  reg.register({ id: 'a', update: (ctx) => seen.push(['a', ctx]) });
  reg.register({ id: 'b', update: (ctx) => seen.push(['b', ctx]) });
  reg.refresh();
  assert.equal(seen.length, 2);
  assert.equal(seen[0][1].genome, genome);
  assert.equal(seen[0][1].resolved, resolved);
});

test('registry: one panel throwing does not stop the others', () => {
  let bRan = false;
  const reg = createInspectorRegistry({ getGenome: () => ({}), getResolved: () => ({}) });
  reg.register({ id: 'boom', update: () => { throw new Error('panel failure'); } });
  reg.register({ id: 'ok', update: () => { bRan = true; } });
  assert.doesNotThrow(() => reg.refresh());
  assert.ok(bRan, 'the second panel must still run after the first throws');
});

test('registry.dispose calls each panel dispose and clears the list', () => {
  let disposed = 0;
  const reg = createInspectorRegistry({});
  reg.register({ id: 'a', dispose: () => { disposed++; } });
  reg.register({ id: 'b', dispose: () => { disposed++; } });
  reg.dispose();
  assert.equal(disposed, 2);
  assert.equal(reg.panels.length, 0);
});

// ---------------------------------------------------------------------------
// Structural: this module must NOT import three.js (keeps it Node-loadable and
// build-covered, concentrating WebGL/onBeforeCompile risk in barkSwatch.js).
// ---------------------------------------------------------------------------

test('inspectorPanels.js imports no three.js', () => {
  const src = readFileSync(join(__dirname, '../src/inspectorPanels.js'), 'utf8');
  assert.ok(!/from\s+['"]three['"]/.test(src), 'inspectorPanels.js must not import three');
});
