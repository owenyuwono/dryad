// =============================================================================
// STAGE 3 — buildSkeleton(genome, rng, jitterAmp=1.0) -> { nodes, bones, meta }
// Recursive tapering branch graph for procedural FLORA generation.
//
// CONTINUOUS MORPHOSPACE — no discrete body-plan modes.
// All structural parameters are derived from continuous [0,1] genes so that
// every gene interpolation yields a valid, smoothly-changing organism.
//
// GENOME FIELDS CONSUMED HERE (all [0,1] unless noted):
//   branchiness      — fractional maxDepth ∈ [0,4]
//   branchFactorN    — fractional children per node ∈ [1,4]
//   tillering        — fractional basal stem count ∈ [1,7]
//   radialOrder      — 0=bilateral, mid=radial-N, 1=phyllotaxis (float blended)
//   appendageBreadth — passed through to skin; not consumed here
//   appendageDensity — fractional terminals-per-node (future placeholder)
//   segmentation     — drives internode count ∈ [2,4] and trunk segments ∈ [3,6]
//   branchAngle      [0.35,0.80] radians
//   lengthRatio      [0.55,0.85]
//   apicalBias       [0,1]
//   droopBias        [-0.2,0.4]  — passed through to proportions stage
//   jitter           [0,1]       — base jitter amplitude (multiplied by jitterAmp arg)
//   structuralSeed   [0,1]       — deterministic curvature seed per organism (no rng draws)
//
// DERIVED (no longer explicit genes — see comments on each):
//   internodeCount  — derived from segmentation: floor(2 + segmentation*1) ∈ [2,3]
//   trunkSegments   — derived from segmentation: floor(3 + segmentation*3) ∈ [3,6]
//   The old discrete categoricals (growthHabit/symmetry/appendageKind) and ints
//   (maxDepth/branchFactor) are gone; replaced by continuous genes above.
//
// =============================================================================
//
// FRACTIONAL-COUNT CROSSFADE — the load-bearing continuity trick
// ==============================================================
// Many structural properties are "counts" (number of children, depth levels, etc.)
// Discrete count changes cause population jumps. We avoid this with:
//
//   Given fractional count x (e.g. 2.7 children):
//     - Build floor(x) FULL elements normally.
//     - Build ONE extra "crossfade" element at weight frac = x - floor(x).
//     - Scale that element's radius AND length by frac, so it GROWS IN FROM ZERO.
//     - At frac≈0 the element is invisible (zero-size); at frac≈1 it matches full.
//     - A small gene delta moves frac continuously with no population discontinuity.
//
// Applied to:
//   tillering (basal stems): fullStems full stems + 1 crossfade stem at weight stemFrac
//   branch children: fullChildren full + 1 crossfade at weight childrenFrac
//   branch depth: nodes at level==maxDepth receive children scaled by depthFrac,
//                 so the new level grows in from radius=0 continuously
//
// WEIGHTED STRUCTURAL METRIC (for continuity verification):
//   Sum each non-root, non-stem node's radius as a fraction of baseline (0.04).
//   This weighted sum changes continuously even when bone count has step-wise
//   changes, because new bones enter at near-zero radius and grow continuously.
//
// =============================================================================
//
// SKELETON STAGE RNG DRAW ORDER:
//   draw 1:  trunkBend   — lateral (X) arc
//   draw 2:  trunkLean   — fore-aft (Z) arc
//   Then for each basal stem (totalStems = fullStems + [0 or 1]), per stem:
//     draw 3+s: stem azimuth jitter
//   Then BFS in leader-first order, per branching node:
//     draws A, B, C = length jitter, angle jitter, azimuth jitter for leader
//     draws A, B, C = length jitter, angle jitter, azimuth jitter for each lateral
//   Per terminal node: 1 draw for flatNormal azimuth jitter
//
//   NOTE ON CURVATURE: per-internode curvature is computed deterministically
//   from structuralSeed, child index, and branch level — it does NOT consume
//   any additional rng draws. The existing drawB value (angle jitter) is also
//   reused as per-node wiggle within the curvature computation (see below).
//
// INVARIANT: rng draw count/order is NEVER affected by jitterAmp.
//
// BONE BUDGET — WORST-CASE:
//   Each trunk: trunkSegments ≤ 6 segments → ≤ 5 bones
//   Tillering: up to 7 basal stems, each with segments = up to 35 bones
//   Root system: out-of-band via roots.js (post-pass in resolve()); skeleton emits ZERO isRoot nodes.
//   BFS soft ceiling: MAX_BONES - 20 bones (boneCounter tracks trunk bones only; roots use a separate ROOT_BONE_BUDGET)
//   No final hard-clamp: bones array is returned at its true length.
//   Exported MAX_BONES = 900 — the absolute upper bound; callers may reference it.
//
// BRANCH CURVATURE — DESIGN NOTES:
//   Each internode chain curves its direction progressively as segments are placed.
//   At each segment j along the chain the direction is rotated by a small angle
//   that accumulates over the chain length. The curve consists of:
//     (a) A structural arc: a deterministic bend computed from structuralSeed, the
//         branch child index, and the branch level. This gives each branch organism-
//         specific character that is stable across runs (no rng draw consumed).
//     (b) A gravitropic droop: a gentle downward pull that increases with level,
//         so higher branches arch slightly. Magnitude is fixed at 0.04 rad/segment.
//     (c) A per-node wiggle: reuses the drawB value (already consumed) scaled down
//         to contribute a small random wander without any extra draws.
//   Total curvature per chain is bounded: the arc spans ≤ MAX_ARC_ANGLE per branch
//   and the combined rotation per segment is ≤ ~0.15 rad, which for intNodes≤4
//   never produces loops.
//
// TWIG TAPER — DESIGN NOTES:
//   Branch radii now scale with level so deeper branches are meaningfully thinner:
//     radius = BRANCH_BASE_RADIUS * childRadiusScale * tipTaper(level)
//   where tipTaper(level) = TAPER_BASE ^ level (exponential thinning toward tips).
//   Terminal branches are also made slightly longer (×TIP_LENGTH_BOOST) and wispier
//   to separate foliage clusters from stubby ends.
//   The 64-bone hard cap limits the total twig count. With intNodes=2..4 and
//   maxDepth=4, the budget is the binding constraint on how many fine twigs can
//   exist simultaneously — raising MAX_BONES would directly buy more terminal twigs.
// =============================================================================

import { computeSizeFactor, deriveTraits } from './allometry.js';

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function normalize(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  if (len < 1e-10) return [1, 0, 0];
  return [v[0]/len, v[1]/len, v[2]/len];
}

function cross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0]
  ];
}

