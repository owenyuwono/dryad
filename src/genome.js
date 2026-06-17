// =============================================================================
// genome.js — FLORA genome layer (continuous morphospace)
//
// A genome is a flat object with one numeric gene per field in FLORA_SCHEMA.
// It is the single object passed to the render pipeline to produce all
// render-ready data for one plant specimen.
//
// CONTINUOUS MORPHOSPACE (No Man's Sky-style):
//   All genes are kind:'continuous' (float in [lo,hi]) except structuralSeed
//   which is kind:'seed' (uint32). The old categoricals (growthHabit/symmetry/
//   appendageKind) and integer step-genes are gone.
//
// RNG DRAW ORDER for randomGenome(env, seed):
//   Draws are consumed from mulberry32(seed) in a FIXED documented order.
//   Structural genes (7):
//     Draw 01: branchiness
//     Draw 02: branchFactorN
//     Draw 03: tillering
//     Draw 04: radialOrder
//     Draw 05: appendageBreadth
//     Draw 06: appendageDensity
//     Draw 07: segmentation
//   Proportions genes (11):
//     Draw 08: succulence
//     Draw 09: stemGirth
//     Draw 10: taper
//     Draw 11: rigidity
//     Draw 12: verticality
//     Draw 13: ribbing
//     Draw 14: spininess
//     Draw 15: branchAngle
//     Draw 16: lengthRatio
//     Draw 17: apicalBias
//     Draw 18: droopBias
//   Cosmetic genes (4 continuous + 1 seed):
//     Draw 19: pigment      (wide hue spread — full [0,1] range → full HSL hue wheel)
//     Draw 20: leafSize
//     Draw 21: leafDensity
//     Draw 22: jitter
//     Draw 23: structuralSeed  — (rng() * 2**32) >>> 0
//   Root system genes (7 structural, appended AFTER draw 23 — MUST stay last):
//     Draw 24: rootCount
//     Draw 25: rootDepth
//     Draw 26: rootSpread
//     Draw 27: rootFlare
//     Draw 28: rootButtress
//     Draw 29: rootBranchiness
//     Draw 30: rootTaper
//   Cosmetic extension (appended AFTER draw 30 — cosmetic/texture-only, no skeleton/foliage shift):
//     Draw 31: leafWidth
//     Draw 32: leafLength
//     Draw 33: leafTip
//     Draw 34: leafSerration
//     Draw 35: leafLobing
//   Bark + weep genes (appended AFTER draw 35 — no skeleton/foliage shift):
//     Draw 36: barkColor    (cosmetic — returned by resolve)
//     Draw 37: barkPattern  (cosmetic — returned by resolve)
//     Draw 38: weep         (proportions — NOT returned by resolve; consumed in proportions.js)
//
// NEUTRAL DEFAULTS (geneNeutral) — the sensible middling plant:
//   branchiness:      0.50   (moderate branching)
//   branchFactorN:    0.33   (≈2 children, moderate)
//   tillering:        0.10   (mostly single-stem)
//   radialOrder:      0.25   (slight radial lean)
//   appendageBreadth: 0.45   (narrow blade)
//   appendageDensity: 0.40   (moderate density)
//   segmentation:     0.20   (lightly segmented)
//   succulence:       0.20   (slightly fleshy)
//   stemGirth:        0.40   (moderate, leans thin)
//   taper:            0.50   (mid taper)
//   rigidity:         0.60   (fairly rigid)
//   verticality:      0.50   (erect — no rotation)
//   ribbing:          0.05   (almost smooth)
//   spininess:        0.05   (almost spineless)
//   branchAngle:      0.575  (mid of [0.35,0.80] ≈ 33°)
//   lengthRatio:      0.70   (mid of [0.55,0.85])
//   apicalBias:       0.50   (balanced leader/lateral)
//   droopBias:        0.10   (mild droop, mid of [-0.2,0.4])
//   pigment:          0.45   (on the full-hue wheel this is ~162° = blue-green; TREE_DEFAULT uses 0.33 for green)
//   leafSize:         1.10   (mid of [0.6,1.6])
//   leafDensity:      1.00   (mid of [0.5,1.5])
//   jitter:           1.00   (mid of [0,1.5])
//   leafWidth:        0.50   (mid of [0,1]; 0.5 = medium breadth via superformula)
//   leafLength:       0.45   (moderate elongation; maps to axialStretch≈2.35)
//   leafTip:          0.40   (slightly pointed; maps to n1≈1.24)
//   leafSerration:    0.00   (smooth margin by default)
//   leafLobing:       0.00   (simple ovate, m=2, no lobes)
//   barkColor:        0.85   (mid-brown bark; 0=white/cream birch, 1=dark brown)
//   barkPattern:      0.80   (mostly furrowed; 0=smooth+lenticels, 1=deeply furrowed)
//   weep:             0.00   (no weep droop — no-op at neutral)
//   structuralSeed:   derived from seed draw, not a neutral offset
//
// ENV→GENE BIAS TABLE (envOffset — default-centered):
//   Neutral env: gravity=1, medium='air', light=0.6, sunAngle=0.25,
//                wind=0.2, aridity=0.35, temperature=0.5
//   All offsets are 0 at the neutral env so only seedVariation applies.
//
//   aridity and temperature biases:
//     aridHeat = clamp((aridity - 0.35)/0.65 * 0.5 + (temp - 0.5)/0.5 * 0.5, -1, 1)
//     succulence  += +0.30 * aridHeat   (dry+hot → cactus)
//     spininess   += +0.20 * aridHeat
//     ribbing     += +0.15 * aridHeat
//     appendageBreadth -= 0.20 * aridHeat
//
//   medium === 'water':
//     appendageBreadth += +0.25   (wide fronds/kelp)
//     rigidity         -= 0.25   (buoyant, flexible)
//     verticality      += +0.15   (upright in current)
//     tillering        += +0.20   (holdfast clumping)
//
//   gravity (g, neutral=1):
//     gravDelta = clamp((gravity - 1) / 2, -0.5, 0.5)
//     stemGirth   += +0.20 * gravDelta   (heavy → thicker)
//     succulence  += +0.10 * gravDelta   (slight water storage)
//     branchiness -= 0.20 * gravDelta   (heavy → squat/fewer branches)
//
//   wind (w, neutral=0.2):
//     windDelta = clamp((wind - 0.2) / 0.8, 0, 1)
//     verticality      -= 0.25 * windDelta   (wind → low/prostrate)
//     rigidity         += +0.25 * windDelta   (streamlined/stiff)
//     appendageBreadth -= 0.20 * windDelta   (narrowed)
//
//   light (l, neutral=0.6):
//     lightDelta = clamp((0.6 - light) / 0.6, -1, 1)   (positive = dim)
//     branchiness      += +0.20 * lightDelta   (dim → more branches to catch light)
//     appendageBreadth += +0.20 * lightDelta   (dim → broader leaves)
//     appendageDensity += +0.15 * lightDelta   (dim → denser packing)
//
// SEED VARIATION (±spread, drawn in the fixed order above):
//   Most genes: ±0.12 of full range (small but visible variation)
//   pigment:    full [0,1] range (draw maps directly to [0,1])
//   jitter:     ±0.20 of range
//
// speciesColor → pigmentToColor (colorRamp.js, single source of truth):
//   Full HSL hue wheel — pigment 0→1 maps hue 0°→360° (S=0.55, L=0.42).
//
// Pure ESM — no three.js dependency.
// =============================================================================

