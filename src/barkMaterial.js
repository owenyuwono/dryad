// =============================================================================
// barkMaterial.js — procedural bark MeshStandardMaterial for branch-tube mesh
//
// Wraps THREE.MeshStandardMaterial and injects all bark GLSL helpers via
// onBeforeCompile so the material participates in full PBR lighting, IBL
// (scene.environment), and shadow casting/receiving for free.
//
// The bark math is IDENTICAL to the original ShaderMaterial — same constants,
// same function bodies, same coordinate conventions.  Only the lighting model
// is removed (three.js handles that) and the outputs are wired into the PBR
// pipeline via shader chunk replacement.
//
// Coordinate source:
//   vObjPos  — object-space vertex position, set from `position` in the vertex
//               hook.  Used for all bark helper math exactly as the SDF shader
//               used its hit point `p`.
//
// Genome uniforms:
//   uWoodiness  float  1=woody bark (identity), 0=soft green herbaceous stem.
//                      Blends albedo, roughness, and bump toward a green stem.
//   uPigment    float  per-species hue gene 0–1 (reserved / future use)
//
// AO attribute:
//   Geometry must supply a per-vertex `ao` float attribute [0,1].
//   It is passed as vAo to the fragment shader and blended into the indirect
//   diffuse term (same role as before, now targeting PBR ambient path).
//
// Usage:
//   import { createBarkMaterial } from './barkMaterial.js';
//   const bark = createBarkMaterial();
//   branchMesh.material = bark.material;
//   bark.setGenome({ woodiness: 1.0, pigment: 0.45 });
//   // later:
//   bark.dispose();
// =============================================================================

import * as THREE from 'three';
import {
    WIND_BONE_UNIFORM_DECLS,
    WIND_BONE_FETCH_GLSL,
    WIND_SKIN_VERTEX_GLSL,
    WIND_BONE_UNIFORM_DEFAULTS,
} from './windSkinGlsl.js';

// ---------------------------------------------------------------------------
// GLSL — bark helper functions (ported verbatim from the original file)
//
// These are injected into the fragment shader preamble via onBeforeCompile.
// barkAO is intentionally omitted — AO comes from the baked vertex attribute.
// ---------------------------------------------------------------------------

