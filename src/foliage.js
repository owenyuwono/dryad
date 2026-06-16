// =============================================================================
// foliage.js — CLUSTER-CARD instance generation for the flora pipeline.
//
// generateFoliage(graph, genome) -> Structure-of-Arrays cluster set.
//
// Each instance is a CLUSTER card (a sprig of several leaves), so there are
// FEWER, BIGGER instances than the old per-leaf scheme.
//
// CLUSTER CANOPY RULES:
//  1. BARE LOWER TRUNK: branchLevel >= 1 only; skip the proximal bare zone
//     of each branch segment — deeper for inner structural branches.
//  2. TIP-WEIGHTING: cluster density ∝ t^TIP_EXPONENT (t=0 base → 1 tip).
//     Terminal segments always receive an extra apical cluster at t=1.
//  3. CANOPY ENVELOPE JITTER: position jittered ±JITTER_FRAC of the local
//     branch length for an irregular (not smooth) outer canopy silhouette.
//  4. UPWARD/OUTWARD LEAN: tangent/orientation biased toward +Y and radial
//     outward (stronger than the old single-leaf scheme).
//  5. SIZE VARIANCE: ±SIZE_JITTER per cluster, multiplied by node weight
//     (crossfade) and genome.leafSize.
//  6. CLUMP/GAP STRUCTURE: inner structural branches (low branchLevel,
//     non-terminal) are probabilistically bare so sky gaps appear between
//     foliage clumps, revealing branch structure. Terminal twigs always get
//     foliage (covered by apical pass).
//
// DETERMINISM INVARIANT:
//   rng = mulberry32((genome.structuralSeed ^ 0x1EAF1EAF) >>> 0)
//   This stream is completely separate from the skeleton rng and never
//   interferes with it. Same graph+genome → byte-identical SoA output.
//
// No three.js, pure ESM.
// =============================================================================

import { mulberry32 } from './rng.js';

// ---------------------------------------------------------------------------
// Public constants — exposed for tuning and tests.
// ---------------------------------------------------------------------------

/** Maximum cluster instances allocated (hard budget). */
export const MAX_LEAVES = 6000;

/**
 * Base clusters-per-segment before density scaling.
 * Tuned so a bushy genome (appendageDensity≈1, leafDensity≈1.5, branchiness≈1)
 * produces 2000–6000 clusters (a lush full canopy), and sparse yields a handful (~5–20).
 */
export const BASE_DENSITY = 12;

/**
 * Tip-weight exponent: cluster density ∝ t^TIP_EXPONENT along each segment.
 * Values > 1 push density toward the distal (tip) end.
 */
export const TIP_EXPONENT = 1.5;

/**
 * Fraction of each branch's length from its origin that is bare of clusters
 * on low-order branches (branchLevel 1). Kept for backward compatibility —
 * the actual skip values per level are computed by bareSkip().
 */
export const BARE_FRACTION = 0.25;

/**
 * Number of extra apical clusters added to terminal node segments.
 */
export const APICAL_CLUSTER = 3;

/**
 * Golden angle in radians — drives helical phyllotactic azimuth.
 */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.3999 rad

/**
 * Base cluster size in world units before genome modifiers.
 * Larger clusters overlap each other so adjacent cards fuse into a continuous
 * leafy mass rather than isolated sprigs on visible twigs.
 */
export const LEAF_BASE = 0.80;

/**
 * Silhouette jitter: fraction of segment length by which position is
 * perturbed along the branch axis for an irregular canopy envelope.
 */
export const JITTER_FRAC = 0.20;

/**
 * Volumetric fill: clusters are pushed this many cluster-sizes outward from
 * the branch axis, randomised each cluster.  Kept small so the cluster BASE
 * stays near the branch surface; the card's own size still gives the outward
 * puff.  Range [0, RADIAL_OFFSET_FRAC] * clusterScale.
 */
export const RADIAL_OFFSET_FRAC = 0.30;

/**
 * Additional spherical jitter applied on top of the radial offset so that the
 * crown surface is irregular (puffy/fluffy silhouette, not a smooth shell).
 * Kept small so jitter does not detach cluster bases from the branch surface.
 * Applied as a random displacement in a random direction ± this fraction of
 * clusterScale.
 */
