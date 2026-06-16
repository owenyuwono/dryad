precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform int   uBoneCount;
uniform vec4  uBoneA[64];     // xyz=endpointA, w=radiusA
uniform vec4  uBoneB[64];     // xyz=endpointB, w=radiusB
uniform float uBlendK;        // smin blend radius: carbon=0.30, silicon=0.05
uniform int   uMaterialMode;  // 0=carbon/plant, 1=silicon/stone
uniform vec3  uCamPos;        // camera world position (orbiting)
uniform vec3  uTarget;        // look-at point — plant centroid, set per generation
uniform vec4  uBoneFlat[64];  // xyz=unit leaf-plane normal, w=flatten factor in [0,1] (0=round tube, 1=thin blade)
uniform vec3  uLightDir;      // unit key-light direction; plant grew toward this
uniform float uLightFlux;    // [0,1] world light intensity; envelope.light feeds this
uniform float uPigment;      // [0,1] per-species hue gene: 0=teal, 0.45=green, 0.7=olive, 1=autumnal
// uCardMode: 0 = normal full-screen (background + vignette unchanged), 1 = card mode
// (ray miss → fully transparent; ray hit → plant color, a=1.0)
uniform float uCardMode;

// Surface-relief uniforms for succulent/cactus morphospace.
// Skin stage sets these; default 0.0 = no effect on the SDF.
// Each value is in [0, 1].
uniform float uRibbing;       // radial cos-ripple ribs on stem bones
uniform float uSpininess;     // outward conical spine bumps on stem bones
uniform float uSegmentation;  // axial sin-modulation bulges on stem bones

// Woodiness: 0 = fleshy green plant skin (byte-identical to current path),
//            1 = full procedural bark (warm-brown ridged surface with AO).
// Set from genome as approximately (1 - succulence).
uniform float uWoodiness;

// ------------------------------------------------------------
// Depth-correct compositing with instanced leaf mesh (WebGL2 / GLSL ES 3.0)
//
// PINHOLE CONTRACT — viewer MUST match exactly:
//
//   This shader builds rays as:
//     forward = normalize(uTarget - uCamPos)
//     right   = normalize(cross(forward, vec3(0,1,0)))
//     up      = cross(right, forward)
//     rayDir  = normalize(forward * FOV_TAN + right * uv.x + up * uv.y)
//   where uv.x is already aspect-corrected (uv.x *= width/height) and
//   FOV_TAN = 1.1 (the forward weighting factor).
//
//   This is a standard pinhole with:
//     tan(half_vFov) = 1.0 / FOV_TAN = 1.0 / 1.1
//     half_vFov      = atan(1.0 / 1.1)  ≈ 42.27°
//     full vFov      = 2 * atan(1.0 / 1.1) ≈ 84.55°
//
//   THREE.PerspectiveCamera must be constructed with:
//     fov  = 2 * Math.atan(1.0 / 1.1) * (180 / Math.PI)  // ≈ 84.55°
//     near / far matching the raymarcher's [0, MAX_DIST=20] range
//     camera.position = uCamPos
//     camera.lookAt(uTarget)
//
//   uViewMatrix must equal camera.matrixWorldInverse.
//   uProjMatrix must equal camera.projectionMatrix.
//
//   The fov / FOV_TAN identity (tan(half_vFov) == 1/1.1) is the
//   load-bearing contract between this shader and the leaf mesh.
//   If the viewer's projection diverges from this, SDF body and leaf
//   mesh will have mismatched depth values and z-fighting will occur.
// ------------------------------------------------------------
uniform mat4 uViewMatrix;    // camera.matrixWorldInverse
uniform mat4 uProjMatrix;    // camera.projectionMatrix

// ------------------------------------------------------------
// Smooth minimum — polynomial version (Inigo Quilez)
// k controls blend radius: large k = soft/organic, small k = hard/rigid
// ------------------------------------------------------------
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// ------------------------------------------------------------
// Tapered capsule SDF (iq's sdRoundCone)
// p: query point, a/b: endpoints, r1/r2: radii at a and b
// ------------------------------------------------------------
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3  ba = b - a;
  float l2 = dot(ba, ba);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;

  vec3  pa = p - a;
  float y  = dot(pa, ba);
  float z  = y - l2;
  float x2 = dot(pa * l2 - ba * y, pa * l2 - ba * y);
  float y2 = y * y * l2;
  float z2 = z * z * l2;

  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

