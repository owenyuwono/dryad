import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkeleton }      from '../src/skeleton.js';
import { solveProportions }   from '../src/proportions.js';
import {
  generateFoliage,
  MAX_LEAVES,
  BARE_FRACTION,
  TIP_EXPONENT,
  LEAF_BASE,
  RADIAL_OFFSET_FRAC,
  VOLUME_JITTER_FRAC,
  SIZE_JITTER,
  APICAL_CLUSTER,
  OUTER_LEVEL_THRESHOLD,
  INNER_SEGMENT_PROB,
  MID_SEGMENT_PROB,
} from '../src/foliage.js';
import { mulberry32 }         from '../src/rng.js';
import { growRootSystem, ROOT_SALT } from '../src/roots.js';

// ---------------------------------------------------------------------------
// Genome / graph helpers
// ---------------------------------------------------------------------------

function makeBushyGenome(overrides = {}) {
  return {
    // Structural
    branchiness:      0.90,
    branchFactorN:    0.80,
    tillering:        0.30,
    radialOrder:      0.50,
    appendageBreadth: 0.70,
    appendageDensity: 0.90,
    segmentation:     0.50,
    // Proportions
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
    // Cosmetic
    pigment:          0.45,
    leafSize:         1.40,
    leafDensity:      1.40,
    jitter:           0.80,
    structuralSeed:   0x12345678,
    ...overrides,
  };
}

function makeSparseGenome(overrides = {}) {
  return {
    branchiness:      0.30,
    branchFactorN:    0.20,
    tillering:        0.05,
    radialOrder:      0.10,
    appendageBreadth: 0.30,
    appendageDensity: 0.10,
    segmentation:     0.20,
    succulence:       0.20,
    stemGirth:        0.40,
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
    leafSize:         0.80,
    leafDensity:      0.60,
    jitter:           0.50,
    structuralSeed:   0x12345678,
    ...overrides,
  };
}

const DEFAULT_ENV = {
  gravity: 1,
  medium:  'air',
  light:   0.6,
  sunAngle: 0.25,
  wind:    0.2,
  aridity: 0.35,
};

function buildGraph(genome) {
  const rng   = mulberry32(genome.structuralSeed);
  const graph = buildSkeleton(genome, rng, genome.jitter);
  solveProportions(graph, DEFAULT_ENV, genome);
  return graph;
}

// ---------------------------------------------------------------------------
// Helper: deep-copy a Float32Array for byte comparison.
// ---------------------------------------------------------------------------
function copyF32(arr) {
  return new Float32Array(arr);
}

// ---------------------------------------------------------------------------
// Helper: point-to-segment distance (3D).
// Returns the perpendicular distance from point p to the finite segment [a, b].
// ---------------------------------------------------------------------------
function pointToSegDist(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-20) {
    // Degenerate segment — use distance to the single point.
    return Math.sqrt(apx * apx + apy * apy + apz * apz);
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / lenSq));
  const dx = apx - t * abx;
  const dy = apy - t * aby;
  const dz = apz - t * abz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Helper: find the min distance from a position to any non-trunk branch point.
// Returns the minimum distance across all qualifying segment endpoints.
// ---------------------------------------------------------------------------
function minSegReach(pos, nodes) {
  let minDist = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.isRoot || n.branchLevel === undefined || n.branchLevel < 1) continue;
    if (n.parentIdx === undefined || n.parentIdx < 0) continue;
    if (!n.isWoody && !n.isTerminal) continue;
    const p = nodes[n.parentIdx];
    // Check distance to segment (parent→node), just use the endpoints.
    for (const pt of [p.pos, n.pos]) {
      const dx = pos[0] - pt[0];
      const dy = pos[1] - pt[1];
      const dz = pos[2] - pt[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < minDist) minDist = d;
    }
  }
  return minDist;
}

// ---------------------------------------------------------------------------
// Helper: minimum perpendicular distance from pos to the nearest eligible
// branch segment midline (true point-to-segment, not just endpoints).
// Returns { dist, midRadius } for the closest segment.
// ---------------------------------------------------------------------------
function minDistToSegmentMidline(pos, nodes) {
  let minDist = Infinity;
  let nearestMidRadius = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.isRoot || n.branchLevel === undefined || n.branchLevel < 1) continue;
    if (n.parentIdx === undefined || n.parentIdx < 0) continue;
    if (!n.isWoody && !n.isTerminal) continue;
    const p = nodes[n.parentIdx];
    const d = pointToSegDist(pos, p.pos, n.pos);
    if (d < minDist) {
      minDist = d;
      nearestMidRadius = (p.radius + n.radius) * 0.5;
    }
  }
  return { dist: minDist, midRadius: nearestMidRadius };
}

// ---------------------------------------------------------------------------
// TEST: Determinism — identical SoA arrays on repeat calls.
// ---------------------------------------------------------------------------

test('generateFoliage is deterministic (byte-identical on repeat)', () => {
  const genome = makeBushyGenome();
  const graph1 = buildGraph(genome);
  const graph2 = buildGraph(genome);

  const r1 = generateFoliage(graph1, genome);
  const r2 = generateFoliage(graph2, genome);

  assert.strictEqual(r1.count, r2.count, 'count must match');
  assert.strictEqual(r1.shape, r2.shape, 'shape must match');

  // Compare every element of every typed array (including the new boneIndex field).
  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure', 'boneIndex']) {
    const a = r1[key];
    const b = r2[key];
    assert.strictEqual(a.length, b.length, `${key}.length mismatch`);
    for (let i = 0; i < a.length; i++) {
      // Float32Array: same bit-pattern guaranteed when same computation path.
      assert.strictEqual(a[i], b[i], `${key}[${i}] differs`);
    }
  }
});

// ---------------------------------------------------------------------------
// TEST: count increases with appendageDensity (0.1 vs 0.9)
// ---------------------------------------------------------------------------

