import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSizeFactor,
  deriveTraits,
  GIRTH_EXP,
  LEAF_AREA_EXP,
  TIER_EXP,
} from '../src/allometry.js';

// ---------------------------------------------------------------------------
// IDENTITY: at trunkHeight=0.5 (sizeFactor=1) every derived scale is a no-op.
// This is the load-bearing determinism guarantee — default-stature plants must
// be byte-identical to the pre-allometry pipeline.
// ---------------------------------------------------------------------------

test('computeSizeFactor(0.5) === exactly 1.0 (bit-exact identity)', () => {
  assert.strictEqual(computeSizeFactor(0.5), 1.0);
  assert.strictEqual(computeSizeFactor(), 1.0); // default arg
});

test('deriveTraits at trunkHeight=0.5 → all scales identity (1.0 / bonus 0)', () => {
  const t = deriveTraits({ trunkHeight: 0.5 });
  assert.strictEqual(t.sizeFactor, 1.0);
  assert.strictEqual(t.girthScale, 1.0);
  assert.strictEqual(t.leafAreaScale, 1.0);
  assert.strictEqual(t.tierCountScale, 1.0);
  assert.strictEqual(t.rootScale, 1.0);
  assert.strictEqual(t.branchOrderBonus, 0);
});

test('deriveTraits with empty genome (trunkHeight undefined) → identity', () => {
  const t = deriveTraits({});
  assert.strictEqual(t.sizeFactor, 1.0);
  assert.strictEqual(t.girthScale, 1.0);
  assert.strictEqual(t.branchOrderBonus, 0);
});

// ---------------------------------------------------------------------------
// NEAR-DEFAULT HEIGHTS (oak/birch ≈ 0.515) must NOT shift the integer bonus,
// so their golden-pinned node/foliage counts stay byte-identical.
// ---------------------------------------------------------------------------

test('branchOrderBonus is 0 for near-default stature (oak/birch trunkHeight≈0.515)', () => {
  for (const th of [0.50, 0.5059965573296284, 0.5146918888426049, 0.5337214213881903, 0.48, 0.52]) {
    assert.strictEqual(deriveTraits({ trunkHeight: th }).branchOrderBonus, 0,
      `branchOrderBonus must round to 0 at trunkHeight=${th}`);
  }
});

// ---------------------------------------------------------------------------
// MONOTONICITY: every "more size" scale increases with trunkHeight.
// ---------------------------------------------------------------------------

test('sizeFactor and derived scales increase monotonically with trunkHeight', () => {
  let prev = null;
  for (let i = 0; i <= 50; i++) {
    const th = i / 50;
    const t = deriveTraits({ trunkHeight: th });
    if (prev) {
      assert.ok(t.sizeFactor   > prev.sizeFactor,   `sizeFactor not increasing at th=${th}`);
      // girth is DECOUPLED from trunkHeight (GIRTH_EXP=0) → constant 1.0 at every height.
      assert.strictEqual(t.girthScale, 1.0, `girthScale must stay 1.0 (decoupled) at th=${th}`);
      assert.ok(t.leafAreaScale > prev.leafAreaScale, `leafAreaScale not increasing at th=${th}`);
      assert.ok(t.tierCountScale > prev.tierCountScale, `tierCountScale not increasing at th=${th}`);
      assert.ok(t.branchOrderBonus >= prev.branchOrderBonus, `branchOrderBonus not non-decreasing at th=${th}`);
    }
    prev = t;
  }
});

// ---------------------------------------------------------------------------
// BOUNDED + DIRECTION: extremes are finite and point the right way.
// ---------------------------------------------------------------------------

test('extremes are finite and tall ⇒ same girth / more tiers / more orders', () => {
  const tall  = deriveTraits({ trunkHeight: 1.0 });
  const short = deriveTraits({ trunkHeight: 0.0 });
  for (const k of ['sizeFactor', 'girthScale', 'leafAreaScale', 'tierCountScale', 'rootScale']) {
    assert.ok(Number.isFinite(tall[k]) && tall[k] > 0, `${k} not finite/positive at max`);
    assert.ok(Number.isFinite(short[k]) && short[k] > 0, `${k} not finite/positive at min`);
  }
  assert.strictEqual(tall.sizeFactor, 10.0);            // 10^(2*0.5)
  assert.strictEqual(tall.girthScale, 1.0);             // girth DECOUPLED from height (GIRTH_EXP=0)
  assert.ok(tall.branchOrderBonus >= 1);                // tall gains ≥1 branch order
  assert.ok(short.branchOrderBonus <= 0);               // short sheds (or 0)
  assert.ok(GIRTH_EXP === 0 && LEAF_AREA_EXP < 1 && TIER_EXP < 1); // girth decoupled; area/tiers sub-linear
});

test('deriveTraits is deterministic (same genome → same traits)', () => {
  for (const th of [0.0, 0.25, 0.5, 0.72, 1.0]) {
    assert.deepStrictEqual(deriveTraits({ trunkHeight: th }), deriveTraits({ trunkHeight: th }));
  }
});