// ------------------------------------------------------------
// Scene SDF — smooth-union all bones (round cones), with optional
// per-bone single-axis squash to produce flattened fronds (squash path),
// and optional procedural relief (ribbing, segmentation, spines) on
// round stem bones.
//
// NOTE: Leaf bones (uBoneFlat[i].w > 0) now render via the same squash
// round-cone path as stems. Instanced leaf mesh handles blade geometry.
// The shader is robust: regardless of the w value, only the squash
// round-cone path runs — no sdLeaf / leaf blades are rendered here.
//
// SQUASH MATH (conservative distance bound proof):
//   Given leaf-plane normal n (unit) and flatten factor f in [0,1]:
//     s = 1.0 - 0.9*f        (s in [0.1, 1.0]; f=0 → s=1 identity)
//   Decompose p relative to bone endpoint A:
//     along = dot(p - A.xyz, n)           // component toward leaf normal
//     perp  = (p - A.xyz) - along * n     // component in leaf plane
//   Stretch space along n by 1/s:
//     pSquashed = A.xyz + perp + (along / s) * n
//   Evaluate sdRoundCone on pSquashed, then multiply result by s.
//
//   Why it stays conservative: stretching by 1/s shrinks the capsule
//   to 1/s of its original thickness along n while leaving the other
//   two axes unchanged. The raw SDF in stretched space is 1/s × the
//   Euclidean distance to the squashed surface in original space when
//   evaluated along the squash axis. Multiplying by s gives a value ≤
//   the true Euclidean distance (since s ≤ 1 and the minimum axis
//   scale is s), so the result is always a conservative lower bound —
//   the sphere-tracer cannot overshoot.
//
//   Identity check when f == 0:
//     s = 1.0 - 0.9*0.0 = 1.0
//     pSquashed = A.xyz + perp + (along / 1.0) * n = p    ← exact p
//     result × 1.0 = sdRoundCone(p, ...) unchanged         ← no regression
//
// RELIEF MATH (conservative distance bound proofs):
//   Relief only applies to STEM bones (f < 0.05).  A stemMask = 1 for
//   stems and 0 for lamina/blade bones ensures broad flat blades (high f)
//   are untouched.  Note: fat succulent columns are already produced by
//   large-radius capsules at f=0 with no new primitive needed.
//
//   All three effects work by subtracting a non-negative value D from
//   the raw `bone` distance.  Since sdRoundCone has Lipschitz constant
//   1 and D ≥ 0, returning (bone - D) is ≤ bone ≤ true distance to
//   the original surface.  The new implicit surface (where bone - D = 0)
//   is a displaced version of the original capsule, pushed outward by
//   at most max(D) world-units.  Because we never add to the distance,
//   the sphere-tracer always underestimates step size → conservative.
//
//   RIBBING (uRibbing in [0,1], k = 11 ribs):
//     Compute theta = atan(dot(perp, vAx), dot(perp, uAx)) around the
//     bone axis.  Use a one-sided cosine lobe (cos(k*theta)+1)*0.5 ∈
//     [0,1] so ribs only push the surface OUT (no valley inversion).
//     amp_rib = uRibbing * r_bone * 0.20
//     D_rib   = amp_rib * (cos(11.0*theta) + 1.0) * 0.5
//     Max displacement = 0.20 * r_bone (20% of local radius).
//     At uRibbing=0: amp_rib=0, D_rib=0, result unchanged (identity).
//
//   SEGMENTATION (uSegmentation in [0,1], m = 6 segments):
//     Compute t_norm = position along bone axis in [0,1].
//     Use a one-sided sine lobe max(sin(m*PI*t_norm*2.0),0.0) ∈ [0,1]
//     so bulges only push OUT, no inward pinch that could overshoot.
//     amp_seg = uSegmentation * r_bone * 0.18
//     D_seg   = amp_seg * max(sin(6.0 * PI * t_norm), 0.0)
//     Max displacement = 0.18 * r_bone (18% of local radius).
//     At uSegmentation=0: amp_seg=0, D_seg=0, identity.
//
//   SPINES (uSpininess in [0,1], zero extra bones):
//     Map the bone surface to a 2D (col, row) lattice in (theta/(2PI),
//     t_norm) space scaled to (8 columns, 12 rows).  At each lattice
//     cell centre, a radial smooth bump in UV-distance gives a spine:
//       spineDist2 = du*du + dv*dv   (in cell-fraction units)
//       spineField = max(0.0, 1.0 - spineDist2 * 5.0)^2  ∈ [0,1]
//     amp_spine = uSpininess * r_bone * 0.35
//     D_spine   = amp_spine * spineField
//     Max displacement = 0.35 * r_bone.  Spines are domain-repeated on
//     the bone's own surface — no geometry/bones added.
//     At uSpininess=0: amp_spine=0, D_spine=0, identity.
//
//   COMBINED identity at uRibbing=uSegmentation=uSpininess=0:
//     All amps are 0 ⟹ all D terms are 0 ⟹ bone unchanged ⟹
//     the returned SDF is byte-identical to the pre-relief version.
//
// GLSL ES requires constant loop upper bound; break on uBoneCount.
// ------------------------------------------------------------
float sceneSDF(vec3 p) {
  float d = 1e10;
  for (int i = 0; i < 64; i++) {
    if (i >= uBoneCount) break;
    vec4 A = uBoneA[i];
    vec4 B = uBoneB[i];

    // Per-bone flatten: w=0 → identity (stem/branch), w>0 → blade squash.
    // High w (broad lamina/leaf) is left entirely untouched by relief below.
    // Thick succulent columns are fat capsules at w≈0 — no new primitive.
    // Leaf mesh handles blade geometry; all bones use this squash/round-cone path.
    float f = uBoneFlat[i].w;
    vec3  n = uBoneFlat[i].xyz;                       // unit leaf-plane normal

    float s = 1.0 - 0.9 * f;                         // minimum axis scale
    vec3  rel   = p - A.xyz;
    float along = dot(rel, n);
    vec3  pSq   = A.xyz + (rel - along * n) + (along / s) * n;

    float bone = sdRoundCone(pSq, A.xyz, B.xyz, A.w, B.w) * s;

    // ---- Procedural surface relief (stem bones only) ----
    // stemMask = 1 for round stems (f < 0.05), 0 for blade/lamina bones.
    // Multiplied into every amplitude so uRibbing/uSegmentation/uSpininess=0
    // AND lamina bones both produce zero displacement (identity path).
    float stemMask = 1.0 - step(0.05, f);

    // Build a consistent local frame around the bone axis.
    // ba_dir: unit vector along the bone.
    vec3  ba_dir  = normalize(B.xyz - A.xyz);
    // Project query point onto the bone axis to get axial parameter t_norm.
    float ba_len  = length(B.xyz - A.xyz);
    float t_norm  = clamp(dot(p - A.xyz, ba_dir) / max(ba_len, 1e-5), 0.0, 1.0);
    // Interpolated cone radius at the projected position along the bone.
    float r_bone  = mix(A.w, B.w, t_norm);
    // Perpendicular component from the bone axis in world space.
    vec3  perp    = (p - A.xyz) - dot(p - A.xyz, ba_dir) * ba_dir;

    // Build two orthogonal axes in the bone's cross-section plane.
    // Pick an up-vector not parallel to ba_dir to avoid degeneracy.
    vec3  upRef  = (abs(ba_dir.y) < 0.9) ? vec3(0.0, 1.0, 0.0)
                                           : vec3(1.0, 0.0, 0.0);
    vec3  uAx = normalize(cross(ba_dir, upRef));   // first cross-section axis
    vec3  vAx = cross(ba_dir, uAx);               // second (already unit length)

    // Angle around the bone axis in [-PI, PI].
    float theta = atan(dot(perp, vAx), dot(perp, uAx));

    // ---- 1. RIBBING ----
    // One-sided cosine lobe: (cos(k*theta)+1)/2 ∈ [0,1].
    // k=11 gives 11 ribs visible around the stem circumference.
    // Max displacement amp_rib = uRibbing * r_bone * 0.20.
    // D_rib ∈ [0, amp_rib] → only pushes surface OUT → conservative.
    float amp_rib  = uRibbing * r_bone * 0.20 * stemMask;
    float D_rib    = amp_rib * (cos(11.0 * theta) + 1.0) * 0.5;

    // ---- 2. SEGMENTATION ----
    // One-sided sine: max(sin(m*PI*t_norm), 0) ∈ [0,1].
    // m=6 gives 6 bulge rings along the bone length.
    // Max displacement amp_seg = uSegmentation * r_bone * 0.18.
    // Negative half of sine is clamped to 0 → no inward pinch → conservative.
    float amp_seg  = uSegmentation * r_bone * 0.18 * stemMask;
    float D_seg    = amp_seg * max(sin(6.0 * 3.14159265 * t_norm), 0.0);

    // ---- 3. SPINES (zero-bone domain-repeat) ----
    // Map (theta, t_norm) to a 2D lattice: 8 columns × 12 rows.
    // Offset odd rows by half a column for a staggered hex-like layout.
    float col_f  = theta / (2.0 * 3.14159265) * 8.0;  // [−4, 4]
    float row_f  = t_norm * 12.0;                       // [0, 12]
    // Stagger: shift even/odd rows to avoid aligned-grid artefacts.
    col_f += floor(row_f + 0.5) * 0.5;
    // Distance to nearest lattice point in cell-fraction units.
    float du     = fract(col_f) - 0.5;                 // ∈ [−0.5, 0.5]
    float dv     = fract(row_f) - 0.5;
    float sd2    = du * du + dv * dv;                  // squared UV-cell dist
    // Smooth bump: 1 at cell centre → 0 at radius ~0.45 cell widths.
    float spineF = max(0.0, 1.0 - sd2 * 5.0);
    spineF       = spineF * spineF;                     // ∈ [0,1], C1-smooth
    // Max displacement amp_spine = uSpininess * r_bone * 0.35.
    float amp_spine = uSpininess * r_bone * 0.35 * stemMask;
    float D_spine   = amp_spine * spineF;

    // Apply relief: subtract total displacement from bone distance.
    // Each D_* ≥ 0, so (bone - D_total) ≤ bone ≤ true distance. Conservative.
    bone -= (D_rib + D_seg + D_spine);

    float k_i = max(uBlendK * min(A.w, B.w) * 2.5, 0.002);
    d = smin(d, bone, k_i);
  }
  return d;
}

