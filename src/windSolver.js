// src/windSolver.js
// Pure, no Three.js import. Per-frame hierarchical wind solver.
//
// Given a bones_wind table (from buildBranchGeometry) and wind parameters,
// computes one mat4 per bone (column-major, Float32Array) by:
//   1. Computing a local rotation angle per bone (from time + per-bone phase + stiffness)
//   2. Composing top-down: world_c = world_parent(c) * local_c
//      where local_c = T(pivot_c) * R(axis, angle_c) * T(-pivot_c)
//
// Output layout:
//   out[c*16 .. c*16+15]  = mat4 for bone c, column-major (same as GLSL mat4)
//
// Guarantees:
//   - windStrength === 0  => every bone matrix is identity
//   - deterministic: same (bones_wind, time, strength, dir) => byte-identical out
//   - parent-before-child ordering (asserted; bones_wind.parent[c] < c)
//   - rigid bones (isRigid[c] === 1) always produce identity local rotation

// ---------------------------------------------------------------------------
// Integer hash → deterministic per-bone phase in [0, 2π)
// A simple Wang hash variant (no floating-point, no rng).
// Input: bone index c (integer). We fold pivot coordinates too so two organisms
// with the same bone count but different pivots get different phases.
// ---------------------------------------------------------------------------

function wangHash(x) {
    // Wang hash (32-bit)
    x = Math.imul(x ^ (x >>> 4), 0x08D8_74F5 | 0);
    x = Math.imul(x ^ (x >>> 9), 0x6546_B0DF | 0);
    x = (x ^ (x >>> 16)) >>> 0;
    return x;
}

// Quantise a float pivot coordinate to an integer bucket (avoids float-hash
// instability while still distinguishing organisms with different geometry).
function quantisePivot(v) {
    // Snap to 0.5mm buckets (tree coords are in metres, ~5m tall; 1/2000 = 0.5mm)
    return Math.round(v * 2000) | 0;
}

function bonePhase(c, px, py, pz) {
    // Three-input hash: XOR fold then Wang-hash together.
    const hc  = wangHash(c);
    const hx  = wangHash(quantisePivot(px) ^ 0x1234_5678);
    const hy  = wangHash(quantisePivot(py) ^ 0xDEAD_BEEF);
    const hz  = wangHash(quantisePivot(pz) ^ 0x9E37_79B9);
    const combined = (hc ^ hx ^ hy ^ hz) >>> 0;
    // Map to [0, 2π)
    return (combined / 4294967296) * 6.283185307179586;
}

// ---------------------------------------------------------------------------
// Helpers: 4×4 matrix ops on a Float64Array scratch buffer (column-major)
// We use Float64 internally for precision, then write Float32 to out.
// ---------------------------------------------------------------------------

// Write identity into a 16-element subarray view.
function setIdentity(m, off) {
    m[off +  0] = 1; m[off +  1] = 0; m[off +  2] = 0; m[off +  3] = 0;
    m[off +  4] = 0; m[off +  5] = 1; m[off +  6] = 0; m[off +  7] = 0;
    m[off +  8] = 0; m[off +  9] = 0; m[off + 10] = 1; m[off + 11] = 0;
    m[off + 12] = 0; m[off + 13] = 0; m[off + 14] = 0; m[off + 15] = 1;
}

// Build pivot-rotation matrix into dst[0..15]:
//   T(pivot) * R(axis, angle) * T(-pivot)
// axis MUST be normalised.
// Column-major: column j starts at dst[j*4].
function buildPivotRotation(dst, ax, ay, az, angle, px, py, pz) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;

    // Rodrigues rotation matrix (column-major):
    // col 0: [t*ax*ax+c,  t*ax*ay+s*az, t*ax*az-s*ay, 0]
    // col 1: [t*ax*ay-s*az, t*ay*ay+c,  t*ay*az+s*ax, 0]
    // col 2: [t*ax*az+s*ay, t*ay*az-s*ax, t*az*az+c,  0]
    // col 3: translation part

    const r00 = t*ax*ax + c;
    const r10 = t*ax*ay + s*az;
    const r20 = t*ax*az - s*ay;

    const r01 = t*ax*ay - s*az;
    const r11 = t*ay*ay + c;
    const r21 = t*ay*az + s*ax;

    const r02 = t*ax*az + s*ay;
    const r12 = t*ay*az - s*ax;
    const r22 = t*az*az + c;

    // Translation: T(pivot) * R * T(-pivot) => col 3 = pivot - R*pivot
    const tx = px - (r00*px + r01*py + r02*pz);
    const ty = py - (r10*px + r11*py + r12*pz);
    const tz = pz - (r20*px + r21*py + r22*pz);

    dst[ 0] = r00; dst[ 1] = r10; dst[ 2] = r20; dst[ 3] = 0;
    dst[ 4] = r01; dst[ 5] = r11; dst[ 6] = r21; dst[ 7] = 0;
    dst[ 8] = r02; dst[ 9] = r12; dst[10] = r22; dst[11] = 0;
    dst[12] = tx;  dst[13] = ty;  dst[14] = tz;  dst[15] = 1;
}

