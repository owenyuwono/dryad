// =============================================================================
// presets.test.mjs — contract tests for src/presets.js
//
// Run: node --test test/presets.test.mjs
//
// Covers:
//   1. Every preset has every FLORA_SCHEMA gene field defined (guards NaN)
//   2. resolve(preset.genome, neutralEnv) does not throw; graph.nodes.length > 0
//      and foliage count ≥ 0
//   3. Presets are pairwise DISTINCT gene vectors (no two presets identical)
//   4. Determinism: resolve twice → deep-equal
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, TREE_DEFAULT } from '../src/presets.js';
import { FLORA_SCHEMA }          from '../src/genomeSchema.js';
import { resolve }               from '../src/genome.js';

// ---------------------------------------------------------------------------
// Neutral env — matches the convention used across other test files.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS = Object.keys(FLORA_SCHEMA);

/** Returns the first missing FLORA_SCHEMA field, or null if all are present. */
function firstMissingField(genome) {
  for (const field of SCHEMA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(genome, field)) return field;
  }
  return null;
}

/** Returns true if two gene vectors are identical (structuralSeed included). */
function genomesEqual(a, b) {
  for (const field of SCHEMA_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Suite 1 — PRESETS structure and completeness
// ---------------------------------------------------------------------------

describe('PRESETS — structure', () => {

  it('PRESETS is a non-empty array', () => {
    assert.ok(Array.isArray(PRESETS) && PRESETS.length > 0, 'PRESETS must be a non-empty array');
  });

  it('every preset has id, label, and genome properties', () => {
    for (const preset of PRESETS) {
      assert.ok(typeof preset.id === 'string' && preset.id.length > 0,
        `preset missing or empty id: ${JSON.stringify(preset)}`);
      assert.ok(typeof preset.label === 'string' && preset.label.length > 0,
        `preset "${preset.id}" missing or empty label`);
      assert.ok(preset.genome !== null && typeof preset.genome === 'object',
        `preset "${preset.id}" missing genome object`);
    }
  });

  it('first preset is "tree" (id) with genome === TREE_DEFAULT values', () => {
    const tree = PRESETS[0];
    assert.equal(tree.id, 'tree', 'first preset id should be "tree"');
    // genome values must match TREE_DEFAULT (a shallow field-for-field check)
    for (const field of SCHEMA_FIELDS) {
      assert.equal(tree.genome[field], TREE_DEFAULT[field],
        `tree preset field "${field}" differs from TREE_DEFAULT`);
    }
  });

  it('preset ids are unique', () => {
    const ids = PRESETS.map(p => p.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, `preset ids are not unique: ${ids}`);
  });

});

// ---------------------------------------------------------------------------
// Suite 2 — every preset has all FLORA_SCHEMA genes (guards NaN)
// ---------------------------------------------------------------------------

describe('PRESETS — all FLORA_SCHEMA fields defined in every genome', () => {

  for (const preset of PRESETS) {
    it(`"${preset.id}" genome has every FLORA_SCHEMA field`, () => {
      const missing = firstMissingField(preset.genome);
      assert.equal(missing, null,
        `preset "${preset.id}": missing FLORA_SCHEMA field "${missing}"`);
    });
  }

  it('all preset genomes have defined (non-undefined) values for every field', () => {
    for (const preset of PRESETS) {
      for (const field of SCHEMA_FIELDS) {
        assert.notEqual(preset.genome[field], undefined,
          `preset "${preset.id}": field "${field}" is undefined`);
      }
    }
  });

  it('all continuous-kind fields are finite numbers (no NaN, no Infinity)', () => {
    for (const preset of PRESETS) {
      for (const field of SCHEMA_FIELDS) {
        const gene = FLORA_SCHEMA[field];
        if (gene.kind !== 'continuous') continue;
        const v = preset.genome[field];
        assert.ok(typeof v === 'number' && isFinite(v),
          `preset "${preset.id}": "${field}"=${v} is not a finite number`);
      }
    }
  });

  it('all continuous-kind fields are within FLORA_SCHEMA range', () => {
    for (const preset of PRESETS) {
      for (const field of SCHEMA_FIELDS) {
        const gene = FLORA_SCHEMA[field];
        if (gene.kind !== 'continuous') continue;
        const [lo, hi] = gene.range;
        const v = preset.genome[field];
        assert.ok(v >= lo && v <= hi,
          `preset "${preset.id}": "${field}"=${v} out of range [${lo}, ${hi}]`);
      }
    }
  });

  it('structuralSeed is a valid uint32 in every preset', () => {
    for (const preset of PRESETS) {
      const s = preset.genome.structuralSeed;
      assert.equal(s >>> 0, s,
        `preset "${preset.id}": structuralSeed ${s} is not a uint32`);
    }
  });

});

// ---------------------------------------------------------------------------
// Suite 3 — resolve does not throw; yields a non-empty graph + foliage
// ---------------------------------------------------------------------------

describe('PRESETS — resolve produces valid output', () => {

  for (const preset of PRESETS) {
    it(`resolve("${preset.id}", neutralEnv) returns graph.nodes.length > 0`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = resolve(preset.genome, NEUTRAL_ENV);
      }, `resolve threw for preset "${preset.id}"`);

      assert.ok(result !== null && result !== undefined,
        `resolve returned null/undefined for "${preset.id}"`);
      assert.ok(result.graph !== null && result.graph !== undefined,
        `resolve missing .graph for "${preset.id}"`);
      assert.ok(Array.isArray(result.graph.nodes) && result.graph.nodes.length > 0,
        `graph.nodes empty for preset "${preset.id}"`);
    });

    it(`resolve("${preset.id}", neutralEnv) yields a foliage set`, () => {
      const result = resolve(preset.genome, NEUTRAL_ENV);
      // foliage can be an object with .count or an array — just verify it exists
      assert.ok(result.foliage !== null && result.foliage !== undefined,
        `resolve missing .foliage for preset "${preset.id}"`);
      // foliage.count should be a non-negative number
      const count = result.foliage.count;
      assert.ok(typeof count === 'number' && count >= 0,
        `foliage.count is not a non-negative number for "${preset.id}": ${count}`);
    });
  }

});

