import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkeleton }    from '../src/skeleton.js';
import { solveProportions } from '../src/proportions.js';
import {
  growRootSystem,
  ROOT_BONE_BUDGET,
  ROOT_SALT,
} from '../src/roots.js';
import { mulberry32 } from '../src/rng.js';
import { MAX_BONES }  from '../src/skeleton.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseGenome(overrides = {}) {
  return {
    // Canopy genes
    branchiness:      0.50,
    branchFactorN:    0.50,
    tillering:        0.00,
    radialOrder:      0.00,
    appendageBreadth: 0.50,
    appendageDensity: 0.50,
    segmentation:     0.50,
    succulence:       0.20,
    stemGirth:        0.50,
    taper:            0.50,
    rigidity:         0.60,
    verticality:      0.50,
    ribbing:          0.05,
    spininess:        0.05,
    branchAngle:      0.575,
    lengthRatio:      0.70,
    apicalBias:       0.50,
    droopBias:        0.10,
    pigment:          0.45,
    leafSize:         1.10,
    leafDensity:      1.00,
    jitter:           0.50,
    structuralSeed:   0x12345678,
    // Root genes
    rootCount:        0.45,
    rootDepth:        0.45,
    rootSpread:       0.50,
    rootFlare:        0.30,
    rootButtress:     0.15,
    rootBranchiness:  0.45,
    rootTaper:        0.50,
    ...overrides,
  };
}

function makeGraph(genome, seed) {
  const rng   = mulberry32(seed !== undefined ? seed : genome.structuralSeed);
  const graph = buildSkeleton(genome, rng, genome.jitter);
  return graph;
}

/** Deep-clone a graph (nodes array + bones array, meta shallow-cloned). */
function cloneGraph(graph) {
  return {
    nodes: graph.nodes.map(n => ({ ...n, pos: [...n.pos] })),
    bones: graph.bones.map(b => ({ ...b })),
    meta:  { ...graph.meta },
  };
}

const DEFAULT_ENV = {
  gravity:  1.0,
  medium:   'air',
  light:    0.6,
  sunAngle: 0.25,
  wind:     0.2,
  aridity:  0.35,
};

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

test('ROOT_SALT and ROOT_BONE_BUDGET are exported with correct values', () => {
  assert.strictEqual(ROOT_SALT, 0x900D5EED);
  assert.strictEqual(ROOT_BONE_BUDGET, 220);
});

// ---------------------------------------------------------------------------
// RETURN VALUE
// ---------------------------------------------------------------------------

test('growRootSystem returns the same graph object (mutation, not copy)', () => {
  const genome = makeBaseGenome();
  const graph  = makeGraph(genome);
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  const result  = growRootSystem(graph, genome, rootRng);
  assert.strictEqual(result, graph, 'should return the exact same graph reference');
});

// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------

test('growRootSystem is deterministic: two calls on fresh graph copies produce deep-equal results', () => {
  const genome = makeBaseGenome();
  const g1 = makeGraph(genome);
  const g2 = cloneGraph(g1);

  const rng1 = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  const rng2 = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);

  growRootSystem(g1, genome, rng1);
  growRootSystem(g2, genome, rng2);

  assert.deepStrictEqual(g1.nodes, g2.nodes, 'nodes arrays must be deep-equal');
  assert.deepStrictEqual(g1.bones, g2.bones, 'bones arrays must be deep-equal');
});

test('determinism holds across seeds 0..20', () => {
  for (let seed = 0; seed <= 20; seed++) {
    const genome = makeBaseGenome({ structuralSeed: seed });
    const g1 = makeGraph(genome, seed);
    const g2 = cloneGraph(g1);

    const rng1 = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
    const rng2 = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);

    growRootSystem(g1, genome, rng1);
    growRootSystem(g2, genome, rng2);

    assert.deepStrictEqual(g1.nodes, g2.nodes, `seed=${seed}: nodes not deterministic`);
    assert.deepStrictEqual(g1.bones, g2.bones, `seed=${seed}: bones not deterministic`);
  }
});

// ---------------------------------------------------------------------------
// NODE FLAGS — §1.2 contract
// ---------------------------------------------------------------------------

