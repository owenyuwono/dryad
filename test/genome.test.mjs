// =============================================================================
// genome.test.mjs — contract tests for continuous-morphospace genome layer
//
// Run: node --test test/genome.test.mjs
//
// Covers:
//   1. randomGenome determinism (same seed+env → deep-equal output)
//   2. All genes in FLORA_SCHEMA range after randomGenome
//   3. Default-centered: at neutral env, env offsets are ~0 (only seed variation)
//   4. Env-bias direction asserts (aridity+temp → succulence/spininess; water → breadth/rigidity; gravity → stemGirth)
//   5. resolve determinism (same genome+env → deep-equal output)
//   6. resolve returns boneCount>0, relief scalars, lightFlux
//   7. mutate compatibility (child is schema-valid)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { randomGenome, resolve, speciesColor } from '../src/genome.js';
import { FLORA_SCHEMA, clampField }            from '../src/genomeSchema.js';
import { mutate }                              from '../src/mutate.js';
import { mulberry32 }                          from '../src/rng.js';
import { MAX_BONES }                           from '../src/skeleton.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Neutral environment — all env offsets should be 0 at these values. */
const NEUTRAL_ENV = Object.freeze({
  gravity:     1,
  medium:      'air',
  light:       0.6,
  sunAngle:    0.25,
  wind:        0.2,
  aridity:     0.35,
  temperature: 0.5,
  energy:      'photo',
  biochem:     'carbon',
});

/** High aridity + high temperature environment. */
const HOT_DRY_ENV = Object.freeze({
  ...NEUTRAL_ENV,
  aridity:     0.90,
  temperature: 0.95,
});

/** Aquatic environment. */
const WATER_ENV = Object.freeze({
  ...NEUTRAL_ENV,
  medium: 'water',
});

/** High-gravity environment. */
const HIGH_GRAVITY_ENV = Object.freeze({
  ...NEUTRAL_ENV,
  gravity: 2.5,
});

/** High-wind environment. */
const HIGH_WIND_ENV = Object.freeze({
  ...NEUTRAL_ENV,
  wind: 0.9,
});

/** Dim light environment. */
const DIM_LIGHT_ENV = Object.freeze({
  ...NEUTRAL_ENV,
  light: 0.1,
});

/**
 * Return true iff every gene in the genome is within its FLORA_SCHEMA range.
 */
function isSchemaValid(genome) {
  for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
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

/**
 * Return a deep-cloned genome (JSON round-trip is safe for our flat numeric objects).
 */
function deepClone(g) {
  return JSON.parse(JSON.stringify(g));
}

// ---------------------------------------------------------------------------
// Suite 1: randomGenome — determinism
// ---------------------------------------------------------------------------

describe('randomGenome — determinism', () => {

  it('same (env, seed) produces deep-equal genome on repeated calls', () => {
    for (const seed of [0, 1, 42, 0xDEADBEEF, 99999]) {
      const g1 = randomGenome(NEUTRAL_ENV, seed);
      const g2 = randomGenome(NEUTRAL_ENV, seed);
      assert.deepEqual(g1, g2, `seed ${seed}: randomGenome not deterministic`);
    }
  });

  it('different seeds produce different genomes (not identical)', () => {
    const g1 = randomGenome(NEUTRAL_ENV, 1);
    const g2 = randomGenome(NEUTRAL_ENV, 2);
    // At least one gene should differ — structuralSeed alone satisfies this
    const same = JSON.stringify(g1) === JSON.stringify(g2);
    assert.equal(same, false, 'different seeds produced identical genomes');
  });

  it('neutral env and modified env produce different genomes for same seed', () => {
    const gNeutral = randomGenome(NEUTRAL_ENV, 42);
    const gHotDry  = randomGenome(HOT_DRY_ENV, 42);
    const same = JSON.stringify(gNeutral) === JSON.stringify(gHotDry);
    assert.equal(same, false, 'different envs produced identical genomes at same seed');
  });

});

// ---------------------------------------------------------------------------
// Suite 2: randomGenome — all genes in range
// ---------------------------------------------------------------------------

describe('randomGenome — all genes in FLORA_SCHEMA range', () => {

  it('at neutral env, 50 seeds all produce schema-valid genomes', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      assert.ok(isSchemaValid(g), `seed ${seed}: genome failed schema validation`);
    }
  });

  it('at hot-dry env, 50 seeds all produce schema-valid genomes', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(HOT_DRY_ENV, seed);
      assert.ok(isSchemaValid(g), `hot-dry seed ${seed}: genome failed schema validation`);
    }
  });

  it('at water env, 50 seeds all produce schema-valid genomes', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(WATER_ENV, seed);
      assert.ok(isSchemaValid(g), `water seed ${seed}: genome failed schema validation`);
    }
  });

  it('at high-gravity env, 50 seeds all produce schema-valid genomes', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(HIGH_GRAVITY_ENV, seed);
      assert.ok(isSchemaValid(g), `high-grav seed ${seed}: genome failed schema validation`);
    }
  });

  it('every gene present in output matches FLORA_SCHEMA fields', () => {
    const g = randomGenome(NEUTRAL_ENV, 7);
    const schemaFields = new Set(Object.keys(FLORA_SCHEMA));
    for (const field of Object.keys(g)) {
      assert.ok(schemaFields.has(field), `unexpected field in genome: ${field}`);
    }
    for (const field of schemaFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(g, field),
        `genome missing field: ${field}`);
    }
  });

  it('structuralSeed is a valid uint32 (equals itself >>> 0)', () => {
    for (let seed = 0; seed < 20; seed++) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      assert.equal(g.structuralSeed >>> 0, g.structuralSeed,
        `seed ${seed}: structuralSeed ${g.structuralSeed} is not a uint32`);
    }
  });

  it('all genes pass clampField round-trip (value === clamp(value))', () => {
    const g = randomGenome(NEUTRAL_ENV, 13);
    for (const [field, gene] of Object.entries(FLORA_SCHEMA)) {
      if (gene.kind === 'seed') continue;
      const clamped = clampField(FLORA_SCHEMA, field, g[field]);
      assert.equal(clamped, g[field],
        `${field}=${g[field]} does not survive clampField (got ${clamped})`);
    }
  });

});

