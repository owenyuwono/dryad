// =============================================================================
// forestPreview.js — inspector dock panel: a small STAND of varied individuals.
//
// Renders N trees of the CURRENT genome, each with a different structuralSeed
// (distinct individuals of the same species), placed by deterministic blue-noise
// Poisson-disk sampling so the spacing reads natural (no clumping / no grid).
//
// REUSE / SAFETY:
//   - Its own WebGLRenderer + Scene + Camera + PMREM env (like barkSwatch.js).
//     NEVER touches the hero renderer (viewer.js).
//   - Builds each tree with the EXACT same calls viewer.setPlant uses
//     (resolve → buildBranchGeometry → createBarkMaterial / createLeafMesh), so a
//     stand tree looks identical to the hero specimen. Wind stays OFF
//     (uWindStrength=0 default) — windSkinPosition / windBoneFollowDelta both
//     early-return before any texelFetch when calm, so the null bone texture is
//     never sampled (same guarantee barkSwatch relies on). No new GLSL.
//   - Leaves use CLUSTER mode (one multi-leaf sprite per clump anchor, no
//     single-leaf fan-out) so a whole stand stays cheap.
//   - Rebuilds are debounced and skipped while the dock is collapsed; a dirty flag
//     forces one rebuild on expand. The shared bark material + leaf texture are
//     built once per genome; only the per-tree geometry differs by seed.
// =============================================================================

import * as THREE from 'three';
import { resolve } from './genome.js';
import { buildBranchGeometry, MAX_WIND_BONES } from './branchMesh.js';
import { createBarkMaterial } from './barkMaterial.js';
import { createLeafMesh } from './leafMesh.js';
import { makeLeafClusterTexture } from './leafTexture.js';
import { generateFoliage } from './foliage.js';
import { loadEnvironment } from './environment.js';
import { mulberry32 } from './rng.js';
import { poissonDisk } from './poisson.js';

const FOREST_COUNT   = 6;      // trees in the stand (cap; Poisson may yield fewer)
const PLOT           = 4.2;    // plot side (world units) the trees scatter across
const MIN_SPACING    = 1.25;   // Poisson min distance between trunks
const TARGET_HEIGHT  = 1.5;    // each tree normalised to ~this tall so they're comparable
const SPIN_RATE      = 0.18;   // rad/s slow auto-rotate
const SEED_STRIDE    = 0x9E3779B1; // golden-ratio odd stride → well-spread per-tree seeds
const POISSON_SALT   = 0xF0235D1B;

/**
 * createForestPreview(canvas)
 * @returns {{ setGenome(genome, env): void, start(): void, stop(): void,
 *             resize(): void, dispose(): void }}
 */
