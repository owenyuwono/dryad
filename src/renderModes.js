// =============================================================================
// renderModes.js — viewport render-mode switcher for the procedural-tree viewer
//
// Supported modes:
//   lit        — full PBR (restored real materials)
//   unlit      — MeshBasicMaterial, albedo-only; leaf uses texture map
//   wireframe  — MeshBasicMaterial wireframe; instancing-safe
//   normals    — MeshNormalMaterial; instancing-safe
//   ao         — grayscale debug: bark uses vertex 'ao' attribute,
//                leaf uses per-instance 'aExposure' attribute
//
// Override mechanism:
//   mesh.material = overrideMat is set per-mesh.  Real materials cached on first
//   use and restored on 'lit'.  Override materials are lazily created and reused.
//   scene.overrideMaterial is NOT used so ground / sky are unaffected.
//
// Regeneration robustness:
//   Both branchMesh and leafMesh are STABLE objects (same JS reference across
//   setPlant calls — only geometry/instances change, not the mesh objects).
//   Cached real materials remain valid across setPlant; re-applying the current
//   mode after setPlant is handled by viewer.js calling setRenderMode again via
//   attachRenderModeController.
//
// Usage:
//   import { createRenderModeController } from './renderModes.js';
//   const ctrl = createRenderModeController({ branchMesh, leafMesh, barkCtl, leafCtl });
//   ctrl.setMode('wireframe');
//   ctrl.getMode();   // → 'wireframe'
//   ctrl.dispose();
// =============================================================================

import * as THREE from 'three';

// Flat bark color used in unlit mode (procedural bark has no texture; a
// representative warm brown is used so branches read clearly).
const BARK_UNLIT_COLOR = new THREE.Color(0.35, 0.22, 0.12);

/**
 * createRenderModeController({ branchMesh, leafMesh, barkCtl, leafCtl })
 *
 * @param {object}                  opts
 * @param {THREE.Mesh}              opts.branchMesh  stable branch mesh object
 * @param {THREE.InstancedMesh}     opts.leafMesh    stable leaf instanced mesh
 * @param {object}                  opts.barkCtl     bark material controller (barkCtl.material)
 * @param {object}                  opts.leafCtl     leaf mesh controller (leafCtl.mesh.material)
 *
 * @returns {{ setMode(mode:string):void, getMode():string, dispose():void }}
 */