// ---------------------------------------------------------------------------
// Suite 4 — presets are pairwise DISTINCT
// ---------------------------------------------------------------------------

describe('PRESETS — pairwise distinct gene vectors', () => {

  it('no two presets have identical gene vectors', () => {
    for (let i = 0; i < PRESETS.length; i++) {
      for (let j = i + 1; j < PRESETS.length; j++) {
        const same = genomesEqual(PRESETS[i].genome, PRESETS[j].genome);
        assert.equal(same, false,
          `presets "${PRESETS[i].id}" and "${PRESETS[j].id}" have identical gene vectors`);
      }
    }
  });

  it('all presets have distinct structuralSeeds', () => {
    const seeds = PRESETS.map(p => p.genome.structuralSeed);
    const unique = new Set(seeds);
    assert.equal(unique.size, seeds.length,
      `structuralSeeds are not all distinct: ${seeds}`);
  });

});

// ---------------------------------------------------------------------------
// Suite 5 — determinism: resolve twice → deep-equal
// ---------------------------------------------------------------------------

describe('PRESETS — resolve is deterministic', () => {

  for (const preset of PRESETS) {
    it(`resolve("${preset.id}") twice → deep-equal`, () => {
      const r1 = resolve(preset.genome, NEUTRAL_ENV);
      const r2 = resolve(preset.genome, NEUTRAL_ENV);
      assert.deepEqual(r1, r2,
        `resolve is not deterministic for preset "${preset.id}"`);
    });
  }

});

// ---------------------------------------------------------------------------
// Suite 6 — clone-on-load isolation (preset genome is not mutated by caller)
// ---------------------------------------------------------------------------

describe('PRESETS — preset genomes are safe to clone-on-load', () => {

  it('mutating a cloned genome does not affect the preset source', () => {
    for (const preset of PRESETS) {
      const originalSeed = preset.genome.structuralSeed;
      const clone = { ...preset.genome };
      clone.structuralSeed = 0xDEADBEEF >>> 0;
      assert.equal(preset.genome.structuralSeed, originalSeed,
        `mutating clone.structuralSeed affected preset "${preset.id}" source`);
    }
  });

});
