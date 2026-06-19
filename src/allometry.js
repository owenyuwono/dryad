// =============================================================================
// allometry.js — continuous scaling LAWS for the flora morphospace.
//
// This is NOT an archetype/type system. There is no "tree" or "conifer" concept
// here. It encodes the continuous physical relationships that make an organism's
// dimensions move together as a single morphological degree of freedom changes —
// the same way real biology obeys allometric power laws (girth ∝ height^~1.5,
// canopy leaf mass ∝ crown volume, etc.).
//
// Genes stay independent sliders. What this layer does is turn the ONE "size"
// slider (trunkHeight) into a coherent realized organism: a taller plant is also
// thicker, carries bigger/more foliage, and (for whorled stems) gains more tiers
// at roughly constant spacing — instead of stretching into a spindly reed.
//
// IDENTITY-CENTERED (load-bearing for determinism):
//   At trunkHeight=0.5 → sizeFactor === 1.0 → EVERY derived scale is exactly 1.0
//   (or its additive form 0), so a default-stature plant is byte-identical to the
//   pre-allometry pipeline. Couplings only diverge from identity as the size slider
//   moves meaningfully away from 0.5, so the golden-pinned default presets are
//   untouched.
//
// Pure ESM — no three.js, no rng. Deterministic: same genome → same traits.
// =============================================================================

// ---------------------------------------------------------------------------
// computeSizeFactor(trunkHeight) — the master vertical-stature multiplier.
//
// Single source of truth for the height factor (skeleton.js imports this instead
// of recomputing it). Piecewise so f(0.5) = exactly 1.0 (bit-exact identity):
//   [0,   0.5]: 0.45 + t*1.10           → f(0)=0.45, f(0.5)=1.00
//   [0.5, 1.0]: 10^(2*(t-0.5))          → f(0.5)=1.00, f(1)=10.0
// Monotonic on both halves; multiplied onto trunk height + branch lengths.
// ---------------------------------------------------------------------------
export function computeSizeFactor(trunkHeight = 0.5) {
  return trunkHeight <= 0.5
    ? 0.45 + trunkHeight * 1.10
    : Math.pow(10, 2 * (trunkHeight - 0.5));
}

// ---------------------------------------------------------------------------
// Allometric exponents (named, tunable). Each is chosen so sizeFactor=1 → 1.0.
// ---------------------------------------------------------------------------

// GIRTH_EXP: trunk/branch radius ∝ sizeFactor^GIRTH_EXP.
//   0    = DECOUPLED (current) — trunk HEIGHT and trunk WIDTH are independent axes:
//          trunkHeight changes only the bole's height, and girth is controlled solely
//          by the stemGirth gene (per user request). girthScale === 1 at every height.
//   1.0  = isometric (a tall plant is a uniformly scaled-up short one).
//   >1.0 = super-linear "bigger ⇒ stockier" (real D∝H^1.5), but reads as a baobab at
//          the top of the height slider.
// (Was 1.0 isometric → 1.3 → now 0: the user wants height and width decoupled.)
export const GIRTH_EXP = 0.0;

// LEAF_AREA_EXP: leaf-cluster card SIZE ∝ sizeFactor^LEAF_AREA_EXP. Sub-linear —
// a real leaf is roughly constant size, but a CLUSTER card is a clump of foliage,
// and letting clumps grow mildly with stature keeps a big crown reading as a solid
// volume instead of sparse confetti, within the instance budget.
export const LEAF_AREA_EXP = 0.5;

// TIER_EXP: whorl tier COUNT ∝ sizeFactor^TIER_EXP. <1 so spacing grows slowly:
// height ∝ sizeFactor^1, tiers ∝ sizeFactor^0.7 → inter-tier spacing ∝ sizeFactor^0.3
// (nearly constant), matching how a tall conifer stacks more whorls rather than
// stretching a fixed number apart.
export const TIER_EXP = 0.7;

// ROOT_EXP: root depth/spread/flare ∝ sizeFactor^ROOT_EXP — a bigger canopy needs
// a proportionally bigger anchor. Linear is a reasonable first law.
export const ROOT_EXP = 1.0;

// BRANCH_ORDER_GAIN: extra recursion levels added (or removed) per decade of size.
// branchOrderBonus = round(log10(sizeFactor) * GAIN). At sizeFactor=1 → 0 (identity),
// and it stays 0 for any near-default height (log10≈0 rounds to 0), so default
// presets keep their exact branch hierarchy; only markedly tall/short plants gain
// or shed branch generations — matching saplings (few orders) vs old trees (many).
export const BRANCH_ORDER_GAIN = 2.0;

// ---------------------------------------------------------------------------
// deriveTraits(genome, env) — realized coupled parameters for the pipeline.
//
// Returns scalars consumed by skeleton/proportions/foliage. All identity at
// sizeFactor=1. env is accepted for future env-coupled laws (unused today).
// ---------------------------------------------------------------------------
export function deriveTraits(genome = {}, env = undefined) {
  const sizeFactor = computeSizeFactor(genome.trunkHeight ?? 0.5);

  return {
    sizeFactor,
    // Radius multiplier (proportions.js): taller ⇒ thicker. 1.0 at sizeFactor=1.
    girthScale: Math.pow(sizeFactor, GIRTH_EXP),
    // Leaf-cluster card-size multiplier (foliage.js). 1.0 at sizeFactor=1.
    leafAreaScale: Math.pow(sizeFactor, LEAF_AREA_EXP),
    // Whorl tier-count multiplier (skeleton.js). 1.0 at sizeFactor=1.
    tierCountScale: Math.pow(sizeFactor, TIER_EXP),
    // Additive branch-recursion-depth bonus (skeleton.js). 0 at sizeFactor=1 and
    // for any near-default height (rounding). Can be negative for small plants.
    // `|| 0` normalizes Math.round's -0 (for tiny-negative inputs) to +0 so the
    // identity comparison in tests/consumers is exact.
    branchOrderBonus: Math.round(Math.log10(sizeFactor) * BRANCH_ORDER_GAIN) || 0,
    // Root-system size multiplier (roots.js). 1.0 at sizeFactor=1.
    rootScale: Math.pow(sizeFactor, ROOT_EXP),
  };
}