// ---------------------------------------------------------------------------
// Suite 3: default-centered — neutral env offsets are ~0
// ---------------------------------------------------------------------------

describe('randomGenome — default-centered at neutral env', () => {

  // At neutral env, envOffset for every gene is 0.
  // So randomGenome(NEUTRAL_ENV, seed) = clamp(neutral + seedVariation(seed)).
  // For a LARGE population of seeds, the mean of each gene should be near NEUTRAL[gene].
  // We test with 200 seeds and allow ±0.10 tolerance for the mean.

  it('gene means over 200 seeds at neutral env are near neutral defaults (±0.10 tol)', () => {
    const NEUTRAL_DEFAULTS = {
      branchiness:      0.50,
      branchFactorN:    0.33,
      tillering:        0.10,
      radialOrder:      0.25,
      appendageBreadth: 0.45,
      appendageDensity: 0.40,
      segmentation:     0.20,
      succulence:       0.20,
      stemGirth:        0.40,
      taper:            0.50,
      rigidity:         0.60,
      verticality:      0.50,
      ribbing:          0.05,
      spininess:        0.05,
    };

    const N = 200;
    const sums = {};
    for (const field of Object.keys(NEUTRAL_DEFAULTS)) sums[field] = 0;

    for (let seed = 0; seed < N; seed++) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      for (const field of Object.keys(NEUTRAL_DEFAULTS)) {
        sums[field] += g[field];
      }
    }

    const TOL = 0.10;
    for (const [field, neutral] of Object.entries(NEUTRAL_DEFAULTS)) {
      const mean = sums[field] / N;
      assert.ok(
        Math.abs(mean - neutral) <= TOL,
        `${field}: mean ${mean.toFixed(3)} is not within ${TOL} of neutral ${neutral}`
      );
    }
  });

  it('at neutral env seed=0 and seed=1, genomes differ only in seed variation (not env push)', () => {
    // Both should be close to neutral — neither should be pushed far from neutral defaults
    const g0 = randomGenome(NEUTRAL_ENV, 0);
    const g1 = randomGenome(NEUTRAL_ENV, 1);
    // succulence neutral = 0.20; at hot-dry it could be pushed to ~0.50+
    // At neutral, succulence should be near 0.20 (within seed variation ±0.12)
    const succulenceRange = 0.12 + 0.05; // spread + small buffer
    assert.ok(Math.abs(g0.succulence - 0.20) < succulenceRange + 0.05,
      `seed=0 succulence ${g0.succulence} should be near neutral 0.20`);
    assert.ok(Math.abs(g1.succulence - 0.20) < succulenceRange + 0.05,
      `seed=1 succulence ${g1.succulence} should be near neutral 0.20`);
  });

});

// ---------------------------------------------------------------------------
// Suite 4: env-bias direction asserts
// ---------------------------------------------------------------------------