// Multiply: result = A * B (column-major, 16-element flat arrays).
// Safe to call with result === A or result === B (uses temp).
function mul4x4(result, A, B) {
    // Unrolled column-major mat4 multiply.
    const a00 = A[0], a01 = A[4], a02 = A[8],  a03 = A[12];
    const a10 = A[1], a11 = A[5], a12 = A[9],  a13 = A[13];
    const a20 = A[2], a21 = A[6], a22 = A[10], a23 = A[14];
    const a30 = A[3], a31 = A[7], a32 = A[11], a33 = A[15];

    const b00 = B[0], b01 = B[4], b02 = B[8],  b03 = B[12];
    const b10 = B[1], b11 = B[5], b12 = B[9],  b13 = B[13];
    const b20 = B[2], b21 = B[6], b22 = B[10], b23 = B[14];
    const b30 = B[3], b31 = B[7], b32 = B[11], b33 = B[15];

    result[ 0] = a00*b00 + a01*b10 + a02*b20 + a03*b30;
    result[ 1] = a10*b00 + a11*b10 + a12*b20 + a13*b30;
    result[ 2] = a20*b00 + a21*b10 + a22*b20 + a23*b30;
    result[ 3] = a30*b00 + a31*b10 + a32*b20 + a33*b30;

    result[ 4] = a00*b01 + a01*b11 + a02*b21 + a03*b31;
    result[ 5] = a10*b01 + a11*b11 + a12*b21 + a13*b31;
    result[ 6] = a20*b01 + a21*b11 + a22*b21 + a23*b31;
    result[ 7] = a30*b01 + a31*b11 + a32*b21 + a33*b31;

    result[ 8] = a00*b02 + a01*b12 + a02*b22 + a03*b32;
    result[ 9] = a10*b02 + a11*b12 + a12*b22 + a13*b32;
    result[10] = a20*b02 + a21*b12 + a22*b22 + a23*b32;
    result[11] = a30*b02 + a31*b12 + a32*b22 + a33*b32;

    result[12] = a00*b03 + a01*b13 + a02*b23 + a03*b33;
    result[13] = a10*b03 + a11*b13 + a12*b23 + a13*b33;
    result[14] = a20*b03 + a21*b13 + a22*b23 + a23*b33;
    result[15] = a30*b03 + a31*b13 + a32*b23 + a33*b33;
}

// ---------------------------------------------------------------------------
// Wind formula constants (mirrors §2.3 Decision 4 formula)
// ---------------------------------------------------------------------------
// Per-bone rotation amplitudes are in RADIANS and COMPOSE down the hierarchy
// (trunk→branch→twig angles stack), so they must be small — the canonical
// SpeedTree / GPU Gems wind uses a few degrees per level. The old values
// (0.6 / 0.4 rad ≈ 57° peak per bone) accumulated into the whole canopy folding
// over. These give ~3–4° per bone at strength 1.0 → a gentle compounded sway.
const A1 = 0.06;  // primary gust amplitude (rad) ≈ 3.4° per bone
const A2 = 0.03;  // turbulence amplitude (rad) ≈ 1.7° per bone
const F1 = 1.2;   // primary frequency (rad/s)
const F2 = 2.73;  // turbulence frequency (irrational ratio to F1)

// ---------------------------------------------------------------------------
// createWindSolver
// ---------------------------------------------------------------------------

