// =============================================================================
// viewer.js — single-specimen rasterized plant viewer
//
// Renders one resolved plant via a standard THREE.js mesh scene:
//   - Branch geometry: THREE.Mesh built from buildBranchGeometry(), shaded
//     by the procedural bark ShaderMaterial from createBarkMaterial().
//   - Foliage: createLeafMesh() InstancedMesh added to the SAME scene so
//     depth-testing between trunk and leaves happens automatically through
//     the standard pipeline — no manual two-pass compositing needed.
//
// Camera: PerspectiveCamera, fov = 50° (a calmer, more natural tree framing
// than the previous ~84° SDF-matched fov). The AABB fit uses
//   HALF_ANGLE = tan(25° in radians) = tan(0.4363) ≈ 0.4663
// so the camera distance that fits a given bounding radius is
//   distance = boundRadius / HALF_ANGLE * FIT_MARGIN
// (larger than the old fov would require, which is correct — a narrower fov
// needs more distance to frame the same object).
//
// Navigation:
//   Left-drag   → orbit (azimuth / elevation)
//   Wheel       → dolly (orbit radius)
//   Shift-drag or right-drag → pan (translate target in camera right/up plane)
//
// Auto-spin plays until first user interaction, then stops permanently.
// Orbit state persists across setPlant() calls; only the first call auto-frames.
//
// Usage:
//   import { createViewer } from './viewer.js';
//   const viewer = createViewer(canvas);
//   viewer.setPlant(resolved);     // call after resolve()
//   viewer.start();
//   viewer.resize();
//   viewer.dispose();
// =============================================================================

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass }       from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass }     from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildBranchGeometry, MAX_WIND_BONES } from './branchMesh.js';
import { createBarkMaterial, createBranchDepthMaterial } from './barkMaterial.js';
import { createLeafMesh }      from './leafMesh.js';
import { makeLeafClusterTexture } from './leafTexture.js';
import { loadEnvironment }     from './environment.js';
import { createGround }        from './ground.js';
import { WIND_UNIFORM_DEFAULTS } from './windGlsl.js';
import { WIND_TEX_WIDTH }      from './windSkinGlsl.js';
import { createWindSolver }    from './windSolver.js';
import { generateFoliage }     from './foliage.js';

// =============================================================================
// CONSTANTS
// =============================================================================

// FOV: 50° full vertical angle, chosen for a natural tree-portrait framing.
// Half angle = 25° = 25 * PI / 180 ≈ 0.4363 rad.
// HALF_ANGLE = tan(25°) ≈ 0.4663 (used in fit math: dist = radius / HALF_ANGLE).
const PERSP_FOV    = 50;
const HALF_ANGLE   = Math.tan((PERSP_FOV / 2) * (Math.PI / 180)); // ≈ 0.4663
const PERSP_NEAR   = 0.05;
const PERSP_FAR    = 100000.0; // large enough to encompass the sky sphere (scaled to 45000)

// Sky Preetham parameters — tuned for a pleasant mid-day sky, not blown-out white.
const SKY_TURBIDITY          = 6.0;
const SKY_RAYLEIGH           = 2.0;
const SKY_MIE_COEFFICIENT    = 0.005;
const SKY_MIE_DIRECTIONAL_G  = 0.8;
const SKY_SCALE              = 45000;

// Hemisphere fill colours to match the Preetham sky tint.
// These are set on both bark and leaf materials so shadow-side faces
// pick up a soft sky-blue from above and a warm bounce from below.
const SKY_COLOR    = new THREE.Vector3(0.55, 0.62, 0.72);
const GROUND_COLOR = new THREE.Vector3(0.22, 0.20, 0.16);

const FIT_MARGIN   = 1.25;  // extra breathing room around the AABB
const FIT_MIN      = 1.0;
const FIT_MAX      = 80.0;

const MIN_RADIUS   = 0.5;
const MAX_RADIUS   = 80.0;
const MAX_ELEVATION = (85 * Math.PI) / 180; // ±85°

const AUTO_SPIN_SPEED = 0.15; // radians per second

// Wind — default direction: normalize(1, 0.2), clamped strength range
const WIND_DIR_DEFAULT  = new THREE.Vector2(1, 0.2).normalize();
const WIND_STRENGTH_MIN = 0.0;
const WIND_STRENGTH_MAX = 1.5;
const WIND_STRENGTH_FALLBACK = 0.6; // used when genome wind value is unavailable

// =============================================================================
// INTERNAL — AABB fit from branch geometry bounds
// =============================================================================

/**
 * Compute camera fit from g.bounds (from buildBranchGeometry).
 * Returns { center: THREE.Vector3, fitRadius: number }.
 */
