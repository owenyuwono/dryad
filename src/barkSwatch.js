// =============================================================================
// barkSwatch.js — dedicated mini-WebGL preview of the procedural bark material.
//
// WHY THIS IS THE ONE NEW WEBGL CONTEXT IN THE INSPECTOR:
//   The bark shader keys its feature size on object-space radius —
//     barkFeatureScale = clamp(length(vObjPos.xz), 0.04, 0.35)   (barkMaterial.js)
//   — so a flat 2D tile would mis-scale the furrows/lenticels/plate size. A
//   vertical tapered cylinder (radius ~0.05 at the top → ~0.30 at the base) is
//   the only faithful preview: it shows the full twig→trunk feature-scale range
//   (and the trunk-ring banding, which is gated to radius > 0.06) in one frame.
//
// CONTRACT / SAFETY:
//   - Owns its OWN WebGLRenderer + Scene + Camera + PMREM env. It NEVER touches
//     the hero renderer (viewer.js) — separate context, separate everything.
//   - Reuses the production createBarkMaterial() verbatim, so the swatch shows
//     the exact same shader the tree uses (zero new GLSL → no new onBeforeCompile
//     risk beyond what the tree already carries).
//   - The cylinder geometry carries the four attributes the bark vertex shader
//     declares — ao, windWeight, boneIndex, boneFraction — or the bark would
//     render with ao=0 (too dark). Wind stays OFF (uWindStrength=0 default), so
//     windSkinPosition early-returns rest position and the bone texture (null)
//     is never sampled.
//   - Read-only: setGenome() mirrors the resolved organism's bark axes. It does
//     not feed back into the generation pipeline.
//
// COLOR ENCODE:
//   This renderer uses the plain (no-composer) single-encode path:
//   ACESFilmic tonemap + SRGB output color space. That is one encode (no
//   double-tonemap "muddy brown" risk). It is intentionally NOT pixel-identical
//   to the hero's LinearSRGB + OutputPass path, but matches it closely.
// =============================================================================

import * as THREE from 'three';
import { createBarkMaterial } from './barkMaterial.js';
import { loadEnvironment } from './environment.js';

const CYL_RADIUS_TOP    = 0.05;   // twig end — fine bark, no rings (radius < 0.06)
const CYL_RADIUS_BOTTOM = 0.30;   // trunk end — coarse furrows + rings + lenticels
const CYL_HEIGHT        = 1.30;
const SPIN_RATE         = 0.35;   // rad/s — slow auto-rotate so all sides are seen

/**
 * createBarkSwatch(canvas)
 *
 * @param {HTMLCanvasElement} canvas - the <canvas> the swatch renders into.
 * @returns {{
 *   setGenome(barkGenes: object): void,
 *   render(): void,
 *   start(): void,
 *   stop(): void,
 *   resize(): void,
 *   dispose(): void,
 * }}
 */
export function createBarkSwatch(canvas) {
  if (!canvas) {
    // Headless / missing element — return an inert no-op handle so callers
    // never have to null-check (mirrors makeLeafClusterTexture's null guard).
    return {
      setGenome() {}, render() {}, start() {}, stop() {}, resize() {}, dispose() {},
    };
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.environmentIntensity = 0.6;   // matches viewer.js IBL weight

  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
  camera.position.set(1.45, 0.95, 1.45);
  camera.lookAt(0, CYL_HEIGHT * 0.5, 0);

  // --- Lights (mirror the hero scene's key + fill) ---
  const sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
  sun.position.set(2.5, 4.0, 2.0);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x88aacc, 0x443322, 0.3);
  scene.add(hemi);

  // --- Tapered cylinder along +Y, base at y=0 ---
  const geom = new THREE.CylinderGeometry(
    CYL_RADIUS_TOP, CYL_RADIUS_BOTTOM, CYL_HEIGHT,
    64,   // radialSegments — smooth silhouette
    1,    // heightSegments — bark detail is per-fragment, not per-vertex
    true, // openEnded — no caps (reads as a trunk segment)
  );
  geom.translate(0, CYL_HEIGHT * 0.5, 0);   // base at y=0, top at y=CYL_HEIGHT

  // The bark vertex shader declares: attribute float ao / windWeight /
  // boneIndex / boneFraction / aRadius. They MUST exist on the geometry — ao=1 (no
  // darkening); the three wind attributes are 0 (unused while wind is off).
  const vcount = geom.attributes.position.count;
  const ones  = new Float32Array(vcount).fill(1);
  const zeros = new Float32Array(vcount);   // already zero-filled
  geom.setAttribute('ao',           new THREE.BufferAttribute(ones, 1));
  geom.setAttribute('windWeight',   new THREE.BufferAttribute(zeros.slice(), 1));
  geom.setAttribute('boneIndex',    new THREE.BufferAttribute(zeros.slice(), 1));
  geom.setAttribute('boneFraction', new THREE.BufferAttribute(zeros.slice(), 1));
  // aRadius = true local radius. For this axis-centred cylinder that is exactly the
  // horizontal distance from the axis, length(x,z) per vertex (it tapers top→base).
  const pos = geom.attributes.position.array;
  const radii = new Float32Array(vcount);
  for (let i = 0; i < vcount; i++) {
    const x = pos[i * 3], z = pos[i * 3 + 2];
    radii[i] = Math.sqrt(x * x + z * z);
  }
  geom.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));

  const barkCtl = createBarkMaterial();
  const mesh = new THREE.Mesh(geom, barkCtl.material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  // --- HDRI IBL (async; the cylinder is lit by the direct lights until ready) ---
  let envResult = null;
  let disposed = false;
  loadEnvironment(renderer)
    .then((result) => {
      if (disposed) { result.dispose(); return; }
      envResult = result;
      scene.environment = result.envMap;
      render();
    })
    .catch(() => { /* swatch renders without IBL — non-fatal */ });

  let rafId = 0;
  let lastT = 0;
  let spinning = false;

  function render() {
    if (disposed) return;
    renderer.render(scene, camera);
  }

  function resize() {
    if (disposed) return;
    const w = canvas.clientWidth  || canvas.width  || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  function tick(t) {
    if (disposed) return;
    const dt = lastT ? (t - lastT) / 1000 : 0;
    lastT = t;
    mesh.rotation.y += SPIN_RATE * dt;
    render();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (disposed || spinning) return;
    spinning = true;
    lastT = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    spinning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  resize();

  return {
    /**
     * setGenome(barkGenes) — mirror the resolved organism's bark axes onto the
     * swatch. Same mapping/defaults as viewer.js setPlant's barkCtl.setGenome.
     */
    setGenome(g = {}) {
      barkCtl.setGenome({
        woodiness:      g.woodiness      ?? 1.0,
        pigment:        g.pigment,
        barkHue:        g.barkHue        ?? 0.85,
        barkLightness:  g.barkLightness  ?? 0.28,
        barkRelief:     g.barkRelief     ?? 1.0,
        barkLenticels:  g.barkLenticels  ?? 0.0,
        barkScale:      g.barkScale      ?? 0.5,
        barkOrient:     g.barkOrient     ?? 0.7,
        barkPlates:     g.barkPlates     ?? 0.45,
        barkShed:       g.barkShed       ?? 0.0,
        barkUnderHue:   g.barkUnderHue   ?? 0.75,
      });
      render();
    },
    render,
    start,
    stop,
    resize,
    dispose() {
      disposed = true;
      stop();
      if (envResult) envResult.dispose();
      barkCtl.dispose();
      geom.dispose();
      renderer.dispose();
    },
  };
}