export function createForestPreview(canvas) {
  if (!canvas) {
    return { setGenome() {}, render() {}, start() {}, stop() {}, resize() {}, dispose() {} };
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.environmentIntensity = 0.6;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
  camera.position.set(PLOT * 0.95, TARGET_HEIGHT * 1.5, PLOT * 1.15);
  camera.lookAt(0, TARGET_HEIGHT * 0.45, 0);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.8);
  sun.position.set(3, 5, 2);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x9ec4e8, 0x3a3026, 0.35);
  scene.add(hemi);

  // Simple ground disc so the stand doesn't float (no shadows — keep it cheap).
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(PLOT * 1.3, 48),
    new THREE.MeshStandardMaterial({ color: 0x4b3b2c, roughness: 1.0, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Shared bark material (one shader compile for the whole stand; same genome).
  const barkCtl = createBarkMaterial();

  const forestGroup = new THREE.Group();
  scene.add(forestGroup);

  // Per-tree disposables (rebuilt each setGenome): { group, geometry, leafCtl, normalTex }.
  let trees = [];
  let envResult = null;
  let disposed = false;

  // Pending rebuild state (debounced; skipped while collapsed).
  let pending = null;      // { genome, env }
  let dirty = false;
  let rebuildTimer = 0;
  let running = false;

  loadEnvironment(renderer)
    .then((result) => {
      if (disposed) { result.dispose(); return; }
      envResult = result;
      scene.environment = result.envMap;
      render();
    })
    .catch(() => { /* renders under direct lights without IBL — non-fatal */ });

  function disposeTrees() {
    for (const t of trees) {
      forestGroup.remove(t.group);
      t.geometry.dispose();                              // branch tube geometry
      if (t.leafCtl) t.leafCtl.dispose();                // leaf geom + material + COLOUR map + depthMaterial
      if (t.normalTex) t.normalTex.dispose();            // leafCtl.dispose() does NOT free normalMap
    }
    trees = [];
  }

  function buildBranchMesh(g) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position',     new THREE.BufferAttribute(g.positions,    3));
    bg.setAttribute('normal',       new THREE.BufferAttribute(g.normals,      3));
    bg.setAttribute('uv',           new THREE.BufferAttribute(g.uvs,          2));
    bg.setAttribute('ao',           new THREE.BufferAttribute(g.ao,           1));
    bg.setAttribute('aRadius',      new THREE.BufferAttribute(g.radii,        1));
    bg.setAttribute('windWeight',   new THREE.BufferAttribute(g.windWeight,   1));
    bg.setAttribute('boneIndex',    new THREE.BufferAttribute(g.boneIndex,    1));
    bg.setAttribute('boneFraction', new THREE.BufferAttribute(g.boneFraction, 1));
    bg.setIndex(new THREE.BufferAttribute(g.indices, 1));
    return bg;
  }

  function buildForest(genome, env) {
    disposeTrees();

    // Push the (shared) bark genome onto the shared material.
    barkCtl.setGenome({
      woodiness:     genome.woodiness     ?? 1.0,
      pigment:       genome.pigment,
      barkHue:       genome.barkHue       ?? 0.75,
      barkLightness: genome.barkLightness ?? 0.30,
      barkRelief:    genome.barkRelief    ?? 1.0,
      barkLenticels: genome.barkLenticels ?? 0.0,
      barkScale:     genome.barkScale     ?? 0.5,
      barkOrient:    genome.barkOrient    ?? 0.7,
      barkPlates:    genome.barkPlates    ?? 0.45,
      barkShed:      genome.barkShed      ?? 0.0,
      barkUnderHue:  genome.barkUnderHue  ?? 0.75,
    });

    // CLUSTER-mode leaf sprite (multi-leaf card → cheap for a whole stand). The
    // venation/superformula raster is computed ONCE; each tree then wraps the same
    // canvases in its OWN CanvasTexture so per-tree disposal is clean (a shared
    // texture would be freed N times by createLeafMesh.dispose()'s material.map).
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
      leafMode:      'cluster',
    });
    const leafSrc    = texData && texData.source ? texData.source : null;
    const leafNrmSrc = texData && texData.normal ? texData.normal : null;

    const baseSeed = (genome.structuralSeed ?? 1) >>> 0;
    const pts = poissonDisk({
      width: PLOT, height: PLOT, minDist: MIN_SPACING,
      rng: mulberry32(baseSeed ^ POISSON_SALT), maxPoints: FOREST_COUNT,
    });

    for (let i = 0; i < pts.length; i++) {
      // Distinct individual: same genome, new structuralSeed. Each tree is built in
      // isolation: if resolve/generateFoliage/etc throws, dispose that tree's partial
      // GPU resources and skip it — one bad seed must not abort or leak the stand.
      const seed = (baseSeed + (i + 1) * SEED_STRIDE) >>> 0;
      let bg = null, leafCtl = null, normalTex = null;
      try {
        const res = resolve({ ...genome, structuralSeed: seed }, env);

        const g = buildBranchGeometry(res.graph, { maxWindBones: MAX_WIND_BONES });
        if (!g || !g.positions || g.positions.length === 0) continue;

        bg = buildBranchMesh(g);
        const branch = new THREE.Mesh(bg, barkCtl.material);
        branch.castShadow = false;
        branch.receiveShadow = false;

        leafCtl = createLeafMesh();
        if (leafSrc) {
          const colTex = new THREE.CanvasTexture(leafSrc);
          colTex.colorSpace = THREE.SRGBColorSpace;
          colTex.needsUpdate = true;
          if (leafNrmSrc) {
            normalTex = new THREE.CanvasTexture(leafNrmSrc);
            normalTex.colorSpace = THREE.NoColorSpace;
            normalTex.needsUpdate = true;
          }
          leafCtl.setTexture(colTex, normalTex);   // colTex becomes material.map → freed by leafCtl.dispose()
        }
        // Cluster mode: one sprite per clump anchor (use the bone-joined foliage so
        // boneIndex is valid; wind is off so it's inert but keeps the SoA consistent).
        const foliage = (res.genome && g.nodeToBone)
          ? generateFoliage(res.graph, res.genome, { nodeToBone: g.nodeToBone })
          : res.foliage;
        if (foliage) leafCtl.update(foliage);

        // Normalise this tree to TARGET_HEIGHT and stand it on the ground (base at y=0).
        const b = g.bounds;
        const treeH = Math.max(1e-3, b.max[1] - b.min[1]);
        const s = TARGET_HEIGHT / treeH;
        const group = new THREE.Group();
        group.add(branch, leafCtl.mesh);
        group.scale.setScalar(s);
        // Centre the plot around origin: Poisson is [0,PLOT]² → shift by -PLOT/2.
        group.position.set(pts[i].x - PLOT / 2, -b.min[1] * s, pts[i].y - PLOT / 2);

        forestGroup.add(group);
        trees.push({ group, geometry: bg, leafCtl, normalTex });
      } catch (err) {
        if (bg) bg.dispose();
        if (leafCtl) leafCtl.dispose();
        if (normalTex) normalTex.dispose();
        if (typeof console !== 'undefined') console.warn('forest tree build failed (skipped):', err);
      }
    }
    render();
  }

  function maybeRebuild() {
    if (disposed || !pending) return;
    if (!running) { dirty = true; return; }   // collapsed — defer to expand
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = 0;
      if (disposed || !pending) return;
      dirty = false;
      try { buildForest(pending.genome, pending.env); }
      catch (err) { if (typeof console !== 'undefined') console.warn('forest preview rebuild failed:', err); }
    }, 250);
  }

  let rafId = 0;
  let lastT = 0;
  function render() { if (!disposed) renderer.render(scene, camera); }
  function tick(t) {
    if (disposed) return;
    const dt = lastT ? (t - lastT) / 1000 : 0;
    lastT = t;
    forestGroup.rotation.y += SPIN_RATE * dt;
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
    // Mirror barkSwatch's API. genome + env are needed (we re-resolve per seed).
    setGenome(genome, env) {
      if (disposed || !genome) return;
      pending = { genome, env };
      maybeRebuild();
    },
    render,
    start() {
      if (disposed || running) return;
      running = true;
      // Rebuild immediately on (re)expand if the genome changed while collapsed.
      if (dirty && pending) {
        try { buildForest(pending.genome, pending.env); } catch (_) { /* ignore */ }
        dirty = false;
      }
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
      disposeTrees();
      if (envResult) envResult.dispose();
      barkCtl.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
      renderer.dispose();
    },
  };
}
