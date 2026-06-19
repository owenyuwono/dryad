// =============================================================================
// leafMesh.js — instanced leaf-card renderer for the single-specimen viewer
//
// Builds ONE InstancedMesh (one draw call) of PlaneGeometry leaf quads.
// The base quad is 1×1, base-at-bottom-center (vertex Y spans [0,1]).
//
// Foliage instance set contract (from foliage.js):
//   { count, position, normal, tangent, scale, rotation, ageColor, shape }
//   Arrays are Float32Array, stride 3 for position/normal/tangent, stride 1 for
//   scale/rotation/ageColor.  MAX_LEAVES = 4500.
//   Optional: exposure — Float32Array stride 1, [0=shaded interior, 1=sunlit outer].
//   If absent, defaults to 1.0 (no depth darkening).
//
// Material: THREE.MeshStandardMaterial + onBeforeCompile.
//   PBR lighting is handled by Three's built-in light system.  Additional terms
//   injected via onBeforeCompile:
//     - Per-instance tint (vInstanceColor from instanceColor attribute)
//     - Back-face normal flip (DoubleSide without separate back-face pass)
//     - Back-lit translucency glow (wrap-diffuse forward-scatter, GPU Gems 3 style)
//     - Canopy depth via aExposure (darkens deep interior, lifts sunlit outer)
//
//   uLightDir is an internal uniform used solely for the backlit glow term.
//   It is NOT externally settable — scene lights drive PBR diffuse/specular.
//
// Canopy depth via aExposure:
//   Each instance carries an aExposure value (0=deep/shaded, 1=outer/sunlit).
//   The fragment shader scales the lit term by a mix of a shadow multiplier
//   (low exposure) and a sunlit tint lift (high exposure), giving a dark interior
//   shell that brightens toward the outer/top surface.
//
// Shadow casting: mesh.customDepthMaterial uses MeshDepthMaterial (RGBA packing)
//   with alphaTest so the cutout silhouette is respected in shadow maps.
//
// Usage:
//   import { createLeafMesh } from './leafMesh.js';
//   const leaves = createLeafMesh();
//   scene.add(leaves.mesh);
//   leaves.setTexture(tex);
//   leaves.update(instanceSet);
//   // later:
//   leaves.dispose();
// =============================================================================

import * as THREE from 'three';
import { MAX_LEAVES, LEAVES_PER_CLUMP } from './foliage.js';
import {
    WIND_BONE_UNIFORM_DECLS,
    WIND_BONE_FETCH_GLSL,
    WIND_LEAF_FOLLOW_GLSL,
    WIND_BONE_UNIFORM_DEFAULTS,
} from './windSkinGlsl.js';

// ---------------------------------------------------------------------------
// CONSTANTS — re-export so callers can use leafMesh.js as the single import
// ---------------------------------------------------------------------------

export { MAX_LEAVES };

// Instance capacity: each clump anchor (≤ MAX_LEAVES) is fanned into up to
// LEAVES_PER_CLUMP single-leaf cards by expandClumpsToLeaves, so the mesh and
// all per-instance buffers must hold MAX_LEAVES × LEAVES_PER_CLUMP instances.
export const LEAF_CAPACITY = MAX_LEAVES * LEAVES_PER_CLUMP;

// Gravity bend: every leaf card curves toward world-down, the tip drooping by
// this fraction of the leaf's world length (quadratic from base→tip). Applied
// in the vertex shader (see the project_vertex hook). 0 = flat cards.
export const LEAF_BEND_DEFAULT = 0.45;

// Leaf normal-map strength. The fragment shader blends the surface normal ~80%
// toward the canopy sphere normal, so the tangent-space vein/midrib relief is
// amplified here to stay visible after that blend.
export const LEAF_NORMAL_SCALE = 2.5;

// Vertices along the leaf's length. The gravity bend is quadratic in position.y,
// so the blade needs several rows between base and tip to read as a smooth CURVE
// rather than a single-quad tilt. 6 is plenty smooth and cheap (one draw call).
export const LEAF_LENGTH_SEGMENTS = 6;

// ---------------------------------------------------------------------------
// INTERNAL — orthonormal basis construction
//
// The quad sits in the XY plane: +Y is "up the blade", +Z faces the viewer.
// We want the blade's +Y to point along `tangent` and +Z to point along
// `normal`.  The third axis (blade's +X) is the cross product.
//
// Then we apply a roll of `rotation` radians about the tangent.
//
// Basis columns in the resulting rotation matrix:
//   col0 = bladeX (right, derived)
//   col1 = tangent (up-the-blade)
//   col2 = normal  (face normal)
// ---------------------------------------------------------------------------

const _T   = new THREE.Vector3();
const _N   = new THREE.Vector3();
const _X   = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _col = new THREE.Color();

/**
 * Build the per-instance Matrix4 for leaf i and write it into `out`.
 *
 * @param {Float32Array} position   stride-3 array
 * @param {Float32Array} normal     stride-3 array
 * @param {Float32Array} tangent    stride-3 array
 * @param {Float32Array} scale      stride-1 array
 * @param {Float32Array} rotation   stride-1 array (roll, radians)
 * @param {number}       i          instance index
 * @param {THREE.Matrix4} out       matrix to write into
 */
