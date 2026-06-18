// =============================================================================
// genomeSchema.js — declarative FLORA genome schema (continuous morphospace)
//
// Keystone of the phylogeny layer. Describes every gene's tier, kind, and valid
// domain. Used by genome-agnostic mutate() and by distance/divergence calcs.
//
// CONTINUOUS MORPHOSPACE (No Man's Sky-style):
//   All genes are kind:'continuous' (float in [lo,hi]) except structuralSeed
//   which is kind:'seed' (uint32). Discrete categoricals and integer step-genes
//   have been replaced by continuous axes — the renderer interprets these axes
//   directly rather than branching on named categories.
//
// Tier assignments affect mutation-rate multipliers in mutate.js:
//   structural  — gross body plan axes (rare mutation, macromutation)
//   proportions — shape/proportion axes (moderate mutation)
//   cosmetic    — surface detail axes (frequent mutation)
//
// Pure ESM — no three.js dependency; importable via `node --input-type=module`.
// =============================================================================

// ---------------------------------------------------------------------------
// FLORA_SCHEMA
// ---------------------------------------------------------------------------

/**
 * Schema map: field -> gene descriptor.
 *
 * tier:  'structural' | 'proportions' | 'cosmetic'
 * kind:  'continuous' | 'seed'
 * range: (continuous only) [lo, hi] inclusive
 */