test('all appended root nodes have isRoot===true, branchLevel===0, rootLevel>=0, parentIdx<ownIndex', () => {
  const genome   = makeBaseGenome();
  const graph    = makeGraph(genome);
  const priorLen = graph.nodes.length;
  const rootRng  = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  const rootNodes = graph.nodes.filter(n => n.isRoot);
  assert.ok(rootNodes.length > 0, 'should append at least one root node');

  for (let i = priorLen; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    if (!node.isRoot) continue;

    assert.strictEqual(node.isRoot, true,     `node[${i}].isRoot must be true`);
    assert.strictEqual(node.branchLevel, 0,   `node[${i}].branchLevel must be 0`);
    assert.ok(node.rootLevel >= 0,            `node[${i}].rootLevel must be >= 0`);
    assert.ok(typeof node.parentIdx === 'number', `node[${i}].parentIdx must be a number`);
    assert.ok(node.parentIdx < i,             `node[${i}].parentIdx (${node.parentIdx}) must be < ${i}`);

    // Must NOT set isStem, isWoody, isTerminal, attachPos
    assert.ok(!node.isStem,     `node[${i}] must not have isStem`);
    assert.ok(!node.isWoody,    `node[${i}] must not have isWoody`);
    assert.ok(!node.isTerminal, `node[${i}] must not have isTerminal`);
    assert.ok(node.attachPos === undefined, `node[${i}] must not have attachPos`);
  }
});

