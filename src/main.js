import { randomGenome, resolve }          from './genome.js';
import { createViewer }                   from './viewer.js';
import { createRenderModeController }     from './renderModes.js';

// =============================================================================
// MODULE STATE
// =============================================================================
let seed   = 42;
let genome = null;   // current specimen's full gene vector (incl. structuralSeed)

// =============================================================================
// MORPHOLOGICAL SLIDER REGISTRY
// All continuous genes that have direct sliders in the UI.
// =============================================================================
const MORPH_GENES = [
  // Form
  'branchiness', 'branchFactorN', 'tillering', 'radialOrder',
  // Stem
  'succulence', 'stemGirth', 'taper', 'ribbing', 'segmentation', 'spininess',
  // Appendage
  'appendageBreadth', 'appendageDensity',
  // Posture
  'verticality', 'rigidity', 'branchAngle', 'lengthRatio', 'apicalBias', 'droopBias',
  // Cosmetic
  'pigment', 'leafSize', 'leafDensity', 'jitter', 'leafWidth',
  // Roots
  'rootCount', 'rootDepth', 'rootSpread', 'rootFlare',
  'rootButtress', 'rootBranchiness', 'rootTaper',
];

// Map gene name → slider element id (branchiness → bранchSlider is the one special case)
const GENE_SLIDER_ID = {
  branchiness:      'brchinessSlider',
  branchFactorN:    'branchFactorNSlider',
  tillering:        'tilleringSlider',
  radialOrder:      'radialOrderSlider',
  succulence:       'succulenceSlider',
  stemGirth:        'stemGirthSlider',
  taper:            'taperSlider',
  ribbing:          'ribbingSlider',
  segmentation:     'segmentationSlider',
  spininess:        'spininessSlider',
  appendageBreadth: 'appendageBreadthSlider',
  appendageDensity: 'appendageDensitySlider',
  verticality:      'verticalitySlider',
  rigidity:         'rigiditySlider',
  branchAngle:      'branchAngleSlider',
  lengthRatio:      'lengthRatioSlider',
  apicalBias:       'apicalBiasSlider',
  droopBias:        'droopBiasSlider',
  pigment:          'pigmentSlider',
  leafSize:         'leafSizeSlider',
  leafDensity:      'leafDensitySlider',
  jitter:           'jitterSlider',
  leafWidth:        'leafWidthSlider',
  // Roots
  rootCount:        'rootCountSlider',
  rootDepth:        'rootDepthSlider',
  rootSpread:       'rootSpreadSlider',
  rootFlare:        'rootFlareSlider',
  rootButtress:     'rootButtressSlider',
  rootBranchiness:  'rootBranchinessSlider',
  rootTaper:        'rootTaperSlider',
};

// =============================================================================
// ENV ENVELOPE — reads climate sliders; energy/biochem locked
// =============================================================================
function getEnvelope() {
  return {
    gravity:     parseFloat(document.getElementById('gravSlider').value),
    medium:      document.getElementById('mediumSel').value,
    energy:      'photo',
    biochem:     'carbon',
    temperature: parseFloat(document.getElementById('tempSlider').value    ?? '0.5'),
    light:       parseFloat(document.getElementById('lightSlider').value   ?? '0.6'),
    sunAngle:    parseFloat(document.getElementById('sunAngleSlider').value ?? '0.25'),
    wind:        parseFloat(document.getElementById('windSlider').value    ?? '0.2'),
    aridity:     parseFloat(document.getElementById('ariditySlider').value ?? '0.35'),
  };
}

// =============================================================================
// ONE-TIME SETUP — fullscreen canvas + viewer
// =============================================================================
const canvas = document.getElementById('viewer-canvas');
const viewer = createViewer(canvas);
viewer.start();

// =============================================================================
// RENDER MODE CONTROLLER
// branchMesh and leafMesh are stable refs (created once in viewer, geometry
// swapped on setPlant — the mesh object itself never changes).
// We create the controller immediately and attach it; setMode calls before the
// first setPlant are no-ops (cacheRealMaterials caches on first non-lit call,
// after the first generate has set real materials).
// =============================================================================
const renderModeCtrl = createRenderModeController({
  branchMesh: viewer.branchMesh,
  leafMesh:   viewer.leafMesh,
  barkCtl:    viewer.barkCtl,
  leafCtl:    viewer.leafCtl,
});
viewer.attachRenderModeController(renderModeCtrl);

// Wire render-mode panel buttons
(function wireRenderModePanel() {
  const panel = document.getElementById('rendermode-panel');
  if (!panel) return;

  const buttons = panel.querySelectorAll('[data-mode]');

  function activateMode(mode) {
    viewer.setRenderMode(mode);
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', () => activateMode(btn.dataset.mode));
  });

  // Start with 'lit' active
  activateMode('lit');
})();