// ------------------------------------------------------------
// Central-difference normal (gradient of SDF)
// ------------------------------------------------------------
vec3 calcNormal(vec3 p) {
  const float e = 0.001;
  return normalize(vec3(
    sceneSDF(p + vec3(e, 0, 0)) - sceneSDF(p - vec3(e, 0, 0)),
    sceneSDF(p + vec3(0, e, 0)) - sceneSDF(p - vec3(0, e, 0)),
    sceneSDF(p + vec3(0, 0, e)) - sceneSDF(p - vec3(0, 0, e))
  ));
}

// ============================================================
// PROCEDURAL BARK MATERIAL HELPERS
// ============================================================
//
// GRAIN DIRECTION: Uses object-space Y as the primary trunk axis so bark
// ridges run vertically along stems. The along-axis coordinate is stretched
// ~7x relative to the around-axis so ridges are elongated and vertical.
// Per-bone cylindrical grain (aligning to each branch axis independently)
// is a future refinement — vertical-Y grain is correct for the main trunk
// and acceptable for branches in the current design.
//
// NOISE BUDGET: Each bark hit adds ~22-28 hash/noise evaluations:
//   • domain warp (2), coarse fissure (5), fine grain (5): 12 ridge evals
//   • Voronoi 3×3 grid: 9 hash evals
//   • lichen + blotch + micro: 3 noise evals
//   • bump FD (3 extra height-field evals × ~6 each): ~18 evals
//   Total: ~42 evals per hit + 5 AO taps (each = full sceneSDF = 96×64 ops).
//   Still well within budget — AO taps dominate cost, not noise math.
// ============================================================