function computeFitFromBounds(bounds) {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;

  const hw = (maxX - minX) * 0.5;
  const hh = (maxY - minY) * 0.5;
  const hd = (maxZ - minZ) * 0.5;
  // Expand slightly to account for foliage beyond the branch bounds.
  const foliageFactor = 1.15;
  const boundRadius = Math.sqrt(hw * hw + hh * hh + hd * hd) * foliageFactor;

  // distance = radius / tan(halfFov) * margin
  const raw = (boundRadius / HALF_ANGLE) * FIT_MARGIN;
  const fitRadius = Math.max(FIT_MIN, Math.min(raw, FIT_MAX));

  return { center: new THREE.Vector3(cx, cy, cz), fitRadius };
}

// Fallback fit when the geometry is empty (zero bones).
function defaultFit() {
  return { center: new THREE.Vector3(0, 0, 0), fitRadius: 4.5 };
}

// =============================================================================
// INTERNAL — camera position from orbit state
// =============================================================================

function orbitCamPos(azimuth, elevation, radius, target) {
  const cosEl = Math.cos(elevation);
  return new THREE.Vector3(
    target.x + radius * cosEl * Math.sin(azimuth),
    target.y + radius * Math.sin(elevation),
    target.z + radius * cosEl * Math.cos(azimuth)
  );
}

// =============================================================================
// PUBLIC FACTORY
// =============================================================================

/**
 * createViewer(canvas)
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{
 *   setPlant(resolved: object): void,
 *   start(): void,
 *   resize(): void,
 *   dispose(): void,
 *   getStats(): object,
 *   branchMesh: THREE.Mesh,
 *   leafMesh: THREE.InstancedMesh,
 *   barkCtl: object,
 *   leafCtl: object,
 *   setRenderMode(mode: string): void,
 *   attachRenderModeController(ctrl: object): void,
 *   setRootsRevealed(revealed: boolean): void,
 *   setWindEnabled(enabled: boolean): void,
 *   setWindStrength(strength: number): void,
 * }}
 */
