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
import { makeLeafClusterTexture, leafWidthFactor, leafLengthFactor } from './leafTexture.js';
import { loadEnvironment }     from './environment.js';
import { createGround }        from './ground.js';
import { WIND_UNIFORM_DEFAULTS } from './windGlsl.js';
import { WIND_TEX_WIDTH }      from './windSkinGlsl.js';
import { createWindSolver }    from './windSolver.js';
import { generateFoliage, expandClumpsToLeaves, expandClumpsToCrossedCards } from './foliage.js';

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

// First-person walk mode.
// Eye height and move speed are derived from the scene scale (orbit radius)
// each time enterWalk() runs, so it feels right for both the single specimen
// (~a few units tall) and a forest (trees ~1.5 units tall) — see enterWalk().
const WALK_PITCH_LIMIT  = 1.45;   // clamp look up/down to ±~83°
const WALK_LOOK_SENS    = 0.0025; // radians per pixel of mouse movement
const WALK_EYE_FRAC     = 0.06;   // eye height as a fraction of orbit radius
const WALK_SPEED_FRAC   = 0.55;   // walk speed (units/s) as a fraction of orbit radius
const WALK_EYE_MIN      = 0.3;    // floor so tiny scenes still have a sensible eye height
const WALK_SPEED_MIN    = 1.0;    // floor so walking never feels glacial
const WALK_RUN_MULT     = 2.0;    // shift-to-run multiplier

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
  // Stats: composer.render() issues several render() calls per frame (shadow
  // pass, scene, bloom, SMAA, output). With autoReset=true, renderer.info would
  // reset on each and end up reflecting only the final fullscreen pass (1 tri,
  // 1 call). Disable autoReset and reset once per frame so info.render
  // accumulates the real per-frame totals (scene + shadows + post passes).
  renderer.info.autoReset = false;
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
  let currentLeafNormalTex = null;

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

  // ---------------------------------------------------------------------------
  // First-person walk-mode state
  //
  // When walkMode is true the frame loop drives perspCam from walkPos + yaw/pitch
  // instead of the orbit state. The orbit state (azimuth/elevation/radius/target)
  // is left untouched so exitWalk() resumes the prior orbit view exactly.
  // ---------------------------------------------------------------------------
  let walkMode    = false;
  const walkPos   = new THREE.Vector3();
  let walkYaw     = 0;       // heading: 0 looks toward +Z, increases CCW
  let walkPitch   = 0;       // look up/down, clamped to ±WALK_PITCH_LIMIT
  let walkEyeY    = 1.6;     // fixed eye height (world units), set in enterWalk
  let walkSpeed   = 3.0;     // move speed (units/s), set in enterWalk
  const walkKeys  = new Set();
  const _walkLookScratch = new THREE.Vector3();

  // Forest mode: a Group of N stand trees added to the scene (built by forest.js).
  // When set, the single specimen meshes are hidden and the camera frames the stand.
  let _forestGroup = null;
  // Per-frame wind driver for the active forest stand (forestHandle.updateWind),
  // stored by setForest and cleared by clearForest. null when no forest is shown.
  // Called from frame() with the same time/strength/direction as the single specimen.
  let _forestWindUpdate = null;
  // Intended specimen part-visibility (the inspector isolate-part toggles set these).
  // setForest force-hides the meshes WITHOUT touching this intent, so clearForest can
  // restore exactly what the user had toggled, not a blind `true`.
  let _foliageVisible = true;
  let _structureVisible = true;

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

  // Leaf rendering mode: 'single' = one leaf per card (clumps fanned out by
  // expandClumpsToLeaves); 'cluster' = a multi-leaf sprig painted into one card
  // (cheaper — far fewer instances/triangles). Read in setPlant; toggled via
  // setLeafMode() + a caller re-render.
  let _leafMode = 'single';

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
    if (walkMode) return; // dragging must not orbit while walking
    isPan = e.shiftKey || e.button === 2;
    pointerDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    stopAutoSpin();
  }

  function onPointerMove(e) {
    if (walkMode) return; // mouse-look is handled by the pointer-lock listener
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
    if (walkMode) return; // no dolly while walking
    e.preventDefault();
    stopAutoSpin();
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius * factor));
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // First-person walk-mode handlers (document-level; added in enterWalk,
  // removed in exitWalk + dispose).
  // ---------------------------------------------------------------------------

  // Forward direction from yaw/pitch. yaw=0,pitch=0 → looks toward +Z.
  function walkLookDir(yaw, pitch, out) {
    const cosP = Math.cos(pitch);
    out.set(Math.sin(yaw) * cosP, Math.sin(pitch), Math.cos(yaw) * cosP);
    return out;
  }

  function onWalkKeyDown(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Esc always exits, even if pointer lock was never acquired (otherwise a denied
    // lock would soft-lock walk mode with no way back — the only other exit is the
    // pointerlockchange handler, which never fires without a lock).
    if (k === 'Escape') { exitWalk(); return; }
    walkKeys.add(k);
    // Prevent WASD/space from scrolling the page while walking.
    if (['w', 'a', 's', 'd', ' ', 'Shift'].includes(k) || k === 'ArrowUp' ||
        k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
    }
  }

  function onWalkKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    walkKeys.delete(k);
  }

  function onWalkMouseMove(e) {
    if (document.pointerLockElement !== canvas) return;
    walkYaw   -= e.movementX * WALK_LOOK_SENS;
    walkPitch -= e.movementY * WALK_LOOK_SENS;
    walkPitch  = Math.max(-WALK_PITCH_LIMIT, Math.min(WALK_PITCH_LIMIT, walkPitch));
  }

  function onPointerLockChange() {
    // Lock lost (Esc, alt-tab, etc.) while in walk mode → leave walk mode.
    if (walkMode && document.pointerLockElement !== canvas) {
      exitWalk();
    }
  }

  function enterWalk() {
    if (walkMode) return;
    walkMode = true;
    stopAutoSpin();

    // Release any in-progress orbit drag so it doesn't fight the walk camera.
    if (pointerId != null && canvas.releasePointerCapture) {
      try { canvas.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
    }
    pointerDown = false;
    pointerId = null;

    // Derive eye height + speed from the current scene scale (orbit radius).
    walkEyeY  = Math.max(WALK_EYE_MIN,   radius * WALK_EYE_FRAC);
    walkSpeed = Math.max(WALK_SPEED_MIN, radius * WALK_SPEED_FRAC);

    // Start position: the current orbit camera position, projected onto the
    // walking plane at the fixed eye height. Start heading: face the orbit
    // target (so entering walk keeps roughly the same view), pitch level.
    const camPos = orbitCamPos(azimuth, elevation, radius, target);
    walkPos.set(camPos.x, walkEyeY, camPos.z);
    const dx = target.x - walkPos.x;
    const dz = target.z - walkPos.z;
    walkYaw   = Math.atan2(dx, dz); // atan2(x,z) so yaw matches walkLookDir
    walkPitch = 0;
    walkKeys.clear();

    document.addEventListener('keydown',          onWalkKeyDown);
    document.addEventListener('keyup',            onWalkKeyUp);
    document.addEventListener('mousemove',        onWalkMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    // Request pointer lock. If it's unsupported or the browser rejects it (modern
    // API returns a Promise), don't strand the user in walk mode — Esc still exits
    // (onWalkKeyDown), and a rejected lock falls back to exitWalk so orbit resumes.
    if (canvas.requestPointerLock) {
      const req = canvas.requestPointerLock();
      if (req && typeof req.catch === 'function') req.catch(() => exitWalk());
    }
  }

  function exitWalk() {
    if (!walkMode) return;
    walkMode = false;
    walkKeys.clear();

    document.removeEventListener('keydown',          onWalkKeyDown);
    document.removeEventListener('keyup',            onWalkKeyUp);
    document.removeEventListener('mousemove',        onWalkMouseMove);
    document.removeEventListener('pointerlockchange', onPointerLockChange);

    if (document.pointerLockElement === canvas && document.exitPointerLock) {
      document.exitPointerLock();
    }

    // The orbit state (azimuth/elevation/radius/target) was never touched, so
    // the next frame resumes the prior orbit view. Notify any UI controller so
    // it can clear its "walking" affordance (e.g. an .active button class).
    if (typeof _onWalkExit === 'function') _onWalkExit();
  }

  // Optional UI callback fired when walk mode ends (e.g. on Esc).
  let _onWalkExit = null;

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

    // Forest stand wind — drive every tree in the active stand with the same
    // time/strength/direction as the single specimen so the whole stand sways.
    if (_forestWindUpdate !== null) {
      _forestWindUpdate(windTime, activeStrength, WIND_DIR_DEFAULT.x, WIND_DIR_DEFAULT.y);
    }

    if (walkMode) {
      // First-person: advance walkPos by WASD along the horizontal heading,
      // keep a fixed eye height, then aim the camera along yaw/pitch.
      const sinY = Math.sin(walkYaw);
      const cosY = Math.cos(walkYaw);
      // Horizontal forward (ignores pitch) and screen-right vectors.
      // forward = (sinY, 0, cosY);  screen-right = cross(forward, up) = (-cosY, 0, sinY).
      let mx = 0; // strafe (+ = screen-right, the D key)
      let mz = 0; // forward
      if (walkKeys.has('w') || walkKeys.has('ArrowUp'))    mz += 1;
      if (walkKeys.has('s') || walkKeys.has('ArrowDown'))  mz -= 1;
      if (walkKeys.has('d') || walkKeys.has('ArrowRight')) mx += 1;
      if (walkKeys.has('a') || walkKeys.has('ArrowLeft'))  mx -= 1;
      if (mx !== 0 || mz !== 0) {
        // Normalize so diagonal isn't faster.
        const inv = 1 / Math.hypot(mx, mz);
        mx *= inv; mz *= inv;
        const speed = walkSpeed * (walkKeys.has('Shift') ? WALK_RUN_MULT : 1) * dt;
        walkPos.x += (mz * sinY - mx * cosY) * speed;   // +mz forward, +mx screen-right
        walkPos.z += (mz * cosY + mx * sinY) * speed;
      }
      walkPos.y = walkEyeY;

      const look = walkLookDir(walkYaw, walkPitch, _walkLookScratch);
      perspCam.position.copy(walkPos);
      perspCam.up.set(0, 1, 0);
      perspCam.lookAt(walkPos.x + look.x, walkPos.y + look.y, walkPos.z + look.z);
      perspCam.updateMatrixWorld();
    } else {
      if (autoSpin) {
        azimuth += AUTO_SPIN_SPEED * dt;
      }

      const camPos = orbitCamPos(azimuth, elevation, radius, target);
      perspCam.position.copy(camPos);
      perspCam.up.set(0, 1, 0);
      perspCam.lookAt(target);
      perspCam.updateMatrixWorld();
    }

    // Reset render counters once per frame (autoReset is off) so getStats sees
    // the accumulated totals across all of composer's passes, not just the last.
    renderer.info.reset();
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
      const g = buildBranchGeometry(resolved.graph, {
        ribbing:  resolved.ribbing  ?? 0,
        flatness: resolved.flatness ?? 0,
        ribCount: resolved.ribCount ?? 10,
      });

      // Dispose previous geometry to avoid GPU leaks (slider edits fire often).
      branchGeometry.dispose();
      branchGeometry = new THREE.BufferGeometry();

      branchGeometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      branchGeometry.setAttribute('normal',   new THREE.BufferAttribute(g.normals,   3));
      branchGeometry.setAttribute('uv',       new THREE.BufferAttribute(g.uvs,       2));
      // barkMaterial REQUIRES a per-vertex float 'ao' attribute.
      branchGeometry.setAttribute('ao',       new THREE.BufferAttribute(g.ao,        1));
      // barkMaterial scales its bark feature size to the true local tube radius (world
      // units) via this per-vertex 'aRadius' attribute (not the broken length(xz) proxy).
      branchGeometry.setAttribute('aRadius',  new THREE.BufferAttribute(g.radii,     1));
      // Branch frame (parallel-transported) so bark relief follows the branch axis, not world-Y.
      branchGeometry.setAttribute('aTangent', new THREE.BufferAttribute(g.tangents,  3));
      branchGeometry.setAttribute('aFrameU',  new THREE.BufferAttribute(g.frameUs,   3));
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

      // setGenome() is the correct API on barkCtl — updates uniforms in-place
      // without triggering a shader recompile.
      // lightDir/skyColor/groundColor are not bark uniforms; they drive the scene
      // lights and are handled below via sunLight + setSkyFromLightDir.
      // Orthogonal bark axes — default-guarded in case a gene isn't wired yet.
      barkCtl.setGenome({
        woodiness:      resolved.woodiness      ?? 1.0,
        pigment:        resolved.pigment,
        barkHue:        resolved.barkHue        ?? 0.85,
        barkLightness:  resolved.barkLightness  ?? 0.28,
        barkRelief:     resolved.barkRelief     ?? 1.0,
        barkLenticels:  resolved.barkLenticels  ?? 0.0,
        barkScale:      resolved.barkScale      ?? 0.5,
        barkOrient:     resolved.barkOrient     ?? 0.7,
        barkPlates:     resolved.barkPlates     ?? 0.45,
        barkShed:       resolved.barkShed       ?? 0.0,
        barkUnderHue:   resolved.barkUnderHue   ?? 0.75,
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
        // Dispose previous leaf textures (colour + normal).
        if (currentLeafTex !== null) {
          currentLeafTex.dispose();
          currentLeafTex = null;
        }
        if (currentLeafNormalTex !== null) {
          currentLeafNormalTex.dispose();
          currentLeafNormalTex = null;
        }

        const texData = makeLeafClusterTexture({
          pigment:       resolved.pigment,
          breadth:       resolved.foliage.shape,
          seed:          1,
          leafWidth:     resolved.leafWidth     ?? 0.5,
          leafLength:    resolved.leafLength    ?? 0.45,
          leafTip:       resolved.leafTip       ?? 0.4,
          leafSerration: resolved.leafSerration ?? 0.0,
          leafLobing:    resolved.leafLobing    ?? 0.0,
          leafSkew:      resolved.leafSkew      ?? 0.5,
          leafDivision:  resolved.leafDivision  ?? 0,
          frondFan:      resolved.frondFan      ?? 0,
          leafMode:      _leafMode,
        });
        if (texData !== null) {
          const tex = new THREE.CanvasTexture(texData.source);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          currentLeafTex = tex;

          // Normal map derived from the same sprite (veins/midrib relief).
          let normalTex = null;
          if (texData.normal) {
            normalTex = new THREE.CanvasTexture(texData.normal);
            normalTex.colorSpace = THREE.NoColorSpace;
            normalTex.needsUpdate = true;
            currentLeafNormalTex = normalTex;
          }
          leaves.setTexture(tex, normalTex);
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

        // CARD ASPECT (single-leaf mode only): leafWidth → card X-scale,
        // leafLength → card Y-scale, so the two genes stretch independent axes of
        // each leaf card (the sprite is drawn unit-width; width comes from the
        // card). Cluster/crossed modes use the multi-leaf sprig sprite, which must
        // NOT be stretched, so the aspect resets to (1,1) for them.
        if (_leafMode === 'single') {
          const wf = leafWidthFactor(resolved.leafWidth  ?? 0.5);
          const lf = leafLengthFactor(resolved.leafLength ?? 0.45);
          if (typeof leaves.setLeafAspect === 'function') leaves.setLeafAspect(wf, lf);
        } else if (typeof leaves.setLeafAspect === 'function') {
          leaves.setLeafAspect(1, 1);
        }

        // SINGLE-LEAF mode: fan each broadleaf CLUMP anchor into individual
        // single-leaf cards (render-only — generation/SoA above are untouched;
        // frond/needle/spiny canopies pass through unchanged). CROSSED mode emits
        // K=3 criss-crossed copies of the multi-leaf cluster card per anchor
        // (SpeedTree-style). CLUSTER mode keeps one multi-leaf card per anchor (no
        // expansion) — far fewer instances.
        const leafSet = _leafMode === 'single'
          ? expandClumpsToLeaves(foliageForUpdate, resolved.genome)
          : _leafMode === 'crossed'
            ? expandClumpsToCrossedCards(foliageForUpdate, resolved.genome)
            : foliageForUpdate;
        leaves.update(leafSet);
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
        // uWeep: reduce canopy-sphere-normal blend for weeping willows so their
        // sky-facing geometric normals (from foliage.js Parts A+B) drive diffuse.
        // At weep=0 the factor is 0.8*(1-0)=0.8 — byte-identical to before.
        if (leafUniforms && leafUniforms.uWeep !== undefined) {
          leafUniforms.uWeep.value = resolved.genome ? (resolved.genome.weep ?? 0) : 0;
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
     *   resolution:   { width: number, height: number },
     * }}
     */
    getStats() {
      return {
        fps:          fpsSmoothEma,
        triangles:    renderer.info.render.triangles,
        drawCalls:    renderer.info.render.calls,
        leafClusters: leaves.mesh.count,
        bones:        currentBoneCount,
        // Drawing-buffer pixel size. Returned as {width,height} (not an array)
        // to match the stats panel reader (main.js reads r.width/r.height).
        resolution:   { width: renderer.domElement.width, height: renderer.domElement.height },
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

      // Walk-mode document listeners (added only while walking, but remove
      // defensively in case dispose() lands mid-walk).
      document.removeEventListener('keydown',           onWalkKeyDown);
      document.removeEventListener('keyup',             onWalkKeyUp);
      document.removeEventListener('mousemove',         onWalkMouseMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      if (document.pointerLockElement === canvas && document.exitPointerLock) {
        document.exitPointerLock();
      }

      if (currentLeafTex !== null) {
        currentLeafTex.dispose();
        currentLeafTex = null;
      }
      if (currentLeafNormalTex !== null) {
        currentLeafNormalTex.dispose();
        currentLeafNormalTex = null;
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

    /**
     * enterWalk()
     *
     * Enter first-person walk mode: WASD to move, mouse to look (via Pointer
     * Lock), fixed eye height on the ground plane. Press Esc to exit (the
     * browser releases pointer lock → pointerlockchange → exitWalk). Eye height
     * and move speed are derived from the current scene scale. The orbit camera
     * state is preserved, so exiting resumes the prior orbit view.
     */
    enterWalk() {
      enterWalk();
    },

    /**
     * exitWalk()
     *
     * Programmatically leave walk mode (also invoked automatically when pointer
     * lock is released, e.g. on Esc).
     */
    exitWalk() {
      exitWalk();
    },

    /**
     * isWalking()
     * @returns {boolean} whether walk mode is currently active.
     */
    isWalking() { return walkMode; },

    /**
     * onWalkExit(cb)
     *
     * Register a callback fired whenever walk mode ends (so the UI can clear its
     * "walking" affordance, e.g. an .active button class, after an Esc exit).
     *
     * @param {(() => void) | null} cb
     */
    onWalkExit(cb) { _onWalkExit = cb; },

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
     * setLeafBend(amount)
     *
     * Global per-leaf gravity-droop strength (0 = flat cards, higher = more
     * downward curve). Forwards to the leaf mesh, which updates the bend uniform
     * on both its lit and shadow-depth materials.
     *
     * @param {number} amount
     */
    setLeafBend(amount) {
      if (typeof leaves.setLeafBend === 'function') leaves.setLeafBend(amount);
    },

    /**
     * setLeafMode(mode)
     *
     * 'single' = one leaf per card (clumps fanned out); 'cluster' = a multi-leaf
     * sprig per card (cheaper); 'crossed' = K=3 criss-crossed copies of the
     * multi-leaf sprig per anchor (SpeedTree-style volumetric puff). Unknown
     * values normalize to 'single'. Stores the mode; the caller must re-render
     * (setPlant) for it to take effect — both the leaf sprite and whether clump
     * anchors are expanded are decided in setPlant from this flag.
     *
     * @param {'single'|'cluster'|'crossed'} mode
     */
    setLeafMode(mode) {
      _leafMode = (mode === 'cluster' || mode === 'crossed') ? mode : 'single';
    },

    getLeafMode() { return _leafMode; },

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

    /**
     * setFoliageVisible(visible)
     *
     * Show/hide the canopy InstancedMesh in the main hero scene — the
     * "structure only" inspector toggle (bark + branches + twigs, no leaves).
     * Pure visibility flip on the existing mesh: zero geometry rebuild, zero
     * rng, zero per-frame cost, and (because Object3D.visible=false also skips
     * the shadow pass) no leaf shadows either. Composes with render-mode/roots.
     *
     * @param {boolean} visible
     */
    setFoliageVisible(visible) {
      _foliageVisible = visible;
      leaves.mesh.visible = visible;
    },

    /**
     * setStructureVisible(visible)
     *
     * Show/hide the branch/trunk/root tube mesh in the main hero scene — the
     * "foliage only" inspector toggle (canopy cards alone). Hiding the mesh
     * (visible=false) also removes its shadow contribution, so the canopy is not
     * shadowed by an invisible trunk. Pure visibility flip — no rebuild, no rng.
     *
     * @param {boolean} visible
     */
    setStructureVisible(visible) {
      _structureVisible = visible;
      branchMesh.visible = visible;
    },

    /**
     * setForest(group, bounds)
     *
     * Show a forest stand (a THREE.Group of N trees built by forest.js) IN THE HERO
     * SCENE: hides the single specimen (branch + leaves), adds the group, and frames
     * the camera to the stand bounds. Replaces any previously-set forest group in the
     * scene (the caller owns disposal of the old group). The group carries its own
     * materials; its wind is driven per-frame via the windUpdate callback (no
     * render-mode swap).
     *
     * reframe: re-aim the camera at the stand bounds. Pass true when ENTERING forest
     * mode or changing the count (bounds changed); pass false for a genome-driven
     * rebuild at the same count (bounds are identical) so the user's orbit/pan survives.
     *
     * windUpdate: optional per-frame wind driver (forestHandle.updateWind). Called from
     * the render loop with (time, strength, dirX, dirZ). Pass null for a static stand.
     */
    setForest(group, bounds, reframe = true, windUpdate = null) {
      if (_forestGroup && _forestGroup !== group) scene.remove(_forestGroup);
      _forestGroup = group;
      _forestWindUpdate = windUpdate;   // per-frame wind driver for this stand (null = none)
      if (group) scene.add(group);
      branchMesh.visible = false;   // hide specimen WITHOUT changing the user's toggle intent
      leaves.mesh.visible = false;
      if (reframe && bounds) {
        const fit = computeFitFromBounds(bounds);
        target = fit.center.clone();
        radius = fit.fitRadius;
      }
    },

    /**
     * clearForest()
     *
     * Remove the forest group from the scene (caller disposes it), restore the single
     * specimen, and re-frame the camera to the specimen's last bounds.
     */
    clearForest() {
      if (_forestGroup) { scene.remove(_forestGroup); _forestGroup = null; }
      _forestWindUpdate = null;
      // Restore the parts the user actually wants visible (not a blind true), so the
      // isolate-part toggles stay in sync after leaving forest mode.
      branchMesh.visible = _structureVisible;
      leaves.mesh.visible = _foliageVisible;
      const fit = lastBounds ? computeFitFromBounds(lastBounds) : defaultFit();
      target = fit.center.clone();
      radius = fit.fitRadius;
    },
  };
}