const BARK_GLSL_HELPERS = /* glsl */`
// ============================================================
// BARK TUNING CONSTANTS (verbatim from creature.frag.glsl:309–341)
// ============================================================

const float BARK_RIDGE_FREQ_SCALE   = 0.4;   // lowered 0.5→0.4 → bolder, larger furrows
const float BARK_FISSURE_FREQ_SCALE = 0.42;
const float BARK_FISSURE_WEIGHT     = 0.68;  // raised 0.55→0.68 → coarse furrows dominate the fine grain
const float BARK_BUMP_MIN           = 0.18;
const float BARK_BUMP_MAX           = 0.62;  // deeper relief than 0.55 (AO keeps furrows dark, no bright walls)
                                             // into the sun (bright-network look); AO now carries the dark.
// PLATE (voronoi cell) size — higher = SMALLER plates (more cells), so the trunk reads as
// many fine bark scales rather than a few big obvious voronoi cells. Raised 1.4→2.6 (~2×
// smaller plates). Note: shrinking plates also thins the fissures proportionally, so
// BARK_CRACK_WIDTH below is lowered by the same factor to keep the fissure size constant.
// (uBarkScale also scales this — gene-driven — but it scales the FBM grain too.)
const float BARK_PLATE_FREQ         = 2.6;
// Crack THINNESS: the border groove occupies edge-distance up to 1/BARK_CRACK_WIDTH, so a
// LARGER value = THINNER cracks. Lowered 40→21 in step with the BARK_PLATE_FREQ increase so
// the absolute fissure width stays the same while the plates shrink. NOTE the normal-sampling
// eps (barkPerturbNormal) is the real floor — a crack thinner than eps won't resolve.
const float BARK_CRACK_WIDTH        = 21.0;
// Ridged-FBM octave count. Raised from 5 → 8 so fine bark grain survives a close-up
// zoom (5 octaves anchored to a fixed object-space frequency ran out of detail when
// magnified → soft/blurry up close). The per-octave AA fade in ridgedFBM still drops
// sub-pixel octaves when far, so the extra octaves add NO shimmer at distance — they
// only switch on as the camera nears. Cost ~+60% noise; lower this if a big forest
// stand drops frames (it is the single perf knob for this).
const int   BARK_FBM_OCTAVES        = 8;
// Damp the vertical part of the domain warp so furrows wander side-to-side (organic)
// but are NOT chopped into vertical segments. 1.0 = old isotropic warp; 0 = dead-straight.
const float BARK_WARP_Y_DAMP        = 0.30;

// ---- OAK/ASH BARK MODEL (matches the reference photo) -------------------------------
// The CRACKS are the voronoi cell BORDERS — the thin lines between cells, recessed into
// grooves. The voronoi CELLS are the bark scales/plates. Cells are vertically elongated
// (BARK_PLATE_ASPECT < 1 → cells taller than wide), so the borders run mostly VERTICALLY
// as the long root→branch fissures, with the shorter horizontal borders breaking the
// ridges into stacked scales — both fall out of one cellular field. The network is broken
// into ragged fragments (gate noise) so it never reads as clean closed cells, and the
// borders are cut deep (× BARK_FISSURE_DEPTH) so the cracks read strongly in the normal map.
const float BARK_PLATE_ASPECT       = 0.45;  // cell height/width = 1/ASPECT ≈ 2.2× → vertical scales
const float BARK_VORONOI_BREAK_FREQ = 2.3;   // freq (in cell units) of the noise that fragments the borders
const float BARK_FISSURE_GATE_LO    = 0.34;  // border-gate lo/hi: raise LO for more gaps (more broken)
const float BARK_FISSURE_GATE_HI    = 0.72;
const float BARK_FISSURE_DEPTH      = 0.6;   // crack groove depth (× uBarkPlates). Kept MODERATE — deep
                                             // steep cracks catch the sun on their walls (the bright-network
                                             // inversion); the dark fissures now come from BARK_CRACK_AO +
                                             // the crack albedo, not from extreme geometric depth.
// BLOCK MODEL relief: the voronoi CELLS are raised plateaus (the bark scales), the crack
// network is recessed, and the FBM rides on top as fine grain ON the block faces — so the
// blocky scale structure is the DOMINANT relief (matching the reference) rather than broad
// FBM furrows. The albedo darkens the SAME crack mask, so dark fissures align with grooves.
const float BARK_Y_STRETCH          = 3.0;   // must match the Y-stretch applied in barkPGrain
const float BARK_BLOCK_HEIGHT       = 0.38;  // raised height of the block plateaus (the bark scales)
const float BARK_GRAIN_AMT          = 0.40;  // amplitude of the FBM fine grain on the block faces
const float BARK_CRACK_DARKEN       = 0.85;  // how dark the crack colour goes in the albedo (0..1)
const float BARK_CRACK_AO           = 0.80;  // ambient-occlusion darkening in the FURROWS (0..1) — keeps
                                             // them dark instead of catching light
// RIDGED-FBM bark model (deep-research verdict — replaces voronoi). The ridged multifractal
// in barkHeightField IS the bark: crests = ridges/plates, valleys = furrows. Anisotropy makes
// the furrows run vertically; a horizontal break band chops ridges into stacked scales.
const float BARK_VERT_STRETCH       = 3.5;   // along-axis stretch: >1 → vertical furrows (around freq > along)
const float BARK_SCALE_FREQ         = 0.6;   // plate-break freq as a FRACTION of the furrow base freq (sparse —
                                             // a few breaks per furrow run; was 3.3 × 1/featureScale = hatching)
const float BARK_SCALE_AROUND       = 0.30;  // around-trunk freq of the breaks (<1 → breaks run around, irregular)
const float BARK_SCALE_DEPTH        = 0.40;  // how deep the plate breaks cut the ridges
// FLOW-LINE FURROWS — the explicit "trace a line down the branch" model. Furrows are lines of
// ~constant angle running ALONG the branch, meandering as they climb. This field now DRIVES the
// bark: relief height, normal, colour and AO all derive from it (see barkFurrowHeight).
// Density is the uBarkScale gene → integer count in [MIN,MAX] (rounded → seamless wrap).
const float BARK_FURROW_MIN         = 8.0;   // furrow count at density 0
const float BARK_FURROW_MAX         = 30.0;  // furrow count at density 1
const float BARK_FURROW_MEANDER_FREQ = 0.9;  // meander freq along the branch (low → furrows stay vertical)
const float BARK_FURROW_WANDER      = 0.22;  // side-to-side meander amplitude (furrow-band units)
const float BARK_FURROW_SHARP       = 3.0;   // furrow wall sharpness (higher = deeper, sharper V-groove)
const float BARK_FURROW_ALONG_FREQ  = 2.0;   // FBM vertical-detail freq in furrow-flow space — enough
                                             // along-variation that the furrows break/vary organically
                                             // (too low → degenerate 1-D stripes = "just furrow")
const float BARK_FURROW_WARP        = 0.8;   // domain-warp amplitude → furrows wander/merge organically
                                             // instead of regular stripes. The FBM IS the texture; the
                                             // furrow coordinate (count + meander) only GUIDES its flow.
const float BARK_FURROW_DEPTH       = 0.06;  // furrow relief depth = normal-tilt strength (deep)
// HORIZONTAL CROSS-FRACTURES (S1) — the "palm fiber → oak" structure. Thin recessed cracks that
// chop the vertical furrow RIDGES into stacked oak scales. Sampled on the SAME seamless cylinder
// embedding as the furrows (cos/sin of the furrow angle → no wrap seam) and keyed to alongArc so
// they align with the furrow grain. Because the cracks come from the 3-D noise field they vary
// AROUND the trunk → ragged, staggered breaks (never clean horizontal rings). Driven by the
// (previously inert) uBarkPlates gene × uBarkRelief, so 0 = continuous ridges (strict no-op,
// byte-identical) and the 0.45 default = a moderate scaling. Smooth-bark presets (low barkRelief,
// e.g. birch) stay smooth via the uBarkRelief gate.
const float BARK_XCRACK_AROUND      = 0.9;   // around-axis cylinder radius: small → cracks run mostly
                                             // horizontal but ragged/broken (raise → blockier scales)
const float BARK_XCRACK_FREQ        = 1.8;   // vertical (along-arc) stacking freq → a few cracks per
                                             // furrow run (raise → shorter, more-stacked scales)
const float BARK_XCRACK_DEPTH       = 0.6;   // how deep the cracks cut ridge crests (× uBarkRelief × uBarkPlates)
// BARK_CRACK_DEPTH (0.45) was the fixed voronoi crack depth; it is now the uBarkPlates
// gene (ridges↔plates morphology), whose 0.45 identity default reproduces this value.
// BARK_CRACK_DEPTH (0.45) was the fixed voronoi crack depth; it is now the uBarkPlates
// gene (ridges↔plates morphology), whose 0.45 identity default reproduces this value.

// Bark color is generated PROCEDURALLY from two orthogonal uniforms — uBarkHue
// (grey→warm brown/red) and uBarkLightness (dark→pale/birch) — via HSL, instead of
// lerping two authored palettes (the old birch↔brown crossfade that welded "white"
// and "lenticels" to one end). hsl2rgb: compact branchless HSL→RGB.
vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}

// ============================================================
// BARK HELPERS (verbatim from creature.frag.glsl:343–537)
// barkAO is intentionally omitted — replaced by baked vAo attribute.
// ============================================================

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
// 5 octaves.  Returns h in [0, 1] where 1 = ridge top, 0 = groove bottom.
// The power(h, 0.7) sharpens the transition, making furrows crisper.
//
// fw: pixel-footprint scale of the base sampling position (precomputed by caller
//     as max(fwidth(pw.x), fwidth(pw.y), fwidth(pw.z))).  Each octave fades out
//     smoothly via smoothstep when its detail would be sub-pixel, preventing
//     high-frequency aliasing from octaves the screen can't resolve.
float ridgedFBM(vec3 pw, float freq, float fw) {
    float amp   = 1.0;
    float total = 0.0;
    float norm  = 0.0;
    for (int oct = 0; oct < BARK_FBM_OCTAVES; oct++) {
        // Band-limit: fade out this octave when its pixel footprint >= ~1 px.
        // Wider fade band (0.35→1.3) preserves fine grain a little longer on zoom-in
        // before band-limiting, without re-introducing shimmer at distance.
        float octFw   = fw * freq;
        float aaFade  = 1.0 - smoothstep(0.35, 1.3, octFw);
        total += ridgeOctave(pw * freq) * amp * aaFade;
        norm  += amp;
        freq  *= 2.13;   // slightly irrational lacunarity -> no aliasing
        amp   *= 0.52;   // gain < 0.5 keeps ridges dominant
    }
    float h = clamp(total / norm, 0.0, 1.0);
    // Sharpening: push ridge peaks up and furrow bottoms down for crisper look.
    return pow(h, 0.5);
}

// ============================================================
// ANISOTROPIC ORIENTATION (barkOrient) — the unifier that reorients the entire
// relief field between horizontal rings (orient→0), an isotropic reticulate net
// (mid), and vertical furrows / longitudinal fiber (orient→1). It absorbed the old
// barkGrain (vertical-fiber corner) and trunkRings (horizontal-ring pole): both are
// now just points along this one axis, with REAL normal relief (not an albedo decal).
// ============================================================
const float BARK_ORIENT_DEFAULT = 0.70;   // gain == 1 here → byte-identical legacy coord
const float BARK_ANISO_SPREAD   = 1.20;   // exp2(±SPREAD) → ~2.3x anisotropy tilt at the rails

// Orientation gain: 1.0 at the identity default; >1 deepens the vertical bias,
// <1 tilts toward horizontal banding. Asymmetric span because the identity (0.70)
// is NOT the geometric centre — the legacy bark is already vertically biased (Y×3).
float barkAnisoGain(float orient) {
    float span = (orient >= BARK_ORIENT_DEFAULT) ? (1.0 - BARK_ORIENT_DEFAULT) : BARK_ORIENT_DEFAULT;
    float u    = (orient - BARK_ORIENT_DEFAULT) / max(span, 1e-3);   // [-1, +1], 0 at default
    return exp2(u * BARK_ANISO_SPREAD);
}

// Tilt a legacy-stretched coordinate by the orientation gain. XZ shrink as Y grows
// (and vice-versa), so feature SCALE stays owned by barkScale — only the RATIO
// (orientation) changes. gain == 1 returns the input unchanged (byte-identical).
vec3 barkAnisoCoord(vec3 pStretched, float gain) {
    return vec3(pStretched.x / gain, pStretched.y * gain, pStretched.z / gain);
}

// ============================================================
// EXFOLIATION (barkShed) — coarse organic patches that shed/peel to reveal under-bark.
// Opens the whole peeling/mottled/camouflage half of barkspace (plane/sycamore,
// eucalyptus, birch curls, redwood strands). Fed the ANISOTROPIC coord, so at high
// barkOrient the patches stretch into vertical strips → fibrous strand-peel for free.
// Returns shed amount in [0,1] (0 = intact bark, 1 = fully exposed under-bark).
// STRICT NO-OP when uBarkShed == 0 → bark byte-identical to pre-gene output.
// ============================================================
const float BARK_SHED_FREQ = 0.6;    // low frequency → big organic patches
const float BARK_SHED_LIFT = 0.35;   // relief lift at patch edges (curling-flake lip)
float barkShedField(vec3 p) {
    if (uBarkShed < 0.001) return 0.0;
    // Coarse organic patch value in [0,1]; a low-freq blotch, not salt-and-pepper.
    // NOTE: 'patch' is a RESERVED keyword in GLSL ES 3.00 (WebGL2) — do NOT use it as an
    // identifier or the shader fails to compile in-browser (silent vanished mesh).
    float patchVal = barkNoise(p * BARK_SHED_FREQ + vec3(13.7, 4.2, 8.1)) * 0.5 + 0.5;
    // As shed rises the threshold drops, so more (larger) patches exceed it and peel.
    // The smoothstep band gives soft patch edges (a feathered peel boundary).
    float shedT = mix(1.05, 0.02, uBarkShed);
    return smoothstep(shedT, shedT + 0.20, patchVal);
}

// Combined height field: coarse fissure layer + fine grain layer.
// The coarse layer provides big trunk furrows; the fine layer adds grain texture.
// BARK_FISSURE_WEIGHT blends them: higher weight = more-dominant coarse furrows.
// Returns h in [0, 1] where 1 = ridge top, 0 = deep furrow.
//
// fw: pixel-footprint scale passed through to ridgedFBM for analytic AA.
//     Caller computes: max(fwidth(p_grain.x), fwidth(p_grain.y), fwidth(p_grain.z)).
float barkHeightField(vec3 p_grain, float featureScale, float fw) {
    // Domain warp: nudge the ridge coordinates with a low-freq FBM so
    // ridges meander organically rather than running perfectly straight.
    vec3 warpOfs = barkWarpFBM(p_grain * 0.45) * 0.55;
    // Damp the vertical wander so ridges/furrows stay continuous up the trunk (they
    // still meander side-to-side via the full x/z warp) — keeps the long root→branch lines.
    warpOfs.y *= BARK_WARP_Y_DAMP;
    vec3 pw = p_grain + warpOfs;

    // uBarkScale: 0 = coarse plates, 1 = fine plates (modulates ridge frequency).
    float baseFreq = (BARK_RIDGE_FREQ_SCALE * mix(0.6, 1.8, uBarkScale)) / max(featureScale, 0.01);

    // Coarse fissure layer (big trunk cracks, lower frequency).
    float coarseH = ridgedFBM(pw, baseFreq * BARK_FISSURE_FREQ_SCALE, fw);

    // Fine grain layer (original-style grain on top of the coarse structure).
    float fineH   = ridgedFBM(pw, baseFreq, fw);

    // Combine: coarse sets the macro furrow, fine adds surface grain.
    // Where coarse is low (deep furrow), fine is suppressed too -- keeps the
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

    // 3x3 lattice search -- constant loop bounds, GLSL ES 3.0 safe.
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
    // Edge distance: F2 - F1 (approximately 0 at boundaries, > 0 inside plates).
    // sqrt to get linear distance; ramp gives the crack groove a FIXED OBJECT-SPACE width
    // (half-width 1/BARK_CRACK_WIDTH in edge units). This drives the RELIEF/normal, so an
    // object-space width is what we want: the finite-difference normal then resolves the
    // crack wall consistently at any zoom (a screen-relative width would make the groove
    // depth swim with the camera). Returns 0 ON the border (crack), 1 in the plate interior.
    float edge = sqrt(minDist2) - sqrt(minDist1);
    return clamp(edge * BARK_CRACK_WIDTH, 0.0, 1.0);
}

// Shared CRACK MASK — the disconnected voronoi-border network in [0,1] (1 = inside a crack,
// 0 = on a block face). Used by BOTH the relief (barkReliefHeight) and the albedo
// (barkAlbedo) so the dark crack COLOUR lines up exactly with the recessed grooves. The
// voronoi CELLS are the bark scales; tall cells (BARK_PLATE_ASPECT < 1) make the borders run
// mostly VERTICALLY (long fissures) with shorter horizontal borders breaking them into
// stacked scales. A noise gate fragments the network so it never reads as clean closed cells.
float barkCrackMask(vec3 p_grain, float featureScale) {
    float plateFreq = (BARK_PLATE_FREQ * mix(0.6, 1.8, uBarkScale)) / max(featureScale, 0.04);
    vec2  plateUV   = vec2(p_grain.x, (p_grain.y / BARK_Y_STRETCH) * BARK_PLATE_ASPECT) * plateFreq;
    float crack     = 1.0 - barkVoronoiEdge(plateUV);   // 1 on a border (crack), 0 in a cell
    float gate = barkNoise(vec3(plateUV * BARK_VORONOI_BREAK_FREQ, p_grain.y * 0.3)
                           + vec3(21.3, 7.1, 4.9)) * 0.5 + 0.5;
    crack *= smoothstep(BARK_FISSURE_GATE_LO, BARK_FISSURE_GATE_HI, gate);
    return clamp(crack, 0.0, 1.0);
}

// Horizontal lenticel marks for birch-like bark.
// Returns [0,1] where 1 = inside a dark lenticel dash.
// lenticels are horizontal short dashes, keyed by integer height-band × angle.
// prominence: strength of the effect, driven by the independent uBarkLenticels axis.
float barkLenticel(vec3 p_grain, float prominence) {
    if (prominence < 0.001) return 0.0;

    // Height-band index: lenticels appear at regular vertical intervals.
    // Y is stretched 3x in p_grain, so divide back to get world-scale bands.
    float bandY     = p_grain.y / 3.0;           // undo y-stretch for band spacing
    float bandIndex = floor(bandY * 5.0);         // ~5 bands per unit height
    float bandFrac  = fract(bandY * 5.0);         // 0..1 within the band

    // Horizontal angle from object-space xz (assumes cylinder-ish trunk).
    float angle = atan(p_grain.z, p_grain.x);    // -PI..PI

    // Per-band pseudo-random offset of dash start (varies each band).
    float bandHash = fract(sin(bandIndex * 127.1 + 311.7) * 43758.5);
    // Multiple dashes per ring: divide angle into sectors (e.g. 4-6 per ring).
    float sectors    = 5.0;
    float sectorAngle = 6.28318 / sectors;
    float sectorFrac  = fract((angle / sectorAngle) + bandHash);

    // Dash shape: elongated horizontally (short in the sectorFrac direction,
    // narrow in the vertical bandFrac direction).
    // centerSector: 1 at the center of a dash, 0 at edges.
    float dashWidth  = 0.35;  // fraction of sector width occupied by the dash
    float dashHeight = 0.18;  // fraction of band height
    float dashCenterH = smoothstep(0.5 - dashWidth,  0.5 - dashWidth  * 0.3, sectorFrac)
                      * (1.0 - smoothstep(0.5 + dashWidth  * 0.3, 0.5 + dashWidth,  sectorFrac));
    float dashCenterV = smoothstep(0.5 - dashHeight, 0.5 - dashHeight * 0.3, bandFrac)
                      * (1.0 - smoothstep(0.5 + dashHeight * 0.3, 0.5 + dashHeight, bandFrac));
    float dashMask = dashCenterH * dashCenterV;

    // Vary dash presence per band (not every band/sector has a lenticel).
    float presenceHash = fract(sin(bandIndex * 73.13 + floor(sectorFrac * sectors + bandHash) * 57.3) * 91027.3);
    float present = step(0.45, presenceHash);  // ~55% of positions have a lenticel

    return dashMask * present * prominence;
}

// Bark albedo — FLAT base colour + colour-only features (lenticels, mottle, lichen, shed).
// The fracture PATTERN (furrows / ridges / plate cracks) is NOT painted into albedo — it
// lives entirely in the normal map + lighting (avoids the "albedo contains lighting" look).
// Colour from orthogonal uBarkHue (grey→warm) + uBarkLightness (dark→pale); dashes from
// uBarkLenticels — all independent. h is used only to pool lichen into crevices (a colour
// feature, not the furrow line); worldY biases lichen toward the base.
vec3 barkAlbedo(vec3 p_grain, float h, float worldY, float featureScale) {
    // ---- Procedural palette from orthogonal uBarkHue + uBarkLightness ----
    // bL = base lightness (dark↔pale); bS/bH = saturation+hue (grey↔warm brown→red).
    float bL = mix(0.24, 0.92, uBarkLightness);  // raised floor (0.10→0.24) so dark genes aren't near-black
    float bS = uBarkHue * 0.55;
    float bH = mix(0.095, 0.035, uBarkHue); // tan/yellow-brown → warm brown (floor lifted off pure red)
    // paletteRidge/paletteFurrow are kept ONLY as the source tones for the lenticel dashes
    // (a colour feature). The furrow/ridge/crack RELIEF is rendered by the normal map now,
    // so it is no longer mixed into baseCol.
    vec3 paletteRidge      = hsl2rgb(bH, bS,                      clamp(bL + 0.07, 0.0, 1.0));
    vec3 paletteFurrow     = hsl2rgb(bH, bS * 1.15,               clamp(bL - 0.20, 0.0, 1.0));
    vec3 paletteLichen     = hsl2rgb(0.26, 0.28,                  clamp(0.32 + bL * 0.18, 0.0, 1.0));
    vec3 paletteBlotchWarm = hsl2rgb(clamp(bH - 0.015, 0.0, 1.0), bS,        clamp(bL - 0.05, 0.0, 1.0));
    vec3 paletteBlotchCool = hsl2rgb(clamp(bH + 0.05, 0.0, 1.0),  bS * 0.7,  clamp(bL - 0.07, 0.0, 1.0));

    // ---- FLAT base tone — single colour, no height/crack dependence ----
    // The bark "lines" (furrows, ridges, plate cracks) are NOT painted here; they are carried
    // by the normal-map relief + lighting. Only the genuine colour features below tint this.
    // DESATURATED + nudged off the red end: at full bS/bH the flat base reads as saturated
    // salmon/pink (the old painted look only read brown because dark furrows pulled it down).
    float baseSat = bS * 0.52;                 // warm tan/ochre (ref base), a touch less saturated
    float baseHue = mix(bH, 0.08, 0.5);        // pull firmly toward tan, away from red/maroon
    vec3 baseCol = hsl2rgb(baseHue, baseSat, bL);

    // ---- Crack-aligned tone: dark recessed fissures vs lighter block faces ----
    // Use the SAME crack mask the relief uses, so the dark colour lands exactly in the
    // grooves (the reference's defining contrast) instead of following broad FBM furrows.
    // Furrow darkening: the ridged-FBM VALLEYS (low h) are the recessed furrows → darker, warm;
    // ridge crests (high h) stay pale. Aligned with the relief because both read the SAME
    // ridged FBM (h here is barkH), so the dark colour lands exactly in the lit furrows.
    float furrowT   = clamp((0.5 - h) * 2.2, 0.0, 1.0);   // 1 deep in a furrow, 0 on a ridge crest
    vec3  furrowCol = hsl2rgb(clamp(bH - 0.005, 0.0, 1.0), clamp(bS * 1.1, 0.0, 1.0), clamp(bL - 0.34, 0.0, 1.0));
    baseCol = mix(baseCol, furrowCol, furrowT * BARK_CRACK_DARKEN);

    // Pale weathered ridge CRESTS (high h) — the other half of the reference's light/dark
    // split. Lifts and de-saturates the ridge tops so they read as worn grey-tan against the
    // dark furrows, instead of the whole trunk reading uniformly dark.
    float ridgeT   = smoothstep(0.6, 0.92, h);
    vec3  ridgeCol = hsl2rgb(baseHue, baseSat * 0.6, clamp(bL + 0.26, 0.0, 1.0));
    baseCol = mix(baseCol, ridgeCol, ridgeT * 0.6);

    // ---- Lichen: in deep crevices AND biased toward base (lower worldY) ----
    // lichenCrevice: low h = deep furrow = likely crevice.
    // lichenBase: fades out above Y=1.5 so lichen pools near ground.
    float lichenCrevice = clamp((0.22 - h) * 6.0, 0.0, 1.0);
    float lichenBase    = clamp(1.0 - worldY * 0.55, 0.0, 1.0);
    float lichenSpatter = clamp(barkNoise(p_grain * 3.7 + vec3(7.3, 2.9, 5.1)) * 0.5 + 0.5, 0.0, 1.0);
    float lichenMask = lichenCrevice * lichenBase * lichenSpatter;
    baseCol = mix(baseCol, paletteLichen, lichenMask * 0.70);

    // ---- Large-scale color blotch (low-freq noise) ----
    // Prevents uniform color -- drifts between warm and cool regions.
    float blotch = barkNoise(p_grain * 0.18 + vec3(5.5, 1.3, 3.7)) * 0.5 + 0.5;
    vec3 blotchCol = mix(paletteBlotchCool, paletteBlotchWarm, blotch);
    baseCol = mix(baseCol, blotchCol, 0.22);

    // ---- Oxidation / rust patches: scattered warm, saturated weathering zones ----
    // Low-freq noise selects ~organic patches that shift toward a rust-orange; modest blend
    // so they enrich variation without reading as painted stains (the reference's warm zones).
    float oxide = barkNoise(p_grain * 0.22 + vec3(9.2, 0.8, 6.4)) * 0.5 + 0.5;
    oxide = smoothstep(0.40, 0.78, oxide);
    vec3 oxideCol = hsl2rgb(clamp(bH - 0.01, 0.0, 1.0), clamp(bS * 1.4, 0.0, 1.0), clamp(bL - 0.05, 0.0, 1.0));
    baseCol = mix(baseCol, oxideCol, oxide * 0.40);

    // ---- Lenticel marks: now an INDEPENDENT axis (uBarkLenticels), decoupled from
    // furrow/color — so brown bark can have lenticels (cherry) or pale bark none. ----
    float lenticelProminence = clamp(uBarkLenticels * 1.2, 0.0, 1.0);
    float lenticelMask = barkLenticel(p_grain, lenticelProminence);
    // Lenticel color: dark grey-brown dash on the pale birch base.
    vec3 lenticelCol = mix(paletteRidge, paletteFurrow * 0.55, 0.75);
    baseCol = mix(baseCol, lenticelCol, lenticelMask);

    // ---- Cavity darkening: a gentle extra shade in the FBM-grain lows on the block faces.
    // Milder now (0.82) since the crack-aligned darkening above carries the strong fissure
    // colour; this just keeps the block faces from reading flat.
    float cavity = mix(0.82, 1.0, clamp(h * 1.7, 0.0, 1.0));
    baseCol *= cavity;

    // ---- Micro-variation: +-0.06 from high-freq noise (visible weathered speckle close up) ----
    float micro = barkNoise(p_grain * 8.3 + vec3(1.1, 4.4, 2.2)) * 0.06;
    baseCol = clamp(baseCol + micro, 0.0, 1.0);

    return baseCol;
}

// Bark normal perturbation via gradient of the height field.
// Uses finite differences on barkHeightField; eps scaled to featureScale
// so thin twigs get tighter bumps and thick trunks get broader bumps.
// Returns a perturbed normal in world space.
//
// fw: pixel-footprint scale (same as passed to barkHeightField).
//     Used to attenuate bump strength toward 0 when the sampled noise is
//     sub-pixel — preventing random per-pixel specular glints at distance.
// (BARK_Y_STRETCH is defined in the top constants block.)

// Furrow density (integer count) from the uBarkScale gene → the "Furrow density" slider.
// Rounded to an integer so the wrap stays seamless.
float barkFurrowCount() {
    return floor(mix(BARK_FURROW_MIN, BARK_FURROW_MAX, uBarkScale) + 0.5);
}

// FLOW-LINE FURROW HEIGHT — THE bark relief. Furrows are lines of ~constant angle running ALONG
// the branch, meandering as they climb; this returns the surface HEIGHT in [0,1] (1 = ridge
// crest, 0 = furrow floor). Everything (relief, normal, colour, AO) reads this so the whole
// texture FOLLOWS the furrows. Inputs:
//   around      — SEAMLESS angle around the branch [0,1) (radial normal · branch frame), NOT uv.x
//                 (uv.x had a wrap-seam quad). atan2 ±π jump is seamless: integer count +
//                 periodic meander. Carried frame keeps it aligned across forks.
//   alongArc    — arc length up the branch (uv.y) — world-consistent, drives the grain.
//   alongGlobal — object height — drives the meander (global → no fork seam in the wobble).
float barkFurrowHeight(float around, float alongArc, float alongGlobal) {
    float count   = barkFurrowCount();
    float ang0    = around * 6.2831853;            // angle around the trunk (cos/sin → SEAMLESS wrap)
    float meander = sin(alongGlobal * BARK_FURROW_MEANDER_FREQ + ang0) * BARK_FURROW_WANDER;
    float ang     = ang0 + meander * (6.2831853 / count);   // wander by up to WANDER furrow-widths
    float Rn      = count / 6.2831853;             // circle radius → circumference = count furrows
    // CYLINDER embedding: sample the FBM on a CLOSED circle around the trunk → inherently
    // seamless wrap (no back seam — noise(a) was not periodic, which caused the seam). x/z trace
    // the circle (count furrows), y = up the branch. Domain warp (a function of the seamless
    // point) keeps furrows organic without breaking the wrap. The furrow coordinate GUIDES it.
    vec3 fp = vec3(cos(ang) * Rn, alongArc * BARK_FURROW_ALONG_FREQ, sin(ang) * Rn);
    fp += vec3(barkNoise(fp * 0.5 + vec3(1.7)),
               barkNoise(fp * 0.5 + vec3(8.3)),
               barkNoise(fp * 0.5 + vec3(4.2))) * BARK_FURROW_WARP;
    float h = ridgedFBM(fp, 1.0, 0.0);             // [0,1] organic ridged-FBM bark, seamless

    // S1 — horizontal cross-fractures: chop the vertical ridges into stacked oak scales. Sampled on
    // the SAME seamless cylinder (cos/sin of the furrow angle → no wrap seam); the 3-D noise varies
    // around the trunk so the cracks stagger (ragged, never clean rings). Cuts only ridge CRESTS
    // (smoothstep gate) so existing furrows stay deep. uBarkPlates × uBarkRelief drives it: 0 = strict
    // no-op (continuous ridges, byte-identical), ~0.45 default = moderate scaling, 1 = strongly plated.
    vec3  xc    = vec3(cos(ang) * BARK_XCRACK_AROUND, alongArc * BARK_XCRACK_FREQ, sin(ang) * BARK_XCRACK_AROUND);
    float crack = 1.0 - abs(barkNoise(xc + vec3(7.0)));
    crack = crack * crack * crack;                 // thin recessed crack line
    h -= uBarkRelief * uBarkPlates * BARK_XCRACK_DEPTH * crack * smoothstep(0.45, 0.78, h);

    return clamp(h, 0.0, 1.0);
}

// Combined bark RELIEF height — the height field the NORMAL follows: the FBM ridge field
// MINUS the voronoi-border CRACKS, so the normal map carries the full oak/ash pattern
// (scale plates separated by recessed fissures), not just the coarse FBM ridges.
float barkReliefHeight(vec3 pLocal, float featureScale, float fw) {
    // RIDGED-FBM relief (research verdict — NOT voronoi). barkHeightField is the domain-warped
    // ridged multifractal: its crests are the ridges/scale plates, its valleys the connected
    // furrows. Build the vertically-anisotropic coord here (around freq > along) so the
    // ridges/furrows run up the branch.
    float vstretch = BARK_VERT_STRETCH * barkAnisoGain(uBarkOrient);
    vec3  pv = vec3(pLocal.x, pLocal.y / vstretch, pLocal.z);
    float h  = barkHeightField(pv, featureScale, fw);   // ridged FBM: 1 = ridge crest, 0 = furrow
    // Horizontal PLATE BREAKS — SPARSE thin horizontal cracks that chop the vertical ridges
    // into stacked plates. Frequency is a small FRACTION of the furrow base frequency (a few
    // breaks per furrow run) — NOT the dense hatching the old × 1/featureScale produced. The
    // crack is a thin recessed LINE (^3 sharpen, NOT the broad area). Amount driven by
    // uBarkPlates so the gene works again: 0 = continuous ridges (oak), 1 = strongly plated.
    float baseFreqB = (BARK_RIDGE_FREQ_SCALE * mix(0.6, 1.8, uBarkScale)) / max(featureScale, 0.04);
    vec3  ph = vec3(pLocal.x * baseFreqB * BARK_SCALE_AROUND,
                    pLocal.y * baseFreqB * BARK_SCALE_FREQ,
                    pLocal.z * baseFreqB * BARK_SCALE_AROUND);
    float crack = 1.0 - abs(barkNoise(ph));
    crack = crack * crack * crack;                       // thin recessed crack line
    float plateAmt = clamp(uBarkPlates * 2.0, 0.0, 2.0); // gene: 0 = continuous ridges, ~0.9 at default 0.45
    h -= uBarkRelief * BARK_SCALE_DEPTH * plateAmt * crack * smoothstep(0.45, 0.78, h);
    // Exfoliation lift (peel boundary catches raking light). No-op at uBarkShed=0.
    float shed     = barkShedField(pv);
    float shedEdge = shed * (1.0 - shed) * 4.0;
    h += uBarkRelief * BARK_SHED_LIFT * shedEdge;
    return h;
}

vec3 barkPerturbNormal(vec3 p_grain, vec3 worldNormal, float featureScale, float fw,
                       vec3 frameU, vec3 frameT, vec3 frameW) {
    // Bump epsilon proportional to feature size. This is the FLOOR on crack thinness — a
    // crack narrower than eps won't resolve in the finite difference — so it's tightened
    // (0.04→0.012) to match the thin voronoi-border cracks (BARK_CRACK_WIDTH) and keep the
    // walls sharp. High FBM octaves have negligible amplitude, so the small step is safe.
    float eps = clamp(featureScale * 0.012, 0.0025, 0.04);

    // Sample the COMBINED relief (FBM ridges + voronoi cracks) so the normal
    // follows the same features the albedo paints — the cracks become grooves.
    float h0  = barkReliefHeight(p_grain, featureScale, fw);
    float hx  = barkReliefHeight(p_grain + vec3(eps, 0.0, 0.0), featureScale, fw);
    float hz  = barkReliefHeight(p_grain + vec3(0.0, 0.0, eps), featureScale, fw);
    // Y gradient is along the ridge direction -- contributes less to the
    // apparent bump since the ridges run in Y. Still include for completeness.
    float hy  = barkReliefHeight(p_grain + vec3(0.0, eps, 0.0), featureScale, fw);

    // Gradient of the scalar height field in grain space.
    // Divided by eps to get approximate derivative.
    // Unstretch grad.y: p_grain has Y stretched by BARK_Y_STRETCH, so the
    // Y derivative needs dividing by that factor to match the xz scale.
    vec3 grad = vec3((hx - h0) / eps, (hy - h0) / eps, (hz - h0) / eps);

    // Bump strength: stronger on thick trunks (large featureScale), weaker on twigs.
    // Kept GENTLE on purpose — with the flat albedo, the relief is the ONLY furrow cue,
    // and a strong bump tilts the groove walls perpendicular to the sun so they self-shadow
    // to near-black (the harsh "cracked-salmon" look). A soft bump keeps grooves lit + grey.
    float bumpStr = clamp(featureScale * 2.0, BARK_BUMP_MIN, BARK_BUMP_MAX);

    // Attenuate bump ONLY when the grain is genuinely sub-pixel. The grain coord
    // stretches Y by BARK_Y_STRETCH (×3), which inflates fw, so the old
    // smoothstep(0.3,0.8) faded the relief at normal viewing distances and the
    // bark read as flat. Push the fade out so bumps stay full until truly tiny.
    float bumpAA = 1.0 - smoothstep(0.7, 1.6, fw);
    bumpStr *= bumpAA;

    // The gradient is in the BRANCH-LOCAL frame (the sampling coord was rotated so the
    // branch axis is Y). Rotate it back to world via the frame basis before perturbing the
    // world normal, so the bump faces the right way on angled branches. For the trunk the
    // frame is (X,Y,Z) → worldGrad == grad → byte-identical to the old behaviour.
    vec3 worldGrad = frameU * grad.x + frameT * grad.y + frameW * grad.z;
    vec3 perturbed = normalize(worldNormal - worldGrad * bumpStr);
    return perturbed;
}
`;