export function createViewer(canvas) {
  // ---------------------------------------------------------------------------
  // Render-mode controller slot
  // ---------------------------------------------------------------------------
  let _renderModeController = null;

  // ---------------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // OutputPass applies ACES tonemapping + sRGB conversion to the canvas.
  // Intermediate EffectComposer render targets must stay LINEAR so that
  // conversion only happens once (in OutputPass).  Setting SRGBColorSpace
  // here would make the renderer gamma-encode its own internal targets,
  // then OutputPass would re-encode them — double sRGB + double tonemapping
  // produces the muddy washed-out brown regression.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);

  // ---------------------------------------------------------------------------
  // Scene + camera
  // ---------------------------------------------------------------------------
  const scene = new THREE.Scene();

  const perspCam = new THREE.PerspectiveCamera(
    PERSP_FOV,
    (canvas.clientWidth || window.innerWidth) / (canvas.clientHeight || window.innerHeight),
    PERSP_NEAR,
    PERSP_FAR
  );

  // ---------------------------------------------------------------------------
  // Procedural sky (Preetham model via Sky addon).
  //
  // Sky renders as a large sphere that completely surrounds the scene.  Its
  // material writes depth but we scale it to SKY_SCALE (45000 units) so it
  // is always behind all tree geometry given our camera distances.  The camera
  // far plane is raised to 100 000 to ensure the sphere isn't clipped.
  //
  // toneMappingExposure on the renderer tames the raw Preetham luminance so
  // the sky reads as a pleasant daytime blue rather than an overexposed white.
  // ACESFilmic also lifts the bark/leaf darks very slightly — verified pleasant.
  // ---------------------------------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(SKY_SCALE);
  scene.add(sky);

  const skyUniforms = sky.material.uniforms;
  skyUniforms['turbidity'].value         = SKY_TURBIDITY;
  skyUniforms['rayleigh'].value          = SKY_RAYLEIGH;
  skyUniforms['mieCoefficient'].value    = SKY_MIE_COEFFICIENT;
  skyUniforms['mieDirectionalG'].value   = SKY_MIE_DIRECTIONAL_G;

  // sunPosition is set from the light direction in setSkyFromLightDir() and
  // called each time setPlant() provides a (potentially new) lightDir.
  const _sunPos = new THREE.Vector3();

  /**
   * Derive a sky sun position vector from a world-space light direction.
   * The Sky shader expects a direction FROM the origin TOWARD the sun, which
   * is the same convention as uLightDir.  We normalise and apply it directly.
   *
   * @param {THREE.Vector3} lightDir  world-space unit vector toward the key light
   */
  function setSkyFromLightDir(lightDir) {
    _sunPos.copy(lightDir).normalize();
    skyUniforms['sunPosition'].value.copy(_sunPos);
  }

  // Default sun position matches the default light direction used by the materials.
  setSkyFromLightDir(new THREE.Vector3(0.5, 1.0, 0.5).normalize());

  // ---------------------------------------------------------------------------
  // Lights — DirectionalLight (sun) + HemisphereLight (ambient fill)
  // ---------------------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(0xfff4e0, 3.0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.02;
  sunLight.position.set(25, 50, 25); // default; overridden in setPlant
  sunLight.target.position.set(0, 0, 0);
  sunLight.target.updateMatrixWorld();
  scene.add(sunLight);
  scene.add(sunLight.target);

  const hemiLight = new THREE.HemisphereLight(0x88aacc, 0x443322, 0.3);
  scene.add(hemiLight);

  /**
   * Size the shadow camera frustum to cover the tree's AABB.
   * Called from setPlant() after bounds are known.
   *
   * @param {{ min: number[], max: number[] }} bounds
   */
  function updateShadowCamera(bounds) {
    const [minX, minY, minZ] = bounds.min;
    const [maxX, maxY, maxZ] = bounds.max;

    const halfW = (maxX - minX) / 2;
    const halfD = (maxZ - minZ) / 2;
    const halfExtent = Math.max(halfW, halfD) + 5; // +5 margin

    const cam = sunLight.shadow.camera;
    cam.left   = -halfExtent;
    cam.right  =  halfExtent;
    cam.top    =  halfExtent;
    cam.bottom = -halfExtent;
    cam.near   = -50;
    cam.far    = maxY + 50;
    cam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------------
  // Ground plane
  // ---------------------------------------------------------------------------
  const ground = createGround();
  scene.add(ground.mesh);

  // ---------------------------------------------------------------------------
  // IBL — fire-and-forget; scene.environment set once the HDR loads.
  // createViewer stays synchronous so main.js needs no changes.
  // ---------------------------------------------------------------------------
  let envMapResult = null;
  loadEnvironment(renderer).then((result) => {
    envMapResult = result;
    scene.environment = result.envMap;
    // Pull IBL down so the directional sun's gradient reads clearly.
    // At 1.0 (Three default) the HDRI washes out shadowed faces.
    scene.environmentIntensity = 0.6;
    // Do NOT set scene.background — keep the procedural Sky visible.
  }).catch((err) => {
    console.warn('IBL load failed, continuing without env map:', err);
  });

  // ---------------------------------------------------------------------------
  // Branch mesh — geometry rebuilt each setPlant(); material persists.
  // ---------------------------------------------------------------------------
  const barkCtl  = createBarkMaterial();
  // Placeholder geometry (0 vertices) so the mesh exists before first setPlant.
  let branchGeometry = new THREE.BufferGeometry();
  const branchMesh   = new THREE.Mesh(branchGeometry, barkCtl.material);
  branchMesh.castShadow = true;
  branchMesh.receiveShadow = true;
  scene.add(branchMesh);

  // ---------------------------------------------------------------------------
  // Leaf mesh — added to the same scene so depth sorting happens automatically.
  // ---------------------------------------------------------------------------
  const leaves = createLeafMesh();
  leaves.mesh.castShadow = true;
  leaves.mesh.receiveShadow = true;
  scene.add(leaves.mesh);

  // Cache the real leaf PBR material so uniform updates in setPlant() always
  // reach the real material even when a render-mode override is active on the mesh.
  const realLeafPbrMaterial = leaves.mesh.material;

  // Current leaf texture — tracked for disposal on next setPlant call.
  let currentLeafTex = null;

  // ---------------------------------------------------------------------------
  // Post-processing composer
  // RenderPass → UnrealBloomPass → SMAAPass → OutputPass
  //
  // Double-tonemapping avoidance:
  //   OutputPass applies ACES tone mapping + sRGB conversion once (it reads
  //   renderer.toneMapping and renderer.outputColorSpace). The intermediate
  //   render targets used by bloom are linear RGBA16F — no colour-space
  //   conversion happens there. We do NOT call renderer.render() directly
  //   in the frame loop; composer.render() drives everything.
  // ---------------------------------------------------------------------------
  const w0 = canvas.clientWidth  || window.innerWidth;
  const h0 = canvas.clientHeight || window.innerHeight;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, perspCam));
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(w0, h0),
    0.15,  // strength — subtle
    0.4,   // radius
    1.1    // threshold — raised to prevent residual bright bark pixels from blooming
  ));
  composer.addPass(new SMAAPass(w0, h0));
  composer.addPass(new OutputPass());

  // ---------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------
  const clock = new THREE.Clock();

  // ---------------------------------------------------------------------------
  // Orbit state — persists across setPlant() calls
  // ---------------------------------------------------------------------------
  let azimuth   = 0.3;
  let elevation = 0.25;
  let radius    = 5.0;
  let target    = new THREE.Vector3(0, 0, 0);

  // Only auto-frame on the very first setPlant call.
  let firstPlant = true;

  // Whether roots are currently revealed (ground faded, camera uses true bounds).
  let rootsRevealed = false;

  // Cached branch-geometry bounds from the most recent setPlant() call.
  // Needed so setRootsRevealed() can recompute fit/shadows without a regenerate.
  let lastBounds = null;

  // ---------------------------------------------------------------------------
  // Wind state
  // ---------------------------------------------------------------------------
  let windEnabled    = false;
  let windStrength   = WIND_STRENGTH_FALLBACK; // target strength, applied when enabled
  let windTime       = WIND_UNIFORM_DEFAULTS.uTime;

  // Bone DataTexture — allocated/replaced each setPlant call (disposed on regenerate).
  // Layout: width=WIND_TEX_WIDTH (4), height=MAX_WIND_BONES; each row is one bone mat4
  // stored as 4 RGBA32F texels (columns 0-3 of the mat4, column-major).
  // The backing Float32Array is reused as the solver's output buffer (zero-copy).
  let boneTex = null;

  // Per-frame wind solver — created from bones_wind after each buildBranchGeometry call.
  let windSolver = null;

  // Branch custom depth material — created once, assigned to branchMesh.customDepthMaterial.
  // Recreated each setPlant so it binds the fresh DataTexture.
  let branchDepthMat = null;

  /**
   * Write per-frame wind uniforms to one material's _windUniforms block.
   * Called for all four materials: bark, bark-depth, leaf, leaf-depth.
   * Guards each field access so materials with partial _windUniforms still work.
   */
  function applyWindUniforms(material, strength) {
    const wu = material._windUniforms;
    if (!wu) return;
    if (wu.uTime)         wu.uTime.value         = windTime;
    if (wu.uWindStrength) wu.uWindStrength.value  = strength;
    if (wu.uWindDir)      wu.uWindDir.value.copy(WIND_DIR_DEFAULT);
    if (wu.uBoneTex)      wu.uBoneTex.value       = boneTex;
    if (wu.uBoneCount !== undefined) wu.uBoneCount.value = windSolver ? windSolver.boneCount : 0;
  }

  // ---------------------------------------------------------------------------
  // Auto-spin — plays until first pointer/wheel interaction
  // ---------------------------------------------------------------------------
  let autoSpin = true;

  function stopAutoSpin() {
    autoSpin = false;
  }

  // ---------------------------------------------------------------------------
  // Current plant state (for getStats)
  // ---------------------------------------------------------------------------
  let currentBoneCount = 0;

  // ---------------------------------------------------------------------------
  // Pointer / wheel event handling
  // ---------------------------------------------------------------------------
  let pointerDown = false;
  let lastX       = 0;
  let lastY       = 0;
  let isPan       = false;
  let pointerId   = null;

  function onPointerDown(e) {
    isPan = e.shiftKey || e.button === 2;
    pointerDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    stopAutoSpin();
  }

  function onPointerMove(e) {
    if (!pointerDown || e.pointerId !== pointerId) return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isPan) {
      const camPos  = orbitCamPos(azimuth, elevation, radius, target);
      const forward = new THREE.Vector3().subVectors(target, camPos).normalize();
      const right   = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const up      = new THREE.Vector3().crossVectors(right, forward);

      const panScale = radius * 0.0015;
      target.addScaledVector(right, -dx * panScale);
      target.addScaledVector(up,    -dy * panScale);
    } else {
      const w = canvas.clientWidth  || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      azimuth   -= dx / w * Math.PI * 1.5;
      elevation += dy / h * Math.PI;
      elevation  = Math.max(-MAX_ELEVATION, Math.min(MAX_ELEVATION, elevation));
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== pointerId) return;
    pointerDown = false;
    pointerId   = null;
  }

  function onWheel(e) {
    e.preventDefault();
    stopAutoSpin();
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius * factor));
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  canvas.addEventListener('pointerdown',   onPointerDown);
  canvas.addEventListener('pointermove',   onPointerMove);
  canvas.addEventListener('pointerup',     onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel',         onWheel, { passive: false });
  canvas.addEventListener('contextmenu',   onContextMenu);

  // ---------------------------------------------------------------------------
  // Render resolution (drawing-buffer size)
  // ---------------------------------------------------------------------------
  const resolution = new THREE.Vector2();

  function updateResolution() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w   = (canvas.clientWidth  || window.innerWidth)  * dpr;
    const h   = (canvas.clientHeight || window.innerHeight) * dpr;
    resolution.set(w, h);
  }
  updateResolution();

  // ---------------------------------------------------------------------------
  // Stats — FPS via exponential moving average
  // ---------------------------------------------------------------------------
  let fpsSmoothEma  = 0;
  let lastFrameTime = 0;
  const FPS_EMA_ALPHA = 0.1;

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------
  let loopRunning = false;
  let rafId       = null;

  function frame() {
    rafId = requestAnimationFrame(frame);

    // FPS measurement
    const now = performance.now();
    if (lastFrameTime > 0) {
      const dtMs = now - lastFrameTime;
      if (dtMs > 0) {
        const instantFps = 1000 / dtMs;
        fpsSmoothEma = fpsSmoothEma === 0
          ? instantFps
          : fpsSmoothEma + FPS_EMA_ALPHA * (instantFps - fpsSmoothEma);
      }
    }
    lastFrameTime = now;

    const dt = clock.getDelta();

    // Wind time — always advance so the shader position is continuous when
    // wind is toggled back on.  Strength is 0 when wind is disabled, so the
    // solver emits identity matrices → exact rest pose regardless of uTime.
    windTime += dt;
    const activeStrength = windEnabled ? windStrength : 0;

    // Hierarchical wind solver: solve bone matrices, upload to DataTexture,
    // then push all uniforms to all four materials (bark, bark-depth, leaf, leaf-depth).
    // When strength is 0, solver emits identity → no displacement (calm guarantee).
    if (windSolver !== null && boneTex !== null) {
      windSolver.solve(
        boneTex.image.data,
        windTime,
        activeStrength,
        WIND_DIR_DEFAULT.x,
        WIND_DIR_DEFAULT.y,
      );
      boneTex.needsUpdate = true;
    }

    // Push uniforms to all four materials.
    // applyWindUniforms guards each field, so materials with partial _windUniforms
    // (or no _windUniforms) are safe.
    applyWindUniforms(barkCtl.material, activeStrength);
    if (branchDepthMat !== null) {
      applyWindUniforms(branchDepthMat.depthMaterial, activeStrength);
    }
    applyWindUniforms(realLeafPbrMaterial, activeStrength);
    const leafDepthMat = leaves.mesh.customDepthMaterial;
    if (leafDepthMat) {
      applyWindUniforms(leafDepthMat, activeStrength);
    }

    if (autoSpin) {
      azimuth += AUTO_SPIN_SPEED * dt;
    }

    const camPos = orbitCamPos(azimuth, elevation, radius, target);
    perspCam.position.copy(camPos);
    perspCam.up.set(0, 1, 0);
    perspCam.lookAt(target);
    perspCam.updateMatrixWorld();

    // Composer drives rendering: RenderPass → bloom → SMAA → OutputPass (sRGB+ACES).
    composer.render();
  }

  // ---------------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------------

  return {
    /**
     * setPlant(resolved)
     *
     * Rebuilds branch geometry and refreshes leaf instances from a resolved plant.
     * Orbit state persists; only the first call auto-frames the camera.
     *
     * resolved must include: graph, foliage, pigment, woodiness, lightDir, boneCount.
     *
     * @param {object} resolved  Output of resolve().
     */
    setPlant(resolved) {
      currentBoneCount = resolved.boneCount ?? 0;

      // -----------------------------------------------------------------------
      // 1. Branch geometry
      // -----------------------------------------------------------------------
      const g = buildBranchGeometry(resolved.graph);

      // Dispose previous geometry to avoid GPU leaks (slider edits fire often).
      branchGeometry.dispose();
      branchGeometry = new THREE.BufferGeometry();

      branchGeometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      branchGeometry.setAttribute('normal',   new THREE.BufferAttribute(g.normals,   3));
      branchGeometry.setAttribute('uv',       new THREE.BufferAttribute(g.uvs,       2));
      // barkMaterial REQUIRES a per-vertex float 'ao' attribute.
      branchGeometry.setAttribute('ao',       new THREE.BufferAttribute(g.ao,        1));
      // barkMaterial wind sway reads a per-vertex 'windWeight' attribute
      // (0 = rigid trunk/roots, 1 = flexible twigs).
      branchGeometry.setAttribute('windWeight', new THREE.BufferAttribute(g.windWeight, 1));
      // Skeletal wind skinning: per-vertex bone index and intra-chain fraction.
      // boneIndex: which wind-bone (chain) this vertex belongs to [0, boneCount).
      // boneFraction: normalized arc position along the chain [0=pivot, 1=tip].
      // These are consumed by windSkinPosition() in barkMaterial's vertex shader.
      branchGeometry.setAttribute('boneIndex',    new THREE.BufferAttribute(g.boneIndex,    1));
      branchGeometry.setAttribute('boneFraction', new THREE.BufferAttribute(g.boneFraction, 1));
      branchGeometry.setIndex(new THREE.BufferAttribute(g.indices, 1));

      branchMesh.geometry = branchGeometry;
      branchMesh.castShadow = true;
      branchMesh.receiveShadow = true;

      // -----------------------------------------------------------------------
      // 1b. Bone DataTexture + wind solver
      //
      // Layout: width=WIND_TEX_WIDTH (4), height=MAX_WIND_BONES.
      //   Row b = bone b. Columns 0-3 = mat4 column-major (4 RGBA32F texels).
      //   Bone b occupies floats [b*16 .. b*16+15] in the backing array.
      //
      // The solver writes directly into the DataTexture's backing Float32Array
      // (boneTex.image.data) — zero-copy between solver output and GPU upload.
      // After solve(), set boneTex.needsUpdate=true to upload on next frame.
      //
      // Dispose previous DataTexture to avoid GPU leaks across regenerates.
      // -----------------------------------------------------------------------
      if (boneTex !== null) {
        boneTex.dispose();
        boneTex = null;
      }

      // Allocate MAX_WIND_BONES rows regardless of actual bone count so the
      // texture dimensions never change between trees (avoids shader recompile).
      // Only the first boneCount rows are meaningful; the rest stay identity
      // (Float32Array default zeros → non-identity, so solver must init all used rows).
      const boneMatrixFloats = new Float32Array(WIND_TEX_WIDTH * MAX_WIND_BONES * 4);
      boneTex = new THREE.DataTexture(
        boneMatrixFloats,
        WIND_TEX_WIDTH,   // width  = 4 texels per bone row
        MAX_WIND_BONES,   // height = one row per bone (up to budget)
        THREE.RGBAFormat,
        THREE.FloatType,
      );
      boneTex.magFilter = THREE.NearestFilter;
      boneTex.minFilter = THREE.NearestFilter;
      boneTex.generateMipmaps = false;
      boneTex.flipY = false; // texelFetch(ivec2(col, row)) must address row 0 at bottom
      boneTex.needsUpdate = true;

      // Create the per-frame solver from the bone hierarchy tables.
      windSolver = createWindSolver(g.bones_wind);

      // Run an initial solve at strength=0 so all matrices are identity on first frame.
      windSolver.solve(boneMatrixFloats, windTime, 0, WIND_DIR_DEFAULT.x, WIND_DIR_DEFAULT.y);
      boneTex.needsUpdate = true;

      // -----------------------------------------------------------------------
      // 1c. Branch custom depth material (shadow skinning)
      //
      // Dispose previous depth material before creating a new one so GPU
      // resources from the old program are released on regenerate.
      // -----------------------------------------------------------------------
      if (branchDepthMat !== null) {
        branchDepthMat.depthMaterial.dispose();
        branchDepthMat = null;
      }
      branchDepthMat = createBranchDepthMaterial();
      branchMesh.customDepthMaterial = branchDepthMat.depthMaterial;

      // -----------------------------------------------------------------------
      // 2. Bark material uniforms
      // -----------------------------------------------------------------------
      const lightDirVec = new THREE.Vector3(
        resolved.lightDir[0],
        resolved.lightDir[1],
        resolved.lightDir[2]
      ).normalize();

      // setGenome() is the correct API on barkCtl — updates uWoodiness/uPigment
      // uniforms in-place without triggering a shader recompile.
      // lightDir/skyColor/groundColor are not bark uniforms; they drive the scene
      // lights and are handled below via sunLight + setSkyFromLightDir.
      barkCtl.setGenome({
        woodiness: resolved.woodiness ?? 0.88,
        pigment:   resolved.pigment,
      });

      // Align the procedural sky's sun with the scene light direction so the
      // visible sun disc and the key light agree.
      setSkyFromLightDir(lightDirVec);

      // -----------------------------------------------------------------------
      // 3. Sun light — sync position and shadow camera to current tree
      // -----------------------------------------------------------------------
      sunLight.position.copy(lightDirVec.clone().multiplyScalar(50));
      sunLight.target.position.set(0, 0, 0);
      sunLight.target.updateMatrixWorld();

      if (g.vertexCount > 0) {
        // Clamp the vertical extent used for shadow/camera framing so that hidden
        // below-ground roots do not push the frustum underground or zoom the camera
        // out to frame buried geometry (Risk B fix).
        //
        // When roots ARE revealed we use the true bounds so the full root system
        // fits in the shadow frustum and the camera frames roots + canopy together.
        const shadowBounds = rootsRevealed ? g.bounds : {
          min: [g.bounds.min[0], Math.max(g.bounds.min[1], 0), g.bounds.min[2]],
          max: g.bounds.max,
        };
        updateShadowCamera(shadowBounds);
      }

      // -----------------------------------------------------------------------
      // 4. Ground — sit at trunk-base origin (y=0), NOT at bounds.min[1].
      //
      //    Roots dive below y=0; pinning the ground here keeps it at the soil
      //    surface regardless of how deep the root system extends underground
      //    (Risk B fix: ground must NOT follow roots underground).
      // -----------------------------------------------------------------------
      ground.setBaseY(0);

      // -----------------------------------------------------------------------
      // 5. Leaves
      // -----------------------------------------------------------------------
      if (resolved.foliage) {
        // Dispose previous leaf texture.
        if (currentLeafTex !== null) {
          currentLeafTex.dispose();
          currentLeafTex = null;
        }

        const texData = makeLeafClusterTexture({
          pigment: resolved.pigment,
          breadth: resolved.foliage.shape,
          seed:    1,
        });
        if (texData !== null) {
          const tex = new THREE.CanvasTexture(texData.source);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          currentLeafTex = tex;
          leaves.setTexture(tex);
        }

        // Leaf→bone join (Task 5a):
        //
        // resolved.foliage was generated by resolve() without nodeToBone, so all
        // leaf boneIndex values default to 0 (pinned to trunk — wrong for canopy wind).
        //
        // If the caller provides resolved.genome (the full genome object), we re-run
        // generateFoliage with { nodeToBone: g.nodeToBone } to get correctly assigned
        // boneIndex values. The SoA is byte-identical to resolved.foliage in all other
        // fields (same graph + same rng seed) — only boneIndex changes.
        //
        // When genome is absent (main.js doesn't currently pass it), we fall back to
        // resolved.foliage as-is. Leaves will use bone 0 (rigid trunk) so they won't
        // follow individual branches, but the scene is still correct and stable.
        let foliageForUpdate = resolved.foliage;
        if (resolved.genome && g.nodeToBone) {
          foliageForUpdate = generateFoliage(resolved.graph, resolved.genome, {
            nodeToBone: g.nodeToBone,
          });
        }

        leaves.update(foliageForUpdate);
        leaves.mesh.castShadow = true;
        leaves.mesh.receiveShadow = true;

        // Update the leaf shader's uLightDir so the backlit translucency glow
        // tracks the scene sun direction.  _customUniforms is set in
        // leafMesh.js onBeforeCompile — it may be undefined if the material
        // has not compiled yet on the very first frame, so guard the access.
        // uSkyColor / uGroundColor are NOT declared in the leaf shader;
        // hemisphere fill is provided by the HemisphereLight via Three's PBR path.
        const leafUniforms = realLeafPbrMaterial._customUniforms;
        if (leafUniforms && leafUniforms.uLightDir) {
          leafUniforms.uLightDir.value.copy(lightDirVec);
        }
      }

      // -----------------------------------------------------------------------
      // 6. Camera auto-frame (first plant only)
      // -----------------------------------------------------------------------
      if (firstPlant) {
        const fitBounds = (!rootsRevealed && g.vertexCount > 0) ? {
          min: [g.bounds.min[0], Math.max(g.bounds.min[1], 0), g.bounds.min[2]],
          max: g.bounds.max,
        } : g.bounds;
        const fit = g.vertexCount > 0
          ? computeFitFromBounds(fitBounds)
          : defaultFit();
        target    = fit.center.clone();
        radius    = fit.fitRadius;
        firstPlant = false;
      }
      // Subsequent calls: preserve current azimuth, elevation, radius, target
      // so the user's orbit state survives regenerate() / slider changes.

      // -----------------------------------------------------------------------
      // 7. Cache bounds for use by setRootsRevealed().
      // -----------------------------------------------------------------------
      lastBounds = g.vertexCount > 0 ? g.bounds : null;
    },

    /**
     * start()
     * Begin the render loop. Idempotent.
     */
    start() {
      if (loopRunning) return;
      loopRunning = true;
      clock.start();
      frame();
    },

    /**
     * resize()
     * Call when the canvas/window size changes.
     */
    resize() {
      const w = canvas.clientWidth  || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setSize(w, h);
      perspCam.aspect = w / h;
      perspCam.updateProjectionMatrix();
      composer.setSize(w, h);
      updateResolution();
    },

    /**
     * getStats()
     *
     * Returns a fresh snapshot of render statistics.
     *
     * @returns {{
     *   fps:          number,
     *   triangles:    number,
     *   drawCalls:    number,
     *   leafClusters: number,
     *   bones:        number,
     *   resolution:   [number, number],
     * }}
     */
    getStats() {
      return {
        fps:          fpsSmoothEma,
        triangles:    renderer.info.render.triangles,
        drawCalls:    renderer.info.render.calls,
        leafClusters: leaves.mesh.count,
        bones:        currentBoneCount,
        resolution:   [renderer.domElement.width, renderer.domElement.height],
      };
    },

    /**
     * dispose()
     * Stop loop and release WebGL resources.
     */
    dispose() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      loopRunning = false;

      canvas.removeEventListener('pointerdown',   onPointerDown);
      canvas.removeEventListener('pointermove',   onPointerMove);
      canvas.removeEventListener('pointerup',     onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel',         onWheel);
      canvas.removeEventListener('contextmenu',   onContextMenu);

      if (currentLeafTex !== null) {
        currentLeafTex.dispose();
        currentLeafTex = null;
      }
      if (boneTex !== null) {
        boneTex.dispose();
        boneTex = null;
      }
      if (branchDepthMat !== null) {
        branchDepthMat.depthMaterial.dispose();
        branchDepthMat = null;
      }
      branchGeometry.dispose();
      barkCtl.dispose();
      leaves.dispose();
      sky.material.dispose();
      sky.geometry.dispose();
      composer.dispose();
      sunLight.dispose();
      hemiLight.dispose();
      ground.dispose();
      if (envMapResult) envMapResult.dispose();
      renderer.dispose();
    },

    // -------------------------------------------------------------------------
    // Exposed render-mode surface
    // -------------------------------------------------------------------------
    branchMesh,
    leafMesh: leaves.mesh,
    barkCtl,
    leafCtl: leaves,

    setRenderMode(mode) {
      if (_renderModeController) _renderModeController.setMode(mode);
      // else: no-op until controller attached
    },

    attachRenderModeController(ctrl) {
      _renderModeController = ctrl;
    },

    /**
     * setWindEnabled(enabled)
     *
     * Toggles animated wind displacement on/off.  When false, uWindStrength is
     * forced to 0 on both materials so the tree is exactly static.  When true,
     * the current target windStrength is applied.  uTime continues advancing
     * regardless so toggling back on resumes from the correct phase.
     *
     * @param {boolean} enabled
     */
    setWindEnabled(enabled) {
      windEnabled = enabled;
      const strength = enabled ? windStrength : 0;
      applyWindUniforms(barkCtl.material, strength);
      if (branchDepthMat !== null) {
        applyWindUniforms(branchDepthMat.depthMaterial, strength);
      }
      applyWindUniforms(realLeafPbrMaterial, strength);
      const leafDepthMat = leaves.mesh.customDepthMaterial;
      if (leafDepthMat) applyWindUniforms(leafDepthMat, strength);
    },

    /**
     * setWindStrength(strength)
     *
     * Sets the target wind strength (clamped to [0, 1.5]).  Applied immediately
     * if wind is currently enabled.
     *
     * @param {number} strength
     */
    setWindStrength(strength) {
      windStrength = Math.max(WIND_STRENGTH_MIN, Math.min(WIND_STRENGTH_MAX, strength));
      if (windEnabled) {
        applyWindUniforms(barkCtl.material, windStrength);
        if (branchDepthMat !== null) {
          applyWindUniforms(branchDepthMat.depthMaterial, windStrength);
        }
        applyWindUniforms(realLeafPbrMaterial, windStrength);
        const leafDepthMat = leaves.mesh.customDepthMaterial;
        if (leafDepthMat) applyWindUniforms(leafDepthMat, windStrength);
      }
    },

    /**
     * setRootsRevealed(revealed)
     *
     * Fades the ground plane so the underground root system is visible, and
     * adjusts camera/shadow framing to include below-ground geometry when
     * revealing (or exclude it when hiding).
     *
     * Called by the UI reveal-toggle button (wired in main.js).  The concurrent
     * integration engineer owns that button's DOM and IIFE wiring.
     *
     * @param {boolean} revealed
     */
    setRootsRevealed(revealed) {
      rootsRevealed = revealed;
      ground.setRevealed(revealed);

      // Reframe camera and shadow frustum to include (or exclude) below-ground
      // roots.  This is a deliberate user action so reframing is intentional —
      // unlike setPlant() subsequent calls which preserve the user's orbit state.
      if (lastBounds === null) return;

      // When revealing: use true bounds so the full root system is framed.
      // When hiding:    clamp min[1] to 0 so the camera returns to the canopy.
      const effectiveBounds = revealed ? lastBounds : {
        min: [lastBounds.min[0], Math.max(lastBounds.min[1], 0), lastBounds.min[2]],
        max: lastBounds.max,
      };

      updateShadowCamera(effectiveBounds);

      const fit = computeFitFromBounds(effectiveBounds);
      target = fit.center.clone();
      radius = fit.fitRadius;
    },
  };
}