// Wire reveal-roots toggle button
(function wireRootsRevealToggle() {
  const btn = document.getElementById('reveal-roots-btn');
  if (!btn) return;

  let revealed = false;

  btn.addEventListener('click', () => {
    revealed = !revealed;
    btn.classList.toggle('active', revealed);
    if (typeof viewer.setRootsRevealed === 'function') {
      viewer.setRootsRevealed(revealed);
    }
  });
})();

// Wire wind toggle button + strength slider
(function wireWindControls() {
  const toggleBtn = document.getElementById('wind-toggle-btn');
  const strengthSlider = document.getElementById('wind-strength-slider');
  if (!toggleBtn || !strengthSlider) return;

  let windOn = false;

  toggleBtn.addEventListener('click', () => {
    windOn = !windOn;
    toggleBtn.classList.toggle('active', windOn);
    if (typeof viewer.setWindEnabled === 'function') {
      viewer.setWindEnabled(windOn);
    }
  });

  strengthSlider.addEventListener('input', () => {
    const val = parseFloat(strengthSlider.value);
    if (typeof viewer.setWindStrength === 'function') {
      viewer.setWindStrength(val);
    }
  });
})();

// =============================================================================
// HELPERS
// =============================================================================

/** Push genome gene values back into all morphological sliders + their labels. */
function syncSlidersFromGenome(g) {
  for (const gene of MORPH_GENES) {
    const sliderId   = GENE_SLIDER_ID[gene];
    const displayId  = document.getElementById(sliderId)?.dataset?.display;
    const slider     = document.getElementById(sliderId);
    if (!slider) continue;
    slider.value = g[gene];
    if (displayId) {
      const label = document.getElementById(displayId);
      if (label) label.textContent = parseFloat(g[gene]).toFixed(2);
    }
  }
}

/** Re-resolve current genome against env and push to viewer. */
function renderCurrent() {
  if (!genome) return;
  const resolved = resolve(genome, getEnvelope());
  viewer.setPlant(resolved);
}

// =============================================================================
// GENERATE — randomGenome adapted to current climate, then sync sliders, render
// =============================================================================
function generate() {
  const env = getEnvelope();
  genome = randomGenome(env, seed);
  syncSlidersFromGenome(genome);
  const resolved = resolve(genome, env);
  viewer.setPlant(resolved);
}

// =============================================================================
// WINDOW RESIZE
// =============================================================================
window.addEventListener('resize', () => {
  viewer.resize();
});

// =============================================================================
// CLIMATE SLIDER WIRING
// Climate changes: update label, re-resolve current genome (no re-randomize).
// Adaptation (moving morph sliders) only happens on Generate.
// =============================================================================

function wireClimateSlider(sliderId, labelId) {
  const slider = document.getElementById(sliderId);
  const label  = labelId ? document.getElementById(labelId) : null;
  slider.addEventListener('input', () => {
    if (label) label.textContent = parseFloat(slider.value).toFixed(2);
    renderCurrent();
  });
}

wireClimateSlider('gravSlider',     'gravVal');
wireClimateSlider('tempSlider',     'tempVal');
wireClimateSlider('lightSlider',    'lightVal');
wireClimateSlider('sunAngleSlider', 'sunAngleVal');
wireClimateSlider('windSlider',     'windVal');
wireClimateSlider('ariditySlider',  'aridityVal');

document.getElementById('mediumSel').addEventListener('change', renderCurrent);

// =============================================================================
// MORPHOLOGICAL SLIDER WIRING
// Direct gene control: set genome[gene], keep structuralSeed, re-resolve.
// =============================================================================

for (const gene of MORPH_GENES) {
  const sliderId = GENE_SLIDER_ID[gene];
  const slider   = document.getElementById(sliderId);
  if (!slider) continue;

  const displayId = slider.dataset.display;

  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);

    // Update display label
    if (displayId) {
      const label = document.getElementById(displayId);
      if (label) label.textContent = val.toFixed(2);
    }

    // Direct genome edit: only this one gene changes, structuralSeed stays
    if (genome) {
      genome[gene] = val;
      renderCurrent();
    }
  });
}

// =============================================================================
// SEED FIELD + GENERATE BUTTON
// =============================================================================

document.getElementById('seedInput').addEventListener('input', () => {
  const raw = document.getElementById('seedInput').value.trim();
  const n   = parseInt(raw, 10);
  seed      = isNaN(n) ? 0 : (n >>> 0);
  // Seed change alone does NOT regenerate — user hits Generate to apply
});

document.getElementById('generateBtn').addEventListener('click', () => {
  // Reroll seed via crypto for a fresh specimen
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  seed = arr[0];
  document.getElementById('seedInput').value = seed.toString();
  generate();
});

