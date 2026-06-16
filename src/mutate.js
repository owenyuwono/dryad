// =============================================================================
// mutate.js — schema-driven mutation operator for the phylogeny layer
//
// Produces a nearby child genome from a parent genome, driven entirely by the
// passed schema. No hardcoded gene names appear in the mutation loop — a future
// FaunaGenome + FaunaSchema reuses this file unchanged.
//
// Draw schedule (fixed position, deterministic):
//   For each field in stable key order (Object.keys(schema)):
//     1. Draw rng() — "does it fire?" gate value.
//     2. If the field is a seed kind → skip fire/perturb; handle separately.
//     3. If gate value < tier fire-probability → draw perturbation value(s).
//        Categorical: rng() to pick the replacement option index.
//        Int:         rng() to determine direction (< 0.5 → minus, else plus).
//        Continuous:  rng() as the U(-1,+1) scale value.
//     4. Non-firing fields consume only the gate rng() draw (no extra draws).
//   LAST step (after the field loop):
//     5. Draw rng() once to re-derive structuralSeed for every child.
//        Placed last so the seed-field position in the schema does NOT shift the
//        draw count for subsequent non-seed fields regardless of schema ordering.
//
// This fixed draw schedule guarantees: same (genome, equally-seeded rng, strength)
// → deep-equal child, always.
// =============================================================================

import { FLORA_SCHEMA, clampField } from './genomeSchema.js';

// ---------------------------------------------------------------------------
// Exported tuning constants
// ---------------------------------------------------------------------------

/**
 * Base fire-probabilities per tier (multiplied by `strength` at call time).
 *   structural:  rare — changing body plan is a macromutation
 *   proportions: moderate — scaling/angle shifts within a body plan
 *   cosmetic:    frequent — colour/texture/jitter vary easily
 */
export const MUTATION_RATES = Object.freeze({
  structural:  0.06,
  proportions: 0.35,
  cosmetic:    0.80,
});

/**
 * Fractional-span multipliers for continuous fields when a mutation fires.
 *   K_PROPORTIONS: 20 % of the field's [lo,hi] span per unit strength
 *   K_COSMETIC:    35 % of the field's [lo,hi] span per unit strength
 */
export const K_PROPORTIONS = 0.20;
export const K_COSMETIC    = 0.35;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the K constant for a continuous field given its tier. */
function kForTier(tier) {
  if (tier === 'proportions') return K_PROPORTIONS;
  if (tier === 'cosmetic')    return K_COSMETIC;
  // structural continuous fields are unusual but handle gracefully
  return K_PROPORTIONS;
}

/**
 * Perturb one categorical field: choose a DIFFERENT option uniformly at random.
 * Draws exactly one rng() call.
 *
 * @param {readonly string[]} options  - valid option list from the schema field
 * @param {string}            current  - current value (will be excluded)
 * @param {() => number}      rng      - uniform [0,1) source
 * @returns {string}                   - a different option
 */
function perturbCategorical(options, current, rng) {
  const others = options.filter(o => o !== current);
  // If somehow only one option exists, stay put (can't change).
  if (others.length === 0) return current;
  const idx = Math.floor(rng() * others.length);
  return others[idx];
}

/**
 * Perturb one int field: step ±(1 + floor(strength * 1.5)), then clamp.
 * Draws exactly one rng() call (direction).
 *
 * @param {number}           value    - current int value
 * @param {number}           strength - mutation strength [0,1]
 * @param {[number, number]} range    - [lo, hi]
 * @param {() => number}     rng      - uniform [0,1) source
 * @param {object}           schema   - full schema (passed to clampField)
 * @param {string}           field    - field name (passed to clampField)
 * @returns {number}                  - clamped int
 */
function perturbInt(value, strength, schema, field, rng) {
  const step  = 1 + Math.floor(strength * 1.5);
  const delta = rng() < 0.5 ? -step : +step;
  return clampField(schema, field, value + delta);
}

/**
 * Perturb one continuous field: add U(-1,+1)*span*K*strength, then clamp.
 * Draws exactly one rng() call (scale).
 *
 * @param {number}       value    - current value
 * @param {number}       strength - mutation strength [0,1]
 * @param {object}       gene     - schema descriptor for this field
 * @param {object}       schema   - full schema
 * @param {string}       field    - field name
 * @param {() => number} rng      - uniform [0,1) source
 * @returns {number}              - clamped value
 */
function perturbContinuous(value, strength, gene, schema, field, rng) {
  const [lo, hi] = gene.range;
  const span  = hi - lo;
  const K     = kForTier(gene.tier);
  const delta = (rng() * 2 - 1) * span * K * strength;
  return clampField(schema, field, value + delta);
}

// ---------------------------------------------------------------------------
// mutate
// ---------------------------------------------------------------------------

/**
 * Produce a schema-valid child genome close to `genome`.
 *
 * GENOME-AGNOSTIC: the mutation loop references no hardcoded field names.
 * Everything — field names, tiers, kinds, ranges/options — is read from
 * `schema`.
 *
 * Draw schedule (see module docblock for full description):
 *   For each field (stable key order):
 *     gate draw:        rng()
 *     perturb draw(s):  rng()  (only when gate fires; 0 draws otherwise)
 *   After the field loop:
 *     seed draw:        rng()  (always; re-derives structuralSeed)
 *
 * @param {object}        genome   - parent genome (never mutated)
 * @param {() => number}  rng      - deterministic uniform [0,1) source
 * @param {number}        strength - mutation intensity, clamped to [0,1]
 * @param {object}        schema   - genome schema (defaults to FLORA_SCHEMA)
 * @returns {object}               - new child genome
 */
export function mutate(genome, rng, strength, schema = FLORA_SCHEMA) {
  // Clamp strength to [0,1].
  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength;

  // Shallow-copy the parent; values will be overwritten per-field below.
  const child = { ...genome };

  // Walk fields in stable key order.
  const fields = Object.keys(schema);

  // Track the name of any seed field so we can re-derive it at the end.
  // (Schema may have zero or more seed fields; we handle all of them.)
  const seedFields = [];

  for (const field of fields) {
    const gene = schema[field];

    if (gene.kind === 'seed') {
      // Seed fields: consume one gate draw (to keep the draw schedule intact
      // for fields that follow), but defer actual perturbation to after the loop.
      rng(); // gate draw — consumed but result ignored for seed fields
      seedFields.push(field);
      continue;
    }

    // --- gate draw ---
    const gate = rng();

    // Per-tier fire probability.
    const p = (MUTATION_RATES[gene.tier] ?? 0) * s;

    if (gate >= p) {
      // Doesn't fire — no perturbation draw; field stays at parent's value.
      continue;
    }

    // --- perturbation draw ---
    switch (gene.kind) {
      case 'categorical':
        child[field] = perturbCategorical(gene.options, child[field], rng);
        break;

      case 'int':
        child[field] = perturbInt(child[field], s, schema, field, rng);
        break;

      case 'continuous':
        child[field] = perturbContinuous(child[field], s, gene, schema, field, rng);
        break;

      default:
        // Unknown kind — leave value unchanged; no extra rng draw.
        break;
    }
  }

  // --- seed re-derivation (always last; one rng() draw per seed field) ---
  // Every child gets a fresh structuralSeed regardless of strength, so
  // siblings are never identical in jitter detail even when nothing else changed.
  for (const field of seedFields) {
    child[field] = (rng() * 2 ** 32) >>> 0;
  }

  return child;
}
