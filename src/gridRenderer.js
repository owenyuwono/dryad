// =============================================================================
// gridRenderer.js — navigable gallery renderer for procedural flora
//
// Renders N plant species as a navigable 3D gallery of billboard cards, each
// holding a pre-raymarched plant texture. The user orbits/zooms/pans the
// full-screen gallery with OrbitControls. Cards pseudo-rotate when the camera
// settles: each plant is re-raymarched from the current gallery view direction.
//
// Architecture:
//   OFFSCREEN QUAD PASS — a raymarch ShaderMaterial on a PlaneGeometry(2,2)
//     rendered into a WebGLRenderTarget per species (only on setSpecies and
//     on camera-settle, NOT per frame).
//   GALLERY PASS — per frame: N billboard PlaneGeometry cards with
//     MeshBasicMaterial({map: rtTexture}), OrbitControls, PerspectiveCamera.
//
// Usage:
//   import { createGridRenderer } from './gridRenderer.js';
//   const grid = createGridRenderer(document.getElementById('canvas-host'));
//   grid.setSpecies(resolvedList);   // resolve() outputs
//   grid.start();
//   grid.resize();
//   grid.dispose();
// =============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import fragmentShader from './shaders/creature.frag.glsl?raw';
import vertexShader   from './shaders/creature.vert.glsl?raw';

// =============================================================================
// PURE HELPER — exported for unit testing (no THREE, no DOM)
// =============================================================================

/**
 * buildGridLayout(count, pixelW, pixelH)
 *
 * Returns an array of non-overlapping cell rects {x, y, w, h} in renderer/
 * scissor pixel coordinates (origin bottom-left, matching THREE's convention).
 *
 * Layout:
 *   cols = Math.ceil(Math.sqrt(count))
 *   rows = Math.ceil(count / cols)
 *   Cells fill left-to-right, top-to-bottom (row 0 is the top visual row,
 *   but stored in y-flipped renderer coords).
 *
 * Guarantees:
 *   - Full coverage of pixelW × pixelH (last row/col cells expand to fill).
 *   - No overlap.
 *   - count=1 → single cell covering the full canvas.
 *
 * Pure function — no side effects, safe to call from Node.
 * NOTE: still exported and used for world-space card layout (cols/rows math).
 *
 * @param {number} count   Number of species (1..MAX_SPECIES)
 * @param {number} pixelW  Canvas pixel width
 * @param {number} pixelH  Canvas pixel height
 * @returns {{ x:number, y:number, w:number, h:number }[]}
 */
