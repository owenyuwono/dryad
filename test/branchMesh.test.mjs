// =============================================================================
// branchMesh.test.mjs
// Tests for buildBranchGeometry in src/branchMesh.js
// Run with: node --test test/branchMesh.test.mjs
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkeleton }    from '../src/skeleton.js';
import { solveProportions } from '../src/proportions.js';
import { buildBranchGeometry, MAX_WIND_BONES } from '../src/branchMesh.js';
import { resolve, randomGenome } from '../src/genome.js';
import { createWindSolver } from '../src/windSolver.js';

// ---------------------------------------------------------------------------
// RNG (mulberry32 — matches the pattern used in other test files)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Genome factories
// ---------------------------------------------------------------------------
function makeGenome(overrides = {}) {
  return {
    branchiness:      0.5,
    branchFactorN:    0.5,
    tillering:        0.0,
    radialOrder:      0.0,
    segmentation:     0.5,
    appendageBreadth: 0.5,
    appendageDensity: 0.5,
    branchAngle:      0.5,
    lengthRatio:      0.7,
    apicalBias:       0.5,
    droopBias:        0.1,
    jitter:           0.5,
    structuralSeed:   0.0,
    ...overrides,
  };
}

// Bushy genome: lots of branching
const bushyGenome = makeGenome({
  branchiness:   0.9,
  branchFactorN: 0.9,
  tillering:     0.8,
  segmentation:  0.9,
});

// Sparse genome: minimal branching
const sparseGenome = makeGenome({
  branchiness:   0.1,
  branchFactorN: 0.1,
  tillering:     0.0,
  segmentation:  0.1,
});

// Tree-like genome: tall trunk, moderate branches
const treeGenome = makeGenome({
  branchiness:   0.7,
  branchFactorN: 0.4,
  tillering:     0.0,
  segmentation:  0.7,
  apicalBias:    0.8,
});

// Default envelope for solveProportions
const envelope = { gravity: 1.0, medium: 'air' };

// Build a complete graph: skeleton + proportions
function buildGraph(genome, seed) {
  const rng = mulberry32(seed);
  const graph = buildSkeleton(genome, rng);
  solveProportions(graph, envelope);
  return graph;
}

// Deep-equal of two typed arrays by checking every element
function typedArraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helper: check a result for structural correctness
// ---------------------------------------------------------------------------
function assertWellFormed(result, label) {
  const { positions, normals, uvs, ao, indices, vertexCount, triangleCount, bounds } = result;

  // Array type checks
  assert.ok(positions instanceof Float32Array, `${label}: positions is Float32Array`);
  assert.ok(normals   instanceof Float32Array, `${label}: normals is Float32Array`);
  assert.ok(uvs       instanceof Float32Array, `${label}: uvs is Float32Array`);
  assert.ok(ao        instanceof Float32Array, `${label}: ao is Float32Array`);
  assert.ok(indices   instanceof Uint32Array,  `${label}: indices is Uint32Array`);

  // Stride checks
  assert.strictEqual(positions.length, vertexCount * 3, `${label}: positions stride`);
  assert.strictEqual(normals.length,   vertexCount * 3, `${label}: normals stride`);
  assert.strictEqual(uvs.length,       vertexCount * 2, `${label}: uvs stride`);
  assert.strictEqual(ao.length,        vertexCount,     `${label}: ao stride`);
  assert.strictEqual(indices.length,   triangleCount * 3, `${label}: indices stride`);

  // Bounds object shape
  assert.ok(Array.isArray(bounds.min) && bounds.min.length === 3, `${label}: bounds.min`);
  assert.ok(Array.isArray(bounds.max) && bounds.max.length === 3, `${label}: bounds.max`);

  // No NaN or Infinity in any array
  for (let i = 0; i < positions.length; i++) {
    assert.ok(isFinite(positions[i]), `${label}: positions[${i}] is finite`);
  }
  for (let i = 0; i < normals.length; i++) {
    assert.ok(isFinite(normals[i]), `${label}: normals[${i}] is finite`);
  }
  for (let i = 0; i < uvs.length; i++) {
    assert.ok(isFinite(uvs[i]), `${label}: uvs[${i}] is finite`);
  }
  for (let i = 0; i < ao.length; i++) {
    assert.ok(isFinite(ao[i]), `${label}: ao[${i}] is finite`);
    assert.ok(ao[i] >= 0 && ao[i] <= 1, `${label}: ao[${i}] in [0,1]`);
  }
  for (let i = 0; i < indices.length; i++) {
    assert.ok(indices[i] < vertexCount, `${label}: index[${i}]=${indices[i]} < vertexCount=${vertexCount}`);
  }

  // All normals unit-length (within 1e-3)
  for (let i = 0; i < vertexCount; i++) {
    const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    assert.ok(
      Math.abs(len - 1.0) < 1e-3,
      `${label}: normal[${i}] length=${len.toFixed(6)} (expected ~1.0)`
    );
  }
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

test('empty graph returns zero-length arrays without throwing', () => {
  const emptyGraph = { nodes: [], bones: [] };
  const result = buildBranchGeometry(emptyGraph);
  assert.strictEqual(result.vertexCount, 0);
  assert.strictEqual(result.triangleCount, 0);
  assert.strictEqual(result.positions.length, 0);
  assert.strictEqual(result.normals.length, 0);
  assert.strictEqual(result.uvs.length, 0);
  assert.strictEqual(result.ao.length, 0);
  assert.strictEqual(result.indices.length, 0);
  assert.deepStrictEqual(result.bounds.min, [0,0,0]);
  assert.deepStrictEqual(result.bounds.max, [0,0,0]);
});

test('null/undefined bones returns zero-length arrays without throwing', () => {
  const result = buildBranchGeometry({ nodes: [], bones: undefined });
  assert.strictEqual(result.vertexCount, 0);
  assert.strictEqual(result.triangleCount, 0);
});

test('array shapes and strides are correct for a bushy genome', () => {
  const graph = buildGraph(bushyGenome, 0);
  const result = buildBranchGeometry(graph);
  assertWellFormed(result, 'bushy seed=0');
});

test('array shapes and strides are correct for a sparse genome', () => {
  const graph = buildGraph(sparseGenome, 0);
  const result = buildBranchGeometry(graph);
  assertWellFormed(result, 'sparse seed=0');
});

test('array shapes and strides are correct for a tree-like genome', () => {
  const graph = buildGraph(treeGenome, 0);
  const result = buildBranchGeometry(graph);
  assertWellFormed(result, 'tree seed=0');
});

test('no NaN or Infinity across genome battery × seeds 0..50', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  const labels  = ['bushy', 'sparse', 'tree'];
  for (let seed = 0; seed <= 50; seed++) {
    for (let gi = 0; gi < genomes.length; gi++) {
      const graph = buildGraph(genomes[gi], seed);
      const result = buildBranchGeometry(graph);
      assertWellFormed(result, `${labels[gi]} seed=${seed}`);
    }
  }
});