// ---- Bark tuning constants — nudge these to reshape the look ----
//
// RIDGE FREQUENCY: base_freq = 1/featureScale * BARK_RIDGE_FREQ_SCALE
//   Increase → finer, more-numerous ridges.  1.0 = stock "one ridge per radius".
const float BARK_RIDGE_FREQ_SCALE   = 1.0;
//
// COARSE FISSURE: big trunk cracks, ~2-3× the ridge spacing.
//   BARK_FISSURE_FREQ_SCALE < BARK_RIDGE_FREQ_SCALE → coarser, deeper layer.
//   BARK_FISSURE_WEIGHT in [0,1]: how strongly the coarse layer darkens furrows.
const float BARK_FISSURE_FREQ_SCALE = 0.42;  // ~2.4× coarser than fine ridges
const float BARK_FISSURE_WEIGHT     = 0.55;  // weight of coarse layer in combined h
//
// BUMP STRENGTH: multiplied into the height-field gradient before perturbing normal.
//   Higher = more exaggerated relief. Range: 0.5 (twig) → 1.4 (trunk).
const float BARK_BUMP_MIN           = 0.55;  // twig bump (was 0.4)
const float BARK_BUMP_MAX           = 1.40;  // trunk bump (was 0.8)
//
// VORONOI PLATE: cellular crack layer — plate size scales with featureScale.
//   BARK_PLATE_FREQ: how many plates per world-unit (before featureScale scaling).
//   Smaller number → bigger plates (trunk); larger → smaller scales (branch).
//   BARK_CRACK_WIDTH: controls crack edge width; higher = thinner cracks.
//   BARK_CRACK_DEPTH: how much cracks darken the surface (0 = no effect).
const float BARK_PLATE_FREQ         = 2.8;   // plates per featureScale unit
const float BARK_CRACK_WIDTH        = 6.0;   // sharpness of crack edges (IQ smoothstep knee)
const float BARK_CRACK_DEPTH        = 0.45;  // crack darkness weight
//
// PALETTE — all in linear sRGB, tweak individually:
const vec3  BARK_COLOR_RIDGE        = vec3(0.36, 0.24, 0.13); // warm tan ridge tops
const vec3  BARK_COLOR_FURROW       = vec3(0.14, 0.11, 0.09); // dark desaturated grey-brown furrows
const vec3  BARK_COLOR_INNER        = vec3(0.42, 0.19, 0.08); // reddish exposed inner bark (midtones)
const vec3  BARK_COLOR_LICHEN       = vec3(0.48, 0.53, 0.33); // sage-green lichen in crevices
const vec3  BARK_COLOR_BLOTCH_WARM  = vec3(0.30, 0.19, 0.10); // large-scale warm brown blotch
const vec3  BARK_COLOR_BLOTCH_COOL  = vec3(0.18, 0.15, 0.12); // large-scale cool grey-brown blotch

// Value noise hash — fast, no trig dependency.
// Returns a pseudo-random float in [-1, 1] for a vec3 seed.
float barkHash(vec3 p) {
    p = fract(p * vec3(127.1, 311.7, 74.7));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z) * 2.0 - 1.0;
}

// 3-D value noise: trilinear interpolation of lattice hashes.
// Smoothstep kernel gives C1 continuity.
float barkNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f); // smoothstep

    float n000 = barkHash(i + vec3(0.0, 0.0, 0.0));
    float n100 = barkHash(i + vec3(1.0, 0.0, 0.0));
    float n010 = barkHash(i + vec3(0.0, 1.0, 0.0));
    float n110 = barkHash(i + vec3(1.0, 1.0, 0.0));
    float n001 = barkHash(i + vec3(0.0, 0.0, 1.0));
    float n101 = barkHash(i + vec3(1.0, 0.0, 1.0));
    float n011 = barkHash(i + vec3(0.0, 1.0, 1.0));
    float n111 = barkHash(i + vec3(1.0, 1.0, 1.0));

    return mix(
        mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
        u.z);
}

// Single ridge-noise octave: sharp valley / rounded ridge shape.
// (1 - |n|)^2 maps the center of each noise cell to 1 and the
// borders to 0, giving bright ridges on a dark base.
// Power of 2 gives a broader flat top and sharper valley — more furrow-like.
float ridgeOctave(vec3 p) {
    float n = barkNoise(p);
    n = 1.0 - abs(n);
    return n * n;
}

// Low-frequency FBM for domain warp input (2 octaves, very cheap).
vec3 barkWarpFBM(vec3 p) {
    float a = barkNoise(p);
    float b = barkNoise(p * 2.07 + vec3(3.17, 1.43, 2.71));
    return vec3(a + 0.5 * b, b + 0.5 * a, a * b) * 0.5;
}

// Single-layer ridged FBM at a given frequency (no domain warp — caller warps).
// 5 octaves.  Returns h ∈ [0, 1] where 1 = ridge top, 0 = groove bottom.
// The power(h, 0.7) sharpens the transition, making furrows crisper.
float ridgedFBM(vec3 pw, float freq) {
    float amp   = 1.0;
    float total = 0.0;
    float norm  = 0.0;
    for (int oct = 0; oct < 5; oct++) {
        total += ridgeOctave(pw * freq) * amp;
        norm  += amp;
        freq  *= 2.13;   // slightly irrational lacunarity → no aliasing
        amp   *= 0.52;   // gain < 0.5 keeps ridges dominant
    }
    float h = clamp(total / norm, 0.0, 1.0);
    // Sharpening: push ridge peaks up and furrow bottoms down for crisper look.
    return pow(h, 0.65);
}

// Combined height field: coarse fissure layer + fine grain layer.
// The coarse layer provides big trunk furrows; the fine layer adds grain texture.
// BARK_FISSURE_WEIGHT blends them: higher weight = more-dominant coarse furrows.
// Returns h ∈ [0, 1] where 1 = ridge top, 0 = deep furrow.
float barkHeightField(vec3 p_grain, float featureScale) {
    // Domain warp: nudge the ridge coordinates with a low-freq FBM so
    // ridges meander organically rather than running perfectly straight.
    vec3 warpOfs = barkWarpFBM(p_grain * 0.45) * 0.55;
    vec3 pw = p_grain + warpOfs;

    float baseFreq = BARK_RIDGE_FREQ_SCALE / max(featureScale, 0.01);

    // Coarse fissure layer (big trunk cracks, lower frequency).
    float coarseH = ridgedFBM(pw, baseFreq * BARK_FISSURE_FREQ_SCALE);

    // Fine grain layer (original-style grain on top of the coarse structure).
    float fineH   = ridgedFBM(pw, baseFreq);

    // Combine: coarse sets the macro furrow, fine adds surface grain.
    // Where coarse is low (deep furrow), fine is suppressed too — keeps the
    // big cracks reading as deep, not filled in with fine noise.
    float combined = mix(fineH, coarseH, BARK_FISSURE_WEIGHT);
    // Multiply by coarse so fine ridges fade in the deepest furrows.
    combined = combined * (0.4 + 0.6 * coarseH);

    return clamp(combined, 0.0, 1.0);
}

