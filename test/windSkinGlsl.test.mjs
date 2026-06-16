// test/windSkinGlsl.test.mjs
// Unit tests for windSkinGlsl.js — pure JS / GLSL string exports only.
// Mirrors windGlsl.test.mjs patterns per WIND_HIERARCHICAL_PLAN.md §4.
// Run with: node --test test/windSkinGlsl.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    WIND_BONE_UNIFORM_DECLS,
    WIND_BONE_FETCH_GLSL,
    WIND_SKIN_VERTEX_GLSL,
    WIND_LEAF_FOLLOW_GLSL,
    WIND_BONE_UNIFORM_DEFAULTS,
    WIND_TEX_WIDTH,
} from '../src/windSkinGlsl.js';

// ---------------------------------------------------------------------------
// Helper: count balanced braces
// ---------------------------------------------------------------------------
function countBraces(str) {
    const opens  = (str.match(/\{/g) || []).length;
    const closes = (str.match(/\}/g) || []).length;
    return { opens, closes };
}

// ---------------------------------------------------------------------------
// WIND_TEX_WIDTH
// ---------------------------------------------------------------------------
describe('WIND_TEX_WIDTH', () => {
    it('is the number 4', () => {
        assert.equal(WIND_TEX_WIDTH, 4,
            'WIND_TEX_WIDTH must be 4 — RGBA32F texels per bone (one mat4)');
    });
});

// ---------------------------------------------------------------------------
// WIND_BONE_UNIFORM_DECLS
// ---------------------------------------------------------------------------
describe('WIND_BONE_UNIFORM_DECLS', () => {
    it('is a non-empty string', () => {
        assert.equal(typeof WIND_BONE_UNIFORM_DECLS, 'string');
        assert.ok(WIND_BONE_UNIFORM_DECLS.length > 0, 'must not be empty');
    });

    it('declares uBoneTex as uniform sampler2D', () => {
        assert.ok(
            WIND_BONE_UNIFORM_DECLS.includes('uniform sampler2D uBoneTex'),
            'must declare uBoneTex as sampler2D for the bone DataTexture'
        );
    });

    it('declares uBoneCount as uniform float', () => {
        assert.ok(
            WIND_BONE_UNIFORM_DECLS.includes('uniform float uBoneCount'),
            'must declare uBoneCount'
        );
    });

    it('declares uWindStrength as uniform float', () => {
        assert.ok(
            WIND_BONE_UNIFORM_DECLS.includes('uniform float uWindStrength'),
            'must declare uWindStrength'
        );
    });
});

// ---------------------------------------------------------------------------
// WIND_BONE_FETCH_GLSL
// ---------------------------------------------------------------------------
describe('WIND_BONE_FETCH_GLSL', () => {
    it('is a non-empty string', () => {
        assert.equal(typeof WIND_BONE_FETCH_GLSL, 'string');
        assert.ok(WIND_BONE_FETCH_GLSL.length > 0, 'must not be empty');
    });

    it('defines fetchBone function returning mat4', () => {
        assert.ok(
            WIND_BONE_FETCH_GLSL.includes('mat4 fetchBone('),
            'must define fetchBone returning mat4'
        );
    });

    it('uses texelFetch (not texture2D — WebGL2 required)', () => {
        assert.ok(
            WIND_BONE_FETCH_GLSL.includes('texelFetch'),
            'must use texelFetch for WebGL2 exact-integer bone texture addressing'
        );
        assert.ok(
            !WIND_BONE_FETCH_GLSL.includes('texture2D'),
            'must NOT use texture2D — texelFetch is the WebGL2 path'
        );
    });

    it('references uBoneTex', () => {
        assert.ok(
            WIND_BONE_FETCH_GLSL.includes('uBoneTex'),
            'fetchBone must sample uBoneTex'
        );
    });

    it('reads 4 texels per bone (one per mat4 column)', () => {
        // The function must address columns 0, 1, 2, 3 of the same row.
        assert.ok(
            WIND_BONE_FETCH_GLSL.includes('ivec2(0,') || WIND_BONE_FETCH_GLSL.includes('ivec2(0 ,') || WIND_BONE_FETCH_GLSL.includes('ivec2( 0,'),
            'must address texel column 0'
        );
        assert.ok(
            WIND_BONE_FETCH_GLSL.includes('ivec2(1,') || WIND_BONE_FETCH_GLSL.includes('ivec2(1 ,') || WIND_BONE_FETCH_GLSL.includes('ivec2( 1,'),
            'must address texel column 1'
        );
        assert.ok(
            WIND_BONE_FETCH_GLSL.includes('ivec2(2,') || WIND_BONE_FETCH_GLSL.includes('ivec2(2 ,') || WIND_BONE_FETCH_GLSL.includes('ivec2( 2,'),
            'must address texel column 2'
        );
        assert.ok(
            WIND_BONE_FETCH_GLSL.includes('ivec2(3,') || WIND_BONE_FETCH_GLSL.includes('ivec2(3 ,') || WIND_BONE_FETCH_GLSL.includes('ivec2( 3,'),
            'must address texel column 3'
        );
    });

    it('has balanced braces', () => {
        const { opens, closes } = countBraces(WIND_BONE_FETCH_GLSL);
        assert.equal(opens, closes, 'WIND_BONE_FETCH_GLSL must have balanced braces');
    });
});

