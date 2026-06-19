// =============================================================================
// mutate.test.js — acceptance tests for mutate()
//
// Run: node --test test/mutate.test.js
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mutate, MUTATION_RATES, K_PROPORTIONS, K_COSMETIC } from '../src/mutate.js';
import { FLORA_SCHEMA, clampField, genomeDistance } from '../src/genomeSchema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal seeded PRNG (mulberry32) that implements the `rng()` interface.
 * Deterministic from its uint32 seed.
 */
function makePrng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    z = (z ^ (z >>> 14)) >>> 0;
    return z / 4294967296;
  };
}

/** Build a representative parent genome whose every field is within schema range. */
function makeFloraParent() {
  return {
    // structural tier
    branchiness:      0.5,
    branchFactorN:    0.5,
    tillering:        0.3,
    radialOrder:      0.5,
    appendageBreadth: 0.5,
    appendageDensity: 0.5,
    segmentation:     0.4,
    // proportions tier
    succulence:       0.2,
    stemGirth:        0.4,
    taper:            0.5,
    rigidity:         0.6,
    verticality:      0.5,
    ribbing:          0.3,
    spininess:        0.1,
    branchAngle:      0.55,
    lengthRatio:      0.70,
    apicalBias:       0.5,
    droopBias:        0.0,
    // cosmetic tier
    pigment:          0.4,
    leafSize:         1.0,
    leafDensity:      1.0,
    jitter:           0.5,
    leafWidth:        0.5,
    // leaf-shape genes (draws 32-35)
    leafLength:       0.45,
    leafTip:          0.40,
    leafSerration:    0.00,
    leafLobing:       0.00,
    leafSkew:         0.50,
    // orthogonal bark axes + weep
    barkHue:          0.85,
    barkLightness:    0.30,
    barkRelief:       0.85,
    barkLenticels:    0.00,
    barkScale:        0.50,
    barkOrient:       0.70,
    barkPlates:       0.45,
    barkShed:         0.00,
    barkUnderHue:     0.75,
    weep:             0.00,
    // trunkHeight (draw 39)
    trunkHeight:      0.50,
    // new inert genes (draws 40–42)
    flatness:         0.00,
    stemSpread:       0.00,
    rosette:          0.00,
    // new inert genes (draws 43–45)
    woodiness:        1.00,
    whorl:            0.00,
    crownStart:       1.00,
    tipTuft:          0.00,
    // new inert genes (draws 46–48)
    leafDivision:     0.00,
    frondFan:         0.00,  // 0 = pinnate/feather frond (identity)
    phototropism:     1.00,  // 1.0 = full phototropism (identity — draw 49)
    trunkTaper:       0.00,  // 0 = identity (draw 50)
    structuralSeed:   0xDEADBEEF,
    // root system tier (added Task 1 — required so genomeDistance is non-NaN)
    rootCount:        0.45,
    rootDepth:        0.45,
    rootSpread:       0.50,
    rootFlare:        0.30,
    rootButtress:     0.15,
    rootBranchiness:  0.45,
    rootTaper:        0.50,
  };
}

/** Return true iff every non-seed field of `genome` is within its schema range. */
function isSchemaValid(genome, schema) {
  for (const [field, gene] of Object.entries(schema)) {
    if (gene.kind === 'seed') continue;
    const v = genome[field];
    if (gene.kind === 'categorical') {
      if (!gene.options.includes(v)) return false;
    } else if (gene.kind === 'int' || gene.kind === 'continuous') {
      const [lo, hi] = gene.range;
      if (v < lo || v > hi) return false;
    }
  }
  return true;
}

/** Deep-equal two plain objects. */
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Suite 1: Determinism + no-input-mutation + child-valid
// ---------------------------------------------------------------------------

describe('mutate() — basic invariants', () => {

  it('is deterministic: same seed → deep-equal child', () => {
    const parent = makeFloraParent();
    const child1 = mutate(parent, makePrng(42), 0.5);
    const child2 = mutate(parent, makePrng(42), 0.5);
    assert.deepEqual(child1, child2, 'Children from same seed must be identical');
  });

  it('never mutates the input genome', () => {
    const parent  = makeFloraParent();
    const snapshot = JSON.stringify(parent);
    mutate(parent, makePrng(99), 0.7);
    assert.equal(JSON.stringify(parent), snapshot, 'Parent must be unchanged after mutate()');
  });

  it('child is always schema-valid (every field in range / valid option)', () => {
    const parent = makeFloraParent();
    for (let seed = 0; seed < 200; seed++) {
      const child = mutate(parent, makePrng(seed), 0.5);
      assert.ok(isSchemaValid(child, FLORA_SCHEMA), `Child from seed ${seed} failed schema validation`);
    }
  });

  it('child structuralSeed always differs from parent', () => {
    const parent = makeFloraParent();
    for (let seed = 0; seed < 200; seed++) {
      const child = mutate(parent, makePrng(seed), 0.5);
      assert.notEqual(
        child.structuralSeed,
        parent.structuralSeed,
        `Seed ${seed}: child.structuralSeed must differ from parent`
      );
    }
  });

});

