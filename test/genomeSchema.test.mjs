// =============================================================================
// genomeSchema.test.mjs — contract tests for the continuous FLORA_SCHEMA
//
// Run: node --test test/genomeSchema.test.mjs
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FLORA_SCHEMA,
  STRUCTURAL_FIELDS,
  PROPORTIONS_FIELDS,
  COSMETIC_FIELDS,
  clampField,
  genomeDistance,
  FAUNA_SCHEMA_STUB,
} from '../src/genomeSchema.js';

import { mutate } from '../src/mutate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** mulberry32 — deterministic uniform [0,1) PRNG used by the project. */
function mulberry32(seed) {
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

/**
 * Build a mid-range sample genome with every gene in FLORA_SCHEMA set to a
 * value well within its valid range so it is a useful parent for mutate().
 */
function makeSampleGenome() {
  const g = {};
  for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
    if (gene.kind === 'continuous') {
      const [lo, hi] = gene.range;
      // Use the midpoint of each field's range.
      g[field] = (lo + hi) / 2;
    } else if (gene.kind === 'seed') {
      g[field] = 0xCAFEBABE >>> 0;
    }
  }
  return g;
}

/**
 * Return true iff the genome passes schema validity:
 *   continuous → value in [lo, hi]
 *   seed       → value === (value >>> 0)  (uint32)
 */
