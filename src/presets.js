// =============================================================================
// presets.js — hand-authored gene-vector "bookmarks" in the continuous morphospace
//
// Each preset is a named starting point, NOT a discrete plant type.
// They are regions of the same continuous morphospace — the user can tweak any
// slider or hit Generate after loading one.
//
// Construction: { ...TREE_DEFAULT, ...overrides, structuralSeed: <distinct uint32> }
// This guarantees every FLORA_SCHEMA gene is present (no missing field → no NaN).
// Distinct structuralSeed per preset gives each its own consistent "hero" look;
// the reroll button generates new individuals of the same form.
// =============================================================================

// ---------------------------------------------------------------------------
// TREE_DEFAULT — deciduous tree; solid trunk + rounded densely-branched crown.
//
// Key tuning goals:
//   TRUNK:  segmentation=0.35 → 6–7 trunk segments; clear tall leader.
//   DENSE:  branchFactorN=0.65 → ~2.95 children per node; crown fills broadly.
//   ROUND:  branchAngle=0.60 → branches spread at ~43°; rounded dome silhouette.
//   COMPACT: lengthRatio=0.70 → crown fills densely rather than whippy far arms.
//   FOLIAGE: appendageDensity=0.90 → dense leaf clusters on twig tips.
//
// tillering=0 → exactly one trunk (no basal tillering).
// ribbing=0   → perfectly round trunk (ribbing is now live on the mesh; real
//               trunks are not fluted — bark relief comes from the shader).
// ---------------------------------------------------------------------------
export const TREE_DEFAULT = {
  branchiness:      0.92,  // fractDepth=6.44 → maxDepth=6 (fine twigs at levels 5-6)
  branchFactorN:    0.65,  // ~2.95 children per node → crown fills broadly at every level
  tillering:        0.00,  // pinned to 0: exactly one trunk for a tree
  radialOrder:      0.55,
  appendageBreadth: 0.45,
  appendageDensity: 0.90,  // dense foliage on twig tips
  segmentation:     0.35,  // ~6 trunk segments → tall clear trunk
  succulence:       0.12,
  stemGirth:        0.68,
  taper:            0.72,
  rigidity:         0.40,
  verticality:      0.50,
  ribbing:          0.00,  // smooth round trunk — real trunks aren't fluted; bark detail from shader
  spininess:        0.00,
  branchAngle:      0.60,  // moderate spread → rounded crown, not flat fan
  lengthRatio:      0.70,  // faster taper → compact proportionate crown, not whippy
  apicalBias:       0.75,  // strong apical dominance keeps clear trunk leader
  droopBias:        0.00,  // identity (0) = no droop; was inert, now wired
  pigment:          0.33,  // hue≈120° on the full-hue wheel → leaf green
  leafSize:         1.00,
  leafDensity:      1.10,
  jitter:           1.00,
  leafWidth:        0.50,  // 0.5 = medium breadth via superformula
  leafLength:       0.45,
  leafTip:          0.40,
  leafSerration:    0.00,
  leafLobing:       0.00,
  structuralSeed:   1337,
  // Root system defaults
  rootCount:        0.50,  // ~4 major laterals — good oak/beech spread
  rootDepth:        0.40,  // moderate taproot
  rootSpread:       0.55,  // medium radial reach
  rootFlare:        0.35,  // visible but subtle trunk flare
  rootButtress:     0.10,  // minimal buttressing
  rootBranchiness:  0.45,  // moderate sub-root branching
  rootTaper:        0.50,  // neutral taper
  // Bark + weep genes (draws 36–38)
  barkColor:        1.00,  // brown bark (1.0 = furrowed-brown identity)
  barkPattern:      1.00,  // deep furrows (identity)
  weep:             0.00,  // no pendulous droop
  // trunkHeight (draw 39) — 0.50 = identity (1.0× factor)
  trunkHeight:      0.50,
  // Live surface + structure genes (draws 40–42) — 0 = strict no-op
  flatness:         0.00,
  stemSpread:       0.00,
  rosette:          0.00,
  // New inert genes (draws 43–45) — identity defaults, no consumer wired yet
  woodiness:        1.00,  // 1.0 = fully woody identity (no-op)
  whorl:            0.00,  // 0 = no whorled branching (no-op)
  tipTuft:          0.00,  // 0 = no tip tuft (no-op)
  // New inert genes (draws 46–48) — identity defaults, no consumer wired yet
  needleLeaf:       0.00,  // 0 = broad leaf (no-op)
  leafScale:        1.00,  // 1.0 = no scaling (identity)
  frondLeaf:        0.00,  // 0 = broadleaf sprite (no-op)
  // phototropism (draw 49) — 1.0 = full sun-lean (identity, existing trees unchanged)
  phototropism:     1.00,
  // trunkTaper (draw 50) — 0 = identity (trunk taper unchanged)
  trunkTaper:       0.00,
  // trunkRings (draw 51) — 0 = identity (no ring banding, bark byte-identical)
  trunkRings:       0.00,
};