function dot(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

// Rodrigues rotation: rotate vector v by angle around unit axis ax
function rotateAround(v, ax, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot(v, ax);
  const cr = cross(ax, v);
  return [
    v[0]*c + cr[0]*s + ax[0]*d*(1 - c),
    v[1]*c + cr[1]*s + ax[1]*d*(1 - c),
    v[2]*c + cr[2]*s + ax[2]*d*(1 - c)
  ];
}

// Compute a perpendicular vector to dir (unit)
function perpTo(dir) {
  if (Math.abs(dot(dir, [1, 0, 0])) < 0.9) {
    return normalize(cross(dir, [1, 0, 0]));
  }
  return normalize(cross(dir, [0, 0, 1]));
}

// Linearly interpolate between a and b
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Branch curvature helpers
// ---------------------------------------------------------------------------

// MAX_ARC_ANGLE: the maximum arc a single branch chain can subtend.
// At 0.55 rad (~31°) a branch noticeably curves without becoming a loop.
const MAX_ARC_ANGLE = 0.55;

// TAPER_BASE: radius multiplier per branch level. 0.72^1=0.72, 0.72^2=0.52,
// 0.72^3=0.37, 0.72^4=0.27 — terminal twigs are visibly thinner than primaries.
const TAPER_BASE = 0.72;

// TIP_LENGTH_BOOST: terminal (deepest) branches are a touch longer so foliage
// clusters sit on delicate twigs, not stubby endpoints.
const TIP_LENGTH_BOOST = 1.0;

// Branch base radius (unchanged from prior code).
const BRANCH_BASE_RADIUS = 0.04;

// computeCurvatureArc: returns a deterministic arc angle for a branch, derived
// purely from structuralSeed, branchChildIndex, and branchLevel.
// No rng draws consumed. Result is in [-MAX_ARC_ANGLE, +MAX_ARC_ANGLE].
function computeCurvatureArc(structuralSeed, childIndex, level) {
  // Mix structuralSeed with child/level to get unique-but-deterministic values.
  // Use simple integer arithmetic that won't drift.
  const h = Math.sin(structuralSeed * 6.2831 + childIndex * 2.3999 + level * 1.6180);
  return h * MAX_ARC_ANGLE * 0.6; // scale to 60% of max so it's gentle
}

// computeCurvatureAxis: returns a unit axis (perpendicular to dir) around which
// the branch arcs. Also deterministic. Uses a second hash offset.
function computeCurvatureAxis(dir, structuralSeed, childIndex, level) {
  const h = Math.sin(structuralSeed * 9.4248 + childIndex * 3.7699 + level * 2.7183);
  // Build a reference perpendicular to dir
  const base = perpTo(dir);
  // Rotate that reference around dir by a deterministic angle to pick the arc plane
  const planeAngle = h * Math.PI;
  return normalize(rotateAround(base, dir, planeAngle));
}

// buildCurvedChain: places intNodes segments along a curving branch.
//   startPos:       [x,y,z] — root of this chain
//   initialDir:     [x,y,z] unit — direction at chain start
//   segLen:         total chain length / intNodes (length per segment)
//   intNodes:       number of segments
//   arcAngle:       total arc the chain subtends (from computeCurvatureArc)
//   arcAxis:        unit axis for the arc rotation (from computeCurvatureAxis)
//   droopPerSeg:    gravitropic downward pull per segment (rad)
//   wigglePerSeg:   per-segment wiggle angle (rad) — reuses existing draw
//   wiggleAxis:     perpendicular axis for wiggle
//   radiusScale:    accumulated crossfade weight
//   level:          branch level (for tip taper)
//
// Returns: Array of { pos, dir } for each placed node (length = intNodes).
// The final entry's .dir is the direction for the next child's initial dir.
function buildCurvedChain(
  startPos, initialDir, segLen, intNodes,
  arcAngle, arcAxis,
  droopPerSeg, wigglePerSeg, wiggleAxis,
  radiusScale, level
) {
  const result = [];
  let pos = startPos;
  let dir = initialDir;
  const arcPerSeg = intNodes > 1 ? arcAngle / intNodes : 0;
  const WORLD_DOWN = [0, -1, 0];

  for (let j = 0; j < intNodes; j++) {
    // Step 1: arc curvature — rotate dir by arcPerSeg around arcAxis
    if (Math.abs(arcPerSeg) > 1e-6) {
      dir = normalize(rotateAround(dir, arcAxis, arcPerSeg));
    }

    // Step 2: gravitropic droop — gently pull dir toward world down
    if (Math.abs(droopPerSeg) > 1e-6) {
      dir = normalize(rotateAround(dir, perpTo(dir), droopPerSeg));
    }

    // Step 3: per-node wiggle — small wander using pre-computed wiggle axis
    if (Math.abs(wigglePerSeg) > 1e-6) {
      dir = normalize(rotateAround(dir, wiggleAxis, wigglePerSeg * (j % 2 === 0 ? 1 : -1)));
    }

    // Advance position
    pos = [
      pos[0] + dir[0] * segLen * radiusScale,
      pos[1] + dir[1] * segLen * radiusScale,
      pos[2] + dir[2] * segLen * radiusScale
    ];

    result.push({ pos: [...pos], dir: [...dir] });
  }
  return result;
}

// ---------------------------------------------------------------------------
// applySymmetry — ONE GENERAL OPERATOR for continuous radialOrder
//
// radialOrder ∈ [0,1] float — continuously blends three arrangements in one pass:
//   0.0       → bilateral: 2 copies, angle step = π (copies at 0° and 180°)
//   0.0..0.5  → zone A: angle step blends from π (bilateral) to 2π/N (radial)
//   0.5       → pure radial-N: N copies evenly spaced, no axis advance
//   0.5..1.0  → zone B: angle step blends from 2π/N (radial) to GOLDEN_ANGLE (phyllo)
//               axis advance blends from 0 to GOLDEN_ADVANCE
//   1.0       → phyllotaxis: 7 copies, golden-angle rotation + axis advance
//
// CONTINUITY:
//   N = 2 + floor(radialOrder * 5) — integer copy count, step-wise but bounded.
//   angleStep is always interpolated between adjacent modes (no if-branch on copy count).
//   axisAdvance grows continuously from 0 (at radialOrder=0.5) to GOLDEN_ADVANCE (at 1).
//   This means the arrangement morphs smoothly everywhere except at N integer steps,
//   where one copy pops in at near-zero weight (its angle offset is continuous).
//
// appendageSpec: Array<{ offset:[x,y,z] }>
// radialOrder:   float [0,1] — the genome gene
// axis:          [x,y,z] parent branch direction (unit)
// attachSite:    { pos:[x,y,z] }
// _rng:          passed for signature compatibility; NOT consumed
// Returns: Array of instances, each = Array<{ pos:[x,y,z] }>
// ---------------------------------------------------------------------------
export function applySymmetry(appendageSpec, radialOrder, axis, attachSite, _rng) {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.3999 rad ≈ 137.5°
  const GOLDEN_ADVANCE = 0.6; // total axis advance for full phyllotaxis arrangement

  // Integer copy count: bilateral=2, grows to 7 at radialOrder=1
  const N = 2 + Math.floor(radialOrder * 5);

  // Angle step between copies — continuously interpolated across two zones:
  //   zone A [0, 0.5]: π → 2π/N  (bilateral → radial whorl)
  //   zone B [0.5, 1]: 2π/N → GOLDEN_ANGLE  (radial → phyllotaxis)
  const radialStep = (Math.PI * 2) / N;
  let angleStep;
  if (radialOrder <= 0.5) {
    const t = radialOrder * 2; // 0..1 within zone A
    angleStep = lerp(Math.PI, radialStep, t);
  } else {
    const t = (radialOrder - 0.5) * 2; // 0..1 within zone B
    angleStep = lerp(radialStep, GOLDEN_ANGLE, t);
  }

  // Axis advance: 0 for bilateral/radial; grows continuously into phyllotaxis
  const advancePerCopyTotal = radialOrder > 0.5
    ? lerp(0, GOLDEN_ADVANCE, (radialOrder - 0.5) * 2)
    : 0;

  const instances = [];

  for (let i = 0; i < N; i++) {
    const rot = i * angleStep;
    // Center the axis advance around zero so attachment site stays in place
    const advance = N > 1
      ? (i / (N - 1)) * advancePerCopyTotal - advancePerCopyTotal * 0.5
      : 0;

    const limbNodes = [];
    for (const spec of appendageSpec) {
      const rotOff = rotateAround(spec.offset, axis, rot);
      limbNodes.push({
        pos: [
          attachSite.pos[0] + rotOff[0] + axis[0] * advance,
          attachSite.pos[1] + rotOff[1] + axis[1] * advance,
          attachSite.pos[2] + rotOff[2] + axis[2] * advance
        ]
      });
    }
    instances.push(limbNodes);
  }

  return instances;
}

// ---------------------------------------------------------------------------
// MAX_BONES — exported bone budget ceiling.
//
// The BFS in buildSkeleton spends up to (MAX_BONES - 20) bones before it
// gracefully terminates branches into tips. Callers (skin.js, tests) can import
// this to know the upper bound without hard-coding 64.
//
// Raised from 750 → 900 to accommodate the denser crown produced by
// branchFactorN≈0.65 (~3 children/node) and shorter internode chains (2–3
// segments), which generates more fork nodes at each level.
// More bones → more tube triangles but the FPS counter is the user's gauge.
// ---------------------------------------------------------------------------
export const MAX_BONES = 900;

// ---------------------------------------------------------------------------
// TRUNK_HEIGHT — world-space height of a full (weight=1) single trunk.
//
// Raised from 1.0 → 2.0 to produce a tall, clear trunk with the canopy
// starting high rather than a compressed ball near the ground.
// ---------------------------------------------------------------------------
const TRUNK_HEIGHT = 2.0;

// ---------------------------------------------------------------------------
// BASE_BRANCH_LENGTH — multiplier on the initial branch length fed into the BFS.
//
// All branch lengths start at (BASE_BRANCH_LENGTH * trunkHeight) and decay
// by lengthRatio at each successive level. Lowered from 1.5 → 1.0 so primary
// branches reach ~2× trunk height (not 3×), producing compact proportionate
// branches that fill the crown densely rather than whippy far-reaching arms.
// ---------------------------------------------------------------------------
const BASE_BRANCH_LENGTH = 1.0;

// ---------------------------------------------------------------------------
// LATERAL_SPREAD_BOOST — extra angular spread added to branchAngle for
// laterals at level >= 1 (never at the trunk-top fork, which is clamped).
//
// Pushes secondary/tertiary branches wider so the canopy fans out rather than
// hugging the trunk. Value in radians added on top of the genome branchAngle.
// ---------------------------------------------------------------------------
const LATERAL_SPREAD_BOOST = 0.15;

// ---------------------------------------------------------------------------
// buildSkeleton
//
// genome (the archetype arg): continuous gene vector.
//   All structural genes are [0,1] continuous. See file header for full list.
//
// jitterAmp: scales ALL per-node jitter magnitudes uniformly.
//   1.0 (default) → full jitter. 0 → unjittered ideal positions.
//   INVARIANT: rng draw count/order is NEVER affected by jitterAmp.
//
// Returns: { nodes, bones, meta }
// ---------------------------------------------------------------------------
export function buildSkeleton(genome, rng, jitterAmp = 1.0) {
  const {
    branchiness    = 0.5,   // [0,1] → fractional maxDepth ∈ [0,4]
    branchFactorN  = 0.5,   // [0,1] → fractional children per node ∈ [1,4]
    tillering      = 0.0,   // [0,1] → fractional basal stem count ∈ [1,7]
    radialOrder    = 0.0,   // [0,1] → bilateral(0) → radial-N → phyllotaxis(1)
    segmentation   = 0.5,   // [0,1] → internode and trunk segment counts
    branchAngle    = 0.5,   // [0.35,0.80] radians
    lengthRatio    = 0.7,   // [0.55,0.85]
    apicalBias     = 0.5,   // [0,1]
    // droopBias passed through to proportions stage, not used here
    jitter         = 0.5,   // [0,1] — base jitter amplitude
    structuralSeed = 0.0,   // [0,1] — deterministic curvature seed; no rng draws consumed
    trunkHeight    = 0.5,   // [0,1] — overall vertical stature; 0.5 = identity (1.0× factor)
  } = genome;

  // Defensive reads for new genes — identity/no-op at 0.
  const stemSpread = genome.stemSpread ?? 0; // [0,1] — basal footprint radius for multi-stem shrubs
  const rosette    = genome.rosette    ?? 0; // [0,1] — apical whorl frond count (fern/palm crown)
  // crownStart [0,1]: where the crown's primary branches begin along the trunk.
  // 1.0 = IDENTITY — branches fork only from the trunk TOP (peak), as before (palm).
  // <1.0 = ALSO emit primary branches from trunk nodes down to crownStart·H, so the
  // crown starts lower (birch / most broadleaves). Non-whorl path only (conifers use
  // the whorl tier startFrac). Gated so 1.0 draws zero extra rng → byte-identical.
  const crownStart = genome.crownStart ?? 1.0;

  // ---------------------------------------------------------------------------
  // trunkHeightFactor: the master vertical-stature multiplier. Single source of
  // truth is computeSizeFactor (allometry.js): piecewise, f(0.5)=exactly 1.0
  // (bit-exact identity), up to ~10× at trunkHeight=1. Multiplied onto TRUNK_HEIGHT
  // and BASE_BRANCH_LENGTH so the whole plant scales uniformly in height.
  //
  // ALLOMETRY (allometry.js deriveTraits): the same size factor also drives derived
  // laws below — branch-recursion depth and whorl tier count grow with stature so a
  // taller plant gains branch generations / tiers instead of merely stretching. All
  // are identity (0 / ×1) at sizeFactor=1, so default-stature plants are unchanged.
  // No rng draws consumed; no genome draw shifted.
  // ---------------------------------------------------------------------------
  const trunkHeightFactor = computeSizeFactor(trunkHeight);
  const traits = deriveTraits(genome);

  // -------------------------------------------------------------------------
  // Derive integer structural parameters from continuous genes.
  //
  // internodeCount and trunkSegments are no longer explicit genes. They are
  // both derived from `segmentation` because both represent branch resolution —
  // more segmentation = more geometry detail. A single gene avoids redundant knobs.
  //
  //   internodeCount ∈ [2,4]: floor(2 + segmentation*2)
  //   trunkSegments  ∈ [3,6]: floor(3 + segmentation*3)
  // -------------------------------------------------------------------------
  // internodeCount ∈ [2,3]: lowered upper bound from 4 → 3 so chains between
  // fork points are shorter, producing more frequent branching and a denser crown
  // rather than long whippy runs between sparse forks.
  const intNodes = Math.max(2, Math.min(3, Math.floor(2 + segmentation * 1)));
  // trunkSegmentsCount ∈ [5,8]: raised from [3,6] to give a taller trunk with
  // more curvature resolution and a more natural silhouette.
  const trunkSegmentsCount = Math.max(5, Math.min(8, Math.floor(5 + segmentation * 3)));

  // Fractional branch depth.
  //   branchiness=0 → fractDepth=0 → maxDepth=0 → no branching (unbranched stalk)
  //   branchiness=1 → fractDepth=7 → maxDepth=7
  //   depthFrac = remainder after floor: weight for crossfade at deepest level.
  //   At any integer boundary (fractDepth=N.00), depthFrac=0 so newly-appearing
  //   deepest-level children start at radius=0 and grow in continuously.
  //   Mapping changed from *4 → *7 so high branchiness reaches 6–7 levels,
  //   producing fine terminal twigs (the old *4 gave at most 4 levels).
  const fractDepth = branchiness * 7;
  const baseMaxDepth = Math.floor(fractDepth);
  const depthFrac  = fractDepth - baseMaxDepth; // ∈ [0,1): crossfade weight at deepest level
  // ALLOMETRY: a taller plant gains branch generations; a much shorter one sheds
  // them (sapling few orders ↔ old tree many). branchOrderBonus is 0 at default
  // stature (and for any near-default height it rounds to 0), so default presets
  // keep their exact hierarchy; the bone budget still caps the real depth reached.
  // GATED on baseMaxDepth > 0: a fundamentally UNBRANCHED plant (branchiness→0, e.g.
  // a palm/grass column) must stay unbranched no matter how tall — size extends an
  // existing branching program, it never invents one from nothing.
  const maxDepth = baseMaxDepth > 0
    ? Math.max(1, baseMaxDepth + (traits.branchOrderBonus || 0))
    : 0;

  // Fractional children: branchFactorN ∈ [0,1] → children ∈ [1,4]
  const fractChildren  = 1 + branchFactorN * 3;
  const fullChildren   = Math.floor(fractChildren);
  const childrenFrac   = fractChildren - fullChildren;

  // Fractional tillering: tillering ∈ [0,1] → basal stems ∈ [1,7]
  const fractStems = 1 + tillering * 6;
  const fullStems  = Math.floor(fractStems);
  const stemFrac   = fractStems - fullStems;

  // Combined jitter: genome jitter gene × call-site jitterAmp
  const jAmp = jitter * jitterAmp;

  const nodes = [];
  const bones = [];

  const BODY_AXIS = [0, 1, 0];
  const LIGHT_DIR = normalize([0.4, 0.9, 0.3]);
  // SOFT_CEILING: BFS stops spawning new branches when boneCounter reaches this value.
  // Set to MAX_BONES - 20 to leave room for trunk bones (≤35). Root system is out-of-band
  // (added by roots.js after buildSkeleton returns; uses a separate ROOT_BONE_BUDGET).
  const SOFT_CEILING = MAX_BONES - 20;

  // MAX_FOOTPRINT: maximum basal footprint radius (world units) at stemSpread=1, weight=1.
  // 0.6 gives a natural shrub spread without disconnecting visually from the origin.
  const MAX_FOOTPRINT = 0.6;

  // ROSETTE_MAX: maximum frond count for a full rosette (rosette=1).
  // 12 gives a lush palm/fern crown while staying within budget.
  const ROSETTE_MAX = 12;

  // -------------------------------------------------------------------------
  // RNG draw 1: trunkBend (lateral X arc)
  // RNG draw 2: trunkLean (fore-aft Z arc)
  // -------------------------------------------------------------------------
  const trunkBend = (rng() - 0.5) * 0.35 * jAmp;
  const trunkLean = (rng() - 0.5) * 0.25 * jAmp;

  // -------------------------------------------------------------------------
  // buildTrunk: create trunk nodes for one stem, returning all node indices.
  // weight: 1.0 for full stems, stemFrac for the crossfade stem.
  //   Applied to BOTH radius AND the vertical height (length) of the trunk,
  //   so a fading-in stem grows from a near-zero stub up to full height.
  // stemAz: azimuth (radians) used to fan multi-stem trunks outward from the
  //   shared base. For single-stem genomes (az=0) this has no net effect.
  //   The outward lean is a sinusoidal arc peaking at mid-trunk, so the base
  //   node always stays at (0,0,0) regardless of azimuth. This keeps every
  //   stem rooted at the shared origin while letting them diverge above it.
  //   MAX_STEM_FAN_RADIUS: maximum horizontal spread at mid-trunk for a full
  //   (weight=1) stem. Scales by weight so crossfade stubs barely spread.
  // -------------------------------------------------------------------------
  const MAX_STEM_FAN_RADIUS = 0.18; // modest outward lean for grass-like fans
  function buildTrunk(basePos, weight, stemAz = 0) {
    const trunkNodeIndices = [];
    for (let i = 0; i < trunkSegmentsCount; i++) {
      const t = trunkSegmentsCount > 1 ? i / (trunkSegmentsCount - 1) : 0;
      // Scale the full trunk height by both weight (crossfade) and trunkHeightFactor (gene).
      const trunkHeight = TRUNK_HEIGHT * trunkHeightFactor * weight;
      // trunkBend/trunkLean arc for overall organism lean (same for all stems).
      const bendArc = trunkBend * Math.sin(t * Math.PI) * weight;
      const leanArc = trunkLean * Math.sin(t * Math.PI) * weight;
      // Per-stem azimuth fan: pushes each stem outward from origin in its own
      // direction. Fan amplitude grows from 0 (at base i=0) to MAX at mid-trunk
      // then back toward less (sin-shaped). Base node i=0 always stays at
      // basePos regardless of az, so all stems share a single ground point.
      const fanAmp = MAX_STEM_FAN_RADIUS * Math.sin(t * Math.PI) * weight;
      const xOff = basePos[0] + bendArc + fanAmp * Math.cos(stemAz);
      const zOff = basePos[2] + leanArc + fanAmp * Math.sin(stemAz);
      const yPos = basePos[1] + t * trunkHeight;

      const idx = nodes.length;
      nodes.push({
        pos: [xOff, yPos, zOff],
        radius: 0.12 * weight,
        weight,
        branchLevel: 0,
        isStem: true,
        parentIdx: i === 0 ? -1 : idx - 1
      });
      trunkNodeIndices.push(idx);

      if (i > 0) {
        bones.push({ a: idx - 1, b: idx });
      }
    }
    return trunkNodeIndices;
  }

  // -------------------------------------------------------------------------
  // TILLERING: fractional basal stem count
  //
  // CROSSFADE: fullStems full stems + 1 optional crossfade stem (at weight stemFrac).
  //   The crossfade stem has radius = 0.12 * stemFrac (growing from near-zero).
  //   RNG draws are always consumed for all stems (full + crossfade) to maintain
  //   determinism even when stemFrac changes.
  // -------------------------------------------------------------------------
  const totalStems = fullStems + (stemFrac > 0 ? 1 : 0);

  // Draw one azimuth jitter per stem (always, for determinism)
  const stemAzimuths = [];
  for (let s = 0; s < totalStems; s++) {
    stemAzimuths.push(rng() * Math.PI * 2); // draws 3..3+totalStems-1
  }

  const allTrunkTops = []; // { idx: nodeIdx, weight: radiusScale }
  const allTrunkChains = []; // { chain: nodeIdx[], weight } — full trunk node chains (for crownStart)

  // -------------------------------------------------------------------------
  // MULTI-STEM POSITIONING: stemSpread controls basal footprint.
  //
  // stemSpread === 0 → all stems share origin (0,0,0): BYTE-IDENTICAL to prior code.
  // stemSpread > 0   → each stem base is placed on a ring of radius
  //   R = stemSpread * MAX_FOOTPRINT * weight, using the already-drawn stemAzimuths[s].
  //   Base node i=0 in buildTrunk starts at basePos (no sin-term offset at t=0),
  //   so the footprint ring is applied at ground level.
  //
  // SINGLE-STEM EXCEPTION: if totalStems === 1, the base ALWAYS stays at origin
  // for ALL stemSpread values (a lone stem has no footprint to spread). This keeps
  // every tree preset byte-identical regardless of stemSpread.
  // -------------------------------------------------------------------------
  if (totalStems === 1) {
    // Single stem: center position, no azimuth divergence, no footprint spread.
    const ti = buildTrunk([0, 0, 0], 1.0, 0);
    allTrunkTops.push({ idx: ti[ti.length - 1], weight: 1.0 });
    allTrunkChains.push({ chain: ti, weight: 1.0 });
  } else {
    for (let s = 0; s < totalStems; s++) {
      const az = stemAzimuths[s];
      const isCrossfade = s === fullStems;
      const weight = isCrossfade ? stemFrac : 1.0;
      // Footprint: spread base outward from origin along the stem's azimuth.
      // At stemSpread=0 → R=0 → basePos=(0,0,0) → byte-identical to prior code.
      const R = stemSpread * MAX_FOOTPRINT * weight;
      const basePos = [Math.cos(az) * R, 0, Math.sin(az) * R];
      const ti = buildTrunk(basePos, weight, az);
      allTrunkTops.push({ idx: ti[ti.length - 1], weight });
      allTrunkChains.push({ chain: ti, weight });
    }
  }

  // Root system is grown out-of-band by growRootSystem() in roots.js, called from
  // resolve() after buildSkeleton returns. skeleton.js emits ZERO isRoot nodes.
  //
  // RISK D MITIGATION (stub removal budget accounting):
  // The old root-flare stub pushed 3 bones before `boneCounter = bones.length`, so the
  // BFS budget effectively started 3 higher. Removing the stub makes boneCounter start
  // 3 lower, giving the BFS 3 extra bones of headroom — which CHANGES canopy topology
  // for budget-bound genomes (verified: bushy/high-branchiness genomes peg at the
  // SOFT_CEILING of 880, so they ARE affected). To keep every existing seed's canopy
  // BIT-IDENTICAL to the pre-roots output, we reserve those 3 ex-stub bones here.
  // PATH TAKEN: (b) start boneCounter as if the 3 stub bones still occupied budget.
  const ROOT_STUB_RESERVED_BONES = 3; // bones the old isRoot flare stub used to consume
  let boneCounter = bones.length + ROOT_STUB_RESERVED_BONES;

  // -------------------------------------------------------------------------
  // markTerminal: tag a node as a terminal appendage.
  //
  // HANDOFF TO SKIN: We do NOT set node.flat here. The skin stage reads
  // genome.appendageBreadth and computes flattening itself. We only set
  // isTerminal and flatNormal (geometry-derived normal axis for skin to orient).
  //
  // Consumes 1 rng draw (azimuth jitter for flatNormal).
  // -------------------------------------------------------------------------
  function markTerminal(nodeIdx, branchDir, attachPos) {
    const node = nodes[nodeIdx];
    delete node.isWoody;
    node.isTerminal = true;
    node.attachPos = [...attachPos];
    // flatNormal: geometry-derived, skin uses this to orient the flattened card.
    // node.flat is NOT set here — skin reads genome.appendageBreadth instead.

    const azimuthJitter = rng() * Math.PI * 2; // 1 draw, always consumed

    const parallelTest = Math.abs(dot(branchDir, BODY_AXIS));
    let rawNormal;
    if (parallelTest > 0.97) {
      rawNormal = [1, 0, 0];
    } else {
      rawNormal = normalize(cross(branchDir, BODY_AXIS));
    }
    node.flatNormal = rotateAround(rawNormal, branchDir, azimuthJitter);
  }

  // -------------------------------------------------------------------------
  // BFS BRANCHING
  //
  // Queue item: { nodeIdx, level, dir, len, attachPos, radiusScale }
  //   radiusScale: accumulated crossfade weight from parent stems/depth levels.
  //                Multiplied onto all child node radii.
  //
  // DEPTH CROSSFADE:
  //   When we create children at level == maxDepth (the deepest full level),
  //   those children's radii are scaled by depthFrac (the remainder of fractDepth).
  //   At the transition point (e.g. fractDepth=1.02), depthFrac≈0.02, so new
  //   nodes at the first branching level enter at near-zero radius and grow
  //   continuously as branchiness increases. This is the crossfade for depth.
  //
  // CHILD COUNT CROSSFADE:
  //   fullChildren full-weight children + 1 crossfade child (weight=childrenFrac).
  //   All draws for crossfade child are consumed even when it won't change
  //   topology (determinism invariant).
  // -------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Constants for tiered whorl emission (moved from post-pass, now BFS-integrated).
  // ---------------------------------------------------------------------------
  const WHORL_MAX_TIERS          = 9;    // maximum number of tiers at whorl=1
  const WHORL_BRANCHES_PER_TIER  = 7;    // branches emitted per tier
  const WHORL_START_FRAC_MAX     = 0.65; // at whorl=1 the bare lower trunk is the bottom 65% (clean pine-like bole)
  const WHORL_TRUNK_END_FRAC     = 0.95; // upper bound for tier placement
  const WHORL_BASE_LEN_FRAC      = 0.30; // base tier branch length as fraction of trunk span (narrower cone)
  const WHORL_TOP_LEN_FRAC       = 0.07; // top tier branch length as fraction of trunk span
  const INTER_TIER_OFFSET        = Math.PI / WHORL_BRANCHES_PER_TIER; // per-tier azimuth rotation offset
  const WHORL_CROWN_ANGLE        = 0.25; // rad from vertical near crown (upswept)
  const WHORL_BASE_ANGLE         = 1.15; // rad from vertical near base (near-horizontal / slight droop)

  const queue = [];

  const whorl = genome.whorl ?? 0;

  if (whorl > 0 && allTrunkTops.length > 0) {
    // Each tier's BFS continuations are bucketed by tier (tierBuckets[ti]) instead of
    // enqueued directly, so BFS ORDER can be controlled below. Plain FIFO BFS expands
    // whichever tier is enqueued first and, once the bone budget is spent, starves the
    // rest — which left either the bottom (was) or the top (naive reverse) of the
    // conifer bald. Round-robin enqueue (below) spreads the budget evenly across ALL
    // tiers so the whole cone develops, with a mild apex-first bias for the spire.
    const tierBuckets = [];

    // ----- Collect trunk chain from dominant (first) stem in ascending-Y order -----
    const dominantTrunkTopIdx = allTrunkTops[0].idx;
    const trunkChain = []; // { nodeIdx, y }
    {
      let cur = dominantTrunkTopIdx;
      while (cur !== -1) {
        const n = nodes[cur];
        if (!n.isStem) break;
        trunkChain.push({ nodeIdx: cur, y: n.pos[1] });
        cur = n.parentIdx ?? -1;
      }
      trunkChain.reverse(); // base → top (ascending Y)
    }

    if (trunkChain.length >= 2) {
      const trunkBaseY = trunkChain[0].y;
      const trunkTopY  = trunkChain[trunkChain.length - 1].y;
      const trunkSpan  = trunkTopY - trunkBaseY;

      // startFrac: fraction of trunk height where tiers begin.
      // Lerp from 0 (whorl→0: tiers anywhere) to WHORL_START_FRAC_MAX (whorl=1: lower 55% bare).
      const startFrac = lerp(0.0, WHORL_START_FRAC_MAX, whorl);

      // CROSSFADE tier count — mirrors tillering/depth crossfade pattern.
      //
      //   tierCountFloat = whorl * WHORL_MAX_TIERS   (continuous, ∈ [0, WHORL_MAX_TIERS])
      //   fullTiers      = floor(tierCountFloat)       (integer number of fully-weighted tiers)
      //   whorlTierFrac  = tierCountFloat - fullTiers  (∈ [0,1): crossfade weight for the +1 tier)
      //
      // Tiers 0..fullTiers-1: radius = whorlBaseRadius (full weight, 1.0).
      // Tier   fullTiers    : radius = whorlBaseRadius * whorlTierFrac (grows from ~0 as whorl rises).
      //
      // At whorl→0+: tierCountFloat→0+, fullTiers=0, whorlTierFrac→0+ → single partial tier
      //              with branches at ~0 radius → invisible → NO pop at the 0-boundary.
      // At whorl=1:  tierCountFloat=9, fullTiers=9, whorlTierFrac=0 → 9 full tiers, no partial.
      //
      // ALLOMETRY: tier count scales with stature (traits.tierCountScale, 1.0 at
      // default height) so a tall whorled stem stacks MORE tiers at ~constant spacing
      // rather than stretching a fixed count apart. Capped so it cannot explode; the
      // bone budget caps the real count too. Identity (×1) at sizeFactor=1.
      const WHORL_TIER_HARD_MAX = 18;
      const tierCountFloat = Math.min(
        WHORL_TIER_HARD_MAX,
        whorl * WHORL_MAX_TIERS * traits.tierCountScale
      );
      const fullTiers      = Math.floor(tierCountFloat);
      const whorlTierFrac  = tierCountFloat - fullTiers;

      // Total tiers to emit: full tiers + 1 crossfade tier (when frac > 0).
      const N_tiers = fullTiers + (whorlTierFrac > 0 ? 1 : 0);

      // Primary branch length at base tier.
      const primaryLen = BASE_BRANCH_LENGTH * TRUNK_HEIGHT * trunkHeightFactor;

      for (let ti = 0; ti < N_tiers; ti++) {
        // Stop early if budget is fully consumed.
        if (boneCounter >= SOFT_CEILING) break;

        // Crossfade weight for this tier's branch radii/lengths.
        // Only the last (newest) tier — index fullTiers — gets the fractional scale.
        // All prior tiers are full-weight (1.0).
        const isCrossfadeTier = ti === fullTiers && whorlTierFrac > 0;
        const tierRadiusScale = isCrossfadeTier ? whorlTierFrac : 1.0;

        // Even spacing within [startFrac, WHORL_TRUNK_END_FRAC].
        // Use N_tiers > 1 guard; for the partial single-tier case (fullTiers=0, N_tiers=1) use 0.5.
        const tierPosFrac = N_tiers > 1 ? ti / (N_tiers - 1) : 0.5;
        const frac = startFrac + (WHORL_TRUNK_END_FRAC - startFrac) * tierPosFrac;
        const targetY = trunkBaseY + frac * trunkSpan;

        // Snap to the nearest existing trunk-chain node at or ABOVE targetY.
        // Snapping upward (ceil snap) preserves the "lower trunk bare" invariant —
        // no tier can attach below startFrac even when trunk node spacing is coarse.
        let snapIdx = -1;
        let bestDist = Infinity;
        for (const tc of trunkChain) {
          if (tc.y < targetY - 1e-6) continue; // skip nodes strictly below target
          const d = tc.y - targetY; // distance above (non-negative)
          if (d < bestDist) {
            bestDist = d;
            snapIdx = tc.nodeIdx;
          }
        }
        // Fallback: if no node is at or above (trunk is shorter than expected), use the topmost.
        if (snapIdx === -1) snapIdx = trunkChain[trunkChain.length - 1].nodeIdx;

        const snapNode = nodes[snapIdx];
        const snapPos  = snapNode.pos;

        // Branch length: conical silhouette — base tier longest, top tier shortest.
        // heightRatio=1 at base (tierPosFrac=0), 0 at crown (tierPosFrac=1).
        // conicalShape multiplier makes the taper more pronounced/curved.
        // Scale crossfade tier length by tierRadiusScale so it grows in from near-zero.
        const heightRatio = 1 - tierPosFrac;
        const conicalShape = 0.2 + 0.8 * heightRatio; // 1.0 at base, 0.2 at top
        const tierBranchLen = trunkSpan * lerp(WHORL_TOP_LEN_FRAC, WHORL_BASE_LEN_FRAC, heightRatio)
          * conicalShape * tierRadiusScale;

        // Polar angle: lerp from base-angle (tierPosFrac=0) to crown-angle (tierPosFrac=1).
        // No rng draw — fully deterministic from tierPosFrac.
        const tierPolarAngle = lerp(WHORL_BASE_ANGLE, WHORL_CROWN_ANGLE, tierPosFrac);

        // Azimuth jitter: 0 at whorl=1 (perfect regularity), full at whorl=0.
        const whorlJitter = 0.4; // base jitter magnitude (radians)

        // Emit WHORL_BRANCHES_PER_TIER spokes at evenly-distributed azimuths.
        // Tier rotation: rotate the whole spoke set by INTER_TIER_OFFSET per tier.
        // ZERO rng draws: azimuth derived deterministically from structuralSeed + tierIdx + k.
        const tierRotation = ti * INTER_TIER_OFFSET;

        // Base radius for whorl branches at full weight.
        const whorlBaseRadius = BRANCH_BASE_RADIUS * Math.pow(TAPER_BASE, 1);

        for (let bi = 0; bi < WHORL_BRANCHES_PER_TIER; bi++) {
          if (boneCounter >= SOFT_CEILING) break;

          // Base azimuth: regular spoke spacing.
          const baseAz = (Math.PI * 2 * bi) / WHORL_BRANCHES_PER_TIER + tierRotation;
          // Deterministic jitter: derived from structuralSeed + tier + branch index.
          // Uses sin hash — no rng draw consumed.
          const jitterHash = Math.sin(structuralSeed * 6.2831 + ti * 7.3 + bi * 2.9999) * whorlJitter * (1 - whorl);
          const az = baseAz + jitterHash;

          // Branch direction: angled outward from vertical at tierPolarAngle (varies by height).
          const branchDir = normalize([
            Math.sin(tierPolarAngle) * Math.cos(az),
            Math.cos(tierPolarAngle),
            Math.sin(tierPolarAngle) * Math.sin(az)
          ]);

          // Build the first internode chain from snapPos along branchDir.
          const childKey = ti * WHORL_BRANCHES_PER_TIER + bi;
          const arcAngle   = computeCurvatureArc(structuralSeed, childKey, 1);
          const arcAxis    = computeCurvatureAxis(branchDir, structuralSeed, childKey, 1);
          const droopPerSeg = 0.04;
          const segLen = tierBranchLen / intNodes;

          const chainNodes = buildCurvedChain(
            snapPos, branchDir, segLen, intNodes,
            arcAngle, arcAxis, droopPerSeg, 0, perpTo(branchDir),
            tierRadiusScale, 1
          );

          // Branch radius: full base radius × crossfade weight for the partial tier.
          const whorlRadius = whorlBaseRadius * tierRadiusScale;
          let prevIdx = snapIdx;
          for (const cn of chainNodes) {
            if (boneCounter >= SOFT_CEILING) break;
            const newIdx = nodes.length;
            nodes.push({
              pos: cn.pos,
              radius: whorlRadius,
              weight: tierRadiusScale,
              branchLevel: 1,
              parentIdx: prevIdx,
              isWoody: true
            });
            bones.push({ a: prevIdx, b: newIdx });
            boneCounter++;
            prevIdx = newIdx;
          }

          // Enqueue the tail of this chain into the BFS at level=1 so sub-branching
          // and foliage placement happen through the normal BFS recursion.
          // Crossfade tier branches carry their radiusScale into the BFS subtree.
          const tierTailIdx = nodes.length - 1;
          if (tierTailIdx !== snapIdx) {
            const tierFinalDir = chainNodes[chainNodes.length - 1].dir;
            if (!tierBuckets[ti]) tierBuckets[ti] = [];
            tierBuckets[ti].push({
              nodeIdx: tierTailIdx,
              level: 1,
              dir: tierFinalDir,
              len: tierBranchLen * (lengthRatio),
              attachPos: [...nodes[tierTailIdx].pos],
              radiusScale: tierRadiusScale,
              childIndex: childKey
            });
          }
        }
      }
    }

    // BFS ORDER (budget priority): enqueue the apex/leader FIRST so the spire and
    // upper crown develop before the bone budget is spent, then the tier sub-branches
    // from the TOP tier DOWN. If the budget then runs out it starves the LOWEST tiers
    // (whose primary branches are already built and still get foliated) instead of the
    // apex — fixing the "dense bottom whorl, bald top" conifer look.
    // CONIFER_LEADER_FRAC: a conifer's crown IS the tiers along the trunk, so the
    // leader (trunk continuation above the top tier) must be a SHORT apex spike — not
    // the full-trunk-height branch a broadleaf uses to build a crown atop its trunk.
    // Without this the leader shoots a tall bare spire ~3× the tier zone, cramming the
    // whole foliated crown into the bottom of the silhouette (the "bald top" report).
    const CONIFER_LEADER_FRAC = 0.22;
    for (const { idx: topIdx, weight } of allTrunkTops) {
      queue.push({
        nodeIdx: topIdx,
        level: 0,
        dir: [0, 1, 0],
        len: BASE_BRANCH_LENGTH * TRUNK_HEIGHT * trunkHeightFactor * CONIFER_LEADER_FRAC,
        attachPos: [...nodes[topIdx].pos],
        radiusScale: weight,
        childIndex: 0
      });
    }
    // Round-robin across tiers: enqueue the k-th branch of every tier before the
    // (k+1)-th, walking tiers TOP→bottom within each round. This shares the bone
    // budget evenly across all tiers (no tier is fully expanded before the next is
    // touched), so the whole cone fills out; the top→bottom order within a round gives
    // the apex a slight head start for a clean spire.
    let maxBucket = 0;
    for (const b of tierBuckets) if (b && b.length > maxBucket) maxBucket = b.length;
    for (let k = 0; k < maxBucket; k++) {
      for (let ti = tierBuckets.length - 1; ti >= 0; ti--) {
        const bucket = tierBuckets[ti];
        if (bucket && k < bucket.length) queue.push(bucket[k]);
      }
    }
  } else {
    // whorl === 0: byte-identical path — enqueue trunk tops exactly as before.
    for (const { idx: topIdx, weight } of allTrunkTops) {
      queue.push({
        nodeIdx: topIdx,
        level: 0,
        dir: [0, 1, 0],
        // BASE_BRANCH_LENGTH × TRUNK_HEIGHT gives the primary branch reach.
        // At each successive depth level this is multiplied by lengthRatio so
        // branches taper naturally inward toward the fine twigs.
        len: BASE_BRANCH_LENGTH * TRUNK_HEIGHT * trunkHeightFactor,
        attachPos: [...nodes[topIdx].pos],
        radiusScale: weight,
        childIndex: 0   // deterministic curvature key: which child of its parent is this?
      });
    }

    // crownStart < 1: ALSO emit primary crown branches from trunk nodes down to
    // crownStart·H (the crown starts lower, not just at the peak). Gated here so
    // crownStart=1 appends nothing and the whole path stays byte-identical. No rng
    // draws — azimuths are a deterministic golden-angle spiral up the trunk.
    if (crownStart < 1) {
      const CROWN_GOLDEN = Math.PI * (3 - Math.sqrt(5));      // ≈137.5° phyllotaxis
      const primaryLen = BASE_BRANCH_LENGTH * TRUNK_HEIGHT * trunkHeightFactor;
      let lbIndex = 0;
      for (let si = 0; si < allTrunkChains.length; si++) {
        const { chain, weight } = allTrunkChains[si];
        const n = chain.length;
        if (n < 3) continue;
        const baseAz = stemAzimuths[si] !== undefined ? stemAzimuths[si] : 0;
        // Skip the base (k=0) and the top (k=n-1, already a trunk-top primary).
        for (let k = 1; k < n - 1; k++) {
          const t = k / (n - 1);
          if (t < crownStart) continue;
          const az = baseAz + lbIndex * CROWN_GOLDEN;
          lbIndex++;
          // Outward + upward primary direction (the recursion spreads laterals from it).
          const up = 0.55;
          const s  = Math.sqrt(Math.max(0, 1 - up * up));
          const dir = normalize([Math.cos(az) * s, up, Math.sin(az) * s]);
          queue.push({
            nodeIdx: chain[k],
            level: 0,
            dir,
            // Longer toward the base, shorter toward the apex — a natural crown taper.
            len: primaryLen * (0.55 + 0.35 * (1 - t)),
            attachPos: [...nodes[chain[k]].pos],
            radiusScale: weight,
            childIndex: k,
          });
        }
      }
    }
  }

  let queueHead = 0;

  while (queueHead < queue.length) {
    const item = queue[queueHead++];
    const { nodeIdx, level, dir, len, attachPos, radiusScale = 1.0, childIndex = 0 } = item;

    const nextLevel = level + 1;

    // At the deepest level, terminal branches are slightly longer and wispier.
    const isDeepestLevel = nextLevel === maxDepth;
    const tipLengthMult = isDeepestLevel ? TIP_LENGTH_BOOST : 1.0;
    const childLen = len * lengthRatio * tipLengthMult;

    // Terminate: exceeded max depth or bone budget exhausted
    if (nextLevel > maxDepth || boneCounter >= SOFT_CEILING) {
      markTerminal(nodeIdx, dir, attachPos);
      continue;
    }

    // Each child costs intNodes bones
    const childCost = intNodes;
    const maxAffordableChildren = Math.floor((SOFT_CEILING - boneCounter) / childCost);

    if (maxAffordableChildren < 1) {
      markTerminal(nodeIdx, dir, attachPos);
      continue;
    }

    // The crossfade weight for children at the deepest allowed level:
    //   nextLevel == maxDepth → children are at the deepest level; scale by depthFrac.
    //   nextLevel < maxDepth  → children are intermediate; full weight (1.0).
    // When branchiness crosses an integer boundary (fractDepth=N.00), depthFrac=0
    // so newly-appearing deepest-level children start at radius=0 and grow in.
    const depthWeight = (nextLevel === maxDepth && depthFrac < 1.0) ? depthFrac : 1.0;

    // Tip taper: radius shrinks exponentially with branch level so deepest branches
    // are noticeably thinner than primary branches. TAPER_BASE^nextLevel.
    const levelTaper = Math.pow(TAPER_BASE, nextLevel);

    // Total children = fullChildren + 1 crossfade (if childrenFrac>0)
    const totalChildren = fullChildren + (childrenFrac > 0 ? 1 : 0);
    const actualChildren = Math.min(totalChildren, maxAffordableChildren);

    const perp = perpTo(dir);

    // Consume rng draws: always 3 per child (determinism — draw count fixed)
    const draws = [];
    for (let ci = 0; ci < actualChildren; ci++) {
      const drawA = (rng() - 0.5) * 0.16 * jAmp;
      const drawB = (rng() - 0.5) * (Math.PI / 18) * jAmp;
      const drawC = (rng() - 0.5) * (Math.PI / 9) * jAmp;
      draws.push({ drawA, drawB, drawC });
    }

    const parentPos = nodes[nodeIdx].pos;

    // Leader (child index 0): smallest divergence from parent dir.
    //
    // SINGLE-TRUNK ENFORCEMENT: at level==0 (trunk top → first branches), the
    // leader must continue nearly straight up so it reads as "the trunk keeps
    // going". We clamp the leader divergence to at most 5° regardless of
    // branchAngle or jitter. This ensures no Y-split at the base.
    //
    // At higher levels (level>0), the normal branchAngle*0.15 rule applies so
    // higher branches can have their natural apical-dominant but looser form.
    {
      const leaderLen = childLen * (1 + apicalBias * 0.3) * (1 + draws[0].drawA);
      const MAX_TRUNK_LEADER_DIVERGENCE = Math.PI / 36; // 5° hard cap at trunk level
      const rawLeaderDivergence = branchAngle * 0.15 + draws[0].drawB;
      const leaderDivergence = level === 0
        ? Math.max(-MAX_TRUNK_LEADER_DIVERGENCE, Math.min(MAX_TRUNK_LEADER_DIVERGENCE, rawLeaderDivergence))
        : rawLeaderDivergence;
      const leaderInitialDir = normalize(rotateAround(dir, perp, leaderDivergence));

      // Accumulated crossfade weight for this child's subtree.
      const childRadiusScale = radiusScale * depthWeight;
      // Effective radius includes level-based taper for tip thinning.
      const nodeRadius = BRANCH_BASE_RADIUS * childRadiusScale * levelTaper;

      // Curvature parameters: deterministic, no rng draws.
      const arcAngle = computeCurvatureArc(structuralSeed, childIndex, nextLevel);
      const arcAxis  = computeCurvatureAxis(leaderInitialDir, structuralSeed, childIndex, nextLevel);
      // Gravitropic droop: mild pull downward, stronger at higher levels.
      const droopPerSeg = 0.04 * (nextLevel / (maxDepth + 1));
      // Wiggle: reuse drawB (already consumed) scaled down to a small wander angle.
      const wigglePerSeg = draws[0].drawB * 0.35;
      const wiggleAxis = perpTo(leaderInitialDir);
      const segLen = leaderLen / intNodes;

      const chainNodes = buildCurvedChain(
        parentPos, leaderInitialDir, segLen, intNodes,
        arcAngle, arcAxis, droopPerSeg, wigglePerSeg, wiggleAxis,
        childRadiusScale, nextLevel
      );

      let prevIdx = nodeIdx;
      for (const cn of chainNodes) {
        const newIdx = nodes.length;
        nodes.push({
          pos: cn.pos,
          radius: nodeRadius,
          weight: childRadiusScale,
          branchLevel: nextLevel,
          parentIdx: prevIdx,
          isWoody: true
        });
        bones.push({ a: prevIdx, b: newIdx });
        boneCounter++;
        prevIdx = newIdx;
      }

      const leaderTailIdx = nodes.length - 1;
      const leaderFinalDir = chainNodes[chainNodes.length - 1].dir;
      queue.push({
        nodeIdx: leaderTailIdx,
        level: nextLevel,
        dir: leaderFinalDir,
        len: childLen,
        attachPos: [...nodes[leaderTailIdx].pos],
        radiusScale: childRadiusScale,
        childIndex: 0
      });
    }

    // Laterals (indices 1..actualChildren-1) via applySymmetry
    const numLaterals = actualChildren - 1;
    if (numLaterals > 0) {
      // LATERAL_SPREAD_BOOST widens branches at depth >= 1 so the canopy fans out.
      // At the trunk top (level==0) no boost is applied — trunk clamping already
      // handles the leader and we don't want to open up laterals there either
      // (they would look like co-equal Y-forks at the base).
      // APICAL DOMINANCE COUPLING: a strong leader (high apicalBias) doesn't only grow
      // longer (handled at the leader above) — it SUPPRESSES laterals, shortening them
      // AND pulling them more upright (excurrent / conifer-like form). This is the
      // missing other half of apical dominance the audit flagged. At apicalBias=0 both
      // factors are 1.0 (identity, no suppression). No rng draws added; bone count
      // unchanged (laterals are still built, just shorter/steeper).
      const apicalSuppress = 1 - apicalBias * 0.45;        // lateral length → 55% at full apical
      const spreadBoost = level > 0 ? LATERAL_SPREAD_BOOST : 0;
      const lateralBranchAngle = (branchAngle + spreadBoost) * (1 - apicalBias * 0.40) + draws[1].drawB;
      const lateralLen = childLen * (1 + draws[1].drawA) * apicalSuppress;
      const lateralBaseDir = normalize([
        dir[0] * Math.cos(lateralBranchAngle) + perp[0] * Math.sin(lateralBranchAngle),
        dir[1] * Math.cos(lateralBranchAngle) + perp[1] * Math.sin(lateralBranchAngle),
        dir[2] * Math.cos(lateralBranchAngle) + perp[2] * Math.sin(lateralBranchAngle)
      ]);

      // Build appendageSpec as unit-length offsets — positions at full weight=1.
      // applySymmetry rotates these around dir to distribute laterals.
      // We build the spec as single-step vectors (not chains) so applySymmetry
      // gives us the rotated initial directions; we then run buildCurvedChain per lateral.
      const lateralSpecSingleStep = [{ offset: [...lateralBaseDir] }];

      const lateralInstances = applySymmetry(
        lateralSpecSingleStep,
        radialOrder,
        dir,
        { pos: [0, 0, 0] }, // relative origin: we'll add parentPos below
        null
      );

      // Use only numLaterals instances
      const instancesUsed = lateralInstances.slice(0, numLaterals);

      for (let li = 0; li < instancesUsed.length; li++) {
        // Extra crossfade child (the one beyond fullChildren) gets scaled by childrenFrac
        const isXfadeChild = li + 2 > fullChildren && childrenFrac > 0;
        const lateralCrossfadeWeight = isXfadeChild ? childrenFrac : 1.0;
        // Total accumulated weight for this child's subtree.
        const childRadiusScale = radiusScale * depthWeight * lateralCrossfadeWeight;
        // Effective radius with level taper.
        const nodeRadius = BRANCH_BASE_RADIUS * childRadiusScale * levelTaper;

        // Derive the rotated initial direction for this lateral from applySymmetry result.
        // The instance gives us a single offset node representing a unit-step in lateralDir.
        const rotatedOffset = instancesUsed[li][0].pos;
        const lateralInitialDir = normalize(rotatedOffset);

        // Curvature parameters for this lateral — child index offset from leader.
        const lateralChildIdx = childIndex + li + 1;
        const arcAngle   = computeCurvatureArc(structuralSeed, lateralChildIdx, nextLevel);
        const arcAxis    = computeCurvatureAxis(lateralInitialDir, structuralSeed, lateralChildIdx, nextLevel);
        const droopPerSeg = 0.04 * (nextLevel / (maxDepth + 1));
        // Wiggle: reuse draws[1].drawB (already consumed) scaled down per lateral.
        const wigglePerSeg = draws[1].drawB * 0.35;
        const wiggleAxis   = perpTo(lateralInitialDir);
        const segLen = lateralLen / intNodes;

        const chainNodes = buildCurvedChain(
          parentPos, lateralInitialDir, segLen, intNodes,
          arcAngle, arcAxis, droopPerSeg, wigglePerSeg, wiggleAxis,
          childRadiusScale, nextLevel
        );

        let prevIdx = nodeIdx;
        for (const cn of chainNodes) {
          const newIdx = nodes.length;
          nodes.push({
            pos: cn.pos,
            radius: nodeRadius,
            weight: childRadiusScale,
            branchLevel: nextLevel,
            parentIdx: prevIdx,
            isWoody: true
          });
          bones.push({ a: prevIdx, b: newIdx });
          boneCounter++;
          prevIdx = newIdx;
        }

        const lateralTailIdx = nodes.length - 1;
        const lateralFinalDir = chainNodes[chainNodes.length - 1].dir;

        queue.push({
          nodeIdx: lateralTailIdx,
          level: nextLevel,
          dir: lateralFinalDir,
          len: childLen,
          attachPos: [...nodes[lateralTailIdx].pos],
          radiusScale: childRadiusScale,
          childIndex: lateralChildIdx
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // ROSETTE POST-PASS: apical whorl of equal-length fronds from the trunk top.
  //
  // Mirrors the roots.js pattern: runs AFTER the BFS loop so it never perturbs
  // any BFS rng draw. ALL rng draws are gated behind rosette > 0 so that
  // rosette === 0 consumes ZERO draws → BYTE-IDENTICAL skeleton to prior code.
  //
  // N = round(rosette * ROSETTE_MAX) fronds are distributed evenly in azimuth
  // (2π/N spacing) from the TRUNK TOP node of the FIRST (dominant) stem.
  // Frond length matches the primary branch length at depth 0 (BASE_BRANCH_LENGTH
  // × TRUNK_HEIGHT × trunkHeightFactor), scaled by lengthRatio so it reads as
  // a natural extension. Budget is respected: stop adding fronds at SOFT_CEILING.
  //
  // parentIdx < ownIndex is maintained because frond nodes are appended after
  // the trunk-top node (which was placed during the BFS-predecessor trunk build).
  // -------------------------------------------------------------------------
  if (rosette > 0 && allTrunkTops.length > 0) {
    // Frond count via the fractional-crossfade idiom: the marginal frond grows in
    // from zero LENGTH as rosette rises, instead of Math.round() stepping the count.
    const fractFronds = rosette * ROSETTE_MAX;   // 0..ROSETTE_MAX
    const fullFronds  = Math.floor(fractFronds);
    const frondFrac   = fractFronds - fullFronds;
    const N           = Math.max(1, fullFronds + (frondFrac > 0 ? 1 : 0));
    // Use the first (dominant) trunk top as the attachment point.
    const trunkTopIdx = allTrunkTops[0].idx;
    const trunkTopNode = nodes[trunkTopIdx];
    const trunkTopPos = trunkTopNode.pos;

    // Frond length: one lengthRatio step below the primary branch length.
    const frondLen = BASE_BRANCH_LENGTH * TRUNK_HEIGHT * trunkHeightFactor * lengthRatio;

    // FROND_SEGMENTS: fronds use MORE internodes than the segmentation-derived
    // intNodes (which is 2 for the palm) so they ARCH smoothly. A single interior
    // joint reads as a rigid elbow, and a whole crown of identical elbows at one
    // emergence angle is the "candelabra / menorah" look. The frond chain consumes
    // NO rng draws (markTerminal's single draw per frond is unchanged), so the
    // rosette>0 rng schedule — and thus palm/fern/banana determinism — is intact.
    const FROND_SEGMENTS = Math.max(intNodes, 5);
    const frondSegLen = frondLen / FROND_SEGMENTS;

    // Radius for rosette fronds: same taper as level-1 branches.
    const frondRadius = BRANCH_BASE_RADIUS * Math.pow(TAPER_BASE, 1);

    // Crown shape: a real palm/fern crown is a FOUNTAIN of arching fronds — emerging
    // across a range of elevations and curving downward over their length — not a
    // uniform cone of straight spokes. Emergence angle and total arch are spread
    // per-frond by a deterministic hash (decorrelated from azimuth so there's no
    // seam), giving a full, natural crown that also varies per individual (reroll).
    const FROND_POLAR_MIN = 0.35;  // ~20° from vertical — central/young upright fronds
    const FROND_POLAR_MAX = 1.25;  // ~72° — outer fronds emerge nearly horizontally
    const FROND_ARCH_MIN  = 0.70;  // gentle total downward arc (rad) for upright fronds
    const FROND_ARCH_MAX  = 1.90;  // strong arc → outer fronds arch over and droop below the crown

    // Build N fronds evenly spaced in azimuth (guarantees full-circle coverage).
    for (let fi = 0; fi < N; fi++) {
      // Stop if bone budget is exhausted.
      if (boneCounter >= SOFT_CEILING) break;

      // Evenly distributed azimuth: 2π * fi / N (no rng draw — deterministic).
      const az = (Math.PI * 2 * fi) / N;

      // Deterministic per-frond elevation factor in [0,1], decorrelated from azimuth
      // so adjacent fronds don't form a visible spiral seam (no rng draw consumed).
      const elevHash   = 0.5 + 0.5 * Math.sin(structuralSeed * 4.7 + fi * 1.873);
      const frondPolar = lerp(FROND_POLAR_MIN, FROND_POLAR_MAX, elevHash);
      const frondArch  = lerp(FROND_ARCH_MIN,  FROND_ARCH_MAX,  elevHash);

      // Frond emergence direction: outward from vertical at frondPolar, azimuth az.
      const frondDir = normalize([
        Math.sin(frondPolar) * Math.cos(az),
        Math.cos(frondPolar),
        Math.sin(frondPolar) * Math.sin(az)
      ]);

      // Arch axis: horizontal, perpendicular to the outward azimuth, oriented so a
      // POSITIVE arc bends the frond DOWNWARD (increasing polar) over its length —
      // the defining arching-frond silhouette. droopPerSeg stays 0 because the arc
      // already provides a clean, smooth downward curve in the frond's own plane.
      const archAxis = normalize([Math.sin(az), 0, -Math.cos(az)]);

      // Crossfade frond (the +1 marginal one) grows in from near-zero LENGTH (via the
      // chain radiusScale) and weight (foliage scales its clusters down) as rosette rises.
      const frondWeight = (fi === fullFronds && frondFrac > 0) ? frondFrac : 1.0;

      const chainNodes = buildCurvedChain(
        trunkTopPos, frondDir, frondSegLen, FROND_SEGMENTS,
        frondArch, archAxis, 0, 0, perpTo(frondDir),
        frondWeight, 1
      );

      let prevIdx = trunkTopIdx;
      for (const cn of chainNodes) {
        if (boneCounter >= SOFT_CEILING) break;
        const newIdx = nodes.length;
        nodes.push({
          pos: cn.pos,
          radius: frondRadius,
          weight: frondWeight,
          branchLevel: 1,
          parentIdx: prevIdx,
          isWoody: true
        });
        bones.push({ a: prevIdx, b: newIdx });
        boneCounter++;
        prevIdx = newIdx;
      }

      // Mark the tail node as terminal. prevIdx is the last node we placed
      // (could be a partial chain if budget was hit mid-way).
      // Only mark if we actually placed at least one frond node.
      if (prevIdx !== trunkTopIdx) {
        markTerminal(prevIdx, frondDir, trunkTopPos);
      }
    }
  }

  return {
    nodes,
    bones,
    meta: {
      bodyAxis: BODY_AXIS,
      lightDir: LIGHT_DIR
    }
  };
}