// ---------------------------------------------------------------------------
// onBeforeCompile — vertex shader injections
//
// We need to pass vObjPos (object-space position) and vAo (baked AO) into
// the fragment shader.  Three's built-in MeshStandardMaterial vertex shader
// does not export object-space position, so we inject:
//   1. varying declarations into the preamble (before the chunk they appear in)
//   2. attribute + assignment into the <begin_vertex> chunk
// ---------------------------------------------------------------------------

const VERTEX_PARS_INJECT = /* glsl */`
varying vec3 vObjPos;
varying float vAo;
varying float vRadius;
attribute float ao;
attribute float windWeight;
attribute float boneIndex;
attribute float boneFraction;
attribute float aRadius;
// Branch frame (parallel-transported): aTangent = branch axis, aFrameU = a cross-section
// basis. Passed to the fragment so the bark pattern can be sampled in a coordinate that
// FOLLOWS the branch instead of world-Y. Absent on non-branch geometry (e.g. the bark
// swatch cylinder) → defaults to 0, and the fragment falls back to a world-Y frame.
attribute vec3 aTangent;
attribute vec3 aFrameU;
varying vec3 vTangent;
varying vec3 vFrameU;
// uv (around = x, arc-length = y) is declared by three unconditionally — do NOT redeclare it,
// just forward it to the fragment for the flow-line furrow field.
varying vec2 vBarkUv;
// Object-space radial normal — used to derive a SEAMLESS around-the-branch angle (the baked
// uv.x has a wrap-seam quad; the normal projected on the frame wraps cleanly).
varying vec3 vObjNormal;
// View-space branch tangent — used to tilt the (view-space) normal for the furrow relief.
varying vec3 vViewTangent;
`;

