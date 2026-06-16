// =============================================================================
// biosphere.js — phylogeny generator for the FLORA procedural ecosystem
//
// Rolls one ancestral genome and branches+mutates it into N related species,
// recording a family tree (tree of descent). The tree is metadata only —
// every node stores a complete standalone genome that needs no parent to render.
//
// Export:
//   generateBiosphere(env, count, rootSeed, strength = 0.5)
//     -> { species: genome[], tree: { rootIndex: 0, nodes: TreeNode[] } }
//
// TreeNode:
//   { index, parentIndex, depth, divergence, genome }
//     index       — position in species[] and tree.nodes[]
//     parentIndex — index of phylogenetic parent (-1 for root)
//     depth       — generations from root (0 for root)
//     divergence  — genomeDistance(parent, child, FLORA_SCHEMA)  (0 for root)
//     genome      — complete standalone genome; resolve(genome, env) always works
//
// DETERMINISM CONTRACT:
//   Same (env, count, rootSeed, strength) → bit-identical { species, tree }.
//   Each step derives its own decorrelated rng from rootSeed and the step index
//   using the golden-ratio constant 0x9E3779B1. No Math.random, no shared state.
//
// PARENT SELECTION — weighted cumulative draw:
//   weight(i) = sqrt(count - i) + FLOOR
//   Earlier/trunk nodes are slightly more likely to attract new children
//   (the sqrt term decays gently), but the FLOOR ensures every node always has
//   a nonzero chance. Together these produce BOTH siblings (multiple children
//   off the same parent) AND multi-generation depth (chains extending downward),
//   avoiding both extremes (pure chain / pure star).
//
// Pure ESM — no three.js.
// =============================================================================

import { mulberry32 }               from './rng.js';
import { randomGenome }             from './genome.js';
import { mutate }                   from './mutate.js';
import { FLORA_SCHEMA, genomeDistance } from './genomeSchema.js';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Golden-ratio Knuth multiplicative constant — decorrelates per-step seeds. */
const GOLDEN = 0x9E3779B1;

/**
 * Additive floor added to every node's weight so the newest/deepest nodes
 * always retain a nonzero selection probability. Without this the sqrt term
 * for node i === count-1 collapses to sqrt(1) ≈ 1 while node 0 gets
 * sqrt(count), but the *relative* floor avoids near-zero weights when count
 * is very small (e.g. 2).
 */
const WEIGHT_FLOOR = 0.5;

// ---------------------------------------------------------------------------
// Internal: weighted parent draw
// ---------------------------------------------------------------------------

/**
 * Pick a parent index from the range [0, candidateCount) using a single
 * rng() draw over a cumulative-weight table.
 *
 * weight(i) = sqrt(candidateCount - i) + WEIGHT_FLOOR
 *   — sqrt decay means earlier (trunk) nodes are modestly more likely,
 *     producing deep subtrees as well as sibling clusters.
 *   — WEIGHT_FLOOR ensures every candidate retains a nonzero chance.
 *
 * @param {number}        candidateCount  number of existing nodes (>= 1)
 * @param {number}        countHint       the total species count (for weight scaling)
 * @param {() => number}  rng             uniform [0,1) source
 * @returns {number}                      chosen parent index in [0, candidateCount)
 */
function pickParent(candidateCount, countHint, rng) {
  // Build cumulative weight table.
  const cumulative = new Float64Array(candidateCount);
  let total = 0;
  for (let i = 0; i < candidateCount; i++) {
    total += Math.sqrt(countHint - i) + WEIGHT_FLOOR;
    cumulative[i] = total;
  }

  // Single draw maps into CDF.
  const target = rng() * total;

  // Linear scan (N is small — typically ≤ 100).
  for (let i = 0; i < candidateCount; i++) {
    if (target < cumulative[i]) return i;
  }

  // Floating-point edge: rng() could equal exactly 1.0 in theory.
  return candidateCount - 1;
}

// ---------------------------------------------------------------------------
// generateBiosphere
// ---------------------------------------------------------------------------

/**
 * Generate a family of `count` related plant species sharing a common ancestor.
 *
 * @param {object} env        Planet envelope (gravity, medium, energy, etc.)
 * @param {number} count      Number of species to generate (>= 1)
 * @param {number} rootSeed   Integer seed that anchors the entire family.
 *                            Different rootSeeds → different ancestral genomes.
 * @param {number} [strength] Mutation intensity per generation, clamped [0,1].
 *                            Higher strength → more phenotypic spread. Default 0.5.
 *
 * @returns {{ species: object[], tree: { rootIndex: number, nodes: object[] } }}
 *   species  — flat array of complete standalone genomes, length === count.
 *   tree     — descent metadata: rootIndex is always 0, nodes[] parallels species[].
 */
export function generateBiosphere(env, count, rootSeed, strength = 0.5) {
  // Clamp and coerce inputs.
  const n = count | 0;
  const seed = rootSeed >>> 0;
  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength;

  // Output arrays.
  const species = new Array(n);
  const nodes   = new Array(n);

  // --- ROOT (step 0) ---
  const root = randomGenome(env, seed);
  species[0] = root;
  nodes[0] = {
    index:       0,
    parentIndex: -1,
    depth:       0,
    divergence:  0,
    genome:      root,
  };

  // --- BRANCH + MUTATE (steps 1 … n-1) ---
  for (let step = 1; step < n; step++) {
    // Decorrelated per-step rng — independent of how many rng draws prior
    // steps consumed. The XOR with the golden-ratio constant spreads step
    // indices across the 32-bit seed space to avoid clustering.
    const stepSeed = (seed ^ (Math.imul(step, GOLDEN) >>> 0)) >>> 0;
    const r = mulberry32(stepSeed);

    // Weighted draw: pick a parent from the already-existing nodes.
    const parentIdx = pickParent(step, n, r);
    const parentNode = nodes[parentIdx];

    // Mutate the parent genome into a new child (r has already consumed one
    // draw in pickParent's cumulative walk; mutate draws its own sequence
    // deterministically from the same r).
    const child = mutate(parentNode.genome, r, s);
    const divergence = genomeDistance(parentNode.genome, child, FLORA_SCHEMA);
    const depth = parentNode.depth + 1;

    species[step] = child;
    nodes[step] = {
      index:       step,
      parentIndex: parentIdx,
      depth,
      divergence,
      genome:      child,
    };
  }

  return {
    species,
    tree: {
      rootIndex: 0,
      nodes,
    },
  };
}
