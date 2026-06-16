// test/windGlsl.test.mjs
// Unit tests for windGlsl.js — pure JS / GLSL string exports only.
// Run with: node --test test/windGlsl.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    WIND_UNIFORM_DECLS,
    WIND_FUNCTION_GLSL,
    WIND_UNIFORM_DEFAULTS,
} from '../src/windGlsl.js';

describe('WIND_UNIFORM_DECLS', () => {
    it('is a non-empty string', () => {
        assert.equal(typeof WIND_UNIFORM_DECLS, 'string');
        assert.ok(WIND_UNIFORM_DECLS.length > 0, 'WIND_UNIFORM_DECLS must not be empty');
    });

    it('declares uTime as uniform float', () => {
        assert.ok(WIND_UNIFORM_DECLS.includes('uniform float uTime'),
            'must declare uTime');
    });

    it('declares uWindStrength as uniform float', () => {
        assert.ok(WIND_UNIFORM_DECLS.includes('uniform float uWindStrength'),
            'must declare uWindStrength');
    });

    it('declares uWindDir as uniform vec2', () => {
        assert.ok(WIND_UNIFORM_DECLS.includes('uniform vec2') && WIND_UNIFORM_DECLS.includes('uWindDir'),
            'must declare uWindDir as vec2');
    });
});

describe('WIND_FUNCTION_GLSL', () => {
    it('is a non-empty string', () => {
        assert.equal(typeof WIND_FUNCTION_GLSL, 'string');
        assert.ok(WIND_FUNCTION_GLSL.length > 0, 'WIND_FUNCTION_GLSL must not be empty');
    });

    it('defines windOffset with correct signature', () => {
        assert.ok(
            WIND_FUNCTION_GLSL.includes('vec3 windOffset(vec3 worldPos, float swayFactor)'),
            'must define windOffset(vec3 worldPos, float swayFactor) returning vec3'
        );
    });

    it('uses uWindStrength (so strength=0 → no movement)', () => {
        assert.ok(WIND_FUNCTION_GLSL.includes('uWindStrength'),
            'must reference uWindStrength so calm wind (0) produces zero displacement');
    });

    it('uses uWindDir', () => {
        assert.ok(WIND_FUNCTION_GLSL.includes('uWindDir'),
            'must reference uWindDir for directional sway');
    });

    it('uses uTime', () => {
        assert.ok(WIND_FUNCTION_GLSL.includes('uTime'),
            'must reference uTime for animated traveling gust');
    });

    it('returns a vec3', () => {
        assert.ok(WIND_FUNCTION_GLSL.includes('return'),
            'function must have a return statement');
        // The return type in the signature
        assert.ok(WIND_FUNCTION_GLSL.includes('vec3 windOffset'),
            'return type must be vec3');
    });

    it('has balanced braces', () => {
        const opens  = (WIND_FUNCTION_GLSL.match(/\{/g) || []).length;
        const closes = (WIND_FUNCTION_GLSL.match(/\}/g) || []).length;
        assert.equal(opens, closes, 'WIND_FUNCTION_GLSL must have balanced braces');
    });
});

describe('WIND_UNIFORM_DEFAULTS', () => {
    it('is a plain object', () => {
        assert.equal(typeof WIND_UNIFORM_DEFAULTS, 'object');
        assert.ok(WIND_UNIFORM_DEFAULTS !== null);
    });

    it('has uTime defaulting to 0', () => {
        assert.equal(WIND_UNIFORM_DEFAULTS.uTime, 0);
    });

    it('has uWindStrength defaulting to 0 (calm)', () => {
        assert.equal(WIND_UNIFORM_DEFAULTS.uWindStrength, 0,
            'uWindStrength=0 means calm — no displacement on load');
    });

    it('has uWindDir as a 2-element array', () => {
        assert.ok(Array.isArray(WIND_UNIFORM_DEFAULTS.uWindDir),
            'uWindDir must be an array (no Three.js dependency)');
        assert.equal(WIND_UNIFORM_DEFAULTS.uWindDir.length, 2,
            'uWindDir must have exactly 2 components [x, z]');
    });

    it('has no Three.js objects (dependency-free)', () => {
        // If any value were a THREE.Vector2, it would have .isVector2 === true.
        for (const [key, val] of Object.entries(WIND_UNIFORM_DEFAULTS)) {
            assert.ok(
                val === null || typeof val !== 'object' || Array.isArray(val) || val.isVector2 === undefined,
                `${key} must not be a Three.js object — windGlsl.js must remain dependency-free`
            );
        }
    });
});