// Appended after the <begin_vertex> chunk body. Captures rest-space object position
// + baked AO for the fragment bark shader (all bark relief is sampled in object space).
const VERTEX_OBJPOS_INJECT = /* glsl */`
vObjPos = position;
vAo = ao;
vRadius = aRadius;
vTangent = aTangent;
vFrameU = aFrameU;
vBarkUv = uv;
vObjNormal = normalize(normal);
vViewTangent = normalize(normalMatrix * aTangent);
`;

// ---------------------------------------------------------------------------
// Skin vertex injection
//
// Replaces the old global-field windOffset with hierarchical skeletal skinning.
//
// Order (critical — Decision 6, bark-texture stability):
//   1. vObjPos = position  (rest/object space, set in VERTEX_OBJPOS_INJECT above)
//   2. THIS block: transformed = windSkinPosition(...)  (skinned position)
//   3. <project_vertex>    (consumes transformed)
//
// Bark albedo/normal/roughness sample vObjPos (rest space) in the fragment
// shader — they must NOT see the skinned position, so vObjPos is captured
// BEFORE this block runs. That ordering is guaranteed because VERTEX_OBJPOS_INJECT
// is prepended first via the #include <begin_vertex> replacement below.
//
// windSkinPosition reads `position` (rest attribute) directly — same value as
// vObjPos, but naming it `position` keeps it explicit that this is rest space,
// not the already-mutated `transformed`.
// ---------------------------------------------------------------------------
const VERTEX_SKIN_INJECT = /* glsl */`
{
    transformed = windSkinPosition(position, boneIndex, boneFraction, windWeight);
}
`;