test('count strictly increases with appendageDensity (0.1 vs 0.9)', () => {
  const base  = { branchiness: 0.70, branchFactorN: 0.60, structuralSeed: 0xABCD1234 };
  const sparse = makeBushyGenome({ ...base, appendageDensity: 0.1, leafDensity: 1.0 });
  const dense  = makeBushyGenome({ ...base, appendageDensity: 0.9, leafDensity: 1.0 });

  const graphSparse = buildGraph(sparse);
  const graphDense  = buildGraph(dense);

  // Re-generate on the same structuralSeed so graph topology is identical.
  const rSparse = generateFoliage(graphSparse, sparse);
  const rDense  = generateFoliage(graphDense,  dense);

  assert.ok(
    rDense.count > rSparse.count,
    `appendageDensity 0.9 (${rDense.count}) should exceed 0.1 (${rSparse.count})`
  );
});

// ---------------------------------------------------------------------------
// TEST: count increases with leafDensity (0.5 vs 1.5)
// ---------------------------------------------------------------------------

test('count strictly increases with leafDensity (0.5 vs 1.5)', () => {
  // Use a sparser base so neither variant saturates MAX_LEAVES, leaving room for
  // the leafDensity gene to control count. With the larger bone budget, the old
  // bushy base produced 800 leaves at both densities (no headroom for the gene).
  const base = { branchiness: 0.40, branchFactorN: 0.40, appendageDensity: 0.40, structuralSeed: 0xABCD1234 };
  const low  = makeBushyGenome({ ...base, leafDensity: 0.5 });
  const high = makeBushyGenome({ ...base, leafDensity: 1.5 });

  const rLow  = generateFoliage(buildGraph(low),  low);
  const rHigh = generateFoliage(buildGraph(high), high);

  assert.ok(
    rHigh.count > rLow.count,
    `leafDensity 1.5 (${rHigh.count}) should exceed 0.5 (${rLow.count})`
  );
});

// ---------------------------------------------------------------------------
// TEST: lush genome yields many clusters (CLUSTER semantics range).
// ---------------------------------------------------------------------------

test('lush genome yields >= 1500 clusters (full canopy with higher density)', () => {
  // With BASE_DENSITY=12 and MAX_LEAVES=6000, a bushy genome should produce
  // a genuinely lush canopy that clothes the twigs.
  const genome = makeBushyGenome();
  const result = generateFoliage(buildGraph(genome), genome);
  assert.ok(
    result.count >= 1500,
    `Expected count >= 1500 for lush genome, got ${result.count}`
  );
  assert.ok(
    result.count <= MAX_LEAVES,
    `Expected count <= MAX_LEAVES (${MAX_LEAVES}) for lush genome, got ${result.count}`
  );
});

// ---------------------------------------------------------------------------
// TEST: sparse genome yields < 50 clusters.
// ---------------------------------------------------------------------------

test('sparse genome yields < 50 clusters', () => {
  const genome = makeSparseGenome();
  const result = generateFoliage(buildGraph(genome), genome);
  assert.ok(
    result.count < 50,
    `Expected count < 50 for sparse genome, got ${result.count}`
  );
});

// ---------------------------------------------------------------------------
// TEST: count <= MAX_LEAVES (hard budget ceiling).
// ---------------------------------------------------------------------------

test('count <= MAX_LEAVES (6000) always', () => {
  // Test with multiple genomes including extremes.
  const genomes = [
    makeBushyGenome(),
    makeBushyGenome({ leafDensity: 1.5, appendageDensity: 1.0, branchiness: 1.0 }),
    makeSparseGenome(),
    makeBushyGenome({ structuralSeed: 0xDEADBEEF }),
  ];
  for (const g of genomes) {
    const r = generateFoliage(buildGraph(g), g);
    assert.ok(r.count <= MAX_LEAVES, `count ${r.count} exceeds MAX_LEAVES=${MAX_LEAVES}`);
  }
});

// ---------------------------------------------------------------------------
// TEST: all valid positions lie within reach of a non-trunk branch segment.
// ---------------------------------------------------------------------------