export function createRenderModeController({ branchMesh, leafMesh, barkCtl, leafCtl }) {
  // ---------------------------------------------------------------------------
  // Real material cache — populated on first setMode away from 'lit'
  // ---------------------------------------------------------------------------
  let realBranchMaterial = null;
  let realLeafMaterial   = null;

  // ---------------------------------------------------------------------------
  // Override material cache — created lazily, reused on subsequent calls
  // ---------------------------------------------------------------------------
  let unlitBranchMat  = null;
  let unlitLeafMat    = null;
  let wireBranchMat   = null;
  let wireLeafMat     = null;
  let normalBranchMat = null;
  let normalLeafMat   = null;
  let aoBranchMat     = null;
  let aoLeafMat       = null;

  let currentMode = 'lit';

  // ---------------------------------------------------------------------------
  // Cache real materials — safe to call multiple times (idempotent)
  // ---------------------------------------------------------------------------
  function cacheRealMaterials() {
    if (realBranchMaterial === null) {
      realBranchMaterial = branchMesh.material;
    }
    if (realLeafMaterial === null) {
      realLeafMaterial = leafMesh.material;
    }
  }

  // ---------------------------------------------------------------------------
  // Restore real materials (lit mode)
  // ---------------------------------------------------------------------------
  function restoreLit() {
    if (realBranchMaterial !== null) {
      branchMesh.material = realBranchMaterial;
    }
    if (realLeafMaterial !== null) {
      leafMesh.material = realLeafMaterial;
    }
  }

  // ---------------------------------------------------------------------------
  // Unlit mode — MeshBasicMaterial
  //   Bark: flat representative brown (no texture, procedural shader)
  //   Leaf: MeshBasicMaterial with leaf texture map so leaf shapes show unlit
  // ---------------------------------------------------------------------------
  function applyUnlit() {
    if (unlitBranchMat === null) {
      unlitBranchMat = new THREE.MeshBasicMaterial({
        color: BARK_UNLIT_COLOR,
      });
    }

    if (unlitLeafMat === null) {
      // Read the current leaf texture from the real leaf material
      const leafTex = realLeafMaterial ? realLeafMaterial.map : null;
      unlitLeafMat = new THREE.MeshBasicMaterial({
        map:       leafTex,
        alphaTest: 0.5,
        side:      THREE.DoubleSide,
      });
    } else {
      // Keep the leaf texture in sync in case setPlant rebuilt it
      const leafTex = realLeafMaterial ? realLeafMaterial.map : null;
      if (unlitLeafMat.map !== leafTex) {
        unlitLeafMat.map = leafTex;
        unlitLeafMat.needsUpdate = true;
      }
    }

    branchMesh.material = unlitBranchMat;
    leafMesh.material   = unlitLeafMat;
  }

  // ---------------------------------------------------------------------------
  // Wireframe mode — MeshBasicMaterial wireframe
  //   MeshBasicMaterial supports InstancedMesh natively in Three r160.
  // ---------------------------------------------------------------------------
  function applyWireframe() {
    if (wireBranchMat === null) {
      wireBranchMat = new THREE.MeshBasicMaterial({
        color:     0x88ccff,
        wireframe: true,
      });
    }
    if (wireLeafMat === null) {
      wireLeafMat = new THREE.MeshBasicMaterial({
        color:     0x88ffaa,
        wireframe: true,
      });
    }
    branchMesh.material = wireBranchMat;
    leafMesh.material   = wireLeafMat;
  }

  // ---------------------------------------------------------------------------
  // Normals mode — MeshNormalMaterial
  //   Supports InstancedMesh natively.
  // ---------------------------------------------------------------------------
  function applyNormals() {
    // LEAF: MeshNormalMaterial supports normalMap, so feed it the leaf normal map
    // (baked from the sprite). The debug view then shows the PERTURBED normals —
    // the vein/midrib relief — instead of one flat colour per card.
    const leafNorm  = realLeafMaterial ? realLeafMaterial.normalMap  : null;
    const leafScale = (realLeafMaterial && realLeafMaterial.normalScale) ? realLeafMaterial.normalScale : null;
    if (normalLeafMat === null) {
      normalLeafMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    }
    if (normalLeafMat.normalMap !== leafNorm) {
      normalLeafMat.normalMap = leafNorm;
      normalLeafMat.needsUpdate = true;
    }
    if (leafScale && normalLeafMat.normalScale) normalLeafMat.normalScale.copy(leafScale);

    // BRANCH: bark relief is procedural (in the lit material's shader), so a stock
    // MeshNormalMaterial can't show it. Use the REAL bark material with its debug-
    // normals flag on, so the debug view renders the bark's perturbed normal (furrows
    // + cracks) directly.
    if (barkCtl && typeof barkCtl.setDebugNormals === 'function') {
      barkCtl.setDebugNormals(true);
      branchMesh.material = barkCtl.material;
    } else {
      if (normalBranchMat === null) normalBranchMat = new THREE.MeshNormalMaterial();
      branchMesh.material = normalBranchMat;
    }
    leafMesh.material = normalLeafMat;
  }

  // ---------------------------------------------------------------------------
  // AO mode — grayscale debug
  //   Bark: MeshBasicMaterial + onBeforeCompile to read vertex 'ao' attribute
  //   Leaf: MeshBasicMaterial + onBeforeCompile to read per-instance 'aExposure'
  //         (instanced attribute on the leaf geometry)
  // ---------------------------------------------------------------------------
  function buildAoBranchMat() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mat.onBeforeCompile = (shader) => {
      // Declare ao attribute and a varying
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        /* glsl */`
attribute float ao;
varying float vAo;
#include <common>
`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */`
#include <begin_vertex>
vAo = ao;
`
      );
      // In fragment, output grayscale ao
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        /* glsl */`
varying float vAo;
#include <common>
`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        /* glsl */`
gl_FragColor = vec4(vec3(vAo), 1.0);
`
      );
    };
    return mat;
  }

  function buildAoLeafMat() {
    // aExposure is a per-instance InstancedBufferAttribute on the leaf geometry
    const mat = new THREE.MeshBasicMaterial({
      side:      THREE.DoubleSide,
      color:     0xffffff,
      alphaTest: 0.5,
    });
    // Re-use the leaf texture map so alphaTest cutout still works in ao mode
    if (realLeafMaterial && realLeafMaterial.map) {
      mat.map = realLeafMaterial.map;
    }
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        /* glsl */`
attribute float aExposure;
varying float vExposure;
#include <common>
`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */`
#include <begin_vertex>
vExposure = aExposure;
`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        /* glsl */`
varying float vExposure;
#include <common>
`
      );
      // Output grayscale exposure (keep alpha from texture map for alphaTest)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        /* glsl */`