// ---------------------------------------------------------------------------
// onBeforeCompile — fragment shader injections
//
// Injection points (exact chunk tokens from three 0.160 ShaderChunk):
//
//   #include <map_fragment>
//     → ALBEDO: replaced to compute bark albedo and set diffuseColor.rgb
//
//   #include <normal_fragment_maps>
//     → NORMAL: replaced to apply barkPerturbNormal to `normal`
//
//   #include <roughnessmap_fragment>
//     → ROUGHNESS: replaced to set roughnessFactor from bark height field
//
//   #include <aomap_fragment>
//     → AO: replaced to apply vAo to reflectedLight.indirectDiffuse
// ---------------------------------------------------------------------------

const FRAG_PARS_INJECT = /* glsl */`
varying vec3 vObjPos;
varying float vAo;
varying float vRadius;
varying vec3 vTangent;
varying vec3 vFrameU;
varying vec2 vBarkUv;
varying vec3 vObjNormal;
varying vec3 vViewTangent;
uniform float uWoodiness;
uniform float uPigment;
uniform float uBarkHue;
uniform float uBarkLightness;
uniform float uBarkRelief;
uniform float uBarkLenticels;
uniform float uBarkScale;
uniform float uBarkOrient;
uniform float uBarkPlates;
uniform float uBarkShed;
uniform float uBarkUnderHue;
uniform float uDebugNormals;
uniform float uBarkDebugFurrow;
`;