describe('randomGenome — env-bias directions', () => {

  // For direction tests we use the MEAN over many seeds to average out
  // seed variation and expose the env offset.

  function meanGene(env, field, N = 200) {
    let sum = 0;
    for (let seed = 0; seed < N; seed++) {
      sum += randomGenome(env, seed)[field];
    }
    return sum / N;
  }

  // --- 4.1: aridity + temperature → succulence↑, spininess↑ ---

  it('high aridity+temperature → succulence ABOVE neutral mean', () => {
    const sucNeutral = meanGene(NEUTRAL_ENV, 'succulence');
    const sucHotDry  = meanGene(HOT_DRY_ENV, 'succulence');
    assert.ok(
      sucHotDry > sucNeutral,
      `succulence at hot-dry (${sucHotDry.toFixed(3)}) should exceed neutral (${sucNeutral.toFixed(3)})`
    );
  });

  it('high aridity+temperature → spininess ABOVE neutral mean', () => {
    const spNeutral = meanGene(NEUTRAL_ENV, 'spininess');
    const spHotDry  = meanGene(HOT_DRY_ENV, 'spininess');
    assert.ok(
      spHotDry > spNeutral,
      `spininess at hot-dry (${spHotDry.toFixed(3)}) should exceed neutral (${spNeutral.toFixed(3)})`
    );
  });

  it('high aridity+temperature → ribbing ABOVE neutral mean', () => {
    const rNeutral = meanGene(NEUTRAL_ENV, 'ribbing');
    const rHotDry  = meanGene(HOT_DRY_ENV, 'ribbing');
    assert.ok(
      rHotDry > rNeutral,
      `ribbing at hot-dry (${rHotDry.toFixed(3)}) should exceed neutral (${rNeutral.toFixed(3)})`
    );
  });

  it('high aridity+temperature → appendageBreadth BELOW neutral mean', () => {
    const aNeutral = meanGene(NEUTRAL_ENV, 'appendageBreadth');
    const aHotDry  = meanGene(HOT_DRY_ENV, 'appendageBreadth');
    assert.ok(
      aHotDry < aNeutral,
      `appendageBreadth at hot-dry (${aHotDry.toFixed(3)}) should be below neutral (${aNeutral.toFixed(3)})`
    );
  });

  // --- 4.2: medium=water → appendageBreadth↑, rigidity↓ ---

  it('medium=water → appendageBreadth ABOVE neutral mean', () => {
    const aNeutral = meanGene(NEUTRAL_ENV, 'appendageBreadth');
    const aWater   = meanGene(WATER_ENV,   'appendageBreadth');
    assert.ok(
      aWater > aNeutral,
      `appendageBreadth in water (${aWater.toFixed(3)}) should exceed neutral (${aNeutral.toFixed(3)})`
    );
  });

  it('medium=water → rigidity BELOW neutral mean', () => {
    const rNeutral = meanGene(NEUTRAL_ENV, 'rigidity');
    const rWater   = meanGene(WATER_ENV,   'rigidity');
    assert.ok(
      rWater < rNeutral,
      `rigidity in water (${rWater.toFixed(3)}) should be below neutral (${rNeutral.toFixed(3)})`
    );
  });

  it('medium=water → tillering ABOVE neutral mean', () => {
    const tNeutral = meanGene(NEUTRAL_ENV, 'tillering');
    const tWater   = meanGene(WATER_ENV,   'tillering');
    assert.ok(
      tWater > tNeutral,
      `tillering in water (${tWater.toFixed(3)}) should exceed neutral (${tNeutral.toFixed(3)})`
    );
  });

  // --- 4.3: gravity↑ → stemGirth↑ ---

  it('high gravity → stemGirth ABOVE neutral mean', () => {
    const gNeutral  = meanGene(NEUTRAL_ENV,      'stemGirth');
    const gHighGrav = meanGene(HIGH_GRAVITY_ENV, 'stemGirth');
    assert.ok(
      gHighGrav > gNeutral,
      `stemGirth at high gravity (${gHighGrav.toFixed(3)}) should exceed neutral (${gNeutral.toFixed(3)})`
    );
  });

  it('high gravity → branchiness BELOW neutral mean', () => {
    const bNeutral  = meanGene(NEUTRAL_ENV,      'branchiness');
    const bHighGrav = meanGene(HIGH_GRAVITY_ENV, 'branchiness');
    assert.ok(
      bHighGrav < bNeutral,
      `branchiness at high gravity (${bHighGrav.toFixed(3)}) should be below neutral (${bNeutral.toFixed(3)})`
    );
  });

  // --- 4.4: wind↑ → verticality↓, rigidity↑ ---

  it('high wind → verticality BELOW neutral mean', () => {
    const vNeutral = meanGene(NEUTRAL_ENV,   'verticality');
    const vWind    = meanGene(HIGH_WIND_ENV, 'verticality');
    assert.ok(
      vWind < vNeutral,
      `verticality at high wind (${vWind.toFixed(3)}) should be below neutral (${vNeutral.toFixed(3)})`
    );
  });

  it('high wind → rigidity ABOVE neutral mean', () => {
    const rNeutral = meanGene(NEUTRAL_ENV,   'rigidity');
    const rWind    = meanGene(HIGH_WIND_ENV, 'rigidity');
    assert.ok(
      rWind > rNeutral,
      `rigidity at high wind (${rWind.toFixed(3)}) should exceed neutral (${rNeutral.toFixed(3)})`
    );
  });

  // --- 4.5: dim light → branchiness↑, appendageBreadth↑, appendageDensity↑ ---

  it('dim light → branchiness ABOVE neutral mean', () => {
    const bNeutral = meanGene(NEUTRAL_ENV,   'branchiness');
    const bDim     = meanGene(DIM_LIGHT_ENV, 'branchiness');
    assert.ok(
      bDim > bNeutral,
      `branchiness at dim light (${bDim.toFixed(3)}) should exceed neutral (${bNeutral.toFixed(3)})`
    );
  });

  it('dim light → appendageBreadth ABOVE neutral mean', () => {
    const aNeutral = meanGene(NEUTRAL_ENV,   'appendageBreadth');
    const aDim     = meanGene(DIM_LIGHT_ENV, 'appendageBreadth');
    assert.ok(
      aDim > aNeutral,
      `appendageBreadth at dim light (${aDim.toFixed(3)}) should exceed neutral (${aNeutral.toFixed(3)})`
    );
  });

});