// Voronoi / cellular nearest-edge distance in 2D, computed cheaply.
// q: 2D coordinate in plate space.  Returns edge distance in [0,1]
// where 0 = on a crack boundary, 1 = far from any crack.
float barkVoronoiEdge(vec2 q) {
    vec2 qi = floor(q);
    vec2 qf = fract(q);

    float minDist1 = 8.0;  // nearest cell centre distance
    float minDist2 = 8.0;  // second-nearest

    // 3×3 lattice search — constant loop bounds, GLSL ES 3.0 safe.
    for (int jy = -1; jy <= 1; jy++) {
        for (int jx = -1; jx <= 1; jx++) {
            vec2 neighbor = vec2(float(jx), float(jy));
            // Random offset for cell centre (in [0.1, 0.9] to avoid edge collisions).
            vec2 cellHash2 = vec2(
                barkHash(vec3(qi + neighbor, 0.0)),
                barkHash(vec3(qi + neighbor, 1.0))
            ) * 0.45 + 0.5;
            vec2 diff = neighbor + cellHash2 - qf;
            float d = dot(diff, diff);
            if (d < minDist1) { minDist2 = minDist1; minDist1 = d; }
            else if (d < minDist2) { minDist2 = d; }
        }
    }
    // Edge distance: F2 - F1 (≈ 0 at boundaries, > 0 inside plates).
    // sqrt to get linear distance; smoothstep for crack sharpness.
    float edge = sqrt(minDist2) - sqrt(minDist1);
    return clamp(edge * BARK_CRACK_WIDTH, 0.0, 1.0);
}

// Bark albedo given height field h, Voronoi edge, object-space point, and Y pos.
// RICHER COLOR: warm-brown ridges, dark grey-brown furrows, reddish midtone,
// lichen concentrated in low-Y crevices, large-scale color blotch.
vec3 barkAlbedo(vec3 p_grain, float h, float voronoiEdge, float worldY) {
    // ---- Inner-bark midtone: only at intermediate heights (not ridges, not deepest grooves) ----
    // Peaks at h≈0.35 (the 'shoulder' between ridge and deep furrow).
    float innerMask = clamp(1.0 - abs(h - 0.35) * 4.0, 0.0, 1.0);
    innerMask *= innerMask;

    // ---- Base ridge/furrow interpolation ----
    // h→0: FURROW color, h→1: RIDGE color, midtone INNER bleeds in at ~0.35.
    vec3 baseCol = mix(BARK_COLOR_FURROW, BARK_COLOR_RIDGE, h);
    baseCol = mix(baseCol, BARK_COLOR_INNER, innerMask * 0.55);

    // ---- Voronoi crack darkening ----
    // Crack edges (voronoiEdge near 0) pull color toward a darker version.
    vec3 crackCol = BARK_COLOR_FURROW * 0.6;  // even darker in crack boundaries
    float crackMask = BARK_CRACK_DEPTH * (1.0 - voronoiEdge) * (1.0 - h * 0.5);
    baseCol = mix(baseCol, crackCol, crackMask);

    // ---- Lichen: in deep crevices AND biased toward base (lower worldY) ----
    // lichenCrevice: low h = deep furrow = likely crevice.
    // lichenBase: fades out above Y=1.5 so lichen pools near ground.
    float lichenCrevice = clamp((0.22 - h) * 6.0, 0.0, 1.0);
    float lichenBase    = clamp(1.0 - worldY * 0.55, 0.0, 1.0);
    float lichenSpatter = clamp(barkNoise(p_grain * 3.7 + vec3(7.3, 2.9, 5.1)) * 0.5 + 0.5, 0.0, 1.0);
    float lichenMask = lichenCrevice * lichenBase * lichenSpatter;
    baseCol = mix(baseCol, BARK_COLOR_LICHEN, lichenMask * 0.70);

    // ---- Large-scale color blotch (low-freq noise) ----
    // Prevents uniform brown — drifts between warm and cool-brown regions.
    float blotch = barkNoise(p_grain * 0.18 + vec3(5.5, 1.3, 3.7)) * 0.5 + 0.5;
    vec3 blotchCol = mix(BARK_COLOR_BLOTCH_COOL, BARK_COLOR_BLOTCH_WARM, blotch);
    baseCol = mix(baseCol, blotchCol, 0.22);

    // ---- Micro-variation: ±0.04 from high-freq noise ----
    float micro = barkNoise(p_grain * 8.3 + vec3(1.1, 4.4, 2.2)) * 0.04;
    baseCol = clamp(baseCol + micro, 0.0, 1.0);

    return baseCol;
}

// Bark normal perturbation via gradient of the height field.
// Uses finite differences on barkHeightField; eps scaled to featureScale
// so thin twigs get tighter bumps and thick trunks get broader bumps.
// Returns a perturbed normal in world space.
vec3 barkPerturbNormal(vec3 p_grain, vec3 worldNormal, float featureScale) {
    // Bump epsilon proportional to feature size, clamped to a sane range.
    float eps = clamp(featureScale * 0.04, 0.003, 0.04);

    float h0  = barkHeightField(p_grain, featureScale);
    float hx  = barkHeightField(p_grain + vec3(eps, 0.0, 0.0), featureScale);
    float hz  = barkHeightField(p_grain + vec3(0.0, 0.0, eps), featureScale);
    // Y gradient is along the ridge direction — contributes less to the
    // apparent bump since the ridges run in Y. Still include for completeness.
    float hy  = barkHeightField(p_grain + vec3(0.0, eps, 0.0), featureScale);

    // Gradient of the scalar height field in grain space.
    // Divided by eps to get approximate derivative.
    vec3 grad = vec3((hx - h0) / eps, (hy - h0) / eps, (hz - h0) / eps);

    // Bump strength: stronger on thick trunks (large featureScale), weaker on twigs.
    float bumpStr = clamp(featureScale * 1.8, BARK_BUMP_MIN, BARK_BUMP_MAX);

    // Perturb world normal by the height-field gradient (tangent-space approx).
    // Since p_grain is in object space with Y=up, the gradient is already in
    // a consistent frame. We subtract the gradient component along the normal
    // and re-normalise.
    vec3 perturbed = normalize(worldNormal - grad * bumpStr);
    return perturbed;
}