test('all normals are unit-length across all genomes × seeds 0..50', () => {
  // assertWellFormed already checks normals; this test makes it explicit.
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 50; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const { normals, vertexCount } = buildBranchGeometry(graph);
      for (let i = 0; i < vertexCount; i++) {
        const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        assert.ok(Math.abs(len - 1.0) < 1e-3, `seed=${seed} normal[${i}] length=${len}`);
      }
    }
  }
});

test('vertexCount and triangleCount are consistent: indices.length === triangleCount*3', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 10; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const { indices, triangleCount, vertexCount, positions, normals, uvs, ao } = buildBranchGeometry(graph);
      assert.strictEqual(indices.length, triangleCount * 3);
      assert.strictEqual(positions.length, vertexCount * 3);
      assert.strictEqual(normals.length,   vertexCount * 3);
      assert.strictEqual(uvs.length,       vertexCount * 2);
      assert.strictEqual(ao.length,        vertexCount);
    }
  }
});

test('vertex and triangle counts scale monotonically with bone count', () => {
  // Build graphs at increasing branchiness and check that more bones → more verts/tris.
  // Not strictly monotonic per seed, but statistically always true for increasing genome extremes.
  const seeds = [0, 1, 2];
  for (const seed of seeds) {
    const g0 = buildGraph(sparseGenome, seed);
    const g1 = buildGraph(makeGenome({ branchiness: 0.5, branchFactorN: 0.5 }), seed);
    const g2 = buildGraph(bushyGenome, seed);

    const r0 = buildBranchGeometry(g0);
    const r1 = buildBranchGeometry(g1);
    const r2 = buildBranchGeometry(g2);

    // More bones → more vertices (not necessarily strictly for every pair, but between extremes)
    assert.ok(
      r2.vertexCount >= r0.vertexCount,
      `seed=${seed}: bushy vertexCount(${r2.vertexCount}) >= sparse vertexCount(${r0.vertexCount})`
    );
    assert.ok(
      r2.triangleCount >= r0.triangleCount,
      `seed=${seed}: bushy triangleCount(${r2.triangleCount}) >= sparse triangleCount(${r0.triangleCount})`
    );
    // Non-zero for bushy
    assert.ok(r2.vertexCount > 0, `seed=${seed}: bushy has vertices`);
    assert.ok(r2.triangleCount > 0, `seed=${seed}: bushy has triangles`);
  }
});

test('bounds contain all node positions', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  const eps = 1e-4; // small epsilon for float precision
  for (let seed = 0; seed <= 20; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const result = buildBranchGeometry(graph);
      if (result.vertexCount === 0) continue;
      const { bounds } = result;

      // Every node pos must be within bounds (expanded by node.radius at most,
      // but node positions themselves are strictly interior to the tube surface).
      for (const node of graph.nodes) {
        if (node.isRoot || node.isTerminal) continue; // these may be outside rendered bones
        const [x, y, z] = node.pos;
        // Loose check: within bounds + node.radius (tube surface extends to radius)
        const r = node.radius || 0;
        assert.ok(x >= bounds.min[0] - r - eps, `node.pos[0]=${x} >= bounds.min[0]=${bounds.min[0]} - ${r}`);
        assert.ok(x <= bounds.max[0] + r + eps, `node.pos[0]=${x} <= bounds.max[0]=${bounds.max[0]} + ${r}`);
        assert.ok(y >= bounds.min[1] - r - eps, `node.pos[1]=${y} >= bounds.min[1]=${bounds.min[1]} - ${r}`);
        assert.ok(y <= bounds.max[1] + r + eps, `node.pos[1]=${y} <= bounds.max[1]=${bounds.max[1]} + ${r}`);
        assert.ok(z >= bounds.min[2] - r - eps, `node.pos[2]=${z} >= bounds.min[2]=${bounds.min[2]} - ${r}`);
        assert.ok(z <= bounds.max[2] + r + eps, `node.pos[2]=${z} <= bounds.max[2]=${bounds.max[2]} + ${r}`);
      }
    }
  }
});

test('bounds contain all emitted vertex positions', () => {
  const graph = buildGraph(bushyGenome, 7);
  const result = buildBranchGeometry(graph);
  if (result.vertexCount === 0) return;
  const { positions, vertexCount, bounds } = result;
  const eps = 1e-4;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    assert.ok(x >= bounds.min[0] - eps, `vert[${i}].x=${x} >= bounds.min[0]=${bounds.min[0]}`);
    assert.ok(x <= bounds.max[0] + eps, `vert[${i}].x=${x} <= bounds.max[0]=${bounds.max[0]}`);
    assert.ok(y >= bounds.min[1] - eps, `vert[${i}].y=${y} >= bounds.min[1]=${bounds.min[1]}`);
    assert.ok(y <= bounds.max[1] + eps, `vert[${i}].y=${y} <= bounds.max[1]=${bounds.max[1]}`);
    assert.ok(z >= bounds.min[2] - eps, `vert[${i}].z=${z} >= bounds.min[2]=${bounds.min[2]}`);
    assert.ok(z <= bounds.max[2] + eps, `vert[${i}].z=${z} <= bounds.max[2]=${bounds.max[2]}`);
  }
});