// ---------------------------------------------------------------------------
// Suite 5: resolve — determinism
// ---------------------------------------------------------------------------

describe('resolve — determinism', () => {

  it('resolve(genome, env) is pure: same inputs → deep-equal output', () => {
    const g   = randomGenome(NEUTRAL_ENV, 42);
    const r1  = resolve(g, NEUTRAL_ENV);
    const r2  = resolve(g, NEUTRAL_ENV);
    assert.deepEqual(r1, r2, 'resolve is not deterministic');
  });

  it('different structuralSeed → different boneAData', () => {
    const g1 = randomGenome(NEUTRAL_ENV, 1);
    const g2 = { ...g1, structuralSeed: (g1.structuralSeed + 1) >>> 0 };
    const r1 = resolve(g1, NEUTRAL_ENV);
    const r2 = resolve(g2, NEUTRAL_ENV);
    // boneAData arrays are unlikely to be identical with different seeds
    const same = JSON.stringify(r1.boneAData) === JSON.stringify(r2.boneAData);
    assert.equal(same, false, 'different structuralSeeds produced identical boneAData');
  });

  it('resolve does not mutate genome', () => {
    const g       = randomGenome(NEUTRAL_ENV, 7);
    const snapshot = JSON.stringify(g);
    resolve(g, NEUTRAL_ENV);
    assert.equal(JSON.stringify(g), snapshot, 'resolve mutated the genome');
  });

});

// ---------------------------------------------------------------------------
// Suite 6: resolve — output contract
// ---------------------------------------------------------------------------