// Replaces #include <map_fragment>.
// Computes the bark coordinate stack once and stores barkPGrain / barkH / barkFw
// in locals so the subsequent normal + roughness chunks can reuse them without
// re-computing.  Macros (#define) cannot span chunks so we use plain locals
// declared in the fragment preamble injection and re-derive cheaply in each chunk
// instead — but since map_fragment runs first, we compute once and rely on the
// GLSL compiler to hoist the shared subexpressions (it will, they're pure).
const FRAG_MAP_REPLACEMENT = /* glsl */`
// ---- Bark coordinate setup (reused by normal + roughness chunks below) ----
// Feature size scales with the TRUE local tube radius (baked per-vertex as aRadius→vRadius),
// so bark furrows are sized to actual thickness and stay consistent around the trunk. (The
// old length(vObjPos.xz) proxy measured distance from the world Y-axis — wrong on any
// leaning/offset trunk, which made the texture frequency vary wildly and read as tiny.)
float barkFeatureScale = clamp(vRadius, 0.14, 0.55);
// Orientation tilt: at the identity barkOrient default the gain is 1.0, reproducing
// the legacy vec3(x, 3y, z) coordinate byte-for-byte (Y-stretch 3.0). orient<default
// tilts toward horizontal rings/bands; orient>default toward deep vertical furrows +
// longitudinal fiber. Shared by the FBM relief AND the voronoi plate UV below so the
// cracks reorient WITH the ridges.
float barkOrientGain = barkAnisoGain(uBarkOrient);
// BRANCH-LOCAL FRAME — so the bark pattern follows the branch axis instead of world-Y.
// frameT = branch axis, frameU/frameW = cross-section basis (orthonormalised from the baked
// attributes). Falls back to a world-Y frame when the attributes are absent (length≈0), so
// non-branch geometry (the bark swatch cylinder) still renders the trunk-style pattern.
vec3  barkFrameT = vTangent;
float barkAxisLen = length(barkFrameT);
barkFrameT = (barkAxisLen > 0.5) ? barkFrameT / barkAxisLen : vec3(0.0, 1.0, 0.0);
vec3  barkFrameU = (barkAxisLen > 0.5) ? vFrameU : vec3(1.0, 0.0, 0.0);
barkFrameU = barkFrameU - barkFrameT * dot(barkFrameT, barkFrameU);   // orthonormalise
barkFrameU = (length(barkFrameU) > 1e-3) ? normalize(barkFrameU) : vec3(1.0, 0.0, 0.0);
vec3  barkFrameW = cross(barkFrameT, barkFrameU);
// Object position expressed in the branch frame (T → Y). For the trunk this is ≈ vObjPos, so
// the pattern is unchanged there; on angled branches it rotates so the streaks run along them.
vec3  barkPLocal = vec3(dot(vObjPos, barkFrameU), dot(vObjPos, barkFrameT), dot(vObjPos, barkFrameW));
// Vertical anisotropy (research verdict): around-trunk frequency HIGHER than along, so the
// ridged-FBM furrows run UP the branch. barkOrientGain (orient gene) scales it: >1 = more
// vertical. The OLD code stretched the ALONG axis (×3), which biased ridges horizontal.
float barkVStretch = BARK_VERT_STRETCH * barkOrientGain;
vec3  barkPGrain   = vec3(barkPLocal.x, barkPLocal.y / barkVStretch, barkPLocal.z);

// Pixel-footprint of the sampling position: max screen-space derivative
// of the grain coordinate.  Passed into ridgedFBM to fade sub-pixel octaves.
float barkFw = max(max(fwidth(barkPGrain.x), fwidth(barkPGrain.y)), fwidth(barkPGrain.z));

// FURROW-GUIDED FBM is the bark relief (drives normal, colour, AO + the debug view). Seamless
// around-the-branch angle from the radial normal projected onto the carried branch frame
// (avoids the UV wrap-seam; consistent across forks). atan2 → [-pi,pi] → [0,1).
vec3  bn = normalize(vObjNormal);
float barkAngle  = atan(dot(bn, barkFrameW), dot(bn, barkFrameU)) / 6.2831853 + 0.5;
float barkFurrowH = barkFurrowHeight(barkAngle, vBarkUv.y, vObjPos.y);  // 1 = ridge crest, 0 = furrow

// ---- Override diffuseColor: bark albedo driven by the FURROW height (pale crest, dark furrow) ----
diffuseColor.rgb = barkAlbedo(barkPGrain, barkFurrowH, vObjPos.y, barkFeatureScale);
// ---- Herbaceous blend: green soft stem at low uWoodiness ----
// uWoodiness=1 → identity (exactly the bark albedo above).
// uWoodiness=0 → green herbaceous stem colour, no bark texture.
// barkH used as cheap within-stem shading variation (lighter ridges, darker base).
vec3 herbAlbedo = mix(vec3(0.16, 0.34, 0.12), vec3(0.30, 0.52, 0.20), barkFurrowH);
diffuseColor.rgb = mix(herbAlbedo, diffuseColor.rgb, uWoodiness);
// ---- Exfoliation: reveal fresh under-bark in shed patches ----
// barkShedField = 0 at uBarkShed=0 → strict no-op (bark byte-identical). Under-bark
// colour is recoloured by uBarkUnderHue, a touch lighter than the outer bark; when
// uBarkUnderHue == uBarkHue the peel is near-monochrome, when it diverges you get plane/
// eucalyptus camouflage. Gated by uWoodiness so herbaceous stems don't 'shed bark'.
float barkShedAmt = barkShedField(barkPGrain);
float ubL = clamp(mix(0.10, 0.92, uBarkLightness) + 0.12, 0.0, 1.0);
float ubS = uBarkUnderHue * 0.55;
float ubH = mix(0.09, 0.02, uBarkUnderHue);
vec3  underCol = hsl2rgb(ubH, ubS, ubL);
diffuseColor.rgb = mix(diffuseColor.rgb, underCol, barkShedAmt * uWoodiness);
`;

// Replaces #include <normal_fragment_maps>.
// `normal` is the working normal variable declared by three's normal_fragment_begin.
// barkFeatureScale / barkPGrain are in scope from the map_fragment replacement above.
const FRAG_NORMAL_REPLACEMENT = /* glsl */`
// Scale bark bump perturbation by uWoodiness so herbaceous stems are smooth.
// uWoodiness=1 → full featureScale (identity bark bump).
// uWoodiness=0 → featureScale approaches 0, barkPerturbNormal returns the
//                 unperturbed world normal (smooth round stem).
// FURROW NORMAL — make light catch the furrow walls. Finite-difference the furrow height in
// (around, along) parameter space, then tilt the VIEW-space normal in the circumferential +
// axial directions (the furrow walls + grain). Replaces the FBM finite-difference normal.
// Gated by uWoodiness so herbaceous stems stay smooth.
float fCount = barkFurrowCount();
float fEpsA  = 0.15 / max(fCount, 1.0);
float fHa = barkFurrowHeight(barkAngle + fEpsA, vBarkUv.y, vObjPos.y);
float fHl = barkFurrowHeight(barkAngle, vBarkUv.y + 0.04, vObjPos.y);
float fdHda = (fHa - barkFurrowH) / fEpsA;          // slope across furrows (circumferential)
float fdHdl = (fHl - barkFurrowH) / 0.04;           // slope along furrows (grain)
float fCirc = 6.2831853 * max(vRadius, 0.05);       // circumference → world scale for the around-slope
vec3  fAxis    = normalize(vViewTangent);
vec3  fCircDir = normalize(cross(fAxis, normal));    // circumferential direction, view space
vec3  fGrad = ((fdHda / fCirc) * fCircDir + fdHdl * fAxis) * BARK_FURROW_DEPTH * uWoodiness;
normal = normalize(normal - fGrad);
// Toksvig-style roughness compensation: raise roughness where the shading normal
// varies fast across the screen (high-normal-variance pixels) to suppress residual
// specular aliasing.  Done HERE, not in the roughness chunk, because three's
// meshphysical fragment runs roughnessmap_fragment BEFORE normal_fragment_begin,
// so the normal variable does not exist yet at the roughness chunk.  roughnessFactor
// was declared by the roughness chunk above and is still mutable (and not yet
// consumed by lighting) at this point.
float barkNormalVariance = clamp(length(fwidth(normal)) * 4.0, 0.0, 0.3);
roughnessFactor = clamp(roughnessFactor + barkNormalVariance, 0.0, 1.0);
`;