// Cheap SDF ambient occlusion — 5-step march along the surface normal.
// Falloff: later steps contribute less (exponential weight).
// Applied ONLY to the ambient/indirect term so branch forks and grooves darken.
// ao_out ∈ [0, 1] where 1 = fully occluded.
float barkAO(vec3 p, vec3 n) {
    float ao   = 0.0;
    float step = 0.06;   // world-space step size along normal
    float weight = 1.0;

    for (int i = 1; i <= 5; i++) {
        float fi = float(i);
        float dist = fi * step;
        float d    = sceneSDF(p + n * dist);
        // How much is the marched distance occluded: (expected - actual).
        // Clamped to ≥0 so open-sky taps don't add light.
        ao     += weight * clamp(dist - d, 0.0, step * 1.5);
        weight *= 0.6;   // exponential falloff per step
    }

    // Normalise to [0,1]. Maximum possible ao sum ≈ 0.17; scale to contrast.
    return clamp(ao * 5.5, 0.0, 1.0);
}

// Full bark shading at a hit point.
// p:           object-space hit position (same as world in this scene)
// worldNormal: SDF gradient normal (before bump)
// rayDir:      view direction
// Returns RGB color (un-fogged).
vec3 shadeBark(vec3 p, vec3 worldNormal, vec3 rayDir) {
    // ---- UV / grain space ----
    // Stretch Y by 7x so ridges are vertically elongated (bark runs up the stem).
    // XZ gives the radial/circumferential variation.
    // Feature scale: use XZ magnitude as a proxy for local radius/thickness.
    // A thick trunk has a larger radius → coarser ridges; thin twig → finer.
    // We clamp to [0.04, 0.35] to keep ridges in a visually sane range.
    float localRadius = clamp(length(p.xz), 0.04, 0.35);
    float featureScale = localRadius;

    // Grain-space coordinate: radial XZ + stretched Y.
    vec3 p_grain = vec3(p.x, p.y * 7.0, p.z);

    // ---- Height field (coarse fissure + fine grain combined) ----
    float h = barkHeightField(p_grain, featureScale);

    // ---- Voronoi plate / crack layer ----
    // Use XZ plane at the trunk surface for plate UV.
    // Scale: larger featureScale → fewer, larger plates (trunk reads as big plates).
    float plateFreq = BARK_PLATE_FREQ / max(featureScale, 0.04);
    vec2 plateUV = vec2(p.x, p.y * 1.4) * plateFreq; // slight Y stretch keeps plates elongated
    float voronoiEdge = barkVoronoiEdge(plateUV);

    // ---- Albedo ----
    vec3 albedo = barkAlbedo(p_grain, h, voronoiEdge, p.y);

    // ---- Normal bump ----
    vec3 bumpedNormal = barkPerturbNormal(p_grain, worldNormal, featureScale);

    // ---- Roughness: grooves rougher, ridge tops slightly shinier ----
    float roughness = mix(0.92, 0.55, h);

    // ---- Lighting ----
    float fluxCurve = smoothstep(0.0, 1.0, uLightFlux);
    float keyScale  = mix(0.35, 1.35, fluxCurve);
    float ambScale  = mix(0.70, 1.15, fluxCurve);

    // Key diffuse
    float diff = max(dot(bumpedNormal, uLightDir), 0.0);

    // Specular: narrow lobe on the smooth ridge tops (roughness-dependent exponent).
    // exponent = mix(8, 64, 1-roughness) so grooves (rough=0.92) have exp~10,
    // ridge tops (rough=0.55) have exp~38 for a subtle catchlight highlight.
    float specExp = mix(8.0, 64.0, 1.0 - roughness);
    vec3  halfV   = normalize(uLightDir - rayDir);
    float spec    = pow(max(dot(bumpedNormal, halfV), 0.0), specExp);
    // Weight by h (ridge height) so only ridge tops catch the highlight.
    spec *= h * (1.0 - roughness) * 0.45 * keyScale;

    // Soft ridge-top highlight: a gentle additive bloom on the very top of ridges.
    // Gives the sense of light skimming across raised bark plates.
    float ridgeHighlight = smoothstep(0.65, 1.0, h) * diff * 0.12 * keyScale;

    // Rim bounce (cooler, muted — bark reflects less sky than leaves)
    vec3  rimLight = normalize(vec3(-0.8, 0.3, -0.6));
    float rim      = pow(max(dot(bumpedNormal, rimLight), 0.0), 3.0) * 0.10;

    // AO for ambient/indirect term only — furrows and crevices darken
    float ao = barkAO(p, bumpedNormal);
    float ambOccluded = 0.07 * ambScale * (1.0 - ao * 0.85);

    // Compose
    vec3 color = albedo * (diff * 0.80 * keyScale + ambOccluded)
               + albedo * ridgeHighlight              // ridge top bloom (albedo-tinted)
               + vec3(0.55, 0.42, 0.28) * spec        // warm specular catchlight
               + vec3(0.18, 0.14, 0.10) * rim;        // muted warm rim

    return color;
}

