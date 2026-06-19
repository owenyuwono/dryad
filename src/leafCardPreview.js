// =============================================================================
// leafCardPreview.js — inspector dock panel: the CLASSIC crossed-card foliage
// technique, for comparison against the hero viewer's single-leaf cards.
//
// Instead of one quad = one leaf, each "leaf card" is 3 intersecting quads
// (criss-crossed at 0°/60°/120° about Y), each textured with a MULTI-LEAF cluster
// sprite. A handful of these cards jittered into a clump reads as a volumetric
// canopy puff from any angle — the old-school SpeedTree-style billboard cluster,
// far cheaper per leaf than individual cards. This panel renders that puff,
// rotating, so the technique can be judged before adopting it anywhere.
//
// PREVIEW-ONLY: this does NOT touch the hero viewer's leafMesh / expandClumps. It
// is its own WebGL context (like barkSwatch.js) and uses a STOCK alpha-cutout
// MeshStandardMaterial (no onBeforeCompile), so there is no new shader risk.
// =============================================================================

import * as THREE from 'three';
import { makeLeafClusterTexture } from './leafTexture.js';
import { loadEnvironment } from './environment.js';
import { mulberry32 } from './rng.js';

const CARD_SIZE   = 0.62;   // side of each quad (world units)
const CLUMP_CARDS = 7;      // crossed-card clusters in the puff
const CLUMP_RAD   = 0.42;   // puff radius the cards scatter within
const PLANES_PER_CARD = 3;  // intersecting quads per card (0°/60°/120° about Y)
const SPIN_RATE   = 0.5;    // rad/s
const ARRANGE_SEED = 0xC0FFEE17;

/**
 * createLeafCardPreview(canvas)
 * @returns {{ setGenome(genome): void, start(): void, stop(): void,
 *             resize(): void, dispose(): void }}
 */
