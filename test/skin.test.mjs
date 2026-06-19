import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skin } from '../src/skin.js';

// ---------------------------------------------------------------------------
// Minimal graph factory
// ---------------------------------------------------------------------------

function makeNode(pos, radius, opts = {}) {
  return { pos, radius, ...opts };
}

/**
 * Build a minimal graph with:
 *   node 0 (root): non-terminal
 *   node 1 (mid):  non-terminal
 *   node 2 (tip):  terminal (isTerminal=true, flatNormal, flat)
 * Bones: [0→1 (stem), 1→2 (terminal)]
 */
function makeGraph() {
  const nodes = [
    makeNode([0, 0, 0], 0.3),                                      // 0: root
    makeNode([0, 1, 0], 0.2),                                      // 1: stem
    makeNode([0, 2, 0], 0.1, {                                     // 2: terminal
      isTerminal: true,
      flatNormal: [1, 0, 0],
      flat: 0.5
    }),
  ];
  const bones = [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
  ];
  return { nodes, bones };
}

const envelope = { biochem: 'carbon' };

// ---------------------------------------------------------------------------
// Helper: get boneFlatData.w for bone index i
// ---------------------------------------------------------------------------
function getFlatW(result, i) {
  return result.boneFlatData[i * 4 + 3];
}

function getFlatNormal(result, i) {
  const base = i * 4;
  return [
    result.boneFlatData[base],
    result.boneFlatData[base + 1],
    result.boneFlatData[base + 2],
  ];
}

// ---------------------------------------------------------------------------
// flatten is always 0 — foliage moved to instanced mesh cards
// ---------------------------------------------------------------------------

test('terminal flatten is always 0 regardless of appendageBreadth', () => {
  const graph = makeGraph();
  // bone index 1 is the terminal bone (b=node2)
  for (const breadth of [0, 0.1, 0.5, 0.9, 1.0]) {
    const genome = { appendageBreadth: breadth, leafSize: 1, leafDensity: 1 };
    const fw = getFlatW(skin(graph, envelope, genome), 1);
    assert.strictEqual(fw, 0, `expected 0 for appendageBreadth=${breadth}, got ${fw}`);
  }
});

test('terminal flatNormal xyz comes from node.flatNormal', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 0.5, leafSize: 1, leafDensity: 1 };
  const result = skin(graph, envelope, genome);
  const fn = getFlatNormal(result, 1);
  // node 2 has flatNormal [1,0,0]
  assert.deepStrictEqual(fn, [1, 0, 0]);
});

// ---------------------------------------------------------------------------
// Non-terminal bones: flatten=0, normal=[0,1,0]
// ---------------------------------------------------------------------------

test('non-terminal bone: flatten=0 and normal=[0,1,0]', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 1, leafSize: 1, leafDensity: 1 };
  const result = skin(graph, envelope, genome);
  // bone 0 is stem (b=node1, not terminal)
  assert.strictEqual(getFlatW(result, 0), 0);
  assert.deepStrictEqual(getFlatNormal(result, 0), [0, 1, 0]);
});

// ---------------------------------------------------------------------------
// leafSize flows through genome fields but does not affect flatten
// (leafDensity was removed — folded into the single appendageDensity gene)
// ---------------------------------------------------------------------------

test('leafSize is present in return value (flows to foliage system)', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 1, leafSize: 1.3 };
  const result = skin(graph, envelope, genome);
  // flatten is 0 regardless of leaf genes
  assert.strictEqual(getFlatW(result, 1), 0);
  // leafSize still returned for downstream foliage mesh system
  assert.strictEqual(result.leafSize, 1.3);
});

// ---------------------------------------------------------------------------
// New surface-relief scalars
// ---------------------------------------------------------------------------

test('uRibbing/uSpininess/uSegmentation present and match genome', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 0.5, ribbing: 0.3, spininess: 0.7, segmentation: 0.2 };
  const result = skin(graph, envelope, genome);
  assert.strictEqual(result.uRibbing, 0.3);
  assert.strictEqual(result.uSpininess, 0.7);
  assert.strictEqual(result.uSegmentation, 0.2);
});

test('uRibbing/uSpininess/uSegmentation default to 0 when genome is null', () => {
  const graph = makeGraph();
  const result = skin(graph, envelope);
  assert.strictEqual(result.uRibbing, 0);
  assert.strictEqual(result.uSpininess, 0);
  assert.strictEqual(result.uSegmentation, 0);
});

test('uRibbing/uSpininess/uSegmentation default to 0 when genome omits them', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 0.5 };
  const result = skin(graph, envelope, genome);
  assert.strictEqual(result.uRibbing, 0);
  assert.strictEqual(result.uSpininess, 0);
  assert.strictEqual(result.uSegmentation, 0);
});

// ---------------------------------------------------------------------------
// boneAData / boneBData layout unchanged
// ---------------------------------------------------------------------------

test('boneAData/boneBData pack xyz=pos w=radius correctly', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 0.5, leafSize: 1, leafDensity: 1 };
  const result = skin(graph, envelope, genome);

  // bone 0: a=node0, b=node1 (non-terminal)
  assert.deepStrictEqual(result.boneAData.slice(0, 4), [0, 0, 0, 0.3]);
  assert.deepStrictEqual(result.boneBData.slice(0, 4), [0, 1, 0, 0.2]);

  // bone 1: a=node1, b=node2 (terminal, leafSizeMul=1 → radiusB unchanged)
  assert.deepStrictEqual(result.boneAData.slice(4, 8), [0, 1, 0, 0.2]);
  assert.deepStrictEqual(result.boneBData.slice(4, 8), [0, 2, 0, 0.1]);
});