export function buildGridLayout(count, pixelW, pixelH) {
  const n    = Math.max(1, Math.min(count, MAX_SPECIES));
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  // Base cell height (integer-truncated; last row absorbs remainder).
  const baseH = Math.floor(pixelH / rows);

  const cells = [];

  // Iterate row by row so we can handle partial last rows correctly.
  // A partial last row (count not a multiple of cols) expands each of its
  // cells to fill the full canvas width, guaranteeing full coverage.
  for (let row = 0; row < rows; row++) {
    const rowStart = row * cols;
    const rowEnd   = Math.min(rowStart + cols, n);
    const rowCols  = rowEnd - rowStart; // < cols on the final partial row

    // Height: last logical row (visual bottom) absorbs the H remainder.
    // THREE renderer y=0 is at the visual bottom.
    //   rendererRow = rows-1-row  → 0 = visual bottom, (rows-1) = visual top
    const rendererRow = rows - 1 - row;
    const y = rendererRow * baseH;
    const h = rendererRow === 0 ? pixelH - (rows - 1) * baseH : baseH;

    // Width: distribute pixelW evenly across the actual cells in this row.
    // Last cell absorbs the W remainder (handles non-integer division).
    const cellBaseW = Math.floor(pixelW / rowCols);

    for (let c = 0; c < rowCols; c++) {
      const x = c * cellBaseW;
      const w = c === rowCols - 1 ? pixelW - x : cellBaseW;
      cells.push({ x, y, w, h });
    }
  }

  return cells;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Hard cap on species count. Caller enforces slider max; guarded here too. */
export const MAX_SPECIES = 16;

// Camera fit helpers — same constants as original per-cell orbit math.
const HALF_ANGLE = Math.atan(1.1); // matches shader fov constant (fov=1.1)
const FIT_MARGIN = 1.2;
const FIT_MIN    = 1.0;
const FIT_MAX    = 20.0;

// Gallery layout — world-space spacing between cards.
const CARD_SIZE    = 1.8;  // world units, width/height of each card
const CARD_SPACING = 2.4;  // center-to-center spacing

// Render target resolution per species (square).
const RT_SIZE = 640;

// Debounce delay after OrbitControls 'change' event before re-rendering RTs.
const SETTLE_DEBOUNCE_MS = 150;

// Default gallery camera start angle (slight elevation, front view).
const DEFAULT_AZIMUTH   =  0.3;  // radians
const DEFAULT_ELEVATION =  0.4;  // radians

// =============================================================================
// INTERNAL — AABB fit helpers
// =============================================================================

/**
 * Compute AABB center and fit-distance for one resolved species.
 * Mirrors the centering / fit-distance logic from main.js exactly.
 *
 * @param {{ boneAData: number[], boneBData: number[], boneCount: number }} resolved
 * @returns {{ center: THREE.Vector3, fitRadius: number }}
 */
function computeSpeciesFit(resolved) {
  const { boneAData, boneBData, boneCount } = resolved;

  if (boneCount === 0) {
    return { center: new THREE.Vector3(0, 0, 0), fitRadius: 4.5 };
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < boneCount; i++) {
    const ai = i * 4;
    const ax = boneAData[ai],     ay = boneAData[ai + 1], az = boneAData[ai + 2], ar = boneAData[ai + 3];
    const bx = boneBData[ai],     by = boneBData[ai + 1], bz = boneBData[ai + 2], br = boneBData[ai + 3];

    minX = Math.min(minX, ax - ar, bx - br);
    maxX = Math.max(maxX, ax + ar, bx + br);
    minY = Math.min(minY, ay - ar, by - br);
    maxY = Math.max(maxY, ay + ar, by + br);
    minZ = Math.min(minZ, az - ar, bz - br);
    maxZ = Math.max(maxZ, az + ar, bz + br);
  }

  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;

  const halfW = (maxX - minX) * 0.5;
  const halfH = (maxY - minY) * 0.5;
  const halfD = (maxZ - minZ) * 0.5;
  const boundRadius = Math.sqrt(halfW * halfW + halfH * halfH + halfD * halfD);

  const rawRadius = (boundRadius / Math.tan(HALF_ANGLE)) * FIT_MARGIN;
  const fitRadius = Math.max(FIT_MIN, Math.min(rawRadius, FIT_MAX));

  return {
    center: new THREE.Vector3(centerX, centerY, centerZ),
    fitRadius,
  };
}

// =============================================================================
// INTERNAL — orbit camera position (shared math for quad-pass cam vectors)
// =============================================================================

/**
 * Compute camera world position from orbit angles, radius, and look-at target.
 *
 * Mirrors main.js orbitCamPos:
 *   x = target.x + radius * cos(el) * sin(az)
 *   y = target.y + radius * sin(el)
 *   z = target.z + radius * cos(el) * cos(az)
 */
function orbitCamPos(azimuth, elevation, radius, target) {
  const cosEl = Math.cos(elevation);
  const sinEl = Math.sin(elevation);
  const cosAz = Math.cos(azimuth);
  const sinAz = Math.sin(azimuth);
  return new THREE.Vector3(
    target.x + radius * cosEl * sinAz,
    target.y + radius * sinEl,
    target.z + radius * cosEl * cosAz
  );
}

/**
 * Extract azimuth and elevation from a world-space direction vector.
 * Used to derive per-card cam direction from the gallery camera direction.
 *
 * @param {THREE.Vector3} dir  Unit direction vector (from cluster center toward camera)
 * @returns {{ azimuth: number, elevation: number }}
 */
function dirToAngles(dir) {
  const elevation = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  const azimuth   = Math.atan2(dir.x, dir.z);
  return { azimuth, elevation };
}

// =============================================================================
// INTERNAL — uniform setup (shared quad-pass material)
// =============================================================================

/**
 * Build the shared uniform object for the raymarch ShaderMaterial.
 * All arrays pre-allocated; per-render code swaps values in place.
 */
function makeUniforms() {
  return {
    uTime:         { value: 0 },
    uResolution:   { value: new THREE.Vector2(RT_SIZE, RT_SIZE) },
    uBoneCount:    { value: 0 },
    uBoneA:        { value: new Array(64).fill(null).map(() => new THREE.Vector4()) },
    uBoneB:        { value: new Array(64).fill(null).map(() => new THREE.Vector4()) },
    uBoneFlat:     { value: new Array(64).fill(null).map(() => new THREE.Vector4(0, 1, 0, 0)) },
    uLightDir:     { value: new THREE.Vector3(0.4, 0.9, 0.3).normalize() },
    uLightFlux:    { value: 0.6 },
    uBlendK:       { value: 0.3 },
    uMaterialMode: { value: 0 },
    uCamPos:       { value: new THREE.Vector3(0, 0, 3) },
    uTarget:       { value: new THREE.Vector3(0, 0, 0) },
    uPigment:      { value: 0.0 },
    uCardMode:     { value: 1.0 },  // always 1 for RT renders; 0 for normal full-screen
  };
}

// =============================================================================
// INTERNAL — upload per-species uniforms into the shared ShaderMaterial
// =============================================================================

/**
 * Set all per-species uniforms on the shared quad-pass material.
 *
 * @param {object} uniforms   The makeUniforms() object
 * @param {object} entry      { resolved, center, fitRadius }
 * @param {number} azimuth    Camera azimuth angle (radians)
 * @param {number} elevation  Camera elevation angle (radians)
 */
function uploadSpeciesUniforms(uniforms, entry, azimuth, elevation) {
  const { resolved, center, fitRadius } = entry;
  const { boneAData, boneBData, boneFlatData, boneCount,
          blendK, materialMode, lightDir, pigment } = resolved;

  uniforms.uBoneCount.value = boneCount;
  for (let i = 0; i < 64; i++) {
    const ai = i * 4;
    uniforms.uBoneA.value[i].set(
      boneAData[ai], boneAData[ai + 1], boneAData[ai + 2], boneAData[ai + 3]
    );
    uniforms.uBoneB.value[i].set(
      boneBData[ai], boneBData[ai + 1], boneBData[ai + 2], boneBData[ai + 3]
    );
    uniforms.uBoneFlat.value[i].set(
      boneFlatData[ai], boneFlatData[ai + 1], boneFlatData[ai + 2], boneFlatData[ai + 3]
    );
  }

  uniforms.uBlendK.value       = blendK;
  uniforms.uMaterialMode.value = materialMode;
  uniforms.uLightDir.value.set(lightDir[0], lightDir[1], lightDir[2]).normalize();
  uniforms.uPigment.value      = pigment;
  uniforms.uLightFlux.value    = (resolved.lightFlux !== undefined) ? resolved.lightFlux : 0.6;

  uniforms.uTarget.value.copy(center);
  const camPos = orbitCamPos(azimuth, elevation, fitRadius, center);
  uniforms.uCamPos.value.copy(camPos);

  uniforms.uResolution.value.set(RT_SIZE, RT_SIZE);
  uniforms.uCardMode.value = 1.0;  // transparent background for card texture
}

// =============================================================================
// INTERNAL — derive pigment accent color for card border
// =============================================================================

/**
 * Map the species pigment gene [0,1] to an approximate THREE.Color for the
 * border/backing material. Mirrors the shader's tip-color ramp anchors.
 *
 * @param {number} pigment  [0,1]
 * @returns {THREE.Color}
 */
function pigmentToColor(pigment) {
  // Ramp: teal → green → olive → autumnal (tip colors from shader)
  const anchors = [
    [0.00, 0.18, 0.65, 0.55],
    [0.45, 0.28, 0.62, 0.18],
    [0.70, 0.52, 0.60, 0.08],
    [1.00, 0.72, 0.42, 0.06],
  ];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const [t0, r0, g0, b0] = anchors[i];
    const [t1, r1, g1, b1] = anchors[i + 1];
    if (pigment <= t1) {
      const alpha = (pigment - t0) / (t1 - t0);
      r = r0 + (r1 - r0) * alpha;
      g = g0 + (g1 - g0) * alpha;
      b = b0 + (b1 - b0) * alpha;
      break;
    }
  }
  return new THREE.Color(r, g, b);
}