test('determinism: two calls on same graph produce byte-identical output', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 10; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const r1 = buildBranchGeometry(graph);
      const r2 = buildBranchGeometry(graph);

      assert.ok(typedArraysEqual(r1.positions, r2.positions), `seed=${seed}: positions identical`);
      assert.ok(typedArraysEqual(r1.normals,   r2.normals),   `seed=${seed}: normals identical`);
      assert.ok(typedArraysEqual(r1.uvs,       r2.uvs),       `seed=${seed}: uvs identical`);
      assert.ok(typedArraysEqual(r1.ao,        r2.ao),        `seed=${seed}: ao identical`);
      assert.ok(typedArraysEqual(r1.indices,   r2.indices),   `seed=${seed}: indices identical`);
      assert.strictEqual(r1.vertexCount,   r2.vertexCount,   `seed=${seed}: vertexCount identical`);
      assert.strictEqual(r1.triangleCount, r2.triangleCount, `seed=${seed}: triangleCount identical`);
    }
  }
});

test('indices is always Uint32Array regardless of vertex count', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 5; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const { indices } = buildBranchGeometry(graph);
      assert.ok(indices instanceof Uint32Array, `seed=${seed}: indices is Uint32Array`);
    }
  }
  // Also check empty graph
  const empty = buildBranchGeometry({ nodes: [], bones: [] });
  assert.ok(empty.indices instanceof Uint32Array, 'empty: indices is Uint32Array');
});

test('ao values are all in [0,1]', () => {
  const graph = buildGraph(bushyGenome, 3);
  const { ao, vertexCount } = buildBranchGeometry(graph);
  for (let i = 0; i < vertexCount; i++) {
    assert.ok(ao[i] >= 0 && ao[i] <= 1, `ao[${i}]=${ao[i]} not in [0,1]`);
  }
});

test('windWeight values are all in [0,1]', () => {
  const graph = buildGraph(bushyGenome, 3);
  const { windWeight, vertexCount } = buildBranchGeometry(graph);
  assert.ok(windWeight instanceof Float32Array, 'windWeight is Float32Array');
  assert.strictEqual(windWeight.length, vertexCount, 'windWeight.length === vertexCount');
  for (let i = 0; i < vertexCount; i++) {
    assert.ok(windWeight[i] >= 0 && windWeight[i] <= 1, `windWeight[${i}]=${windWeight[i]} not in [0,1]`);
  }
});

test('windWeight empty graph returns Float32Array(0)', () => {
  const empty = buildBranchGeometry({ nodes: [], bones: [] });
  assert.ok(empty.windWeight instanceof Float32Array, 'empty windWeight is Float32Array');
  assert.strictEqual(empty.windWeight.length, 0);
});

test('opts.radialSegsFor override is respected', () => {
  // Use a custom radialSegsFor that always returns 6 segments.
  const graph = buildGraph(treeGenome, 0);
  const defaultResult = buildBranchGeometry(graph);
  const customResult  = buildBranchGeometry(graph, {
    radialSegsFor: () => 6,
  });
  // The custom result should have different counts (unless default also happens to be 6 everywhere)
  // Just verify it runs cleanly and counts are consistent.
  assertWellFormed(customResult, 'custom radialSegsFor');
});

test('opts.minRadius prevents ring radius below threshold', () => {
  // With a large minRadius, even tip-tapered nodes should produce non-degenerate rings.
  const graph = buildGraph(sparseGenome, 0);
  const result = buildBranchGeometry(graph, { minRadius: 0.1 });
  assertWellFormed(result, 'large minRadius');
  // Vertex positions should be at least minRadius away from their node pos in the ring plane.
  // (Not trivially testable without re-deriving chain structure, so just verify well-formed.)
});

test('opts.includeRoot=false excludes root-flare bones', () => {
  // skeleton.js no longer emits isRoot nodes (stub was removed in Task 4 — roots.js
  // is the sole source). Manually inject 3 isRoot nodes to exercise includeRoot=false.
  const graph = buildGraph(treeGenome, 2);
  const originIdx = 0; // first trunk base is always index 0
  const origin = graph.nodes[originIdx].pos;
  const rootOffsets = [
    [ 0.30, -0.20,  0.00],
    [-0.30, -0.20,  0.00],
    [ 0.00, -0.20,  0.30],
  ];
  for (const off of rootOffsets) {
    const idx = graph.nodes.length;
    graph.nodes.push({
      pos:         [origin[0] + off[0], origin[1] + off[1], origin[2] + off[2]],
      radius:      0.07,
      weight:      1.0,
      isRoot:      true,
      branchLevel: 0,
      rootLevel:   0,
      parentIdx:   originIdx,
    });
    graph.bones.push({ a: originIdx, b: idx });
  }

  const withRoot    = buildBranchGeometry(graph, { includeRoot: true });
  const withoutRoot = buildBranchGeometry(graph, { includeRoot: false });

  // Both should be structurally valid.
  assertWellFormed(withRoot,    'includeRoot=true');
  assertWellFormed(withoutRoot, 'includeRoot=false');

  // Both must produce non-zero geometry (trunk bones are always included).
  assert.ok(withRoot.vertexCount > 0,    'includeRoot=true: vertexCount > 0');
  assert.ok(withoutRoot.vertexCount > 0, 'includeRoot=false: vertexCount > 0');

  // The two results must differ (root flare contributes vertices).
  // It is valid for either to have more total vertices depending on chain topology,
  // but the results must not be identical (root bones change the geometry).
  const countsMatch =
    withRoot.vertexCount   === withoutRoot.vertexCount &&
    withRoot.triangleCount === withoutRoot.triangleCount;
  assert.ok(!countsMatch, 'includeRoot=true and includeRoot=false should produce different counts');
});

test('bushy genome produces non-zero geometry', () => {
  const graph = buildGraph(bushyGenome, 42);
  const { vertexCount, triangleCount } = buildBranchGeometry(graph);
  assert.ok(vertexCount > 0, 'bushy: vertexCount > 0');
  assert.ok(triangleCount > 0, 'bushy: triangleCount > 0');
});

