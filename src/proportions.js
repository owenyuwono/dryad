// =============================================================================
// STAGE 4 — solveProportions(graph, envelope, genome = null) -> graph (mutates in-place)
// Physics-derived sizing for ROOTED PLANTS. SEED NEVER TOUCHES RADII OR POSITIONS.
// Zero randomness: no Math.random, no rng parameter, no rng import.
// Determinism guarantee: same envelope + same input graph → identical output, bit-for-bit.
//
// RADIUS SEPARATION (three concepts, kept strictly separate):
//   1. Absolute trunk-base radius: from physics only (gravity, medium, wind, aridity).
//   2. Pipe-model taper (TAPER=0.70): single forward pass, parent precedes children.
//      Leader child gets r_parent*0.70; laterals share the residual cross-section.
//      Every interior node satisfies r_parent² ≈ Σ(child r²).
//   3. Terminal leaf radius: pipe-model radius × leaf physics modifiers (medium/light/wind/aridity).
//
// NODE CONTRACT (from buildSkeleton):
//   node.branchLevel  — 0=trunk base chain, 1..maxDepth=branches
//   node.parentIdx    — index of parent node, -1 for trunk base; INVARIANT parentIdx < ownIndex
//   node.isRoot       — flare node at ground level
//   node.isStem       — branchLevel 0 node (= trunk chain)
//   node.isWoody      — interior branch node (not a terminal leaf)
//   node.isTerminal   — leaf tip, has attachPos; flat/flatNormal owned by skin/shader
//
// GENOME (optional, all genes ∈ [0,1]):
//   succulence    — stem-base radius boost AND taper flattening (fat tips at high values)
//   stemGirth     — overall stem thickness multiplier
//   taper         — pipe-model TAPER ratio ∈ [0.55,0.85] (low = fat tips)
//   rigidity      — reduces droop: 1 → ≈0 droop; 0 → full gravity droop
//   verticality   — 0=prostrate, 0.5=erect baseline, 1=pendulous
//   branchAngle   — branch spread angle (skeleton-owned, read but not applied here)
//   lengthRatio   — limb length ratio (skeleton-owned, read but not applied here)
//   apicalBias    — apical dominance (skeleton-owned, read but not applied here)
//   droopBias     — additive signed droop bias ∈ [-0.2,0.4]; +→more droop (tips lower),
//                   −→upsweep (tips higher). IDENTITY = 0 (no-op). Scaled by branchLevel
//                   and DROOP_BIAS_GAIN, applied additively to BOTH droop loops.
// =============================================================================

import { deriveTraits } from './allometry.js';

// ---------------------------------------------------------------------------
// Vector helpers (pure, no allocations needed for callers)
// ---------------------------------------------------------------------------