export const VOLUME_JITTER_FRAC = 0.20;

/**
 * Size variance: per-cluster scale jitter range (±SIZE_JITTER fraction).
 * 0.30 → scale factor in [0.70, 1.30].
 */
export const SIZE_JITTER = 0.30;

/**
 * Phototropism strength: how strongly leaf tangent is lerped toward +Y.
 * Stronger than the old scheme (0.25 vs 0.15) for a more upward lean.
 */
export const PHOTO_STRENGTH = 0.25;

/**
 * Minimum branchLevel for full-density foliage.
 * Segments below this level are treated as inner structural branches and
 * receive sparse-to-zero body clusters (still covered by apical clusters at terminals).
 */
export const OUTER_LEVEL_THRESHOLD = 3;

/**
 * Probability that a non-terminal inner segment (branchLevel < OUTER_LEVEL_THRESHOLD)
 * gets any body clusters at all. Creates sky gaps in the mid-canopy.
 */
export const INNER_SEGMENT_PROB = 0.15;

/**
 * Probability that a non-terminal mid-level segment (branchLevel >= OUTER_LEVEL_THRESHOLD
 * but not outermost) gets body clusters. Higher than inner but still leaves gaps.
 */
export const MID_SEGMENT_PROB = 0.55;

// ---------------------------------------------------------------------------
// Internal math helpers (no allocations beyond small arrays).
// ---------------------------------------------------------------------------