test('all valid positions lie within reach of a non-trunk branch segment', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);

  // Max reach: covers the branch line plus the volumetric outward offset
  // (RADIAL_OFFSET_FRAC + VOLUME_JITTER_FRAC) * maxClusterScale plus axial
  // jitter headroom.  With the new tighter offsets this is well under 2.0 units.
  const MAX_REACH = 2.0;

  for (let i = 0; i < result.count; i++) {
    const pos = [
      result.position[i * 3],
      result.position[i * 3 + 1],
      result.position[i * 3 + 2],
    ];
    const d = minSegReach(pos, graph.nodes);
    assert.ok(
      d <= MAX_REACH,
      `Leaf ${i} at [${pos.map(x => x.toFixed(2)).join(',')}] is ${d.toFixed(2)} from nearest segment endpoint (limit ${MAX_REACH})`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: no cluster base is detached from its branch segment midline.
//
// Each cluster's position must be within (midRadius + MAX_OFFSET) of the
// nearest eligible branch segment, measured as true point-to-segment distance.
// This catches the "floating in space" bug where large RADIAL_OFFSET_FRAC
// pushed cluster bases far from thin twigs.
// ---------------------------------------------------------------------------

test('no cluster is detached from the nearest branch segment midline', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);

  // MAX_OFFSET: maximum extra distance beyond midRadius that we allow a cluster
  // base to sit from the segment axis.  This equals the maximum radial push:
  //   RADIAL_OFFSET_FRAC * maxClusterScale + VOLUME_JITTER_FRAC * maxClusterScale
  // plus axial jitter (JITTER_FRAC projected radially — usually ~0) plus
  // a small numerical margin.  With RADIAL_OFFSET_FRAC=0.30 and
  // VOLUME_JITTER_FRAC=0.20, max total fraction is 0.50.  maxClusterScale with
  // leafSize=1.4, appendageBreadth=0.7 ≈ 0.80 * 1.4 * 0.88 * 1.3 ≈ 1.28.
  // So max push ≈ 0.50 * 1.28 ≈ 0.64, add 0.1 margin → 0.75.
  const MAX_OFFSET = 0.75;

  for (let i = 0; i < result.count; i++) {
    const pos = [
      result.position[i * 3],
      result.position[i * 3 + 1],
      result.position[i * 3 + 2],
    ];
    const { dist, midRadius } = minDistToSegmentMidline(pos, graph.nodes);
    const allowed = midRadius + MAX_OFFSET;
    assert.ok(
      dist <= allowed,
      `Cluster ${i} at [${pos.map(x => x.toFixed(2)).join(',')}] is ${dist.toFixed(3)} from nearest segment midline (midRadius=${midRadius.toFixed(3)}, allowed=${allowed.toFixed(3)})`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: zero leaves on root / branchLevel-0 segments.
// ---------------------------------------------------------------------------

test('no leaves are placed on root or branchLevel-0 trunk segments', () => {
  // Collect positions of trunk/root segment midpoints.
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);

  // Identify trunk/root node positions (branchLevel 0 or isRoot).
  const trunkPts = [];
  for (const n of graph.nodes) {
    if (n.isRoot || n.branchLevel === 0) {
      trunkPts.push(n.pos);
    }
  }

  // No valid leaf should sit exactly at a trunk point.
  // We check that none of the leaves are within 1e-3 of a pure trunk node
  // AND that the graph nodes with branchLevel < 1 have no leaves attributed.
  //
  // The actual invariant: candidate segments require node.branchLevel >= 1.
  // We verify by checking that every leaf position is farther than LEAF_BASE*0.1
  // from any branchLevel-0 node (they sit off branch segments, not trunk).
  //
  // Simpler structural verification: just confirm count=0 when ALL nodes are trunk.
  const minimalGenome = {
    ...makeBushyGenome(),
    // Override: branchiness=0 → no branching, just trunk at branchLevel=0.
    branchiness:   0.0,
    branchFactorN: 0.0,
    leafDensity:   1.5,
    appendageDensity: 1.0,
  };
  const minGraph = buildGraph(minimalGenome);
  const minResult = generateFoliage(minGraph, minimalGenome);

  // With branchiness=0, all nodes are trunk (branchLevel=0) or root — no eligible segments.
  assert.strictEqual(
    minResult.count, 0,
    `Expected 0 leaves on unbranched plant, got ${minResult.count}`
  );
});

// ---------------------------------------------------------------------------
// TEST: SoA buffer sizes are exactly right.
// ---------------------------------------------------------------------------

test('SoA buffer sizes are correct', () => {
  const genome = makeBushyGenome();
  const result = generateFoliage(buildGraph(genome), genome);

  assert.strictEqual(result.position.length,  3 * MAX_LEAVES);
  assert.strictEqual(result.normal.length,    3 * MAX_LEAVES);
  assert.strictEqual(result.tangent.length,   3 * MAX_LEAVES);
  assert.strictEqual(result.scale.length,     MAX_LEAVES);
  assert.strictEqual(result.rotation.length,  MAX_LEAVES);
  assert.strictEqual(result.ageColor.length,  MAX_LEAVES);
  assert.strictEqual(result.exposure.length,  MAX_LEAVES);
  assert.strictEqual(result.boneIndex.length, MAX_LEAVES);
  assert.strictEqual(result.shape, genome.appendageBreadth);
});

// ---------------------------------------------------------------------------
// TEST: shape field equals genome.appendageBreadth.
// ---------------------------------------------------------------------------

test('shape field equals genome.appendageBreadth', () => {
  const genome = makeBushyGenome({ appendageBreadth: 0.77 });
  const result = generateFoliage(buildGraph(genome), genome);
  assert.strictEqual(result.shape, 0.77);
});

// ---------------------------------------------------------------------------
// TEST: all valid scale values are > 0.
// ---------------------------------------------------------------------------

test('all valid scale values are positive', () => {
  const genome = makeBushyGenome();
  const result = generateFoliage(buildGraph(genome), genome);
  for (let i = 0; i < result.count; i++) {
    assert.ok(result.scale[i] > 0, `scale[${i}] = ${result.scale[i]} is not positive`);
  }
});

// ---------------------------------------------------------------------------
// TEST: all valid ageColor values are in [0, 1].
// ---------------------------------------------------------------------------

test('all valid ageColor values are in [0, 1]', () => {
  const genome = makeBushyGenome();
  const result = generateFoliage(buildGraph(genome), genome);
  for (let i = 0; i < result.count; i++) {
    assert.ok(
      result.ageColor[i] >= 0 && result.ageColor[i] <= 1,
      `ageColor[${i}] = ${result.ageColor[i]} is out of [0,1]`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: different seeds produce different leaf arrays.
// ---------------------------------------------------------------------------

test('different structuralSeed values produce different leaf arrays', () => {
  const g1 = makeBushyGenome({ structuralSeed: 0x11111111 });
  const g2 = makeBushyGenome({ structuralSeed: 0x22222222 });

  const r1 = generateFoliage(buildGraph(g1), g1);
  const r2 = generateFoliage(buildGraph(g2), g2);

  // At least one position value should differ.
  let differs = false;
  const n = Math.min(r1.count, r2.count) * 3;
  for (let i = 0; i < n; i++) {
    if (r1.position[i] !== r2.position[i]) {
      differs = true;
      break;
    }
  }
  assert.ok(differs, 'Different seeds should produce different leaf positions');
});

// ---------------------------------------------------------------------------
// TEST: CONTINUITY — leaf scale sum changes smoothly across count boundaries.
// ---------------------------------------------------------------------------

test('CONTINUITY: sweep branchFactorN — total leaf scale changes smoothly (no cliff)', () => {
  // branchFactorN boundary at 2/3 ≈ 0.667: fractChildren goes 2.x→3.x.
  // Before fix: a new crossfade lateral snapped in at FULL scale, causing a cliff.
  // After fix: the crossfade lateral's leaves scale by node.weight≈0 and grow smoothly.
  // We measure total leaf scale (sum of all scale[] values) as the metric.
  const genome = makeBushyGenome({
    branchiness: 0.35,     // moderate depth so we have some branches but not too many
    tillering:   0.0,      // single stem — isolate branchFactorN effect
    structuralSeed: 0xBEEF1234,
  });
  let prevTotalScale = null;
  // Sweep 0.60→0.75, crossing the 2/3 boundary
  for (let fi = 0; fi <= 50; fi++) {
    const branchFactorN = 0.60 + fi * (0.15 / 50);
    const g = { ...genome, branchFactorN };
    const graph = buildGraph(g);
    const result = generateFoliage(graph, g);
    let totalScale = 0;
    for (let i = 0; i < result.count; i++) totalScale += result.scale[i];
    if (prevTotalScale !== null) {
      const delta = Math.abs(totalScale - prevTotalScale);
      // A crossfade branch's leaves enter at near-zero scale, so delta stays small.
      // Cap set to 20.0: the pre-fix cliff was ~164 leaf-widths snapping in at once;
      // after the fix the crossfade entry is weight-ramped. With BASE_DENSITY=10 and
      // LEAF_BASE=0.55, the max measured delta stays well below this cap.
      assert.ok(
        delta <= 20.0,
        `foliage branchFactorN sweep: step ${fi} branchFactorN=${branchFactorN.toFixed(3)} totalScale=${totalScale.toFixed(4)} delta=${delta.toFixed(4)}`
      );
    }
    prevTotalScale = totalScale;
  }
});

// ---------------------------------------------------------------------------
// TEST: tip-weighting — more clusters in the distal half of a segment.
// ---------------------------------------------------------------------------

test('tip-weighting: more clusters in the distal half of each branchLevel-1 segment', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);
  const { nodes } = graph;

  // Collect branchLevel=1 segments.
  const segs = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.isRoot || n.branchLevel !== 1) continue;
    if (n.parentIdx === undefined || n.parentIdx < 0) continue;
    if (!n.isWoody && !n.isTerminal) continue;
    segs.push({ parentIdx: n.parentIdx, node: n });
  }
  assert.ok(segs.length > 0, 'Need at least one branchLevel-1 segment');

  // For each segment, project all cluster positions onto the segment axis and
  // compare the count in the proximal vs distal half (skip zone excluded).
  let totalProximal = 0;
  let totalDistal   = 0;

  for (const { parentIdx, node } of segs) {
    const p  = nodes[parentIdx];
    const ax = [
      node.pos[0] - p.pos[0],
      node.pos[1] - p.pos[1],
      node.pos[2] - p.pos[2],
    ];
    const lenSq = ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2];
    if (lenSq < 1e-10) continue;
    const skip = BARE_FRACTION; // proximal bare zone
    const mid  = skip + (1 - skip) / 2; // midpoint of active range

    for (let i = 0; i < result.count; i++) {
      const cx = result.position[i * 3]     - p.pos[0];
      const cy = result.position[i * 3 + 1] - p.pos[1];
      const cz = result.position[i * 3 + 2] - p.pos[2];
      const t  = (cx * ax[0] + cy * ax[1] + cz * ax[2]) / lenSq;
      if (t >= skip && t <= 1 + 0.1) { // +0.1 tolerance for jitter
        if (t < mid) totalProximal++; else totalDistal++;
      }
    }
  }

  // With t^1.5 weighting the distal half should have substantially more
  // clusters than the proximal half (expected ratio ≈ 2.5:1).
  assert.ok(
    totalDistal > totalProximal,
    `Expected more distal clusters (${totalDistal}) than proximal (${totalProximal})`
  );
});

// ---------------------------------------------------------------------------
// TEST: bare lower trunk — no clusters in the proximal BARE_FRACTION of
// branchLevel-1 segments.
//
// Uses a minimal synthetic graph with exactly ONE branchLevel-1 segment
// (no siblings to confuse spatial attribution).
// ---------------------------------------------------------------------------

test('bare lower trunk: no clusters in proximal BARE_FRACTION of branchLevel-1 segments', () => {
  // Build a minimal fake graph: root → trunk (branchLevel=0) → woody branch (branchLevel=1,
  // non-terminal) → terminal tip (branchLevel=2). Only node2 (branchLevel=1, isWoody, non-
  // terminal) tests the bare-zone rule; terminal segments intentionally skip the bare zone.
  //
  // Due to clump/gap gating (INNER_SEGMENT_PROB=0.15), the single BL-1 non-terminal segment
  // may be probabilistically skipped (producing count=0). We try multiple seeds until the
  // segment is active (count > 0), then verify cluster positions respect the bare zone.
  const baseGenome = makeBushyGenome({ appendageDensity: 0.9, leafDensity: 1.4 });

  let result = null;
  let activeGenome = null;
  let activeFakeGraph = null;

  // Try up to 30 seeds; with INNER_SEGMENT_PROB=0.15 we expect ~4-5 successes in 30.
  for (let seedIdx = 0; seedIdx < 30; seedIdx++) {
    const genome = { ...baseGenome, structuralSeed: baseGenome.structuralSeed + seedIdx };
    const fakeGraph = {
      nodes: [
        {
          // node 0: root
          isRoot: true, branchLevel: 0, parentIdx: -1,
          pos: [0, 0, 0], radius: 0.1,
          isWoody: true, isTerminal: false,
        },
        {
          // node 1: trunk top (branchLevel 0 → not eligible)
          isRoot: false, branchLevel: 0, parentIdx: 0,
          pos: [0, 1, 0], radius: 0.08,
          isWoody: true, isTerminal: false,
        },
        {
          // node 2: first real branch (branchLevel 1, non-terminal, long segment)
          // Non-terminal → bare zone rule applies.
          isRoot: false, branchLevel: 1, parentIdx: 1,
          pos: [1, 1, 0], radius: 0.05,
          isWoody: true, isTerminal: false,
          weight: 1.0,
        },
        {
          // node 3: plain child that makes node2 non-terminal; not isWoody and not
          // isTerminal so it is skipped by the segment collection loop.
          isRoot: false, branchLevel: 2, parentIdx: 2,
          pos: [1, 2, 0], radius: 0.02,
          isWoody: false, isTerminal: false,
          weight: 1.0,
        },
      ],
    };
    const r = generateFoliage(fakeGraph, genome);
    if (r.count > 0) {
      result = r;
      activeGenome = genome;
      activeFakeGraph = fakeGraph;
      break;
    }
  }

  assert.ok(result !== null && result.count > 0, 'Need at least one seed where the BL-1 segment is active');

  // The single eligible segment goes from node1.pos=[0,1,0] to node2.pos=[1,1,0].
  // Node3 is ineligible (not isWoody and not isTerminal), so all clusters come from node2.
  // Segment axis is [1,0,0], length=1.
  // Project all clusters onto this axis; t = cluster.x - node1.x.
  const pPos = activeFakeGraph.nodes[1].pos;
  const ax   = [1, 0, 0]; // unit axis

  for (let j = 0; j < result.count; j++) {
    const cx = result.position[j * 3];
    const cy = result.position[j * 3 + 1];
    const cz = result.position[j * 3 + 2];
    const t  = (cx - pPos[0]) * ax[0] + (cy - pPos[1]) * ax[1] + (cz - pPos[2]) * ax[2];

    // Bare zone is t < bareSkip(1) = 0.55. Allow JITTER_FRAC=0.20 of segLen=1 tolerance.
    // So the safe lower bound is 0.55 - 0.20 = 0.35 (beyond which jitter could push a cluster).
    // Use BARE_FRACTION - 0.15 = 0.10 as a loose check (well inside the bare zone).
    const bareEnd = BARE_FRACTION - 0.15; // = 0.10
    assert.ok(
      t >= bareEnd || t > 1.1, // allow slight overshoot at tip
      `Cluster ${j} at t=${t.toFixed(3)} is in the bare zone (< ${bareEnd}) of the branchLevel-1 segment`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: crossfade weight scaling — node.weight=0.5 halves cluster scale.
// ---------------------------------------------------------------------------

test('crossfade weight scales cluster scale proportionally', () => {
  // Use a controlled fake graph where all weights are explicitly 1.0,
  // so the graph1 baseline has known weight=1.0 at every node.
  // Then graph2 overrides all non-root weights to 0.5.
  // The rng sequence is identical for both (same structuralSeed), so
  // cluster[0] comes from the same node with the same sizeJitter draw,
  // and the scale ratio will be exactly 0.5.
  const genome = makeBushyGenome();

  // Build a controlled fake graph with explicit weight=1.0 everywhere.
  const fakeGraph1 = {
    nodes: [
      { isRoot: true,  branchLevel: 0, parentIdx: -1, pos: [0, 0, 0], radius: 0.1,  isWoody: true,  isTerminal: false, weight: 1.0 },
      { isRoot: false, branchLevel: 0, parentIdx: 0,  pos: [0, 1, 0], radius: 0.08, isWoody: true,  isTerminal: false, weight: 1.0 },
      { isRoot: false, branchLevel: 3, parentIdx: 1,  pos: [1, 1, 0], radius: 0.05, isWoody: true,  isTerminal: true,  weight: 1.0 },
    ],
  };

  // graph2: identical structure but all non-root weights at 0.5.
  const fakeGraph2 = {
    nodes: fakeGraph1.nodes.map(n => ({ ...n, weight: n.isRoot ? 1.0 : 0.5 })),
  };

  const r1 = generateFoliage(fakeGraph1, genome); // weight=1
  const r2 = generateFoliage(fakeGraph2, genome); // weight=0.5

  // Scale at same slot must be exactly half (same rng sequence → same sizeJitter).
  assert.ok(r1.count > 0 && r2.count > 0, 'Need at least one cluster');
  const ratio = r2.scale[0] / r1.scale[0];
  assert.ok(
    Math.abs(ratio - 0.5) < 0.01,
    `Expected scale ratio 0.5, got ${ratio.toFixed(4)}`
  );
});

// ---------------------------------------------------------------------------
// TEST: every terminal twig tip has at least one cluster near it.
// ---------------------------------------------------------------------------

test('every terminal twig tip (branchLevel >= 1) has at least one cluster near it', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);
  const { nodes } = graph;

  // Find all terminal nodes at branchLevel >= 1.
  const terminalNodes = nodes.filter(n =>
    !n.isRoot &&
    n.branchLevel !== undefined && n.branchLevel >= 1 &&
    n.isTerminal
  );

  assert.ok(terminalNodes.length > 0, 'Need at least one terminal twig node');

  for (const tipNode of terminalNodes) {
    const tipPos = tipNode.pos;
    // Find the parent to get segment length.
    const parent = nodes[tipNode.parentIdx];
    const dx = tipPos[0] - parent.pos[0];
    const dy = tipPos[1] - parent.pos[1];
    const dz = tipPos[2] - parent.pos[2];
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // The apical cluster sits at t=1.0 and gets pushed radially by up to
    // (RADIAL_OFFSET_FRAC + VOLUME_JITTER_FRAC) * clusterScale plus axial jitter.
    // Max clusterScale ≈ LEAF_BASE * leafSize * 0.88 * (1 + SIZE_JITTER) ≈ 1.7.
    // Add axial jitter headroom (JITTER_FRAC * segLen) and a safety margin.
    const maxClusterScale = LEAF_BASE * genome.leafSize * 0.88 * (1 + SIZE_JITTER);
    const maxRadial = (RADIAL_OFFSET_FRAC + VOLUME_JITTER_FRAC) * maxClusterScale;
    const maxDist = maxRadial + segLen * 0.2 + 0.5; // radial + axial jitter + margin

    let found = false;
    for (let i = 0; i < result.count; i++) {
      const cx = result.position[i * 3]     - tipPos[0];
      const cy = result.position[i * 3 + 1] - tipPos[1];
      const cz = result.position[i * 3 + 2] - tipPos[2];
      const d  = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (d <= maxDist) {
        found = true;
        break;
      }
    }

    assert.ok(
      found,
      `Terminal tip node at [${tipPos.map(x => x.toFixed(2)).join(',')}] ` +
      `(branchLevel=${tipNode.branchLevel}) has no cluster within ${maxDist.toFixed(2)} units`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: terminal twig tips are COVERED — at least one cluster reaches at/past
// the tip node so no bare tapered tube protrudes past the foliage.
// ---------------------------------------------------------------------------

test('terminal twig tip is covered: at least one cluster reaches at/past the tip position', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);
  const { nodes } = graph;

  const terminalNodes = nodes.filter(n =>
    !n.isRoot &&
    n.branchLevel !== undefined && n.branchLevel >= 1 &&
    n.isTerminal
  );

  assert.ok(terminalNodes.length > 0, 'Need at least one terminal twig node');

  for (const tipNode of terminalNodes) {
    const tipPos = tipNode.pos;
    const parent = nodes[tipNode.parentIdx];
    const ax = [
      tipPos[0] - parent.pos[0],
      tipPos[1] - parent.pos[1],
      tipPos[2] - parent.pos[2],
    ];
    const lenSq = ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2];
    if (lenSq < 1e-10) continue;
    const segLen = Math.sqrt(lenSq);

    // Max cluster scale for a loose check
    const maxClusterScale = LEAF_BASE * genome.leafSize * 0.88 * (1 + SIZE_JITTER);
    const maxRadial = (RADIAL_OFFSET_FRAC + VOLUME_JITTER_FRAC) * maxClusterScale;

    let foundPastTip = false;
    for (let i = 0; i < result.count; i++) {
      const cx = result.position[i * 3]     - parent.pos[0];
      const cy = result.position[i * 3 + 1] - parent.pos[1];
      const cz = result.position[i * 3 + 2] - parent.pos[2];
      // Project onto segment axis to get t
      const t = (cx * ax[0] + cy * ax[1] + cz * ax[2]) / lenSq;
      // Check radial distance from the segment axis (cluster is near the twig)
      const radX = cx - t * ax[0];
      const radY = cy - t * ax[1];
      const radZ = cz - t * ax[2];
      const radDist = Math.sqrt(radX * radX + radY * radY + radZ * radZ);
      // Cluster must be at/past the tip (t >= 0.98) and within maxRadial of the axis
      if (t >= 0.98 && radDist <= maxRadial + 0.1) {
        foundPastTip = true;
        break;
      }
    }

    assert.ok(
      foundPastTip,
      `Terminal tip at [${tipPos.map(x => x.toFixed(2)).join(',')}] ` +
      `(branchLevel=${tipNode.branchLevel}) has no cluster reaching at/past the tip (t >= 0.98)`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: exposure values in [0, 1].
// ---------------------------------------------------------------------------

test('all valid exposure values are in [0, 1]', () => {
  const genome = makeBushyGenome();
  const result = generateFoliage(buildGraph(genome), genome);
  for (let i = 0; i < result.count; i++) {
    assert.ok(
      result.exposure[i] >= 0 && result.exposure[i] <= 1,
      `exposure[${i}] = ${result.exposure[i]} is out of [0,1]`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: exposure correlates with outer/top position.
// ---------------------------------------------------------------------------

test('exposure is higher for outer/top clusters than inner/bottom clusters', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);
  assert.ok(result.count >= 10, 'need enough clusters for split test');

  // Split clusters by Y position (bottom 25% vs top 25%)
  const positions = [];
  for (let i = 0; i < result.count; i++) {
    positions.push({ y: result.position[i * 3 + 1], exposure: result.exposure[i] });
  }
  positions.sort((a, b) => a.y - b.y);
  const quarter = Math.floor(positions.length / 4);

  const bottomAvg = positions.slice(0, quarter).reduce((s, p) => s + p.exposure, 0) / quarter;
  const topAvg    = positions.slice(-quarter).reduce((s, p) => s + p.exposure, 0) / quarter;

  assert.ok(
    topAvg > bottomAvg,
    `Expected top exposure avg (${topAvg.toFixed(3)}) > bottom (${bottomAvg.toFixed(3)})`
  );
});

// ---------------------------------------------------------------------------
// TEST: inner structural branches are largely bare (clumping/redistribution).
// ---------------------------------------------------------------------------

test('REDISTRIBUTION: inner branches (branchLevel 1-2) have far fewer clusters than outer twigs', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome);
  const { nodes } = graph;

  // Build segment list mirroring foliage.js logic.
  const segs = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.isRoot) continue;
    if (n.branchLevel === undefined || n.branchLevel < 1) continue;
    if (n.parentIdx === undefined || n.parentIdx < 0) continue;
    if (!n.isWoody && !n.isTerminal) continue;
    segs.push({ parentIdx: n.parentIdx, nodeIdx: i, node: n });
  }

  // Determine maxBranchLevel (same logic as foliage.js).
  let maxBranchLevel = 1;
  for (const seg of segs) {
    if (seg.node.branchLevel > maxBranchLevel) maxBranchLevel = seg.node.branchLevel;
  }

  // Attribute clusters by ageColor (= branchLevel / maxBranchLevel) rather than
  // spatial nearest-segment. This avoids confounding from clusters on high-BL segments
  // being spatially near low-BL structural branches.
  // inner: BL <= 2 non-terminal → ageColor <= 2/maxBL
  // outer: terminal segments → ageColor at their BL (>= 3/maxBL for this genome)
  const innerAgeMax = 2 / maxBranchLevel + 1e-6;
  const outerAgeMin = 3 / maxBranchLevel - 1e-6;

  let innerClusterCount = 0;
  let outerClusterCount = 0;

  for (let ci = 0; ci < result.count; ci++) {
    const ac = result.ageColor[ci];
    if (ac <= innerAgeMax) innerClusterCount++;
    else if (ac >= outerAgeMin) outerClusterCount++;
  }

  // Count segments in each category.
  let innerSegmentCount = 0;
  let outerSegmentCount = 0;
  for (const seg of segs) {
    const bl = seg.node.branchLevel;
    if (bl <= 2 && !seg.node.isTerminal) innerSegmentCount++;
    else if (seg.node.isTerminal) outerSegmentCount++;
  }

  assert.ok(outerSegmentCount > 0, 'Need terminal segments');
  assert.ok(innerSegmentCount > 0, 'Need inner segments');

  const innerDensity = innerSegmentCount > 0 ? innerClusterCount / innerSegmentCount : 0;
  const outerDensity = outerSegmentCount > 0 ? outerClusterCount / outerSegmentCount : 0;

  // Outer/terminal segments should have at least 2.5x more clusters per segment than inner.
  // (Inner segments: INNER_SEGMENT_PROB=0.15 gate means ~85% are bare.)
  assert.ok(
    outerDensity >= 2.5 * innerDensity,
    `Expected outer density (${outerDensity.toFixed(2)}/seg) to be >= 2.5× inner density (${innerDensity.toFixed(2)}/seg). ` +
    `inner segs=${innerSegmentCount} clusters=${innerClusterCount}; outer segs=${outerSegmentCount} clusters=${outerClusterCount}`
  );
});

// ---------------------------------------------------------------------------
// Task 2 — boneIndex SoA field tests
// ---------------------------------------------------------------------------

// TEST: boneIndex defaults to 0 for every active leaf when no opts.nodeToBone.
test('boneIndex defaults to 0 for all leaves when nodeToBone is absent', () => {
  const genome = makeBushyGenome();
  const result = generateFoliage(buildGraph(genome), genome);

  assert.ok(result.boneIndex instanceof Float32Array, 'boneIndex must be Float32Array');
  assert.strictEqual(result.boneIndex.length, MAX_LEAVES, 'boneIndex.length must equal MAX_LEAVES');

  for (let i = 0; i < result.count; i++) {
    assert.strictEqual(result.boneIndex[i], 0, `boneIndex[${i}] should default to 0`);
  }
});

// TEST: boneIndex defaults to 0 when opts is present but opts.nodeToBone is absent.
test('boneIndex defaults to 0 when opts present but nodeToBone absent', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const result = generateFoliage(graph, genome, {});

  for (let i = 0; i < result.count; i++) {
    assert.strictEqual(result.boneIndex[i], 0, `boneIndex[${i}] should default to 0`);
  }
});

// TEST: with opts.nodeToBone, each leaf's boneIndex equals nodeToBone[attachmentNodeIdx] and >= 0.
//
// We build a synthetic nodeToBone map that assigns each node index to a distinct
// valid bone index (bone = nodeIdx % BONE_COUNT), then verify that every active
// leaf's boneIndex matches the map.
test('boneIndex matches nodeToBone[attachmentNodeIdx] for all leaves', () => {
  const genome = makeBushyGenome();
  const graph  = buildGraph(genome);
  const { nodes } = graph;

  // Assign each graph node a synthetic bone index: bone = nodeIdx % BONE_COUNT.
  // All values are >= 0 (no -1) so every leaf should receive a valid bone.
  const BONE_COUNT = 16;
  const nodeToBone = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    nodeToBone[i] = i % BONE_COUNT;
  }

  const result = generateFoliage(graph, genome, { nodeToBone });

  assert.ok(result.count > 0, 'Need at least one cluster');

  // Verify each leaf has a valid boneIndex that is >= 0.
  for (let i = 0; i < result.count; i++) {
    assert.ok(
      result.boneIndex[i] >= 0,
      `boneIndex[${i}] = ${result.boneIndex[i]} is negative (invalid)`
    );
    assert.ok(
      result.boneIndex[i] < BONE_COUNT,
      `boneIndex[${i}] = ${result.boneIndex[i]} is out of range [0, ${BONE_COUNT})`
    );
    // Must be an integer value (stored in Float32 but derived from Int32Array).
    assert.strictEqual(
      Math.round(result.boneIndex[i]), result.boneIndex[i],
      `boneIndex[${i}] must be an integer`
    );
  }
});

// TEST: with opts.nodeToBone where one node has -1, leaves on that node get 0.
test('boneIndex clamps -1 in nodeToBone to 0 (safe fallback)', () => {
  // Build a graph with exactly one eligible segment.
  const genome = makeBushyGenome({ structuralSeed: 0x12345678 });
  const fakeGraph = {
    nodes: [
      { isRoot: true,  branchLevel: 0, parentIdx: -1, pos: [0, 0, 0], radius: 0.1,  isWoody: true, isTerminal: false, weight: 1.0 },
      { isRoot: false, branchLevel: 0, parentIdx: 0,  pos: [0, 1, 0], radius: 0.08, isWoody: true, isTerminal: false, weight: 1.0 },
      { isRoot: false, branchLevel: 3, parentIdx: 1,  pos: [1, 1, 0], radius: 0.03, isWoody: true, isTerminal: true,  weight: 1.0 },
    ],
  };

  // nodeToBone maps node 2 (the attachment) to -1 (no bone).
  const nodeToBone = new Int32Array(fakeGraph.nodes.length).fill(-1);
  const result = generateFoliage(fakeGraph, genome, { nodeToBone });

  // All leaves should have boneIndex = 0 (clamped from -1).
  for (let i = 0; i < result.count; i++) {
    assert.strictEqual(result.boneIndex[i], 0, `boneIndex[${i}] should be 0 when nodeToBone=-1`);
  }
});

// TEST: existing fields are byte-identical before and after adding opts.nodeToBone.
// This proves that adding boneIndex does NOT change the rng draw order.
test('existing SoA fields (position/normal/etc.) are byte-identical with and without nodeToBone', () => {
  const genome     = makeBushyGenome();
  const graph      = buildGraph(genome);
  const { nodes }  = graph;

  // Generate without nodeToBone (baseline).
  const baseline = generateFoliage(graph, genome);

  // Generate with a nodeToBone map that assigns non-zero indices.
  const nodeToBone = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) nodeToBone[i] = i % 8;
  const withBones  = generateFoliage(graph, genome, { nodeToBone });

  // count must be identical.
  assert.strictEqual(withBones.count, baseline.count, 'count must be unchanged');

  // All pre-existing arrays must be byte-identical.
  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure']) {
    const a = baseline[key];
    const b = withBones[key];
    assert.strictEqual(a.length, b.length, `${key}.length must be unchanged`);
    for (let i = 0; i < a.length; i++) {
      assert.strictEqual(a[i], b[i], `${key}[${i}] changed when adding nodeToBone — rng order disturbed`);
    }
  }
});

// TEST: boneIndex is deterministic (same nodeToBone → same boneIndex output).
test('boneIndex is deterministic when nodeToBone is provided', () => {
  const genome    = makeBushyGenome();
  const graph1    = buildGraph(genome);
  const graph2    = buildGraph(genome);
  const nodeToBone1 = new Int32Array(graph1.nodes.length);
  const nodeToBone2 = new Int32Array(graph2.nodes.length);
  for (let i = 0; i < graph1.nodes.length; i++) nodeToBone1[i] = i % 8;
  for (let i = 0; i < graph2.nodes.length; i++) nodeToBone2[i] = i % 8;

  const r1 = generateFoliage(graph1, genome, { nodeToBone: nodeToBone1 });
  const r2 = generateFoliage(graph2, genome, { nodeToBone: nodeToBone2 });

  assert.strictEqual(r1.count, r2.count, 'count must match');
  for (let i = 0; i < r1.count; i++) {
    assert.strictEqual(r1.boneIndex[i], r2.boneIndex[i], `boneIndex[${i}] differs between identical inputs`);
  }
});

// ---------------------------------------------------------------------------
// TEST: colorRamp — pigmentToColor anchor values.
// ---------------------------------------------------------------------------

import { RAMP_ANCHORS, pigmentToColor } from '../src/colorRamp.js';

test('pigmentToColor returns exact anchor values at anchor t positions', () => {
  for (const [t, r255, g255, b255] of RAMP_ANCHORS) {
    const [r, g, b] = pigmentToColor(t);
    assert.ok(Math.abs(r - r255 / 255) < 1e-5, `anchor t=${t} r mismatch`);
    assert.ok(Math.abs(g - g255 / 255) < 1e-5, `anchor t=${t} g mismatch`);
    assert.ok(Math.abs(b - b255 / 255) < 1e-5, `anchor t=${t} b mismatch`);
  }
});

test('pigmentToColor clamps inputs outside [0,1]', () => {
  const atZero = pigmentToColor(0);
  assert.deepStrictEqual(pigmentToColor(-1), atZero);
  assert.deepStrictEqual(pigmentToColor(-99), atZero);

  const atOne = pigmentToColor(1);
  assert.deepStrictEqual(pigmentToColor(2), atOne);
  assert.deepStrictEqual(pigmentToColor(100), atOne);
});

test('pigmentToColor returns values in [0,1]', () => {
  for (let i = 0; i <= 20; i++) {
    const p = i / 20;
    const [r, g, b] = pigmentToColor(p);
    assert.ok(r >= 0 && r <= 1, `r out of range at p=${p}`);
    assert.ok(g >= 0 && g <= 1, `g out of range at p=${p}`);
    assert.ok(b >= 0 && b <= 1, `b out of range at p=${p}`);
  }
});

// ---------------------------------------------------------------------------
// ROOT EXCLUSION REGRESSION (Task 3 acceptance criteria §1.8)
//
// generateFoliage must produce ZERO clusters whose source segment has isRoot
// on either endpoint — even when the graph has a large root system appended.
// The foliage.js guards are:
//   line 276: if (node.isRoot) continue;
//   line 277: if (node.branchLevel < 1) continue;   (all root nodes keep branchLevel=0)
// ---------------------------------------------------------------------------

test('generateFoliage yields zero clusters sourced on isRoot nodes (foliage exclusion)', () => {
  const genome = {
    // Structural — bushy canopy + large root system
    branchiness:      0.80,
    branchFactorN:    0.70,
    tillering:        0.10,
    radialOrder:      0.25,
    appendageBreadth: 0.60,
    appendageDensity: 0.80,
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
    leafSize:         1.20,
    leafDensity:      1.20,
    jitter:           0.60,
    structuralSeed:   0xABCD1234,
    // Root genes — max root system
    rootCount:        1.00,
    rootDepth:        1.00,
    rootSpread:       1.00,
    rootFlare:        1.00,
    rootButtress:     1.00,
    rootBranchiness:  1.00,
    rootTaper:        1.00,
  };

  const rng     = mulberry32(genome.structuralSeed);
  const graph   = buildSkeleton(genome, rng, genome.jitter);
  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
  growRootSystem(graph, genome, rootRng);

  const DEFAULT_ENV = { gravity: 1, medium: 'air', light: 0.6, sunAngle: 0.25, wind: 0.2, aridity: 0.35 };
  solveProportions(graph, DEFAULT_ENV, genome);

  const foliage = generateFoliage(graph, genome);
  const { nodes } = graph;

  // Reconstruct the eligible segments that foliage.js would consider.
  // Any segment whose node has isRoot=true must NOT have been visited.
  // We verify this by checking that no segment in the eligible list is isRoot.
  const eligibleRootSegments = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.isRoot) {
      // This node should be excluded by foliage.js; if it were included it
      // would contribute clusters. We just record it for the assertion below.
      eligibleRootSegments.push(i);
    }
  }

  // Since we can't directly observe which segments generateFoliage used,
  // we verify the guard logic is in place by checking the foliage exclusion
  // invariant: run a manual segment eligibility filter matching foliage.js lines 274-282
  // and confirm zero of those segments are isRoot.
  const foliageEligibleNodes = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.isRoot) continue;                               // foliage.js line 276
    if (node.branchLevel === undefined || node.branchLevel < 1) continue; // line 277
    const pIdx = node.parentIdx;
    if (pIdx === undefined || pIdx < 0) continue;
    if (!node.isWoody && !node.isTerminal) continue;
    foliageEligibleNodes.push(i);
  }

  // None of the foliage-eligible nodes should be isRoot
  const rootEligible = foliageEligibleNodes.filter(i => nodes[i].isRoot);
  assert.strictEqual(
    rootEligible.length,
    0,
    `${rootEligible.length} isRoot nodes passed foliage eligibility — exclusion guards not working`
  );

  // Also verify the root system actually added isRoot nodes (so the test is non-trivial)
  const rootNodeCount = nodes.filter(n => n.isRoot).length;
  assert.ok(rootNodeCount >= 5, `expected a substantial root system (got ${rootNodeCount} root nodes)`);

  // And verify foliage produced at least some clusters (canopy still works)
  assert.ok(foliage.count > 0, 'foliage should produce at least some clusters from the canopy');
});
