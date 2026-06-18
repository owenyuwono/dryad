import { randomGenome, resolve }          from './genome.js';
import { createViewer }                   from './viewer.js';
import { createRenderModeController }     from './renderModes.js';
import { TREE_DEFAULT, PRESETS }          from './presets.js';
import { pigmentToColor }                 from './colorRamp.js';

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
  'branchiness', 'branchFactorN', 'tillering', 'radialOrder', 'whorl',
  // Stem
  'succulence', 'stemGirth', 'taper', 'ribbing', 'segmentation', 'spininess', 'woodiness',
  // Appendage
  'appendageBreadth', 'appendageDensity', 'tipTuft',
  // Posture
  'verticality', 'rigidity', 'branchAngle', 'lengthRatio', 'apicalBias', 'droopBias',
  'weep', 'trunkHeight', 'trunkTaper',
  // Cosmetic
  'pigment', 'leafSize', 'leafDensity', 'jitter', 'leafWidth',
  'leafLength', 'leafTip', 'leafSerration', 'leafLobing',
  'barkColor', 'barkPattern',
  'needleLeaf', 'leafScale', 'frondLeaf',
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
  whorl:            'whorlSlider',
  succulence:       'succulenceSlider',
  stemGirth:        'stemGirthSlider',
  taper:            'taperSlider',
  ribbing:          'ribbingSlider',
  segmentation:     'segmentationSlider',
  spininess:        'spininessSlider',
  woodiness:        'woodinessSlider',
  appendageBreadth: 'appendageBreadthSlider',
  appendageDensity: 'appendageDensitySlider',
  tipTuft:          'tipTuftSlider',
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
  leafLength:       'leafLengthSlider',
  leafTip:          'leafTipSlider',
  leafSerration:    'leafSerrationSlider',
  leafLobing:       'leafLobingSlider',
  weep:             'weepSlider',
  trunkHeight:      'trunkHeightSlider',
  trunkTaper:       'trunkTaperSlider',
  barkColor:        'barkColorSlider',
  barkPattern:      'barkPatternSlider',
  needleLeaf:       'needleLeafSlider',
  leafScale:        'leafScaleSlider',
  frondLeaf:        'frondLeafSlider',
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
// PRESET MODAL WIRING
// =============================================================================

(function wirePresetModal() {
  const modal     = document.getElementById('presets-modal');
  const openBtn   = document.getElementById('presetsBtn');
  const closeBtn  = document.getElementById('presets-close-btn');
  const body      = document.getElementById('presets-body');
  if (!modal || !openBtn || !closeBtn || !body) return;

  // ── Category order ──────────────────────────────────────────────────────────
  const CATEGORY_ORDER = [
    'Broadleaf', 'Weeping', 'Columnar', 'Conifer',
    'Tropical', 'Shrub', 'Succulent', 'Fern', 'Aquatic', 'Other',
  ];

  // ── Build card DOM ──────────────────────────────────────────────────────────
  function buildCards() {
    // Group presets by category; fall back to 'Other' for missing category.
    const groups = new Map();
    for (const preset of PRESETS) {
      const cat = preset.category ?? 'Other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(preset);
    }

    // Render groups in the defined order, skipping empty ones.
    for (const cat of CATEGORY_ORDER) {
      const presets = groups.get(cat);
      if (!presets || presets.length === 0) continue;

      const heading = document.createElement('div');
      heading.className = 'preset-category-heading';
      heading.textContent = cat;
      body.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'preset-card-grid';

      for (const preset of presets) {
        const card = document.createElement('button');
        card.className = 'preset-card';
        card.type = 'button';
        card.dataset.presetId = preset.id;

        // Color swatch from pigment gene.
        const pigment = preset.genome?.pigment ?? 0.33;
        const [r, g, b] = pigmentToColor(pigment);
        const swatch = document.createElement('span');
        swatch.className = 'preset-swatch';
        swatch.style.background =
          `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
        card.appendChild(swatch);

        // Label.
        const label = document.createElement('span');
        label.className = 'preset-card-label';
        label.textContent = preset.label ?? preset.id;
        card.appendChild(label);

        // Experimental badge.
        if (preset.experimental === true) {
          const badge = document.createElement('span');
          badge.className = 'preset-badge-experimental';
          badge.textContent = 'exp';
          card.appendChild(badge);
        }

        card.addEventListener('click', () => {
          // Exact same load path as the old dropdown.
          genome = { ...preset.genome };
          syncSlidersFromGenome(genome);
          renderCurrent();
          closeModal();
        });

        grid.appendChild(card);
      }

      body.appendChild(grid);
    }
  }

  // ── Open / close ────────────────────────────────────────────────────────────
  function openModal() {
    modal.classList.add('open');
  }

  function closeModal() {
    modal.classList.remove('open');
  }

  // Open button.
  openBtn.addEventListener('click', openModal);

  // X button.
  closeBtn.addEventListener('click', closeModal);

  // Click on backdrop (outside the panel) closes the modal.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // Escape key closes the modal.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
  });

  // Build cards once on startup.
  buildCards();
})();

// =============================================================================
// INITIAL GENERATION — load a fixed tree default so the page always opens on
// a proper deciduous tree (low succulence → bark trunk, lush canopy).
// TREE_DEFAULT is imported from src/presets.js; the 'tree' preset is identical.
// The "Generate" button still rolls a climate-adapted random genome.
// =============================================================================

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
