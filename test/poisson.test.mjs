import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poissonDisk } from '../src/poisson.js';
import { mulberry32 } from '../src/rng.js';

test('poissonDisk: every pair is at least minDist apart', () => {
  const minDist = 1.2;
  const pts = poissonDisk({ width: 10, height: 10, minDist, rng: mulberry32(42) });
  assert.ok(pts.length > 1, 'should produce multiple points');
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
      const d = Math.hypot(dx, dy);
      assert.ok(d >= minDist - 1e-9, `pair ${i},${j} too close: ${d} < ${minDist}`);
    }
  }
});

test('poissonDisk: all points lie within bounds', () => {
  const pts = poissonDisk({ width: 8, height: 5, minDist: 0.9, rng: mulberry32(7) });
  for (const p of pts) {
    assert.ok(p.x >= 0 && p.x < 8, `x out of bounds: ${p.x}`);
    assert.ok(p.y >= 0 && p.y < 5, `y out of bounds: ${p.y}`);
  }
});

test('poissonDisk: deterministic for a given seed', () => {
  const a = poissonDisk({ width: 6, height: 6, minDist: 1.0, rng: mulberry32(123) });
  const b = poissonDisk({ width: 6, height: 6, minDist: 1.0, rng: mulberry32(123) });
  assert.deepEqual(a, b);
});

test('poissonDisk: different seeds give different layouts', () => {
  const a = poissonDisk({ width: 6, height: 6, minDist: 1.0, rng: mulberry32(1) });
  const b = poissonDisk({ width: 6, height: 6, minDist: 1.0, rng: mulberry32(2) });
  assert.notDeepEqual(a, b);
});

test('poissonDisk: respects maxPoints cap', () => {
  const pts = poissonDisk({ width: 20, height: 20, minDist: 0.8, rng: mulberry32(9), maxPoints: 6 });
  assert.ok(pts.length <= 6, `expected <= 6 points, got ${pts.length}`);
  assert.ok(pts.length >= 1);
});

test('poissonDisk: degenerate inputs return empty (no throw)', () => {
  assert.deepEqual(poissonDisk({ width: 0, height: 5, minDist: 1, rng: mulberry32(1) }), []);
  assert.deepEqual(poissonDisk({ width: 5, height: 5, minDist: 0, rng: mulberry32(1) }), []);
  assert.deepEqual(poissonDisk({ width: 5, height: 5, minDist: 1, rng: mulberry32(1), maxPoints: 0 }), []);
  assert.deepEqual(poissonDisk({ width: 5, height: 5, minDist: 1, rng: null }), []);
});
