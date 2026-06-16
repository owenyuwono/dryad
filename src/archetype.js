// =============================================================================
// STAGE 2 — pickArchetype(envelope, rng) -> archetype   [FLORA recursive branch graph]
//
// FIXED rng DRAW ORDER (11 draws — downstream skeleton building depends on
// this exact consumption order; every code path draws all 11):
//   1)  symmetry       — child-arrangement rule at every branch node
//   2)  growthHabit    — overall plant body plan
//   3)  appendageKind  — terminal leaf/blade kind
//   4)  maxDepth       — recursive branch levels below trunk (trunk = level 0)
//   5)  branchFactor   — children per branch node
//   6)  branchAngle    — lateral divergence off parent axis (radians)
//   7)  lengthRatio    — child length / parent length per level
//   8)  apicalBias     — leader dominance (1 = one straight long leader child)
//   9)  internodeCount — segments (bones) along each branch
//   10) trunkSegments  — segments along the level-0 trunk
//   11) droopBias      — grammar-level droop seed
//
// OLD FIELDS REMOVED: whorlN → branchFactor, nodeCount → trunkSegments/internodeCount,
//   recursionDepth → maxDepth.
//
// Physics biases (envelope biases distributions; rng still varies within them):
//   light     [0 dim → 1 bright]  — DIM biases maxDepth UP and branchFactor UP
//                                    (airy periphery for light capture).
//                                    Centered at light=0.6 → zero offset.
//   aridity   [0 lush → 1 arid]   — ARID biases maxDepth DOWN, branchFactor DOWN,
//                                    and appendageKind toward economical kinds.
//                                    Centered at aridity=0.35 → zero offset.
//   wind      [0 calm → 1 strong] — STRONG biases trunkSegments DOWN, branchFactor DOWN,
//                                    and sturdy growthHabits. Does NOT touch maxDepth.
//                                    Centered at wind=0.2 → zero offset.
//   sunAngle  [0 overhead → 1 low]— LOW SUN biases symmetry toward 'bilateral',
//                                    and nudges apicalBias UP (reach toward light).
//                                    Centered at sunAngle=0.25 → zero offset.
//   gravity   — NOT read here; gravity stays in solveProportions (absolute scale/droop).
//
// DEFAULT-CENTERED INVARIANT: at light=0.6, sunAngle=0.25, wind=0.2, aridity=0.35
//   all physics offsets net to zero — same rng draw → same result as unbiased.
//
// Extension point: growthHabit and appendageKind tables are the fauna/fungi
//   extension point (quadruped/mycelium variants, chitinous appendages, etc.) — parked.
// =============================================================================

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Clamp v to [lo, hi]. */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Map a uniform [0,1) rng draw to an integer in [min, max] (inclusive),
 * with an optional additive offset applied before flooring.
 */
function pickInt(raw, min, max, offset = 0) {
  const span = max - min + 1;
  const adj  = clamp(raw + offset, 0, 0.9999);
  return min + Math.floor(adj * span);
}

/**
 * Map a uniform [0,1) rng draw to a float in [min, max],
 * with an optional additive offset applied before scaling.
 */
function pickFloat(raw, min, max, offset = 0) {
  const adj = clamp(raw + offset, 0, 1);
  return min + adj * (max - min);
}

// ---------------------------------------------------------------------------
// pickArchetype
// ---------------------------------------------------------------------------