float gray = clamp(vExposure, 0.0, 1.0);
gl_FragColor = vec4(vec3(gray), diffuseColor.a);
if (gl_FragColor.a < alphaTest) discard;
`
      );
    };
    return mat;
  }

  // ---------------------------------------------------------------------------
  // Furrows mode — flow-line furrow debug view (line traces).
  //   Bark: REAL bark material with its furrow-debug flag on → outputs the
  //   flow-line furrow field directly (ridges pale, furrow lines dark).
  //   Leaf: keep the real material (hide foliage to inspect bark if needed).
  // ---------------------------------------------------------------------------
  function applyFurrows() {
    if (barkCtl && typeof barkCtl.setDebugFurrows === 'function') {
      barkCtl.setDebugFurrows(true);
      branchMesh.material = barkCtl.material;
    }
    if (realLeafMaterial !== null) leafMesh.material = realLeafMaterial;
  }

  function applyAo() {
    if (aoBranchMat === null) {
      aoBranchMat = buildAoBranchMat();
    }
    if (aoLeafMat === null) {
      aoLeafMat = buildAoLeafMat();
    } else {
      // Sync texture in case it changed
      const leafTex = realLeafMaterial ? realLeafMaterial.map : null;
      if (aoLeafMat.map !== leafTex) {
        aoLeafMat.map = leafTex;
        aoLeafMat.needsUpdate = true;
      }
    }
    branchMesh.material = aoBranchMat;
    leafMesh.material   = aoLeafMat;
  }

  // ---------------------------------------------------------------------------
  // setMode — dispatch to per-mode apply functions
  // ---------------------------------------------------------------------------
  function setMode(mode) {
    // Cache real materials before any override (idempotent)
    cacheRealMaterials();

    currentMode = mode;

    // The bark debug-normals flag is only on in 'normals' mode; clear it for every
    // other mode so the lit bark shader renders colour, not its normal-as-colour.
    if (mode !== 'normals' && barkCtl && typeof barkCtl.setDebugNormals === 'function') {
      barkCtl.setDebugNormals(false);
    }
    // Clear the furrow-debug flag for every mode except 'furrows' (it lives on the REAL bark
    // material, which 'lit' restores — so it must be turned off here or it would persist).
    if (mode !== 'furrows' && barkCtl && typeof barkCtl.setDebugFurrows === 'function') {
      barkCtl.setDebugFurrows(false);
    }

    switch (mode) {
      case 'lit':
        restoreLit();
        break;
      case 'unlit':
        applyUnlit();
        break;
      case 'wireframe':
        applyWireframe();
        break;
      case 'normals':
        applyNormals();
        break;
      case 'furrows':
        applyFurrows();
        break;
      case 'ao':
        applyAo();
        break;
      default:
        console.warn(`renderModes: unknown mode "${mode}", falling back to lit`);
        restoreLit();
        currentMode = 'lit';
    }
  }

  // ---------------------------------------------------------------------------
  // getMode
  // ---------------------------------------------------------------------------
  function getMode() {
    return currentMode;
  }

  // ---------------------------------------------------------------------------
  // dispose — release override materials (real materials are owned by viewer)
  // ---------------------------------------------------------------------------
  function dispose() {
    unlitBranchMat  && unlitBranchMat.dispose();
    unlitLeafMat    && unlitLeafMat.dispose();
    wireBranchMat   && wireBranchMat.dispose();
    wireLeafMat     && wireLeafMat.dispose();
    normalBranchMat && normalBranchMat.dispose();
    normalLeafMat   && normalLeafMat.dispose();
    aoBranchMat     && aoBranchMat.dispose();
    aoLeafMat       && aoLeafMat.dispose();

    unlitBranchMat  = null;
    unlitLeafMat    = null;
    wireBranchMat   = null;
    wireLeafMat     = null;
    normalBranchMat = null;
    normalLeafMat   = null;
    aoBranchMat     = null;
    aoLeafMat       = null;
    realBranchMaterial = null;
    realLeafMaterial   = null;
  }

  return { setMode, getMode, dispose };
}