function isSchemaValid(genome, schema) {
  for (const [field, gene] of Object.entries(schema)) {
    const v = genome[field];
    if (gene.kind === 'continuous') {
      const [lo, hi] = gene.range;
      if (typeof v !== 'number' || v < lo || v > hi) return false;
    } else if (gene.kind === 'seed') {
      if ((v >>> 0) !== v) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Expected gene catalogue
// ---------------------------------------------------------------------------

const EXPECTED_STRUCTURAL = [
  'branchiness', 'branchFactorN', 'tillering', 'radialOrder',
  'appendageBreadth', 'appendageDensity', 'segmentation',
  'trunkHeight',
  // Root system genes (added Task 1)
  'rootCount', 'rootDepth', 'rootSpread', 'rootFlare',
  'rootButtress', 'rootBranchiness', 'rootTaper',
  // New inert genes (draws 41–42)
  'stemSpread', 'rosette',
  // New inert gene (draw 44)
  'whorl',
  // crownStart — where the crown's primary branches begin along the trunk
  'crownStart',
];

const EXPECTED_PROPORTIONS = [
  'succulence', 'stemGirth', 'taper', 'rigidity', 'verticality',
  'ribbing', 'spininess', 'branchAngle', 'lengthRatio', 'apicalBias', 'droopBias',
  'weep',
  // New inert gene (draw 40)
  'flatness',
  // New inert genes (draws 43, 45)
  'woodiness', 'tipTuft',
  // phototropism (draw 49)
  'phototropism',
  // trunkTaper (draw 50)
  'trunkTaper',
];

const EXPECTED_COSMETIC = [
  'pigment', 'leafSize', 'jitter', 'leafWidth',
  'leafLength', 'leafTip', 'leafSerration', 'leafLobing', 'leafSkew',
  'barkHue', 'barkLightness', 'barkRelief', 'barkLenticels', 'barkScale', 'barkOrient', 'barkPlates',
  'barkShed', 'barkUnderHue',
  'leafDivision', 'frondFan',
  'structuralSeed',
];

const REMOVED_GENES = [
  'growthHabit', 'symmetry', 'appendageKind',
  'maxDepth', 'branchFactor', 'internodeCount', 'trunkSegments',
];

// Expected [lo, hi] per gene for range assertions.
const EXPECTED_RANGES = {
  branchiness:      [0, 1],
  branchFactorN:    [0, 1],
  tillering:        [0, 1],
  radialOrder:      [0, 1],
  appendageBreadth: [0, 1],
  appendageDensity: [0, 1.5],
  segmentation:     [0, 1],
  succulence:       [0, 1],
  stemGirth:        [0, 1],
  taper:            [0, 1],
  rigidity:         [0, 1],
  verticality:      [0, 1],
  ribbing:          [0, 1],
  spininess:        [0, 1],
  branchAngle:      [0.35, 0.80],
  lengthRatio:      [0.55, 0.85],
  apicalBias:       [0.0, 1.0],
  droopBias:        [-0.2, 0.4],
  pigment:          [0.0, 1.0],
  leafSize:         [0.6, 4.0],
  jitter:           [0.0, 1.5],
  leafWidth:        [0.0, 1.0],
  leafLength:       [0.0, 1.0],
  leafTip:          [0.0, 1.0],
  leafSerration:    [0.0, 1.0],
  leafLobing:       [0.0, 1.0],
  leafSkew:         [0.0, 1.0],
  barkHue:          [0.0, 1.0],
  barkLightness:    [0.0, 1.0],
  barkRelief:       [0.0, 1.0],
  barkLenticels:    [0.0, 1.0],
  barkScale:        [0.0, 1.0],
  barkOrient:       [0.0, 1.0],
  barkPlates:       [0.0, 1.0],
  barkShed:         [0.0, 1.0],
  barkUnderHue:     [0.0, 1.0],
  weep:             [0.0, 1.0],
  trunkHeight:      [0, 1],
  // Root system genes (added Task 1)
  rootCount:        [0, 1],
  rootDepth:        [0, 1],
  rootSpread:       [0, 1],
  rootFlare:        [0, 1],
  rootButtress:     [0, 1],
  rootBranchiness:  [0, 1],
  rootTaper:        [0, 1],
  // New inert genes (draws 40–42)
  flatness:         [0.0, 1.0],
  stemSpread:       [0, 1],
  rosette:          [0, 1],
  // New inert genes (draws 43–45)
  woodiness:        [0.0, 1.0],
  whorl:            [0, 1],
  crownStart:       [0, 1],
  tipTuft:          [0.0, 1.0],
  // New inert genes (draws 46–48)
  leafDivision:     [0.0, 1.0],
  frondFan:         [0.0, 1.0],
  // phototropism (draw 49)
  phototropism:     [0.0, 1.0],
  // trunkTaper (draw 50)
  trunkTaper:       [0.0, 1.0],
};

// ---------------------------------------------------------------------------
// Suite 1: Schema catalogue
// ---------------------------------------------------------------------------

describe('FLORA_SCHEMA — gene catalogue', () => {

  it('all expected structural genes are present with correct tier/kind/range', () => {
    for (const field of EXPECTED_STRUCTURAL) {
      const gene = FLORA_SCHEMA[field];
      assert.ok(gene, `${field} missing from FLORA_SCHEMA`);
      assert.equal(gene.tier, 'structural', `${field}: expected tier 'structural'`);
      assert.equal(gene.kind, 'continuous', `${field}: expected kind 'continuous'`);
      const [elo, ehi] = EXPECTED_RANGES[field];
      assert.deepEqual(
        Array.from(gene.range),
        [elo, ehi],
        `${field}: range mismatch — got [${gene.range}], want [${elo},${ehi}]`
      );
    }
  });

  it('all expected proportions genes are present with correct tier/kind/range', () => {
    for (const field of EXPECTED_PROPORTIONS) {
      const gene = FLORA_SCHEMA[field];
      assert.ok(gene, `${field} missing from FLORA_SCHEMA`);
      assert.equal(gene.tier, 'proportions', `${field}: expected tier 'proportions'`);
      assert.equal(gene.kind, 'continuous', `${field}: expected kind 'continuous'`);
      const [elo, ehi] = EXPECTED_RANGES[field];
      assert.deepEqual(
        Array.from(gene.range),
        [elo, ehi],
        `${field}: range mismatch — got [${gene.range}], want [${elo},${ehi}]`
      );
    }
  });

  it('all expected cosmetic genes are present with correct tier/kind', () => {
    for (const field of EXPECTED_COSMETIC) {
      const gene = FLORA_SCHEMA[field];
      assert.ok(gene, `${field} missing from FLORA_SCHEMA`);
      assert.equal(gene.tier, 'cosmetic', `${field}: expected tier 'cosmetic'`);
      if (field === 'structuralSeed') {
        assert.equal(gene.kind, 'seed', `structuralSeed: expected kind 'seed'`);
      } else {
        assert.equal(gene.kind, 'continuous', `${field}: expected kind 'continuous'`);
        const [elo, ehi] = EXPECTED_RANGES[field];
        assert.deepEqual(
          Array.from(gene.range),
          [elo, ehi],
          `${field}: range mismatch — got [${gene.range}], want [${elo},${ehi}]`
        );
      }
    }
  });

  it('removed categoricals and ints are absent', () => {
    for (const field of REMOVED_GENES) {
      assert.equal(
        FLORA_SCHEMA[field],
        undefined,
        `${field} should have been removed but is still in FLORA_SCHEMA`
      );
    }
  });

  it('every gene is either continuous or seed — no categorical or int kinds remain', () => {
    for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
      assert.ok(
        gene.kind === 'continuous' || gene.kind === 'seed',
        `${field}: unexpected kind '${gene.kind}'`
      );
    }
  });

  it('FAUNA_SCHEMA_STUB is null', () => {
    assert.equal(FAUNA_SCHEMA_STUB, null);
  });

});

// ---------------------------------------------------------------------------
// Suite 2: Derived field lists
// ---------------------------------------------------------------------------

describe('STRUCTURAL_FIELDS / PROPORTIONS_FIELDS / COSMETIC_FIELDS', () => {

  it('STRUCTURAL_FIELDS matches exactly the expected structural genes', () => {
    assert.deepEqual(
      [...STRUCTURAL_FIELDS].sort(),
      [...EXPECTED_STRUCTURAL].sort(),
      'STRUCTURAL_FIELDS content mismatch'
    );
  });

  it('PROPORTIONS_FIELDS matches exactly the expected proportions genes', () => {
    assert.deepEqual(
      [...PROPORTIONS_FIELDS].sort(),
      [...EXPECTED_PROPORTIONS].sort(),
      'PROPORTIONS_FIELDS content mismatch'
    );
  });

  it('COSMETIC_FIELDS matches exactly the expected cosmetic genes', () => {
    assert.deepEqual(
      [...COSMETIC_FIELDS].sort(),
      [...EXPECTED_COSMETIC].sort(),
      'COSMETIC_FIELDS content mismatch'
    );
  });

  it('the three tier lists together cover every field in FLORA_SCHEMA', () => {
    const allDerived = new Set([...STRUCTURAL_FIELDS, ...PROPORTIONS_FIELDS, ...COSMETIC_FIELDS]);
    for (const field of Object.keys(FLORA_SCHEMA)) {
      assert.ok(allDerived.has(field), `${field} missing from all three tier lists`);
    }
    assert.equal(
      allDerived.size,
      Object.keys(FLORA_SCHEMA).length,
      'combined tier lists have duplicate or extra entries'
    );
  });

  it('tier lists are frozen arrays', () => {
    assert.ok(Object.isFrozen(STRUCTURAL_FIELDS));
    assert.ok(Object.isFrozen(PROPORTIONS_FIELDS));
    assert.ok(Object.isFrozen(COSMETIC_FIELDS));
  });

});

// ---------------------------------------------------------------------------
// Suite 3: clampField
// ---------------------------------------------------------------------------

describe('clampField — per-gene clamping', () => {

  // Probe inputs and their expected outcomes for [0,1] genes.
  const PROBE_01 = [
    { input: -1,  expected: 0   },
    { input:  0,  expected: 0   },
    { input:  0.5, expected: 0.5 },
    { input:  1,  expected: 1   },
    { input:  2,  expected: 1   },
  ];

  // [0,1] range genes.
  const UNIT_GENES = [
    'branchiness', 'branchFactorN', 'tillering', 'radialOrder',
    'appendageBreadth', 'segmentation',
    'trunkHeight',
    'succulence', 'stemGirth', 'taper', 'rigidity', 'verticality',
    'ribbing', 'spininess', 'apicalBias', 'pigment', 'leafWidth',
    'leafLength', 'leafTip', 'leafSerration', 'leafLobing', 'leafSkew',
    'barkHue', 'barkLightness', 'barkRelief', 'barkLenticels', 'barkScale', 'barkOrient', 'barkPlates', 'barkShed', 'barkUnderHue', 'weep',
    'woodiness', 'whorl', 'crownStart', 'tipTuft',
    'leafDivision', 'frondFan',
    'phototropism',
    'trunkTaper',
  ];

  for (const field of UNIT_GENES) {
    it(`${field}: clamps correctly at probe inputs -1,0,0.5,1,2`, () => {
      for (const { input, expected } of PROBE_01) {
        const result = clampField(FLORA_SCHEMA, field, input);
        assert.equal(result, expected, `${field}(${input}) → ${result}, want ${expected}`);
      }
    });
  }

  it('branchAngle: clamps to [0.35, 0.80] at probe inputs', () => {
    assert.equal(clampField(FLORA_SCHEMA, 'branchAngle', -1),   0.35);
    assert.equal(clampField(FLORA_SCHEMA, 'branchAngle',  0),   0.35);
    assert.equal(clampField(FLORA_SCHEMA, 'branchAngle',  0.5), 0.5);
    assert.equal(clampField(FLORA_SCHEMA, 'branchAngle',  1),   0.80);
    assert.equal(clampField(FLORA_SCHEMA, 'branchAngle',  2),   0.80);
  });

  it('lengthRatio: clamps to [0.55, 0.85] at probe inputs', () => {
    assert.equal(clampField(FLORA_SCHEMA, 'lengthRatio', -1),   0.55);
    assert.equal(clampField(FLORA_SCHEMA, 'lengthRatio',  0),   0.55);
    assert.equal(clampField(FLORA_SCHEMA, 'lengthRatio',  0.5), 0.55); // 0.5 < 0.55 → lo
    assert.equal(clampField(FLORA_SCHEMA, 'lengthRatio',  1),   0.85);
    assert.equal(clampField(FLORA_SCHEMA, 'lengthRatio',  2),   0.85);
  });

  it('droopBias: clamps to [-0.2, 0.4] at probe inputs', () => {
    assert.equal(clampField(FLORA_SCHEMA, 'droopBias', -1),   -0.2);
    assert.equal(clampField(FLORA_SCHEMA, 'droopBias',  0),    0);
    assert.equal(clampField(FLORA_SCHEMA, 'droopBias',  0.5),  0.4); // 0.5 > 0.4 → hi
    assert.equal(clampField(FLORA_SCHEMA, 'droopBias',  1),    0.4);
    assert.equal(clampField(FLORA_SCHEMA, 'droopBias',  2),    0.4);
  });

  it('leafSize: clamps to [0.6, 4.0] at probe inputs (widened — absorbed leafScale)', () => {
    assert.equal(clampField(FLORA_SCHEMA, 'leafSize', -1),   0.6);
    assert.equal(clampField(FLORA_SCHEMA, 'leafSize',  0),   0.6);
    assert.equal(clampField(FLORA_SCHEMA, 'leafSize',  0.5), 0.6); // 0.5 < 0.6 → lo
    assert.equal(clampField(FLORA_SCHEMA, 'leafSize',  1),   1);
    assert.equal(clampField(FLORA_SCHEMA, 'leafSize',  2),   2);   // within widened range
    assert.equal(clampField(FLORA_SCHEMA, 'leafSize',  5),   4.0); // 5 > 4 → hi
  });

  it('appendageDensity: clamps to [0, 1.5] at probe inputs (widened — absorbed leafDensity)', () => {
    assert.equal(clampField(FLORA_SCHEMA, 'appendageDensity', -1),  0);
    assert.equal(clampField(FLORA_SCHEMA, 'appendageDensity',  0),  0);
    assert.equal(clampField(FLORA_SCHEMA, 'appendageDensity',  1),  1);
    assert.equal(clampField(FLORA_SCHEMA, 'appendageDensity',  1.5), 1.5);
    assert.equal(clampField(FLORA_SCHEMA, 'appendageDensity',  2),  1.5); // 2 > 1.5 → hi
  });

  it('jitter: clamps to [0.0, 1.5] at probe inputs', () => {
    assert.equal(clampField(FLORA_SCHEMA, 'jitter', -1),   0);
    assert.equal(clampField(FLORA_SCHEMA, 'jitter',  0),   0);
    assert.equal(clampField(FLORA_SCHEMA, 'jitter',  0.5), 0.5);
    assert.equal(clampField(FLORA_SCHEMA, 'jitter',  1),   1);
    assert.equal(clampField(FLORA_SCHEMA, 'jitter',  2),   1.5);
  });

  it('structuralSeed (seed): coerces to uint32 — masks fractional / negative inputs', () => {
    // Positive integer: should pass through unchanged.
    assert.equal(clampField(FLORA_SCHEMA, 'structuralSeed', 0xDEADBEEF), 0xDEADBEEF >>> 0);
    // 0 → 0
    assert.equal(clampField(FLORA_SCHEMA, 'structuralSeed', 0), 0);
    // Fractional: Math floor via >>> 0
    assert.equal(clampField(FLORA_SCHEMA, 'structuralSeed', 3.9), 3);
    // Negative: wraps to uint32
    assert.equal(clampField(FLORA_SCHEMA, 'structuralSeed', -1), 0xFFFFFFFF);
  });

  it('unknown field is returned unchanged', () => {
    assert.equal(clampField(FLORA_SCHEMA, 'notAField', 99), 99);
    assert.equal(clampField(FLORA_SCHEMA, 'notAField', 'hello'), 'hello');
  });

  it('clampField round-trips: clamp(clamp(v)) === clamp(v) for all genes', () => {
    const probeValues = [-5, -1, -0.1, 0, 0.3, 0.5, 0.7, 1, 1.2, 2, 99];
    for (const field of Object.keys(FLORA_SCHEMA)) {
      if (FLORA_SCHEMA[field].kind === 'seed') continue;
      for (const v of probeValues) {
        const once  = clampField(FLORA_SCHEMA, field, v);
        const twice = clampField(FLORA_SCHEMA, field, once);
        assert.equal(twice, once, `${field}(${v}): clamp not idempotent — ${once} → ${twice}`);
      }
    }
  });

});

// ---------------------------------------------------------------------------
// Suite 4: genomeDistance
// ---------------------------------------------------------------------------

describe('genomeDistance', () => {

  it('distance(g, g) === 0 for any genome', () => {
    const g = makeSampleGenome();
    assert.equal(genomeDistance(g, g, FLORA_SCHEMA), 0);
  });

  it('distance is symmetric: d(a,b) === d(b,a)', () => {
    const rng = mulberry32(42);
    // Build two random-ish genomes.
    const a = makeSampleGenome();
    const b = makeSampleGenome();
    for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
      if (gene.kind === 'continuous') {
        const [lo, hi] = gene.range;
        a[field] = lo + rng() * (hi - lo);
        b[field] = lo + rng() * (hi - lo);
      }
    }
    const dAB = genomeDistance(a, b, FLORA_SCHEMA);
    const dBA = genomeDistance(b, a, FLORA_SCHEMA);
    assert.equal(dAB, dBA, `distance not symmetric: d(a,b)=${dAB}, d(b,a)=${dBA}`);
  });

  it('distance ∈ [0, 1] for randomly sampled pairs', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      const a = {};
      const b = {};
      for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
        if (gene.kind === 'continuous') {
          const [lo, hi] = gene.range;
          a[field] = lo + rng() * (hi - lo);
          b[field] = lo + rng() * (hi - lo);
        } else {
          a[field] = 0;
          b[field] = 0;
        }
      }
      const d = genomeDistance(a, b, FLORA_SCHEMA);
      assert.ok(d >= 0 && d <= 1, `Trial ${i}: distance ${d} outside [0,1]`);
    }
  });

  it('max-separated genomes (all genes at opposite extremes) give distance ≤ 1', () => {
    const lo = {};
    const hi = {};
    for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
      if (gene.kind === 'continuous') {
        lo[field] = gene.range[0];
        hi[field] = gene.range[1];
      } else {
        lo[field] = 0;
        hi[field] = 0;
      }
    }
    const d = genomeDistance(lo, hi, FLORA_SCHEMA);
    assert.ok(d >= 0 && d <= 1, `Max-separated distance ${d} outside [0,1]`);
    // At full separation the distance should be exactly 1.
    assert.equal(d, 1);
  });

  it('seeds are excluded from distance computation (structuralSeed change does not affect distance)', () => {
    const a = makeSampleGenome();
    const b = { ...a, structuralSeed: 0xDEADBEEF };
    assert.equal(genomeDistance(a, b, FLORA_SCHEMA), 0);
  });

  it('tier weights mean structural distance dominates proportions dominates cosmetic', () => {
    // Build genomes differing in only one field per tier at half-span magnitude.
    const base = makeSampleGenome();

    function distOnField(field) {
      const gene = FLORA_SCHEMA[field];
      if (!gene || gene.kind !== 'continuous') return null;
      const [lo, hi] = gene.range;
      const mid = (lo + hi) / 2;
      const far = hi;  // move to the far end for max span contribution
      const b = { ...base, [field]: far };
      const a = { ...base, [field]: lo };
      return genomeDistance(a, b, FLORA_SCHEMA);
    }

    // Pick one field per tier (all [0,1] so span=1, pure weight comparison).
    const dStruct     = distOnField('branchiness');    // structural ×3
    const dProport    = distOnField('succulence');     // proportions ×1.5
    const dCosmetic   = distOnField('pigment');        // cosmetic ×0.5

    assert.ok(
      dStruct > dProport,
      `structural distance (${dStruct}) should exceed proportions (${dProport})`
    );
    assert.ok(
      dProport > dCosmetic,
      `proportions distance (${dProport}) should exceed cosmetic (${dCosmetic})`
    );
  });

});