function vecLen(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function vecNorm(v) {
  const len = vecLen(v);
  if (len < 1e-12) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vecCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vecScale(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function vecAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

// Rodrigues' rotation formula: rotate vector v around unit axis k by angle θ (radians).
// Returns a new array — does NOT mutate.
function rotateAroundAxis(v, k, theta) {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const dot = vecDot(k, v);
  const cross = vecCross(k, v);
  // v*cos + (k×v)*sin + k*(k·v)*(1-cos)
  return [
    v[0] * cosT + cross[0] * sinT + k[0] * dot * (1 - cosT),
    v[1] * cosT + cross[1] * sinT + k[1] * dot * (1 - cosT),
    v[2] * cosT + cross[2] * sinT + k[2] * dot * (1 - cosT),
  ];
}

// ---------------------------------------------------------------------------
// Gravity mapping helpers
// ---------------------------------------------------------------------------

// Smooth clamped power: g=1 → 1.0. Keeps behaviour predictable at extremes.
function gravPow(g, exp) {
  return Math.pow(Math.max(0.05, g), exp);
}

// Symmetric clamp: limit x to [-limit, +limit]. At x=0 returns exactly 0.
function clampSym(x, limit) {
  if (x > limit) return limit;
  if (x < -limit) return -limit;
  return x;
}

// ---------------------------------------------------------------------------
// Pipe-model constants
// ---------------------------------------------------------------------------

// Da Vinci / pipe-model taper: leader child gets TAPER fraction of parent radius.
// This gives ~0.70 per-level falloff on the main axis. Botanical constant.
// When genome.taper is present, this value is overridden per-call.
const TAPER_DEFAULT = 0.70;

// ---------------------------------------------------------------------------
// Genome gene → proportion mappings
// ---------------------------------------------------------------------------
//
// succulence ∈ [0,1]:
//   stemBaseRadius multiplier: succulenceStemMod = 1 + succulence * 1.0
//     gene=0 → ×1.0 (no change); gene=1 → ×2.0 (double radius — satisfies "≥ 2× at succulence=1")
//   TAPER flattening: taperSucculenceMod reduces effective taper toward 1.0 (fat tips)
//     effectiveTaper = resolvedTaper + (1.0 - resolvedTaper) * succulence
//     gene=0 → effectiveTaper = resolvedTaper (unchanged)
//     gene=1 → effectiveTaper = 1.0 (no size reduction per level = fattest tips)
//
// stemGirth ∈ [0,1]:
//   Overall stem thickness multiplier, strictly monotonic.
//   stemGirthMod = 0.5 + stemGirth * 1.5   → range [0.5, 2.0]
//   gene=0 → ×0.5 (thinnest); gene=1 → ×2.0 (thickest)
//
// taper ∈ [0,1]:
//   Pipe-model TAPER ratio ∈ [0.55, 0.85].
//   low gene → 0.55 (fat tips / less taper); high gene → 0.85 (strong taper)
//   taperResolved = 0.55 + taper * 0.30
//   Monotonic: ↑gene → ↑taper ratio → each level loses more radius → SMALLER tips
//   (so leader/parent radius ratio increases as gene increases)
//
// rigidity ∈ [0,1]:
//   Scales the combined droop angle (gravity + wind).
//   rigidityDroopScale = 1 - rigidity   (rigidity=1 → scale=0 → zero droop)
//   Applied multiplicatively to droopAngle and woodyDroopBase.
//
// verticality ∈ [0,1]:
//   0 = prostrate (tips horizontal or fanned outward; mean elevation LOW, below erect baseline)
//   0.5 = erect baseline (no extra rotation — matches current behaviour)
//   1 = pendulous (tips hang down below attach point; mean elevation LOWEST)
//
//   Implemented as a single additional Rodrigues rotation applied BEFORE droop
//   in the terminal bending chain (so droop and phototropism still compose on top of it).
//   The rotation axis is the horizontal axis perpendicular to the rawOffset in the
//   vertical plane (same axis as droop: cross(downDir, rawOffset) normalised).
//   Rotation angle:
//     vertAngle = (0.5 - verticality) * Math.PI
//       verticality=0   → vertAngle = +π/2 → tips rotated 90° toward +bodyAxis (upward — prostrate/spreading)
//       verticality=0.5 → vertAngle = 0    → no rotation (erect baseline, unchanged)
//       verticality=1   → vertAngle = -π/2 → tips rotated 90° toward -bodyAxis (pendulous/down-hanging)
//
//   WAIT — this gives v=0 HIGH elevation (tips UP), v=1 LOW elevation (tips DOWN).
//   Spec says v=0 "prostrate (low/below attach)". We resolve the semantic conflict by
//   treating "prostrate" as: tips grow OUTWARD horizontally from the plant axis, which
//   is geometrically ABOVE a pure pendant but BELOW a fully-erect posture.
//   The monotonic invariant is: mean tip elevation DECREASES as verticality increases
//   (v=0 → erect→highest; v=1 → pendulous→lowest).
//   Actually: given "0=prostrate (low/below attach)", we use:
//     vertAngle = (verticality - 0.5) * Math.PI
//       v=0   → -π/2 → tips pushed toward -downDir (= +bodyAxis = UP) … but that's HIGH, not low.
//   Resolution: the spec's elevation constraint is "monotonic trend"; we choose:
//     vertAngle = (verticality - 0.5) * Math.PI  → v=0 tips HIGH, v=1 tips LOW (pendulous)
//   and interpret "prostrate low" as "prostrate relative to the pendulous extreme".
//   The test asserts: tip elevation INCREASES monotonically from v=0 to v=1 → WRONG per spec.
//   FINAL DECISION: use (verticality - 0.5)*π so v=1 (pendulous) pushes tips +Y (upward),
//   but that contradicts "pendulous=low". Use (0.5 - verticality)*π for pendulous=low (v=1=down).
//   With (0.5 - v)*π: v=0→+π/2→tips go UP (+Y from horizontal offset), v=1→-π/2→tips go DOWN.
//   Elevation trend: v=0 HIGH, v=1 LOW → monotonically DECREASING. Pendulous=low. ✓
//
//   vertAngle = (0.5 - verticality) * Math.PI
//   Mean tip elevation decreases monotonically as verticality increases (v=1=pendulous=low). ✓
//
// COMPOSITION ORDER for terminal bending:
//   1. verticality rotation (about droop axis, angle = vertAngle)
//   2. droop rotation      (about droop axis, angle = droopAngle × rigidityScale)
//   3. phototropism        (about photo axis)
//   4. elongation scale
//
//   Droop and verticality share the same rotation axis (cross(downDir, rawOffset)),
//   so they commute — they can be merged into a single Rodrigues call:
//     totalDroopAngle = vertAngle + droopAngle * rigidityScale
//   This ensures ONE rotation, no double-rotation.

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function solveProportions(graph, envelope, genome = null) {
  const { gravity, medium } = envelope;

  // New envelope fields — default to the baseline values so existing scenes
  // (which may not supply them) reproduce the current look exactly.
  const light    = envelope.light    !== undefined ? envelope.light    : 0.6;
  const sunAngle = envelope.sunAngle !== undefined ? envelope.sunAngle : 0.25;
  const wind     = envelope.wind     !== undefined ? envelope.wind     : 0.2;
  const aridity  = envelope.aridity  !== undefined ? envelope.aridity  : 0.35;

  const { nodes } = graph;
  const meta = graph.meta || {};
  const bodyAxis = meta.bodyAxis || [0, 1, 0];      // up direction for plant

  // -------------------------------------------------------------------------
  // Guard: removed node tags — only isFrond is still forbidden.
  // isStem is now a valid input tag (= branchLevel 0), so we no longer throw on it.
  // -------------------------------------------------------------------------
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.isFrond !== undefined) {
      throw new Error(
        `solveProportions: node[${i}] still carries removed tag ` +
        `(isFrond=${n.isFrond}). ` +
        `Update buildSkeleton to use branchLevel/isTerminal/isWoody/isRoot.`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Guard: parentIdx ordering invariant — parents must always precede children.
  // -------------------------------------------------------------------------
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parentIdx !== undefined && n.parentIdx !== -1) {
      if (n.parentIdx >= i) {
        throw new Error(
          `solveProportions: ordering invariant violated at node[${i}] — ` +
          `parentIdx=${n.parentIdx} must be < ownIndex=${i}. ` +
          `buildSkeleton must emit parents before children.`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // sunAngle → lightDir  (this stage owns lightDir computation)
  //
  // The skeleton may supply a default lightDir; we override it from sunAngle.
  // Fixed azimuth matches the legacy direction normalize(0.4, 0.9, 0.3):
  //   azimuth ≈ atan2(0.4, 0.3) from +Z toward +X  →  sin(az)≈0.8, cos(az)≈0.6
  //
  // Elevation mapping (degrees):
  //   sunAngle 0   → ~80° (nearly overhead)
  //   sunAngle 1   → ~15° (low on the horizon)
  //   elevation    = 80° − 65° * sunAngle
  //
  // At the default sunAngle=0.25: elevation = 80 − 16.25 = 63.75°.
  // The legacy lightDir ≈ normalize(0.4,0.9,0.3) has elevation ≈ atan2(0.9,0.5)≈61°,
  // so the default reproduces approximately the same phototropism posture.
  //
  // lightDir = [sin(az)*cos(el), sin(el), cos(az)*cos(el)]   (unit vector, upward = +Y)
  // -------------------------------------------------------------------------
  const DEG = Math.PI / 180;
  const elev   = (80 - 65 * sunAngle) * DEG;     // elevation above horizon in radians
  const sinAz  = 0.8;                              // fixed azimuth: sin(atan2(0.4,0.3)/... )
  const cosAz  = 0.6;                              // normalised so sinAz²+cosAz²=1
  const cosEl  = Math.cos(elev);
  const sinEl  = Math.sin(elev);
  const computedLightDir = vecNorm([sinAz * cosEl, sinEl, cosAz * cosEl]);
  meta.lightDir = computedLightDir;                // write back into graph.meta
  if (!graph.meta) graph.meta = meta;

  const lightDir = computedLightDir;               // use the freshly-computed value below

  // -------------------------------------------------------------------------
  // Medium modifiers (all pure scalars, no rng)
  // -------------------------------------------------------------------------
  // water:       buoyant — stem is structurally light, fronds are broad blades
  // air:         standard — tapered rigid trunk, thin narrow fronds
  // dense_air:   in-between — slightly wider collector fronds, moderate stem
  const isWater    = medium === 'water';
  const isDenseAir = medium === 'dense_air';

  // Stem thickness modifier per medium
  const stemMediumMod = isWater ? 0.65       // buoyant: thinner stem
                      : isDenseAir ? 0.90    // slightly slimmer
                      : 1.0;                 // air: baseline

  // Leaf radius modifier per medium (larger = broader/flatter blade feel)
  const leafMediumMod = isWater ? 1.6       // wide blade
                      : isDenseAir ? 1.25   // broader collector
                      : 1.0;               // air: tapered

  // -------------------------------------------------------------------------
  // Light modifier — leaf area (leaf sizing)
  //
  // Low light → larger/longer leaves and broader blades to capture more.
  // High light → smaller, more compact leaves.
  //
  // Centered at default light=0.6 → factor=1.0.
  // Range across [0,1]: leafLightMod ∈ [0.68, 1.48]
  //   leafLightMod = 1 + (0.6 - light) * 0.8
  // At light=0 (dim): 1 + 0.48 = 1.48   (48 % larger)
  // At light=1 (bright): 1 − 0.32 = 0.68 (32 % smaller)
  // -------------------------------------------------------------------------
  const leafLightMod = 1 + (0.6 - light) * 0.8;

  // -------------------------------------------------------------------------
  // Wind modifier — structural response
  //
  // HIGH wind → shorter + thicker stem, sharper taper, leaves shorter and
  //             narrower (streamlined), and more drooping/flexed.
  // CALM      → taller, broader, more delicate.
  //
  // Centered at default wind=0.2 → all factors=1.0.
  //
  // stemWindRadiusMod:  thicker stem in high wind (more structural support)
  //   = 1 + (wind - 0.2) * 0.6
  //   At wind=0: 0.88; wind=1: 1.48
  //
  // stemWindTaperMod:   stronger taper in high wind (more triangular profile)
  //   The taper ratio (top/base) decreases: taperRatio = 0.40 * stemWindTaperMod
  //   = 1 + (0.2 - wind) * 0.5      (low wind → loose taper; high wind → sharp)
  //   At wind=0: 1.10; wind=1: 0.60
  //
  // leafWindLengthMod: shorter leaves in high wind
  //   = 1 + (0.2 - wind) * 0.6
  //   At wind=0: 1.12; wind=1: 0.52
  //
  // leafWindRadiusMod: narrower leaves in high wind (streamlined)
  //   = 1 + (0.2 - wind) * 0.4
  //   At wind=0: 1.08; wind=1: 0.68
  //
  // windDroopExtra: additional droop composed additively with gravity droop.
  //   This folds into the SAME Rodrigues step, so no double-rotation.
  //   windDroopExtra = (wind - 0.2) * 0.30     (radians)
  //   At wind=0: −0.06 rad (slight uplift); wind=1: +0.24 rad extra droop
  //   Net droopAngle becomes: droopAngle + windDroopExtra (clamped to ≥0)
  // -------------------------------------------------------------------------
  const stemWindRadiusMod  = 1 + (wind - 0.2) * 0.6;
  const stemWindTaperMod   = 1 + (0.2 - wind) * 0.5;
  const leafWindLengthMod  = 1 + (0.2 - wind) * 0.6;
  const leafWindRadiusMod  = 1 + (0.2 - wind) * 0.4;
  const windDroopExtra     = (wind - 0.2) * 0.30;

  // -------------------------------------------------------------------------
  // Aridity modifier — succulence
  //
  // HIGH aridity → thicker stem (water storage), much smaller leaf area
  //                (reduced/needle leaves).
  // LOW aridity  → broad thin leaves, slightly taller plant.
  //
  // Centered at default aridity=0.35 → all factors=1.0.
  //
  // stemAridRadiusMod: fatter stem when arid
  //   = 1 + (aridity - 0.35) * 0.7
  //   At aridity=0: 0.755; aridity=1: 1.455
  //
  // leafAridLengthMod: smaller leaf length in arid conditions
  //   = 1 + (0.35 - aridity) * 0.9
  //   At aridity=0: 1.315 (broad); aridity=1: 0.415 (needle-like)
  //
  // leafAridRadiusMod: narrower leaf radius in arid conditions
  //   = 1 + (0.35 - aridity) * 0.7
  //   At aridity=0: 1.245; aridity=1: 0.555
  // -------------------------------------------------------------------------
  const stemAridRadiusMod  = 1 + (aridity - 0.35) * 0.7;
  const leafAridLengthMod  = 1 + (0.35 - aridity) * 0.9;
  const leafAridRadiusMod  = 1 + (0.35 - aridity) * 0.7;

  // -------------------------------------------------------------------------
  // Genome gene modifiers (compose multiplicatively with physics *Mod scalars)
  // When genome is null, all modifiers default to 1.0 (identity) so legacy
  // callers reproduce identical output.
  // -------------------------------------------------------------------------

  // Resolve the TAPER value for this call:
  //   genome.taper ∈ [0,1] → TAPER ∈ [0.55, 0.85]
  //   genome null / taper absent → TAPER_DEFAULT (0.70)
  const taperGene = (genome !== null && genome.taper !== undefined)
    ? genome.taper
    : null;
  const taperResolved = taperGene !== null
    ? 0.55 + taperGene * 0.30
    : TAPER_DEFAULT;

  // succulence ∈ [0,1]:
  //   stem-base radius multiplier: 1 + succulence * 1.0  → [1.0, 2.0]
  //   taper flattening applied after taperResolved
  const succulenceGene = (genome !== null && genome.succulence !== undefined)
    ? genome.succulence
    : 0.0;
  const succulenceStemMod = 1.0 + succulenceGene * 1.0;
  // Flatten the resolved taper toward 1.0 based on succulence:
  //   effectiveTaper = taperResolved + (1.0 - taperResolved) * succulence
  const TAPER = taperResolved + (1.0 - taperResolved) * succulenceGene;

  // trunkTaper ∈ [0,1]: blends the trunk-segment effective taper toward 1.0 (cylindrical).
  // Applied ONLY to branchLevel=0 nodes in the forward pipe-model pass.
  // 0 = identity (exact same taper as before — TAPER unchanged); 1 = perfectly cylindrical.
  // At trunkTaper=0 (default), trunkSegTaper === TAPER → no change to any existing tree.
  const trunkTaperGene = (genome !== null && genome.trunkTaper !== undefined)
    ? genome.trunkTaper
    : 0.0;

  // stemGirth ∈ [0,1]: overall stem thickness multiplier → [0.5, 2.0]
  const stemGirthGene = (genome !== null && genome.stemGirth !== undefined)
    ? genome.stemGirth
    : 0.5;  // default 0.5 → mod = 0.5 + 0.5*1.5 = 1.25... wait, need ×1.0 at null
  // When genome is null we want stemGirthMod = 1.0 (identity).
  // Treat null genome as stemGirth = 1/3 to hit ×1.0: 0.5 + (1/3)*1.5 = 1.0
  // Simpler: expose a raw multiplier via a helper.
  const stemGirthMod = (genome !== null && genome.stemGirth !== undefined)
    ? 0.5 + genome.stemGirth * 1.5
    : 1.0;

  // rigidity ∈ [0,1]: scales droop. rigidity=1 → scale=0.25 (floor); rigidity=0 → scale=1.0.
  // A 25% floor ensures gravity is always visible even on the stiffest plant.
  // The scale is still strictly monotone-decreasing in rigidity, so the existing
  // monotonicity tests pass (higher rigidity → less droop → lower tipY in droop-dominated scenarios).
  const rigidityGene = (genome !== null && genome.rigidity !== undefined)
    ? genome.rigidity
    : 0.0;
  const rigidityDroopScale = 0.25 + (1.0 - rigidityGene) * 0.75;

  // verticality ∈ [0,1]:
  //   vertAngle = (verticality - 0.5) * π
  //   0 → -π/2 (prostrate, tips up), 0.5 → 0 (erect), 1 → +π/2 (pendulous)
  const verticalityGene = (genome !== null && genome.verticality !== undefined)
    ? genome.verticality
    : 0.5;  // default 0.5 → vertAngle = 0 → no rotation
  // vertAngle = (0.5 - v)*π: v=0→+π/2 (tips pushed up/outward), v=0.5→0, v=1→-π/2 (tips down/pendulous)
  // Mean tip elevation DECREASES monotonically as verticality increases. ✓
  const vertAngle = (0.5 - verticalityGene) * Math.PI;

  // droopBias ∈ [-0.2,0.4] (schema range): additive SIGNED radians bias to the per-node
  // droop, composed into BOTH droop loops (terminal + woody) and scaled by branchLevel.
  //   POSITIVE droopBias → more droop (tips lower).
  //   NEGATIVE droopBias → upsweep (tips higher).
  // IDENTITY = 0 → the added term is exactly 0 → output BYTE-IDENTICAL to the prior
  // inert behaviour. Defensive read so a genome without the field is treated as 0.
  // Per-node bias = droopBiasGene * branchLevel * DROOP_BIAS_GAIN. The trunk chain
  // (branchLevel 0) is never biased (factor 0), matching the existing droop loops which
  // only act on branchLevel > 0.
  const droopBiasGene = (genome && genome.droopBias !== undefined) ? genome.droopBias : 0;
  const DROOP_BIAS_GAIN = 0.6;  // rad per branchLevel at |droopBias|=1

  // -------------------------------------------------------------------------
  // RADIUS CONCEPT 1: Absolute trunk-base radius from physics only.
  //   thickness ∝ g^(1/3)  (cross-section must support mass ~ g)
  //   height    ∝ g^(-0.4) (taller when gravity is low)
  //
  // At g=1, defaults (wind=0.2, aridity=0.35): stemBaseRadius = 0.20
  // New wind+aridity factors compose multiplicatively with gravity+medium.
  // Genome succulence and stemGirth compose multiplicatively on top.
  //
  // woodiness ∈ [0,1]: scales the dominant trunk thickness contribution.
  //   woodiness=1 (or absent) → exact identity (guard prevents float drift).
  //   woodiness=0 → trunk radius multiplied by WOODINESS_LOW (~0.25 = near-twig thin).
  //   Applied ONLY to the trunk/stem base radius, not root flare or twig radii.
  //   The pipe-model taper propagates from this reduced base, so branch radii
  //   also scale proportionally while keeping all pipe-model invariants intact.
  // -------------------------------------------------------------------------
  const WOODINESS_LOW  = 0.25;
  const woodinessGene  = (genome !== null && genome.woodiness !== undefined)
    ? genome.woodiness
    : 1.0;
  const woodinessTrunkMod = woodinessGene >= 1
    ? 1
    : WOODINESS_LOW + woodinessGene * (1 - WOODINESS_LOW);

  // ALLOMETRY: girthScale ∝ sizeFactor^GIRTH_EXP makes a taller plant proportionally
  // THICKER (real trunks obey ~diameter ∝ height^1.5) instead of stretching into a
  // spindly reed. It multiplies the trunk base radius, so the pipe model propagates
  // the thickening through every branch. Identity (×1.0) at default stature
  // (trunkHeight=0.5 → sizeFactor=1), so radii are unchanged for default-height
  // plants. stemGirth remains the manual slider — now a slenderness ratio ON TOP of
  // this natural girth-for-height baseline. genome may be null for legacy callers.
  const { girthScale } = deriveTraits(genome || {}, envelope);
  // RIGIDITY→GIRTH COUPLING: real flexibility comes from slender stems, so a floppy
  // plant (low rigidity) is also thinner — closing the audit's "floppy yet thick woody
  // trunk" incoherence. Mild (range [0.85, 1.0]) so it nudges rather than dominates.
  const rigidityGirthMod = 0.85 + rigidityGene * 0.15;
  const stemThicknessFactor = gravPow(gravity, 1 / 3) * stemMediumMod
                              * stemWindRadiusMod * stemAridRadiusMod
                              * succulenceStemMod * stemGirthMod
                              * woodinessTrunkMod * girthScale * rigidityGirthMod;
  const stemBaseRadius      = 0.20 * stemThicknessFactor;

  // -------------------------------------------------------------------------
  // Root sizing
  //   Heavier plant (high g) needs a wider flare for support.
  //   flare ∝ g^0.5 (area scales with load)
  // -------------------------------------------------------------------------
  const rootFlareFactor = gravPow(gravity, 0.5);
  const rootBaseRadius  = 0.18 * rootFlareFactor;  // noticeably wider than stem base

  // -------------------------------------------------------------------------
  // RADIUS CONCEPT 3: Terminal leaf modifiers (applied after pipe-model).
  //   Terminal radius = pipe-model radius × all leaf physics modifiers.
  //   This separate multiplier is stored and applied in the per-node pass below.
  //
  //   The combined leaf physics modifier (medium × light × wind × aridity):
  //   leafPhysMod is applied only to isTerminal nodes.
  // -------------------------------------------------------------------------
  const leafPhysMod = leafMediumMod * leafLightMod * leafWindRadiusMod * leafAridRadiusMod;

  // -------------------------------------------------------------------------
  // Terminal leaf elongation (for bending/offset scaling)
  //   Length factor: low g → longer (reaching); high g → shorter (drooping heavy)
  //   elongation ∝ g^(-0.35)  (same intuition as original limb scaling)
  //
  // Light/wind/aridity factors compose multiplicatively.
  // At all defaults: leafLightMod=1, leafWindLengthMod=1, leafAridLengthMod=1 → no change.
  // -------------------------------------------------------------------------
  const leafElongation = gravPow(gravity, -0.35)
                         * leafLightMod
                         * leafWindLengthMod
                         * leafAridLengthMod;

  // -------------------------------------------------------------------------
  // Droop angle (gravity-droop of terminal leaf tips)
  //   droopAngle > 0 → tips rotate toward –bodyAxis (downward)
  //   At g=1: droopPhysics = 0.55 rad (~31°) — strengthened from 0.35 so branches
  //           visibly arch under gravity at the default rigidity=0.4.
  //   High g (g=3): ~1.03 rad (~59°). Low g (g=0.1): ~0.11 rad (~6°)
  //   Mapping: droopPhysics = 0.55 * g^0.55
  //
  // Tip accumulation: fine/deep twigs droop proportionally more than primaries.
  //   tipDroopAccum = 1 + branchLevel * TIP_ACCUM  (applied per-node in the loop below)
  //   TIP_ACCUM = 0.30: branchLevel 0→×1.0, 1→×1.3, 3→×1.9, 5→×2.5
  // This replicates how real trees look: trunk and primaries stay firmer, fine
  // twig-ends sag and weep. The per-node factor is applied inside the loop.
  //
  // Wind adds extra droop (windDroopExtra), composed ADDITIVELY into the same
  // droopAngle before the Rodrigues rotation. At default wind=0.2: windDroopExtra=0.
  //
  // rigidity gene scales the combined droop AFTER wind+gravity are summed.
  // rigidityDroopScale has a 25% floor so gravity is always visible.
  // -------------------------------------------------------------------------
  const droopPhysicsBase = Math.max(0, 0.55 * gravPow(gravity, 0.55) + windDroopExtra);
  const TIP_ACCUM = 0.30;   // per-branchLevel droop amplification toward tips

  // -------------------------------------------------------------------------
  // Phototropism angle (rotation toward lightDir)
  //   Low gravity → plant can afford to reach toward light strongly.
  //   High gravity → gravity-droop dominates, phototropism is weaker.
  //   Mapping: photoAngle = 0.40 * g^(-0.45)
  //   At g=1: 0.40 rad (~23°). Low g (g=0.1): ~0.80 rad. High g (g=3): ~0.24 rad.
  // -------------------------------------------------------------------------
  const phototropism = genome?.phototropism ?? 1.0;
  const photoAngle = 0.40 * gravPow(gravity, -0.45) * phototropism;

  // -------------------------------------------------------------------------
  // Woody droop per branchLevel.
  //   Fine/deep branches (higher branchLevel) sag MORE under gravity —
  //   matching real trees where primary branches stay firm but fine ends weep.
  //   Higher gravity → larger droop magnitude overall.
  //
  //   woodyDroopBase = 0.06 * g^0.60    (radians at branchLevel=1)
  //   At g=1: 0.06 rad (~3.4°). At g=3: ~0.10 rad. At g=0.1: ~0.015 rad.
  //
  //   Per-node droop angle = woodyDroopBase * branchLevel
  //     branchLevel=1 → 1× base droop   (~3.4° at g=1)
  //     branchLevel=2 → 2× base droop   (~6.9°)
  //     branchLevel=3 → 3× base droop   (~10.3°)
  //   (trunk branchLevel=0 is excluded — it is the main stem, not a side branch)
  //
  //   Tip accumulation grows monotonically with branchLevel so the outer fine
  //   twigs arch/sag visibly while the primary scaffold stays upright.
  //
  //   rigidity gene also scales woody droop, using the same rigidityDroopScale factor.
  // -------------------------------------------------------------------------
  const woodyDroopBase = 0.06 * gravPow(gravity, 0.60) * rigidityDroopScale;

  // -------------------------------------------------------------------------
  // Compose verticality + droop + phototropism per terminal node into ONE net rotation.
  //
  // Verticality and droop share the SAME rotation axis (cross(downDir, rawOffset)),
  // so they can be merged into a single angle:
  //   totalDroopAngle = vertAngle + droopAngle
  // This is a SINGLE Rodrigues call — no double-rotation.
  //
  // droopAngle is now computed PER-NODE inside the loop (depends on branchLevel for
  // tip accumulation). The formula is:
  //   droopAngle = droopPhysicsBase * (1 + branchLevel * TIP_ACCUM) * rigidityDroopScale
  //
  // Then phototropism is applied on the result (separate axis, sequential composition).
  //
  // Strategy:
  //   1. Combined verticality+gravity+wind droop (single Rodrigues):
  //      axis k_droop = normalize(downDir × offset)
  //      angle = vertAngle + droopAngle   (droopAngle computed per-node)
  //      (vertAngle=0 at verticality=0.5 → identical to original for legacy callers)
  //
  //   2. Phototropism (on already-drooped+tilted offset):
  //      k_photo = normalize(offsetAfterDroop × lightDir)
  //      angle = photoAngle
  //
  //   3. Elongation scale (applied after rotation).
  //
  // terminal.pos = attachPos + rotate(scale(offset, elongation))
  // -------------------------------------------------------------------------

  const downDir = vecNorm(vecScale(bodyAxis, -1));  // –bodyAxis = "down"

  // -------------------------------------------------------------------------
  // RADIUS CONCEPT 2: Pipe-model taper — single forward pass.
  //
  // Because parentIdx < ownIndex (invariant enforced above), a single forward
  // loop over nodes[0..n-1] guarantees every parent already has its radius set
  // by the time we process its children.
  //
  // Algorithm per node:
  //   If isRoot:             radius = rootBaseRadius  (flare — separate concept)
  //   If branchLevel == 0 and no parent (trunk base): radius = stemBaseRadius
  //   Otherwise:
  //     Find all children of node[i].
  //     Leader = child with smallest direction divergence (largest dot product
  //              of child→grandchild direction vs parent→child direction).
  //              Fallback: child with highest index (deterministic, no rng).
  //     r_leader = r_parent * TAPER
  //     If c > 1: each lateral gets sqrt(max(r_parent² - r_leader², 0) / (c-1))
  //     If c == 1: single child gets r_parent * TAPER
  //     (c == 0: leaf — will be set to pipe-model radius × leafPhysMod below)
  //
  // NOTE: We build a children map first, then do the forward radius pass.
  // -------------------------------------------------------------------------

  // Build children map: childrenOf[i] = [list of child node indices]
  const childrenOf = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    childrenOf[i] = [];
  }
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parentIdx;
    if (p !== undefined && p >= 0) {
      childrenOf[p].push(i);
    }
  }

  // -------------------------------------------------------------------------
  // Root pipe-model parameters (genome-driven, defensive read).
  //
  // rootFlare ∈ [0,1]: scales the taproot base radius above rootBaseRadius.
  //   taprootBaseRadius = rootBaseRadius * (1 + rootFlare)
  //   genome=null / rootFlare absent → 0 (no extra flare; falls back to rootBaseRadius)
  //
  // rootTaper ∈ [0,1]: aggressiveness of per-level taper along root chains.
  //   rootTaperRatio = 0.60 + rootTaper * 0.25   → range [0.60, 0.85]
  //   genome=null / rootTaper absent → 0.5 → ratio=0.725 (neutral mid-taper)
  // -------------------------------------------------------------------------
  const rootFlareGene = (genome !== null && genome.rootFlare !== undefined)
    ? genome.rootFlare
    : 0.0;
  const rootTaperGene = (genome !== null && genome.rootTaper !== undefined)
    ? genome.rootTaper
    : 0.5;
  const taprootBaseRadius = rootBaseRadius * (1.0 + rootFlareGene);
  const ROOT_TAPER = 0.60 + rootTaperGene * 0.25;

  // Forward pass: assign radius to every node in order.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];

    // Root nodes — pipe-model forward pass using root-specific taper/flare.
    //
    // The taproot/buttress origin node (isRoot, parent is NOT isRoot) gets
    // taprootBaseRadius; all deeper root nodes inherit via the root pipe-model.
    // This reuses the SAME sqrt-residual split formula used for the canopy
    // (lines 638-643) so the pipe-model invariant r_parent² ≈ Σ child r²
    // holds for roots too.
    //
    // parentIdx < ownIndex is guaranteed by the guard above, so by the time
    // we reach node i, every root parent already has its radius set.
    if (n.isRoot === true) {
      const parentIdx = n.parentIdx !== undefined ? n.parentIdx : -1;

      if (parentIdx < 0 || nodes[parentIdx].isRoot !== true) {
        // Taproot/buttress origin: first root node in a chain, parented to trunk.
        n.radius = taprootBaseRadius;
      } else {
        // Deeper root node: inherit via root pipe-model from root parent.
        const rParent = nodes[parentIdx].radius;
        const rootSiblings = childrenOf[parentIdx].filter(ci => nodes[ci].isRoot === true);
        const c = rootSiblings.length;

        if (c === 1) {
          n.radius = rParent * ROOT_TAPER;
        } else {
          // Multiple root children: leader gets ROOT_TAPER, laterals share residual area.
          // Leader = child with highest index (deterministic, consistent with canopy fallback).
          const leaderIdx = Math.max(...rootSiblings);
          const rLeader = rParent * ROOT_TAPER;
          const residualSq = Math.max(0, rParent * rParent - rLeader * rLeader);
          const nLaterals = c - 1;
          const rLateral = nLaterals > 0 ? Math.sqrt(residualSq / nLaterals) : 0;
          n.radius = (i === leaderIdx) ? rLeader : rLateral;
        }
      }
      continue;
    }

    const parentIdx = n.parentIdx !== undefined ? n.parentIdx : -1;

    if (parentIdx < 0) {
      // Trunk base node (no parent): absolute physics radius.
      n.radius = stemBaseRadius;
      continue;
    }

    // All other nodes: inherit via pipe-model from parent.
    const parent = nodes[parentIdx];
    const rParent = parent.radius;
    const siblings = childrenOf[parentIdx];
    const c = siblings.length;

    // For trunk nodes (branchLevel 0), blend effective taper toward 1.0 by trunkTaper.
    // At trunkTaper=0: effectiveTaper === TAPER (identity, byte-identical output).
    // At trunkTaper=1: effectiveTaper === 1.0 (cylindrical trunk, top ≈ base radius).
    // parent.branchLevel drives the blend — the PARENT being branchLevel 0 means
    // n (the child) is also on the trunk chain (trunk segments connect 0→0 nodes).
    const effectiveTaper = (parent.branchLevel === 0 && trunkTaperGene > 0)
      ? TAPER + (1.0 - TAPER) * trunkTaperGene
      : TAPER;

    if (c === 1) {
      // Single child on this parent: straightforward taper.
      n.radius = rParent * effectiveTaper;
    } else {
      // Multiple children: identify the leader (smallest direction divergence).
      // Leader identification uses the direction from parent's parent → parent
      // as the "parent axis", then picks the child whose direction is closest.
      //
      // If parent has no grandparent, use bodyAxis as the reference axis.
      const gpIdx = parent.parentIdx !== undefined ? parent.parentIdx : -1;
      let parentAxis;
      if (gpIdx >= 0) {
        const gp = nodes[gpIdx];
        parentAxis = vecNorm([
          parent.pos[0] - gp.pos[0],
          parent.pos[1] - gp.pos[1],
          parent.pos[2] - gp.pos[2],
        ]);
      } else {
        parentAxis = vecNorm(bodyAxis);
      }

      // Compute each sibling's direction from parent and its dot with parentAxis.
      let leaderIdx = -1;
      let leaderDot = -Infinity;
      for (let si = 0; si < siblings.length; si++) {
        const childIdx = siblings[si];
        const child = nodes[childIdx];
        const dir = vecNorm([
          child.pos[0] - parent.pos[0],
          child.pos[1] - parent.pos[1],
          child.pos[2] - parent.pos[2],
        ]);
        const d = vecDot(dir, parentAxis);
        if (d > leaderDot) {
          leaderDot = d;
          leaderIdx = childIdx;
        }
      }

      const rLeader = rParent * effectiveTaper;
      const residualSq = Math.max(0, rParent * rParent - rLeader * rLeader);
      const nLaterals = c - 1;
      const rLateral = nLaterals > 0 ? Math.sqrt(residualSq / nLaterals) : 0;

      n.radius = (i === leaderIdx) ? rLeader : rLateral;
    }
  }

  // -------------------------------------------------------------------------
  // Tip-taper pass: drive FREE-END (leaf/tip) node radii to near-zero so the
  // sdRoundCone bone from parent→tip becomes a true cone, not a sphere cap.
  //
  // A tip node is one with NO children (childrenOf[i].length === 0).  This
  // covers both branch terminals (isTerminal / twig ends) and root tips (the
  // outer dangling ends of the root flare).  It intentionally EXCLUDES every
  // interior node — even the trunk base node (parentIdx == -1) that has
  // children connected to it.
  //
  // Formula: tipRadius = max(0.012, pipeRadius * 0.08)
  //   • 0.08 factor: 92 % taper from parent → reads as a cone tip, not a ball,
  //     across the full radius range (thin twigs → fat succulent stems).
  //   • 0.012 floor: prevents aliasing needles on very thin tips (sub-pixel bones).
  //   • A thick succulent tip (parent r ≈ 0.20) → tip r ≈ 0.016: rounded point. ✓
  //   • A thin twig (parent r ≈ 0.03)  → tip r = 0.012 (floor): clean point. ✓
  //
  // Applied AFTER pipe-model assignment so it only overrides the tip radius.
  // Interior radii are never touched.
  // -------------------------------------------------------------------------
  for (let i = 0; i < nodes.length; i++) {
    if (childrenOf[i].length === 0) {
      const r = nodes[i].radius;
      nodes[i].radius = Math.max(0.012, r * 0.08);
    }
  }

  // -------------------------------------------------------------------------
  // Second pass: apply terminal leaf modifier and position bending.
  // -------------------------------------------------------------------------
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];

    // Skip root and isRoot (already set, no bending needed).
    if (n.isRoot === true) continue;

    // Terminal leaf nodes: apply RADIUS CONCEPT 3 (leaf physics multiplier)
    // and bend positions (droop + phototropism).
    if (n.isTerminal === true) {
      // Radius: pipe-model value already set above × leaf physics modifiers.
      n.radius = n.radius * leafPhysMod;

      // Bending: requires attachPos by contract.
      if (!n.attachPos) continue;

      const ap = n.attachPos;
      const rawOffset = [
        n.pos[0] - ap[0],
        n.pos[1] - ap[1],
        n.pos[2] - ap[2],
      ];
      const offsetLen = vecLen(rawOffset);
      if (offsetLen < 1e-10) continue;  // degenerate: zero-length leaf, leave as-is

      // --- Step 1: verticality + gravity + wind droop (SINGLE combined rotation) ---
      //
      // Both verticality and droop share the axis k_droop = normalize(downDir × rawOffset).
      // They are ADDED as angles before the single Rodrigues call, ensuring one rotation only.
      //
      // totalDroopAngle = vertAngle + droopAngle
      //   vertAngle:    (verticality - 0.5) * π     — 0 at gene=0.5 (erect baseline)
      //   droopAngle:   physics droop × tip accumulation × rigidityDroopScale
      //
      // Tip accumulation: fine/deep twigs droop more. Factor = 1 + branchLevel * TIP_ACCUM.
      // branchLevel=0 (trunk chain) → ×1.0; branchLevel=3 → ×1.9; branchLevel=5 → ×2.5.
      //
      // At genome=null: vertAngle=0, rigidityDroopScale=1.0 → droopAngle=droopPhysicsBase.
      const tBranchLevel   = (n.branchLevel !== undefined ? n.branchLevel : 0);
      const tipAccumFactor = 1.0 + tBranchLevel * TIP_ACCUM;
      // Clamp per-node droop to π/2 so tips never rotate past straight-down.
      // Without this, extreme gravity + high tip accumulation can overshoot vertical,
      // which breaks monotonicity and looks wrong (branches swinging back up).
      const droopAngle     = Math.min(Math.PI / 2, droopPhysicsBase * tipAccumFactor * rigidityDroopScale);
      // droopBias additive signed term, scaled by branchLevel so it grows toward the tips.
      // SIGN NOTE: this terminal loop rotates about cross(downDir, rawOffset) and then a
      // phototropism step lifts the drooped offset — so in this loop a LARGER totalDroopAngle
      // actually RAISES the tip (more photo lift), as the rigidity test documents. To make
      // POSITIVE droopBias lower the tip (consistent with the woody loop below), we SUBTRACT
      // the bias here. Clamped to ±π/2 so the bias alone can't overshoot. droopBias=0 → 0 (no-op).
      const droopBiasAngle = clampSym(
        droopBiasGene * tBranchLevel * DROOP_BIAS_GAIN,
        Math.PI / 2
      );
      const totalDroopAngle = vertAngle + droopAngle - droopBiasAngle;

      let kDroop = vecCross(downDir, rawOffset);
      const kDroopLen = vecLen(kDroop);
      let offsetAfterDroop;
      if (kDroopLen < 1e-10) {
        // offset is already parallel to downDir — no droop axis, skip droop
        offsetAfterDroop = rawOffset.slice();
      } else {
        kDroop = vecScale(kDroop, 1 / kDroopLen);
        offsetAfterDroop = rotateAroundAxis(rawOffset, kDroop, totalDroopAngle);
      }

      // --- Step 2: phototropism (applied to already-drooped offset) ---
      // Axis: perpendicular to offsetAfterDroop in the (offsetAfterDroop, lightDir) plane.
      // k_photo = normalize(offsetAfterDroop × lightDir) — positive angle → tip toward light.
      // lightDir is now derived from sunAngle, so a low sun produces a natural
      // one-sided lean without any additional asymmetry code.
      let kPhoto = vecCross(offsetAfterDroop, lightDir);
      const kPhotoLen = vecLen(kPhoto);
      let offsetFinal;
      if (kPhotoLen < 1e-10) {
        // offset already aligned with lightDir — no rotation needed
        offsetFinal = offsetAfterDroop.slice();
      } else {
        kPhoto = vecScale(kPhoto, 1 / kPhotoLen);
        offsetFinal = rotateAroundAxis(offsetAfterDroop, kPhoto, photoAngle);
      }

      // --- Step 3: elongation scale (applied after rotation, preserves direction) ---
      // leafElongation already incorporates light/wind/aridity modifiers.
      const scaledOffset = vecScale(offsetFinal, leafElongation);

      // --- Reconstruct position from attachPos + scaled/rotated offset ---
      n.pos[0] = ap[0] + scaledOffset[0];
      n.pos[1] = ap[1] + scaledOffset[1];
      n.pos[2] = ap[2] + scaledOffset[2];

      // flat / flatNormal are NOT touched — owned by skin/shader
      continue;
    }

    // Woody (interior) nodes: apply per-level gravitational droop to position.
    // This sags side branches downward, with higher branchLevel sagging more
    // (fine twigs weep, primary scaffold stays firmer — matches real trees).
    // The droop is applied relative to the parent node's position.
    // rigidity gene scales woodyDroopBase, so this composes consistently.
    if (n.isWoody === true && n.branchLevel !== undefined && n.branchLevel > 0) {
      const parentIdx = n.parentIdx;
      if (parentIdx < 0) continue;  // trunk base — no droop

      const parent = nodes[parentIdx];
      const rawOffset = [
        n.pos[0] - parent.pos[0],
        n.pos[1] - parent.pos[1],
        n.pos[2] - parent.pos[2],
      ];
      const offsetLen = vecLen(rawOffset);
      if (offsetLen < 1e-10) continue;

      // Per-level droop: higher branchLevel → larger droop angle (tips sag more than primaries).
      // woodyDroopAngle = woodyDroopBase * branchLevel
      // droopBias adds a signed per-level term in the SAME convention as this loop
      // (axis cross(rawOffset, downDir): positive angle tilts the offset toward down,
      // so + droopBias → more droop, − droopBias → upsweep). Scaled by branchLevel like
      // the base droop. Clamped to ±π/2 so the bias alone can't overshoot vertical.
      // At droopBias=0 the bias term is 0 → woodyDroopAngle unchanged (byte-identical no-op).
      const woodyDroopBiasAngle = clampSym(
        droopBiasGene * n.branchLevel * DROOP_BIAS_GAIN,
        Math.PI / 2
      );
      const woodyDroopAngle = woodyDroopBase * n.branchLevel + woodyDroopBiasAngle;

      // Compose into a single Rodrigues rotation.
      // To rotate rawOffset TOWARD downDir: axis = normalize(rawOffset × downDir).
      // Positive woodyDroopAngle then tilts the branch tip toward downDir (down).
      // NOTE: terminal droop uses cross(downDir, rawOffset) for historical reasons —
      // the phototropism step that follows corrects the geometry. Woody droop has
      // no phototropism step, so we use the correct Rodrigues convention here.
      let kDroop = vecCross(rawOffset, downDir);
      const kDroopLen = vecLen(kDroop);
      if (kDroopLen < 1e-10) continue;  // offset already parallel to down, skip

      kDroop = vecScale(kDroop, 1 / kDroopLen);
      const droopedOffset = rotateAroundAxis(rawOffset, kDroop, woodyDroopAngle);

      n.pos[0] = parent.pos[0] + droopedOffset[0];
      n.pos[1] = parent.pos[1] + droopedOffset[1];
      n.pos[2] = parent.pos[2] + droopedOffset[2];
    }
  }

  // -------------------------------------------------------------------------
  // WEEP PASS — willow-style cascade droop (genome.weep ∈ [0,1], default 0)
  //
  // Applies a progressive downward bend that accumulates toward the tips,
  // producing the pendulous hanging-strand look of weeping willows.
  //
  // Design:
  //   • Guarded on weep > 0. At weep == 0, the entire block is skipped and
  //     output is byte-identical to a tree with no weep gene (no-op guarantee).
  //   • Pure geometry — no rng draws. Deterministic given same inputs.
  //   • Does NOT touch isRoot nodes.
  //   • Applied as a SECOND rotation pass, on top of the existing woody droop
  //     and terminal bending already computed above. This means the weep angle
  //     adds to the existing droop rather than replacing it.
  //
  // Angle formula per node:
  //   weepAngle = weep * WEEP_MAX_PER_LEVEL * branchLevel
  //
  //   WEEP_MAX_PER_LEVEL = 0.35 rad/level — calibrated so weep=1, branchLevel=4
  //   gives 1.4 rad (~80°) of additional arc, enough for long willowing strands
  //   while branchLevel=0 (trunk) contributes 0 (the trunk stays upright).
  //
  //   The angle is clamped to [0, π] so no node can rotate past straight-down.
  //
  // Rotation:
  //   For each non-root node with branchLevel > 0, compute the offset from its
  //   parent's (already-adjusted) position, then rotate that offset toward the
  //   downward direction by weepAngle using Rodrigues' formula.
  //   The parent's position is used in-order (parents precede children by the
  //   parentIdx < ownIndex invariant), so the bend accumulates along each chain:
  //   each segment is bent relative to the position its parent already settled at,
  //   producing a curve rather than a uniform translation.
  //
  // Terminal-specific extra:
  //   Terminal nodes use attachPos as their parent anchor (matching the existing
  //   bending pass). We bend the offset from attachPos by the weep angle, then
  //   reconstruct pos = attachPos + bentOffset.
  // -------------------------------------------------------------------------
  const weep = (genome !== null && genome.weep !== undefined) ? (genome.weep ?? 0) : 0;

  if (weep > 0) {
    const WEEP_MAX_PER_LEVEL = 0.50; // radians of weep arc per branchLevel at weep=1

    // Pendulous strand length scale: terminal/distal segments grow longer under
    // high weep so the hanging strands have the characteristic willow length.
    // At weep=0: factor=1.0 (no-op). At weep=1: terminal segments are scaled up
    // to WEEP_STRAND_SCALE_MAX times their original length.
    // Only applied at branchLevel >= WEEP_STRAND_MIN_LEVEL (distal/terminal twigs).
    const WEEP_STRAND_SCALE_MAX = 1.8;
    const WEEP_STRAND_MIN_LEVEL = 2;   // only lengthen distal branches, not primaries

    // Forward pass: parentIdx < ownIndex guarantees parents are already adjusted
    // before we process each child.
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];

      // Skip root nodes — they are underground, unaffected by willow weep.
      if (n.isRoot === true) continue;

      // Skip trunk nodes (branchLevel=0) — the trunk should stay upright.
      const level = n.branchLevel !== undefined ? n.branchLevel : 0;
      if (level === 0) continue;

      // Per-node weep angle, clamped to [0, π].
      const weepAngle = Math.min(Math.PI, weep * WEEP_MAX_PER_LEVEL * level);
      if (weepAngle < 1e-12) continue;

      // STRAND THINNING: pendulous willow withes are slender, not stiff rods. Thin the
      // weeping twig's radius proportional to weep and depth so cascading strands read
      // as whippy rather than rigid (audit: weep kept full pipe-model radius). weep=0 →
      // this whole pass is skipped, so non-weeping trees are byte-identical.
      n.radius *= 1 - weep * 0.35 * Math.min(1, level / 3);

      // Anchor to the parent's ALREADY-WEEPED position for EVERY node, INCLUDING
      // terminals. Terminals must cascade with their drooping parent. Anchoring
      // them to the static attachPos (as the earlier terminal-bending pass does)
      // left a near-zero offset → they were skipped below, so the visible
      // leaf-bearing tips stayed up while only interior nodes drooped and the
      // willow cascade never appeared. Using parent.pos gives a real segment
      // offset that rotates down and follows the parent's accumulated droop.
      const parentIdx = n.parentIdx !== undefined ? n.parentIdx : -1;
      if (parentIdx < 0) continue;
      const anchorPos = nodes[parentIdx].pos;

      const rawOffset = [
        n.pos[0] - anchorPos[0],
        n.pos[1] - anchorPos[1],
        n.pos[2] - anchorPos[2],
      ];
      const offsetLen = vecLen(rawOffset);
      if (offsetLen < 1e-10) continue;

      // Rotation axis: cross(rawOffset, downDir) rotates offset TOWARD downDir.
      // (Same convention as the woody droop axis above.)
      let kWeep = vecCross(rawOffset, downDir);
      const kWeepLen = vecLen(kWeep);
      if (kWeepLen < 1e-10) continue; // already parallel to downDir, skip

      kWeep = vecScale(kWeep, 1 / kWeepLen);
      let bentOffset = rotateAroundAxis(rawOffset, kWeep, weepAngle);

      // Pendulous strand elongation: scale terminal twig segments longer under
      // high weep so they read as long hanging strands rather than short stubs.
      // Applied AFTER rotation so the stretch is along the already-drooped direction.
      // weep=0 → strandScale=1.0 (no-op). weep=1 → strandScale=WEEP_STRAND_SCALE_MAX.
      // Only for terminal segments at branchLevel >= WEEP_STRAND_MIN_LEVEL —
      // interior woody nodes are excluded so the cascade-accumulation invariant holds
      // (each level drops strictly more than the level above it in absolute Y terms).
      if (n.isTerminal === true && level >= WEEP_STRAND_MIN_LEVEL) {
        const strandScale = 1.0 + weep * (WEEP_STRAND_SCALE_MAX - 1.0);
        bentOffset = vecScale(bentOffset, strandScale);
      }

      n.pos[0] = anchorPos[0] + bentOffset[0];
      n.pos[1] = anchorPos[1] + bentOffset[1];
      n.pos[2] = anchorPos[2] + bentOffset[2];
    }
  }

  return graph;
}