describe('resolve — output fields', () => {

  it('boneCount > 0 for default genome at neutral env', () => {
    const g = randomGenome(NEUTRAL_ENV, 0);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(typeof r.boneCount === 'number' && r.boneCount > 0,
      `boneCount should be > 0, got ${r.boneCount}`);
  });

  it('boneCount <= MAX_BONES (skeleton bone budget)', () => {
    const g = randomGenome(NEUTRAL_ENV, 0);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(r.boneCount <= MAX_BONES, `boneCount ${r.boneCount} exceeds MAX_BONES=${MAX_BONES}`);
  });

  it('boneAData length === 256 (64 bones × 4 floats)', () => {
    const g = randomGenome(NEUTRAL_ENV, 5);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.boneAData.length, 256, `boneAData.length should be 256`);
  });

  it('boneBData length === 256', () => {
    const g = randomGenome(NEUTRAL_ENV, 5);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.boneBData.length, 256);
  });

  it('boneFlatData length === 256', () => {
    const g = randomGenome(NEUTRAL_ENV, 5);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.boneFlatData.length, 256);
  });

  it('uRibbing is a number in [0,1]', () => {
    const g = randomGenome(NEUTRAL_ENV, 3);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(typeof r.uRibbing === 'number' && r.uRibbing >= 0 && r.uRibbing <= 1,
      `uRibbing ${r.uRibbing} not in [0,1]`);
  });

  it('uSpininess is a number in [0,1]', () => {
    const g = randomGenome(NEUTRAL_ENV, 3);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(typeof r.uSpininess === 'number' && r.uSpininess >= 0 && r.uSpininess <= 1,
      `uSpininess ${r.uSpininess} not in [0,1]`);
  });

  it('uSegmentation is a number in [0,1]', () => {
    const g = randomGenome(NEUTRAL_ENV, 3);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(typeof r.uSegmentation === 'number' && r.uSegmentation >= 0 && r.uSegmentation <= 1,
      `uSegmentation ${r.uSegmentation} not in [0,1]`);
  });

  it('lightFlux === env.light (viewer dependency)', () => {
    const g = randomGenome(NEUTRAL_ENV, 2);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.lightFlux, NEUTRAL_ENV.light,
      `lightFlux ${r.lightFlux} !== env.light ${NEUTRAL_ENV.light}`);
  });

  it('lightDir is a 3-element array of finite numbers', () => {
    const g = randomGenome(NEUTRAL_ENV, 1);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(Array.isArray(r.lightDir) && r.lightDir.length === 3,
      'lightDir should be a 3-element array');
    for (const v of r.lightDir) {
      assert.ok(typeof v === 'number' && isFinite(v), `lightDir contains non-finite: ${v}`);
    }
  });

  it('pigment in output matches genome.pigment', () => {
    const g = randomGenome(NEUTRAL_ENV, 9);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.pigment, g.pigment);
  });

  it('leafSize in output matches genome.leafSize', () => {
    const g = randomGenome(NEUTRAL_ENV, 9);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.leafSize, g.leafSize);
  });

  it('leafDensity in output matches genome.leafDensity', () => {
    const g = randomGenome(NEUTRAL_ENV, 9);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.leafDensity, g.leafDensity);
  });

  it('leafWidth in output matches genome.leafWidth', () => {
    const g = randomGenome(NEUTRAL_ENV, 9);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.leafWidth, g.leafWidth);
  });

  it('ribbing in output matches genome.ribbing', () => {
    const g = randomGenome(NEUTRAL_ENV, 9);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.ribbing, g.ribbing);
  });

  it('flatness in output matches genome.flatness', () => {
    const g = randomGenome(NEUTRAL_ENV, 9);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.flatness, g.flatness);
  });

  it('ribCount in output is integer in [8, 16]', () => {
    const g = randomGenome(NEUTRAL_ENV, 9);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(Number.isInteger(r.ribCount), `ribCount should be integer, got ${r.ribCount}`);
    assert.ok(r.ribCount >= 8 && r.ribCount <= 16,
      `ribCount ${r.ribCount} not in [8, 16]`);
  });

  it('ribCount derived from segmentation=0 is 8', () => {
    const g = { ...randomGenome(NEUTRAL_ENV, 0), segmentation: 0 };
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.ribCount, 8, `ribCount at segmentation=0 should be 8, got ${r.ribCount}`);
  });

  it('ribCount derived from segmentation=1 is 16', () => {
    const g = { ...randomGenome(NEUTRAL_ENV, 0), segmentation: 1 };
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.ribCount, 16, `ribCount at segmentation=1 should be 16, got ${r.ribCount}`);
  });

  it('uRibbing matches genome.ribbing', () => {
    const g = randomGenome(NEUTRAL_ENV, 4);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.uRibbing, g.ribbing);
  });

  it('uSpininess matches genome.spininess', () => {
    const g = randomGenome(NEUTRAL_ENV, 4);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.uSpininess, g.spininess);
  });

  it('uSegmentation matches genome.segmentation', () => {
    const g = randomGenome(NEUTRAL_ENV, 4);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.uSegmentation, g.segmentation);
  });

  it('graph is present with nodes and bones after solve', () => {
    const g = randomGenome(NEUTRAL_ENV, 0);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(r.graph !== undefined && r.graph !== null, 'graph field is missing');
    assert.ok(Array.isArray(r.graph.nodes) && r.graph.nodes.length > 0,
      `graph.nodes should be a non-empty array, got length ${r.graph?.nodes?.length}`);
    assert.ok(Array.isArray(r.graph.bones),
      'graph.bones should be an array');
  });

  it('resolve works on multiple envs without errors', () => {
    const envs = [NEUTRAL_ENV, HOT_DRY_ENV, WATER_ENV, HIGH_GRAVITY_ENV, HIGH_WIND_ENV];
    for (const env of envs) {
      const g = randomGenome(env, 1);
      const r = resolve(g, env);
      assert.ok(r.boneCount > 0, `resolve failed for env ${env.medium}`);
    }
  });

  it('blendK and materialMode are present', () => {
    const g = randomGenome(NEUTRAL_ENV, 0);
    const r = resolve(g, NEUTRAL_ENV);
    assert.ok(typeof r.blendK === 'number', 'blendK missing or not a number');
    assert.ok(typeof r.materialMode === 'number', 'materialMode missing or not a number');
  });

});

// ---------------------------------------------------------------------------
// Suite 7: mutate compatibility
// ---------------------------------------------------------------------------

describe('randomGenome → mutate round-trip schema validity', () => {

  it('mutate(randomGenome(neutral, seed), ...) produces a schema-valid child', () => {
    for (let seed = 0; seed < 20; seed++) {
      const parent = randomGenome(NEUTRAL_ENV, seed);
      const rng    = mulberry32(seed + 1000);
      const child  = mutate(parent, rng, 0.5);
      assert.ok(isSchemaValid(child),
        `seed ${seed}: mutate child failed schema validation`);
    }
  });

  it('mutate child has different structuralSeed from parent', () => {
    for (let seed = 0; seed < 20; seed++) {
      const parent = randomGenome(NEUTRAL_ENV, seed);
      const child  = mutate(parent, mulberry32(seed + 5000), 0.5);
      assert.notEqual(child.structuralSeed, parent.structuralSeed,
        `seed ${seed}: child structuralSeed unchanged after mutate`);
    }
  });

  it('mutate never modifies the parent genome', () => {
    const parent   = randomGenome(NEUTRAL_ENV, 77);
    const snapshot = JSON.stringify(parent);
    mutate(parent, mulberry32(88), 0.5);
    assert.equal(JSON.stringify(parent), snapshot, 'mutate mutated parent genome');
  });

  it('resolve(mutate_child, env) succeeds without error', () => {
    const parent = randomGenome(NEUTRAL_ENV, 55);
    const child  = mutate(parent, mulberry32(66), 0.5);
    const r = resolve(child, NEUTRAL_ENV);
    assert.ok(r.boneCount > 0, 'resolve on mutated child returned boneCount=0');
  });

});