export const FLORA_SCHEMA = Object.freeze({

  // -------------------------------------------------------------------------
  // STRUCTURAL TIER — gross body plan
  // -------------------------------------------------------------------------

  /** Overall branching intensity; 0 = unbranched column, 1 = maximally bushy. */
  branchiness: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Continuous branch-count proxy (maps to ~2–4 children in the renderer);
   * 0 = fewest branches per node, 1 = most.
   */
  branchFactorN: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Basal shoot production; 0 = single-stem, 1 = heavily tillering/clumping.
   */
  tillering: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Continuous symmetry: 0 = bilateral, 0.5 = radial-N, 1 = phyllotactic/helical.
   * Replaces the categorical `symmetry` field.
   */
  radialOrder: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Appendage cross-section breadth: 0 = spine/needle, 0.5 = narrow blade, 1 = broad lamina.
   * Replaces the categorical `appendageKind` field.
   */
  appendageBreadth: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Appendage packing density along a stem; 0 = sparse, 1 = densely clad. */
  appendageDensity: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Degree of articulation / segmentation along stems; 0 = smooth, 1 = highly segmented. */
  segmentation: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Overall plant vertical stature: 0 = short bush (~0.45×), 0.5 = identity (1.0×), 1 = tall (~1.7×).
   * Applied in skeleton.js as a scale on BASE_BRANCH_LENGTH and TRUNK_HEIGHT.
   * NEUTRAL 0.50 → factor exactly 1.0 → byte-identical output to pre-gene skeleton. Draw 39.
   */
  trunkHeight: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Lateral spread of tillering stem bases; 0 = no-op (identity), 1 = maximally splayed.
   * Structural tier — consumed by skeleton.js (not yet wired). Draw 41.
   */
  stemSpread: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Apical whorl rosette prominence; 0 = no-op (identity), 1 = full apical whorl.
   * Structural tier — consumed by skeleton.js (not yet wired). Draw 42.
   */
  rosette: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /**
   * Whorled branching pattern intensity; 0 = no-op, 1 = full whorled arrangement.
   * Structural tier — no consumer wired yet. Draw 44. IDENTITY DEFAULT = 0.
   */
  whorl: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  // -------------------------------------------------------------------------
  // PROPORTIONS TIER — shape
  // -------------------------------------------------------------------------

  /** Water-storage inflation; 0 = wiry/thin, 1 = cactus-like barrel. */
  succulence: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Stem cross-section radius relative to length; 0 = reed-thin, 1 = stout. */
  stemGirth: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Taper from base to tip; 0 = cylindrical (no taper), 1 = strongly pointed. */
  taper: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Stem flexibility; 0 = highly flexible/floppy, 1 = rigid/woody. */
  rigidity: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Growth direction: 0 = prostrate/creeping, 0.5 = erect, 1 = pendulous/weeping. */
  verticality: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Longitudinal ridging on stems; 0 = smooth cylinder, 1 = deeply ribbed. */
  ribbing: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Spine/thorn density and length; 0 = smooth, 1 = heavily armed. */
  spininess: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /** Lateral divergence of child axis off parent axis (radians ≈ 20–46°). */
  branchAngle: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.35, 0.80]),
  }),

  /** Child length / parent length per recursive level. */
  lengthRatio: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.55, 0.85]),
  }),

  /** Leader dominance; 0 = symmetric branching, 1 = single dominant leader. */
  apicalBias: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /** Grammar-level droop seed; negative = upswept, positive = drooping. */
  droopBias: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([-0.2, 0.4]),
  }),

  /**
   * Weeping droop intensity applied in proportions.js; 0 = no-op, 1 = max pendulous.
   * Consumed by solveProportions — NOT returned by resolve(). Draw 38.
   */
  weep: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Cross-section flatness (oval squash) of branch tubes; 0 = no-op (circular), 1 = maximally flat.
   * Proportions tier — consumed by branchMesh.js (not yet wired). Draw 40.
   */
  flatness: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Woodiness: degree of lignification; 1.0 = fully woody (today's default), 0 = herbaceous.
   * Proportions tier — no consumer wired yet. Draw 43. IDENTITY DEFAULT = 1.0.
   */
  woodiness: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Tip tuft: apical leaf/spine concentration at branch tips; 0 = no-op, 1 = full tip tuft.
   * Proportions tier — no consumer wired yet. Draw 45. IDENTITY DEFAULT = 0.
   */
  tipTuft: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Phototropism scale: how strongly terminals rotate toward the sun direction.
   * 1.0 = full phototropism (today's default, identity). 0.0 = no sun-lean (fronds stay at
   * their skeleton azimuths — fixes the palm crown-gap). Draw 49.
   * IDENTITY DEFAULT = 1.0 → photoAngle unchanged → existing trees byte-identical.
   */
  phototropism: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Trunk-taper override: blends the trunk-only (branchLevel 0) per-segment taper
   * toward 1.0 (cylindrical). 0 = identity (current taper behaviour); 1 = perfectly
   * cylindrical trunk (top radius ≈ base radius). Draw 50.
   * IDENTITY DEFAULT = 0 → trunk radii byte-identical to pre-gene output.
   */
  trunkTaper: Object.freeze({
    tier: 'proportions',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  // -------------------------------------------------------------------------
  // COSMETIC TIER — surface detail
  // -------------------------------------------------------------------------

  /** Hue position along the biome colour ramp; 0 = cool end, 1 = warm end. */
  pigment: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /** Appendage (leaf/blade) scale multiplier. */
  leafSize: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.6, 1.6]),
  }),

  /** Appendage count / coverage per attachment site. */
  leafDensity: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.5, 1.5]),
  }),

  /** Positional noise applied to each attachment point. */
  jitter: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.5]),
  }),

  /**
   * Leaf lateral breadth: drives superformula n2+a to produce narrow blade (0) ↔ broad leaf (1).
   * Cosmetic only — affects leaf cluster texture, no skeleton impact. Draw 31.
   */
  leafWidth: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Leaf elongation via superformula axialStretch; 0 = short/round, 1 = long/lanceolate.
   * Cosmetic only — texture only. Draw 32.
   */
  leafLength: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Leaf tip sharpness via superformula n1; 0 = pointed/acuminate, 1 = rounded/obtuse.
   * Cosmetic only — texture only. Draw 33.
   */
  leafTip: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Leaf margin serration; 0 = smooth, 1 = toothed. Drives serration + serrationFreq.
   * Cosmetic only — texture only. Draw 34.
   */
  leafSerration: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Leaf lobing via superformula m; 0 = simple ovate (m≈2), 1 = palmate (m≈5).
   * Non-integer m morphs lobe count continuously. Cosmetic only — texture only. Draw 35.
   */
  leafLobing: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Bark base colour: 0 = white/cream (birch lenticels) → 1 = dark brown.
   * Cosmetic only — barkMaterial consumer. Draw 36.
   */
  barkColor: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Bark surface pattern: 0 = smooth + lenticels → 1 = deeply furrowed.
   * Cosmetic only — barkMaterial consumer. Draw 37.
   */
  barkPattern: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Needle-leaf morphology: 0 = no-op (broad leaf), 1 = needle-like leaf shape.
   * Cosmetic only — no consumer wired yet. Draw 46. IDENTITY DEFAULT = 0.
   */
  needleLeaf: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Leaf cluster scale multiplier; 1.0 = identity (no change), 3.0 = 3× scale.
   * Cosmetic only — no consumer wired yet. Draw 47. IDENTITY DEFAULT = 1.0.
   */
  leafScale: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([1.0, 3.0]),
  }),

  /**
   * Frond-leaf morphology: 0 = no-op (current broadleaf sprite), 1 = palm-frond leaf sprite.
   * Cosmetic only — no consumer wired yet. Draw 48. IDENTITY DEFAULT = 0.
   */
  frondLeaf: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Horizontal leaf-scar ring banding on palm trunks; 0 = no-op (identity — current bark),
   * 1 = fully visible ring bands. Cosmetic only — barkMaterial consumer. Draw 51.
   * IDENTITY DEFAULT = 0 → bark byte-identical to pre-gene output.
   */
  trunkRings: Object.freeze({
    tier: 'cosmetic',
    kind: 'continuous',
    range: Object.freeze([0.0, 1.0]),
  }),

  /**
   * Per-plant uint32 seed that drives fine-grained jitter / procedural detail.
   * Always re-derived in every child (see mutate.js draw schedule).
   */
  structuralSeed: Object.freeze({
    tier: 'cosmetic',
    kind: 'seed',
  }),

  // -------------------------------------------------------------------------
  // ROOT SYSTEM TIER — underground skeleton genes (structural, draws 24–30)
  // All range [0, 1]. Used by growRootSystem() in roots.js.
  // -------------------------------------------------------------------------

  /** Fractional count of major lateral roots; maps to floor(2+rootCount*4) full
   *  laterals + 1 crossfade lateral. */
  rootCount: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Taproot dive depth multiplier; aridity biases this upward. */
  rootDepth: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Radial reach of lateral roots before they curve downward. */
  rootSpread: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Above-ground trunk-base flare girth; wind biases this upward. */
  rootFlare: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Buttress wing prominence (0=none, 1=fig-like); wind biases upward. */
  rootButtress: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Fractional sub-branch depth 0..3; controls recursive root branching. */
  rootBranchiness: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),

  /** Root pipe-model taper aggressiveness; aridity biases this upward. */
  rootTaper: Object.freeze({
    tier: 'structural',
    kind: 'continuous',
    range: Object.freeze([0, 1]),
  }),
});