// ---------------------------------------------------------------------------
// Suite 5: parked mutate() compatibility
// ---------------------------------------------------------------------------

describe('mutate() — compatibility with new continuous schema', () => {

  it('mutate produces a schema-valid child from a new-schema genome', () => {
    const parent = makeSampleGenome();
    const rng    = mulberry32(1);
    const child  = mutate(parent, rng, 0.5);
    assert.ok(
      isSchemaValid(child, FLORA_SCHEMA),
      'mutate() child failed schema validity — some field is out of range'
    );
  });

  it('mutate child passes clampField round-trip for every field', () => {
    const parent = makeSampleGenome();
    const rng    = mulberry32(1);
    const child  = mutate(parent, rng, 0.5);

    for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
      if (gene.kind === 'seed') {
        // seed: clamp should be a uint32 identity
        assert.equal(
          clampField(FLORA_SCHEMA, field, child[field]),
          child[field] >>> 0,
          `${field}: seed clamp mismatch`
        );
      } else {
        // continuous: value must round-trip through clamp unchanged
        const clamped = clampField(FLORA_SCHEMA, field, child[field]);
        assert.equal(
          clamped,
          child[field],
          `${field}: value ${child[field]} does not round-trip through clampField (got ${clamped})`
        );
      }
    }
  });

  it('mutate is deterministic with mulberry32(1) on the new schema', () => {
    const parent = makeSampleGenome();
    const child1 = mutate(parent, mulberry32(1), 0.5);
    const child2 = mutate(parent, mulberry32(1), 0.5);
    assert.deepEqual(child1, child2, 'mutate must be deterministic');
  });

  it('mutate never mutates the parent genome', () => {
    const parent   = makeSampleGenome();
    const snapshot = JSON.stringify(parent);
    mutate(parent, mulberry32(1), 0.5);
    assert.equal(JSON.stringify(parent), snapshot, 'parent mutated in place');
  });

  it('structuralSeed always changes in every child (even at strength=0.5)', () => {
    const parent = makeSampleGenome();
    // Run many seeds — structuralSeed is always re-derived unconditionally.
    for (let s = 0; s < 100; s++) {
      const child = mutate(parent, mulberry32(s), 0.5);
      assert.notEqual(
        child.structuralSeed,
        parent.structuralSeed,
        `seed ${s}: child.structuralSeed should differ from parent`
      );
    }
  });

  it('multiple children from successive seeds are all valid', () => {
    const parent = makeSampleGenome();
    for (let s = 0; s < 200; s++) {
      const child = mutate(parent, mulberry32(s * 13 + 7), 0.5);
      assert.ok(
        isSchemaValid(child, FLORA_SCHEMA),
        `child from seed ${s} failed schema validity`
      );
    }
  });

});
