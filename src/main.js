import { randomGenome, resolve }          from './genome.js';
import { createViewer }                   from './viewer.js';
import { createRenderModeController }     from './renderModes.js';
import { TREE_DEFAULT, PRESETS }          from './presets.js';
import { pigmentToColor }                 from './colorRamp.js';
import { mountInspectorPanels }           from './inspectorPanels.js';
import { createBarkSwatch }               from './barkSwatch.js';
import { buildForestGroup }               from './forest.js';
import { createLeafCardPreview }          from './leafCardPreview.js';

// =============================================================================
// MODULE STATE
// =============================================================================
let seed   = 42;
let genome = null;   // current specimen's full gene vector (incl. structuralSeed)
let lastResolved = null;   // most recent resolve() output — fed to the inspector dock

// =============================================================================
// MORPHOLOGICAL SLIDER REGISTRY
// All continuous genes that have direct sliders in the UI.
// =============================================================================
const MORPH_GENES = [
  // Form
  'branchiness', 'branchFactorN', 'tillering', 'radialOrder', 'whorl', 'crownStart',
  // Stem
  'succulence', 'stemGirth', 'taper', 'ribbing', 'segmentation', 'spininess', 'woodiness',
  // Appendage
  'appendageBreadth', 'appendageDensity', 'tipTuft',
  // Posture
  'verticality', 'rigidity', 'branchAngle', 'lengthRatio', 'apicalBias', 'droopBias',
  'weep', 'trunkHeight', 'trunkTaper',
  // Cosmetic
  'pigment', 'leafSize', 'jitter', 'leafWidth',
  'leafLength', 'leafTip', 'leafSerration', 'leafLobing', 'leafSkew',
  'barkHue', 'barkLightness', 'barkRelief', 'barkLenticels', 'barkScale', 'barkOrient', 'barkPlates',
  'barkShed', 'barkUnderHue',
  'leafDivision', 'frondFan',
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
  crownStart:       'crownStartSlider',
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
  jitter:           'jitterSlider',
  leafWidth:        'leafWidthSlider',
  leafLength:       'leafLengthSlider',
  leafTip:          'leafTipSlider',
  leafSerration:    'leafSerrationSlider',
  leafLobing:       'leafLobingSlider',
  leafSkew:         'leafSkewSlider',
  weep:             'weepSlider',
  trunkHeight:      'trunkHeightSlider',
  trunkTaper:       'trunkTaperSlider',
  barkHue:          'barkHueSlider',
  barkLightness:    'barkLightnessSlider',
  barkRelief:       'barkReliefSlider',
  barkLenticels:    'barkLenticelsSlider',
  barkScale:        'barkScaleSlider',
  barkOrient:       'barkOrientSlider',
  barkPlates:       'barkPlatesSlider',
  barkShed:         'barkShedSlider',
  barkUnderHue:     'barkUnderHueSlider',
  leafDivision:     'leafDivisionSlider',
  frondFan:         'frondFanSlider',
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

// =============================================================================
// INSPECTOR DOCK — part previews (leaf shape / texture / bark / cross-section /
// pigment) + isolate-part toggles. Render-only: reads the resolved organism and
// already-built textures at the setPlant chokepoint; never re-runs generation.
// =============================================================================
const barkSwatch = createBarkSwatch(document.getElementById('insp-bark'));
barkSwatch.start();

// Crossed-card leaf cluster — a dock thumbnail preview (own WebGL context).
const leafCardPreview = createLeafCardPreview(document.getElementById('insp-leaf-cards'));
leafCardPreview.start();

// Forest mode — a stand of varied individuals rendered IN THE HERO VIEW (not a modal).
// forestCount: 1 = single specimen; >1 = a Poisson-placed stand of the same genome with
// different seeds (driven by the count slider). forestHandle owns the built group
// (disposed on rebuild / back to 1×).
let forestCount = 1;
let forestHandle = null;
let forestRebuildTimer = 0;

// reframe: re-aim the camera at the stand. true on count change (bounds changed),
// false on a genome-driven rebuild at the same count (preserves the user's orbit/pan).
function rebuildForest(reframe) {
  if (!genome || forestCount <= 1) return;
  // Build the new stand first, swap it into the scene (setForest removes the old group),
  // THEN dispose the old handle — so a disposed group is never left in the scene.
  const old = forestHandle;
  // Respect the user's leaf-mode setting (single-leaf cards vs clustered sprites) —
  // toggling leaf mode calls renderCurrent() → scheduleForestRebuild(), so the stand
  // tracks it. (single-leaf × many trees is heavier; the count slider controls that.)
  const leafMode = (typeof viewer.getLeafMode === 'function') ? viewer.getLeafMode() : 'single';
  forestHandle = buildForestGroup({ genome, env: getEnvelope(), count: forestCount, leafMode });
  viewer.setForest(forestHandle.group, forestHandle.bounds, reframe, forestHandle.updateWind);
  if (old) old.dispose();
}
function scheduleForestRebuild() {
  if (forestCount <= 1) return;
  if (forestRebuildTimer) clearTimeout(forestRebuildTimer);
  forestRebuildTimer = setTimeout(() => { forestRebuildTimer = 0; rebuildForest(false); }, 250);
}
function applyForestCount(n) {
  forestCount = n;
  if (forestRebuildTimer) { clearTimeout(forestRebuildTimer); forestRebuildTimer = 0; }
  if (n <= 1) {
    viewer.clearForest();
    if (forestHandle) { forestHandle.dispose(); forestHandle = null; }
  } else {
    rebuildForest(true);   // count changed → reframe the camera to the new stand
  }
}

const inspector = mountInspectorPanels({
  viewer,
  getGenome:   () => genome,
  getResolved: () => lastResolved,
  elements: {
    leafShape:      document.getElementById('insp-leaf-shape'),
    leafWireBtn:    document.getElementById('insp-leaf-wire'),
    leafTexture:    document.getElementById('insp-leaf-texture'),
    pigment:        document.getElementById('insp-pigment'),
    pigmentRamp:    document.getElementById('insp-pigment-ramp'),
    crossSection:   document.getElementById('insp-cross-section'),
    toggleLeaves:   document.getElementById('insp-toggle-leaves'),
    toggleBranches: document.getElementById('insp-toggle-branches'),
  },
});

// Collapse/expand the dock from its header.
(function wireInspectorCollapse() {
  const dock   = document.getElementById('inspector-dock');
  const header = document.getElementById('insp-header');
  if (!dock || !header) return;
  header.addEventListener('click', () => {
    const collapsed = dock.classList.toggle('collapsed');
    if (collapsed) {
      // Stop spinning the dock WebGL preview contexts while hidden. (The forest is
      // an in-viewport stand in the hero scene, not a dock card — no spin to pause.)
      barkSwatch.stop();
      leafCardPreview.stop();
    } else {
      // Re-paint on expand (canvases were sized 0 while hidden) and resume.
      inspector.resize();
      barkSwatch.resize();      barkSwatch.start();
      leafCardPreview.resize(); leafCardPreview.start();
    }
  });
})();

/**
 * Push the freshly-resolved organism to the inspector dock. Called right after
 * every viewer.setPlant() — the single chokepoint all slider/preset/reroll paths
 * funnel through. RENDER-ONLY: no generation, no rng.
 */
function refreshInspector(resolved) {
  lastResolved = resolved;
  inspector.refresh();
  barkSwatch.setGenome(resolved);
  leafCardPreview.setGenome(genome);
  // In forest mode, re-resolve the stand to match the current genome (debounced — one
  // rebuild after a slider drag settles, not per-tick). No-op at 1× (single specimen).
  scheduleForestRebuild();
}

// Wire the forest count INPUT — 1 (single specimen) … N (a stand of varied individuals,
// same genome / different seeds, Poisson-placed, IN THE HERO VIEW). Builds on COMMIT
// (Enter / blur / spinner), clamped to [1,1000], debounced to coalesce spinner clicks.
(function wireForestCount() {
  const input = document.getElementById('forest-count-input');
  if (!input) return;
  let timer = 0;
  function commit() {
    let n = parseInt(input.value, 10);
    if (!Number.isFinite(n)) n = 1;
    n = Math.max(1, Math.min(1000, n));
    if (String(n) !== input.value) input.value = String(n);   // reflect the clamp
    applyForestCount(n);
  }
  input.addEventListener('change', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; commit(); }, 150);
  });
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