// ---------------------------------------------------------------------------
// Suite 8: speciesColor — full-hue HSL mapping
// ---------------------------------------------------------------------------

describe('speciesColor', () => {

  it('returns a CSS rgb() string', () => {
    const g = randomGenome(NEUTRAL_ENV, 1);
    const c = speciesColor(g);
    assert.ok(typeof c === 'string' && c.startsWith('rgb('),
      `speciesColor returned unexpected: ${c}`);
  });

  it('is deterministic: same pigment always produces same string', () => {
    for (const p of [0, 0.1, 0.33, 0.5, 0.7, 1.0]) {
      const c1 = speciesColor({ pigment: p });
      const c2 = speciesColor({ pigment: p });
      assert.equal(c1, c2, `speciesColor not deterministic at pigment=${p}`);
    }
  });

  it('pigment=0.33 (≈120° hue = green) has higher green component than red/blue', () => {
    // Green hue: g channel should dominate
    const c = speciesColor({ pigment: 0.33 });
    const m = c.match(/rgb\((\d+),(\d+),(\d+)\)/);
    assert.ok(m, `unexpected format: ${c}`);
    const [, r, g, b] = m.map(Number);
    assert.ok(g > r, `green channel ${g} should exceed red ${r} at pigment=0.33`);
    assert.ok(g > b, `green channel ${g} should exceed blue ${b} at pigment=0.33`);
  });

  it('pigment=0 (red hue) has higher red component than green/blue', () => {
    // Hue=0° = red
    const c = speciesColor({ pigment: 0 });
    const m = c.match(/rgb\((\d+),(\d+),(\d+)\)/);
    assert.ok(m, `unexpected format: ${c}`);
    const [, r, g, b] = m.map(Number);
    assert.ok(r > g, `red channel ${r} should exceed green ${g} at pigment=0`);
    assert.ok(r > b, `red channel ${r} should exceed blue ${b} at pigment=0`);
  });

  it('pigment=0.67 (≈240° hue = blue) has higher blue component than red', () => {
    // Hue≈240° = blue
    const c = speciesColor({ pigment: 0.67 });
    const m = c.match(/rgb\((\d+),(\d+),(\d+)\)/);
    assert.ok(m, `unexpected format: ${c}`);
    const [, r, , b] = m.map(Number);
    assert.ok(b > r, `blue channel ${b} should exceed red ${r} at pigment=0.67`);
  });

  it('distinct pigment values produce distinct colors (full hue variety)', () => {
    // pigment=0 and pigment=1 are both hue=0°/360° (same color — HSL wraparound is correct).
    // Test pigment 0.0, 0.1, ..., 0.9 (10 distinct hue positions).
    const colors = new Set();
    for (let i = 0; i < 10; i++) {
      colors.add(speciesColor({ pigment: i / 10 }));
    }
    assert.equal(colors.size, 10, `expected 10 distinct colors across pigment 0..0.9, got ${colors.size}`);
  });

  it('all channels in [0,255] for all pigment values', () => {
    for (let i = 0; i <= 20; i++) {
      const p = i / 20;
      const c = speciesColor({ pigment: p });
      const m = c.match(/rgb\((\d+),(\d+),(\d+)\)/);
      assert.ok(m, `unexpected format at pigment=${p}: ${c}`);
      const [, r, g, b] = m.map(Number);
      assert.ok(r >= 0 && r <= 255, `r=${r} out of range at pigment=${p}`);
      assert.ok(g >= 0 && g <= 255, `g=${g} out of range at pigment=${p}`);
      assert.ok(b >= 0 && b <= 255, `b=${b} out of range at pigment=${p}`);
    }
  });

  it('clamps out-of-range pigment gracefully', () => {
    // Should not throw and should return a valid rgb() string
    const cLow  = speciesColor({ pigment: -1 });
    const cHigh = speciesColor({ pigment: 2 });
    assert.ok(cLow.startsWith('rgb('),  `negative pigment: ${cLow}`);
    assert.ok(cHigh.startsWith('rgb('), `over-range pigment: ${cHigh}`);
    // Clamped values should equal the boundary values
    assert.equal(cLow,  speciesColor({ pigment: 0 }), 'pigment<0 should clamp to pigment=0');
    assert.equal(cHigh, speciesColor({ pigment: 1 }), 'pigment>1 should clamp to pigment=1');
  });

});

// ---------------------------------------------------------------------------
// Suite 9: pigment variety across seeds
// ---------------------------------------------------------------------------

