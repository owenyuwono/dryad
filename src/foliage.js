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
import { deriveTraits } from './allometry.js';

// ---------------------------------------------------------------------------
// Public constants — exposed for tuning and tests.
// ---------------------------------------------------------------------------

/**
 * Salt XOR'd with structuralSeed to produce the isolated spine RNG stream.
 * Must differ from 0x1EAF1EAF (the foliage stream salt) so the two streams
 * are independent even when spininess > 0.
 */
export const SPINE_SALT = 0x5B1E5B1E;

/** Maximum cluster (anchor) instances allocated (hard budget). */
export const MAX_LEAVES = 6000;

/**
 * Single-leaf expansion factor: each broadleaf CLUMP anchor produced by
 * generateFoliage is fanned into this many individual single-leaf cards by
 * expandClumpsToLeaves (the render-path "one leaf = one card" model). Fronds,
 * needle fascicles, and spiny stems are NOT expanded (their sprite is already a
 * whole unit) — see the gate in expandClumpsToLeaves.
 */
export const LEAVES_PER_CLUMP = 6;

/** Salt for the isolated RNG stream that fans clump anchors into leaves. */
export const LEAF_FAN_SALT = 0x1EAF0FA2;

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
// Spine constants — used by the gated spine post-pass.
// ---------------------------------------------------------------------------

/**
 * Base scale of a spine card in world units, before genome.spininess scaling.
 * Spines are short needles — deliberately much smaller than LEAF_BASE (0.80).
 */
export const SPINE_BASE_SCALE = 0.12;

/**
 * Number of spines emitted per eligible node, at spininess=1.
 * Density scales linearly with spininess so low values give a subtle bristle.
 */
export const SPINE_DENSITY = 6;

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
 * Sample tip-weighted positions on [skip, 1] using t^tipExp density.
 * Returns `n` values in (skip, 1].
 *
 * Strategy: generate evenly-spaced samples in [0,1] then map through the
 * inverse CDF of t^e density → t = ((k+0.5)/n)^(1/(e+1)) but adjusted for
 * the skip zone.
 *
 * After skip the active range is [skip, 1] of length L = 1 - skip.
 * We remap: s = skip + ((k+0.5)/n)^(1/(tipExp+1)) * L
 *
 * @param {number} n       — number of samples to generate
 * @param {number} skip    — proximal bare fraction to skip (0 = full coverage)
 * @param {number} [tipExp=TIP_EXPONENT] — exponent controlling tip-weighting strength;
 *   higher values push more clusters toward the distal tip. Defaults to TIP_EXPONENT
 *   so existing call sites are unchanged.
 */