// Wire leaf-droop (gravity bend) slider — global per-leaf curve toward gravity.
(function wireLeafDroop() {
  const slider = document.getElementById('leaf-droop-slider');
  if (!slider) return;
  const apply = () => {
    if (typeof viewer.setLeafBend === 'function') viewer.setLeafBend(parseFloat(slider.value));
  };
  slider.addEventListener('input', apply);
  apply();   // push the initial value
})();

// Wire leaf-mode toggle — 'single' (one leaf per card) ↔ 'cluster' (multi-leaf
// sprig per card, far fewer instances/triangles). Re-renders the current
// specimen so the new mode takes effect (deterministic — same tree).
(function wireLeafMode() {
  const btn  = document.getElementById('leaf-mode-btn');
  const icon = document.getElementById('leaf-mode-icon');
  if (!btn) return;
  // 3-way cycle: single → cluster → crossed → single.
  //   single  = one leaf per card           (icon '1×')
  //   cluster = a multi-leaf sprig per card  (icon 'N×')
  //   crossed = K=3 criss-crossed sprig cards (SpeedTree puff; icon '✳')
  let mode = 'single';
  const NEXT = { single: 'cluster', cluster: 'crossed', crossed: 'single' };
  const ICON = { single: '1×', cluster: 'N×', crossed: '✳' };
  btn.addEventListener('click', () => {
    mode = NEXT[mode] || 'single';
    btn.classList.toggle('active', mode !== 'single');
    if (icon) icon.textContent = ICON[mode];
    if (typeof viewer.setLeafMode === 'function') viewer.setLeafMode(mode);
    renderCurrent();   // rebuild the current tree with the new leaf mode
  });
})();

// Wire first-person walk mode — clicking enters Pointer-Lock FPS navigation
// (WASD + mouse-look, Esc to exit). The button shows .active while walking;
// the viewer clears it via onWalkExit when pointer lock is released (Esc).
(function wireWalkMode() {
  const btn = document.getElementById('walk-btn');
  if (!btn || typeof viewer.enterWalk !== 'function') return;
  btn.addEventListener('click', () => {
    btn.classList.add('active');
    viewer.enterWalk();
  });
  if (typeof viewer.onWalkExit === 'function') {
    viewer.onWalkExit(() => btn.classList.remove('active'));
  }
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
  refreshInspector(resolved);
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
  refreshInspector(resolved);
}

// =============================================================================
// WINDOW RESIZE
// =============================================================================
window.addEventListener('resize', () => {
  viewer.resize();
  inspector.resize();
  barkSwatch.resize();
  leafCardPreview.resize();
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
refreshInspector(resolved);

// Inspector canvases size from their laid-out client box; re-paint once after the
// first layout/paint so they aren't stuck at a zero/stale size on initial load.
requestAnimationFrame(() => { inspector.resize(); barkSwatch.resize(); leafCardPreview.resize(); });

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
