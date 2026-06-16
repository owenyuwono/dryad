// =============================================================================
// windSkinGlsl.js — shared GLSL for hierarchical skeletal wind (bone DataTexture)
//
// Dependency-free (no Three.js import) — Node-testable and shared by:
//   barkMaterial.js  (branch skin, Task 3)
//   leafMesh.js      (leaf bone-follow, Task 2)
//   depth materials  (shadow sync, Tasks 2 + 3)
//
// Bone DataTexture layout:
//   One bone = 4 RGBA32F texels in a row → one mat4 (column-major):
//     texel 0: mat4 column 0  (m00,m10,m20,m30)
//     texel 1: mat4 column 1  (m01,m11,m21,m31)
//     texel 2: mat4 column 2  (m02,m12,m22,m32)
//     texel 3: mat4 column 3  (m03,m13,m23,m33)
//   The mat4 is T(pivot)·R·T(-pivot) composed top-down by the solver — the
//   shader just multiplies restPos by it to get the fully-composed skinned pos.
//
// SpeedTree linear-chain trick:
//   The solver bakes the FULL chain-end rotation into the bone mat4.
//   The shader scales the displacement linearly by boneFraction (0=pivot,1=tip):
//     skinned = restPos + boneFraction * (boneMat * restPos - restPos)
//   This makes the branch curve as a smooth arc without per-vertex bone matrices.
//
// Calm guarantee:
//   Every amplitude term multiplies uWindStrength. When uWindStrength==0,
//   all bone matrices are identity → boneMat*restPos == restPos →
//   displacement == 0 → exact rest pose.
// =============================================================================

export const WIND_TEX_WIDTH = 4; // RGBA32F texels per bone (one mat4)

// ---------------------------------------------------------------------------
// Uniform declarations — inject before #include <common> in vertex shaders
// ---------------------------------------------------------------------------

export const WIND_BONE_UNIFORM_DECLS = /* glsl */`
uniform sampler2D uBoneTex;
uniform float uBoneCount;
uniform float uWindStrength;
uniform float uTime;
uniform vec2  uWindDir;
`;

// ---------------------------------------------------------------------------
// fetchBone — reads one bone mat4 from the DataTexture using texelFetch.
//
// Texture layout: width=4 (WIND_TEX_WIDTH), height=boneCount.
//   Row idx, columns 0..3 = mat4 columns 0..3 (each RGBA32F texel = one vec4).
// ---------------------------------------------------------------------------

export const WIND_BONE_FETCH_GLSL = /* glsl */`
mat4 fetchBone(float idx) {
    int row = int(idx);
    vec4 c0 = texelFetch(uBoneTex, ivec2(0, row), 0);
    vec4 c1 = texelFetch(uBoneTex, ivec2(1, row), 0);
    vec4 c2 = texelFetch(uBoneTex, ivec2(2, row), 0);
    vec4 c3 = texelFetch(uBoneTex, ivec2(3, row), 0);
    mat4 m = mat4(c0, c1, c2, c3);
    // Safety: an unset/empty bone texture or an out-of-range row yields an
    // all-zero matrix (m[3][3]==0). A valid affine transform always has
    // m[3][3]==1. Treat a degenerate fetch as identity so vertices/leaves stay
    // at rest instead of collapsing to the origin (leaves would vanish).
    if (m[3][3] == 0.0) return mat4(1.0);
    return m;
}
`;

// ---------------------------------------------------------------------------
// windSkinPosition — apply bone skinning to a branch vertex.
//
// Signature (frozen per plan §2.2):
//   vec3 windSkinPosition(vec3 restPos, float boneIdx, float boneFraction, float windWeight)
//
// Algorithm:
//   1. Fetch the composed bone mat4 (T·R·T⁻¹ about the chain pivot).
//   2. Compute skinned = restPos + boneFraction * (boneMat * restPos - restPos)
//      — SpeedTree linear chain trick: displacement scales 0 at pivot → full at tip.
//   3. Blend with rest via windWeight (so trunk base stays pinned even if its
//      bone has a tiny rotation): result = mix(restPos, skinned, windWeight).
//   4. When uWindStrength==0, solver emits identity matrices →
//      boneMat*restPos == restPos → displacement==0 → result==restPos.
// ---------------------------------------------------------------------------