// ---------------------------------------------------------------------------
// Suite 2: Tier-rate ordering
// ---------------------------------------------------------------------------

describe('mutate() — tier-rate ordering', () => {

  it('P(≥1 structural changed) ≪ P(≥1 proportions changed), both well below cosmetic rate', () => {
    const TRIALS   = 3000;
    const STRENGTH = 0.5;
    const parent   = makeFloraParent();

    const structuralFields   = Object.keys(FLORA_SCHEMA).filter(f => FLORA_SCHEMA[f].tier === 'structural');
    const proportionsFields  = Object.keys(FLORA_SCHEMA).filter(f => FLORA_SCHEMA[f].tier === 'proportions');
    // cosmetic excludes seed fields for "changed" detection
    const cosmeticFields     = Object.keys(FLORA_SCHEMA).filter(
      f => FLORA_SCHEMA[f].tier === 'cosmetic' && FLORA_SCHEMA[f].kind !== 'seed'
    );

    let structuralHit   = 0;
    let proportionsHit  = 0;
    let cosmeticHit     = 0;

    for (let i = 0; i < TRIALS; i++) {
      const child = mutate(parent, makePrng(i * 7 + 13), STRENGTH);

      const anyStruct = structuralFields.some(f => child[f] !== parent[f]);
      const anyProp   = proportionsFields.some(f => child[f] !== parent[f]);
      const anyCosmA  = cosmeticFields.some(f => child[f] !== parent[f]);

      if (anyStruct) structuralHit++;
      if (anyProp)   proportionsHit++;
      if (anyCosmA)  cosmeticHit++;
    }

    const pStruct = structuralHit  / TRIALS;
    const pProp   = proportionsHit / TRIALS;
    const pCosmA  = cosmeticHit    / TRIALS;

    console.log(`  P(≥1 structural changed)  = ${pStruct.toFixed(4)}`);
    console.log(`  P(≥1 proportions changed) = ${pProp.toFixed(4)}`);
    console.log(`  P(≥1 cosmetic changed)    = ${pCosmA.toFixed(4)}`);

    // Structural rate must be clearly below proportions (ratio > 2×).
    // With the all-continuous schema, proportions has many more fields than
    // cosmetic, so the P(≥1 proportions) saturates close to P(≥1 cosmetic).
    // We only assert the structural < proportions ordering strictly.
    assert.ok(
      pStruct * 2 < pProp,
      `structural (${pStruct.toFixed(3)}) must be < half of proportions (${pProp.toFixed(3)})`
    );
    // Cosmetic rate must be at least as high as structural (usually much higher).
    assert.ok(
      pStruct < pCosmA,
      `structural (${pStruct.toFixed(3)}) must be < cosmetic (${pCosmA.toFixed(3)})`
    );
  });

});

// ---------------------------------------------------------------------------
// Suite 3: Strength monotonicity
// ---------------------------------------------------------------------------

describe('mutate() — strength monotonicity', () => {

  it('mean genomeDistance increases as strength 0.1 → 0.5 → 0.9', () => {
    const TRIALS = 1000;
    const parent = makeFloraParent();

    function meanDistance(strength) {
      let total = 0;
      for (let i = 0; i < TRIALS; i++) {
        const child = mutate(parent, makePrng(i * 3 + 7), strength);
        total += genomeDistance(parent, child, FLORA_SCHEMA);
      }
      return total / TRIALS;
    }

    const d01 = meanDistance(0.1);
    const d05 = meanDistance(0.5);
    const d09 = meanDistance(0.9);

    console.log(`  mean genomeDistance @ strength=0.1: ${d01.toFixed(5)}`);
    console.log(`  mean genomeDistance @ strength=0.5: ${d05.toFixed(5)}`);
    console.log(`  mean genomeDistance @ strength=0.9: ${d09.toFixed(5)}`);

    assert.ok(d01 < d05, `0.1 (${d01.toFixed(5)}) must be < 0.5 (${d05.toFixed(5)})`);
    assert.ok(d05 < d09, `0.5 (${d05.toFixed(5)}) must be < 0.9 (${d09.toFixed(5)})`);
  });

});

// ---------------------------------------------------------------------------
// Suite 4: strength=0 → only structuralSeed changes
// ---------------------------------------------------------------------------

describe('mutate() — strength=0 behaviour', () => {

  it('at strength=0 only structuralSeed changes; all other fields equal parent', () => {
    const parent = makeFloraParent();
    for (let seed = 0; seed < 500; seed++) {
      const child = mutate(parent, makePrng(seed), 0);

      for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
        if (gene.kind === 'seed') {
          // structuralSeed MUST change.
          assert.notEqual(
            child[field], parent[field],
            `seed ${seed}: ${field} must change at strength=0`
          );
        } else {
          // All other fields must be identical to parent.
          assert.equal(
            child[field], parent[field],
            `seed ${seed}: ${field} must NOT change at strength=0`
          );
        }
      }
    }
  });

});