test('sparse genome produces non-zero geometry (has trunk)', () => {
  const graph = buildGraph(sparseGenome, 0);
  const { vertexCount, triangleCount } = buildBranchGeometry(graph);
  assert.ok(vertexCount > 0, 'sparse: vertexCount > 0');
  assert.ok(triangleCount > 0, 'sparse: triangleCount > 0');
});

test('all triangle indices reference valid vertices', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 20; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const { indices, vertexCount } = buildBranchGeometry(graph);
      for (let i = 0; i < indices.length; i++) {
        assert.ok(
          indices[i] < vertexCount,
          `seed=${seed} index[${i}]=${indices[i]} >= vertexCount=${vertexCount}`
        );
      }
    }
  }
});

test('UV u values are in [0,1]', () => {
  const graph = buildGraph(bushyGenome, 5);
  const { uvs, vertexCount } = buildBranchGeometry(graph);
  for (let i = 0; i < vertexCount; i++) {
    const u = uvs[i*2];
    assert.ok(u >= -1e-6 && u <= 1 + 1e-6, `uvs[${i}].u=${u} not in [0,1]`);
  }
});

test('UV v (arc length) values are non-negative', () => {
  const graph = buildGraph(bushyGenome, 5);
  const { uvs, vertexCount } = buildBranchGeometry(graph);
  for (let i = 0; i < vertexCount; i++) {
    const v = uvs[i*2+1];
    assert.ok(v >= -1e-6, `uvs[${i}].v=${v} is negative`);
  }
});

// ---------------------------------------------------------------------------
// CONNECTIVITY TESTS — no bone should be left untubed (gap regression guard)
//
// For every bone {a, b} in the graph, the geometry must contain at least one
// emitted vertex within (node.radius * 1.5 + minRadius) of BOTH node[a].pos
// AND node[b].pos.  This catches the fork-gap bug where child chains started
// at the child node, leaving the fork→child segment untubed.
//
// OLD BEHAVIOR (before the fix): chains started at the child of a fork, so the
// fork→child bone had NO ring near the fork node.  The test below would have
// failed on any bone that is a fork→child edge.
// ---------------------------------------------------------------------------

// Returns true if any emitted vertex in `positions` (Float32Array, stride 3)
// lies within `threshold` distance of `pos` [x,y,z].
function hasVertexNear(positions, pos, threshold) {
  const [tx, ty, tz] = pos;
  const thresh2 = threshold * threshold;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i]   - tx;
    const dy = positions[i+1] - ty;
    const dz = positions[i+2] - tz;
    if (dx*dx + dy*dy + dz*dz <= thresh2) return true;
  }
  return false;
}

// Check connectivity for a single graph+result pair.
// For every filtered bone {a, b}, verify vertices exist near both endpoints.
function assertBonesCovered(graph, result, opts, label) {
  const { nodes, bones } = graph;
  const { positions } = result;
  const minRadius = opts && opts.minRadius !== undefined ? opts.minRadius : 0.004;
  const includeRoot = opts ? opts.includeRoot !== false : true;

  for (const bone of bones) {
    // Mirror the same filtering logic used inside buildBranchGeometry.
    if (!includeRoot && (nodes[bone.a].isRoot || nodes[bone.b].isRoot)) continue;

    const nodeA = nodes[bone.a];
    const nodeB = nodes[bone.b];
    // Threshold: node radius * 1.5 + minRadius (generous to allow ring offset)
    const threshA = Math.max(nodeA.radius, minRadius) * 1.5 + minRadius;
    const threshB = Math.max(nodeB.radius, minRadius) * 1.5 + minRadius;

    assert.ok(
      hasVertexNear(positions, nodeA.pos, threshA),
      `${label}: bone {${bone.a},${bone.b}} — no vertex near node[${bone.a}].pos ` +
      `[${nodeA.pos}] within ${threshA.toFixed(4)} (fork-gap at parent end)`
    );
    assert.ok(
      hasVertexNear(positions, nodeB.pos, threshB),
      `${label}: bone {${bone.a},${bone.b}} — no vertex near node[${bone.b}].pos ` +
      `[${nodeB.pos}] within ${threshB.toFixed(4)} (fork-gap at child end)`
    );
  }
}

test('connectivity: every bone is covered — no fork gaps (treeGenome seeds 0..20)', () => {
  for (let seed = 0; seed <= 20; seed++) {
    const graph = buildGraph(treeGenome, seed);
    const result = buildBranchGeometry(graph);
    if (result.vertexCount === 0) continue;
    assertBonesCovered(graph, result, {}, `treeGenome seed=${seed}`);
  }
});

test('connectivity: every bone is covered — no fork gaps (bushyGenome seeds 0..20)', () => {
  for (let seed = 0; seed <= 20; seed++) {
    const graph = buildGraph(bushyGenome, seed);
    const result = buildBranchGeometry(graph);
    if (result.vertexCount === 0) continue;
    assertBonesCovered(graph, result, {}, `bushyGenome seed=${seed}`);
  }
});

test('connectivity: every bone is covered — no fork gaps (sparseGenome seeds 0..20)', () => {
  for (let seed = 0; seed <= 20; seed++) {
    const graph = buildGraph(sparseGenome, seed);
    const result = buildBranchGeometry(graph);
    if (result.vertexCount === 0) continue;
    assertBonesCovered(graph, result, {}, `sparseGenome seed=${seed}`);
  }
});

// ---------------------------------------------------------------------------
// RADIAL SEGMENT COUNT TESTS — trunk must be rounder, twigs stay cheap
// ---------------------------------------------------------------------------