// Replaces #include <roughnessmap_fragment>.
// Sets roughnessFactor (declared by three's roughness_fragment_begin preamble).
// barkH is in scope from the map_fragment replacement above.
// Smoother bark (low uBarkRelief) is less rough overall.
const FRAG_ROUGHNESS_REPLACEMENT = /* glsl */`
float roughnessFactor = roughness;
// Bark is a MATTE, diffuse-dominant surface — keep roughness high so it doesn't read as
// glossy/plastic (the flat albedo otherwise lets specular highlights dominate). Furrows
// (low barkH) are slightly rougher than worn ridge tops (high barkH), but both stay matte.
float barkRoughnessBase  = mix(0.86, 0.96, uBarkRelief);   // furrows
float barkRoughnessRidge = mix(0.74, 0.86, uBarkRelief);   // ridge tops (weathered, matte — no plastic gloss)
roughnessFactor = mix(barkRoughnessBase, barkRoughnessRidge, barkFurrowH);
// Herbaceous stems are soft/matte (rougher than polished bark ridges).
// uWoodiness=1 → identity (bark roughness unchanged).
// uWoodiness=0 → blend to 0.78 (flat herbaceous roughness).
roughnessFactor = mix(0.78, roughnessFactor, uWoodiness);
// NOTE: Toksvig roughness compensation (fwidth of the perturbed normal) is applied
// in FRAG_NORMAL_REPLACEMENT, not here — the normal variable does not exist yet here.
`;

// Replaces #include <aomap_fragment>.
// Applies baked per-vertex AO to the indirect diffuse term.
// ao convention: 1.0 = fully lit/unoccluded, 0.0 = fully occluded (matches
// branchMesh, which currently fills ao=1.0 → no darkening). So multiply
// indirect by vAo (NOT 1-vAo): vAo=1 → full IBL, vAo=0 → 0.15 in crevices.
const FRAG_AO_REPLACEMENT = /* glsl */`
reflectedLight.indirectDiffuse *= mix(1.0, vAo, 0.85);
// Procedural crack AO — the KEY to dark fissures. Deep cracks are in self-shadow/occlusion
// in real bark; without this, the recessed crack walls instead CATCH the directional sun and
// read as a bright network (the inverted look). Darken BOTH indirect (IBL) and, partly,
// direct so the cracks stay dark under any light angle. Aligned with the relief via the same
// barkCrackMask. Gated by uBarkRelief so smooth-bark genes aren't darkened.
float barkAO = 1.0 - (1.0 - barkFurrowH) * (BARK_CRACK_AO * uBarkRelief);
reflectedLight.indirectDiffuse  *= barkAO;
reflectedLight.directDiffuse    *= mix(1.0, barkAO, 0.7);
reflectedLight.indirectSpecular *= barkAO;
`;

// ---------------------------------------------------------------------------
// PUBLIC FACTORY
// ---------------------------------------------------------------------------

/**
 * createBarkMaterial()
 *
 * Returns a MeshStandardMaterial with procedural bark injected via
 * onBeforeCompile.  Full PBR lighting, IBL, and shadow support for free.
 *
 * @returns {{
 *   material: THREE.MeshStandardMaterial,
 *   setGenome(opts: { woodiness?: number, pigment?: number }): void,
 *   getAlbedoMap(): null,
 *   dispose(): void,
 * }}
 */