function tipWeightedPositions(n, skip, tipExp = TIP_EXPONENT) {
  const L = 1.0 - skip;
  const exp = 1.0 / (tipExp + 1.0);
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
  // appendageDensity is the SINGLE foliage-density gene (former leafDensity folded in;
  // range widened to [0,1.5]). leafSize is the SINGLE leaf-size gene (former leafScale
  // folded in; range widened to [0.6,4.0]) — big palm/banana fronds come from a high
  // leafSize, not a separate multiplier.
  const appendageDensity = genome.appendageDensity !== undefined ? genome.appendageDensity : 0.4;
  const leafSize         = genome.leafSize          !== undefined ? genome.leafSize          : 1.1;
  const appendageBreadth = genome.appendageBreadth !== undefined ? genome.appendageBreadth : 0.45;
  const radialOrder      = genome.radialOrder      !== undefined ? genome.radialOrder      : 0.25;

  // weep ∈ [0,1]: 0 = no-op (normal orientation), 1 = leaves hang straight down.
  // Strict no-op at weep=0 — the blend block below is skipped entirely via guard.
  const weep = genome.weep ?? 0;

  // tipTuft ∈ [0,1]: 0 = no-op (existing tip-weighting), 1 = strongly concentrated
  // near branch tips (pine/conifer tufted look). Strict no-op at tipTuft=0 — when
  // tipTuft=0, effectiveTipExp === TIP_EXPONENT and effectiveSkip === bareSkip(level),
  // so the SoA output is byte-identical to the pre-tipTuft baseline.
  // NOTE: Only WHERE clusters sit changes — not how many rng() draws happen.
  const tipTuft = genome.tipTuft ?? 0;

  // Frondy plants — needle conifers, compound-frond palms, and rosette crowns
  // (fern/banana/palm) — clothe their branches with foliage ALONG the whole shaft
  // and need EVEN top-to-bottom coverage. The default broadleaf path tip-weights
  // clusters and probabilistically bares inner branches (sky gaps) — right for a
  // deciduous crown, but it leaves conifer spires and palm rachises bare and starves
  // the upper crown once the budget is hit ("dense bottom whorl, bald top" bug).
  // frondyness CONTINUOUSLY blends the distribution from broadleaf (tip-weighted,
  // sky-gaps) toward even shaft coverage. It now derives from the merged leaf model:
  //   leafDivision (compound/frond) → clothe the shaft;
  //   narrow leafWidth (a needle)   → clothe the shaft (narrowFactor);
  //   rosette                       → apical frond crown.
  // = 0 for every broadleaf preset / TREE_DEFAULT (leafDivision 0, leafWidth wide,
  // rosette 0), so all blends collapse to the exact broadleaf path (byte-identical).
  const leafDivision = genome.leafDivision ?? 0;
  const rosette      = genome.rosette      ?? 0;
  const leafWidthG   = genome.leafWidth    ?? 0.5;
  const narrowFactor = Math.max(0, Math.min(1, (0.30 - leafWidthG) / 0.30)); // 1 at leafWidth→0 (needle)
  const frondyness = Math.max(0, Math.min(1, Math.max(leafDivision, rosette, narrowFactor)));

  // ALLOMETRY: leafAreaScale ∝ sizeFactor^LEAF_AREA_EXP grows leaf-cluster cards
  // mildly with overall stature, so a tall plant's crown reads as a solid volume
  // instead of sparse same-size confetti scattered on long branches. Identity (×1.0)
  // at default stature (trunkHeight=0.5 → sizeFactor=1) → byte-identical card size
  // for default-height plants. Applied per-cluster in writeCluster via closure.
  const { leafAreaScale } = deriveTraits(genome);

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

  // Frondy even-coverage budget: spread ~90% of the body budget across ALL eligible
  // segments, weighted like tipBoost (outer branches a touch denser), so the total
  // never exhausts the budget mid-iteration (which would drain it onto the bottom of
  // the crown and leave the top bald). The per-segment value is further capped by the
  // normal density in the loop, so few-segment crowns (palm: a dozen long fronds)
  // don't over-saturate into giant blobs. Gated on frondyness > 0 → zero cost for broadleaf.
  let frondyPerSegBase = 0;
  if (frondyness > 0 && segments.length > 0) {
    let weightSum = 0;
    for (const s of segments) weightSum += 1 + 0.5 * s.node.branchLevel;
    frondyPerSegBase = (bodyBudget * 0.90) / Math.max(weightSum, 1);
  }

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
    // Leaf size is a UNIFORM species size (genome.leafSize) — it is NOT scaled by
    // the twig's crossfade weight (node.weight) any more. A thin / growing-in twig
    // keeps full-size leaves; its DENSITY (cluster count) is reduced instead — see
    // the body pass, which scales clustersPerSeg by node.weight. leafAreaScale is
    // the allometry term (∝ sizeFactor^0.5) so a tall crown reads as a volume.
    const clusterScale = LEAF_BASE * leafSize * (0.6 + 0.4 * appendageBreadth) * sizeJitter * leafAreaScale;

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

    // EMBEDDED PIVOT — the leaf base sits ON the branch/twig surface (radius =
    // midRadius), never floating in the canopy volume. Crown volume comes from
    // the blade leaning OUTWARD/up from this anchor (clusterTangent below), not
    // from displacing the base off the wood. Along-twig spread is already provided
    // by the t-positions + the jPos axial jitter above.
    const clusterBase = [
      jPos[0] + radialDir[0] * midRadius,
      jPos[1] + radialDir[1] * midRadius,
      jPos[2] + radialDir[2] * midRadius,
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

    // LEAF-HANG: blend tangent toward gravity (downward) proportional to weep.
    // At weep=0 this block is unreachable (outer guard `weep > 0` is never true),
    // so the SoA output is byte-identical to the pre-weep baseline. No rng draws.
    //
    // Concave curve: hang = sqrt(weep) so a moderate weep (e.g. 0.55) gives a
    // strong downward leaf hang (~0.74 effective blend) while branch droop in
    // proportions.js remains moderate. Decouples "leaves fall" from "branches droop."
    // weep=0 → hang=0 → block never entered → strict no-op (identity).
    //
    // PART A — recompute clusterNormal inside the weep block (only) so that when
    // clusterTangent ≈ [0,-1,0] the face normal is NOT sideways (which the old
    // cross(tangent, radialDir) formula produces for a downward tangent).
    // Instead use the Gram-Schmidt rejection of radialDir from clusterTangent:
    //   n = normalize(radialDir - clusterTangent * dot(radialDir, clusterTangent))
    // This gives a normal that is perpendicular to the hanging tangent and points
    // outward (in the radialDir hemisphere). Safe fallback to cross-product when
    // the rejection is degenerate (radialDir nearly parallel to clusterTangent).
    //
    // PART B — tilt that outward normal toward sky [0,1,0] by hang*k so hanging
    // cards catch overhead light. k=0.65 keeps the normal strongly sky-facing at
    // moderate weep (willow preset ≈ 0.55) while not over-correcting to pure up.
    // weep=0 → block never entered → clusterNormal computed outside as before.
    let weepNormal = null;
    if (weep > 0) {
      const hang = Math.sqrt(weep);
      const DOWN = [0, -1, 0];
      clusterTangent = norm3([
        clusterTangent[0] * (1 - hang) + DOWN[0] * hang,
        clusterTangent[1] * (1 - hang) + DOWN[1] * hang,
        clusterTangent[2] * (1 - hang) + DOWN[2] * hang,
      ]);

      // PART A: outward-facing normal perpendicular to the hanging tangent.
      const dRad = dot3(radialDir, clusterTangent);
      const rejX = radialDir[0] - clusterTangent[0] * dRad;
      const rejY = radialDir[1] - clusterTangent[1] * dRad;
      const rejZ = radialDir[2] - clusterTangent[2] * dRad;
      const rejLen = Math.sqrt(rejX * rejX + rejY * rejY + rejZ * rejZ);
      let outwardNormal;
      if (rejLen > 1e-6) {
        outwardNormal = [rejX / rejLen, rejY / rejLen, rejZ / rejLen];
      } else {
        // Degenerate: radialDir nearly parallel to tangent — fall back to cross-product.
        outwardNormal = norm3(cross3(clusterTangent, radialDir));
      }

      // PART B: tilt outward normal toward sky so hanging leaves catch overhead light.
      // k=0.65 gives enough sky-facing bias at willow preset (weep≈0.55, hang≈0.74)
      // without making all normals point straight up.
      const k = 0.65;
      const skyBlend = hang * k;
      weepNormal = norm3([
        outwardNormal[0] * (1 - skyBlend) + 0 * skyBlend,
        outwardNormal[1] * (1 - skyBlend) + 1 * skyBlend,
        outwardNormal[2] * (1 - skyBlend) + 0 * skyBlend,
      ]);
    }

    // clusterNormal: use weep-specific sky-facing normal when weep>0,
    // otherwise use the original formula (weep=0 path is byte-identical to before).
    const clusterNormal = weepNormal !== null
      ? weepNormal
      : norm3(cross3(clusterTangent, radialDir));
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
    const normalPerSeg = Math.round(BASE_DENSITY * appendageDensity * tipBoost);
    // Frondy even budget-fair share (keeps the whole crown clothed), capped by normal
    // density so palm's few fronds don't over-saturate, floored at 2 so the shaft is
    // never bare. CONTINUOUS blend toward it by frondyness; at frondyness=0 the guard
    // returns exactly normalPerSeg (byte-identical broadleaf).
    const frondyShare = Math.max(2, Math.min(Math.round(frondyPerSegBase * tipBoost), normalPerSeg));
    const clustersPerSegBase = frondyness <= 0
      ? normalPerSeg
      : Math.round(normalPerSeg + (frondyShare - normalPerSeg) * frondyness);
    // DENSITY ∝ twig crossfade weight: a thin / growing-in twig (node.weight < 1)
    // carries FEWER leaves rather than smaller ones (leaf size is now uniform — see
    // writeCluster). Established branches have weight 1 → unchanged.
    const segWeight = node.weight !== undefined ? node.weight : 1.0;
    const clustersPerSeg = Math.round(clustersPerSegBase * segWeight);
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
    } else {
      // Broadleaf gate probability for this level, blended CONTINUOUSLY toward 1.0
      // (clothe every branch — needles/leaflets line the whole shaft, no sky gaps) as
      // frondyness rises. At frondyness=0 this is exactly the original gate.
      // gateRoll was consumed above, so the draw cadence is unchanged.
      const broadleafProb = node.branchLevel < OUTER_LEVEL_THRESHOLD ? INNER_SEGMENT_PROB : MID_SEGMENT_PROB;
      const activeProb = broadleafProb + (1 - broadleafProb) * frondyness;
      segmentIsActive = gateRoll < activeProb;
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
    //
    // tipTuft modulates both the exponent and the skip:
    //   effectiveTipExp = TIP_EXPONENT + tipTuft * 4.0
    //     → at tipTuft=1 the exponent is 5.5, strongly concentrating clusters at the tip.
    //   effectiveSkip = baseSkip + (1 - baseSkip) * tipTuft * 0.6
    //     → as tipTuft rises, the bare zone expands toward the tip, pushing the
    //       active range further distal.
    // At tipTuft=0: effectiveTipExp === TIP_EXPONENT and effectiveSkip === baseSkip
    //   → byte-identical output to the pre-tipTuft baseline (strict no-op).
    // -----------------------------------------------------------------------
    // Broadleaf vs frondy bare-zone + tip-weighting, blended CONTINUOUSLY by frondyness.
    // Broadleaf: big proximal bare zone + strong tip weighting (clumps at tips, sky-gaps).
    // Frondy: tiny bare zone + near-even spread (clothed along the whole shaft).
    // At frondyness=0 the blend collapses to exactly the broadleaf values (byte-identical).
    const baseSkip = node.isTerminal ? 0 : bareSkip(node.branchLevel);
    const broadTipExp = TIP_EXPONENT + tipTuft * 4.0;
    const broadSkip   = baseSkip + (1 - baseSkip) * tipTuft * 0.6;
    const frondTipExp = 1.0 + tipTuft * 1.0;
    const frondSkip   = node.isTerminal ? 0 : 0.12;
    const effectiveTipExp = broadTipExp + (frondTipExp - broadTipExp) * frondyness;
    const effectiveSkip   = broadSkip   + (frondSkip   - broadSkip)   * frondyness;
    const tValues = tipWeightedPositions(bodyToPlace, effectiveSkip, effectiveTipExp);

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

    // Apical tuft count scales with BOTH the leaf-density gene AND the twig
    // crossfade weight. So leaf density = 0 → NO apical leaves (bare tips), and a
    // thin / growing-in tip carries fewer. Previously apical was floored at 1,
    // which kept every terminal leafy even at density 0 ("dense even at zero").
    const segWeight  = node.weight !== undefined ? node.weight : 1.0;
    const densFactor = Math.min(1, appendageDensity);
    const apicalToPlace = Math.min(Math.round(APICAL_CLUSTER * densFactor * segWeight), MAX_LEAVES - count);
    if (apicalToPlace < 1) continue;   // density/weight too low → no apical tuft here

    // Azimuth base for apical clusters — one draw per terminal segment.
    const azBase = rng() * Math.PI * 2;

    for (let idx = 0; idx < apicalToPlace; idx++) {
      // Spread from t=1.0 to t=1.03 — barely past the tip to bury it inside leaf
      // geometry without floating clusters into empty space above the branch end.
      const t = apicalToPlace === 1 ? 1.02 : 1.0 + (idx / (apicalToPlace - 1)) * 0.03;
      writeCluster(pPos, rawAxis, axis, segLen, midRadius, node, t, azBase, idx, leafAge, crownMinY, crownYRange, nodeIdx);
    }
  }

  // -------------------------------------------------------------------------
  // SPINE POST-PASS — gated on spininess > 0.
  //
  // Emits short, radially-oriented needle cards on woody nodes.  Uses a
  // completely separate RNG stream (SPINE_SALT) so the existing leaf draw
  // stream [0 .. oldCount) is NEVER disturbed.
  //
  // DETERMINISM INVARIANT:
  //   spininess === 0  →  this entire block is SKIPPED (zero rng draws,
  //   zero appended instances).  The SoA is byte-identical to the pre-pass
  //   baseline.  The guard must appear BEFORE any rng() call in this block.
  //
  // When spininess > 0:
  //   All existing leaf instances [0 .. oldCount) are untouched because:
  //     1. The spine rng stream is a fresh mulberry32 seeded independently.
  //     2. Spines only append (count grows from oldCount upward).
  //     3. writeCluster() uses the LEAF rng; spines use their own spineRng.
  //
  // Placement: one pass over `segments` (already collected, same list as
  // body pass).  Each woody node emits spineCount spine cards.  A spine card
  // has a small fixed scale (SPINE_BASE_SCALE * spininess), a tangent
  // pointing radially outward from the branch axis, and a normal that is
  // perpendicular to both the branch axis and the radial tangent — giving
  // the card a "standing-upright" needle orientation.
  // -------------------------------------------------------------------------
  const spininess = genome.spininess !== undefined ? genome.spininess : 0;

  if (spininess > 0) {
    // Fresh, isolated stream — NEVER touches the leaf rng above.
    const spineRng = mulberry32((genome.structuralSeed ^ SPINE_SALT) >>> 0);

    // Fractional-crossfade idiom: the marginal spine grows in (scale × spineFrac)
    // rather than Math.max(1, round()) hard-jumping to a full spine at spininess→0+
    // and then stepping. spineFrac scales the last spine's card in the loop below.
    const fractSpines = SPINE_DENSITY * spininess;   // 0..6
    const fullSpines  = Math.floor(fractSpines);
    const spineFrac   = fractSpines - fullSpines;
    const spineCount  = fullSpines + (spineFrac > 0 ? 1 : 0);
    const spineScale  = SPINE_BASE_SCALE * (0.5 + 0.5 * spininess);

    // Build an extended segment list for spines: includes ALL non-root skeleton
    // nodes (branchLevel 0 stem columns and branchLevel >= 1 branch arms alike).
    // This lets barrel cactus (unbranched, all nodes at branchLevel=0) grow spines
    // all along its main column, and saguaro gets spines on both trunk and arms.
    // Root nodes are always excluded.
    // This list is built ONLY inside the spininess > 0 guard, so it incurs zero
    // cost and zero rng draws when spininess === 0.
    const spineSegments = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.isRoot) continue;
      const pIdx = node.parentIdx;
      if (pIdx === undefined || pIdx < 0) continue;
      spineSegments.push({ parentIdx: pIdx, nodeIdx: i, node });
    }

    for (const { parentIdx, nodeIdx, node } of spineSegments) {
      if (count >= MAX_LEAVES) break;

      const parent  = nodes[parentIdx];
      const pPos    = parent.pos;
      const nPos    = node.pos;
      const rawAxis = [nPos[0] - pPos[0], nPos[1] - pPos[1], nPos[2] - pPos[2]];
      const segLen  = len3(rawAxis);
      if (segLen < 1e-10) {
        // Consume azimuth draw for this segment's spines for determinism.
        spineRng();
        continue;
      }
      const axis = norm3(rawAxis);

      // One azimuth base draw per segment (matches the body-pass pattern).
      const azBase = spineRng() * Math.PI * 2;

      const toPlace = Math.min(spineCount, MAX_LEAVES - count);

      for (let k = 0; k < toPlace; k++) {
        if (count >= MAX_LEAVES) break;

        // Position: evenly spaced along segment [0.05, 0.95] — avoid extremes.
        const t = 0.05 + (k / Math.max(toPlace - 1, 1)) * 0.90;

        const spinePos = [
          pPos[0] + rawAxis[0] * t,
          pPos[1] + rawAxis[1] * t,
          pPos[2] + rawAxis[2] * t,
        ];

        // Radial direction for this spine — rotate a perpendicular around the
        // branch axis by (azBase + k * GOLDEN_ANGLE) for even radial spread.
        const azimuth    = azBase + k * GOLDEN_ANGLE;
        const perp       = perpTo(axis);
        const radialDir  = rotate3(perp, axis, azimuth);

        // Small random azimuth jitter (1 draw per spine).
        const azJitter  = (spineRng() - 0.5) * 0.4;
        const finalDir  = rotate3(perp, axis, azimuth + azJitter);

        // Spine tangent: radially outward from the branch — the "pointing"
        // direction of the needle.
        const spineTangent = norm3(finalDir);

        // Spine normal: perpendicular to both branch axis and tangent so the
        // card face is visible from the side (not edge-on to the viewer).
        const spineNormal  = norm3(cross3(axis, spineTangent));

        // Tiny random roll for natural variation (1 draw per spine).
        const roll = (spineRng() - 0.5) * 0.5;

        // Exposure: reuse the height-based metric (no rng draw).
        const normalizedHeight = Math.max(0, Math.min(1, (spinePos[1] - crownMinY) / crownYRange));
        const expVal = Math.max(0, Math.min(1, 0.5 * (node.branchLevel / maxBranchLevel) + 0.5 * normalizedHeight));

        const i3 = count * 3;
        position[i3]     = spinePos[0];
        position[i3 + 1] = spinePos[1];
        position[i3 + 2] = spinePos[2];
        normal[i3]       = spineNormal[0];
        normal[i3 + 1]   = spineNormal[1];
        normal[i3 + 2]   = spineNormal[2];
        tangent[i3]      = spineTangent[0];
        tangent[i3 + 1]  = spineTangent[1];
        tangent[i3 + 2]  = spineTangent[2];
        // Marginal spine (the +1 crossfade) grows in from zero size as spininess rises.
        scale[count]     = (k === fullSpines && spineFrac > 0) ? spineScale * spineFrac : spineScale;
        rotation[count]  = roll;
        ageColor[count]  = node.branchLevel / maxBranchLevel;
        exposure[count]  = expVal;
        // boneIndex: inherit the branch's wind bone if nodeToBone is provided.
        if (nodeToBone !== null && nodeIdx >= 0 && nodeIdx < nodeToBone.length) {
          const bi = nodeToBone[nodeIdx];
          boneIndex[count] = (bi >= 0) ? bi : 0;
        }
        count++;
      }
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

// ---------------------------------------------------------------------------
// expandClumpsToLeaves — render-path helper.
//
// generateFoliage() produces CLUMP ANCHORS (one instance per anchor). For
// broadleaves we want one SINGLE LEAF per card, so we fan each anchor into
// LEAVES_PER_CLUMP individual leaves arranged as a small 3D spray around the
// anchor (azimuth via the golden angle, midribs splayed outward from the clump
// tangent, bases spread within the clump scale). This is RENDER-ONLY: it does
// NOT touch the generation pipeline or its rng — it reads the resolved foliage
// SoA and returns an expanded SoA for the leaf InstancedMesh.
//
// Gate: only broadleaf canopies expand. Frond/needle sprites are already a whole
// frond/fascicle per card, and spiny stems carry spine cards — for those we
// return the input SoA unchanged (K = 1 passthrough), so palms, conifers, and
// cacti render exactly as before.
//
// Pure ESM (no three.js). Uses an isolated mulberry32 stream so the fan layout
// is deterministic per (seed) but never perturbs generation.
// ---------------------------------------------------------------------------

export function expandClumpsToLeaves(foliage, genome = {}) {
  const inCount = foliage.count | 0;

  const leafDivision = genome.leafDivision ?? 0;
  const rosette      = genome.rosette      ?? 0;
  const spininess    = genome.spininess    ?? 0;
  const leafWidthG   = genome.leafWidth    ?? 0.5;
  const narrowFactor = Math.max(0, Math.min(1, (0.30 - leafWidthG) / 0.30));
  const frondyness   = Math.max(leafDivision, rosette, narrowFactor);

  // Only broadleaf canopies get one-leaf-per-card expansion (compound fronds,
  // needles, and spiny stems keep one whole-unit card per anchor).
  const K = (frondyness > 0.5 || spininess > 0.05) ? 1 : LEAVES_PER_CLUMP;
  if (K <= 1 || inCount === 0) return foliage;

  const maxOut   = inCount * K;
  const position = new Float32Array(3 * maxOut);
  const normal   = new Float32Array(3 * maxOut);
  const tangent  = new Float32Array(3 * maxOut);
  const scale    = new Float32Array(maxOut);
  const rotation = new Float32Array(maxOut);
  const ageColor = new Float32Array(maxOut);
  const exposure = new Float32Array(maxOut);
  const boneIndex = new Float32Array(maxOut);

  const inPos = foliage.position, inNrm = foliage.normal, inTan = foliage.tangent;
  const inScale = foliage.scale, inRot = foliage.rotation, inAge = foliage.ageColor;
  const inExp = foliage.exposure ?? null, inBone = foliage.boneIndex ?? null;

  const seed = (genome.structuralSeed ?? 1) >>> 0;
  const rng = mulberry32((seed ^ LEAF_FAN_SALT) >>> 0);

  const LEAF_SCALE = 0.58;   // single leaf size relative to the clump it came from
  const SPLAY      = 0.55;   // how strongly each midrib fans outward from the clump tangent (tuft spread)

  let out = 0;
  for (let c = 0; c < inCount; c++) {
    const c3 = c * 3;
    const P  = [inPos[c3], inPos[c3 + 1], inPos[c3 + 2]];
    const T  = norm3([inTan[c3], inTan[c3 + 1], inTan[c3 + 2]]);
    const Nf = norm3([inNrm[c3], inNrm[c3 + 1], inNrm[c3 + 2]]);
    const S  = inScale[c];
    const age = inAge[c];
    const exp = inExp ? inExp[c] : 1.0;
    const bone = inBone ? inBone[c] : 0;
    const roll0 = inRot[c];
    const X = norm3(cross3(T, Nf));   // clump "right" axis

    const az0 = rng() * Math.PI * 2;  // one azimuth-phase draw per clump
    for (let j = 0; j < K; j++) {
      const az = az0 + j * GOLDEN_ANGLE;
      const radial = rotate3(X, T, az);

      // EMBEDDED PIVOT: every leaf in the tuft shares the clump anchor as its base
      // (the anchor sits on the branch surface — see writeCluster), so no leaf base
      // floats off the twig. The tuft spreads by ORIENTATION (fanned midribs +
      // staggered azimuth), not by displacing the base into the canopy volume.
      const lx = P[0];
      const ly = P[1];
      const lz = P[2];

      // Midrib fans outward from the clump tangent toward the radial direction.
      const lt = norm3([
        T[0] * (1 - SPLAY) + radial[0] * SPLAY,
        T[1] * (1 - SPLAY) + radial[1] * SPLAY,
        T[2] * (1 - SPLAY) + radial[2] * SPLAY,
      ]);
      // Face normal: clump normal re-orthogonalised against the leaf midrib.
      const d = dot3(Nf, lt);
      let ln = norm3([Nf[0] - lt[0] * d, Nf[1] - lt[1] * d, Nf[2] - lt[2] * d]);
      if (!(ln[0] === ln[0])) ln = Nf;   // NaN guard (radial ∥ tangent)

      const sizeJ = 0.85 + rng() * 0.30; // 1 draw/leaf
      const o3 = out * 3;
      position[o3] = lx; position[o3 + 1] = ly; position[o3 + 2] = lz;
      normal[o3]  = ln[0]; normal[o3 + 1] = ln[1]; normal[o3 + 2] = ln[2];
      tangent[o3] = lt[0]; tangent[o3 + 1] = lt[1]; tangent[o3 + 2] = lt[2];
      scale[out]    = S * LEAF_SCALE * sizeJ;
      rotation[out] = roll0 + (rng() - 0.5) * 0.4;  // 1 draw/leaf
      ageColor[out] = age;
      exposure[out] = exp;
      boneIndex[out] = bone;
      out++;
    }
  }

  return {
    count: out,
    position, normal, tangent, scale, rotation, ageColor, exposure, boneIndex,
    shape: foliage.shape,
  };
}

// ---------------------------------------------------------------------------
// CROSSED_CARD_PLANES — number of intersecting quads emitted per cluster anchor
// in the 'crossed' (SpeedTree-style) leaf mode. 3 quads criss-crossed at
// 0°/60°/120° about the card's up axis read as a volumetric puff from any angle.
// Mirrors leafCardPreview.js's PLANES_PER_CARD.
// ---------------------------------------------------------------------------
export const CROSSED_CARD_PLANES = 3;

// ---------------------------------------------------------------------------
// expandClumpsToCrossedCards — render-path helper (SpeedTree-style crossed cards).
//
// For EACH cluster anchor, emit CROSSED_CARD_PLANES instances at the SAME
// position / scale / normal / tangent / exposure / bone / age, but with the roll
// (rotation field) staggered by k·(π/CROSSED_CARD_PLANES) so the cards criss-cross
// about the card's up axis (the tangent). leafMesh.update() rolls each card about
// its tangent by `rotation` (see buildInstanceMatrix), so staggering rotation alone
// produces the 0°/60°/120° intersecting-quad cluster of leafCardPreview.js — using
// the MULTI-LEAF cluster sprite (the viewer/forest build that sprite with
// leafMode:'crossed', which falls through to the cluster sprite branch).
//
// The output is foliage-SoA-shaped, so leaves.update() consumes it unchanged.
// PURE / RENDER-ONLY: no rng, no generation-pipeline mutation — the layout is a
// deterministic function of the input anchors. The instance count is K× the input
// (≤ MAX_LEAVES × CROSSED_CARD_PLANES, within LEAF_CAPACITY since LEAVES_PER_CLUMP
// = 6 > 3).
// ---------------------------------------------------------------------------

export function expandClumpsToCrossedCards(foliage, genome = {}) {
  const inCount = foliage.count | 0;
  const K = CROSSED_CARD_PLANES;
  if (K <= 1 || inCount === 0) return foliage;

  const maxOut    = inCount * K;
  const position  = new Float32Array(3 * maxOut);
  const normal    = new Float32Array(3 * maxOut);
  const tangent   = new Float32Array(3 * maxOut);
  const scale     = new Float32Array(maxOut);
  const rotation  = new Float32Array(maxOut);
  const ageColor  = new Float32Array(maxOut);
  const exposure  = new Float32Array(maxOut);
  const boneIndex = new Float32Array(maxOut);

  const inPos = foliage.position, inNrm = foliage.normal, inTan = foliage.tangent;
  const inScale = foliage.scale, inRot = foliage.rotation, inAge = foliage.ageColor;
  const inExp = foliage.exposure ?? null, inBone = foliage.boneIndex ?? null;

  // Stagger each plane's roll evenly across a half-turn (planes are double-sided,
  // so π / K spacing gives the full criss-cross without redundant back-to-back quads).
  const ROLL_STEP = Math.PI / K;

  let out = 0;
  for (let c = 0; c < inCount; c++) {
    const c3 = c * 3;
    const roll0 = inRot[c];
    for (let k = 0; k < K; k++) {
      const o3 = out * 3;
      position[o3]     = inPos[c3];     position[o3 + 1] = inPos[c3 + 1];     position[o3 + 2] = inPos[c3 + 2];
      normal[o3]       = inNrm[c3];     normal[o3 + 1]   = inNrm[c3 + 1];     normal[o3 + 2]   = inNrm[c3 + 2];
      tangent[o3]      = inTan[c3];     tangent[o3 + 1]  = inTan[c3 + 1];     tangent[o3 + 2]  = inTan[c3 + 2];
      scale[out]       = inScale[c];
      rotation[out]    = roll0 + k * ROLL_STEP;
      ageColor[out]    = inAge[c];
      exposure[out]    = inExp  ? inExp[c]  : 1.0;
      boneIndex[out]   = inBone ? inBone[c] : 0;
      out++;
    }
  }

  return {
    count: out,
    position, normal, tangent, scale, rotation, ageColor, exposure, boneIndex,
    shape: foliage.shape,
  };
}