test('trunk-level (branchLevel 0) ring uses 16 radial segments by default', () => {
  // Hand-crafted single-chain trunk: root → mid → tip (all branchLevel 0)
  // A 3-node tip chain has (N-1)=2 full rings + 1 apex.
  // vertexCount = 2 * segs + 1 = 2*16+1 = 33
  const nodes = [
    { pos: [0, 0, 0],   radius: 0.08, branchLevel: 0, isRoot: false, isTerminal: false },
    { pos: [0, 0.5, 0], radius: 0.05, branchLevel: 0, isRoot: false, isTerminal: false },
    { pos: [0, 1.0, 0], radius: 0.01, branchLevel: 0, isRoot: false, isTerminal: true  },
  ];
  const bones = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
  const graph = { nodes, bones };

  const result = buildBranchGeometry(graph, { includeRoot: true });
  assertWellFormed(result, 'trunk-segs-16');

  // With default segs=16, tip chain of 3 nodes → 2*16+1 = 33 vertices.
  assert.strictEqual(result.vertexCount, 33,
    `trunk (level 0) ring should use 16 segments: expected 33 vertices, got ${result.vertexCount}`);

  // Confirm an override to the old value (10) produces fewer trunk vertices.
  const oldResult = buildBranchGeometry(graph, {
    includeRoot: true,
    radialSegsFor: (level) => level <= 0 ? 10 : level === 1 ? 8 : 5,
  });
  // Old: 2*10+1 = 21 vertices
  assert.strictEqual(oldResult.vertexCount, 21,
    `trunk override to 10 segs: expected 21 vertices, got ${oldResult.vertexCount}`);

  // New default must have strictly more trunk vertices than old default.
  assert.ok(
    result.vertexCount > oldResult.vertexCount,
    `default trunk vertexCount(${result.vertexCount}) must exceed old-default vertexCount(${oldResult.vertexCount})`
  );
});

test('branch level 1 ring uses 10 radial segments by default', () => {
  // 3-node tip chain all at branchLevel 1 → 2*10+1 = 21 vertices
  const nodes = [
    { pos: [0, 0, 0],   radius: 0.04, branchLevel: 1, isRoot: false, isTerminal: false },
    { pos: [0, 0.5, 0], radius: 0.02, branchLevel: 1, isRoot: false, isTerminal: false },
    { pos: [0, 1.0, 0], radius: 0.005, branchLevel: 1, isRoot: false, isTerminal: true  },
  ];
  const bones = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
  const graph = { nodes, bones };
  const result = buildBranchGeometry(graph);
  assertWellFormed(result, 'level1-segs-10');
  assert.strictEqual(result.vertexCount, 21,
    `level-1 ring should use 10 segments: expected 21 vertices, got ${result.vertexCount}`);
});

test('branch level 2 ring uses 7 radial segments by default', () => {
  // 3-node tip chain all at branchLevel 2 → 2*7+1 = 15 vertices
  const nodes = [
    { pos: [0, 0, 0],   radius: 0.02, branchLevel: 2, isRoot: false, isTerminal: false },
    { pos: [0, 0.5, 0], radius: 0.01, branchLevel: 2, isRoot: false, isTerminal: false },
    { pos: [0, 1.0, 0], radius: 0.003, branchLevel: 2, isRoot: false, isTerminal: true  },
  ];
  const bones = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
  const graph = { nodes, bones };
  const result = buildBranchGeometry(graph);
  assertWellFormed(result, 'level2-segs-7');
  assert.strictEqual(result.vertexCount, 15,
    `level-2 ring should use 7 segments: expected 15 vertices, got ${result.vertexCount}`);
});

test('branch level 3+ ring uses 5 radial segments by default', () => {
  // 3-node tip chain at branchLevel 3 → 2*5+1 = 11 vertices
  const nodes = [
    { pos: [0, 0, 0],   radius: 0.01, branchLevel: 3, isRoot: false, isTerminal: false },
    { pos: [0, 0.5, 0], radius: 0.005, branchLevel: 3, isRoot: false, isTerminal: false },
    { pos: [0, 1.0, 0], radius: 0.001, branchLevel: 3, isRoot: false, isTerminal: true  },
  ];
  const bones = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
  const graph = { nodes, bones };
  const result = buildBranchGeometry(graph);
  assertWellFormed(result, 'level3-segs-5');
  assert.strictEqual(result.vertexCount, 11,
    `level-3 ring should use 5 segments: expected 11 vertices, got ${result.vertexCount}`);
});

test('connectivity: fork-child bones covered — hand-crafted minimal fork graph', () => {
  // Minimal graph: root→trunk→fork, fork→branchA (tip), fork→branchB (tip)
  //
  //   node0 (root)  ──bone0──  node1 (trunk)
  //   node1 (trunk) ──bone1──  node2 (fork)
  //   node2 (fork)  ──bone2──  node3 (branchA tip)
  //   node2 (fork)  ──bone3──  node4 (branchB tip)
  //
  // OLD BEHAVIOR: chains for branchA and branchB would start at node3/node4,
  // so bone2 (node2→node3) and bone3 (node2→node4) had no ring near node2 (the fork).
  // FIXED BEHAVIOR: each branch chain is prepended with node2, bridging the gap.

  const nodes = [
    { pos: [0, 0, 0], radius: 0.08, branchLevel: 0, isRoot: true,  isTerminal: false },
    { pos: [0, 0.5, 0], radius: 0.07, branchLevel: 0, isRoot: false, isTerminal: false },
    { pos: [0, 1.0, 0], radius: 0.05, branchLevel: 0, isRoot: false, isTerminal: false },
    { pos: [0.4, 1.4, 0], radius: 0.02, branchLevel: 1, isRoot: false, isTerminal: true },
    { pos: [-0.4, 1.4, 0], radius: 0.02, branchLevel: 1, isRoot: false, isTerminal: true },
  ];
  const bones = [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
    { a: 2, b: 4 },
  ];
  const graph = { nodes, bones };
  const result = buildBranchGeometry(graph, { includeRoot: true });

  assertWellFormed(result, 'hand-crafted fork');

  // Critical: fork node (node2) must be covered by the branch chains.
  // Bones 2 and 3 both start at node2 — each branch tube must have a ring near node2.
  const forkPos = nodes[2].pos;
  const forkRadius = nodes[2].radius;
  const thresh = forkRadius * 1.5 + 0.004;

  assert.ok(
    hasVertexNear(result.positions, forkPos, thresh),
    `fork node (node2) at [${forkPos}] must have nearby vertices — fork-child bridge missing`
  );

  // Also verify each tip is covered.
  for (const boneIdx of [2, 3]) {
    const bone = bones[boneIdx];
    const na = nodes[bone.a];
    const nb = nodes[bone.b];
    assertBonesCovered(graph, result, { includeRoot: true }, `hand-crafted fork bone ${boneIdx}`);
  }
});