export function createLeafCardPreview(canvas) {
  if (!canvas) {
    return { setGenome() {}, render() {}, start() {}, stop() {}, resize() {}, dispose() {} };
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.environmentIntensity = 0.65;

  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
  camera.position.set(0.0, 0.25, 1.9);
  camera.lookAt(0, 0, 0);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
  sun.position.set(2.0, 3.0, 2.5);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x9ec4e8, 0x3a3026, 0.4);
  scene.add(hemi);

  // ONE shared quad geometry (PlaneGeometry has 0..1 UVs → the square sprite maps
  // directly). All crossed planes reuse it; only their transforms differ.
  const quadGeo = new THREE.PlaneGeometry(CARD_SIZE, CARD_SIZE);

  const clumpGroup = new THREE.Group();
  scene.add(clumpGroup);

  let material = null;
  let colourTex = null;
  let normalTex = null;
  let envResult = null;
  let disposed = false;

  loadEnvironment(renderer)
    .then((result) => {
      if (disposed) { result.dispose(); return; }
      envResult = result;
      scene.environment = result.envMap;
      render();
    })
    .catch(() => { /* renders under direct lights without IBL — non-fatal */ });

  function clearClump() {
    for (let i = clumpGroup.children.length - 1; i >= 0; i--) {
      clumpGroup.remove(clumpGroup.children[i]);
    }
  }

  function buildClump() {
    clearClump();
    if (!material) return;
    const rng = mulberry32(ARRANGE_SEED);
    for (let c = 0; c < CLUMP_CARDS; c++) {
      // Jittered position inside a rough sphere (rejection-free: scale a unit-ish vec).
      const ux = rng() * 2 - 1, uy = (rng() * 2 - 1) * 0.8, uz = rng() * 2 - 1;
      const card = new THREE.Group();
      card.position.set(ux * CLUMP_RAD, uy * CLUMP_RAD, uz * CLUMP_RAD);
      const baseYaw = rng() * Math.PI;
      const tilt = (rng() - 0.5) * 0.5;
      // Intersecting quads: criss-cross about Y so leaves are visible from any angle.
      for (let p = 0; p < PLANES_PER_CARD; p++) {
        const m = new THREE.Mesh(quadGeo, material);
        m.rotation.y = baseYaw + (p / PLANES_PER_CARD) * Math.PI;  // 0/60/120°
        m.rotation.x = tilt;
        card.add(m);
      }
      clumpGroup.add(card);
    }
    render();
  }

  // Rebuild the cluster texture + material + crossed-card meshes (the heavy work:
  // makeLeafClusterTexture rasters the superformula + venation). Gated/debounced by
  // setGenome below so it never runs per-slider-tick or while the dock is collapsed.
  function rebuild(genome) {
    if (disposed || !genome) return;
    const texData = makeLeafClusterTexture({
      pigment:       genome.pigment       ?? 0.33,
      seed:          1,
      leafWidth:     genome.leafWidth     ?? 0.5,
      leafLength:    genome.leafLength    ?? 0.45,
      leafTip:       genome.leafTip       ?? 0.4,
      leafSerration: genome.leafSerration ?? 0.0,
      leafLobing:    genome.leafLobing    ?? 0.0,
      leafSkew:      genome.leafSkew      ?? 0.5,
      leafDivision:  genome.leafDivision  ?? 0,
      frondFan:      genome.frondFan      ?? 0,
      leafMode:      'cluster',   // multi-leaf sprite — the whole point of crossed cards
    });
    if (!texData || !texData.source) return;   // headless / null guard

    // Dispose old textures/material before replacing.
    if (colourTex) colourTex.dispose();
    if (normalTex) { normalTex.dispose(); normalTex = null; }
    if (material)  material.dispose();

    colourTex = new THREE.CanvasTexture(texData.source);
    colourTex.colorSpace = THREE.SRGBColorSpace;
    colourTex.needsUpdate = true;
    if (texData.normal) {
      normalTex = new THREE.CanvasTexture(texData.normal);
      normalTex.colorSpace = THREE.NoColorSpace;
      normalTex.needsUpdate = true;
    }

    material = new THREE.MeshStandardMaterial({
      map:       colourTex,
      normalMap: normalTex || null,
      alphaTest: 0.5,           // cutout — no blending / depth-sort needed
      side:      THREE.DoubleSide,
      roughness: 0.88,          // matte, matching the de-glossed hero leaves
      metalness: 0.0,
    });
    buildClump();
  }

  // Debounced + collapse-gated entry point: never rasters on
  // a per-slider-tick storm, and does zero work while the dock is collapsed (a dirty
  // flag forces one rebuild on expand).
  let pending = null, dirty = false, rebuildTimer = 0, running = false;
  function maybeRebuild() {
    if (disposed || !pending) return;
    if (!running) { dirty = true; return; }   // collapsed — defer to expand
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = 0;
      if (disposed || !pending) return;
      dirty = false;
      try { rebuild(pending); }
      catch (err) { if (typeof console !== 'undefined') console.warn('leaf-card preview rebuild failed:', err); }
    }, 250);
  }
  function setGenome(genome) {
    if (disposed || !genome) return;
    pending = genome;
    maybeRebuild();
  }

  let rafId = 0;
  let lastT = 0;
  function render() { if (!disposed) renderer.render(scene, camera); }
  function tick(t) {
    if (disposed) return;
    const dt = lastT ? (t - lastT) / 1000 : 0;
    lastT = t;
    clumpGroup.rotation.y += SPIN_RATE * dt;
    render();
    rafId = requestAnimationFrame(tick);
  }

  function resize() {
    if (disposed) return;
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  resize();

  return {
    setGenome,
    render,
    start() {
      if (disposed) return;
      running = true;
      // Rebuild once on (re)expand if the genome changed while collapsed.
      if (dirty && pending) { dirty = false; try { rebuild(pending); } catch (_) { /* ignore */ } }
      if (rafId) return;
      lastT = 0;
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; }
    },
    resize,
    dispose() {
      disposed = true;
      this.stop();
      clearClump();
      quadGeo.dispose();
      if (material)  material.dispose();
      if (colourTex) colourTex.dispose();
      if (normalTex) normalTex.dispose();
      if (envResult) envResult.dispose();
      renderer.dispose();
    },
  };
}