export function pickArchetype(envelope, rng) {
  const {
    medium,
    light    = 0.6,   // dim 0 → bright 1
    sunAngle = 0.25,  // overhead 0 → low sun 1
    wind     = 0.2,   // calm 0 → strong 1
    aridity  = 0.35,  // lush 0 → arid 1
  } = envelope;
  // `energy` is always 'photo' for flora — not branched on here.
  // `gravity` and `biochem` are available for future stages but not used here.

  // -------------------------------------------------------------------------
  // DRAW 1 — symmetry
  // -------------------------------------------------------------------------
  // Flora leans radial/helical; bilateral is rare (ferns, monocot leaf fans).
  // BASE weights: bilateral 0.15 | radial_n 0.45 | helical 0.40
  //
  // sunAngle bias: HIGH sunAngle (low sun, →1) → more bilateral (plant faces the sun,
  //   front/back differentiated). Achieved by subtracting from the roll so the bilateral
  //   cutoff band expands downward.
  //   offset = −(sunAngle − 0.25) * 0.40
  //   At default 0.25 → offset 0.  sunAngle=1 → offset −0.30 (bilateral up to ~0.45).
  //   sunAngle=0 → offset +0.10 (bilateral band narrows to ~0.05).
  const symRaw  = rng(); // draw 1
  const symAdj  = clamp(symRaw - (sunAngle - 0.25) * 0.40, 0, 1);
  let symmetry;
  if      (symAdj < 0.15) symmetry = 'bilateral';
  else if (symAdj < 0.60) symmetry = 'radial_n';  // 0.15 + 0.45
  else                    symmetry = 'helical';

  // -------------------------------------------------------------------------
  // DRAW 2 — growthHabit
  // -------------------------------------------------------------------------
  // Extension point: fauna/fungi body plans swap this table — parked stub.
  //
  // Base tables (medium → habit probabilities):
  //   air        single_trunk 0.45 | basal_rosette 0.35 | multi_stem 0.15 | vine 0.05
  //   water      multi_stem   0.40 | vine          0.30 | basal_rosette 0.20 | single_trunk 0.10
  //   dense_air  basal_rosette 0.40 | single_trunk 0.30 | multi_stem 0.20 | vine 0.10
  //
  // wind bias: STRONG wind → low/sturdy habits (multi_stem, basal_rosette) over tall
  //   single_trunk. Higher roll → away from upright/solitary forms.
  //   offset = +(wind − 0.2) * 0.35
  //   At default 0.2 → offset 0.  wind=1 → +0.28; wind=0 → −0.07.
  const habitRaw = rng(); // draw 2
  const habitAdj = clamp(habitRaw + (wind - 0.2) * 0.35, 0, 1);
  let growthHabit;
  if (medium === 'water') {
    if      (habitAdj < 0.40) growthHabit = 'multi_stem';
    else if (habitAdj < 0.70) growthHabit = 'vine';
    else if (habitAdj < 0.90) growthHabit = 'basal_rosette';
    else                      growthHabit = 'single_trunk';
  } else if (medium === 'dense_air') {
    if      (habitAdj < 0.40) growthHabit = 'basal_rosette';
    else if (habitAdj < 0.70) growthHabit = 'single_trunk';
    else if (habitAdj < 0.90) growthHabit = 'multi_stem';
    else                      growthHabit = 'vine';
  } else { // air (default)
    if      (habitAdj < 0.45) growthHabit = 'single_trunk';
    else if (habitAdj < 0.80) growthHabit = 'basal_rosette';
    else if (habitAdj < 0.95) growthHabit = 'multi_stem';
    else                      growthHabit = 'vine';
  }

  // -------------------------------------------------------------------------
  // DRAW 3 — appendageKind
  // -------------------------------------------------------------------------
  // Index 0 of each medium array is the economical/reduced form; index 1 is broad.
  // Extension point: fauna/fungi appendage palettes plug in here — parked stub.
  //
  // aridity bias: HIGH aridity → economical appendages (index 0).
  //   scaleFactor = clamp(1 − (aridity − 0.35) * 0.60, 0.05, 1.0)
  //   At default 0.35 → factor 1.0 (uniform across candidates).
  //   aridity=1 → factor 0.61; aridity=0 → factor clamped to 1.0.
  let appendageCandidates;
  if      (medium === 'water')     appendageCandidates = ['blade', 'frond']; // [economical, broad]
  else if (medium === 'dense_air') appendageCandidates = ['frond', 'sail'];  // [economical, broad]
  else                             appendageCandidates = ['branch', 'leaf']; // [economical, broad]

  const appendageRaw    = rng(); // draw 3
  const appendageScale  = clamp(1 - (aridity - 0.35) * 0.60, 0.05, 1.0);
  const appendageKind   = appendageCandidates[Math.floor(appendageRaw * appendageScale * appendageCandidates.length)];

  // -------------------------------------------------------------------------
  // DRAW 4 — maxDepth   [2..5]
  // -------------------------------------------------------------------------
  // Recursive branch levels below the trunk (trunk = level 0).
  //
  // light bias: DIM light → deeper tree (more levels for light capture).
  //   offset = −(light − 0.6) * 0.50
  //   At default 0.6 → 0. light=0 (dim) → +0.30 (pushed toward 4–5).
  //   light=1 (bright) → −0.20 (pushed toward 2–3).
  //
  // aridity bias: ARID → shallower tree (reduced foliage budget).
  //   offset += −(aridity − 0.35) * 0.40
  //   At default 0.35 → 0. aridity=1 → −0.26. aridity=0 → +0.14.
  //
  // Combined at defaults: 0 + 0 = 0. Extreme dim+lush: +0.30+0.14 = +0.44.
  // Extreme bright+arid: −0.20−0.26 = −0.46.
  const depthRaw    = rng(); // draw 4
  const depthOffset = -(light - 0.6) * 0.50 - (aridity - 0.35) * 0.40;
  const maxDepth    = pickInt(depthRaw, 2, 5, depthOffset);

  // -------------------------------------------------------------------------
  // DRAW 5 — branchFactor   [2..4]
  // -------------------------------------------------------------------------
  // Children spawned per branch node (the symmetry operator's count).
  //
  // light bias: DIM light → more branches (airy periphery).
  //   offset = −(light − 0.6) * 0.45
  //   At default 0.6 → 0. light=0 → +0.27 (pushed toward 3–4).
  //   light=1 → −0.18 (pushed toward 2).
  //
  // aridity bias: ARID → fewer branches.
  //   offset += −(aridity − 0.35) * 0.35
  //   At default 0.35 → 0. aridity=1 → −0.23. aridity=0 → +0.12.
  //
  // wind bias: STRONG wind → fewer branches (reduce drag).
  //   offset += −(wind − 0.2) * 0.30
  //   At default 0.2 → 0. wind=1 → −0.24. wind=0 → +0.06.
  //
  // At all defaults: 0 + 0 + 0 = 0.
  const branchRaw    = rng(); // draw 5
  const branchOffset = -(light - 0.6) * 0.45
                     - (aridity - 0.35) * 0.35
                     - (wind   - 0.2)   * 0.30;
  const branchFactor = pickInt(branchRaw, 2, 4, branchOffset);

  // -------------------------------------------------------------------------
  // DRAW 6 — branchAngle   [0.35..0.80] radians  (≈ 20–46°)
  // -------------------------------------------------------------------------
  // Lateral divergence of child axis off parent axis. No physics bias on this
  // field; it is pure rng variety within the ergonomic range.
  const branchAngle = pickFloat(rng(), 0.35, 0.80); // draw 6

  // -------------------------------------------------------------------------
  // DRAW 7 — lengthRatio   [0.55..0.85]
  // -------------------------------------------------------------------------
  // Child length / parent length per level. No physics bias (solveProportions
  // applies gravity-driven taper on top of this grammar seed).
  const lengthRatio = pickFloat(rng(), 0.55, 0.85); // draw 7

  // -------------------------------------------------------------------------
  // DRAW 8 — apicalBias   [0.0..1.0]
  // -------------------------------------------------------------------------
  // Leader dominance: 1 → one straight long leader child; 0 → symmetric.
  //
  // sunAngle bias: LOW SUN (→1) → plant reaches a leader toward light.
  //   offset = +(sunAngle − 0.25) * 0.20
  //   At default 0.25 → 0. sunAngle=1 → +0.15 (slight lean toward leader).
  //   sunAngle=0 → −0.05 (barely perceptible toward symmetric).
  const apicalRaw    = rng(); // draw 8
  const apicalOffset = (sunAngle - 0.25) * 0.20;
  const apicalBias   = pickFloat(apicalRaw, 0.0, 1.0, apicalOffset);

  // -------------------------------------------------------------------------
  // DRAW 9 — internodeCount   [2..4]
  // -------------------------------------------------------------------------
  // Segments (bones) along each branch. No physics bias; variety provided by rng.
  const internodeCount = pickInt(rng(), 2, 4); // draw 9

  // -------------------------------------------------------------------------
  // DRAW 10 — trunkSegments   [3..6]
  // -------------------------------------------------------------------------
  // Segments along the level-0 trunk.
  //
  // wind bias: STRONG wind → fewer trunk segments (shorter, sturdier trunk).
  //   offset = −(wind − 0.2) * 0.40
  //   At default 0.2 → 0. wind=1 → −0.32 (pushed toward 3–4).
  //   wind=0 → +0.08 (slight lean toward 4–5).
  const trunkRaw    = rng(); // draw 10
  const trunkOffset = -(wind - 0.2) * 0.40;
  const trunkSegments = pickInt(trunkRaw, 3, 6, trunkOffset);

  // -------------------------------------------------------------------------
  // DRAW 11 — droopBias   [−0.2..0.4]
  // -------------------------------------------------------------------------
  // Grammar-level droop seed. Positive → drooping branches; negative → upswept.
  // solveProportions adds gravity-proportional droop on top of this.
  const droopBias = pickFloat(rng(), -0.2, 0.4); // draw 11

  // -------------------------------------------------------------------------
  // Return frozen contract — downstream stages depend on this exact shape.
  // -------------------------------------------------------------------------
  return Object.freeze({
    growthHabit,
    symmetry,
    appendageKind,
    maxDepth,
    branchFactor,
    branchAngle,
    lengthRatio,
    apicalBias,
    internodeCount,
    trunkSegments,
    droopBias,
  });
}