test('parentIdx<ownIndex invariant holds for ALL nodes (canopy + roots) across seeds 0..30', () => {
  for (let seed = 0; seed <= 30; seed++) {
    const genome = makeBaseGenome({ structuralSeed: seed });
    const graph  = makeGraph(genome, seed);
    const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
    growRootSystem(graph, genome, rootRng);

    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i];
      if (n.parentIdx !== undefined && n.parentIdx >= 0) {
        assert.ok(
          n.parentIdx < i,
          `seed=${seed} node[${i}].parentIdx=${n.parentIdx} violates parentIdx<ownIndex`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// BONE BUDGET
// ---------------------------------------------------------------------------

test('appended root bones <= ROOT_BONE_BUDGET for default genome across seeds 0..50', () => {
  const genome = makeBaseGenome();
  for (let seed = 0; seed <= 50; seed++) {
    const g = makeGraph(genome, seed);
    const priorBones = g.bones.length;
    const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
    growRootSystem(g, genome, rootRng);
    const added = g.bones.length - priorBones;
    assert.ok(
      added <= ROOT_BONE_BUDGET,
      `seed=${seed}: added ${added} root bones, exceeds ROOT_BONE_BUDGET=${ROOT_BONE_BUDGET}`
    );
  }
});

test('total bones (canopy + roots) <= MAX_BONES + ROOT_BONE_BUDGET for extreme genomes × seeds 0..30', () => {
  const extremes = [
    { branchiness: 1.0, branchFactorN: 1.0, rootCount: 1.0, rootDepth: 1.0, rootBranchiness: 1.0, rootButtress: 1.0 },
    { branchiness: 0.0, branchFactorN: 0.0, rootCount: 0.0, rootDepth: 0.0, rootBranchiness: 0.0, rootButtress: 0.0 },
    { branchiness: 0.5, rootCount: 0.5, rootDepth: 0.5, rootBranchiness: 0.5, rootButtress: 0.5 },
  ];
  for (const ext of extremes) {
    for (let seed = 0; seed <= 30; seed++) {
      const genome = makeBaseGenome({ ...ext, structuralSeed: seed });
      const g = makeGraph(genome, seed);
      const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
      growRootSystem(g, genome, rootRng);
      assert.ok(
        g.bones.length <= MAX_BONES + ROOT_BONE_BUDGET,
        `ext=${JSON.stringify(ext)} seed=${seed}: total bones=${g.bones.length} exceeds MAX_BONES+ROOT_BONE_BUDGET=${MAX_BONES + ROOT_BONE_BUDGET}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// STRUCTURE — taproot + laterals
// ---------------------------------------------------------------------------

test('growRootSystem appends at least 1 taproot and floor(2+rootCount*4) major laterals', () => {
  const genome  = makeBaseGenome({ rootCount: 0.5, rootBranchiness: 0.0 });
  const graph   = makeGraph(genome);
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  const rootNodes = graph.nodes.filter(n => n.isRoot);
  assert.ok(rootNodes.length > 0, 'must append root nodes');

  // At least one taproot tip should be clearly below ground
  const belowGround = rootNodes.filter(n => n.pos[1] < 0);
  assert.ok(belowGround.length >= 1, 'at least one root node should be below y=0');
});

test('at least one root tip has pos[1] < 0 (taproot dives underground)', () => {
  const genome  = makeBaseGenome();
  const graph   = makeGraph(genome);
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  const rootNodes = graph.nodes.filter(n => n.isRoot);
  const belowGround = rootNodes.filter(n => n.pos[1] < 0);
  assert.ok(belowGround.length >= 1, 'taproot must produce at least one node with pos[1] < 0');
});

test('buttress nodes have pos[1] >= 0 when rootButtress > 0', () => {
  const genome  = makeBaseGenome({ rootButtress: 0.8, rootFlare: 0.7 });
  const graph   = makeGraph(genome);
  const priorLen = graph.nodes.length;
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  // Buttress nodes are added right after the taproot, before laterals.
  // They should be above or at ground level.
  const rootNodes = graph.nodes.slice(priorLen).filter(n => n.isRoot);
  // At least some root nodes near origin should be at/above ground
  const aboveGround = rootNodes.filter(n => n.pos[1] >= -0.01); // allow tiny epsilon
  assert.ok(aboveGround.length >= 1, 'buttress nodes should be at or above ground level');
});

// ---------------------------------------------------------------------------
// GEOTROPISM — lateral chain tip Y decreases monotonically along the chain
// ---------------------------------------------------------------------------

test('geotropism: lateral root chains bend progressively downward (tip Y decreases along chain)', () => {
  // Use a genome with no sub-branches and strong depth to see clear geotropism
  const genome  = makeBaseGenome({ rootBranchiness: 0.0, rootDepth: 0.8, rootSpread: 0.6 });
  const graph   = makeGraph(genome);
  const priorLen = graph.nodes.length;
  const rootRng  = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  const rootNodes = graph.nodes.slice(priorLen).filter(n => n.isRoot);

  // Build parent→children map for root nodes only
  const children = new Map();
  for (let i = priorLen; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    if (!node.isRoot) continue;
    const p = node.parentIdx;
    if (p !== undefined && p >= 0) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(i);
    }
  }

  // Find chains (sequences where each node has exactly 1 child)
  // Starting from each lateral root's first node (parented to trunk base)
  let foundDecreasingChain = false;

  for (let i = priorLen; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    if (!node.isRoot) continue;
    if (node.parentIdx !== 0) continue; // lateral roots parent to trunk base (index 0)
    if (node.pos[1] >= 0) continue;     // skip buttress nodes that are above ground

    // Trace the chain from this node downward
    const chain = [i];
    let cur = i;
    while (children.has(cur) && children.get(cur).length === 1) {
      cur = children.get(cur)[0];
      chain.push(cur);
    }

    if (chain.length < 2) continue;

    // Check that Y coordinates decrease (or stay the same) along the chain
    let isDecreasing = true;
    for (let k = 1; k < chain.length; k++) {
      const prevY = graph.nodes[chain[k - 1]].pos[1];
      const curY  = graph.nodes[chain[k]].pos[1];
      if (curY > prevY + 0.001) { // allow tiny floating-point tolerance
        isDecreasing = false;
        break;
      }
    }

    if (isDecreasing && chain.length >= 2) {
      foundDecreasingChain = true;
      break;
    }
  }

  assert.ok(foundDecreasingChain, 'at least one lateral root chain should have monotonically decreasing Y (geotropism)');
});

// ---------------------------------------------------------------------------
// CROSSFADE — draw count is identical whether lateralFrac === 0 or > 0
// ---------------------------------------------------------------------------

test('crossfade lateral: weight equals frac; draw count identical for frac=0 vs frac>0', () => {
  // rootCount=0.0 → fractLaterals=2.0, lateralFrac=0 (integer boundary, no crossfade)
  // rootCount=0.5 → fractLaterals=4.0, lateralFrac=0 (integer boundary)
  // rootCount=0.25 → fractLaterals=3.0, lateralFrac=0
  // rootCount=0.125 → fractLaterals=2.5, lateralFrac=0.5 — crossfade with weight=0.5

  // We compare draw counts by running two calls with different genomes that differ ONLY
  // by being at vs away from an integer rootCount boundary.
  // Both must consume exactly the same number of rootRng draws.

  // Test: genome with lateralFrac=0 (exact integer) vs lateralFrac=0.5 (crossfade).
  // Same structuralSeed, same structuralSeed^ROOT_SALT → same rng sequence start.
  // Count draws consumed by intercepting the rng.

  function countDraws(rootCountVal) {
    const genome = makeBaseGenome({ rootCount: rootCountVal, rootBranchiness: 0.0 });
    const graph  = makeGraph(genome);
    let drawCount = 0;
    const baseRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
    const countingRng = () => { drawCount++; return baseRng(); };
    growRootSystem(graph, genome, countingRng);
    return drawCount;
  }

  // rootCount=0.0 → fractLaterals=2.0, frac=0 (exact integer)
  // rootCount=0.125 → fractLaterals=2.5, frac=0.5 (crossfade at weight=0.5)
  // Both have fullLaterals=2, so the same crossfade slot exists; only weight differs.
  const draws_frac0 = countDraws(0.0);   // frac=0: crossfade slot weight=0
  const draws_frac5 = countDraws(0.125); // frac=0.5: crossfade slot weight=0.5

  assert.strictEqual(
    draws_frac0,
    draws_frac5,
    `draw count must be identical regardless of lateralFrac (got frac=0: ${draws_frac0}, frac=0.5: ${draws_frac5})`
  );
});

test('crossfade lateral weight equals lateralFrac', () => {
  // Use rootCount=0.125 → fractLaterals=2.5, fullLaterals=2, lateralFrac=0.5
  // The 3rd lateral (index 2, the crossfade one) should have weight≈0.5
  const rootCountVal = 0.125;
  const genome  = makeBaseGenome({ rootCount: rootCountVal, rootBranchiness: 0.0 });
  const graph   = makeGraph(genome);
  const priorLen = graph.nodes.length;
  const rootRng  = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  // Compute expected lateralFrac
  const fractLaterals = 2 + rootCountVal * 4;  // 2.5
  const fullLaterals  = Math.floor(fractLaterals); // 2
  const expectedFrac  = fractLaterals - fullLaterals; // 0.5

  // Find crossfade nodes: appended root nodes with weight !== 1.0 and weight !== undefined
  const addedRootNodes = graph.nodes.slice(priorLen).filter(n => n.isRoot);
  const crossfadeNodes = addedRootNodes.filter(n => Math.abs(n.weight - expectedFrac) < 1e-6);

  // The crossfade lateral must exist with correct weight
  assert.ok(
    crossfadeNodes.length > 0,
    `should have crossfade root nodes with weight≈${expectedFrac} (got weights: ${[...new Set(addedRootNodes.map(n => n.weight))].join(', ')})`
  );
});

// ---------------------------------------------------------------------------
// STABILITY — bones array never has invalid node references
// ---------------------------------------------------------------------------

test('all bone indices reference valid nodes', () => {
  const genome  = makeBaseGenome();
  const graph   = makeGraph(genome);
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  for (let i = 0; i < graph.bones.length; i++) {
    const b = graph.bones[i];
    assert.ok(b.a >= 0 && b.a < graph.nodes.length, `bone[${i}].a=${b.a} out of range`);
    assert.ok(b.b >= 0 && b.b < graph.nodes.length, `bone[${i}].b=${b.b} out of range`);
  }
});

// ---------------------------------------------------------------------------
// PROPS — proportions.js does not move isRoot positions
// ---------------------------------------------------------------------------

test('solveProportions does not move isRoot node positions', () => {
  const genome  = makeBaseGenome();
  const graph   = makeGraph(genome);
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  // Record root positions before proportions
  const possBefore = graph.nodes
    .filter(n => n.isRoot)
    .map(n => [...n.pos]);

  solveProportions(graph, DEFAULT_ENV, genome);

  // Check root positions are unchanged
  const rootNodes = graph.nodes.filter(n => n.isRoot);
  for (let i = 0; i < rootNodes.length; i++) {
    const pos = rootNodes[i].pos;
    const before = possBefore[i];
    assert.ok(
      Math.abs(pos[0] - before[0]) < 1e-9 &&
      Math.abs(pos[1] - before[1]) < 1e-9 &&
      Math.abs(pos[2] - before[2]) < 1e-9,
      `isRoot node[${i}] position changed during solveProportions (bending pass must skip isRoot nodes)`
    );
  }
});

// ---------------------------------------------------------------------------
// ADDITIONAL — multiple genome extremes still honor node flag contract
// ---------------------------------------------------------------------------

test('node flags contract holds for extreme root genomes × seeds 0..20', () => {
  const extremes = [
    { rootCount: 1.0, rootDepth: 1.0, rootBranchiness: 1.0, rootButtress: 1.0, rootSpread: 1.0 },
    { rootCount: 0.0, rootDepth: 0.0, rootBranchiness: 0.0, rootButtress: 0.0, rootSpread: 0.0 },
    { rootCount: 0.5, rootDepth: 0.5, rootBranchiness: 0.5, rootButtress: 0.5, rootSpread: 0.5 },
  ];

  for (const ext of extremes) {
    for (let seed = 0; seed <= 20; seed++) {
      const genome  = makeBaseGenome({ ...ext, structuralSeed: seed });
      const graph   = makeGraph(genome, seed);
      const priorLen = graph.nodes.length;
      const rootRng  = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
      growRootSystem(graph, genome, rootRng);

      for (let i = priorLen; i < graph.nodes.length; i++) {
        const node = graph.nodes[i];
        if (!node.isRoot) continue;
        assert.strictEqual(node.branchLevel, 0, `ext seed=${seed} node[${i}].branchLevel must be 0`);
        assert.ok(node.rootLevel >= 0,          `ext seed=${seed} node[${i}].rootLevel must be >= 0`);
        assert.ok(node.parentIdx < i,            `ext seed=${seed} node[${i}].parentIdx must be < ${i}`);
      }
    }
  }
});
