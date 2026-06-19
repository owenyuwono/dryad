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

const float BARK_RIDGE_FREQ_SCALE   = 0.5;
const float BARK_FISSURE_FREQ_SCALE = 0.42;
const float BARK_FISSURE_WEIGHT     = 0.55;
const float BARK_BUMP_MIN           = 0.18;
const float BARK_BUMP_MAX           = 0.55;
const float BARK_PLATE_FREQ         = 1.4;
const float BARK_CRACK_WIDTH        = 6.0;
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
    for (int oct = 0; oct < 5; oct++) {
        // Band-limit: fade out this octave when its pixel footprint >= ~1 px.
        float octFw   = fw * freq;
        float aaFade  = 1.0 - smoothstep(0.4, 1.0, octFw);
        total += ridgeOctave(pw * freq) * amp * aaFade;
        norm  += amp;
        freq  *= 2.13;   // slightly irrational lacunarity -> no aliasing
        amp   *= 0.52;   // gain < 0.5 keeps ridges dominant
    }
    float h = clamp(total / norm, 0.0, 1.0);
    // Sharpening: push ridge peaks up and furrow bottoms down for crisper look.
    return pow(h, 0.65);
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
    // sqrt to get linear distance; smoothstep for crack sharpness.
    float edge = sqrt(minDist2) - sqrt(minDist1);
    return clamp(edge * BARK_CRACK_WIDTH, 0.0, 1.0);
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
vec3 barkAlbedo(vec3 p_grain, float h, float worldY) {
    // ---- Procedural palette from orthogonal uBarkHue + uBarkLightness ----
    // bL = base lightness (dark↔pale); bS/bH = saturation+hue (grey↔warm brown→red).
    float bL = mix(0.10, 0.92, uBarkLightness);
    float bS = uBarkHue * 0.55;
    float bH = mix(0.09, 0.02, uBarkHue);   // tan/yellow-brown → red as hue rises
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
    float baseSat = bS * 0.50;                 // earthy, not salmon
    float baseHue = mix(bH, 0.07, 0.40);       // pull toward tan/orange-brown, away from red
    vec3 baseCol = hsl2rgb(baseHue, baseSat, bL);

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

    // ---- Lenticel marks: now an INDEPENDENT axis (uBarkLenticels), decoupled from
    // furrow/color — so brown bark can have lenticels (cherry) or pale bark none. ----
    float lenticelProminence = clamp(uBarkLenticels * 1.2, 0.0, 1.0);
    float lenticelMask = barkLenticel(p_grain, lenticelProminence);
    // Lenticel color: dark grey-brown dash on the pale birch base.
    vec3 lenticelCol = mix(paletteRidge, paletteFurrow * 0.55, 0.75);
    baseCol = mix(baseCol, lenticelCol, lenticelMask);

    // ---- Micro-variation: +-0.04 from high-freq noise ----
    float micro = barkNoise(p_grain * 8.3 + vec3(1.1, 4.4, 2.2)) * 0.04;
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
const float BARK_Y_STRETCH = 3.0; // must match the stretch applied in barkPGrain

// Combined bark RELIEF height — the height field the NORMAL follows. It is the
// FBM ridge field MINUS the voronoi plate cracks (the same cracks barkAlbedo
// darkens), so the normal map follows the VISIBLE bark pattern instead of only
// the coarse ridges. The plate UV here is identical to the one used for the
// albedo crack mask (vObjPos = p_grain with Y un-stretched by BARK_Y_STRETCH),
// so the lit grooves line up exactly with the painted cracks.
float barkReliefHeight(vec3 p_grain, float featureScale, float fw) {
    float h = barkHeightField(p_grain, featureScale, fw);
    float plateFreq = (BARK_PLATE_FREQ * mix(0.6, 1.8, uBarkScale)) / max(featureScale, 0.04);
    vec2  plateUV   = vec2(p_grain.x, (p_grain.y / BARK_Y_STRETCH) * 1.4) * plateFreq;
    float vEdge     = barkVoronoiEdge(plateUV);   // 1 inside plate, 0 on a crack
    // Cracks cut grooves into the relief, depth driven by uBarkPlates (ridges↔plates),
    // gated by uBarkRelief — same factor the albedo crack mask uses, so lit grooves match.
    h -= uBarkRelief * uBarkPlates * (1.0 - vEdge);
    // Exfoliation: lift the patch BOUNDARY (curling-flake lip) so peel edges catch raking
    // light. Gated by uBarkRelief so on smooth bark (relief→0) shedding is colour-only mottle.
    // shedEdge humps at the patch boundary (peaks where shed≈0.5). No-op when uBarkShed=0.
    float shed     = barkShedField(p_grain);
    float shedEdge = shed * (1.0 - shed) * 4.0;
    h += uBarkRelief * BARK_SHED_LIFT * shedEdge;
    return h;
}

vec3 barkPerturbNormal(vec3 p_grain, vec3 worldNormal, float featureScale, float fw) {
    // Bump epsilon proportional to feature size, clamped to a sane range.
    float eps = clamp(featureScale * 0.04, 0.003, 0.04);

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
    vec3 grad = vec3((hx - h0) / eps, (hy - h0) / (eps * BARK_Y_STRETCH), (hz - h0) / eps);

    // Bump strength: stronger on thick trunks (large featureScale), weaker on twigs.
    // Kept GENTLE on purpose — with the flat albedo, the relief is the ONLY furrow cue,
    // and a strong bump tilts the groove walls perpendicular to the sun so they self-shadow
    // to near-black (the harsh "cracked-salmon" look). A soft bump keeps grooves lit + grey.
    float bumpStr = clamp(featureScale * 1.4, BARK_BUMP_MIN, BARK_BUMP_MAX);

    // Attenuate bump ONLY when the grain is genuinely sub-pixel. The grain coord
    // stretches Y by BARK_Y_STRETCH (×3), which inflates fw, so the old
    // smoothstep(0.3,0.8) faded the relief at normal viewing distances and the
    // bark read as flat. Push the fade out so bumps stay full until truly tiny.
    float bumpAA = 1.0 - smoothstep(0.7, 1.6, fw);
    bumpStr *= bumpAA;

    // Perturb world normal by the height-field gradient (tangent-space approx).
    // Since p_grain is in object space with Y=up, the gradient is already in
    // a consistent frame. We subtract the gradient component along the normal
    // and re-normalise.
    vec3 perturbed = normalize(worldNormal - grad * bumpStr);
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
`;

// Appended after the <begin_vertex> chunk body. Captures rest-space object position
// + baked AO for the fragment bark shader (all bark relief is sampled in object space).
const VERTEX_OBJPOS_INJECT = /* glsl */`
vObjPos = position;
vAo = ao;
vRadius = aRadius;
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
vec3  barkPGrain     = barkAnisoCoord(vec3(vObjPos.x, vObjPos.y * 3.0, vObjPos.z), barkOrientGain);

// Pixel-footprint of the sampling position: max screen-space derivative
// of the grain coordinate.  Passed into ridgedFBM to fade sub-pixel octaves.
float barkFw = max(max(fwidth(barkPGrain.x), fwidth(barkPGrain.y)), fwidth(barkPGrain.z));

float barkH = barkHeightField(barkPGrain, barkFeatureScale, barkFw);
// Flatten relief toward smooth as uBarkRelief → 0 (smooth bark).
// Ridge contrast is pulled toward a neutral mid-grey so normals stay gentle.
// The lerp target (0.55) sits at the 'nearly flat' read without going fully flat.
barkH = mix(0.55, barkH, mix(0.25, 1.0, uBarkRelief));

// ---- Override diffuseColor with procedural bark albedo (FLAT base + colour features) ----
// The voronoi plate edge is no longer needed for albedo (the pattern lives in the normal).
// barkReliefHeight computes its own plate UV internally for the NORMAL relief.
diffuseColor.rgb = barkAlbedo(barkPGrain, barkH, vObjPos.y);
// ---- Herbaceous blend: green soft stem at low uWoodiness ----
// uWoodiness=1 → identity (exactly the bark albedo above).
// uWoodiness=0 → green herbaceous stem colour, no bark texture.
// barkH used as cheap within-stem shading variation (lighter ridges, darker base).
vec3 herbAlbedo = mix(vec3(0.16, 0.34, 0.12), vec3(0.30, 0.52, 0.20), barkH);
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
float scaledBarkFeature = barkFeatureScale * uWoodiness;
normal = barkPerturbNormal(barkPGrain, normal, scaledBarkFeature, barkFw);
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
float barkRoughnessBase  = mix(0.84, 0.96, uBarkRelief);   // furrows
float barkRoughnessRidge = mix(0.70, 0.82, uBarkRelief);   // ridge tops
roughnessFactor = mix(barkRoughnessBase, barkRoughnessRidge, barkH);
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
    };

    const material = new THREE.MeshStandardMaterial({
        roughness: 0.85,
        metalness: 0.0,
        side:      THREE.FrontSide,
    });

    // Stable cache key so three.js never recompiles this variant unnecessarily.
    // Bumped from 'bark-windskin' → 'bark-windskin-colorpattern' for the
    // barkColor/barkPattern uniform additions so stale cached programs are not reused.
    material.customProgramCacheKey = () => 'bark-windskin-orthoBark-woody-orient-plates-shed-radius-dbgN';

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