// ---------------------------------------------------------------------------
// PRESETS — ordered array of { id, label, category, experimental, genome }.
// Hand-authored starting points; tune values via the sliders after loading.
//
// category ∈ {"Broadleaf","Weeping","Columnar","Conifer","Tropical","Shrub",
//              "Succulent","Grass","Fern","Aquatic","Other"}
// experimental: false for all production-quality presets.
// ---------------------------------------------------------------------------
export const PRESETS = [

  // ── Broadleaf ─────────────────────────────────────────────────────────────

  // Default deciduous broadleaf — rounded crown, single dominant trunk.
  {
    id:           'tree',
    label:        'Tree',
    category:     'Broadleaf',
    experimental: false,
    genome: { ...TREE_DEFAULT },
  },

  // Oak — broad spreading crown, low branch angles, robust trunk.
  {
    id:           'oak',
    label:        'Oak',
    category:     'Broadleaf',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.85,
      branchFactorN:    0.62,
      tillering:        0.00,
      branchAngle:      0.72,  // wide spreading branches
      apicalBias:       0.55,  // moderate leader → broad dome, not spire
      droopBias:        0.00,  // reset to identity (was inert 0.05)
      stemGirth:        0.80,  // thick robust limbs
      taper:            0.65,
      rigidity:         0.60,  // stiff woody
      lengthRatio:      0.65,  // compact crown
      leafLobing:       0.45,  // slightly lobed — oakish silhouette
      leafSerration:    0.10,
      leafWidth:        0.60,
      leafLength:       0.50,
      leafTip:          0.55,
      leafSize:         1.10,
      leafDensity:      1.15,
      pigment:          0.30,  // dark forest green
      trunkHeight:      0.5146918888426049,  // re-tuned: reproduces prior 0.55 factor (1.07) under new 10^(2*(th-0.5)) mapping
      rootCount:        0.60,
      rootSpread:       0.70,
      rootFlare:        0.45,
      rootButtress:     0.20,
      barkColor:        0.90,  // dark brown furrowed bark
      barkPattern:      0.90,
      structuralSeed:   0x4C2F7A11 >>> 0,
    },
  },

  // Maple — broad rounded crown; palmate deeply-lobed serrated leaves.
  {
    id:           'maple',
    label:        'Maple',
    category:     'Broadleaf',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.60,
      branchFactorN:    0.60,
      tillering:        0.00,
      branchAngle:      0.75,  // spreading canopy
      apicalBias:       0.45,  // less dominant leader → broad dome
      droopBias:        0.00,  // reset to identity (was inert 0.05)
      leafLobing:       0.85,  // palmate / maple-leaf lobing
      leafSerration:    0.35,  // serrated margins
      leafWidth:        0.70,  // broad leaf
      leafLength:       0.40,  // relatively short, wide
      leafTip:          0.60,
      leafSize:         1.10,
      pigment:          0.35,  // rich leaf green
      trunkHeight:      0.50,
      structuralSeed:   0xA1B2C3D4 >>> 0,
    },
  },

  // Beech — tall straight trunk, high smooth-ish bark, ovate serrated leaves.
  {
    id:           'beech',
    label:        'Beech',
    category:     'Broadleaf',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.75,
      branchFactorN:    0.58,
      tillering:        0.00,
      branchAngle:      0.65,
      apicalBias:       0.70,  // tall straight leader
      droopBias:        0.00,  // reset to identity (was inert 0.08)
      rigidity:         0.55,
      stemGirth:        0.72,
      taper:            0.68,
      segmentation:     0.30,
      leafLobing:       0.05,  // nearly simple ovate
      leafSerration:    0.25,  // mildly serrated
      leafWidth:        0.55,
      leafLength:       0.50,
      leafTip:          0.45,
      leafSize:         1.00,
      leafDensity:      1.20,
      pigment:          0.31,
      barkColor:        0.75,  // silver-grey smooth beech bark
      barkPattern:      0.35,  // smoother than oak, some texture
      trunkHeight:      0.5337214213881903,  // re-tuned: reproduces prior 0.62 factor under new mapping (tall)
      rootFlare:        0.30,
      rootSpread:       0.60,
      structuralSeed:   0x1D3A7F52 >>> 0,
    },
  },

  // Birch — slender columnar; fine pendulous twigs; white bark; small serrated leaves.
  {
    id:           'birch',
    label:        'Birch',
    category:     'Broadleaf',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.55,
      branchFactorN:    0.50,
      tillering:        0.00,
      verticality:      0.70,  // upright, columnar
      stemGirth:        0.30,  // slender stems
      taper:            0.80,  // strong taper to fine tips
      droopBias:        0.00,  // reset to identity (was inert 0.30)
      rigidity:         0.35,
      branchAngle:      0.55,
      apicalBias:       0.65,
      leafDensity:      1.45,
      leafSize:         0.85,
      leafSerration:    0.50,
      leafWidth:        0.45,
      leafLength:       0.45,
      leafLobing:       0.00,
      leafTip:          0.35,
      pigment:          0.30,
      barkColor:        0.05,  // pale white/cream — classic birch bark
      barkPattern:      0.10,  // smooth with lenticels
      trunkHeight:      0.5146918888426049,  // re-tuned: reproduces prior 0.55 factor (1.07) under new mapping
      structuralSeed:   0x7F3A1E05 >>> 0,
    },
  },

  // Elm — vase-shaped; arching branches, serrated ovate leaves.
  {
    id:           'elm',
    label:        'Elm',
    category:     'Broadleaf',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.78,
      branchFactorN:    0.63,
      tillering:        0.00,
      branchAngle:      0.68,
      apicalBias:       0.60,
      droopBias:        0.00,  // reset to identity (was inert 0.20)
      rigidity:         0.45,
      stemGirth:        0.62,
      taper:            0.70,
      lengthRatio:      0.72,
      verticality:      0.55,
      leafLobing:       0.10,
      leafSerration:    0.55,  // distinctly serrated elm leaf
      leafWidth:        0.50,
      leafLength:       0.55,
      leafTip:          0.50,
      leafSize:         0.95,
      leafDensity:      1.20,
      pigment:          0.32,
      trunkHeight:      0.5230523936230194,  // re-tuned: reproduces prior 0.58 factor under new mapping
      barkColor:        0.85,
      barkPattern:      0.80,
      structuralSeed:   0x6B4E3C28 >>> 0,
    },
  },

  // ── Weeping ────────────────────────────────────────────────────────────────

  // Weeping Willow — long hanging lanceolate leaves, full curtain cascade.
  // weep=0.55 → sqrt(0.55)≈0.74 effective leaf-hang (concave curve in foliage.js),
  // giving strong downward leaf orientation while branch droop stays moderate.
  // Leaves: very long (leafLength=0.95), narrow (leafWidth=0.18), large & dense curtain.
  {
    id:           'weeping',
    label:        'Weeping Willow',
    category:     'Weeping',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.68,  // enough crown volume for a full weeping head
      branchFactorN:    0.58,
      tillering:        0.00,
      verticality:      0.65,  // upright trunk base; branches fall from a high crown
      rigidity:         0.25,  // flexible, whippy stems
      droopBias:        0.00,  // reset to identity (was inert 0.28); willow droop comes from weep
      apicalBias:       0.50,
      branchAngle:      0.55,  // branches launch upward before falling
      lengthRatio:      0.80,  // long whippy branches — cascade reach
      taper:            0.80,  // tips thin out → fine hair-like ends
      stemGirth:        0.40,
      leafWidth:        0.18,  // very narrow — true lanceolate willow leaf
      leafLength:       0.95,  // near-maximum elongation for pendant look
      leafTip:          0.80,  // sharp pointed tip
      leafSerration:    0.20,  // slight serration
      leafLobing:       0.00,
      leafSize:         1.20,  // larger clusters → full hanging curtain
      leafDensity:      1.35,  // dense curtain of foliage
      pigment:          0.34,  // fresh willow green
      rootCount:        0.55,
      rootSpread:       0.65,  // willows spread wide for water
      weep:             0.55,  // sqrt(0.55)≈0.74 effective hang — strong leaf fall
      trunkHeight:      0.5413926851582250,  // re-tuned: reproduces prior 0.65 factor (tall — high crown from which branches cascade)
      barkColor:        0.80,
      barkPattern:      0.65,
      structuralSeed:   0xE5D2A0F7 >>> 0,
    },
  },

  // Weeping Cherry — shorter, more delicate; light drooping boughs.
  {
    id:           'weeping-cherry',
    label:        'Weeping Cherry',
    category:     'Weeping',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.60,
      branchFactorN:    0.55,
      tillering:        0.00,
      verticality:      0.60,
      rigidity:         0.30,
      droopBias:        0.00,  // reset to identity (was inert 0.22); droop comes from weep
      apicalBias:       0.48,
      branchAngle:      0.58,
      lengthRatio:      0.78,
      taper:            0.75,
      stemGirth:        0.35,
      leafWidth:        0.40,
      leafLength:       0.55,
      leafTip:          0.65,
      leafSerration:    0.40,
      leafLobing:       0.00,
      leafSize:         0.85,
      leafDensity:      1.15,
      pigment:          0.36,  // greener spring foliage
      weep:             0.30,  // gentler droop than willow
      trunkHeight:      0.5059965573296284,  // re-tuned: reproduces prior 0.52 factor under new mapping
      barkColor:        0.70,
      barkPattern:      0.50,  // smooth reddish cherry bark
      rootSpread:       0.50,
      structuralSeed:   0x3B9F1D77 >>> 0,
    },
  },

  // ── Columnar ──────────────────────────────────────────────────────────────

  // Lombardy Poplar / Columnar cypress — narrow spire, high verticality, tall.
  {
    id:           'lombardy',
    label:        'Lombardy Poplar',
    category:     'Columnar',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.72,
      branchFactorN:    0.55,
      tillering:        0.00,
      verticality:      0.85,  // KEY: strongly upright, all branches point up
      branchAngle:      0.38,  // very tight angle — near-vertical branches
      apicalBias:       0.90,  // dominant central leader, minimal lateral spread
      droopBias:        0.00,  // reset to identity (was inert -0.05)
      rigidity:         0.70,
      stemGirth:        0.50,
      taper:            0.75,
      lengthRatio:      0.65,  // short branches → narrow column
      leafWidth:        0.40,
      leafLength:       0.55,
      leafTip:          0.55,
      leafSerration:    0.15,
      leafLobing:       0.00,
      leafSize:         0.85,
      leafDensity:      1.25,
      pigment:          0.32,
      trunkHeight:      0.5761441721915282,  // re-tuned: reproduces prior 0.80 factor (tall spire) under new mapping
      barkColor:        0.85,
      barkPattern:      0.75,
      rootFlare:        0.20,
      rootSpread:       0.40,  // narrow deep roots for a columnar tree
      structuralSeed:   0xC7A3F209 >>> 0,
    },
  },

  // ── Conifer ────────────────────────────────────────────────────────────────

  // Spruce — strong apical dominance, downswept boughs, dense conifer crown.
  // leafWidth raised to 0.30 so needle-spray cards are visible (was 0.08 → invisible);
  // leafSize/leafDensity boosted substantially for a SOLID dense needle mass.
  // tipTuft raised so foliage covers the tier branches, not just their tips.
  {
    id:           'spruce',
    label:        'Spruce',
    category:     'Conifer',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.82,
      branchFactorN:    0.72,
      tillering:        0.00,
      branchAngle:      0.52,  // tight angle — narrow spire silhouette
      apicalBias:       0.90,  // strong apical dominance → clear spire
      droopBias:        0.00,  // reset to identity (was inert 0.20)
      rigidity:         0.72,
      verticality:      0.74,
      stemGirth:        0.55,
      taper:            0.78,
      lengthRatio:      0.65,
      appendageBreadth: 0.20,  // wider than needle to be visible as spray
      appendageDensity: 0.95,
      leafWidth:        0.18,  // narrow needle-sprig cards — mass comes from leafDensity, not card width
      leafLength:       0.70,  // moderately elongated needle
      leafTip:          0.15,  // sharp pointed tip
      leafSerration:    0.00,
      leafLobing:       0.00,
      leafSize:         1.50,  // larger clusters → denser reading solid mass (was 1.10; max is 1.6)
      leafDensity:      1.50,  // at schema maximum — fills into a solid conifer crown (was 1.40; range [0.5, 1.5])
      pigment:          0.27,  // deep conifer green
      barkColor:        0.85,
      barkPattern:      0.88,  // rough scaly conifer bark
      trunkHeight:      0.70,  // taller conifer per user (~2.51× under new 10^(2*(th-0.5)) mapping)
      rootDepth:        0.55,
      rootSpread:       0.50,
      tipTuft:          0.65,  // raised: foliage covers tier branches not just tips (was 0.40)
      whorl:            0.35,  // subtle tiering — spruce is denser/more continuous than pine
      needleLeaf:       1.00,  // full needle-fascicle sprite for conifer foliage
      structuralSeed:   0x5E8A4D32 >>> 0,
    },
  },

  // Pine — tall bare lower trunk with tiered whorled branches and needle tufts at tips.
  // Distinct from spruce: whorled branching (whorl=0.65, core BFS emission), tip needle tufts,
  // sparser branching so whorls dominate, level/upswept boughs (droopBias≈0.05), tall bare trunk.
  // leafDensity/leafSize raised substantially so the upper crown reads as a solid needle mass.
  {
    id:           'pine',
    label:        'Pine',
    category:     'Conifer',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.55,  // sparse — open crown, whorls read clearly
      branchFactorN:    0.48,  // fewer children per node; whorled tiers dominate
      tillering:        0.00,
      branchAngle:      0.50,  // ascending branches → open umbrella crown at top
      apicalBias:       0.95,  // near-maximum dominance → bare lower trunk
      droopBias:        0.00,  // reset to identity (was inert 0.05)
      rigidity:         0.78,  // stiff woody branches
      verticality:      0.70,
      stemGirth:        0.60,  // stout trunk
      taper:            0.75,
      lengthRatio:      0.72,  // slightly longer arms → open crown
      appendageBreadth: 0.20,
      appendageDensity: 0.95,  // raised to match denser canopy intent (was 0.92)
      leafWidth:        0.16,  // narrow needle-sprig cards — mass comes from leafDensity, not card width
      leafLength:       0.65,
      leafTip:          0.12,  // very sharp tip
      leafSerration:    0.00,
      leafLobing:       0.00,
      leafSize:         1.40,  // larger clusters → solid needle mass at branch ends (was 1.15)
      leafDensity:      1.50,  // substantially denser — fills upper crown into solid mass (was 1.30)
      pigment:          0.26,  // slightly darker/blue-green than spruce
      barkColor:        0.80,
      barkPattern:      0.92,  // deeply plated pine bark
      trunkHeight:      0.72,  // taller conifer per user (~2.75× under new 10^(2*(th-0.5)) mapping); bare trunk prominent; whorl=0.65 → startFrac≈0.358 of trunk
      rootDepth:        0.60,
      rootSpread:       0.55,
      rootFlare:        0.25,
      whorl:            0.65,  // KEY: distinct tiered whorled branch levels (core-emission BFS; was 0.58 additive post-pass)
      tipTuft:          0.55,  // raised: foliage covers branch length not just tip pompoms (was 0.32)
      needleLeaf:       1.00,  // full needle-fascicle sprite for conifer foliage
      structuralSeed:   0x3A1CF890 >>> 0,
    },
  },

  // ── Tropical ──────────────────────────────────────────────────────────────

  // Palm — tall bare trunk with an apical rosette of large arching pinnate fronds.
  // rosette drives the frond crown at the apex; high apicalBias keeps the bare pole.
  // Fuller crown: rosette=1.00 (12 fronds, ROSETTE_MAX), leafSize at schema max,
  // leafDensity raised for denser frond foliage, appendageDensity at max.
  {
    id:           'palm',
    label:        'Palm',
    category:     'Tropical',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.12,  // minimal branching — single crown pole
      branchFactorN:    0.28,
      tillering:        0.00,
      rosette:          1.00,  // KEY: maximum frond count (12 = ROSETTE_MAX) — fullest possible crown
      branchAngle:      0.70,  // fronds spread wide from the apex
      apicalBias:       0.95,  // single dominant leader — bare pole trunk
      droopBias:        0.00,  // reset to identity (was inert 0.28)
      rigidity:         0.55,
      stemGirth:        0.55,  // slim but not skeletal
      taper:            0.30,  // less extreme taper gene; trunkTaper takes over
      succulence:       0.30,  // slim trunk; trunkTaper handles cylindrical now
      segmentation:     0.70,  // ring-segmented leaf-scar trunk texture
      appendageBreadth: 0.78,  // broad lamina fronds
      appendageDensity: 1.00,  // schema max — densest frond attachments along crown
      leafWidth:        0.90,  // very broad pinnate frond
      leafLength:       0.95,  // long arching frond
      leafTip:          0.32,
      leafSerration:    0.05,
      leafLobing:       0.58,  // pinnate frond split — palm character
      leafSize:         1.60,  // schema max — largest possible frond clusters
      leafDensity:      1.35,  // raised from 1.10 for fuller frond mass per direction
      pigment:          0.36,  // bright tropical green
      trunkHeight:      0.90,  // taller bare trunk
      barkColor:        0.65,  // grey-brown palm trunk
      barkPattern:      0.20,  // smooth column — palm trunks are not deeply furrowed
      rootFlare:        0.12,
      rootButtress:     0.05,
      rootSpread:       0.45,
      rootDepth:        0.55,
      leafScale:        2.00,  // big fronds — large arching pinnate leaves
      frondLeaf:        1.00,  // KEY: palm-frond sprite (pinnate frond shape)
      phototropism:     0.00,  // KEY: no sun-lean — fronds keep full-circle skeleton azimuths (fixes crown gap)
      trunkTaper:       0.85,  // KEY: near-cylindrical trunk — trunkTaper now owns the columnar look
      trunkRings:       0.50,  // visible leaf-scar ring banding — the defining palm trunk feature
      structuralSeed:   0xB3F2C851 >>> 0,
    },
  },

  // Tropical broadleaf — dense canopy, big leaves, low fork trunk.
  {
    id:           'tropical',
    label:        'Tropical Tree',
    category:     'Tropical',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.65,
      branchFactorN:    0.65,
      tillering:        0.05,
      branchAngle:      0.68,
      apicalBias:       0.50,  // low fork, spreading crown
      droopBias:        0.00,  // reset to identity (was inert 0.15)
      rigidity:         0.50,
      stemGirth:        0.78,
      taper:            0.60,
      appendageBreadth: 0.70,
      leafWidth:        0.80,
      leafLength:       0.75,
      leafTip:          0.40,
      leafSerration:    0.05,
      leafLobing:       0.20,
      leafSize:         1.40,  // large tropical leaves
      leafDensity:      1.00,
      pigment:          0.37,  // vivid tropical green
      trunkHeight:      0.5337214213881903,  // re-tuned: reproduces prior 0.62 factor under new mapping
      barkColor:        0.70,
      barkPattern:      0.55,
      rootFlare:        0.40,
      rootButtress:     0.30,
      rootSpread:       0.65,
      leafScale:        1.60,  // big tropical leaves
      structuralSeed:   0xF2A8340B >>> 0,
    },
  },

  // Banana — very large broad leaves, short trunk, few mega-fronds.
  {
    id:           'banana',
    label:        'Banana',
    category:     'Tropical',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.10,  // minimal branching — single pseudostem
      branchFactorN:    0.25,
      tillering:        0.15,  // occasional basal pup
      rosette:          0.70,  // apical crown of arching leaves
      branchAngle:      0.72,  // leaves sweep wide from the crown
      apicalBias:       0.92,  // single dominant pseudostem
      droopBias:        0.00,  // reset to identity (was inert 0.30)
      rigidity:         0.35,  // flexible petioles
      stemGirth:        0.82,  // stout trunk-like pseudostem
      taper:            0.25,  // barely tapers — cylindrical pseudostem
      segmentation:     0.60,  // ring-segmented leaf-scar marks
      appendageBreadth: 0.90,  // very broad leaf lamina
      leafWidth:        0.95,  // broad pinnate frond
      leafLength:       0.90,  // long paddle-shaped leaf
      leafTip:          0.55,  // rounded to slightly pointed tip
      leafSerration:    0.10,  // slightly ragged margins (natural tearing)
      leafLobing:       0.30,  // slight lobing (pinnately ribbed midrib)
      leafSize:         1.40,  // large clusters
      leafDensity:      0.70,  // fewer very large leaves
      leafScale:        2.50,  // mega-fronds — the defining banana character
      pigment:          0.37,  // vivid tropical green
      trunkHeight:      0.40,  // short — banana is a low pseudostem
      barkColor:        0.60,  // greenish sheath
      barkPattern:      0.30,  // smooth-ish wrapped sheath
      rootFlare:        0.20,
      rootButtress:     0.08,
      rootSpread:       0.50,
      rootDepth:        0.35,
      structuralSeed:   0xC4B7E923 >>> 0,
    },
  },

  // ── Shrub ─────────────────────────────────────────────────────────────────

  // Bush — true multi-stem shrub: high tillering + high stemSpread so separate stems
  // emerge from the ground at distinct XZ positions, wide low dome, no single leader.
  {
    id:           'bush',
    label:        'Bush',
    category:     'Shrub',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.90,  // maximum branching — fills the crown densely
      branchFactorN:    0.68,  // many children per node → wide rounded mass
      tillering:        0.95,  // near-maximum basal shoot production
      stemSpread:       0.80,  // KEY: spread stem bases outward → true multi-stem footprint
      apicalBias:       0.20,  // very weak leader → no dominant trunk axis
      verticality:      0.38,  // spreading, low habit
      stemGirth:        0.28,  // thin wiry stems
      taper:            0.62,
      lengthRatio:      0.58,  // short internodes → compact dense crown
      droopBias:        0.00,  // reset to identity (was inert 0.10)
      rigidity:         0.42,
      branchAngle:      0.65,  // wide spreading branches
      leafDensity:      1.30,
      leafSize:         0.85,
      leafWidth:        0.55,
      leafLength:       0.38,
      leafLobing:       0.12,
      leafSerration:    0.15,
      pigment:          0.32,
      rootCount:        0.55,
      rootSpread:       0.65,
      rootFlare:        0.15,
      trunkHeight:      0.10,  // near-minimum — barely any trunk above ground
      barkColor:        0.65,
      barkPattern:      0.45,
      structuralSeed:   0x2C8F4B91 >>> 0,
    },
  },

  // Lilac / Hydrangea multi-stem shrub — separate flowering stems from the ground,
  // bushy crown, warm flowering pigment (hue toward pink/purple).
  {
    id:           'lilac',
    label:        'Lilac',
    category:     'Shrub',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.78,
      branchFactorN:    0.62,
      tillering:        0.85,  // multiple ground-level stems
      stemSpread:       0.72,  // splay stem bases for true multi-stem look
      apicalBias:       0.25,  // weak leader → bushy, rounded crown
      verticality:      0.50,  // upright-ish but full and spreading
      stemGirth:        0.32,
      taper:            0.65,
      lengthRatio:      0.62,
      droopBias:        0.00,  // reset to identity (was inert 0.12)
      rigidity:         0.48,
      branchAngle:      0.62,
      leafDensity:      1.25,
      leafSize:         0.90,
      leafWidth:        0.60,
      leafLength:       0.50,
      leafLobing:       0.08,
      leafSerration:    0.20,
      pigment:          0.75,  // hue≈270° → purple/lilac flowering tone
      trunkHeight:      0.15,  // very low trunk — stems emerge near ground
      rootCount:        0.50,
      rootSpread:       0.60,
      rootFlare:        0.10,
      barkColor:        0.72,
      barkPattern:      0.38,
      structuralSeed:   0xB4A2C831 >>> 0,
    },
  },

  // ── Succulent ─────────────────────────────────────────────────────────────

  // Saguaro Cactus — tall columnar succulent with visible vertical flutes,
  // upright arms, and real spine cards. High ribbing + spininess now rendered.
  {
    id:           'cactus-saguaro',
    label:        'Saguaro Cactus',
    category:     'Succulent',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.15,  // sparse upright arms — saguaro has few
      branchFactorN:    0.25,
      tillering:        0.00,
      branchAngle:      0.40,  // arms reach up, not out
      apicalBias:       0.85,
      droopBias:        0.00,  // reset to identity (was inert -0.05)
      rigidity:         0.90,  // very stiff — no flexibility
      succulence:       0.95,  // water-barrel inflated column
      stemGirth:        0.92,  // fat trunk
      taper:            0.15,  // barely tapers — cylindrical column shape
      ribbing:          0.88,  // KEY: deep vertical flutes — now rendered on mesh
      spininess:        0.85,  // KEY: real spine cards visible on surface
      flatness:         0.00,  // circular cross-section
      segmentation:     0.20,
      appendageBreadth: 0.05,  // spine-like appendages
      appendageDensity: 0.70,
      leafWidth:        0.05,
      leafLength:       0.70,
      leafTip:          0.10,
      leafSerration:    0.00,
      leafLobing:       0.00,
      leafSize:         0.65,
      leafDensity:      0.55,
      pigment:          0.30,  // grey-green — waxy cactus green
      barkColor:        0.55,
      barkPattern:      0.40,
      trunkHeight:      0.5413926851582250,  // re-tuned: reproduces prior 0.65 factor under new mapping
      rootDepth:        0.80,  // deep taproot for desert water
      rootSpread:       0.80,  // wide surface roots for rain capture
      rootBranchiness:  0.70,
      woodiness:        0.15,  // cacti are GREEN, not brown bark — mostly herbaceous tissue
      structuralSeed:   0x17F64A8C >>> 0,
    },
  },

  // Barrel Cactus — squat, maximally ribbed and spined, nearly spherical.
  {
    id:           'cactus-barrel',
    label:        'Barrel Cactus',
    category:     'Succulent',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.05,  // almost no branching — single fat barrel
      branchFactorN:    0.20,
      tillering:        0.00,
      branchAngle:      0.40,
      apicalBias:       0.90,
      droopBias:        0.00,
      rigidity:         0.95,
      succulence:       1.00,  // maximum inflation
      stemGirth:        1.00,  // maximum girth — true barrel
      taper:            0.05,  // nearly spherical, almost no taper
      ribbing:          1.00,  // maximum ribbing — very pronounced flutes
      spininess:        1.00,  // maximum spines — densely armed
      flatness:         0.00,
      segmentation:     0.15,
      appendageBreadth: 0.05,
      appendageDensity: 0.80,
      leafWidth:        0.05,
      leafLength:       0.65,
      leafTip:          0.08,
      leafSerration:    0.00,
      leafLobing:       0.00,
      leafSize:         0.60,  // minimum per schema range [0.6, 1.6]
      leafDensity:      0.50,
      pigment:          0.29,  // blue-grey-green
      barkColor:        0.52,
      barkPattern:      0.38,
      trunkHeight:      0.25,  // squat — barely clears ground
      rootDepth:        0.85,
      rootSpread:       0.75,
      rootBranchiness:  0.65,
      woodiness:        0.15,  // cacti are GREEN, not brown bark — mostly herbaceous tissue
      structuralSeed:   0x4D9C3E01 >>> 0,
    },
  },

  // ── Fern ──────────────────────────────────────────────────────────────────

  // Fern — apical rosette of arching pinnate fronds at ground level, no woody trunk.
  {
    id:           'fern',
    label:        'Fern',
    category:     'Fern',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.50,
      branchFactorN:    0.48,
      tillering:        0.45,  // arching fronds from a central crown
      rosette:          0.70,  // KEY: apical frond crown — fronds radiate from apex
      apicalBias:       0.38,
      verticality:      0.40,  // spreading, low habit
      stemGirth:        0.20,
      taper:            0.60,
      rigidity:         0.22,  // arching, flexible fronds
      succulence:       0.05,
      flatness:         0.45,  // slightly flattened stipe
      droopBias:        0.00,  // reset to identity (was inert 0.22)
      branchAngle:      0.65,
      lengthRatio:      0.78,
      segmentation:     0.40,
      appendageBreadth: 0.65,
      leafWidth:        0.68,
      leafLength:       0.82,
      leafTip:          0.45,
      leafSerration:    0.70,  // deeply pinnate / serrate frond margins
      leafLobing:       0.78,  // pinnate lobing → strong frond character
      leafSize:         1.20,
      leafDensity:      1.10,
      pigment:          0.30,  // deep fern green
      barkColor:        0.45,
      barkPattern:      0.20,
      trunkHeight:      0.12,  // nearly ground-level — ferns have no trunk
      rootDepth:        0.20,
      rootSpread:       0.55,
      rootBranchiness:  0.60,
      woodiness:        0.05,  // soft green frond stems — nearly fully herbaceous
      structuralSeed:   0xE3F71A04 >>> 0,
    },
  },

  // ── Aquatic ───────────────────────────────────────────────────────────────

  // Kelp — tall flexible stipe with broad flattened lamina blades, minimal rigidity.
  {
    id:           'kelp',
    label:        'Kelp',
    category:     'Aquatic',
    experimental: false,
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.35,
      branchFactorN:    0.35,
      tillering:        0.05,
      apicalBias:       0.80,  // single dominant stipe
      verticality:      0.60,  // upright stipe toward the surface
      stemGirth:        0.35,
      taper:            0.50,
      rigidity:         0.10,  // KEY: very flexible — current-swept, like kelp in water
      succulence:       0.30,  // slightly inflated pneumatocysts
      flatness:         0.65,  // KEY: flat lamina stipe cross-section
      ribbing:          0.25,  // subtle midrib along stipe
      segmentation:     0.45,
      droopBias:        0.00,  // reset to identity (was inert 0.25)
      branchAngle:      0.60,
      lengthRatio:      0.80,
      appendageBreadth: 0.85,  // broad lamina blades
      leafWidth:        0.95,  // very broad fronds
      leafLength:       0.90,  // long fronds
      leafTip:          0.40,
      leafSerration:    0.38,  // frilled / undulate blade edges
      leafLobing:       0.30,
      leafSize:         1.50,
      leafDensity:      0.75,
      pigment:          0.22,  // olive-brown kelp colour
      barkColor:        0.45,
      barkPattern:      0.30,
      trunkHeight:      0.5651668842475030,  // re-tuned: reproduces prior 0.75 factor under new mapping
      rootDepth:        0.15,  // holdfasts, not deep roots
      rootSpread:       0.40,
      rootBranchiness:  0.80,
      woodiness:        0.10,  // soft flexible aquatic tissue — not woody
      structuralSeed:   0x7D5C2E91 >>> 0,
    },
  },


];