// ---------------------------------------------------------------------------
// WIND_SKIN_VERTEX_GLSL
// ---------------------------------------------------------------------------
describe('WIND_SKIN_VERTEX_GLSL', () => {
    it('is a non-empty string', () => {
        assert.equal(typeof WIND_SKIN_VERTEX_GLSL, 'string');
        assert.ok(WIND_SKIN_VERTEX_GLSL.length > 0, 'must not be empty');
    });

    it('defines windSkinPosition with frozen signature', () => {
        assert.ok(
            WIND_SKIN_VERTEX_GLSL.includes(
                'vec3 windSkinPosition(vec3 restPos, float boneIdx, float boneFraction, float windWeight)'
            ),
            'must define windSkinPosition with exact frozen signature'
        );
    });

    it('references uWindStrength (calm == rest guarantee)', () => {
        assert.ok(
            WIND_SKIN_VERTEX_GLSL.includes('uWindStrength'),
            'must reference uWindStrength so calm wind (0) returns exact rest position'
        );
    });

    it('references uBoneTex (via fetchBone or directly)', () => {
        const combined = WIND_SKIN_VERTEX_GLSL + WIND_BONE_FETCH_GLSL;
        assert.ok(
            combined.includes('uBoneTex'),
            'skin pipeline must reference uBoneTex'
        );
    });

    it('applies the composed bone matrix to restPos (pure skinning)', () => {
        // Pure composed skinning: the bone matrix (T*R*T^-1 composed top-down)
        // is applied directly to restPos. The old boneFraction/windWeight linear
        // blend toward rest was removed — it fought the hierarchical composition
        // and caused the exploding-spikes artifact.
        assert.ok(
            WIND_SKIN_VERTEX_GLSL.includes('boneMat * vec4(restPos'),
            'must apply the composed bone matrix directly to restPos'
        );
        assert.ok(
            !WIND_SKIN_VERTEX_GLSL.includes('mix('),
            'must NOT blend toward rest with mix() (breaks hierarchical follow-through)'
        );
    });

    it('is gated by uWindStrength for the calm guarantee', () => {
        assert.ok(
            WIND_SKIN_VERTEX_GLSL.includes('uWindStrength == 0.0') &&
            WIND_SKIN_VERTEX_GLSL.includes('return restPos'),
            'must return restPos exactly when wind is off'
        );
    });

    it('has balanced braces', () => {
        const { opens, closes } = countBraces(WIND_SKIN_VERTEX_GLSL);
        assert.equal(opens, closes, 'WIND_SKIN_VERTEX_GLSL must have balanced braces');
    });

    it('returns a vec3', () => {
        assert.ok(
            WIND_SKIN_VERTEX_GLSL.includes('vec3 windSkinPosition'),
            'return type must be vec3'
        );
        assert.ok(
            WIND_SKIN_VERTEX_GLSL.includes('return'),
            'must have a return statement'
        );
    });
});