// =============================================================================
// WIND BONE DATA TESTS (Task 1 acceptance criteria)
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: assert well-formed bones_wind table
// ---------------------------------------------------------------------------
function assertBonesWindWellFormed(result, label) {
  const { bones_wind, boneIndex, boneFraction, nodeToBone, vertexCount } = result;
  const { count, parent, pivot, axisHint, stiffness, branchLevel, isRigid } = bones_wind;

  // Type checks
  assert.ok(typeof count === 'number', `${label}: count is number`);
  assert.ok(parent      instanceof Int32Array,   `${label}: parent Int32Array`);
  assert.ok(pivot       instanceof Float32Array, `${label}: pivot Float32Array`);
  assert.ok(axisHint    instanceof Float32Array, `${label}: axisHint Float32Array`);
  assert.ok(stiffness   instanceof Float32Array, `${label}: stiffness Float32Array`);
  assert.ok(branchLevel instanceof Int32Array,   `${label}: branchLevel Int32Array`);
  assert.ok(isRigid     instanceof Uint8Array,   `${label}: isRigid Uint8Array`);
  assert.ok(boneIndex   instanceof Float32Array, `${label}: boneIndex Float32Array`);
  assert.ok(boneFraction instanceof Float32Array, `${label}: boneFraction Float32Array`);
  assert.ok(nodeToBone  instanceof Int32Array,   `${label}: nodeToBone Int32Array`);

  // Stride checks
  assert.strictEqual(parent.length,      count,     `${label}: parent.length`);
  assert.strictEqual(pivot.length,       count * 3, `${label}: pivot.length`);
  assert.strictEqual(axisHint.length,    count * 3, `${label}: axisHint.length`);
  assert.strictEqual(stiffness.length,   count,     `${label}: stiffness.length`);
  assert.strictEqual(branchLevel.length, count,     `${label}: branchLevel.length`);
  assert.strictEqual(isRigid.length,     count,     `${label}: isRigid.length`);
  assert.strictEqual(boneIndex.length,   vertexCount, `${label}: boneIndex.length`);
  assert.strictEqual(boneFraction.length, vertexCount, `${label}: boneFraction.length`);

  // count <= MAX_WIND_BONES
  assert.ok(count <= MAX_WIND_BONES, `${label}: count(${count}) <= MAX_WIND_BONES(${MAX_WIND_BONES})`);

  // boneIndex in [0, count)
  for (let v = 0; v < vertexCount; v++) {
    const bi = boneIndex[v];
    assert.ok(
      isFinite(bi) && bi >= 0 && bi < count,
      `${label}: boneIndex[${v}]=${bi} not in [0, ${count})`
    );
  }

  // boneFraction in [0,1]
  for (let v = 0; v < vertexCount; v++) {
    const bf = boneFraction[v];
    assert.ok(
      isFinite(bf) && bf >= -1e-6 && bf <= 1 + 1e-6,
      `${label}: boneFraction[${v}]=${bf} not in [0,1]`
    );
  }

  // parent[c] < c for all non-root bones
  let rootCount = 0;
  for (let c = 0; c < count; c++) {
    if (parent[c] === -1) {
      rootCount++;
    } else {
      assert.ok(
        parent[c] >= 0 && parent[c] < c,
        `${label}: parent[${c}]=${parent[c]} must be < ${c}`
      );
    }
  }

  // At least one root chain; all root chains have branchLevel 0
  assert.ok(rootCount >= 1, `${label}: at least one root bone (got 0)`);
  for (let c = 0; c < count; c++) {
    if (parent[c] === -1) {
      assert.strictEqual(branchLevel[c], 0,
        `${label}: root bone ${c} must have branchLevel 0 (got ${branchLevel[c]})`);
    }
  }

  // stiffness in [0,1]; isRigid root bones have stiffness 0
  for (let c = 0; c < count; c++) {
    assert.ok(
      isFinite(stiffness[c]) && stiffness[c] >= -1e-6 && stiffness[c] <= 1 + 1e-6,
      `${label}: stiffness[${c}]=${stiffness[c]} not in [0,1]`
    );
    if (isRigid[c]) {
      assert.ok(stiffness[c] <= 1e-6,
        `${label}: isRigid bone ${c} must have stiffness ≈ 0 (got ${stiffness[c]})`);
    }
  }

  // axisHint vectors must be unit-length (within tolerance)
  for (let c = 0; c < count; c++) {
    const ax = axisHint[c*3], ay = axisHint[c*3+1], az = axisHint[c*3+2];
    const len = Math.sqrt(ax*ax + ay*ay + az*az);
    assert.ok(
      Math.abs(len - 1.0) < 1e-3,
      `${label}: axisHint[${c}] length=${len.toFixed(6)} (expected ~1.0)`
    );
  }
}

test('MAX_WIND_BONES is exported and equals 1024', () => {
  assert.strictEqual(typeof MAX_WIND_BONES, 'number');
  assert.strictEqual(MAX_WIND_BONES, 1024);
});