function buildInstanceMatrix(position, normal, tangent, scale, rotation, i, out, widthFactor, lengthFactor) {
  const p3 = i * 3;

  // Normalise tangent (blade up) and normal (face)
  _T.set(tangent[p3], tangent[p3 + 1], tangent[p3 + 2]).normalize();
  _N.set(normal[p3],  normal[p3 + 1],  normal[p3 + 2]).normalize();

  // Blade right = tangent × normal  (gives orthonormal third axis)
  _X.crossVectors(_T, _N).normalize();

  // Re-orthogonalise normal in case tangent/normal weren't exactly orthogonal
  _N.crossVectors(_X, _T).normalize();

  // Unscaled rotation matrix from the three column vectors
  //   col0 = _X  (blade right)
  //   col1 = _T  (blade up / tangent)
  //   col2 = _N  (face normal)
  // THREE.Matrix4 is column-major stored as a flat 16-element array:
  //   [ m00 m10 m20 m30  m01 m11 m21 m31  m02 m12 m22 m32  m03 m13 m23 m33 ]
  // set(n11,n12,...) takes ROW-major arguments, so we pass column vectors as rows:
  _mat.set(
    _X.x, _T.x, _N.x, 0,
    _X.y, _T.y, _N.y, 0,
    _X.z, _T.z, _N.z, 0,
    0,    0,    0,    1
  );

  // Roll about the tangent axis
  const roll = rotation[i];
  if (roll !== 0) {
    _rot.makeRotationAxis(_T, roll);
    _mat.premultiply(_rot);
  }

  // Scale: uniform per-instance size `s`, modulated by the CARD ASPECT
  // (widthFactor on the blade-right axis = X, lengthFactor on the tangent/up axis
  // = Y). leafWidth drives widthFactor, leafLength drives lengthFactor, so the two
  // genes stretch independent axes of the card — the leaf reads wider OR longer
  // rather than both collapsing onto one axis. The face-normal axis (Z) uses the
  // width factor so the card stays planar (no shear). Defaults (1,1) = uniform.
  // NOTE: this scaling lives in instanceMatrix column 1 (the up axis), so the
  // gravity-bend's leafLen = length(instanceMatrix[1].xyz) = s*lengthFactor —
  // the droop stays proportional to the RENDERED leaf length.
  const s = scale[i];
  _mat.scale(new THREE.Vector3(s * widthFactor, s * lengthFactor, s * widthFactor));

  // Translation
  _mat.setPosition(position[p3], position[p3 + 1], position[p3 + 2]);

  out.copy(_mat);
}

// ---------------------------------------------------------------------------
// PUBLIC FACTORY
// ---------------------------------------------------------------------------

/**
 * createLeafMesh()
 *
 * @returns {{
 *   mesh: THREE.InstancedMesh,
 *   update(instanceSet: object): void,
 *   setTexture(texture: THREE.Texture): void,
 *   dispose(): void,
 * }}
 */