export function createBarkMaterial() {
    // Stable uniform refs — mutated by setGenome() without triggering recompile.
    const barkUniforms = {
        uWoodiness:      { value: 1.0 },
        uPigment:        { value: 0.45 },
        uBarkHue:        { value: 0.85 },  // brown (default = old brown-furrowed identity)
        uBarkLightness:  { value: 0.28 },  // dark
        uBarkRelief:     { value: 1.00 },  // relief amplitude (furrowed)
        uBarkLenticels:  { value: 0.00 },  // none
        uBarkScale:      { value: 0.50 },  // medium feature scale
        uBarkOrient:     { value: 0.70 },  // crack orientation — 0.70 = legacy vertical bias (gain==1)
        uBarkPlates:     { value: 0.45 },  // ridges↔plates morphology — 0.45 = legacy crack depth
        uBarkShed:       { value: 0.00 },  // exfoliation — 0 = intact bark (no-op), 1 = strong peel
        uBarkUnderHue:   { value: 0.75 },  // under-bark hue (only active when uBarkShed > 0)
        uDebugNormals:   { value: 0.0 },   // 1 = output the perturbed normal as colour (normals debug view)
        uBarkDebugFurrow:{ value: 0.0 },   // 1 = output the flow-line furrow field (furrow-lines debug view)
    };

    const material = new THREE.MeshStandardMaterial({
        roughness: 0.85,
        metalness: 0.0,
        side:      THREE.FrontSide,
    });

    // Stable cache key so three.js never recompiles this variant unnecessarily.
    // Bumped from 'bark-windskin' → 'bark-windskin-colorpattern' for the
    // barkColor/barkPattern uniform additions so stale cached programs are not reused.
    material.customProgramCacheKey = () => 'bark-windskin-orthoBark-woody-orient-plates-shed-radius-dbgN-xcrack';

    material.onBeforeCompile = (shader) => {
        // Merge our genome uniforms into the shader's uniform map.
        Object.assign(shader.uniforms, barkUniforms);

        // --- Wind/skin uniforms ---
        // uBoneTex is set to a real THREE.DataTexture by viewer.js after
        // buildBranchGeometry(); null here is replaced before first render.
        const windUniforms = {
            uBoneTex:      { value: null },
            uBoneCount:    { value: WIND_BONE_UNIFORM_DEFAULTS.uBoneCount },
            uWindStrength: { value: WIND_BONE_UNIFORM_DEFAULTS.uWindStrength },
            uTime:         { value: WIND_BONE_UNIFORM_DEFAULTS.uTime },
            uWindDir:      { value: new THREE.Vector2(...(WIND_BONE_UNIFORM_DEFAULTS.uWindDir ?? [1, 0])) },
        };
        Object.assign(shader.uniforms, windUniforms);
        // Expose wind uniforms for per-frame updates by the wiring code (viewer.js).
        material._windUniforms = windUniforms;

        // --- Vertex shader ---
        // Prepend:
        //   VERTEX_PARS_INJECT  — varyings + per-vertex attributes (ao, windWeight,
        //                         boneIndex, boneFraction)
        //   WIND_BONE_UNIFORM_DECLS — uBoneTex, uBoneCount, uWindStrength
        //   WIND_BONE_FETCH_GLSL    — fetchBone(float idx) → mat4
        //   WIND_SKIN_VERTEX_GLSL   — windSkinPosition(restPos, boneIdx, frac, w) → vec3
        shader.vertexShader = (
            VERTEX_PARS_INJECT +
            WIND_BONE_UNIFORM_DECLS +
            WIND_BONE_FETCH_GLSL +
            WIND_SKIN_VERTEX_GLSL +
            shader.vertexShader
        );

        // After <begin_vertex> (which declares `vec3 transformed = vec3(position)`):
        //   1. VERTEX_OBJPOS_INJECT: capture rest-space vObjPos = position FIRST
        //      (bark fragment samples this — must be pre-skin)
        //   2. VERTEX_SKIN_INJECT: skin transformed via windSkinPosition
        // Both must run before <project_vertex> which consumes `transformed`.
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n' + VERTEX_OBJPOS_INJECT + VERTEX_SKIN_INJECT,
        );

        // --- Fragment shader ---
        // Inject varying declarations + genome uniforms before the built-in preamble.
        shader.fragmentShader = FRAG_PARS_INJECT + BARK_GLSL_HELPERS + shader.fragmentShader;

        // ALBEDO — replace <map_fragment>
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            FRAG_MAP_REPLACEMENT,
        );

        // NORMAL — replace <normal_fragment_maps>
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <normal_fragment_maps>',
            FRAG_NORMAL_REPLACEMENT,
        );

        // ROUGHNESS — replace <roughnessmap_fragment>
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <roughnessmap_fragment>',
            FRAG_ROUGHNESS_REPLACEMENT,
        );

        // AO — replace <aomap_fragment>
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <aomap_fragment>',
            FRAG_AO_REPLACEMENT,
        );

        // DEBUG NORMALS — when uDebugNormals is on, output the PERTURBED bark normal
        // as colour (the "normals" render mode) so the procedural furrow/crack relief
        // is visible. `outgoingLight` and `normal` are both in scope here (normal is
        // the view-space perturbed normal); overriding outgoingLight before the output
        // chunk avoids touching gl_FragColor directly.
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            /* glsl */`
if (uDebugNormals > 0.5) { outgoingLight = normalize(normal) * 0.5 + 0.5; }
// DEBUG LINE TRACES — show the flow-line furrow field: ridges pale, furrow lines dark, so the
// traced furrow geometry reads directly (the "furrows" render mode).
if (uBarkDebugFurrow > 0.5) {
    float fl = smoothstep(0.0, 0.35, barkFurrowH);  // 0 in a furrow line, 1 on a ridge crest
    outgoingLight = mix(vec3(0.02, 0.03, 0.05), vec3(0.82, 0.86, 0.90), fl);
}
#include <opaque_fragment>
`,
        );
    };

    return {
        material,

        /**
         * setDebugNormals(on)
         *
         * Toggle outputting the perturbed bark normal as colour (for the "normals"
         * render mode). In-place uniform write — no recompile.
         *
         * @param {boolean} on
         */
        setDebugNormals(on) {
            barkUniforms.uDebugNormals.value = on ? 1.0 : 0.0;
        },

        /**
         * setDebugFurrows(on)
         *
         * Toggle outputting the flow-line furrow field as colour (the "furrows" render mode),
         * so the traced furrow lines are visible before they drive the relief. No recompile.
         *
         * @param {boolean} on
         */
        setDebugFurrows(on) {
            barkUniforms.uBarkDebugFurrow.value = on ? 1.0 : 0.0;
        },

        /**
         * setGenome({ woodiness, pigment, barkColor, barkPattern })
         *
         * Mutates genome uniform values in-place — no shader recompile triggered.
         * All parameters are optional; omitted ones keep their current value.
         *
         * @param {object} opts
         * @param {number} [opts.woodiness]      1=woody bark (identity), 0=green herbaceous stem
         * @param {number} [opts.pigment]        per-species hue gene 0–1
         * @param {number} [opts.barkHue]        0=grey, 1=saturated warm brown/red
         * @param {number} [opts.barkLightness]  0=near-black, 1=pale/birch
         * @param {number} [opts.barkRelief]     0=smooth, 1=deep relief amplitude
         * @param {number} [opts.barkLenticels]  0=none, 1=dense horizontal dashes
         * @param {number} [opts.barkScale]      0=coarse, 1=fine feature scale
         * @param {number} [opts.barkOrient]     0=horizontal rings, 0.5≈isotropic net, 1=vertical furrows/fiber
         * @param {number} [opts.barkPlates]     0=continuous ridges, 1=discrete flaking plates/scales
         * @param {number} [opts.barkShed]       0=intact bark, 1=strong exfoliation/peel
         * @param {number} [opts.barkUnderHue]   under-bark hue revealed by shedding (0=grey, 1=warm)
         */
        setGenome({ woodiness, pigment, barkHue, barkLightness, barkRelief, barkLenticels, barkScale, barkOrient, barkPlates, barkShed, barkUnderHue } = {}) {
            if (woodiness      !== undefined) barkUniforms.uWoodiness.value      = woodiness;
            if (pigment        !== undefined) barkUniforms.uPigment.value        = pigment;
            if (barkHue        !== undefined) barkUniforms.uBarkHue.value        = barkHue;
            if (barkLightness  !== undefined) barkUniforms.uBarkLightness.value  = barkLightness;
            if (barkRelief     !== undefined) barkUniforms.uBarkRelief.value     = barkRelief;
            if (barkLenticels  !== undefined) barkUniforms.uBarkLenticels.value  = barkLenticels;
            if (barkScale      !== undefined) barkUniforms.uBarkScale.value      = barkScale;
            if (barkOrient     !== undefined) barkUniforms.uBarkOrient.value     = barkOrient;
            if (barkPlates     !== undefined) barkUniforms.uBarkPlates.value     = barkPlates;
            if (barkShed       !== undefined) barkUniforms.uBarkShed.value       = barkShed;
            if (barkUnderHue   !== undefined) barkUniforms.uBarkUnderHue.value   = barkUnderHue;
        },

        /**
         * getAlbedoMap()
         *
         * Albedo is fully procedural — no texture map is used.
         * Returns null; callers in Unlit mode fall back to a flat tinted color.
         *
         * @returns {null}
         */
        getAlbedoMap() {
            return null;
        },

        /**
         * dispose()
         *
         * Release the material's GPU resources.
         * Remove any mesh using this material from the scene first.
         */
        dispose() {
            material.dispose();
        },
    };
}

// ---------------------------------------------------------------------------
// Branch depth material — for shadow casting (customDepthMaterial)
//
// MeshDepthMaterial with the SAME skeletal skinning injection so the shadow
// silhouette tracks the swaying branch (Decision 7 / Task 3).
//
// Because we do NOT use SkinnedMesh, three will NOT auto-skin any depth
// material. We must inject the bone-follow ourselves.
//
// The depth vertex shader (ShaderLib/depth.glsl.js) has the same
// #include <begin_vertex> / #include <project_vertex> tokens as the standard
// vertex shader, so the same injection pattern works.
//
// The fragment shader is plain depth — no bark sampling — so we only need
// the vertex-side injection.
//
// Usage (viewer.js):
//   const { depthMaterial } = createBranchDepthMaterial();
//   branchMesh.customDepthMaterial = depthMaterial;
//   branchMesh.castShadow = true;
//   // Per-frame: update depthMaterial._windUniforms the same way as bark.
// ---------------------------------------------------------------------------

// Minimal vertex pars for depth material: just the skin attributes.
// No varyings needed (fragment doesn't read them).
const DEPTH_VERTEX_PARS_INJECT = /* glsl */`
attribute float windWeight;
attribute float boneIndex;
attribute float boneFraction;
`;

/**
 * createBranchDepthMaterial()
 *
 * Returns a MeshDepthMaterial with hierarchical skeletal skinning injected via
 * onBeforeCompile. Assign to branchMesh.customDepthMaterial so the branch
 * shadow silhouette tracks the wind sway.
 *
 * The returned _windUniforms object should be updated each frame by viewer.js
 * in parallel with the main bark material uniforms.
 *
 * @returns {{
 *   depthMaterial: THREE.MeshDepthMaterial,
 *   dispose(): void,
 * }}
 */
export function createBranchDepthMaterial() {
    const depthMaterial = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
    });

    depthMaterial.customProgramCacheKey = () => 'bark-depth-windskin';

    depthMaterial.onBeforeCompile = (shader) => {
        // Skin uniforms — shared values updated by viewer.js each frame.
        const windUniforms = {
            uBoneTex:      { value: null },
            uBoneCount:    { value: WIND_BONE_UNIFORM_DEFAULTS.uBoneCount },
            uWindStrength: { value: WIND_BONE_UNIFORM_DEFAULTS.uWindStrength },
            uTime:         { value: WIND_BONE_UNIFORM_DEFAULTS.uTime },
            uWindDir:      { value: new THREE.Vector2(...(WIND_BONE_UNIFORM_DEFAULTS.uWindDir ?? [1, 0])) },
        };
        Object.assign(shader.uniforms, windUniforms);
        depthMaterial._windUniforms = windUniforms;

        // Prepend attribute decls + skin GLSL into vertex shader preamble.
        shader.vertexShader = (
            DEPTH_VERTEX_PARS_INJECT +
            WIND_BONE_UNIFORM_DECLS +
            WIND_BONE_FETCH_GLSL +
            WIND_SKIN_VERTEX_GLSL +
            shader.vertexShader
        );

        // After <begin_vertex> (declares `vec3 transformed`): apply skinning.
        // No vObjPos capture needed — depth fragment does not sample bark.
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n' + VERTEX_SKIN_INJECT,
        );
    };

    return {
        depthMaterial,
        dispose() {
            depthMaterial.dispose();
        },
    };
}