test('leafSizeMul scales terminal radiusB', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 0.5, leafSize: 2, leafDensity: 1 };
  const result = skin(graph, envelope, genome);
  // bone 1 terminal: node2.radius=0.1 * leafSize=2 = 0.2
  assert.ok(Math.abs(result.boneBData[7] - 0.2) < 1e-9, `expected 0.2, got ${result.boneBData[7]}`);
});

// ---------------------------------------------------------------------------
// boneCount and 64-cap
// ---------------------------------------------------------------------------

test('boneCount = min(bones.length, 64)', () => {
  const graph = makeGraph();
  const result = skin(graph, envelope);
  assert.strictEqual(result.boneCount, 2);
});

test('boneCount capped at 64 and arrays always length 256 (64*4)', () => {
  // Build a graph with 70 bones → count must be capped at 64
  const nodes = [];
  const bones = [];
  for (let i = 0; i <= 70; i++) {
    nodes.push(makeNode([0, i, 0], 0.1));
  }
  for (let i = 0; i < 70; i++) {
    bones.push({ a: i, b: i + 1 });
  }
  const graph = { nodes, bones };
  const result = skin(graph, envelope);
  assert.strictEqual(result.boneCount, 64);
  assert.strictEqual(result.boneAData.length, 256);
  assert.strictEqual(result.boneBData.length, 256);
  assert.strictEqual(result.boneFlatData.length, 256);
});

test('padding entries use degenerate capsule sentinel', () => {
  const graph = makeGraph(); // 2 bones → indices 2..63 are padding
  const result = skin(graph, envelope);
  // padding bone at index 2
  assert.deepStrictEqual(result.boneAData.slice(8, 12), [0, -9999, 0, 0.001]);
  assert.deepStrictEqual(result.boneBData.slice(8, 12), [0, -9999, 0, 0.001]);
  assert.deepStrictEqual(result.boneFlatData.slice(8, 12), [0, 1, 0, 0]);
});

// ---------------------------------------------------------------------------
// 2-arg legacy path: byte-identical boneAData/boneBData/boneFlatData
// ---------------------------------------------------------------------------

test('2-arg path is byte-identical to genome=null path for core arrays', () => {
  // Build a graph where node 2 has legacy flat/flatNormal (old skeleton style)
  const nodes = [
    makeNode([0, 0, 0], 0.3),
    makeNode([0, 1, 0], 0.2),
    makeNode([0, 2, 0], 0.1, {
      isTerminal: true,
      flatNormal: [0, 0, 1],
      flat: 0.6
    }),
  ];
  const bones = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
  const graph = { nodes, bones };

  const r2arg   = skin(graph, envelope);
  const rnull   = skin(graph, envelope, null);

  assert.deepStrictEqual(r2arg.boneAData,   rnull.boneAData);
  assert.deepStrictEqual(r2arg.boneBData,   rnull.boneBData);
  assert.deepStrictEqual(r2arg.boneFlatData, rnull.boneFlatData);
  assert.strictEqual(r2arg.boneCount, rnull.boneCount);
});

test('legacy path: terminal flatten is 0 (no longer uses skeleton flat value)', () => {
  const nodes = [
    makeNode([0, 0, 0], 0.3),
    makeNode([0, 1, 0], 0.2),
    makeNode([0, 2, 0], 0.1, {
      isTerminal: true,
      flatNormal: [0, 0, 1],
      flat: 0.6  // nb.flat present but no longer applied — foliage is mesh cards
    }),
  ];
  const bones = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
  const graph = { nodes, bones };

  const result = skin(graph, envelope);
  assert.strictEqual(getFlatW(result, 1), 0);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('skin is deterministic (deep-equal on repeat)', () => {
  const graph = makeGraph();
  const genome = { appendageBreadth: 0.42, leafSize: 1.2, leafDensity: 0.8, ribbing: 0.1, spininess: 0.9, segmentation: 0.5 };
  const r1 = skin(graph, envelope, genome);
  const r2 = skin(graph, envelope, genome);
  assert.deepStrictEqual(r1.boneAData,    r2.boneAData);
  assert.deepStrictEqual(r1.boneBData,    r2.boneBData);
  assert.deepStrictEqual(r1.boneFlatData, r2.boneFlatData);
  assert.strictEqual(r1.uRibbing,        r2.uRibbing);
  assert.strictEqual(r1.uSpininess,      r2.uSpininess);
  assert.strictEqual(r1.uSegmentation,   r2.uSegmentation);
  assert.strictEqual(r1.boneCount,       r2.boneCount);
});

// ---------------------------------------------------------------------------
// blendK / materialMode unchanged
// ---------------------------------------------------------------------------

test('blendK=0.30 and materialMode=0 for carbon biochem', () => {
  const graph = makeGraph();
  const result = skin(graph, { biochem: 'carbon' });
  assert.strictEqual(result.blendK, 0.30);
  assert.strictEqual(result.materialMode, 0);
});

test('blendK=0.05 and materialMode=1 for silicon biochem', () => {
  const graph = makeGraph();
  const result = skin(graph, { biochem: 'silicon' });
  assert.strictEqual(result.blendK, 0.05);
  assert.strictEqual(result.materialMode, 1);
});