import { mulberry32 }              from './rng.js';
import { buildSkeleton }           from './skeleton.js';
import { solveProportions }        from './proportions.js';
import { skin }                    from './skin.js';
import { FLORA_SCHEMA, clampField } from './genomeSchema.js';
import { generateFoliage }         from './foliage.js';
import { growRootSystem, ROOT_SALT } from './roots.js';
import { pigmentToColor }          from './colorRamp.js';

// ---------------------------------------------------------------------------
// Neutral gene vector (geneNeutral)
// ---------------------------------------------------------------------------
// These are the sensible "average plant" defaults. envOffset and seedVariation
// are added on top of these values before clamping.
// ---------------------------------------------------------------------------

const NEUTRAL = Object.freeze({
  // Structural
  branchiness:      0.50,
  branchFactorN:    0.33,
  tillering:        0.10,
  radialOrder:      0.25,
  appendageBreadth: 0.45,
  appendageDensity: 0.40,
  segmentation:     0.20,
  // Proportions
  succulence:       0.20,
  stemGirth:        0.40,
  taper:            0.50,
  rigidity:         0.60,
  verticality:      0.50,
  ribbing:          0.05,
  spininess:        0.05,
  branchAngle:      0.575,
  lengthRatio:      0.70,
  apicalBias:       0.50,
  droopBias:        0.10,
  // Cosmetic (pigment handled separately via seed draw)
  pigment:          0.45,
  leafSize:         1.10,
  leafDensity:      1.00,
  jitter:           1.00,
  leafWidth:        0.50,
  leafLength:       0.45,
  leafTip:          0.40,
  leafSerration:    0.00,
  leafLobing:       0.00,
  // Bark + weep (draws 36–38)
  // barkColor/barkPattern = 1.0 is the brown-furrowed IDENTITY (matches the
  // pre-gene bark exactly). Lower values lighten toward birch white / smooth +
  // lenticels — only the birch preset drives them down.
  barkColor:        1.00,
  barkPattern:      1.00,
  weep:             0.00,
  // trunkHeight (draw 39) — 0.5 = identity (1.0× scale factor, byte-identical to pre-gene)
  trunkHeight:      0.50,
  // Root system (draws 24–30)
  rootCount:        0.45,
  rootDepth:        0.45,
  rootSpread:       0.50,
  rootFlare:        0.30,
  rootButtress:     0.15,
  rootBranchiness:  0.45,
  rootTaper:        0.50,
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Clamp v to [lo, hi]. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Compute environment-driven gene offsets (envOffset).
 *
 * All offsets are 0 at the neutral environment:
 *   gravity=1, medium='air', light=0.6, sunAngle=0.25,
 *   wind=0.2, aridity=0.35, temperature=0.5
 *
 * Returns a partial object with only the genes that need offsetting.
 * Absent genes default to 0 in the caller.
 */
function computeEnvOffset(env) {
  const {
    gravity    = 1,
    medium     = 'air',
    light      = 0.6,
    wind       = 0.2,
    aridity    = 0.35,
    temperature = 0.5,
  } = env;

  const offset = {
    branchiness:      0,
    branchFactorN:    0,
    tillering:        0,
    radialOrder:      0,
    appendageBreadth: 0,
    appendageDensity: 0,
    segmentation:     0,
    succulence:       0,
    stemGirth:        0,
    taper:            0,
    rigidity:         0,
    verticality:      0,
    ribbing:          0,
    spininess:        0,
    branchAngle:      0,
    lengthRatio:      0,
    apicalBias:       0,
    droopBias:        0,
    pigment:          0,
    leafSize:         0,
    leafDensity:      0,
    jitter:           0,
    leafWidth:        0,
    leafLength:       0,
    leafTip:          0,
    leafSerration:    0,
    leafLobing:       0,
    // Root system offsets (0 at neutral env)
    rootCount:        0,
    rootDepth:        0,
    rootSpread:       0,
    rootFlare:        0,
    rootButtress:     0,
    rootBranchiness:  0,
    rootTaper:        0,
    // Bark + weep offsets (0 at neutral env)
    barkColor:        0,
    barkPattern:      0,
    weep:             medium === 'water' ? 0.05 : 0,
    // trunkHeight offset (0 at all envs — stature is seed-driven, not env-driven)
    trunkHeight:      0,
  };

  // --- aridity + temperature → dry/hot = cactus region ---
  // aridHeat: 0 at neutral (aridity=0.35, temp=0.5), range [-1, +1]
  const aridFrac = clamp((aridity - 0.35) / 0.65, -1, 1);
  const tempFrac = clamp((temperature - 0.5) / 0.5, -1, 1);
  const aridHeat = clamp(aridFrac * 0.5 + tempFrac * 0.5, -1, 1);

  offset.succulence       += 0.30 * aridHeat;
  offset.spininess        += 0.20 * aridHeat;
  offset.ribbing          += 0.15 * aridHeat;
  offset.appendageBreadth -= 0.20 * aridHeat;

  // --- medium === 'water' → kelp/holdfast ---
  if (medium === 'water') {
    offset.appendageBreadth += 0.25;
    offset.rigidity         -= 0.25;
    offset.verticality      += 0.15;
    offset.tillering        += 0.20;
  }

  // --- gravity → heavy-planet squat/thick ---
  // gravDelta: 0 at g=1, range [-0.5, +0.5]
  const gravDelta = clamp((gravity - 1) / 2, -0.5, 0.5);
  offset.stemGirth   += 0.20 * gravDelta;
  offset.succulence  += 0.10 * gravDelta;
  offset.branchiness -= 0.20 * gravDelta;

  // --- wind → low/streamlined ---
  // windDelta: 0 at wind=0.2, range [0, 1]
  const windDelta = clamp((wind - 0.2) / 0.8, 0, 1);
  offset.verticality      -= 0.25 * windDelta;
  offset.rigidity         += 0.25 * windDelta;
  offset.appendageBreadth -= 0.20 * windDelta;

  // --- light → dim = more branching/broader for capture ---
  // lightDelta: 0 at light=0.6, positive = dim
  const lightDelta = clamp((0.6 - light) / 0.6, -1, 1);
  offset.branchiness      += 0.20 * lightDelta;
  offset.appendageBreadth += 0.20 * lightDelta;
  offset.appendageDensity += 0.15 * lightDelta;

  // --- root system env biases ---
  // aridity → deeper taproot, more aggressive taper (desert tap-roots)
  offset.rootDepth += 0.30 * aridHeat;
  offset.rootTaper += 0.10 * aridHeat;

  // wind → wider flare and more buttressing for anchorage
  offset.rootFlare    += 0.30 * windDelta;
  offset.rootButtress += 0.20 * windDelta;

  // water / low-aridity wet → shallow plate roots (wide spread, shallow depth)
  if (medium === 'water' || aridity < 0.15) {
    offset.rootSpread += 0.20;
    offset.rootDepth  -= 0.20;
  }

  return offset;
}

/**
 * Draw seed variation for one gene.
 * spread is the half-width of the ±variation in [0,1] rng space.
 * Returns (draw - 0.5) * 2 * spread * rangeSpan.
 */
function seedVar(draw, spread, rangeSpan) {
  return (draw - 0.5) * 2 * spread * rangeSpan;
}

// ---------------------------------------------------------------------------
// randomGenome(env, seed) -> genome (flat object, all genes in FLORA_SCHEMA)
// ---------------------------------------------------------------------------

/**
 * Construct a random genome from a numeric seed and an environment envelope.
 *
 * Each gene is computed as:
 *   clampField(FLORA_SCHEMA, name, geneNeutral[name] + envOffset[name] + seedVariation(rng))
 *
 * The rng draws are consumed in the FIXED order documented at the top of this file.
 * Repeating with the same (env, seed) produces bit-identical output.
 *
 * Returns a plain (non-frozen) object with all FLORA_SCHEMA fields.
 */
export function randomGenome(env, seed) {
  const rng    = mulberry32(seed);
  const offset = computeEnvOffset(env);

  // Standard seed spread for most genes (±12% of range)
  const STD = 0.12;

  // Helper: build one continuous gene value
  function gene(name, spread) {
    const schema = FLORA_SCHEMA[name];
    const [lo, hi] = schema.range;
    const span  = hi - lo;
    const raw   = NEUTRAL[name] + offset[name] + seedVar(rng(), spread, span);
    return clampField(FLORA_SCHEMA, name, raw);
  }

  // --- Structural (draws 01–07) ---
  const branchiness      = gene('branchiness',      STD);
  const branchFactorN    = gene('branchFactorN',    STD);
  const tillering        = gene('tillering',        STD);
  const radialOrder      = gene('radialOrder',      STD);
  const appendageBreadth = gene('appendageBreadth', STD);
  const appendageDensity = gene('appendageDensity', STD);
  const segmentation     = gene('segmentation',     STD);

  // --- Proportions (draws 08–18) ---
  const succulence  = gene('succulence',  STD);
  const stemGirth   = gene('stemGirth',   STD);
  const taper       = gene('taper',       STD);
  const rigidity    = gene('rigidity',    STD);
  const verticality = gene('verticality', STD);
  const ribbing     = gene('ribbing',     STD);
  const spininess   = gene('spininess',   STD);
  const branchAngle = gene('branchAngle', STD);
  const lengthRatio = gene('lengthRatio', STD);
  const apicalBias  = gene('apicalBias',  STD);
  const droopBias   = gene('droopBias',   STD);

  // --- Cosmetic (draws 19–22 continuous, 23 seed) ---
  // pigment: wide hue spread across the full [0,1] range (maps draw directly)
  const pigment     = clampField(FLORA_SCHEMA, 'pigment',     rng());               // draw 19
  const leafSize    = gene('leafSize',    0.20);                                    // draw 20
  const leafDensity = gene('leafDensity', STD);                                     // draw 21
  const jitter      = gene('jitter',      0.20);                                    // draw 22

  // structuralSeed: always a fresh uint32 from the rng (draw 23)
  const structuralSeed = (rng() * 2 ** 32) >>> 0;                                  // draw 23

  // --- Root system genes (draws 24–30) ---
  // DETERMINISM-CRITICAL: these draws MUST be appended after draw 23 (structuralSeed).
  // Adding them here preserves draws 01–23 unchanged for all existing seeds.
  const rootCount       = gene('rootCount',       STD);   // draw 24
  const rootDepth       = gene('rootDepth',       STD);   // draw 25
  const rootSpread      = gene('rootSpread',      STD);   // draw 26
  const rootFlare       = gene('rootFlare',       STD);   // draw 27
  const rootButtress    = gene('rootButtress',    STD);   // draw 28
  const rootBranchiness = gene('rootBranchiness', STD);   // draw 29
  const rootTaper       = gene('rootTaper',       STD);   // draw 30

  // --- Cosmetic extension (draws 31–35) ---
  // DETERMINISM-CRITICAL: these draws are appended LAST, after draw 30 (rootTaper).
  // This keeps draws 01–30 untouched — existing seeds' skeleton, foliage, and all
  // other genes remain byte-identical. These genes only affect the leaf texture.
  const leafWidth     = gene('leafWidth',     STD);       // draw 31
  const leafLength    = gene('leafLength',    STD);       // draw 32
  const leafTip       = gene('leafTip',       STD);       // draw 33
  const leafSerration = gene('leafSerration', STD);       // draw 34
  const leafLobing    = gene('leafLobing',    STD);       // draw 35

  // --- Bark + weep genes (draws 36–38) ---
  // DETERMINISM-CRITICAL: appended AFTER draw 35 (leafLobing). Draws 01–35 are untouched.
  const barkColor   = gene('barkColor',   STD);           // draw 36
  const barkPattern = gene('barkPattern', STD);           // draw 37
  const weep        = gene('weep',        STD);           // draw 38

  // --- trunkHeight gene (draw 39) ---
  // DETERMINISM-CRITICAL: appended AFTER draw 38 (weep). Draws 01–38 are untouched.
  // At neutral (0.5) the skeleton scale factor is exactly 1.0 → byte-identical output.
  const trunkHeight = gene('trunkHeight', STD);           // draw 39

  return {
    // Structural
    branchiness,
    branchFactorN,
    tillering,
    radialOrder,
    appendageBreadth,
    appendageDensity,
    segmentation,
    // Proportions
    succulence,
    stemGirth,
    taper,
    rigidity,
    verticality,
    ribbing,
    spininess,
    branchAngle,
    lengthRatio,
    apicalBias,
    droopBias,
    // Cosmetic
    pigment,
    leafSize,
    leafDensity,
    jitter,
    leafWidth,
    leafLength,
    leafTip,
    leafSerration,
    leafLobing,
    barkColor,
    barkPattern,
    weep,
    trunkHeight,
    structuralSeed,
    // Root system
    rootCount,
    rootDepth,
    rootSpread,
    rootFlare,
    rootButtress,
    rootBranchiness,
    rootTaper,
  };
}

// ---------------------------------------------------------------------------
// resolve(genome, env) -> render data  [PURE]
// ---------------------------------------------------------------------------

/**
 * Pure render-data pipeline from a genome + environment envelope.
 *
 * Determinism contract:
 *   - Structural jitter uses mulberry32(genome.structuralSeed), a fresh rng
 *     created here each call. No shared mutable state is read or written.
 *   - solveProportions mutates the graph in-place, but the graph is created
 *     fresh every call, so repeated calls on the same (genome, env) pair
 *     produce deep-equal output.
 *
 * Returns:
 *   { boneAData, boneBData, boneFlatData, boneCount, blendK, materialMode,
 *     uRibbing, uSpininess, uSegmentation,
 *     pigment, leafSize, leafDensity, lightDir, lightFlux }
 */
export function resolve(genome, env) {
  // Fresh rng seeded from genome — never touches external state.
  const rng = mulberry32(genome.structuralSeed);

  // Build skeleton: genome supplies all structural genes + jitter amplitude.
  const graph = buildSkeleton(genome, rng, genome.jitter);

  // Grow root system: isolated sub-stream (ROOT_SALT XOR) so skeleton rng is
  // untouched and canopy/foliage stay byte-identical to pre-roots output.
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng, { env });

  // Solve proportions in-place (deterministic given same inputs).
  // Pass genome so genome genes (succulence, stemGirth, etc.) are applied.
  solveProportions(graph, env, genome);

  // Skin — genome supplies appendageBreadth, leafSize, leafDensity;
  // skinData already includes uRibbing, uSpininess, uSegmentation.
  const skinData = skin(graph, env, genome);

  // Foliage: leaf-card instance set, separate from the SDF bone budget.
  // Uses its own deterministic RNG stream seeded from structuralSeed ^ 0x1EAF1EAF.
  const foliage = generateFoliage(graph, genome);

  return {
    ...skinData,
    // boneCount: the REAL branch count from the skeleton graph, not the legacy
    // skin-capped value. skin.js still caps its own arrays at 64 for the SDF
    // shader (which no longer renders — mesh pipeline), but the stats panel and
    // any caller that wants the actual bone count should use graph.bones.length.
    boneCount:   graph.bones.length,
    graph,
    // The source genome, so render-side consumers (e.g. the viewer's leaf→bone
    // wind join, which re-generates foliage with the geometry's nodeToBone map)
    // can reach it without main.js re-threading it.
    genome,
    lightDir:    graph.meta.lightDir,
    pigment:     genome.pigment,
    leafSize:    genome.leafSize,
    leafDensity: genome.leafDensity,
    leafWidth:     genome.leafWidth,
    leafLength:    genome.leafLength,
    leafTip:       genome.leafTip,
    leafSerration: genome.leafSerration,
    leafLobing:    genome.leafLobing,
    barkColor:     genome.barkColor,
    barkPattern:   genome.barkPattern,
    lightFlux:   env.light,
    foliage,
    woodiness:   Math.max(0, Math.min(1, 1 - genome.succulence)),
  };
}

// ---------------------------------------------------------------------------
// speciesColor(genome) -> CSS color string  [single source of truth]
// ---------------------------------------------------------------------------

/**
 * Map genome.pigment ∈ [0, 1] to a CSS rgb() color string.
 *
 * Delegates to pigmentToColor (colorRamp.js) — the single source of truth
 * for the pigment→color mapping. UI swatches and leaf textures share the
 * same color at any pigment value.
 *
 * Full hue sweep: pigment 0→1 sweeps hue 0°→360° (HSL, S=0.55, L=0.42).
 */
export function speciesColor(genome) {
  const [r, g, b] = pigmentToColor(genome.pigment);
  const ri = Math.round(r * 255);
  const gi = Math.round(g * 255);
  const bi = Math.round(b * 255);
  return `rgb(${ri},${gi},${bi})`;
}
