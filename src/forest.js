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
import { makeLeafClusterTexture } from './leafTexture.js';
import { generateFoliage, expandClumpsToLeaves } from './foliage.js';
import { mulberry32 } from './rng.js';
import { poissonDisk } from './poisson.js';

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
  bg.setAttribute('windWeight',   new THREE.BufferAttribute(g.windWeight,   1));
  bg.setAttribute('boneIndex',    new THREE.BufferAttribute(g.boneIndex,    1));
  bg.setAttribute('boneFraction', new THREE.BufferAttribute(g.boneFraction, 1));
  bg.setIndex(new THREE.BufferAttribute(g.indices, 1));
  const mesh = new THREE.Mesh(bg, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, geometry: bg };
}

/**
 * buildForestGroup({ genome, env, count, leafMode }) -> { group, bounds, dispose }
 */
export function buildForestGroup({ genome, env, count = 6, leafMode = 'cluster' }) {
  const group = new THREE.Group();
  const disposables = [];   // { geometry?, leafCtl?, normalTex? }

  // Shared bark material (one shader compile for the whole stand; same genome).
  const barkCtl = createBarkMaterial();
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
    let geometry = null, leafCtl = null, normalTex = null;
    try {
      const seed = (baseSeed + (i + 1) * SEED_STRIDE) >>> 0;
      const res = resolve({ ...genome, structuralSeed: seed }, env);
      const g = buildBranchGeometry(res.graph, { maxWindBones: MAX_WIND_BONES });
      if (!g || !g.positions || g.positions.length === 0) continue;

      const branch = buildBranchMesh(g, barkCtl.material);
      geometry = branch.geometry;

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
      // Mirror the hero viewer: SINGLE mode fans each broadleaf clump anchor into
      // individual single-leaf cards (1 card = 1 leaf); CLUSTER keeps one multi-leaf
      // sprite per anchor. (The sprite itself already matches via leafMode above.)
      const leafSet = (leafMode === 'single' && foliage)
        ? expandClumpsToLeaves(foliage, res.genome)
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
      tree.rotation.y = jr() * Math.PI * 2;
      tree.position.set(pts[i].x - plot / 2, 0, pts[i].y - plot / 2);

      group.add(tree);
      disposables.push({ geometry, leafCtl, normalTex });
    } catch (err) {
      if (geometry) geometry.dispose();
      if (leafCtl) leafCtl.dispose();
      if (normalTex) normalTex.dispose();
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
    dispose() {
      for (const d of disposables) {
        if (d.geometry) d.geometry.dispose();
        if (d.leafCtl) d.leafCtl.dispose();      // leaf geom + material + COLOUR map + depthMaterial
        if (d.normalTex) d.normalTex.dispose();  // leafCtl.dispose() does NOT free normalMap
      }
      disposables.length = 0;
      barkCtl.dispose();
    },
  };
}
