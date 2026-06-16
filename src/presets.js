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
  ribbing:          0.00,
  spininess:        0.00,
  branchAngle:      0.60,  // moderate spread → rounded crown, not flat fan
  lengthRatio:      0.70,  // faster taper → compact proportionate crown, not whippy
  apicalBias:       0.75,  // strong apical dominance keeps clear trunk leader
  droopBias:        0.10,
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
};

// ---------------------------------------------------------------------------
// PRESETS — ordered array of { id, label, genome }.
// Hand-authored starting points; tune values via the sliders after loading.
// ---------------------------------------------------------------------------
export const PRESETS = [

  // ── Tree ──────────────────────────────────────────────────────────────────
  // Default deciduous broadleaf — rounded crown, single dominant trunk.
  {
    id:     'tree',
    label:  'Tree',
    genome: { ...TREE_DEFAULT },
  },

  // ── Maple ─────────────────────────────────────────────────────────────────
  // Broad rounded crown; palmate, deeply-lobed, serrated leaves; wide spread.
  {
    id:     'maple',
    label:  'Maple',
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.60,
      branchFactorN:    0.60,
      tillering:        0.00,
      branchAngle:      0.75,  // spreading canopy, wider than tree default
      apicalBias:       0.45,  // less dominant leader → broad dome
      droopBias:        0.05,
      leafLobing:       0.85,  // palmate / maple-leaf lobing
      leafSerration:    0.35,  // serrated margins
      leafWidth:        0.70,  // broad leaf
      leafLength:       0.40,  // relatively short, wide
      leafTip:          0.60,  // slightly rounded tip
      leafSize:         1.10,
      pigment:          0.35,  // rich leaf green
      structuralSeed:   0xA1B2C3D4 >>> 0,
    },
  },

  // ── Birch ─────────────────────────────────────────────────────────────────
  // Slender columnar form; fine pendulous twigs; small serrated ovate leaves.
  {
    id:     'birch',
    label:  'Birch',
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.45,
      branchFactorN:    0.50,
      tillering:        0.00,
      verticality:      0.70,  // upright, columnar
      stemGirth:        0.30,  // slender stems
      taper:            0.80,  // strong taper to fine tips
      droopBias:        0.30,  // pendulous secondary twigs
      rigidity:         0.35,  // flexible, droopy fine branches
      branchAngle:      0.55,
      apicalBias:       0.65,  // moderate apical — columnar but still branching
      leafSize:         0.85,  // small leaves
      leafSerration:    0.50,  // distinctly serrated
      leafWidth:        0.45,  // medium-narrow
      leafLength:       0.45,
      leafLobing:       0.00,  // simple ovate, no lobing
      leafTip:          0.35,  // pointed acuminate tip
      pigment:          0.30,
      structuralSeed:   0x7F3A1E05 >>> 0,
    },
  },

  // ── Bush ──────────────────────────────────────────────────────────────────
  // Low dense multi-stem shrub; heavy tillering is the defining characteristic.
  {
    id:     'bush',
    label:  'Bush',
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.70,
      branchFactorN:    0.60,
      tillering:        0.80,  // KEY: multi-stem basal clump
      apicalBias:       0.35,  // weak apical → spreading, no single leader
      verticality:      0.40,  // low, spreading habit
      stemGirth:        0.30,  // thin stems
      lengthRatio:      0.60,  // shorter internodes → compact
      droopBias:        0.08,
      rigidity:         0.45,
      leafDensity:      1.20,  // dense foliage
      leafSize:         0.90,
      leafWidth:        0.55,
      leafLength:       0.40,
      leafLobing:       0.10,
      pigment:          0.32,
      rootCount:        0.55,
      rootSpread:       0.65,  // wide root plate for a multi-stem shrub
      rootFlare:        0.20,  // minimal flare on thin stems
      structuralSeed:   0x2C8F4B91 >>> 0,
    },
  },

  // ── Weeping ───────────────────────────────────────────────────────────────
  // Willow-like; strongly pendulous branches; long narrow drooping leaves.
  {
    id:     'weeping',
    label:  'Weeping',
    genome: {
      ...TREE_DEFAULT,
      branchiness:      0.50,
      branchFactorN:    0.55,
      tillering:        0.00,
      verticality:      0.70,  // upright trunk base
      rigidity:         0.20,  // very flexible → dramatic droop
      droopBias:        0.38,  // KEY: strong pendulous droop (near schema max 0.4)
      apicalBias:       0.55,
      branchAngle:      0.58,
      lengthRatio:      0.78,  // long branches for cascading effect
      stemGirth:        0.45,
      leafWidth:        0.30,  // narrow lanceolate leaves
      leafLength:       0.85,  // long
      leafTip:          0.70,  // pointed
      leafSerration:    0.20,  // slightly serrated
      leafLobing:       0.00,
      leafSize:         0.95,
      leafDensity:      1.05,
      pigment:          0.34,
      rootCount:        0.50,
      rootSpread:       0.60,
      structuralSeed:   0xE5D2A0F7 >>> 0,
    },
  },

];