// =============================================================================
// PUBLIC FACTORY
// =============================================================================

/**
 * createGridRenderer(container)
 *
 * Sets up a single WebGL renderer inside `container` (a DOM element) and
 * returns a controller for the navigable flora gallery.
 *
 * @param {HTMLElement} container
 * @returns {{
 *   setSpecies(resolvedList: object[]): void,
 *   start(): void,
 *   resize(): void,
 *   dispose(): void,
 * }}
 */
export function createGridRenderer(container) {
  // ---------------------------------------------------------------------------
  // THREE setup — renderer
  // ---------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(
    container.clientWidth  || window.innerWidth,
    container.clientHeight || window.innerHeight
  );
  // Scissor test disabled for gallery pass; we re-enable only for the quad pass
  // by using setRenderTarget which bypasses scissor anyway.
  renderer.setScissorTest(false);
  container.appendChild(renderer.domElement);

  // ---------------------------------------------------------------------------
  // OFFSCREEN QUAD PASS — raymarch into WebGLRenderTargets
  // ---------------------------------------------------------------------------
  const quadScene  = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  quadCamera.position.z = 1;

  const uniforms = makeUniforms();
  const quadMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,  // needed so RGBA alpha channel is respected
  });
  const quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMaterial);
  quadScene.add(quadMesh);

  // ---------------------------------------------------------------------------
  // GALLERY SCENE — perspective camera, OrbitControls, card meshes
  // ---------------------------------------------------------------------------
  const galleryScene = new THREE.Scene();
  galleryScene.background = new THREE.Color(0x01010a);  // near-black, app aesthetic

  const galleryCamera = new THREE.PerspectiveCamera(
    50,   // fov degrees
    (container.clientWidth || window.innerWidth) /
    (container.clientHeight || window.innerHeight),
    0.1,
    200
  );
  // Place camera at the default azimuth/elevation so the initial RT render
  // and gallery view are aligned.
  {
    const startPos = orbitCamPos(DEFAULT_AZIMUTH, DEFAULT_ELEVATION, 8, new THREE.Vector3(0, 0, 0));
    galleryCamera.position.copy(startPos);
    galleryCamera.lookAt(0, 0, 0);
  }

  // OrbitControls attaches only to renderer.domElement — the control panel
  // and dendrogram are separate DOM nodes above the canvas (pointer-events
  // handled there) so they don't interfere with camera moves.
  const controls = new OrbitControls(galleryCamera, renderer.domElement);
  controls.enableDamping  = true;
  controls.dampingFactor  = 0.08;
  controls.enablePan      = true;
  controls.enableZoom     = true;
  controls.enableRotate   = true;
  controls.minDistance    = 1.5;
  controls.maxDistance    = 60;

  // ---------------------------------------------------------------------------
  // Per-species state (populated by setSpecies, read in gallery frame loop)
  // ---------------------------------------------------------------------------

  /**
   * @type {Array<{
   *   resolved: object,
   *   center: THREE.Vector3,
   *   fitRadius: number,
   *   rt: THREE.WebGLRenderTarget,
   *   cardMesh: THREE.Mesh,
   *   borderMesh: THREE.Mesh,
   * }>}
   */
  let speciesCache = [];

  // ---------------------------------------------------------------------------
  // Clock for uTime animation
  // ---------------------------------------------------------------------------
  const clock = new THREE.Clock();

  // ---------------------------------------------------------------------------
  // Settle debounce — re-render RTs after camera stops moving
  // ---------------------------------------------------------------------------
  let settleTimer = null;

  function scheduleSettle() {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      rerenderAllRTs();
    }, SETTLE_DEBOUNCE_MS);
  }

  controls.addEventListener('change', scheduleSettle);

  // ---------------------------------------------------------------------------
  // RT allocation / deallocation
  // ---------------------------------------------------------------------------

  function createRT() {
    return new THREE.WebGLRenderTarget(RT_SIZE, RT_SIZE, {
      minFilter:   THREE.LinearFilter,
      magFilter:   THREE.LinearFilter,
      format:      THREE.RGBAFormat,
      type:        THREE.UnsignedByteType,
    });
  }

  function disposeSpeciesCache() {
    for (const entry of speciesCache) {
      entry.rt.dispose();
      galleryScene.remove(entry.cardMesh);
      galleryScene.remove(entry.borderMesh);
      entry.cardMesh.material.dispose();
      entry.cardMesh.geometry.dispose();
      entry.borderMesh.material.dispose();
      entry.borderMesh.geometry.dispose();
    }
    speciesCache = [];
  }

  // ---------------------------------------------------------------------------
  // Derive current gallery camera angles relative to cluster center (origin)
  // ---------------------------------------------------------------------------

  function getGalleryCameraAngles() {
    // The cluster is centered at the origin. Direction from origin to camera.
    const dir = galleryCamera.position.clone().normalize();
    return dirToAngles(dir);
  }

  // ---------------------------------------------------------------------------
  // Render all species into their RTs from the current camera angle
  // ---------------------------------------------------------------------------

  function rerenderAllRTs() {
    if (speciesCache.length === 0) return;

    const { azimuth, elevation } = getGalleryCameraAngles();

    // Save renderer state we're about to change.
    const savedRT = renderer.getRenderTarget();

    for (const entry of speciesCache) {
      uploadSpeciesUniforms(uniforms, entry, azimuth, elevation);
      uniforms.uTime.value = clock.elapsedTime;

      renderer.setRenderTarget(entry.rt);
      renderer.render(quadScene, quadCamera);
    }

    renderer.setRenderTarget(savedRT);

    // Update card textures (they already reference rt.texture, so needsUpdate
    // is not required — the texture object itself is the map reference.)
  }

  // ---------------------------------------------------------------------------
  // Build world-space card positions from species count
  // Uses buildGridLayout's cols/rows math mapped to world space.
  // ---------------------------------------------------------------------------

  function buildCardPositions(count) {
    const n    = Math.max(1, count);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);

    const positions = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;

      // Center the grid on the origin.
      const totalW = (cols - 1) * CARD_SPACING;
      const totalH = (rows - 1) * CARD_SPACING;
      const x = col * CARD_SPACING - totalW * 0.5;
      const y = -row * CARD_SPACING + totalH * 0.5;

      positions.push(new THREE.Vector3(x, y, 0));
    }
    return positions;
  }

  // ---------------------------------------------------------------------------
  // Gallery loop
  // ---------------------------------------------------------------------------
  let loopRunning = false;
  let rafId       = null;

  function frame() {
    rafId = requestAnimationFrame(frame);

    clock.getDelta(); // advance internal clock; elapsedTime updated
    const t = clock.elapsedTime;
    uniforms.uTime.value = t;

    controls.update(); // apply damping

    // Billboard: rotate each card to face the camera every frame.
    for (const entry of speciesCache) {
      entry.cardMesh.quaternion.copy(galleryCamera.quaternion);
      entry.borderMesh.quaternion.copy(galleryCamera.quaternion);
    }

    renderer.render(galleryScene, galleryCamera);
  }

  // ---------------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------------

  return {
    /**
     * setSpecies(resolvedList)
     *
     * Caches resolve() outputs, creates one WebGLRenderTarget per species,
     * renders each species into its RT at the default angle, then builds the
     * gallery card meshes.
     *
     * Safe to call multiple times — disposes previous RTs and meshes first.
     * resolve() is NOT called here; the caller provides resolved data.
     *
     * @param {object[]} resolvedList  Array of resolve() outputs (max 16)
     */
    setSpecies(resolvedList) {
      disposeSpeciesCache();

      const capped = resolvedList.slice(0, MAX_SPECIES);
      const positions = buildCardPositions(capped.length);

      // Build species entries (RT + card meshes) without rendering yet.
      for (let i = 0; i < capped.length; i++) {
        const resolved = capped[i];
        const { center, fitRadius } = computeSpeciesFit(resolved);
        const rt = createRT();

        // Card: the plant texture on a plane.
        const cardGeo  = new THREE.PlaneGeometry(CARD_SIZE, CARD_SIZE);
        const cardMat  = new THREE.MeshBasicMaterial({
          map:         rt.texture,
          transparent: true,
          depthWrite:  false,
        });
        const cardMesh = new THREE.Mesh(cardGeo, cardMat);
        cardMesh.position.copy(positions[i]);

        // Backing panel: slightly larger, dark, opaque — gives card a frame.
        const borderColor = pigmentToColor(resolved.pigment ?? 0.45);
        const borderGeo   = new THREE.PlaneGeometry(CARD_SIZE * 1.06, CARD_SIZE * 1.06);
        const borderMat   = new THREE.MeshBasicMaterial({
          color:      borderColor.multiplyScalar(0.35),  // dim tint
          transparent: false,
          depthWrite:  true,
        });
        const borderMesh = new THREE.Mesh(borderGeo, borderMat);
        borderMesh.position.copy(positions[i]);
        borderMesh.position.z -= 0.005; // slightly behind the card

        // Small index label — a sprite using canvas texture.
        // (Only if count > 1 to avoid clutter on single-species view.)
        if (capped.length > 1) {
          const labelCanvas = document.createElement('canvas');
          labelCanvas.width  = 64;
          labelCanvas.height = 64;
          const ctx = labelCanvas.getContext('2d');
          ctx.fillStyle = 'rgba(0,0,0,0)';
          ctx.clearRect(0, 0, 64, 64);
          ctx.font = 'bold 28px monospace';
          ctx.fillStyle = '#aac8aa';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(i + 1), 32, 36);

          const labelTex = new THREE.CanvasTexture(labelCanvas);
          const labelGeo = new THREE.PlaneGeometry(CARD_SIZE * 0.2, CARD_SIZE * 0.2);
          const labelMat = new THREE.MeshBasicMaterial({
            map:         labelTex,
            transparent: true,
            depthWrite:  false,
          });
          const labelMesh = new THREE.Mesh(labelGeo, labelMat);
          // Position in bottom-left corner of the card.
          labelMesh.position.set(
            positions[i].x - CARD_SIZE * 0.38,
            positions[i].y - CARD_SIZE * 0.38,
            positions[i].z + 0.01
          );
          galleryScene.add(labelMesh);
        }

        galleryScene.add(borderMesh);
        galleryScene.add(cardMesh);

        speciesCache.push({ resolved, center, fitRadius, rt, cardMesh, borderMesh });
      }

      // Initial render from default angle (slight elevation, front).
      rerenderAllRTs();

      // Reposition gallery camera to frame all cards.
      const colCount = Math.ceil(Math.sqrt(capped.length));
      const rowCount = Math.ceil(capped.length / colCount);
      const clusterW = (colCount - 1) * CARD_SPACING + CARD_SIZE;
      const clusterH = (rowCount - 1) * CARD_SPACING + CARD_SIZE;
      const clusterRadius = Math.sqrt(clusterW * clusterW + clusterH * clusterH) * 0.5;
      const fovRad = (galleryCamera.fov * Math.PI) / 180;
      const fitDist = (clusterRadius / Math.tan(fovRad * 0.5)) * 1.3;

      const startPos = orbitCamPos(DEFAULT_AZIMUTH, DEFAULT_ELEVATION, fitDist, new THREE.Vector3(0, 0, 0));
      galleryCamera.position.copy(startPos);
      galleryCamera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();
    },

    /**
     * start()
     *
     * Begin the gallery animation loop. Idempotent — calling while already
     * running is a no-op.
     */
    start() {
      if (loopRunning) return;
      loopRunning = true;
      clock.start();
      frame();
    },

    /**
     * resize()
     *
     * Call when the container size changes (e.g. window resize). Resizes the
     * renderer and updates the gallery camera aspect ratio.
     */
    resize() {
      const w = container.clientWidth  || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      renderer.setSize(w, h);
      galleryCamera.aspect = w / h;
      galleryCamera.updateProjectionMatrix();
    },

    /**
     * dispose()
     *
     * Stop the loop and release all WebGL resources (RTs, meshes, renderer).
     * The renderer canvas is removed from the container.
     */
    dispose() {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      loopRunning = false;

      controls.dispose();
      disposeSpeciesCache();
      quadMaterial.dispose();
      renderer.dispose();

      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    },
  };
}
