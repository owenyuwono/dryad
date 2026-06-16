// test/windSolver.test.mjs
// Unit tests for src/windSolver.js — pure JS, no Three.js.
// Run with: node --test test/windSolver.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createWindSolver } from '../src/windSolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDENTITY_MAT4 = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
];

function isIdentity(mat4Slice, eps = 1e-5) {
    for (let i = 0; i < 16; i++) {
        const expected = IDENTITY_MAT4[i];
        if (Math.abs(mat4Slice[i] - expected) > eps) return false;
    }
    return true;
}

function hasNoNaN(arr) {
    for (let i = 0; i < arr.length; i++) {
        if (!isFinite(arr[i])) return false;
    }
    return true;
}

// Build a minimal bones_wind for N bones in a linear chain: 0 <- 1 <- 2 <- ...
// pivots are spaced along the Y axis so each bone's pivot is above the previous.
function makeLinearChain(n, pivotSpacing = 1.0) {
    const parent     = new Int32Array(n);
    const pivot      = new Float32Array(n * 3);
    const stiffness  = new Float32Array(n);
    const branchLevel = new Int32Array(n);
    const isRigid    = new Uint8Array(n);
    const axisHint   = new Float32Array(n * 3);

    parent[0] = -1; // root
    for (let c = 1; c < n; c++) parent[c] = c - 1;

    for (let c = 0; c < n; c++) {
        pivot[c * 3 + 0] = 0;
        pivot[c * 3 + 1] = c * pivotSpacing;
        pivot[c * 3 + 2] = 0;
        stiffness[c]  = 1.0;   // fully flexible
        branchLevel[c] = c;
        isRigid[c]    = 0;
        axisHint[c * 3 + 1] = 1; // unit Y
    }

    return { count: n, parent, pivot, stiffness, branchLevel, isRigid, axisHint };
}

// Make a 3-bone chain: root (rigid/stiff=0), mid, tip.
// root: isRigid=1, stiffness=0
// mid and tip: stiffness=1
function makeTreeChain() {
    const n = 3;
    const parent     = new Int32Array([-1, 0, 1]);
    const pivot      = new Float32Array([
        0, 0, 0,   // root pivot at origin
        0, 1, 0,   // mid pivot 1m up
        0, 2, 0,   // tip pivot 2m up
    ]);
    const stiffness  = new Float32Array([0, 1, 1]);
    const branchLevel = new Int32Array([0, 1, 2]);
    const isRigid    = new Uint8Array([1, 0, 0]);
    const axisHint   = new Float32Array(n * 3);
    return { count: n, parent, pivot, stiffness, branchLevel, isRigid, axisHint };
}

// Apply a mat4 (column-major, Float32) to a point [x,y,z] → [x',y',z'].
function applyMat4(m, x, y, z) {
    return [
        m[0]*x + m[4]*y + m[ 8]*z + m[12],
        m[1]*x + m[5]*y + m[ 9]*z + m[13],
        m[2]*x + m[6]*y + m[10]*z + m[14],
    ];
}