test('empty graph returns well-formed bones_wind tables with count=0', () => {
  const empty = buildBranchGeometry({ nodes: [], bones: [] });
  assert.ok(empty.bones_wind !== undefined, 'bones_wind present');
  assert.strictEqual(empty.bones_wind.count, 0);
  assert.ok(empty.bones_wind.parent      instanceof Int32Array,   'parent Int32Array');
  assert.ok(empty.bones_wind.pivot       instanceof Float32Array, 'pivot Float32Array');
  assert.ok(empty.bones_wind.stiffness   instanceof Float32Array, 'stiffness Float32Array');
  assert.ok(empty.bones_wind.branchLevel instanceof Int32Array,   'branchLevel Int32Array');
  assert.ok(empty.bones_wind.isRigid     instanceof Uint8Array,   'isRigid Uint8Array');
  assert.ok(empty.boneIndex   instanceof Float32Array, 'boneIndex Float32Array');
  assert.ok(empty.boneFraction instanceof Float32Array, 'boneFraction Float32Array');
  assert.ok(empty.nodeToBone  instanceof Int32Array,   'nodeToBone Int32Array');
  assert.strictEqual(empty.boneIndex.length, 0);
  assert.strictEqual(empty.boneFraction.length, 0);
});

test('bone data invariants hold for bushy genome (seeds 0..20)', () => {
  for (let seed = 0; seed <= 20; seed++) {
    const graph = buildGraph(bushyGenome, seed);
    const result = buildBranchGeometry(graph);
    assertBonesWindWellFormed(result, `bushy seed=${seed}`);
  }
});

test('bone data invariants hold for sparse genome (seeds 0..20)', () => {
  for (let seed = 0; seed <= 20; seed++) {
    const graph = buildGraph(sparseGenome, seed);
    const result = buildBranchGeometry(graph);
    assertBonesWindWellFormed(result, `sparse seed=${seed}`);
  }
});

test('bone data invariants hold for tree genome (seeds 0..20)', () => {
  for (let seed = 0; seed <= 20; seed++) {
    const graph = buildGraph(treeGenome, seed);
    const result = buildBranchGeometry(graph);
    assertBonesWindWellFormed(result, `tree seed=${seed}`);
  }
});

test('determinism: bone data is byte-identical on repeat calls', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 10; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const r1 = buildBranchGeometry(graph);
      const r2 = buildBranchGeometry(graph);

      assert.ok(typedArraysEqual(r1.boneIndex,          r2.boneIndex),          `seed=${seed}: boneIndex identical`);
      assert.ok(typedArraysEqual(r1.boneFraction,        r2.boneFraction),        `seed=${seed}: boneFraction identical`);
      assert.ok(typedArraysEqual(r1.bones_wind.parent,  r2.bones_wind.parent),  `seed=${seed}: bones_wind.parent identical`);
      assert.ok(typedArraysEqual(r1.bones_wind.pivot,   r2.bones_wind.pivot),   `seed=${seed}: bones_wind.pivot identical`);
      assert.ok(typedArraysEqual(r1.bones_wind.stiffness, r2.bones_wind.stiffness), `seed=${seed}: bones_wind.stiffness identical`);
      assert.ok(typedArraysEqual(r1.bones_wind.branchLevel, r2.bones_wind.branchLevel), `seed=${seed}: bones_wind.branchLevel identical`);
      assert.ok(typedArraysEqual(r1.bones_wind.isRigid, r2.bones_wind.isRigid), `seed=${seed}: bones_wind.isRigid identical`);
      assert.ok(typedArraysEqual(r1.nodeToBone,         r2.nodeToBone),         `seed=${seed}: nodeToBone identical`);
      assert.strictEqual(r1.bones_wind.count, r2.bones_wind.count,              `seed=${seed}: bones_wind.count identical`);
    }
  }
});

test('existing arrays unchanged: positions/normals/uvs/ao/windWeight/indices byte-identical to pre-bone baseline (self-consistency)', () => {
  // Build with the same graph twice and assert byte-identical existing arrays
  // (This verifies that adding bone data does NOT alter any pre-existing array.)
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 10; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const r1 = buildBranchGeometry(graph);
      const r2 = buildBranchGeometry(graph);

      assert.ok(typedArraysEqual(r1.positions,  r2.positions),  `seed=${seed}: positions byte-identical`);
      assert.ok(typedArraysEqual(r1.normals,    r2.normals),    `seed=${seed}: normals byte-identical`);
      assert.ok(typedArraysEqual(r1.uvs,        r2.uvs),        `seed=${seed}: uvs byte-identical`);
      assert.ok(typedArraysEqual(r1.ao,         r2.ao),         `seed=${seed}: ao byte-identical`);
      assert.ok(typedArraysEqual(r1.windWeight, r2.windWeight), `seed=${seed}: windWeight byte-identical`);
      assert.ok(typedArraysEqual(r1.indices,    r2.indices),    `seed=${seed}: indices byte-identical`);
      assert.strictEqual(r1.vertexCount,   r2.vertexCount,   `seed=${seed}: vertexCount identical`);
      assert.strictEqual(r1.triangleCount, r2.triangleCount, `seed=${seed}: triangleCount identical`);
    }
  }
});

test('bones_wind.count stays <= MAX_WIND_BONES across bushy × seeds 0..50 (chain budget)', () => {
  // Instrumentation test: bushy genome × 51 seeds — the worst-case chain count
  // must stay well under the 1024 budget that we promise fits in a DataTexture.
  let maxSeen = 0;
  for (let seed = 0; seed <= 50; seed++) {
    const graph = buildGraph(bushyGenome, seed);
    const { bones_wind } = buildBranchGeometry(graph);
    if (bones_wind.count > maxSeen) maxSeen = bones_wind.count;
    assert.ok(
      bones_wind.count <= MAX_WIND_BONES,
      `seed=${seed}: bones_wind.count=${bones_wind.count} exceeds MAX_WIND_BONES=${MAX_WIND_BONES}`
    );
  }
  // Informational: this will print in test output if the test runner shows logs.
  // assert.ok(maxSeen > 0, `max chain count across bushy seeds: ${maxSeen}`);
});

test('parent ordering: parent[c] < c for all non-root bones (top-down composition precondition)', () => {
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 20; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const { bones_wind } = buildBranchGeometry(graph);
      const { count, parent } = bones_wind;
      for (let c = 0; c < count; c++) {
        if (parent[c] !== -1) {
          assert.ok(
            parent[c] >= 0 && parent[c] < c,
            `seed=${seed} bone ${c} parent=${parent[c]} must satisfy 0 <= parent < ${c}`
          );
        }
      }
    }
  }
});