// ---------------------------------------------------------------------------
// WIND_LEAF_FOLLOW_GLSL
// ---------------------------------------------------------------------------
describe('WIND_LEAF_FOLLOW_GLSL', () => {
    it('is a non-empty string', () => {
        assert.equal(typeof WIND_LEAF_FOLLOW_GLSL, 'string');
        assert.ok(WIND_LEAF_FOLLOW_GLSL.length > 0, 'must not be empty');
    });

    it('defines windBoneFollowDelta function', () => {
        assert.ok(
            WIND_LEAF_FOLLOW_GLSL.includes('windBoneFollowDelta('),
            'must define windBoneFollowDelta'
        );
    });

    it('returns a vec3', () => {
        assert.ok(
            WIND_LEAF_FOLLOW_GLSL.includes('vec3 windBoneFollowDelta'),
            'return type must be vec3'
        );
        assert.ok(
            WIND_LEAF_FOLLOW_GLSL.includes('return'),
            'must have a return statement'
        );
    });

    it('uses fetchBone (via boneIdx parameter)', () => {
        assert.ok(
            WIND_LEAF_FOLLOW_GLSL.includes('fetchBone('),
            'must call fetchBone to get the bone matrix'
        );
    });

    it('has balanced braces', () => {
        const { opens, closes } = countBraces(WIND_LEAF_FOLLOW_GLSL);
        assert.equal(opens, closes, 'WIND_LEAF_FOLLOW_GLSL must have balanced braces');
    });
});

// ---------------------------------------------------------------------------
// WIND_BONE_UNIFORM_DEFAULTS
// ---------------------------------------------------------------------------
describe('WIND_BONE_UNIFORM_DEFAULTS', () => {
    it('is a plain object', () => {
        assert.equal(typeof WIND_BONE_UNIFORM_DEFAULTS, 'object');
        assert.ok(WIND_BONE_UNIFORM_DEFAULTS !== null);
    });

    it('has uBoneCount defaulting to 0', () => {
        assert.equal(WIND_BONE_UNIFORM_DEFAULTS.uBoneCount, 0,
            'uBoneCount=0 means no bones allocated yet');
    });

    it('has uWindStrength defaulting to 0 (calm)', () => {
        assert.equal(WIND_BONE_UNIFORM_DEFAULTS.uWindStrength, 0,
            'uWindStrength=0 means calm — no displacement on load');
    });

    it('has no Three.js objects (dependency-free)', () => {
        for (const [key, val] of Object.entries(WIND_BONE_UNIFORM_DEFAULTS)) {
            assert.ok(
                val === null
                    || typeof val !== 'object'
                    || Array.isArray(val)
                    || val.isVector2 === undefined,
                `${key} must not be a Three.js object — windSkinGlsl.js must remain dependency-free`
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Cross-module: strings can be concatenated for injection without backtick clash
// ---------------------------------------------------------------------------
describe('string safety', () => {
    it('no GLSL string contains template-literal backticks that would break JS string', () => {
        // Backticks inside /* glsl */`...` would prematurely close the template literal.
        // This has caused broken shaders in this repo before.
        for (const [name, str] of [
            ['WIND_BONE_UNIFORM_DECLS', WIND_BONE_UNIFORM_DECLS],
            ['WIND_BONE_FETCH_GLSL', WIND_BONE_FETCH_GLSL],
            ['WIND_SKIN_VERTEX_GLSL', WIND_SKIN_VERTEX_GLSL],
            ['WIND_LEAF_FOLLOW_GLSL', WIND_LEAF_FOLLOW_GLSL],
        ]) {
            assert.ok(
                !str.includes('`'),
                `${name} must not contain backticks — they close the JS template literal`
            );
        }
    });
});