/**
 * @param {object} bones_wind  — the bones_wind table from buildBranchGeometry (§2.1)
 *   {
 *     count:       number,
 *     parent:      Int32Array(count),
 *     pivot:       Float32Array(3*count),
 *     stiffness:   Float32Array(count),
 *     isRigid:     Uint8Array(count),
 *   }
 * @returns {{ boneCount: number, solve: function }}
 */
export function createWindSolver(bones_wind) {
    const { count, parent, pivot, stiffness, isRigid } = bones_wind;

    // Assert parent ordering: parents always precede children (precondition for top-down loop).
    for (let c = 0; c < count; c++) {
        const p = parent[c];
        if (p !== -1) {
            if (p >= c) {
                throw new Error(
                    `windSolver: bones_wind.parent[${c}]=${p} violates parent < child ordering`
                );
            }
        }
    }

    // Pre-compute per-bone phases (deterministic, from index + pivot coords).
    const phases = new Float64Array(count);
    for (let c = 0; c < count; c++) {
        const px = pivot[c * 3 + 0];
        const py = pivot[c * 3 + 1];
        const pz = pivot[c * 3 + 2];
        phases[c] = bonePhase(c, px, py, pz);
    }

    // Scratch buffers for the composition loop (avoids per-frame allocation).
    // Each entry: one mat4 in Float64 precision.
    const worldMats = new Float64Array(count * 16); // composed world matrices
    const localMat  = new Float64Array(16);          // local pivot-rotation scratch

    return {
        boneCount: count,

        /**
         * solve(out, time, windStrength, windDirX, windDirZ)
         *
         * Writes one mat4 (16 floats, column-major) per bone into `out`.
         * `out` must be Float32Array of length >= count * 16.
         *
         * windDirX / windDirZ: horizontal wind direction components (need not be normalised;
         *   they define the direction the wind blows along XZ; the rotation axis is ⟂ this).
         *
         * When windStrength === 0, every matrix is identity.
         */
        solve(out, time, windStrength, windDirX, windDirZ) {
            // Normalise wind direction in XZ plane.
            // Rotation axis = cross(up, windDir) = (windDirZ, 0, -windDirX) (up = Y).
            // This is the horizontal axis perpendicular to the wind, so branches bend *downwind*.
            let ax = windDirZ;
            let ay = 0;
            let az = -windDirX;
            const len = Math.sqrt(ax * ax + az * az);
            if (len > 1e-9) {
                ax /= len;
                az /= len;
            } else {
                // Degenerate wind dir — default axis is X.
                ax = 1; az = 0;
            }

            // Top-down composition: parent[c] < c guaranteed, so ascending index order suffices.
            for (let c = 0; c < count; c++) {
                const p = parent[c];
                const wOff = c * 16;   // offset into worldMats for bone c
                const px = pivot[c * 3 + 0];
                const py = pivot[c * 3 + 1];
                const pz = pivot[c * 3 + 2];

                // Compute local rotation angle for this bone.
                let angle = 0;
                if (windStrength !== 0 && isRigid[c] !== 1) {
                    const ph = phases[c];
                    const s = stiffness[c];
                    angle = windStrength * s * (
                        A1 * Math.sin(time * F1 + ph) +
                        A2 * Math.sin(time * F2 + ph * 2.17 + 1.3)
                    );
                }

                if (angle === 0) {
                    // Local matrix is identity → world matrix = parent world matrix (or identity).
                    if (p === -1) {
                        setIdentity(worldMats, wOff);
                    } else {
                        // Copy parent world matrix.
                        const pOff = p * 16;
                        for (let i = 0; i < 16; i++) {
                            worldMats[wOff + i] = worldMats[pOff + i];
                        }
                    }
                } else {
                    // Build local pivot-rotation matrix.
                    buildPivotRotation(localMat, ax, ay, az, angle, px, py, pz);

                    if (p === -1) {
                        // Root bone: world = local.
                        for (let i = 0; i < 16; i++) {
                            worldMats[wOff + i] = localMat[i];
                        }
                    } else {
                        // world_c = world_parent * local_c
                        mul4x4(worldMats.subarray(wOff, wOff + 16),
                               worldMats.subarray(p * 16, p * 16 + 16),
                               localMat);
                    }
                }

                // Write Float32 output.
                const oOff = c * 16;
                for (let i = 0; i < 16; i++) {
                    out[oOff + i] = worldMats[wOff + i];
                }
            }
        },
    };
}