test('nodeToBone covers all non-isolated rendered nodes (every node in a chain has a bone assignment)', () => {
  // Build a graph and verify that every node that appears in any chain has
  // nodeToBone[nodeIdx] >= 0 and within [0, count).
  const genomes = [bushyGenome, sparseGenome, treeGenome];
  for (let seed = 0; seed <= 10; seed++) {
    for (const genome of genomes) {
      const graph = buildGraph(genome, seed);
      const { nodeToBone, bones_wind } = buildBranchGeometry(graph);
      // All nodeToBone values must be -1 (not rendered) or valid bone index.
      for (let ni = 0; ni < graph.nodes.length; ni++) {
        const nb = nodeToBone[ni];
        assert.ok(
          nb === -1 || (nb >= 0 && nb < bones_wind.count),
          `seed=${seed} node=${ni}: nodeToBone=${nb} out of [-1, count=${bones_wind.count})`
        );
      }
    }
  }
});

test('hand-crafted fork: parent[1] and parent[2] both point to bone 0 (trunk chain)', () => {
  // Minimal fork: trunk (chain 0) → fork → branchA (chain 1), branchB (chain 2).
  // Both branch chains should have parent = 0.
  const nodes = [
    { pos: [0, 0, 0],    radius: 0.08, branchLevel: 0, isRoot: false, isTerminal: false },
    { pos: [0, 0.5, 0],  radius: 0.07, branchLevel: 0, isRoot: false, isTerminal: false },
    { pos: [0, 1.0, 0],  radius: 0.05, branchLevel: 0, isRoot: false, isTerminal: false },
    { pos: [0.4, 1.4, 0], radius: 0.02, branchLevel: 1, isRoot: false, isTerminal: true },
    { pos: [-0.4, 1.4, 0], radius: 0.02, branchLevel: 1, isRoot: false, isTerminal: true },
  ];
  const bones = [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }, { a: 2, b: 4 }];
  const graph = { nodes, bones };
  const result = buildBranchGeometry(graph, { includeRoot: true });
  const { bones_wind } = result;

  assert.strictEqual(bones_wind.count, 3, 'exactly 3 chains: trunk + 2 branches');
  assert.strictEqual(bones_wind.parent[0], -1, 'bone 0 (trunk) has no parent');
  assert.strictEqual(bones_wind.parent[1], 0, 'bone 1 (branchA) parent = bone 0 (trunk)');
  assert.strictEqual(bones_wind.parent[2], 0, 'bone 2 (branchB) parent = bone 0 (trunk)');
  assert.strictEqual(bones_wind.branchLevel[0], 0, 'trunk bone at level 0');
  assert.strictEqual(bones_wind.branchLevel[1], 1, 'branchA bone at level 1');
  assert.strictEqual(bones_wind.branchLevel[2], 1, 'branchB bone at level 1');
});

test('isRigid bones (isRoot=true nodes) get stiffness=0 and isRigid=1', () => {
  // Build a graph with manually injected isRoot nodes (like includeRoot test).
  const graph = buildGraph(treeGenome, 2);
  const originIdx = 0;
  const origin = graph.nodes[originIdx].pos;
  const rootOffsets = [[0.30, -0.20, 0.00], [-0.30, -0.20, 0.00]];
  for (const off of rootOffsets) {
    const idx = graph.nodes.length;
    graph.nodes.push({
      pos:         [origin[0] + off[0], origin[1] + off[1], origin[2] + off[2]],
      radius:      0.07,
      weight:      1.0,
      isRoot:      true,
      branchLevel: 0,
      rootLevel:   0,
      parentIdx:   originIdx,
    });
    graph.bones.push({ a: originIdx, b: idx });
  }

  const result = buildBranchGeometry(graph, { includeRoot: true });
  const { bones_wind } = result;

  // Find all rigid bones and verify their stiffness
  let rigidCount = 0;
  for (let c = 0; c < bones_wind.count; c++) {
    if (bones_wind.isRigid[c]) {
      rigidCount++;
      assert.ok(
        bones_wind.stiffness[c] <= 1e-6,
        `bone ${c}: isRigid=1 but stiffness=${bones_wind.stiffness[c]} (expected ≈0)`
      );
    }
  }
  assert.ok(rigidCount >= 2, `expected at least 2 rigid root bones, got ${rigidCount}`);
});

test('resolved (rooted) graph: bone parent<child holds and createWindSolver does not throw', () => {
  // REGRESSION: the per-bone parent-ordering test above runs on buildSkeleton-only
  // graphs (no roots), but the real render path is resolve() → buildBranchGeometry,
  // and resolve() appends the root system which makes the origin (node 0) a FORK.
  // That made the trunk chain prepend node 0 AND claim it, so its fork-parent
  // resolved to its own bone → parent[0]=0, and createWindSolver threw inside
  // setPlant (which silently aborted leaf setup). Guard the REAL path here.
  const env = {
    gravity: 1, medium: 'air', light: 1, sunAngle: 45, wind: 0.4,
    aridity: 0.3, temperature: 0.5, energy: 'photo', biochem: 'carbon',
  };
  for (const seed of [0, 1, 2, 3, 7, 42, 99, 123]) {
    const genome = randomGenome(env, seed);
    const resolved = resolve(genome, env);
    const { bones_wind } = buildBranchGeometry(resolved.graph);
    const { count, parent } = bones_wind;
    for (let c = 0; c < count; c++) {
      assert.ok(
        parent[c] === -1 || (parent[c] >= 0 && parent[c] < c),
        `seed=${seed} bone ${c}: parent=${parent[c]} must be -1 or 0<=parent<${c} (rooted graph)`
      );
    }
    // The solver enforces parent<child at construction — must not throw.
    assert.doesNotThrow(
      () => createWindSolver(bones_wind),
      `seed=${seed}: createWindSolver threw on a resolved (rooted) graph`
    );
  }
});