// ------------------------------------------------------------
// Material — plant/flora (mode 0) vs silicon/stone (mode 1, kept for
// compilation but no longer reached from the UI).
//
// Mode 0 — PLANT / FLORA:
//   Base: green palette blended by height (pos.y):
//     low/root = deep forest green, high/tip = bright spring green.
//   Diffuse key: uLightDir (plant grew toward it).
//   Backlit translucency: a wrap/SSS term — when the eye looks at the
//     back face relative to the light (dot(-N, uLightDir) > 0), the
//     leaf appears to glow green as light scatters through thin tissue.
//     Term: pow(max(dot(-normal, uLightDir), 0.0), 3.0) * 0.45.
//   Specular: wide-lobe Blinn-Phong (exponent 18) tinted slightly warm
//     for waxy cuticle sheen — intentionally soft, not plastic.
//   Rim/fill: cool blue-green backlight for ambient sky bounce.
// ------------------------------------------------------------
vec3 getMaterial(vec3 pos, vec3 normal, vec3 rayDir, int mode) {
  // Rim light is a fixed aesthetic fill independent of mode
  vec3 rimLight = normalize(vec3(-0.8, 0.3, -0.6));
  float rim     = pow(max(dot(normal, rimLight), 0.0), 3.0) * 0.20;
  float amb     = 0.07;

  if (mode == 0) {
    // -----------------------------------------------------------
    // Plant / flora material
    // -----------------------------------------------------------

    // Height-based palette: deeper/older near base, fresh at tips.
    // Endpoint colors are parameterised by uPigment (the species hue gene).
    //
    // Ramp anchors — base (root) endpoint:
    //   0.00 → teal         vec3(0.04, 0.18, 0.20)
    //   0.45 → green (orig) vec3(0.06, 0.22, 0.07)  ← calibration point
    //   0.70 → olive        vec3(0.14, 0.20, 0.04)
    //   1.00 → autumnal     vec3(0.30, 0.12, 0.02)
    //
    // Ramp anchors — tip (young) endpoint:
    //   0.00 → teal         vec3(0.18, 0.65, 0.55)
    //   0.45 → green (orig) vec3(0.28, 0.62, 0.18)  ← calibration point
    //   0.70 → olive        vec3(0.52, 0.60, 0.08)
    //   1.00 → autumnal     vec3(0.72, 0.42, 0.06)
    //
    // Piecewise linear across three segments; no dynamic arrays or loops.
    // Each segment driver is clamped to [0,1] and mix() handles blending.
    float pigSeg0 = clamp(uPigment / 0.45, 0.0, 1.0);         // [0.00 → 0.45]
    float pigSeg1 = clamp((uPigment - 0.45) / 0.25, 0.0, 1.0); // [0.45 → 0.70]
    float pigSeg2 = clamp((uPigment - 0.70) / 0.30, 0.0, 1.0); // [0.70 → 1.00]

    // Base (root) color piecewise chain
    vec3 pigBase01 = mix(vec3(0.04, 0.18, 0.20), vec3(0.06, 0.22, 0.07), pigSeg0);
    vec3 pigBase12 = mix(vec3(0.06, 0.22, 0.07), vec3(0.14, 0.20, 0.04), pigSeg1);
    vec3 pigBase23 = mix(vec3(0.14, 0.20, 0.04), vec3(0.30, 0.12, 0.02), pigSeg2);
    // Select active segment: seg0 when pigment<0.45, seg1 when 0.45-0.70, seg2 beyond
    float inSeg1   = step(0.45, uPigment);
    float inSeg2   = step(0.70, uPigment);
    vec3 pigBase   = mix(mix(pigBase01, pigBase12, inSeg1), pigBase23, inSeg2);

    // Tip (young) color piecewise chain
    vec3 pigTip01  = mix(vec3(0.18, 0.65, 0.55), vec3(0.28, 0.62, 0.18), pigSeg0);
    vec3 pigTip12  = mix(vec3(0.28, 0.62, 0.18), vec3(0.52, 0.60, 0.08), pigSeg1);
    vec3 pigTip23  = mix(vec3(0.52, 0.60, 0.08), vec3(0.72, 0.42, 0.06), pigSeg2);
    vec3 pigTip    = mix(mix(pigTip01, pigTip12, inSeg1), pigTip23, inSeg2);

    float yFac    = clamp(pos.y * 0.35 + 0.5, 0.0, 1.0);
    vec3 baseColor = mix(pigBase, pigTip, yFac);

    // Flux → intensity curve.
    // smoothstep maps [0,1]→[0,1] with a gentle S-curve; at uLightFlux=0.6
    // smoothstep(0,1,0.6) = 3*(0.36)-2*(0.216) = 0.648.
    // mix(0.35, 1.35, 0.648) = 0.35 + 0.648*1.0 = 0.998 ≈ 1.0  ← no regression.
    // At flux=0.0: keyScale=0.35 (dim mood, not crushed black).
    // At flux=1.0: keyScale=1.35 (vivid bright, not blown white).
    float fluxCurve  = smoothstep(0.0, 1.0, uLightFlux);
    float keyScale   = mix(0.35, 1.35, fluxCurve);  // drives key/diffuse + specular
    // Backlit gets a softer range so leaves stay readable even when dim.
    // mix(0.50, 1.20, 0.648) = 0.50 + 0.648*0.70 = 0.954 ≈ 1.0 at default.
    float backlitScale = mix(0.50, 1.20, fluxCurve);
    // Ambient/fill shifts only gently to preserve overall readability.
    // mix(0.70, 1.15, 0.648) = 0.70 + 0.648*0.45 = 0.992 ≈ 1.0 at default.
    float ambScale   = mix(0.70, 1.15, fluxCurve);

    // Key diffuse — light comes from uLightDir (plant growth direction)
    float diff = max(dot(normal, uLightDir), 0.0);

    // Backlit translucency / wrap term:
    // When the surface normal faces away from the light (back face),
    // dot(-N, L) > 0 — light scatters through the thin leaf tissue.
    // Exponent 3 gives a tight-but-visible glow; 0.45 weight tints
    // the transmitted color green (biological chlorophyll glow).
    float backlit = pow(max(dot(-normal, uLightDir), 0.0), 3.0) * 0.45 * backlitScale;
    vec3 transColor = vec3(0.15, 0.55, 0.10) * backlit;

    // Waxy leaf sheen: wide Blinn-Phong lobe (exponent 18), low weight.
    // Soft enough to read as cuticle, not hard plastic.
    vec3  halfV = normalize(uLightDir - rayDir);
    float spec  = pow(max(dot(normal, halfV), 0.0), 18.0) * 0.22 * keyScale;
    vec3 specColor = vec3(0.85, 0.95, 0.70) * spec; // slightly warm-green tint

    // Compose fleshy color: ambient + diffuse + translucency + specular + rim bounce
    vec3 fleshyColor = baseColor * (diff * 0.80 * keyScale + amb * ambScale)
                     + transColor
                     + specColor
                     + vec3(0.10, 0.30, 0.20) * rim;  // cool sky-green rim

    // -----------------------------------------------------------
    // BARK BLEND (uWoodiness)
    // When uWoodiness == 0.0: mix(fleshy, bark, 0.0) = fleshy exactly.
    // Bark branch is only evaluated when uWoodiness > 0.0.
    // The short-circuit avoids the bark noise cost for pure succulents,
    // but even without branching the multiply-by-zero path is safe.
    //
    // GLSL ES 3.0 has no dynamic branching guarantee, but uWoodiness is a
    // uniform — the driver may still flatten the branch statically when it
    // is set to 0. We rely on mix() for correctness regardless.
    // -----------------------------------------------------------
    vec3 barkColor = shadeBark(pos, normal, rayDir);
    vec3 color = mix(fleshyColor, barkColor, uWoodiness);

    return color;

  } else {
    // -----------------------------------------------------------
    // Silicon / mineral — kept intact, unreachable from UI
    // -----------------------------------------------------------
    vec3 lightDir = normalize(vec3(1.2, 2.0, 1.5)); // original fixed light

    // Slight faceting effect via normal quantization
    vec3 quantNorm     = normalize(floor(normal * 4.0 + 0.5) / 4.0);
    vec3 shadingNormal = mix(normal, quantNorm, 0.35);

    float diffFacet = max(dot(shadingNormal, lightDir), 0.0);

    float yFac = clamp(pos.y * 0.4 + 0.5, 0.0, 1.0);
    vec3 baseColor = mix(vec3(0.30, 0.33, 0.40), vec3(0.50, 0.52, 0.55), yFac);

    // Harder/narrower specular = crystalline
    vec3  halfV = normalize(lightDir - rayDir);
    float spec  = pow(max(dot(shadingNormal, halfV), 0.0), 64.0) * 0.9;

    vec3 color = baseColor * (diffFacet * 0.80 + amb)
               + vec3(0.85, 0.90, 1.0) * spec
               + vec3(0.3, 0.35, 0.5) * rim;
    return color;
  }
}