function dist3(a, b) {
    const dx = a[0]-b[0], dy = a[1]-b[1], dz = a[2]-b[2];
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('windSolver — strength=0 identity guarantee', () => {
    it('all bone matrices are identity when windStrength === 0', () => {
        const bones = makeLinearChain(5);
        const solver = createWindSolver(bones);
        const out = new Float32Array(bones.count * 16);

        solver.solve(out, 0.0, 0.0, 1.0, 0.0);

        for (let c = 0; c < bones.count; c++) {
            const slice = out.subarray(c * 16, c * 16 + 16);
            assert.ok(isIdentity(slice),
                `bone ${c} should be identity at strength=0, got [${slice}]`);
        }
    });

    it('all bone matrices are identity at any time when strength === 0', () => {
        const bones = makeLinearChain(4);
        const solver = createWindSolver(bones);
        const out = new Float32Array(bones.count * 16);

        for (const t of [0, 0.5, 1.0, 100.0, 999.9]) {
            solver.solve(out, t, 0.0, 1.0, 0.0);
            for (let c = 0; c < bones.count; c++) {
                const slice = out.subarray(c * 16, c * 16 + 16);
                assert.ok(isIdentity(slice),
                    `bone ${c} at t=${t} should be identity at strength=0`);
            }
        }
    });
});

describe('windSolver — determinism', () => {
    it('same (bones, time, strength, dir) produces byte-identical output', () => {
        const bones = makeLinearChain(6);
        const solver = createWindSolver(bones);
        const outA = new Float32Array(bones.count * 16);
        const outB = new Float32Array(bones.count * 16);

        solver.solve(outA, 3.7, 0.8, 0.707, 0.707);
        solver.solve(outB, 3.7, 0.8, 0.707, 0.707);

        assert.deepStrictEqual(outA, outB, 'two solves with identical args must be byte-identical');
    });

    it('different times produce different matrices (solver is animated)', () => {
        const bones = makeLinearChain(3);
        const solver = createWindSolver(bones);
        const outA = new Float32Array(bones.count * 16);
        const outB = new Float32Array(bones.count * 16);

        solver.solve(outA, 1.0, 1.0, 1.0, 0.0);
        solver.solve(outB, 2.0, 1.0, 1.0, 0.0);

        // At least one flexible bone must differ.
        let differs = false;
        for (let i = 0; i < outA.length; i++) {
            if (outA[i] !== outB[i]) { differs = true; break; }
        }
        assert.ok(differs, 'different times should produce different bone matrices');
    });
});

describe('windSolver — rigid bones', () => {
    it('rigid bone (isRigid=1) stays identity regardless of strength', () => {
        const bones = makeTreeChain(); // bone 0 is rigid
        const solver = createWindSolver(bones);
        const out = new Float32Array(bones.count * 16);

        solver.solve(out, 5.0, 2.0, 1.0, 0.0);

        const rootSlice = out.subarray(0, 16);
        assert.ok(isIdentity(rootSlice, 1e-5),
            `rigid root bone must remain identity; got [${rootSlice}]`);
    });

    it('non-rigid bones rotate when strength > 0', () => {
        const bones = makeTreeChain(); // bones 1,2 are flexible
        const solver = createWindSolver(bones);
        const out = new Float32Array(bones.count * 16);

        solver.solve(out, 0.25, 1.0, 1.0, 0.0); // t chosen so sin values are non-zero

        // At least one of mid/tip should differ from identity.
        const midIdentity = isIdentity(out.subarray(16, 32));
        const tipIdentity = isIdentity(out.subarray(32, 48));
        // They might both happen to be identity at t=0.25 if the sin phases cancel —
        // but with two different bones and irrational frequency ratio this is astronomically unlikely.
        // Verify by checking multiple times.
        let anyNonIdentity = !midIdentity || !tipIdentity;
        if (!anyNonIdentity) {
            for (const t of [0.1, 0.3, 0.7, 1.1, 2.3]) {
                solver.solve(out, t, 1.0, 1.0, 0.0);
                if (!isIdentity(out.subarray(16, 32)) || !isIdentity(out.subarray(32, 48))) {
                    anyNonIdentity = true;
                    break;
                }
            }
        }
        assert.ok(anyNonIdentity, 'non-rigid bones should rotate with nonzero strength');
    });
});

describe('windSolver — hierarchical composition (trunk→branch→twig)', () => {
    it('child world displacement grows larger than parent (cumulative bending)', () => {
        // 3-bone flexible chain: all stiffness=1, isRigid=0.
        // root at origin, mid at Y=1, tip at Y=2.
        // With wind blowing along Z (axis = X), each bone bends further.
        // The tip (bone 2) must be displaced more than the mid (bone 1).
        const n = 3;
        const parent     = new Int32Array([-1, 0, 1]);
        const pivot      = new Float32Array([0,0,0,  0,1,0,  0,2,0]);
        const stiffness  = new Float32Array([1, 1, 1]);
        const branchLevel = new Int32Array([0, 1, 2]);
        const isRigid    = new Uint8Array([0, 0, 0]);
        const axisHint   = new Float32Array(n * 3);
        const bones = { count: n, parent, pivot, stiffness, branchLevel, isRigid, axisHint };

        const solver = createWindSolver(bones);
        const out = new Float32Array(n * 16);

        // Use a time that gives significant rotation.
        // Try multiple times until we get a measurable angle.
        let rootDisp = 0, midDisp = 0, tipDisp = 0;
        const testPoint = [0, 0.5, 0]; // a point slightly above each pivot

        for (const t of [0.1, 0.3, 0.7, 1.2, 2.1]) {
            solver.solve(out, t, 1.0, 0.0, 1.0); // windDir = Z

            // Apply each bone's world matrix to the point *above* its pivot.
            // Measure displacement from rest (= point itself in world space).
            const rootPivot = [0, 0, 0];
            const rootPoint = [rootPivot[0], rootPivot[1] + 0.5, rootPivot[2]];
            const transformedRoot = applyMat4(out.subarray(0, 16), ...rootPoint);
            rootDisp = dist3(rootPoint, transformedRoot);

            const midPivot = [0, 1, 0];
            const midPoint = [midPivot[0], midPivot[1] + 0.5, midPivot[2]];
            const transformedMid = applyMat4(out.subarray(16, 32), ...midPoint);
            midDisp = dist3(midPoint, transformedMid);

            const tipPivot = [0, 2, 0];
            const tipPoint = [tipPivot[0], tipPivot[1] + 0.5, tipPivot[2]];
            const transformedTip = applyMat4(out.subarray(32, 48), ...tipPoint);
            tipDisp = dist3(tipPoint, transformedTip);

            if (tipDisp > 0.001) break; // we have a measurable rotation
        }

        // The composed hierarchy means tip > mid >= root (all bend the same local
        // amount, but tip's world matrix is root*mid*tip so the displacements accumulate).
        assert.ok(tipDisp > midDisp,
            `tip displacement (${tipDisp.toFixed(6)}) must exceed mid displacement (${midDisp.toFixed(6)}) — hierarchical composition`);
        assert.ok(midDisp > rootDisp * 0.5 || midDisp > 0.0001,
            `mid should have non-trivial displacement; got midDisp=${midDisp}`);
    });

    it('pivot point itself does not move (rotation is about the pivot)', () => {
        const n = 3;
        const parent     = new Int32Array([-1, 0, 1]);
        const pivot      = new Float32Array([0,0,0,  0,1,0,  0,2,0]);
        const stiffness  = new Float32Array([1, 1, 1]);
        const branchLevel = new Int32Array([0, 1, 2]);
        const isRigid    = new Uint8Array([0, 0, 0]);
        const axisHint   = new Float32Array(n * 3);
        const bones = { count: n, parent, pivot, stiffness, branchLevel, isRigid, axisHint };

        const solver = createWindSolver(bones);
        const out = new Float32Array(n * 16);
        solver.solve(out, 1.0, 1.0, 1.0, 0.0);

        // Bone 0: its own pivot (0,0,0) applied through its own mat should stay near (0,0,0).
        // (It IS the root rotation about (0,0,0) — by definition the pivot stays fixed.)
        const rootPivot = applyMat4(out.subarray(0, 16), 0, 0, 0);
        assert.ok(dist3(rootPivot, [0,0,0]) < 1e-5,
            `bone 0 pivot must be fixed under its own rotation; got ${rootPivot}`);

        // Bone 1: its world matrix is world_0 * local_1 where local_1 rotates about (0,1,0).
        // So the point (0,1,0) in world space should be unchanged.
        // We verify: applyMat4(out[1], pivotOf1) ≈ pivotOf1 + translation from bone 0's rotation.
        // Actually in hierarchical mode the point (0,1,0) is first moved by bone 0,
        // THEN local_1 rotates about (0,1,0) in *local* space relative to bone 0.
        // The correct test: the pivot of bone 1 as seen in the COMPOSED frame equals
        // where bone 0's rotation places it (it doesn't stay at (0,1,0) in world space if bone 0 rotated).
        // What DOES hold: the displacement of the bone-1 pivot under bone-1's OWN local_1 = zero.
        // We test this by noting that applyMat4(world_1, pivot_1) == applyMat4(world_0, pivot_1).
        const p1 = [0, 1, 0];
        const viaWorld1 = applyMat4(out.subarray(16, 32), ...p1);
        const viaWorld0 = applyMat4(out.subarray( 0, 16), ...p1);
        assert.ok(dist3(viaWorld1, viaWorld0) < 1e-5,
            `bone 1's pivot (0,1,0) transformed through world_1 must equal world_0*pivot_1 (local_1 fixes the pivot)`);
    });

    it('world_child = world_parent * local_child (explicit mat4 check)', () => {
        // Minimal 2-bone case: root has a 90° rotation; child has a 45° rotation.
        // We control this by using a custom bones_wind with a specific time and params.
        // Instead of back-solving, we verify the composition relationship directly:
        // world[c] = world[parent[c]] * local[c] where local is what solve would compute.
        // We verify by taking any child bone and checking that:
        //   applying world[child] to a point == applying (world[parent] * local_child) to the point.
        //
        // Since we can't extract local_child from the solver's output without re-deriving,
        // we instead verify a weaker but still composition-proving property:
        // At strength=0 world[c] == world[parent[c]] == identity (already covered).
        // At strength>0, for a chain A->B->C, if we zero-out C's LOCAL rotation (make isRigid=1),
        // then world[C] == world[B].

        const n = 3;
        const parent     = new Int32Array([-1, 0, 1]);
        const pivot      = new Float32Array([0,0,0,  0,1,0,  0,2,0]);
        const stiffness  = new Float32Array([1, 1, 0]); // C rigid via stiffness=0
        const branchLevel = new Int32Array([0, 1, 2]);
        const isRigid    = new Uint8Array([0, 0, 1]); // C is rigid
        const axisHint   = new Float32Array(n * 3);
        const bones = { count: n, parent, pivot, stiffness, branchLevel, isRigid, axisHint };

        const solver = createWindSolver(bones);
        const out = new Float32Array(n * 16);
        solver.solve(out, 1.5, 1.0, 1.0, 0.0);

        // world[2] should equal world[1] (since local_2 = identity for rigid bone 2).
        for (let i = 0; i < 16; i++) {
            assert.ok(Math.abs(out[32 + i] - out[16 + i]) < 1e-5,
                `world[2][${i}] (${out[32+i]}) should equal world[1][${i}] (${out[16+i]}) when bone 2 is rigid`);
        }
    });
});

describe('windSolver — no NaN / Inf', () => {
    it('produces finite values across a battery of (time, strength, dir) inputs', () => {
        const bones = makeLinearChain(8);
        const solver = createWindSolver(bones);
        const out = new Float32Array(bones.count * 16);

        const times     = [0, 0.001, 0.5, 1.0, 10.0, 100.0, 9999.9];
        const strengths = [0, 0.01, 0.5, 1.0, 2.0];
        const dirs      = [[1,0], [0,1], [0.707, 0.707], [-1, 0], [0, -1]];

        for (const t of times) {
            for (const s of strengths) {
                for (const [dx, dz] of dirs) {
                    solver.solve(out, t, s, dx, dz);
                    assert.ok(hasNoNaN(out),
                        `NaN/Inf detected at t=${t}, s=${s}, dir=[${dx},${dz}]`);
                }
            }
        }
    });

    it('handles degenerate wind direction (0,0) without NaN', () => {
        const bones = makeLinearChain(3);
        const solver = createWindSolver(bones);
        const out = new Float32Array(bones.count * 16);

        solver.solve(out, 1.0, 1.0, 0.0, 0.0);
        assert.ok(hasNoNaN(out), 'degenerate wind dir (0,0) must not produce NaN');
    });
});

describe('windSolver — parent ordering assertion', () => {
    it('throws if parent[c] >= c (would violate top-down order)', () => {
        const n = 2;
        const parent     = new Int32Array([1, -1]); // INVALID: parent[0]=1 > 0
        const pivot      = new Float32Array(n * 3);
        const stiffness  = new Float32Array(n);
        const branchLevel = new Int32Array(n);
        const isRigid    = new Uint8Array(n);
        const axisHint   = new Float32Array(n * 3);

        assert.throws(
            () => createWindSolver({ count: n, parent, pivot, stiffness, branchLevel, isRigid, axisHint }),
            /parent.*ordering|parent.*child/i,
            'should throw on invalid parent ordering'
        );
    });
});

describe('windSolver — single bone (trivial case)', () => {
    it('single bone with strength=0 is identity', () => {
        const bones = makeLinearChain(1);
        const solver = createWindSolver(bones);
        const out = new Float32Array(16);
        solver.solve(out, 0, 0, 1, 0);
        assert.ok(isIdentity(out), 'single bone at strength=0 must be identity');
    });

    it('single rigid bone at nonzero strength is still identity', () => {
        const n = 1;
        const bones = {
            count: 1,
            parent: new Int32Array([-1]),
            pivot: new Float32Array([0, 0, 0]),
            stiffness: new Float32Array([1]),
            branchLevel: new Int32Array([0]),
            isRigid: new Uint8Array([1]),
            axisHint: new Float32Array(3),
        };
        const solver = createWindSolver(bones);
        const out = new Float32Array(16);
        solver.solve(out, 5.0, 2.0, 1.0, 0.0);
        assert.ok(isIdentity(out), 'single rigid bone must always be identity');
    });
});