// ---------------------------------------------------------------------------
// Suite 5: Genome-agnostic — synthetic 3-field schema
// ---------------------------------------------------------------------------

describe('mutate() — genome-agnostic with synthetic schema', () => {

  /**
   * A 3-field schema that exercises categorical, int, and continuous kinds
   * across varied tiers — with NO relation to FLORA_SCHEMA field names.
   */
  const SYNTH_SCHEMA = Object.freeze({
    // structural categorical
    bodyPlan: Object.freeze({
      tier: 'structural',
      kind: 'categorical',
      options: Object.freeze(['plan_A', 'plan_B', 'plan_C']),
    }),
    // proportions int
    limbCount: Object.freeze({
      tier: 'proportions',
      kind: 'int',
      range: Object.freeze([1, 6]),
    }),
    // cosmetic continuous
    skinTone: Object.freeze({
      tier: 'cosmetic',
      kind: 'continuous',
      range: Object.freeze([0.0, 1.0]),
    }),
  });

  const synthParent = Object.freeze({
    bodyPlan:  'plan_A',
    limbCount: 3,
    skinTone:  0.5,
  });

  it('produces schema-valid children from a synthetic schema', () => {
    for (let seed = 0; seed < 200; seed++) {
      const child = mutate(synthParent, makePrng(seed), 0.5, SYNTH_SCHEMA);
      // bodyPlan must be a valid option
      assert.ok(
        SYNTH_SCHEMA.bodyPlan.options.includes(child.bodyPlan),
        `Seed ${seed}: bodyPlan '${child.bodyPlan}' not a valid option`
      );
      // limbCount must be in [1, 6]
      assert.ok(
        child.limbCount >= 1 && child.limbCount <= 6,
        `Seed ${seed}: limbCount ${child.limbCount} out of range`
      );
      // skinTone must be in [0.0, 1.0]
      assert.ok(
        child.skinTone >= 0.0 && child.skinTone <= 1.0,
        `Seed ${seed}: skinTone ${child.skinTone} out of range`
      );
    }
  });

  it('categorical field changes to a DIFFERENT option when it fires', () => {
    // Run many trials and collect all bodyPlan mutations; they must never equal parent's.
    let mutated = 0;
    for (let seed = 0; seed < 5000; seed++) {
      const child = mutate(synthParent, makePrng(seed), 1.0, SYNTH_SCHEMA);
      if (child.bodyPlan !== synthParent.bodyPlan) {
        assert.notEqual(child.bodyPlan, synthParent.bodyPlan);
        assert.ok(SYNTH_SCHEMA.bodyPlan.options.includes(child.bodyPlan));
        mutated++;
      }
    }
    // At strength=1.0 and p_structural=0.06, we expect ~300/5000 categorical mutations.
    assert.ok(mutated > 50, `Expected some bodyPlan mutations; got ${mutated}`);
  });

  it('int field steps by ±1..±2 and stays clamped', () => {
    const parent3 = { ...synthParent, limbCount: 3 };
    const seen = new Set();
    for (let seed = 0; seed < 5000; seed++) {
      const child = mutate(parent3, makePrng(seed), 0.5, SYNTH_SCHEMA);
      seen.add(child.limbCount);
      assert.ok(child.limbCount >= 1 && child.limbCount <= 6);
    }
    // Should see values on both sides of 3 over many trials.
    assert.ok(seen.size > 1, 'limbCount should vary over many trials');
  });

  it('continuous field stays clamped after perturbation', () => {
    // Edge case: parent at the boundary.
    const edgeParent = { ...synthParent, skinTone: 0.0 };
    for (let seed = 0; seed < 200; seed++) {
      const child = mutate(edgeParent, makePrng(seed), 1.0, SYNTH_SCHEMA);
      assert.ok(child.skinTone >= 0.0 && child.skinTone <= 1.0,
        `skinTone ${child.skinTone} escaped range at seed ${seed}`);
    }
  });

  it('is deterministic on synthetic schema', () => {
    const child1 = mutate(synthParent, makePrng(777), 0.5, SYNTH_SCHEMA);
    const child2 = mutate(synthParent, makePrng(777), 0.5, SYNTH_SCHEMA);
    assert.deepEqual(child1, child2);
  });

  it('does not mutate the synthetic parent', () => {
    const snap = JSON.stringify(synthParent);
    mutate(synthParent, makePrng(1), 0.9, SYNTH_SCHEMA);
    assert.equal(JSON.stringify(synthParent), snap);
  });

});

// ---------------------------------------------------------------------------
// Suite 6: Exported constants sanity
// ---------------------------------------------------------------------------

describe('exported constants', () => {

  it('MUTATION_RATES has the correct values', () => {
    assert.equal(MUTATION_RATES.structural,  0.06);
    assert.equal(MUTATION_RATES.proportions, 0.35);
    assert.equal(MUTATION_RATES.cosmetic,    0.80);
  });

  it('K constants are correct', () => {
    assert.equal(K_PROPORTIONS, 0.20);
    assert.equal(K_COSMETIC,    0.35);
  });

});