// ---------------------------------------------------------------------------
// Tier-partitioned field arrays — DERIVED from FLORA_SCHEMA (no hardcoded lists)
// ---------------------------------------------------------------------------

/** All field names with tier === 'structural'. */
export const STRUCTURAL_FIELDS = Object.freeze(
  Object.keys(FLORA_SCHEMA).filter(f => FLORA_SCHEMA[f].tier === 'structural')
);

/** All field names with tier === 'proportions'. */
export const PROPORTIONS_FIELDS = Object.freeze(
  Object.keys(FLORA_SCHEMA).filter(f => FLORA_SCHEMA[f].tier === 'proportions')
);

/** All field names with tier === 'cosmetic'. */
export const COSMETIC_FIELDS = Object.freeze(
  Object.keys(FLORA_SCHEMA).filter(f => FLORA_SCHEMA[f].tier === 'cosmetic')
);

// ---------------------------------------------------------------------------
// Tier weights used by genomeDistance
// ---------------------------------------------------------------------------

const TIER_WEIGHT = Object.freeze({
  structural:  3.0,
  proportions: 1.5,
  cosmetic:    0.5,
});

// ---------------------------------------------------------------------------
// clampField(schema, field, value) -> coerced value
// ---------------------------------------------------------------------------

/**
 * Coerce `value` into the valid domain for `field` as described by `schema`.
 *
 *   continuous  → clamp to [lo, hi].
 *   seed        → return value >>> 0  (coerce to uint32).
 *   unknown field → return value unchanged.
 */
export function clampField(schema, field, value) {
  const gene = schema[field];
  if (gene === undefined) return value;

  switch (gene.kind) {
    case 'continuous': {
      const [lo, hi] = gene.range;
      return value < lo ? lo : value > hi ? hi : value;
    }
    case 'seed': {
      return value >>> 0;
    }
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// genomeDistance(a, b, schema) -> number in [0, 1]
// ---------------------------------------------------------------------------

/**
 * Normalized, tier-weighted phenotypic distance between two genome objects.
 *
 * Per-field distance:
 *   continuous   → |a - b| / (hi - lo)
 *   seed         → SKIPPED (not a phenotype axis)
 *
 * Tier weights: structural ×3, proportions ×1.5, cosmetic ×0.5.
 *
 * Returns sum(weight * fieldDist) / sum(weights of fields actually compared).
 * Returns 0 if no comparable fields exist.
 */
export function genomeDistance(a, b, schema) {
  let weightedSum = 0;
  let weightTotal = 0;

  for (const field of Object.keys(schema)) {
    const gene = schema[field];

    // Seeds are not a phenotype axis — skip them entirely.
    if (gene.kind === 'seed') continue;

    const weight = TIER_WEIGHT[gene.tier] ?? 1.0;
    let fieldDist;

    switch (gene.kind) {
      case 'continuous': {
        const [lo, hi] = gene.range;
        const span = hi - lo;
        fieldDist = span === 0 ? 0 : Math.abs(a[field] - b[field]) / span;
        break;
      }
      default:
        continue;
    }

    weightedSum += weight * fieldDist;
    weightTotal += weight;
  }

  return weightTotal === 0 ? 0 : weightedSum / weightTotal;
}

// ---------------------------------------------------------------------------
// Future fauna hook
// ---------------------------------------------------------------------------

/** Future FaunaGenome schema hook; mutate() is genome-agnostic and will reuse it unchanged. */
export const FAUNA_SCHEMA_STUB = null;