export const WIND_SKIN_VERTEX_GLSL = /* glsl */`
vec3 windSkinPosition(vec3 restPos, float boneIdx, float boneFraction, float windWeight) {
    // uWindStrength gate: when calm (0), solver emits identity matrices so
    // this returns restPos exactly. The explicit check also allows the GPU
    // driver to skip the texelFetch entirely when wind is off.
    if (uWindStrength == 0.0) return restPos;
    mat4 boneMat = fetchBone(boneIdx);
    // PURE composed skinning. The bone matrix is the full T(pivot)*R*T(-pivot)
    // about the chain pivot, composed top-down with all ancestor bones, so
    // applying it directly makes each vertex follow its own branch AND every
    // ancestor branch with NO stretch.
    //
    // The previous boneFraction/windWeight linear blend toward restPos was the
    // bug: it fought the hierarchical composition. At a chain's base the
    // composed matrix has already moved the pivot (via the parent's rotation),
    // but the blend pulled the vertex back toward its ORIGINAL rest position,
    // stretching the branch — compounded down the hierarchy (and amplified by a
    // non-rigid trunk rotating the whole tree about the origin) into the
    // exploding-spikes artifact. Stiffness now lives entirely in the per-bone
    // rotation angle (solver) + isRigid for the trunk/roots. boneFraction and
    // windWeight are no longer used here (kept in the signature for callers).
    return (boneMat * vec4(restPos, 1.0)).xyz;
}
`;

// ---------------------------------------------------------------------------
// windBoneFollowDelta — compute the world-space follow delta for a leaf.
//
// Used in the leaf project_vertex hook (view-space add, per plan §2.6 / Decision 5):
//   followDelta = boneRotate(anchor) - anchor  (pure world-space displacement)
//   gl_Position = projectionMatrix * (mvPosition + viewMatrix * vec4(followDelta, 0.0));
//
// This mirrors the existing primary-sway pattern in leafMesh.js (pre-Task-2),
// keeping the displacement in view space so it is NOT warped by the per-leaf
// instanceMatrix rotation/scale (the "warp trap" documented in leafMesh.js).
//
// At boneIdx's identity matrix: boneMat*anchor == anchor → delta == vec3(0).
// ---------------------------------------------------------------------------

export const WIND_LEAF_FOLLOW_GLSL = /* glsl */`
vec3 windBoneFollowDelta(vec3 anchor, float boneIdx) {
    // Calm gate: no displacement when wind is off, regardless of bone-texture
    // state (prevents leaves collapsing to the origin if the texture is ever
    // unset/empty — a degenerate fetch would otherwise return -anchor).
    if (uWindStrength == 0.0) return vec3(0.0);
    mat4 boneMat = fetchBone(boneIdx);
    vec3 rotatedAnchor = (boneMat * vec4(anchor, 1.0)).xyz;
    return rotatedAnchor - anchor;
}
`;

// ---------------------------------------------------------------------------
// WIND_BONE_UNIFORM_DEFAULTS — plain JS object, no Three.js types.
//
// Callers (viewer.js) replace uBoneTex with an actual THREE.DataTexture;
// uBoneCount is set to the real bone count after buildBranchGeometry().
// uWindStrength, uTime, uWindDir are updated each frame.
// ---------------------------------------------------------------------------

export const WIND_BONE_UNIFORM_DEFAULTS = {
    uBoneCount:    0,
    uWindStrength: 0,
    uTime:         0,
    uWindDir:      [1, 0],
};