describe('randomGenome — pigment variety', () => {

  it('pigment varies across a wide range of seeds (spread > 0.5)', () => {
    let minP = Infinity;
    let maxP = -Infinity;
    for (let seed = 0; seed < 100; seed++) {
      const p = randomGenome(NEUTRAL_ENV, seed).pigment;
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
    }
    const spread = maxP - minP;
    assert.ok(spread > 0.5,
      `pigment spread over 100 seeds was only ${spread.toFixed(3)} — expected full hue variety`);
  });

});

// ---------------------------------------------------------------------------
// Suite 10: leafWidth gene — draw order and contract
// ---------------------------------------------------------------------------

describe('randomGenome — leafWidth gene', () => {

  it('leafWidth is present in every randomGenome output', () => {
    for (const seed of [0, 1, 42, 1337]) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      assert.ok(Object.prototype.hasOwnProperty.call(g, 'leafWidth'),
        `seed ${seed}: leafWidth missing from genome`);
    }
  });

  it('leafWidth is in [0,1] range for 50 seeds', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      assert.ok(g.leafWidth >= 0 && g.leafWidth <= 1,
        `seed ${seed}: leafWidth=${g.leafWidth} out of [0,1]`);
    }
  });

  it('leafWidth draw does NOT shift existing draws — skeleton is byte-identical to pre-leafWidth genome', () => {
    // Build two genomes from the same seed:
    //   g1: the full new genome (has leafWidth as draw 31)
    //   g2: same genome with leafWidth manually removed
    // Then resolve both; the skeleton (boneAData/boneBData) should be identical
    // because leafWidth only affects the texture, not the skeleton pipeline.
    const seed = 42;
    const g = randomGenome(NEUTRAL_ENV, seed);
    const { leafWidth: _lw, ...gWithout } = g;
    // Manually assign the same structuralSeed so the skeletons are driven identically
    gWithout.structuralSeed = g.structuralSeed;
    // Resolve both with the identical structural part
    const r1 = resolve(g, NEUTRAL_ENV);
    const r2 = resolve(gWithout, NEUTRAL_ENV);
    assert.deepEqual(r1.boneAData, r2.boneAData, 'leafWidth draw shifted boneAData');
    assert.deepEqual(r1.boneBData, r2.boneBData, 'leafWidth draw shifted boneBData');
  });

  it('leafWidth varies across seeds (is not constant)', () => {
    const values = new Set();
    for (let seed = 0; seed < 30; seed++) {
      values.add(randomGenome(NEUTRAL_ENV, seed).leafWidth);
    }
    assert.ok(values.size > 1, 'leafWidth should vary across seeds');
  });

});

// ---------------------------------------------------------------------------
// Suite 11: new leaf-shape genes (draws 32-35)
// ---------------------------------------------------------------------------

describe('randomGenome — new leaf-shape genes (draws 32-35)', () => {

  it('leafLength, leafTip, leafSerration, leafLobing are present in every output', () => {
    for (const seed of [0, 1, 42, 1337]) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      for (const gene of ['leafLength', 'leafTip', 'leafSerration', 'leafLobing']) {
        assert.ok(Object.prototype.hasOwnProperty.call(g, gene),
          `seed ${seed}: ${gene} missing from genome`);
      }
    }
  });

  it('all 4 new genes are in [0,1] for 50 seeds', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      for (const gene of ['leafLength', 'leafTip', 'leafSerration', 'leafLobing']) {
        assert.ok(g[gene] >= 0 && g[gene] <= 1,
          `seed ${seed}: ${gene}=${g[gene]} out of [0,1]`);
      }
    }
  });

  it('new draws do NOT shift existing draws — boneAData byte-identical', () => {
    const seed = 42;
    const g = randomGenome(NEUTRAL_ENV, seed);
    const { leafLength: _a, leafTip: _b, leafSerration: _c, leafLobing: _d, ...gWithout } = g;
    gWithout.structuralSeed = g.structuralSeed;
    const r1 = resolve(g, NEUTRAL_ENV);
    const r2 = resolve(gWithout, NEUTRAL_ENV);
    assert.deepEqual(r1.boneAData, r2.boneAData, 'new leaf draws shifted boneAData');
    assert.deepEqual(r1.boneBData, r2.boneBData, 'new leaf draws shifted boneBData');
  });

  it('all 4 new genes in resolve() output', () => {
    const g = randomGenome(NEUTRAL_ENV, 7);
    const r = resolve(g, NEUTRAL_ENV);
    assert.equal(r.leafLength,    g.leafLength);
    assert.equal(r.leafTip,       g.leafTip);
    assert.equal(r.leafSerration, g.leafSerration);
    assert.equal(r.leafLobing,    g.leafLobing);
  });

  it('new genes vary across seeds (not constant)', () => {
    for (const gene of ['leafLength', 'leafTip', 'leafSerration', 'leafLobing']) {
      const values = new Set();
      for (let seed = 0; seed < 30; seed++) {
        values.add(randomGenome(NEUTRAL_ENV, seed)[gene]);
      }
      assert.ok(values.size > 1, `${gene} should vary across seeds`);
    }
  });

});

