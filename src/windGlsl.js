// =============================================================================
// windGlsl.js — shared GLSL wind displacement strings and JS defaults
//
// Dependency-free (no Three.js import) so this module is Node-testable.
//
// Exports:
//   WIND_UNIFORM_DECLS    — GLSL uniform declarations (vertex shader preamble)
//   WIND_FUNCTION_GLSL    — GLSL windOffset() function definition
//   WIND_UNIFORM_DEFAULTS — Plain JS object with initial values for wiring
//
// The wind model:
//   Primary sway: low-frequency sin wave traveling along uWindDir, amplitude
//     scaled by swayFactor and uWindStrength. The gust phase travels with
//     worldPos dot uWindDir + uTime so the wave sweeps across the tree.
//   Secondary cross-sway: a smaller orthogonal sway at a different frequency,
//     giving the slight side-to-side motion real trees show.
//   When uWindStrength == 0, all terms collapse to zero (calm tree identical
//     to the static case, since every term multiplies uWindStrength).
// =============================================================================

// ---------------------------------------------------------------------------
// GLSL — uniform declarations (inject into vertex shader preamble)
// ---------------------------------------------------------------------------

export const WIND_UNIFORM_DECLS = /* glsl */`
uniform float uTime;
uniform float uWindStrength;
uniform vec2  uWindDir;
`;

// ---------------------------------------------------------------------------
// GLSL — windOffset function
//
// Signature (frozen contract):
//   vec3 windOffset(vec3 worldPos, float swayFactor)
//
// Parameters:
//   worldPos   — world-space position of the point being displaced
//   swayFactor — 0 = rigid (trunk base), 1 = maximum flex (twig tips / leaves)
//
// Returns a world-space displacement vector.
//
// Algorithm:
//   1. Primary gust: sin wave traveling along uWindDir with phase driven by
//      the projection of worldPos onto uWindDir + uTime.  Amplitude ∝
//      swayFactor^1.5 so the base stays very rigid and tips flex strongly.
//   2. Turbulence: a second sin at a higher, irrational frequency adds organic
//      variation — prevents all branches swaying in perfect lockstep.
//   3. Cross-sway: a small perpendicular component (the third axis) adds the
//      side-to-side stagger real trees show in gusty conditions.
//
// Guard: every amplitude term multiplies uWindStrength, so when
// uWindStrength == 0, windOffset returns exactly vec3(0.0).
// ---------------------------------------------------------------------------

export const WIND_FUNCTION_GLSL = /* glsl */`
vec3 windOffset(vec3 worldPos, float swayFactor) {
    // Early-out baked in: uWindStrength == 0 → all amplitudes == 0.

    // Primary wave direction (normalized 3D, horizontal only)
    vec3 windDir3 = normalize(vec3(uWindDir.x, 0.0, uWindDir.y));

    // Cross direction (perpendicular to wind, in the horizontal plane)
    vec3 crossDir = vec3(-windDir3.z, 0.0, windDir3.x);

    // Phase: position projected onto wind direction + time.
    // Multiplying by 0.8 sets the spatial frequency of the gust wave.
    float phase = dot(worldPos, windDir3) * 0.8 + uTime;

    // Flexible amplitude: ^1.5 ease — base stays rigid, but mid-canopy and tips
    // both flex meaningfully (cubic crushed everything below the extreme tips,
    // making the sway invisible). Matches the documented swayFactor^1.5 intent.
    float flex = pow(swayFactor, 1.5);

    // Primary sway: large-amplitude, slow wave along the wind direction.
    // Frequency 1.1 rad/s keeps it visually "heavy tree" cadence.
    float primaryAmp = uWindStrength * flex * 0.7;
    float primarySway = sin(phase * 1.1) * primaryAmp;

    // Turbulence: irrational-ratio frequency, offset phase, smaller amplitude.
    // This breaks the mechanical lockstep between branches.
    float turbAmp = uWindStrength * flex * 0.22;
    float turbSway = sin(phase * 2.73 + worldPos.y * 1.4) * turbAmp;

    // Cross-sway: perpendicular, slower frequency. Kept SMALL — a large cross
    // component turns the back-and-forth sway into a circular/elliptical orbit
    // (Lissajous of primary vs cross). Just a touch of side-to-side stagger.
    float crossAmp = uWindStrength * flex * 0.05;
    float crossSway = sin(phase * 0.83 + 0.9) * crossAmp;

    vec3 displacement = windDir3 * (primarySway + turbSway)
                      + crossDir  * crossSway;

    return displacement;
}
`;

// ---------------------------------------------------------------------------
// JS — initial uniform values for the wiring engineer
//
// uWindDir is a plain [x, z] pair (no Three.js dependency).
// uWindStrength == 0 → no movement (calm default).
// ---------------------------------------------------------------------------

export const WIND_UNIFORM_DEFAULTS = {
    uTime:          0,
    uWindStrength:  0,
    uWindDir:       [1, 0],
};
