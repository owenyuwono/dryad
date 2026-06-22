// =============================================================================
// forest.js — build a STAND of varied individuals as a THREE.Group, to drop into
// the hero viewer's scene (NOT a separate renderer/modal). Each tree is the same
// genome with a different structuralSeed, Poisson-disk placed (blue-noise spacing).
//
// Returns { group, bounds, dispose } so the caller (main.js) adds group to the
// viewer scene, frames the camera to `bounds`, and disposes when the count/genome
// changes. Reuses the real bark + leaf materials with wind OFF (windSkin* early-
// return so the null bone texture is never sampled) and CLUSTER-mode leaves (cheap
// for a whole stand). Trees don't cast shadows (keeps the stand cheap + avoids the
// hero shadow-camera, which is fit to the single specimen). No new GLSL.
// =============================================================================

import * as THREE from 'three';
import { resolve } from './genome.js';
import { buildBranchGeometry, MAX_WIND_BONES } from './branchMesh.js';
import { createBarkMaterial } from './barkMaterial.js';
import { createLeafMesh } from './leafMesh.js';
import { makeLeafClusterTexture, leafWidthFactor, leafLengthFactor } from './leafTexture.js';
import { generateFoliage, expandClumpsToLeaves, expandClumpsToCrossedCards } from './foliage.js';
import { mulberry32 } from './rng.js';
import { poissonDisk } from './poisson.js';
import { createWindSolver } from './windSolver.js';
import { WIND_TEX_WIDTH } from './windSkinGlsl.js';

const MIN_SPACING   = 0.78;    // min trunk separation — tight enough that canopies overlap
const TARGET_HEIGHT = 1.5;     // mean tree height (jittered ±22% per tree for a natural stand)
const CANOPY_R      = 0.7;     // canopy half-spread beyond the plot edge (for camera fit)
const SEED_STRIDE   = 0x9E3779B1;
const POISSON_SALT  = 0xF0235D1B;
const JITTER_SALT   = 0x5151A7B3;

function buildBranchMesh(g, material) {
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position',     new THREE.BufferAttribute(g.positions,    3));
  bg.setAttribute('normal',       new THREE.BufferAttribute(g.normals,      3));
  bg.setAttribute('uv',           new THREE.BufferAttribute(g.uvs,          2));
  bg.setAttribute('ao',           new THREE.BufferAttribute(g.ao,           1));
  bg.setAttribute('aRadius',      new THREE.BufferAttribute(g.radii,        1));
  bg.setAttribute('aTangent',     new THREE.BufferAttribute(g.tangents,     3));
  bg.setAttribute('aFrameU',      new THREE.BufferAttribute(g.frameUs,      3));
  bg.setAttribute('windWeight',   new THREE.BufferAttribute(g.windWeight,   1));
  bg.setAttribute('boneIndex',    new THREE.BufferAttribute(g.boneIndex,    1));
  bg.setAttribute('boneFraction', new THREE.BufferAttribute(g.boneFraction, 1));
  bg.setIndex(new THREE.BufferAttribute(g.indices, 1));
  const mesh = new THREE.Mesh(bg, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, geometry: bg };
}

// Push per-frame wind uniforms onto one forest-tree material. Guards _windUniforms
// (set lazily in the material's onBeforeCompile) so a not-yet-compiled material is a
// no-op until its first render — mirrors viewer.applyWindUniforms. dirX/dirZ are this
// tree's OBJECT-space wind direction (the world dir rotated by the caller).
function applyTreeWind(material, t, time, strength, dirX, dirZ) {
  const wu = material && material._windUniforms;
  if (!wu) return;
  if (wu.uTime)         wu.uTime.value         = time;
  if (wu.uWindStrength) wu.uWindStrength.value = strength;
  if (wu.uWindDir)      wu.uWindDir.value.set(dirX, dirZ);
  if (wu.uBoneTex)      wu.uBoneTex.value      = t.boneTex;
  if (wu.uBoneCount !== undefined) wu.uBoneCount.value = t.boneCount;
}

/**
 * buildForestGroup({ genome, env, count, leafMode }) -> { group, bounds, dispose }
 */