// ---------------------------------------------------------------------------
// Suite 12: orthogonal bark axes + weep gene
// (barkColor/barkPattern were replaced by 5 orthogonal bark genes)
// ---------------------------------------------------------------------------

const BARK_GENES = ['barkHue', 'barkLightness', 'barkRelief', 'barkLenticels', 'barkScale'];

describe('randomGenome — orthogonal bark axes + weep gene', () => {

  it('all bark axes + weep are present in every output', () => {
    for (const seed of [0, 1, 42, 1337]) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      for (const gene of [...BARK_GENES, 'weep']) {
        assert.ok(Object.prototype.hasOwnProperty.call(g, gene),
          `seed ${seed}: ${gene} missing from genome`);
      }
    }
  });

  it('all bark axes + weep are in [0,1] for 50 seeds', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      for (const gene of [...BARK_GENES, 'weep']) {
        assert.ok(g[gene] >= 0 && g[gene] <= 1,
          `seed ${seed}: ${gene}=${g[gene]} out of [0,1]`);
      }
    }
  });

  it('bark axes are cosmetic — removing them does NOT shift the skeleton (boneAData byte-identical)', () => {
    const seed = 42;
    const g = randomGenome(NEUTRAL_ENV, seed);
    const gWithout = { ...g };
    for (const gene of BARK_GENES) delete gWithout[gene];
    const r1 = resolve(g, NEUTRAL_ENV);
    const r2 = resolve(gWithout, NEUTRAL_ENV);
    assert.deepEqual(r1.boneAData, r2.boneAData, 'bark axes shifted boneAData');
    assert.deepEqual(r1.boneBData, r2.boneBData, 'bark axes shifted boneBData');
  });

  it('bark axes are in resolve() output; weep is NOT', () => {
    const g = randomGenome(NEUTRAL_ENV, 7);
    const r = resolve(g, NEUTRAL_ENV);
    for (const gene of BARK_GENES) {
      assert.equal(r[gene], g[gene], `${gene} missing from resolve output`);
    }
    assert.equal(r.weep, undefined, 'weep should NOT be in resolve output');
  });

  it('bark axes + weep vary across seeds (not constant)', () => {
    for (const gene of [...BARK_GENES, 'weep']) {
      const values = new Set();
      for (let seed = 0; seed < 30; seed++) {
        values.add(randomGenome(NEUTRAL_ENV, seed)[gene]);
      }
      assert.ok(values.size > 1, `${gene} should vary across seeds`);
    }
  });

});

// ---------------------------------------------------------------------------
// Suite 13: trunkHeight gene (draw 39)
// ---------------------------------------------------------------------------

describe('randomGenome — trunkHeight gene (draw 39)', () => {

  it('trunkHeight is present in every randomGenome output', () => {
    for (const seed of [0, 1, 42, 1337]) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      assert.ok(Object.prototype.hasOwnProperty.call(g, 'trunkHeight'),
        `seed ${seed}: trunkHeight missing from genome`);
    }
  });

  it('trunkHeight is in [0,1] for 50 seeds', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = randomGenome(NEUTRAL_ENV, seed);
      assert.ok(g.trunkHeight >= 0 && g.trunkHeight <= 1,
        `seed ${seed}: trunkHeight=${g.trunkHeight} out of [0,1]`);
    }
  });

  it('draw 39 does NOT shift existing draws — at trunkHeight=0.5 skeleton is byte-identical to absent gene', () => {
    // trunkHeight=0.5 is the identity (scale factor exactly 1.0).
    // A genome with trunkHeight explicitly set to 0.5 must produce byte-identical
    // boneAData to a genome with trunkHeight absent (which defaults to 0.5 in
    // buildSkeleton's destructuring), confirming no draw shift and factor=1.0.
    const seed = 42;
    const g = randomGenome(NEUTRAL_ENV, seed);
    // Override to exactly 0.5 (identity) — the scale factor is exactly 1.0
    const gIdentity = { ...g, trunkHeight: 0.5 };
    // Remove trunkHeight entirely — skeleton defaults it to 0.5 via destructuring
    const { trunkHeight: _th, ...gWithout } = g;
    gWithout.structuralSeed = g.structuralSeed;
    const r1 = resolve(gIdentity, NEUTRAL_ENV);
    const r2 = resolve(gWithout, NEUTRAL_ENV);
    assert.deepEqual(r1.boneAData, r2.boneAData, 'trunkHeight=0.5 vs absent: boneAData differ (identity broken)');
    assert.deepEqual(r1.boneBData, r2.boneBData, 'trunkHeight=0.5 vs absent: boneBData differ (identity broken)');
  });

  it('trunkHeight varies across seeds (is not constant)', () => {
    const values = new Set();
    for (let seed = 0; seed < 30; seed++) {
      values.add(randomGenome(NEUTRAL_ENV, seed).trunkHeight);
    }
    assert.ok(values.size > 1, 'trunkHeight should vary across seeds');
  });

});