// ------------------------------------------------------------
// Main — camera ray setup + sphere-tracing
// ------------------------------------------------------------
void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution.xy) * 2.0 - 1.0;
  uv.x *= uResolution.x / uResolution.y; // correct aspect

  // Camera: orbit around Y axis at fit distance; target is plant centroid
  vec3 camPos  = uCamPos;
  vec3 target  = uTarget;
  vec3 forward = normalize(target - camPos);
  vec3 right   = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  vec3 up      = cross(right, forward);

  // Build ray
  float fov = 1.1; // ~63 degrees half-angle tangent
  vec3 rayDir = normalize(forward * fov + right * uv.x + up * uv.y);

  // Background: deep space with faint nebula gradient
  float bgY    = uv.y * 0.5 + 0.5;
  vec3 bgColor = mix(vec3(0.01, 0.01, 0.025), vec3(0.04, 0.02, 0.06), bgY);
  // Add a faint star-field flicker based on uv hash
  float star = fract(sin(dot(gl_FragCoord.xy, vec2(127.1, 311.7))) * 43758.5453);
  if (star > 0.997) bgColor += vec3(0.6, 0.7, 0.9) * (star - 0.997) * 333.0;

  // Sphere-trace
  const int MAX_STEPS = 96;
  const float MAX_DIST = 20.0;
  const float SURF_DIST = 0.001;

  float t = 0.0;
  bool hit = false;
  vec3 hitPos = vec3(0.0);

  for (int step = 0; step < MAX_STEPS; step++) {
    vec3 p = camPos + rayDir * t;
    float d = sceneSDF(p);
    if (d < SURF_DIST) {
      hit = true;
      hitPos = p;
      break;
    }
    t += d;
    if (t > MAX_DIST) break;
  }

  vec3 color;
  if (hit) {
    vec3 normal = calcNormal(hitPos);
    color = getMaterial(hitPos, normal, rayDir, uMaterialMode);
    float fog = exp(-t * 0.08);
    color = mix(bgColor, color, fog);

    // Write depth matching the PerspectiveCamera projection so the
    // instanced leaf mesh can occlude / be-occluded by the SDF body.
    // See PINHOLE CONTRACT comment above for the required camera setup.
    vec4 clip = uProjMatrix * uViewMatrix * vec4(hitPos, 1.0);
    gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  } else {
    color = bgColor;
    // Miss: write far depth so leaf mesh fragments over background still draw.
    gl_FragDepth = 1.0;
  }

  // Subtle vignette
  float vig = 1.0 - dot(uv * 0.38, uv * 0.38);
  color *= vig;

  // Card mode (uCardMode=1): ray miss → transparent; ray hit → opaque plant.
  // Normal mode (uCardMode=0): byte-identical to original — background +
  // vignette written with a=1.0 exactly as before.
  if (uCardMode > 0.5) {
    if (!hit) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
      return;
    }
    gl_FragColor = vec4(color, 1.0);
  } else {
    gl_FragColor = vec4(color, 1.0);
  }
}