export function buildForestGroup({ genome, env, count = 6, leafMode = 'cluster' }) {
  const group = new THREE.Group();
  const disposables = [];   // { geometry?, leafCtl?, normalTex? }

  // Per-tree bark material. Each tree has its OWN skeleton → its own wind bone
  // matrices, so it needs its own uBoneTex uniform; one shared material could only
  // hold a single tree's bones. The materials share the SAME stable
  // customProgramCacheKey, so three.js still compiles the bark shader only ONCE for
  // the whole stand — only the per-material uniforms differ. Genome values are
  // identical across trees, so build the uniform set once and apply it per tree.
  const barkGenome = {
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
  };

  // Leaf sprite raster — computed ONCE; each tree wraps the canvases in its own
  // CanvasTexture (a shared one would be freed N times by createLeafMesh.dispose()).
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
    leafMode,
  });
  const leafSrc    = texData && texData.source ? texData.source : null;
  const leafNrmSrc = texData && texData.normal ? texData.normal : null;

  // Plot sized so `count` trees fit at MIN_SPACING with a little slack.
  const plot = MIN_SPACING * (Math.sqrt(Math.max(1, count)) + 0.5);
  const baseSeed = (genome.structuralSeed ?? 1) >>> 0;
  const pts = poissonDisk({
    width: plot, height: plot, minDist: MIN_SPACING,
    rng: mulberry32(baseSeed ^ POISSON_SALT), maxPoints: count,
  });

  for (let i = 0; i < pts.length; i++) {
    let geometry = null, leafCtl = null, normalTex = null, barkCtl = null, boneTex = null;
    try {
      const seed = (baseSeed + (i + 1) * SEED_STRIDE) >>> 0;
      const res = resolve({ ...genome, structuralSeed: seed }, env);
      const g = buildBranchGeometry(res.graph, { maxWindBones: MAX_WIND_BONES });
      if (!g || !g.positions || g.positions.length === 0) continue;

      // Per-tree bark material (own uBoneTex for this tree's wind bones).
      barkCtl = createBarkMaterial();
      barkCtl.setGenome(barkGenome);

      const branch = buildBranchMesh(g, barkCtl.material);
      geometry = branch.geometry;

      // Per-tree wind: bone DataTexture + solver (each tree's skeleton differs, so the
      // bone matrices and bone count are unique). Sized to this tree's bone count; the
      // solver writes straight into the texture's backing array (zero-copy upload).
      const bones = g.bones_wind;
      const boneRows = Math.max(1, bones.count);
      const boneFloats = new Float32Array(WIND_TEX_WIDTH * boneRows * 4);
      boneTex = new THREE.DataTexture(
        boneFloats, WIND_TEX_WIDTH, boneRows, THREE.RGBAFormat, THREE.FloatType,
      );
      boneTex.magFilter = THREE.NearestFilter;
      boneTex.minFilter = THREE.NearestFilter;
      boneTex.generateMipmaps = false;
      boneTex.flipY = false; // texelFetch(ivec2(col, row)) addresses row 0 at the bottom
      boneTex.needsUpdate = true;
      const solver = createWindSolver(bones);

      leafCtl = createLeafMesh();
      leafCtl.mesh.castShadow = false;
      leafCtl.mesh.receiveShadow = false;
      if (leafSrc) {
        const colTex = new THREE.CanvasTexture(leafSrc);
        colTex.colorSpace = THREE.SRGBColorSpace;
        colTex.needsUpdate = true;
        if (leafNrmSrc) {
          normalTex = new THREE.CanvasTexture(leafNrmSrc);
          normalTex.colorSpace = THREE.NoColorSpace;
          normalTex.needsUpdate = true;
        }
        leafCtl.setTexture(colTex, normalTex);   // colTex → material.map (freed by leafCtl.dispose())
      }
      const foliage = (res.genome && g.nodeToBone)
        ? generateFoliage(res.graph, res.genome, { nodeToBone: g.nodeToBone })
        : res.foliage;
      // Card aspect — mirror the hero viewer: single mode carries width:length on
      // the card (leafWidth → X, leafLength → Y); cluster/crossed keep the square
      // multi-leaf sprig sprite (1,1) so it isn't stretched.
      if (typeof leafCtl.setLeafAspect === 'function') {
        if (leafMode === 'single') {
          leafCtl.setLeafAspect(leafWidthFactor(res.leafWidth ?? 0.5), leafLengthFactor(res.leafLength ?? 0.45));
        } else {
          leafCtl.setLeafAspect(1, 1);
        }
      }
      // Mirror the hero viewer: SINGLE mode fans each broadleaf clump anchor into
      // individual single-leaf cards (1 card = 1 leaf); CROSSED emits K=3 criss-
      // crossed copies of the multi-leaf sprite per anchor; CLUSTER keeps one
      // multi-leaf sprite per anchor. (The sprite itself already matches via leafMode.)
      const leafSet = (leafMode === 'single' && foliage)
        ? expandClumpsToLeaves(foliage, res.genome)
        : (leafMode === 'crossed' && foliage)
          ? expandClumpsToCrossedCards(foliage, res.genome)
          : foliage;
      if (leafSet) leafCtl.update(leafSet);

      // Place at the Poisson point (plot centred on origin). y=0: the graph origin is
      // the trunk base, so it stands on the ground and roots dive below (hidden by the
      // ground plane) — same as the single specimen. Scale by the ABOVE-GROUND height,
      // jittered ±22% per tree, plus a random facing — so the stand reads natural and
      // doesn't look like uniform clones. (Uniform scale + rotation keeps the leaf
      // gravity-bend proportional — leafLen is measured in world space.)
      const b = g.bounds;
      const aboveGround = Math.max(1e-3, b.max[1]);   // trunk base ≈ 0, canopy at max[1]
      const jr = mulberry32(seed ^ JITTER_SALT);
      const s = (TARGET_HEIGHT * (0.78 + jr() * 0.44)) / aboveGround;
      const tree = new THREE.Group();
      tree.add(branch.mesh, leafCtl.mesh);
      tree.scale.setScalar(s);
      const rotY = jr() * Math.PI * 2;
      tree.rotation.y = rotY;
      tree.position.set(pts[i].x - plot / 2, 0, pts[i].y - plot / 2);

      group.add(tree);
      // cos/sin of the tree's facing — used each frame to rotate the WORLD wind
      // direction into this tree's object space, so every tree bends the same world
      // direction (a coherent stand) despite its random rotation.y.
      disposables.push({
        geometry, leafCtl, normalTex, barkCtl, boneTex, solver,
        leafMat: leafCtl.mesh.material,
        boneCount: bones.count,
        cosY: Math.cos(rotY), sinY: Math.sin(rotY),
      });
    } catch (err) {
      if (geometry) geometry.dispose();
      if (leafCtl) leafCtl.dispose();
      if (normalTex) normalTex.dispose();
      if (barkCtl) barkCtl.dispose();
      if (boneTex) boneTex.dispose();
      if (typeof console !== 'undefined') console.warn('forest tree build failed (skipped):', err);
    }
  }

  const half = plot / 2 + CANOPY_R;
  const bounds = {
    min: [-half, 0, -half],
    max: [ half, TARGET_HEIGHT * 1.3, half],   // *1.3 = tallest jittered tree + canopy
  };

  return {
    group,
    bounds,
    /**
     * updateWind(time, strength, dirX, dirZ) — drive every tree's wind for one frame.
     * Called from the viewer's render loop (viewer.setForest stores this) with the same
     * time/strength/direction as the single specimen, so the stand sways with the same
     * wind. dirX/dirZ is the WORLD wind direction in XZ; per tree it is rotated into
     * object space so the whole stand bends one coherent world direction. When strength
     * is 0 the solver is skipped (the shader early-returns at uWindStrength==0 → exact
     * rest pose), and uWindStrength is still pushed to 0 so toggling wind off settles.
     */
    updateWind(time, strength, dirX, dirZ) {
      for (const t of disposables) {
        if (!t.solver) continue;
        // World wind dir → this tree's object space:  Ry(-rotY) · (dirX, dirZ).
        const ox = t.cosY * dirX - t.sinY * dirZ;
        const oz = t.sinY * dirX + t.cosY * dirZ;
        if (strength > 0) {
          t.solver.solve(t.boneTex.image.data, time, strength, ox, oz);
          t.boneTex.needsUpdate = true;
        }
        applyTreeWind(t.barkCtl.material, t, time, strength, ox, oz);
        applyTreeWind(t.leafMat,          t, time, strength, ox, oz);
      }
    },
    dispose() {
      for (const d of disposables) {
        if (d.geometry) d.geometry.dispose();
        if (d.leafCtl) d.leafCtl.dispose();      // leaf geom + material + COLOUR map + depthMaterial
        if (d.normalTex) d.normalTex.dispose();  // leafCtl.dispose() does NOT free normalMap
        if (d.barkCtl) d.barkCtl.dispose();      // per-tree bark material
        if (d.boneTex) d.boneTex.dispose();      // per-tree wind bone DataTexture
      }
      disposables.length = 0;
    },
  };
}