function len3(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function norm3(v) {
  const l = len3(v);
  if (l < 1e-10) return [1, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Rodrigues rotation: rotate v around unit axis ax by angle (radians). */
function rotate3(v, ax, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot3(v, ax);
  const cr = cross3(ax, v);
  return [
    v[0] * c + cr[0] * s + ax[0] * d * (1 - c),
    v[1] * c + cr[1] * s + ax[1] * d * (1 - c),
    v[2] * c + cr[2] * s + ax[2] * d * (1 - c),
  ];
}

/**
 * Return a unit vector perpendicular to dir (arbitrary but stable).
 */
function perpTo(dir) {
  if (Math.abs(dot3(dir, [1, 0, 0])) < 0.9) {
    return norm3(cross3(dir, [1, 0, 0]));
  }
  return norm3(cross3(dir, [0, 0, 1]));
}

/**
 * Compute how much of the proximal fraction to skip for this branchLevel.
 * Inner structural branches get a deeper bare zone so branch structure shows.
 * Level 1: 55% bare zone. Level 2: 40%. Level 3: 20%. Level 4+: 8%.
 */
function bareSkip(branchLevel) {
  if (branchLevel <= 1) return 0.55;  // big bare zone on first-order branches
  if (branchLevel === 2) return 0.40; // still large for second-order
  if (branchLevel === 3) return 0.20; // moderate for third-order
  if (branchLevel >= 4) return 0.08;  // small bare zone for fine twigs
  return 0.55;
}

/**
 * Sample tip-weighted positions on [skip, 1] using t^TIP_EXPONENT density.
 * Returns `n` values in (skip, 1].
 *
 * Strategy: generate evenly-spaced samples in [0,1] then map through the
 * inverse CDF of t^e density → t = ((k+0.5)/n)^(1/(e+1)) but adjusted for
 * the skip zone.
 *
 * After skip the active range is [skip, 1] of length L = 1 - skip.
 * We remap: s = skip + ((k+0.5)/n)^(1/(TIP_EXPONENT+1)) * L
 */
function tipWeightedPositions(n, skip) {
  const L = 1.0 - skip;
  const exp = 1.0 / (TIP_EXPONENT + 1.0);
  const result = new Array(n);
  for (let k = 0; k < n; k++) {
    const normalized = Math.pow((k + 0.5) / n, exp);
    result[k] = skip + normalized * L;
  }
  return result;
}

// ---------------------------------------------------------------------------
// generateFoliage
// ---------------------------------------------------------------------------

/**
 * Generate cluster-card instances for the solved graph+genome.
 *
 * @param {object} graph  — output of buildSkeleton (mutated by solveProportions)
 * @param {object} genome — flora genome (all [0,1] fields)
 * @param {object} [opts] — optional
 * @param {Int32Array} [opts.nodeToBone] — node index → wind-bone index (length nodes.length,
 *   -1 if the node has no bone). When provided, each leaf's boneIndex SoA field is set from
 *   the attachment node's bone. When absent, boneIndex defaults to 0 (backward-compatible).
 * @returns {{
 *   count:     number,
 *   position:  Float32Array,  // 3 * MAX_LEAVES — world cluster base
 *   normal:    Float32Array,  // 3 * MAX_LEAVES — unit face normal
 *   tangent:   Float32Array,  // 3 * MAX_LEAVES — unit base→tip (midrib) direction
 *   scale:     Float32Array,  // MAX_LEAVES — per-cluster world-unit size
 *   rotation:  Float32Array,  // MAX_LEAVES — roll about tangent (radians)
 *   ageColor:  Float32Array,  // MAX_LEAVES — 0..1 tip/age tint
 *   exposure:  Float32Array,  // MAX_LEAVES — 0=inner/shaded, 1=outer/sunlit
 *   boneIndex: Float32Array,  // MAX_LEAVES — wind-bone index of each leaf's attachment branch; 0 if no nodeToBone
 *   shape:     number         // = genome.appendageBreadth
 * }}
 */
export function generateFoliage(graph, genome, opts) {
  // -------------------------------------------------------------------------
  // Allocate SoA buffers (full MAX_LEAVES size; only first `count` are valid).
  // -------------------------------------------------------------------------
  const position  = new Float32Array(3 * MAX_LEAVES);
  const normal    = new Float32Array(3 * MAX_LEAVES);
  const tangent   = new Float32Array(3 * MAX_LEAVES);
  const scale     = new Float32Array(MAX_LEAVES);
  const rotation  = new Float32Array(MAX_LEAVES);
  const ageColor  = new Float32Array(MAX_LEAVES);
  const exposure  = new Float32Array(MAX_LEAVES);
  const boneIndex = new Float32Array(MAX_LEAVES); // default 0 (backward-compatible)

  // nodeToBone map from opts (optional; when absent, boneIndex stays 0).
  const nodeToBone = (opts && opts.nodeToBone) ? opts.nodeToBone : null;

  // -------------------------------------------------------------------------
  // Genome genes with safe defaults.
  // -------------------------------------------------------------------------
  const appendageDensity = genome.appendageDensity !== undefined ? genome.appendageDensity : 0.4;
  const leafDensity      = genome.leafDensity      !== undefined ? genome.leafDensity      : 1.0;
  const leafSize         = genome.leafSize          !== undefined ? genome.leafSize          : 1.1;
  const appendageBreadth = genome.appendageBreadth !== undefined ? genome.appendageBreadth : 0.45;
  const radialOrder      = genome.radialOrder      !== undefined ? genome.radialOrder      : 0.25;

  // -------------------------------------------------------------------------
  // Separate deterministic RNG stream — NEVER touches the skeleton stream.
  // -------------------------------------------------------------------------
  const rng = mulberry32((genome.structuralSeed ^ 0x1EAF1EAF) >>> 0);

  const { nodes } = graph;

  // -------------------------------------------------------------------------
  // Collect eligible segments: (parentIdx → nodeIdx) where:
  //   - node.branchLevel >= 1  (no trunk/root segments)
  //   - not node.isRoot
  //   - node has a real parent (parentIdx >= 0)
  //   - node.isWoody || node.isTerminal
  // -------------------------------------------------------------------------
  const segments = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.isRoot) continue;
    if (node.branchLevel === undefined || node.branchLevel < 1) continue;
    const pIdx = node.parentIdx;
    if (pIdx === undefined || pIdx < 0) continue;
    if (!node.isWoody && !node.isTerminal) continue;
    segments.push({ parentIdx: pIdx, nodeIdx: i, node });
  }

  // -------------------------------------------------------------------------
  // Determine maximum branchLevel for ageColor normalization.
  // -------------------------------------------------------------------------
  let maxBranchLevel = 1;
  for (const { node } of segments) {
    if (node.branchLevel > maxBranchLevel) maxBranchLevel = node.branchLevel;
  }

  // -------------------------------------------------------------------------
  // Crown bounding box for exposure normalization.
  // -------------------------------------------------------------------------
  let crownMinY = Infinity;
  let crownMaxY = -Infinity;
  for (const { node } of segments) {
    if (node.pos[1] < crownMinY) crownMinY = node.pos[1];
    if (node.pos[1] > crownMaxY) crownMaxY = node.pos[1];
  }
  const crownYRange = Math.max(crownMaxY - crownMinY, 1e-6);

  // -------------------------------------------------------------------------
  // Place clusters on each eligible segment.
  //
  // TWO-PASS STRATEGY for guaranteed tip coverage:
  //   Pass 1 (body): for every segment, place tip-weighted body clusters.
  //     The body budget is capped at MAX_LEAVES minus the apical reserve so
  //     there is always room for the apical pass.
  //   Pass 2 (apical): for every terminal segment, place APICAL_CLUSTER clusters
  //     at t=1.0..1.15 (at and past the tip node), using the reserved slots.
  //
  // Apical reserve = number of terminal segments × APICAL_CLUSTER (upper bound).
  // Body budget = MAX_LEAVES − apical reserve.
  // This guarantees apical clusters always fit regardless of body cluster count.
  //
  // Each pass consumes one azBase rng draw per segment plus per-cluster draws,
  // maintaining full determinism (same graph+genome → identical output).
  // -------------------------------------------------------------------------
  let count = 0;

  const UP = [0, 1, 0];

  // Count terminal segments to determine the apical slot reserve.
  const terminalSegmentCount = segments.filter(s => s.node.isTerminal).length;
  const apicalReserve = Math.min(terminalSegmentCount * APICAL_CLUSTER, MAX_LEAVES);
  const bodyBudget    = MAX_LEAVES - apicalReserve;

  // -------------------------------------------------------------------------
  // Shared helper: write one cluster into the SoA at position `count`.
  // Consumes 9 rng draws per cluster (sizeJitter, jitter, azJitter, radialPush,
  // jPhi, jCosT, volJit, outAngle, clusterRoll).
  // nodeIdx is the attachment graph node index — used to look up the wind-bone
  // index via nodeToBone (when provided). No rng draws for this lookup.
  // -------------------------------------------------------------------------
  function writeCluster(pPos, rawAxis, axis, segLen, midRadius, node, t, azBase, k, leafAge, crownMinY, crownYRange, nodeIdx) {
    const segPos = [
      pPos[0] + rawAxis[0] * t,
      pPos[1] + rawAxis[1] * t,
      pPos[2] + rawAxis[2] * t,
    ];

    // SIZE
    const sizeJitter   = 1.0 + (rng() - 0.5) * 2.0 * SIZE_JITTER;
    const nodeWeight   = node.weight !== undefined ? node.weight : 1.0;
    // Leaf size is a uniform species size (genome.leafSize) — NOT scaled by branch
    // thickness. Real leaves are the same size on a fine twig as on a thick branch,
    // and they live mostly on the fine twigs, so scaling them down there was backwards.
    const clusterScale = LEAF_BASE * leafSize * (0.6 + 0.4 * appendageBreadth) * sizeJitter * nodeWeight;

    // CANOPY ENVELOPE JITTER
    const jitter = (rng() - 0.5) * 2.0 * JITTER_FRAC * segLen;
    const jPos = [
      segPos[0] + axis[0] * jitter,
      segPos[1] + axis[1] * jitter,
      segPos[2] + axis[2] * jitter,
    ];

    // AZIMUTH
    const azStep   = (1 - radialOrder) * Math.PI + radialOrder * GOLDEN_ANGLE;
    const azimuth  = azBase + k * azStep;
    const azJitter = (rng() - 0.5) * 0.6;
    const azFinal  = azimuth + azJitter;

    const perp      = perpTo(axis);
    const radialDir = rotate3(perp, axis, azFinal);

    // VOLUMETRIC CROWN FILL
    const radialPush = midRadius + rng() * RADIAL_OFFSET_FRAC * clusterScale;

    const jPhi  = rng() * Math.PI * 2;
    const jCosT = (rng() - 0.5) * 2.0;
    const jSinT = Math.sqrt(Math.max(0, 1 - jCosT * jCosT));
    const jDirX = jSinT * Math.cos(jPhi);
    const jDirY = jCosT;
    const jDirZ = jSinT * Math.sin(jPhi);
    const volJit = rng() * VOLUME_JITTER_FRAC * clusterScale;

    const clusterBase = [
      jPos[0] + radialDir[0] * radialPush + jDirX * volJit,
      jPos[1] + radialDir[1] * radialPush + jDirY * volJit,
      jPos[2] + radialDir[2] * radialPush + jDirZ * volJit,
    ];

    // UPWARD/OUTWARD LEAN
    const outAngle = (Math.PI / 4) + rng() * (Math.PI / 4);
    const outAxis  = norm3(cross3(axis, radialDir));
    let clusterTangent = rotate3(axis, outAxis, outAngle);
    clusterTangent = norm3([
      clusterTangent[0] * (1 - PHOTO_STRENGTH) + UP[0] * PHOTO_STRENGTH,
      clusterTangent[1] * (1 - PHOTO_STRENGTH) + UP[1] * PHOTO_STRENGTH,
      clusterTangent[2] * (1 - PHOTO_STRENGTH) + UP[2] * PHOTO_STRENGTH,
    ]);

    const clusterNormal = norm3(cross3(clusterTangent, radialDir));
    const clusterRoll   = (rng() - 0.5) * 0.8;

    // EXPOSURE: 0=deep/inner/shaded, 1=outer/top/sunlit
    const normalizedLevel  = node.branchLevel / maxBranchLevel;
    const normalizedHeight = Math.max(0, Math.min(1, (clusterBase[1] - crownMinY) / crownYRange));
    const expVal = Math.max(0, Math.min(1, 0.5 * normalizedLevel + 0.5 * normalizedHeight));

    const i3 = count * 3;
    position[i3]     = clusterBase[0];
    position[i3 + 1] = clusterBase[1];
    position[i3 + 2] = clusterBase[2];
    normal[i3]       = clusterNormal[0];
    normal[i3 + 1]   = clusterNormal[1];
    normal[i3 + 2]   = clusterNormal[2];
    tangent[i3]      = clusterTangent[0];
    tangent[i3 + 1]  = clusterTangent[1];
    tangent[i3 + 2]  = clusterTangent[2];
    scale[count]     = clusterScale;
    rotation[count]  = clusterRoll;
    ageColor[count]  = leafAge;
    exposure[count]  = expVal;
    // Wind-bone index: map attachment node → bone via nodeToBone (no rng draw).
    // When nodeToBone is absent, boneIndex stays 0 (Float32Array default).
    if (nodeToBone !== null && nodeIdx >= 0 && nodeIdx < nodeToBone.length) {
      const bi = nodeToBone[nodeIdx];
      boneIndex[count] = (bi >= 0) ? bi : 0;
    }
    count++;
  }

  // -------------------------------------------------------------------------
  // PASS 1 — body clusters for all segments (terminal and non-terminal).
  //
  // Body clusters fill [0, bodyBudget). One azBase rng draw per segment.
  //
  // CLUMP/GAP GATING: non-terminal inner/mid branches are probabilistically
  // skipped so sky gaps appear between foliage clumps, revealing branch
  // structure. The gate rng draw is ALWAYS consumed for determinism.
  // -------------------------------------------------------------------------
  for (const { parentIdx, nodeIdx, node } of segments) {
    if (count >= bodyBudget) break;

    const parent = nodes[parentIdx];
    const pPos   = parent.pos;
    const nPos   = node.pos;

    const rawAxis = [nPos[0] - pPos[0], nPos[1] - pPos[1], nPos[2] - pPos[2]];
    const segLen  = len3(rawAxis);
    if (segLen < 1e-10) {
      // Consume azimuth rng draw to maintain determinism even on degenerate segs.
      rng();
      continue;
    }
    const axis = norm3(rawAxis);

    // -----------------------------------------------------------------------
    // How many body clusters for this segment?
    // Outer segments (higher branchLevel) get more.
    // -----------------------------------------------------------------------
    const tipBoost = 1 + 0.5 * node.branchLevel;
    const clustersPerSeg = Math.round(BASE_DENSITY * appendageDensity * leafDensity * tipBoost);
    const bodyToPlace    = Math.min(Math.max(0, clustersPerSeg), bodyBudget - count);

    // Consume gate rng for determinism (always, even if bodyToPlace=0).
    const gateRoll = rng();

    if (bodyToPlace < 1) {
      // Consume azBase draw for determinism.
      rng();
      continue;
    }

    // -----------------------------------------------------------------------
    // CLUMP/GAP GATING:
    // Terminal segments are always active (apical pass covers them anyway;
    // body clusters add tip density).
    // Non-terminal inner/mid branches probabilistically bare → sky gaps.
    // -----------------------------------------------------------------------
    let segmentIsActive;
    if (node.isTerminal) {
      segmentIsActive = true;
    } else if (node.branchLevel < OUTER_LEVEL_THRESHOLD) {
      segmentIsActive = gateRoll < INNER_SEGMENT_PROB;
    } else {
      segmentIsActive = gateRoll < MID_SEGMENT_PROB;
    }

    const midRadius = (parent.radius + node.radius) * 0.5;
    const leafAge   = node.branchLevel / maxBranchLevel;

    // Azimuth base — always consumed (even if inactive, for determinism).
    const azBase = rng() * Math.PI * 2;

    if (!segmentIsActive) continue;

    // -----------------------------------------------------------------------
    // BARE ZONE RULE (deeper for inner branches):
    // Terminal twigs: skip=0 (tip-to-base full coverage).
    // Non-terminal: bareSkip() per branchLevel.
    // -----------------------------------------------------------------------
    const effectiveSkip = node.isTerminal ? 0 : bareSkip(node.branchLevel);
    const tValues = tipWeightedPositions(bodyToPlace, effectiveSkip);

    for (let k = 0; k < bodyToPlace; k++) {
      writeCluster(pPos, rawAxis, axis, segLen, midRadius, node, tValues[k], azBase, k, leafAge, crownMinY, crownYRange, nodeIdx);
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2 — apical clusters for every terminal segment.
  //
  // Apical t-values spread from t=1.0 to t=1.15 (past the tip node) so the
  // tapered tube end is buried inside leaf geometry (over-tip placement).
  // These use the reserved slots [bodyBudget, MAX_LEAVES).
  //
  // One azBase rng draw per terminal segment, then per-cluster draws.
  // Non-terminal segments are skipped (no rng consumed in this pass).
  // -------------------------------------------------------------------------
  for (const { parentIdx, nodeIdx, node } of segments) {
    if (!node.isTerminal) continue;
    if (count >= MAX_LEAVES) break;

    const parent = nodes[parentIdx];
    const pPos   = parent.pos;
    const nPos   = node.pos;
    const rawAxis = [nPos[0] - pPos[0], nPos[1] - pPos[1], nPos[2] - pPos[2]];
    const segLen  = len3(rawAxis);
    if (segLen < 1e-10) continue; // degenerate segment: skip, no rng consumed

    const axis      = norm3(rawAxis);
    const midRadius = (parent.radius + node.radius) * 0.5;
    const leafAge   = node.branchLevel / maxBranchLevel;

    const apicalToPlace = Math.min(APICAL_CLUSTER, MAX_LEAVES - count);
    if (apicalToPlace < 1) break;

    // Azimuth base for apical clusters — one draw per terminal segment.
    const azBase = rng() * Math.PI * 2;

    for (let idx = 0; idx < apicalToPlace; idx++) {
      // Spread from t=1.0 to t=1.03 — barely past the tip to bury it inside leaf
      // geometry without floating clusters into empty space above the branch end.
      const t = apicalToPlace === 1 ? 1.02 : 1.0 + (idx / (apicalToPlace - 1)) * 0.03;
      writeCluster(pPos, rawAxis, axis, segLen, midRadius, node, t, azBase, idx, leafAge, crownMinY, crownYRange, nodeIdx);
    }
  }

  return {
    count,
    position,
    normal,
    tangent,
    scale,
    rotation,
    ageColor,
    exposure,
    boneIndex,
    shape: appendageBreadth,
  };
}