export function createLeafMesh() {
  // ---------------------------------------------------------------------------
  // Geometry — 1×1 quad, base at Y=0, tip at Y=1.
  // PlaneGeometry(1,1) has vertices at Y ∈ [-0.5, 0.5]; shift by +0.5 so
  // the base sits at origin and the tip is at Y=1.
  //
  // SUBDIVIDED ALONG THE LENGTH (heightSegments = LEAF_LENGTH_SEGMENTS): the
  // gravity-bend vertex shader displaces each vertex by position.y² — with only
  // the 4 corners of a single quad that just lowers the top edge (a flat tilt),
  // so the blade must have intermediate rows of vertices to actually CURVE.
  // ---------------------------------------------------------------------------
  const geometry = new THREE.PlaneGeometry(1, 1, 1, LEAF_LENGTH_SEGMENTS);

  // Shift vertices so base = (Y=0) and tip = (Y=1)
  const pos = geometry.attributes.position;
  for (let vi = 0; vi < pos.count; vi++) {
    pos.setY(vi, pos.getY(vi) + 0.5);
  }
  pos.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Gravity-bend strength (tip droop as a fraction of leaf length). Mutable via
  // setLeafBend(); the uniform refs are captured in onBeforeCompile below.
  let _leafBend = LEAF_BEND_DEFAULT;

  // CARD ASPECT — per-tree, uniform across all instances (the genome's leafWidth/
  // leafLength are a single value per plant). widthFactor scales the card's X
  // (breadth), lengthFactor scales its Y (length). Set via setLeafAspect(); applied
  // in buildInstanceMatrix. Defaults to (1,1) = square card (today's look for the
  // default genome, where the chosen factor curves both evaluate to ~1.0). Used
  // only in 'single' leaf mode; cluster/crossed modes reset to (1,1) so the
  // multi-leaf sprig sprite isn't stretched.
  let _widthFactor  = 1.0;
  let _lengthFactor = 1.0;

  // ---------------------------------------------------------------------------
  // Material — MeshStandardMaterial with onBeforeCompile.
  //
  // PBR base:
  //   roughness 0.88 / metalness 0.0 — matte, diffuse-dominant leaf (avoids a glossy/
  //     plastic specular sheen under the sun + IBL; raise toward 1.0 for fully matte).
  //   alphaTest 0.5 — cutout alpha; no transparent blending, no depth sorting.
  //   side: DoubleSide — both faces rendered; back-face normal flip handled in
  //     onBeforeCompile rather than relying on Two-Pass rendering.
  //
  // Per-instance tint: THREE.InstancedMesh populates an 'instanceColor'
  //   attribute (vec3) when setColorAt() is called.  Three's USE_INSTANCING_COLOR
  //   define gates a vColor write; we copy it to our own vInstanceColor varying
  //   so our inject does not depend on Three's internal vColor name.
  //
  // aExposure: per-instance InstancedBufferAttribute declared in the vertex
  //   shader via onBeforeCompile.  Passed to fragment as vExposure.
  //
  // Backlit glow: uLightDir uniform (internal, not externally settable).
  //   Used only for the forward-scatter / wrap-diffuse translucency term.
  //   PBR diffuse / specular are driven by scene lights as normal.
  // ---------------------------------------------------------------------------
  const material = new THREE.MeshStandardMaterial({
    map:       null,
    alphaTest: 0.5,
    side:      THREE.DoubleSide,
    roughness: 0.88,
    metalness: 0.0,
  });

  // ---- onBeforeCompile — inject custom attributes and lighting terms ----
  material.onBeforeCompile = (shader) => {
    // 1. aBoneIndex + aExposure + aCanopyNormal attributes + varyings + bone wind decls
    //    — injected before #include <common>
    //
    // Bone wind declarations (WIND_BONE_UNIFORM_DECLS) and helpers (fetchBone,
    // windBoneFollowDelta) are prepended here so they are available before any
    // Three.js built-in chunk references them.
    //
    // aBoneIndex: per-instance float carrying the wind-bone index for this leaf.
    //   Sampled via windBoneFollowDelta(leafWorldAnchor, aBoneIndex) in the
    //   project_vertex hook (view-space add), which avoids the instanceMatrix
    //   warp trap documented below.
    //
    // instanceMatrix column [3] (.xyz) = leaf world anchor (tree at origin,
    //   so modelMatrix = identity → instanceMatrix[3].xyz IS the world anchor).
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      WIND_BONE_UNIFORM_DECLS + WIND_BONE_FETCH_GLSL + WIND_LEAF_FOLLOW_GLSL + /* glsl */`
attribute float aBoneIndex;
attribute float aExposure;
varying float vExposure;
varying vec3 vInstanceColor;
attribute vec3 aCanopyNormal;
varying vec3 vCanopyNormal;
uniform float uLeafBend;
#include <common>
`
    );

    // 2. Pass aBoneIndex, aExposure, instanceColor, and aCanopyNormal to fragment;
    //    apply local-space flutter + tumble — all injected at begin_vertex.
    //
    //    At this injection point `transformed` is in LOCAL leaf quad space (a
    //    1×1 plane with Y in [0,1]).  instanceMatrix has NOT been applied yet
    //    (that happens in project_vertex).  To get the leaf's world anchor we read
    //    the translation column of instanceMatrix directly:
    //      leafWorldAnchor = instanceMatrix[3].xyz
    //    (tree at origin → modelMatrix = I → instanceMatrix[3].xyz is world anchor)
    //
    //    Only LOCAL-space motions are applied to `transformed` here:
    //
    //    Flutter: per-leaf high-frequency shimmer phased by anchor XZ, amplitude
    //      ∝ uWindStrength so it vanishes when calm. position.y in [0,1] makes the
    //      card tip flutter more than the base.
    //
    //    Tumble: a small roll about the leaf's own local Y axis (blade tangent).
    //      Phase derived from anchor hash so adjacent leaves are out of sync.
    //      Amplitude ∝ uWindStrength → zero at calm.
    //
    //    Bone-follow (primary displacement): applied POST-instanceMatrix in the
    //      project_vertex hook (view-space add) so the world displacement is NOT
    //      warped by this leaf's per-instance rotation/scale — the warp trap that
    //      would scatter leaves and detach them from their branches.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`
#include <begin_vertex>
vExposure = aExposure;
vCanopyNormal = aCanopyNormal;
#ifdef USE_INSTANCING_COLOR
  vInstanceColor = instanceColor;
#else
  vInstanceColor = vec3(1.0);
#endif

#ifdef USE_INSTANCING
  // World anchor of this leaf instance (tree at origin so modelMatrix = I).
  // leafWorldAnchor must be declared outside any inner block so the project_vertex
  // hook below can reference it.
  vec3 leafWorldAnchor = instanceMatrix[3].xyz;

  // Per-leaf flutter: high-frequency LOCAL-space shimmer, phased by anchor XZ so
  // adjacent leaves are out of sync. Amplitude ∝ uWindStrength; vanishes when calm.
  // position.y in [0,1] makes the card tip flutter more than the base.
  float flutterPhase = leafWorldAnchor.x * 3.7 + leafWorldAnchor.z * 2.9 + uTime * 4.3;
  float flutterAmp   = uWindStrength * 0.09;
  transformed += vec3(sin(flutterPhase) * flutterAmp * position.y,
                      cos(flutterPhase * 1.31) * flutterAmp * 0.3 * position.y,
                      0.0);

  // Per-leaf tumble: small roll about the local Y axis (blade tangent).
  // Phase derived from world anchor hash so each leaf rolls at its own rhythm.
  // Amplitude ∝ uWindStrength → zero when calm.
  float tumblePhase = leafWorldAnchor.x * 2.3 + leafWorldAnchor.z * 5.1 + uTime * 1.7;
  float tumbleAmp   = uWindStrength * 0.12;
  float tumbleAngle = sin(tumblePhase) * tumbleAmp;
  float tumbleCos   = cos(tumbleAngle);
  float tumbleSin   = sin(tumbleAngle);
  // Rotate transformed around local Y axis (blade tangent): X and Z change.
  float tx = transformed.x * tumbleCos + transformed.z * tumbleSin;
  float tz = -transformed.x * tumbleSin + transformed.z * tumbleCos;
  transformed.x = tx;
  transformed.z = tz;
  // Bone-follow (primary displacement) is applied post-instanceMatrix in
  // project_vertex (view space) — see comment block above.
#endif
`
    );

    // 2b. Bone-follow — applied AFTER instanceMatrix, in view space.
    //     project_vertex computes `mvPosition` (view-space position) then gl_Position.
    //
    //     windBoneFollowDelta(anchor, boneIdx) returns the world-space delta that
    //     moves `anchor` according to its attachment bone's composed rotation.
    //     We add it to mvPosition via viewMatrix (w=0, drops translation) so the
    //     leaf moves by the SAME world vector as the branch vertex at the same
    //     anchor point — the leaf stays attached and moves identically to its branch.
    //
    //     Using view-space add (not pre-instance `transformed`) is the key:
    //     the per-leaf instanceMatrix rotation/scale would warp a world displacement
    //     added before the matrix multiply, scattering leaves off their branches
    //     (the "warp trap" documented in the original leafMesh.js:229-234).
    //
    //     At wind off (uWindStrength==0): bone matrices are identity →
    //     windBoneFollowDelta returns vec3(0) → gl_Position unchanged → exact rest pose.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */`
#include <project_vertex>
#ifdef USE_INSTANCING
  vec3 followDelta = windBoneFollowDelta(leafWorldAnchor, aBoneIndex);
  // GRAVITY BEND: curve every leaf blade toward world-down. The droop grows
  // quadratically from the base (position.y=0 → 0) to the tip (position.y=1),
  // scaled to the leaf's world size (length of the tangent column of
  // instanceMatrix). Applied as a WORLD-space delta in view space (post-
  // instanceMatrix) so it always points at gravity regardless of how the leaf
  // is oriented — adding it pre-instance would let the leaf rotation warp the
  // down vector into another direction (the warp trap).
  // World-space leaf length (column 1 = the blade's up/length axis). Uses the FULL
  // model→world transform (modelMatrix * instanceMatrix), so the gravity droop — which
  // is added in world/view space below — stays proportional to the leaf's RENDERED size
  // even when the mesh is under a scaled parent (e.g. a forest tree group). With the mesh
  // at the scene root (single specimen) modelMatrix = I, so this is unchanged there.
  float leafLen = length((modelMatrix * instanceMatrix)[1].xyz);
  float bendDroop = position.y * position.y * leafLen * uLeafBend;
  vec3 gravityDelta = vec3(0.0, -bendDroop, 0.0);
  // followDelta is in the mesh's OBJECT space (the anchor and the bone matrices are
  // object-space). Rotate/scale it into world space with the model matrix's linear
  // part so the leaf tracks its branch under a transformed parent (e.g. a scaled +
  // rotated forest-tree group). modelMatrix = I for the single specimen, so this is
  // a no-op there. gravityDelta is already world-space (world-down) and is NOT rotated.
  vec3 worldFollow = mat3(modelMatrix) * followDelta;
  gl_Position = projectionMatrix * (mvPosition + viewMatrix * vec4(worldFollow + gravityDelta, 0.0));
#endif
`
    );

    // 3. Fragment declarations — varyings and internal uLightDir/uWeep uniforms.
    //
    // uWeep (default 0): controls canopy-sphere-normal blend reduction for weeping
    // willows. At weep=0, canopy blend = 0.8 (identical to the previous behaviour).
    // At weep=1, canopy blend = 0.0 so the sky-facing geometric normal from foliage.js
    // Parts A+B drives diffuse — leaves under a hanging canopy catch overhead light.
    // Set each frame by viewer.js from resolved.genome.weep (see setPlant).
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */`
varying float vExposure;
varying vec3 vInstanceColor;
uniform vec3 uLightDir;
uniform float uWeep;
varying vec3 vCanopyNormal;
#include <common>
`
    );
    shader.uniforms.uLightDir = { value: new THREE.Vector3(0.5, 1.0, 0.5).normalize() };
    shader.uniforms.uWeep     = { value: 0.0 };
    // Gravity-bend strength: tip droop as a fraction of the leaf's world length.
    shader.uniforms.uLeafBend = { value: _leafBend };
    material._leafBendUniform = shader.uniforms.uLeafBend;

    // Wind uniforms — added to shader.uniforms so they are uploaded each frame.
    // uBoneTex and uBoneCount are wired by viewer.js (Task 5) after buildBranchGeometry.
    // uBoneTex defaults to null here; viewer replaces it with the real DataTexture.
    const windUniforms = {
        uTime:         { value: WIND_BONE_UNIFORM_DEFAULTS.uTime },
        uWindStrength: { value: WIND_BONE_UNIFORM_DEFAULTS.uWindStrength },
        uWindDir:      { value: new THREE.Vector2(...WIND_BONE_UNIFORM_DEFAULTS.uWindDir) },
        uBoneTex:      { value: null },
        uBoneCount:    { value: WIND_BONE_UNIFORM_DEFAULTS.uBoneCount },
    };
    Object.assign(shader.uniforms, windUniforms);

    // Expose the compiled uniform map so viewer.js can update uLightDir after compile.
    // _customUniforms already contains the wind uniforms (they are in shader.uniforms).
    material._customUniforms = shader.uniforms;
    // _windUniforms provides the same uniform access path as barkMaterial, so the
    // wiring code in viewer.js can update both materials through a uniform interface.
    material._windUniforms = windUniforms;

    // 4. Back-face normal flip + canopy sphere normal blend — inject after <normal_fragment_maps>.
    //    Replaces the previous back-face-only flip.  After this chunk `normal` is the
    //    view-space normal blended by (0.8 * (1-uWeep)) canopy sphere / remainder geometric.
    //
    //    At uWeep=0: blend factor = 0.8 — identical to the previous behaviour.
    //    At uWeep=1: blend factor = 0.0 — pure geometric normal so the sky-facing
    //    normals written by foliage.js Parts A+B fully drive the diffuse term, letting
    //    hanging willow leaves catch overhead light instead of shading near-black.
    //    Intermediate weep values reduce the canopy sphere contribution proportionally.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */`
#include <normal_fragment_maps>
// Back-face normal flip (geometric)
vec3 geoNormal = gl_FrontFacing ? normal : -normal;
// Canopy sphere normal — object/world space → view space
vec3 canopyNV = normalize((viewMatrix * vec4(vCanopyNormal, 0.0)).xyz);
if (!gl_FrontFacing) canopyNV = -canopyNV;
// Blend canopy sphere / geometric card — soft volumetric shading.
// uWeep reduces the canopy blend so willow leaves use their sky-facing geometric
// normals (set in foliage.js) rather than a canopy-AABB normal pointing downward.
// At uWeep=0: factor=0.8 (unchanged). At uWeep=1: factor=0 (pure geo normal).
float canopyBlend = 0.8 * (1.0 - uWeep);
normal = normalize(mix(geoNormal, canopyNV, canopyBlend));
`
    );

    // 5. Multiply instanceColor tint into diffuseColor — inject after <color_fragment>.
    //    <color_fragment> applies vertex colors / vColor; we multiply our own
    //    vInstanceColor in after so the tint stacks correctly with PBR diffuse.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */`
#include <color_fragment>
diffuseColor.rgb *= vInstanceColor;
`
    );

    // 6. Backlit translucency glow + canopy exposure — inject before <opaque_fragment>.
    //    <lights_fragment_end> has already finalised outgoingLight from PBR by this
    //    point.  We modify outgoingLight here, then let <opaque_fragment> write
    //    gl_FragColor = vec4(outgoingLight, ...) as normal.
    //
    //    Note: in three r154+ the chunk was renamed from <output_fragment> to
    //    <opaque_fragment>.  We prepend our block and re-emit the include so
    //    three's normal output still runs after our modifications.
    //
    //    Backlit glow model (single-pass, no RT):
    //      backWrap — wrap-diffuse from behind the leaf (transmitted light)
    //      sc       — forward-scatter peak when eye is roughly opposite the light
    //      transAlbedo — yellow-green shifted albedo for the transmitted colour
    //
    //    Canopy exposure:
    //      exp_val=0 (deep interior): multiply by shadowMul=0.45 (55% darker)
    //      exp_val=1 (sunlit outer):  multiply by 1.0 and add warm green highlight
    //
    //    Variables in scope at this point (declared by lights_fragment_begin, which
    //    runs before opaque_fragment): geometryViewDir, geometryPosition,
    //    geometryNormal.  outgoingLight and diffuseColor are also in scope.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      /* glsl */`
// --- backlit translucency (single-pass, no RT) ---
// When light comes from behind the leaf, add a green-tinted transmitted glow.
// Uses the world-space light dir uniform; geometryViewDir is declared by
// lights_fragment_begin (three r160+; replaces the removed geometry.viewDir struct).
vec3 L = normalize(uLightDir);
vec3 N = normalize(normal);
float backLitNdotL = max(dot(-N, L), 0.0);
// forward scatter: only on back faces (transmission lobe); zero on front faces to
// prevent blown-out bright-green patches when the camera faces the sun.
float sc = (!gl_FrontFacing) ? pow(max(dot(-geometryViewDir, L), 0.0), 3.0) * 0.35 : 0.0;
// wrap-diffuse back-face transmission
float backWrap = clamp(dot(-N, L) * 0.6 + 0.4, 0.0, 1.0);
// transmission colour is a yellow-green shifted version of the albedo
vec3 transAlbedo = diffuseColor.rgb * vec3(1.4, 1.5, 1.1);
transAlbedo = clamp(transAlbedo, 0.0, 1.0);
vec3 backlitGlow = transAlbedo * (backWrap * 0.5 + sc) * 0.6;

// --- canopy exposure darkening/lifting ---
float exp_val = clamp(vExposure, 0.0, 1.0);
float shadowMul = mix(0.45, 1.0, exp_val);
vec3  sunliftAdd = mix(vec3(0.0), vec3(0.06, 0.18, 0.08), exp_val * exp_val);

outgoingLight = outgoingLight * shadowMul + sunliftAdd + backlitGlow;

#include <opaque_fragment>
`
    );
  };

  // ---------------------------------------------------------------------------
  // Depth material — MeshDepthMaterial with RGBA packing so shadow maps
  // respect the alpha-cutout silhouette of the leaf cards.
  //
  // alphaTest mirrors the main material so shadow edges align with visible edges.
  // map is set in setTexture() once the leaf texture is available.
  //
  // onBeforeCompile injects bone-follow + flutter into the depth vertex shader so
  // leaf shadow silhouettes track the wind hierarchy (Decision 7, plan §2.6).
  // The injection uses the same tokens (<begin_vertex>, <project_vertex>) and
  // the same GLSL helpers as the main material — one source of truth.
  //
  // Note: depth material shaders have no lighting chunks, so only the vertex
  // hooks are needed. Correctness of shadow sway is USER-VERIFIED (build gate
  // confirms the tokens are present; rendering is not Node-testable).
  // ---------------------------------------------------------------------------
  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    alphaTest:    0.5,
  });

  depthMaterial.onBeforeCompile = (shader) => {
    // 1. Inject bone wind declarations + aBoneIndex attribute before <common>
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      WIND_BONE_UNIFORM_DECLS + WIND_BONE_FETCH_GLSL + WIND_LEAF_FOLLOW_GLSL + /* glsl */`
attribute float aBoneIndex;
uniform float uLeafBend;
#include <common>
`
    );

    // 2. Declare leafWorldAnchor at begin_vertex + apply flutter and tumble.
    //    Mirrors the main material exactly so depth silhouette matches lit shape.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`
#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 leafWorldAnchor = instanceMatrix[3].xyz;

  float flutterPhase = leafWorldAnchor.x * 3.7 + leafWorldAnchor.z * 2.9 + uTime * 4.3;
  float flutterAmp   = uWindStrength * 0.09;
  transformed += vec3(sin(flutterPhase) * flutterAmp * position.y,
                      cos(flutterPhase * 1.31) * flutterAmp * 0.3 * position.y,
                      0.0);

  float tumblePhase = leafWorldAnchor.x * 2.3 + leafWorldAnchor.z * 5.1 + uTime * 1.7;
  float tumbleAmp   = uWindStrength * 0.12;
  float tumbleAngle = sin(tumblePhase) * tumbleAmp;
  float tumbleCos   = cos(tumbleAngle);
  float tumbleSin   = sin(tumbleAngle);
  float tx = transformed.x * tumbleCos + transformed.z * tumbleSin;
  float tz = -transformed.x * tumbleSin + transformed.z * tumbleCos;
  transformed.x = tx;
  transformed.z = tz;
#endif
`
    );

    // 3. Bone-follow + gravity bend in view space — same pattern as main material
    //    so the shadow silhouette matches the drooped leaf.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */`
#include <project_vertex>
#ifdef USE_INSTANCING
  vec3 followDelta = windBoneFollowDelta(leafWorldAnchor, aBoneIndex);
  // World-space leaf length (column 1 = the blade's up/length axis). Uses the FULL
  // model→world transform (modelMatrix * instanceMatrix), so the gravity droop — which
  // is added in world/view space below — stays proportional to the leaf's RENDERED size
  // even when the mesh is under a scaled parent (e.g. a forest tree group). With the mesh
  // at the scene root (single specimen) modelMatrix = I, so this is unchanged there.
  float leafLen = length((modelMatrix * instanceMatrix)[1].xyz);
  float bendDroop = position.y * position.y * leafLen * uLeafBend;
  vec3 gravityDelta = vec3(0.0, -bendDroop, 0.0);
  // followDelta is in the mesh's OBJECT space (the anchor and the bone matrices are
  // object-space). Rotate/scale it into world space with the model matrix's linear
  // part so the leaf tracks its branch under a transformed parent (e.g. a scaled +
  // rotated forest-tree group). modelMatrix = I for the single specimen, so this is
  // a no-op there. gravityDelta is already world-space (world-down) and is NOT rotated.
  vec3 worldFollow = mat3(modelMatrix) * followDelta;
  gl_Position = projectionMatrix * (mvPosition + viewMatrix * vec4(worldFollow + gravityDelta, 0.0));
#endif
`
    );

    // 4. Wind uniforms — depth material needs uTime/uWindStrength/uWindDir/uBoneTex.
    //    Shared via the same backing objects that viewer.js sets each frame.
    const depthWindUniforms = {
      uTime:         { value: WIND_BONE_UNIFORM_DEFAULTS.uTime },
      uWindStrength: { value: WIND_BONE_UNIFORM_DEFAULTS.uWindStrength },
      uWindDir:      { value: new THREE.Vector2(...WIND_BONE_UNIFORM_DEFAULTS.uWindDir) },
      uBoneTex:      { value: null },
      uBoneCount:    { value: WIND_BONE_UNIFORM_DEFAULTS.uBoneCount },
    };
    Object.assign(shader.uniforms, depthWindUniforms);
    shader.uniforms.uLeafBend = { value: _leafBend };
    depthMaterial._leafBendUniform = shader.uniforms.uLeafBend;
    depthMaterial._windUniforms = depthWindUniforms;
  };

  // ---------------------------------------------------------------------------
  // InstancedMesh — allocated once for LEAF_CAPACITY instances (clump anchors
  // fanned into single-leaf cards by expandClumpsToLeaves).
  // ---------------------------------------------------------------------------
  const mesh = new THREE.InstancedMesh(geometry, material, LEAF_CAPACITY);
  mesh.count = 0;             // nothing drawn until update() is called
  mesh.frustumCulled = false; // individual leaf instances span the plant; skip per-mesh cull

  // Shadow casting and receiving — depth material drives the shadow map pass
  mesh.customDepthMaterial = depthMaterial;
  mesh.castShadow    = true;
  mesh.receiveShadow = true;

  // Pre-initialise all instance matrices to identity (avoids NaN artifacts on
  // instances beyond mesh.count if the GPU reads them anyway)
  const identity = new THREE.Matrix4();
  for (let i = 0; i < LEAF_CAPACITY; i++) {
    mesh.setMatrixAt(i, identity);
  }
  mesh.instanceMatrix.needsUpdate = true;

  // Pre-initialise instance colors to white.
  // setColorAt forces InstancedMesh to create the instanceColor attribute,
  // which onBeforeCompile reads via USE_INSTANCING_COLOR / instanceColor.
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < LEAF_CAPACITY; i++) {
    mesh.setColorAt(i, white);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  // ---------------------------------------------------------------------------
  // aExposure — per-instance InstancedBufferAttribute (float, 1 component).
  //
  // Defaults to 1.0 (outer/sunlit — no darkening) so the shader is safe even
  // before foliage.js starts supplying exposure data.
  //
  // The attribute name 'aExposure' is declared in the vertex shader via
  // onBeforeCompile and passed through to the fragment as vExposure.
  // ---------------------------------------------------------------------------
  const _exposureData = new Float32Array(LEAF_CAPACITY).fill(1.0);
  const exposureAttr  = new THREE.InstancedBufferAttribute(_exposureData, 1);
  geometry.setAttribute('aExposure', exposureAttr);

  // ---------------------------------------------------------------------------
  // aCanopyNormal — per-instance InstancedBufferAttribute (vec3, 3 components).
  //
  // Stores an outward unit normal from the canopy AABB center to each leaf
  // position.  Used in the fragment shader (blended 80/20 with the geometric
  // card normal) so all leaves shade as if on a smooth sphere instead of as
  // flat independent patches.  Computed in update() from the AABB center of
  // all instance positions.  Defaults to (0,1,0) until update() is called.
  // ---------------------------------------------------------------------------
  const _canopyNormalData = new Float32Array(LEAF_CAPACITY * 3);
  // Default to up-vector (y=1, x=z=0)
  for (let ci = 0; ci < LEAF_CAPACITY; ci++) { _canopyNormalData[ci * 3 + 1] = 1.0; }
  const canopyNormalAttr  = new THREE.InstancedBufferAttribute(_canopyNormalData, 3);
  geometry.setAttribute('aCanopyNormal', canopyNormalAttr);

  // ---------------------------------------------------------------------------
  // aBoneIndex — per-instance InstancedBufferAttribute (float, 1 component).
  //
  // Carries the wind-bone index for each leaf (which chain this leaf's attachment
  // branch belongs to).  Used by windBoneFollowDelta() in the vertex shader to
  // fetch the bone's composed rotation matrix from the DataTexture, so leaves
  // follow their attachment branch through the full wind hierarchy.
  //
  // Defaults to 0 (bone 0 = trunk chain, effectively rigid since the trunk bone
  // is isRigid and produces identity rotation) so the shader is safe when
  // foliage.js supplies no boneIndex or before viewer.js calls update().
  // ---------------------------------------------------------------------------
  const _boneIndexData = new Float32Array(LEAF_CAPACITY); // default 0
  const boneIndexAttr  = new THREE.InstancedBufferAttribute(_boneIndexData, 1);
  geometry.setAttribute('aBoneIndex', boneIndexAttr);

  // ---------------------------------------------------------------------------
  // Reusable per-frame objects (avoid per-instance allocations in update)
  // ---------------------------------------------------------------------------
  const _m4   = new THREE.Matrix4();
  const _tint = new THREE.Color();

  // ---------------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------------

  return {
    mesh,

    /**
     * update(instanceSet)
     *
     * Rebuild all instance matrices, per-instance tint colors, and per-instance
     * exposure values from the foliage instance set.  Safe to call every frame;
     * only uploads dirty buffers at the end.
     *
     * Per-instance tint: ageColor[i] ∈ [0,1] where 0 = older/darker base,
     * 1 = younger/lighter tip.  We lerp across a wide green range with a strongly
     * randomised lightness spread so the canopy reads with visible variation:
     *   age=0, dark jitter  → very dark shadowed green  (~0.12, 0.28, 0.08)
     *   age=0, light jitter → mid green                 (~0.28, 0.52, 0.18)
     *   age=1, dark jitter  → mid yellow-green          (~0.38, 0.62, 0.20)
     *   age=1, light jitter → pale silvery highlight    (~0.72, 0.96, 0.44)
     *
     * Deterministic per-instance hue and LIGHTNESS jitter — seeded from index,
     * no Math.random — ensures adjacent clumps differ visibly.
     *
     * Per-instance exposure: instanceSet.exposure[i] ∈ [0,1] (optional).
     * 0 = deep interior / shaded, 1 = outer / top / sunlit.  Written into the
     * aExposure InstancedBufferAttribute.  If exposure is absent from the
     * instanceSet, defaults to 1.0 (no shadow darkening, backward-compatible).
     *
     * Canopy sphere normals: computed internally from the AABB center of all
     * instance positions.  Each leaf gets an outward unit normal from that center,
     * which the fragment shader blends 80/20 with the geometric card normal to
     * produce smooth sphere-like lighting across the canopy volume.
     *
     * Per-instance bone index: instanceSet.boneIndex[i] (optional).
     * Written into the aBoneIndex InstancedBufferAttribute.  When absent,
     * defaults to 0 (bone 0 = trunk chain) — backward-compatible.
     *
     * @param {{ count:number, position:Float32Array, normal:Float32Array,
     *           tangent:Float32Array, scale:Float32Array,
     *           rotation:Float32Array, ageColor:Float32Array,
     *           exposure?:Float32Array, boneIndex?:Float32Array }} instanceSet
     */
    update(instanceSet) {
      const { count, position, normal, tangent, scale, rotation, ageColor } = instanceSet;
      // exposure is optional — backward-compatible; defaults to 1.0 (no darkening).
      const exposure = instanceSet.exposure ?? null;
      // boneIndex is optional — backward-compatible; defaults to 0 (bone 0 / trunk).
      const boneIndexSrc = instanceSet.boneIndex ?? null;

      // --- canopy AABB center (for canopy sphere normals) ---
      //
      // Compute the AABB (axis-aligned bounding box) over all instance positions,
      // then take the midpoint of min/max as the canopy center.  This is the
      // reference point from which outward sphere normals radiate.
      //
      // If count === 0, the center is left at (0,0,0) — no instances to light.
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < count; i++) {
        const p3 = i * 3;
        const px = position[p3], py = position[p3 + 1], pz = position[p3 + 2];
        if (px < minX) minX = px;  if (px > maxX) maxX = px;
        if (py < minY) minY = py;  if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz;  if (pz > maxZ) maxZ = pz;
      }
      const cX = (minX + maxX) * 0.5;
      const cY = (minY + maxY) * 0.5;
      const cZ = (minZ + maxZ) * 0.5;

      for (let i = 0; i < count; i++) {
        // --- matrix ---
        buildInstanceMatrix(position, normal, tangent, scale, rotation, i, _m4, _widthFactor, _lengthFactor);
        mesh.setMatrixAt(i, _m4);

        // --- per-instance tint (age-based colour + wide deterministic jitter) ---
        //
        // Two independent LCG hashes of the instance index provide per-cluster
        // lightness and hue variation without Math.random (deterministic).
        //
        // Hash A: lightness jitter — broad ±20% swing on green channel so some
        //   clusters are clearly dark and others clearly pale/silvery.
        // Hash B: hue jitter — shift red vs green independently to give warm
        //   (yellowish) and cool (blue-green) variants across the canopy.
        //
        // Base palette (age=0 → deep green, age=1 → pale yellow-green):
        //   R base: 0.18 → 0.58   (range 0.40)
        //   G base: 0.35 → 0.80   (range 0.45)
        //   B base: 0.10 → 0.30   (range 0.20)
        //
        // Jitter applied after base:
        //   lightness jL ∈ [-0.20, +0.20] scales G and B together (value)
        //   hue jitter  jR ∈ [-0.10, +0.10] shifts R independently (warm/cool)

        const a = ageColor[i]; // [0,1]

        // Hash A — lightness (green-channel multiplier bias)
        const hashA = ((i * 1664525 + 1013904223) & 0xffffff) / 0xffffff; // [0,1)
        const jL    = (hashA - 0.5) * 0.40; // ±20% lightness swing

        // Hash B — hue (red-channel shift for warm/cool bias)
        const hashB = ((i * 22695477 + 1013904223) & 0xffffff) / 0xffffff; // [0,1)
        const jR    = (hashB - 0.5) * 0.20; // ±10% red shift

        // Hash C — blue-green micro-variation (gives subtle teal/olive split)
        const hashC = ((i * 214013 + 2531011) & 0xffffff) / 0xffffff; // [0,1)
        const jB = (hashC - 0.5) * 0.10; // ±5% blue micro-shift

        _tint.setRGB(
          Math.max(0, Math.min(1, 0.18 + 0.40 * a + jR)),        // R: 0.18→0.58
          Math.max(0, Math.min(1, 0.35 + 0.45 * a + jL)),        // G: 0.35→0.80 + lightness
          Math.max(0, Math.min(1, 0.10 + 0.20 * a + jL * 0.5 + jB)), // B: 0.10→0.30
        );
        mesh.setColorAt(i, _tint);

        // --- per-instance exposure → aExposure attribute ---
        _exposureData[i] = (exposure !== null) ? Math.max(0, Math.min(1, exposure[i])) : 1.0;

        // --- per-instance bone index → aBoneIndex attribute ---
        // When boneIndex is absent from instanceSet, default to 0 (bone 0 / trunk chain).
        // This is safe: bone 0 is isRigid and produces identity rotation → no displacement.
        _boneIndexData[i] = (boneIndexSrc !== null) ? boneIndexSrc[i] : 0;

        // --- per-instance canopy sphere normal → aCanopyNormal attribute ---
        //
        // Outward unit normal from the canopy AABB center to this leaf position,
        // in object/world space (plant is at origin, so these are the same).
        // Degenerate case (leaf exactly at center): fall back to up-vector.
        const p3 = i * 3;
        let nx = position[p3]     - cX;
        let ny = position[p3 + 1] - cY;
        let nz = position[p3 + 2] - cZ;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-6) {
          nx /= len;  ny /= len;  nz /= len;
        } else {
          nx = 0;  ny = 1;  nz = 0;
        }
        _canopyNormalData[p3]     = nx;
        _canopyNormalData[p3 + 1] = ny;
        _canopyNormalData[p3 + 2] = nz;
      }

      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      exposureAttr.needsUpdate = true;
      canopyNormalAttr.needsUpdate = true;
      boneIndexAttr.needsUpdate = true;
    },

    /**
     * setTexture(texture)
     *
     * Assign a leaf alpha/colour texture to the material and the depth material.
     * Safe to call before or after update().
     *
     * Updates both material.map (PBR pass) and depthMaterial.map (shadow pass)
     * so alpha cutout is respected in shadow maps as well as the colour pass.
     *
     * @param {THREE.Texture} texture
     */
    setTexture(texture, normalTexture) {
      material.map = texture;
      if (texture) texture.colorSpace = THREE.SRGBColorSpace;
      depthMaterial.map = texture;
      if (normalTexture !== undefined) {
        material.normalMap = normalTexture || null;
        if (normalTexture) {
          // Normal maps are data, not colour — must be sampled linearly.
          normalTexture.colorSpace = THREE.NoColorSpace;
          // Amplify so the vein/midrib relief survives the canopy-sphere normal
          // blend in the fragment shader (which pulls ~80% toward the sphere normal).
          if (!material.normalScale) material.normalScale = new THREE.Vector2(1, 1);
          material.normalScale.set(LEAF_NORMAL_SCALE, LEAF_NORMAL_SCALE);
        }
      }
      depthMaterial.needsUpdate = true;
      material.needsUpdate = true;
    },

    /**
     * setLeafBend(amount)
     *
     * Global gravity-droop strength: tip droop as a fraction of leaf length
     * (0 = flat cards, higher = more downward curve). Updates the uniform on
     * both the lit and shadow-depth materials. No recompile.
     *
     * @param {number} amount
     */
    setLeafBend(amount) {
      _leafBend = amount;
      if (material._leafBendUniform)       material._leafBendUniform.value = amount;
      if (depthMaterial._leafBendUniform)  depthMaterial._leafBendUniform.value = amount;
    },

    /**
     * setLeafAspect(widthFactor, lengthFactor)
     *
     * Set the per-tree card aspect ratio applied to every leaf instance:
     * widthFactor scales the card's breadth (X / blade-right axis), lengthFactor
     * scales its length (Y / tangent axis). leafWidth → widthFactor and
     * leafLength → lengthFactor (computed by the caller), so the two genes scale
     * independent axes instead of collapsing onto one. Takes effect on the NEXT
     * update() (the matrices are rebuilt there). (1,1) = square card.
     *
     * @param {number} widthFactor
     * @param {number} lengthFactor
     */
    setLeafAspect(widthFactor, lengthFactor) {
      _widthFactor  = (widthFactor  > 0) ? widthFactor  : 1.0;
      _lengthFactor = (lengthFactor > 0) ? lengthFactor : 1.0;
    },

    /**
     * dispose()
     *
     * Release geometry, material, depth material, and mesh GPU resources.
     * Remove the mesh from its parent scene before calling.
     */
    dispose() {
      geometry.dispose();
      if (material.map) material.map.dispose();
      material.dispose();
      depthMaterial.dispose();
      mesh.dispose();
    },
  };
}