document.getElementById('rerollSeedBtn').addEventListener('click', () => {
  // Reroll ONLY the structural seed → a new INDIVIDUAL of the same specimen:
  // the skeleton + root topology change, but every gene (and the climate) stays
  // exactly as-is. (Generate, by contrast, rolls a whole new climate-adapted
  // genome.) Re-resolve the current genome with its new structuralSeed.
  if (!genome) return;
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  genome.structuralSeed = arr[0] >>> 0;
  renderCurrent();
});

// =============================================================================
// INITIAL GENERATION — load a fixed tree default so the page always opens on
// a proper deciduous tree (low succulence → bark trunk, lush canopy).
// The "Generate" button still rolls a climate-adapted random genome.
// =============================================================================

// TREE_DEFAULT — produces a solid trunk + rounded, densely-branched crown on page load.
//
// Key tuning goals (see task brief):
//   TRUNK:  trunkHeight=2.0 (in skeleton.js) + segmentation=0.35 → 6–7 trunk segments.
//           The tree has a clear, tall trunk before canopy begins.
//   DENSE:  branchFactorN=0.65 → ~2.95 children per node (3 forks per node fills the
//           crown volume rather than producing a few long sparse arms).
//           Shorter internode chains (2–3 segs, skeleton.js) mean forks happen sooner.
//   ROUND:  branchAngle=0.60 (+ LATERAL_SPREAD_BOOST=0.15 for level≥1) → branches
//           spread at ~0.75 rad (~43°) — wide enough to fill laterally but not so
//           wide they splay into a flat fan. Produces a rounded dome silhouette.
//   COMPACT: BASE_BRANCH_LENGTH=1.0 (skeleton.js) + lengthRatio=0.70 → primaries
//            reach ~2× trunk height; each successive level is 30% shorter so the
//            crown fills densely rather than producing whippy far-reaching arms.
//   FOLIAGE: appendageDensity=0.90 → dense leaf clusters on twig tips.
//
// tillering=0 → exactly one trunk (no basal tillering for a tree).
const TREE_DEFAULT = {
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
  leafWidth:        0.50,  // 0.5 = no width change (widthMul=1.0)
  structuralSeed:   1337,
  // Root system defaults for the tree specimen
  rootCount:        0.50,  // ~4 major laterals — good oak/beech spread
  rootDepth:        0.40,  // moderate taproot
  rootSpread:       0.55,  // medium radial reach
  rootFlare:        0.35,  // visible but subtle trunk flare
  rootButtress:     0.10,  // minimal buttressing
  rootBranchiness:  0.45,  // moderate sub-root branching
  rootTaper:        0.50,  // neutral taper
};

// Load tree default: set genome, push all sliders to match, then resolve + render.
genome = { ...TREE_DEFAULT };
syncSlidersFromGenome(genome);
const resolved = resolve(genome, getEnvelope());
viewer.setPlant(resolved);

// =============================================================================
// STATS PANEL — polls viewer.getStats() ~4×/sec and updates DOM
// =============================================================================

const statFps         = document.getElementById('stat-fps');
const statTriangles   = document.getElementById('stat-triangles');
const statDrawCalls   = document.getElementById('stat-drawcalls');
const statLeafCluster = document.getElementById('stat-leafclusters');
const statBones       = document.getElementById('stat-bones');
const statResolution  = document.getElementById('stat-resolution');

function fpsColorClass(fps) {
  if (fps >= 50) return 'fps-good';
  if (fps >= 30) return 'fps-ok';
  return 'fps-bad';
}

function formatNumber(n) {
  if (n == null) return '--';
  return Number(n).toLocaleString('en-US');
}

function updateStats() {
  if (typeof viewer.getStats !== 'function') return;

  let stats;
  try { stats = viewer.getStats(); } catch (_) { return; }
  if (!stats) return;

  // FPS — color-coded
  const fps = stats.fps != null ? Math.round(stats.fps) : null;
  statFps.textContent = fps != null ? fps : '--';
  statFps.className = fps != null ? fpsColorClass(fps) : '';

  statTriangles.textContent   = formatNumber(stats.triangles);
  statDrawCalls.textContent   = formatNumber(stats.drawCalls);
  statLeafCluster.textContent = formatNumber(stats.leafClusters);
  statBones.textContent       = formatNumber(stats.bones);

  if (stats.resolution != null) {
    const r = stats.resolution;
    statResolution.textContent = typeof r === 'string' ? r : `${r.width ?? r.x ?? '--'}×${r.height ?? r.y ?? '--'}`;
  } else {
    statResolution.textContent = '--';
  }
}

setInterval(updateStats, 250);
