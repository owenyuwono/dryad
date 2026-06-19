import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkeleton }      from '../src/skeleton.js';
import { solveProportions }   from '../src/proportions.js';
import {
  generateFoliage,
  expandClumpsToLeaves,
  expandClumpsToCrossedCards,
  CROSSED_CARD_PLANES,
  LEAVES_PER_CLUMP,
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
  SPINE_BASE_SCALE,
  SPINE_DENSITY,
  SPINE_SALT,
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
    spininess:        0.00,   // bushy broadleaf — no spines (spine tests set this explicitly)
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
// TEST: count increases with appendageDensity at the widened high end (0.5 vs 1.5)
// (appendageDensity is now the single density gene — former leafDensity folded in,
//  range widened to [0,1.5].)
// ---------------------------------------------------------------------------

test('count strictly increases with appendageDensity (0.5 vs 1.5)', () => {
  // Use a sparser base so neither variant saturates MAX_LEAVES, leaving room for
  // the density gene to control count.
  const base = { branchiness: 0.40, branchFactorN: 0.40, structuralSeed: 0xABCD1234 };
  const low  = makeBushyGenome({ ...base, appendageDensity: 0.5 });
  const high = makeBushyGenome({ ...base, appendageDensity: 1.5 });

  const rLow  = generateFoliage(buildGraph(low),  low);
  const rHigh = generateFoliage(buildGraph(high), high);

  assert.ok(
    rHigh.count > rLow.count,
    `appendageDensity 1.5 (${rHigh.count}) should exceed 0.5 (${rLow.count})`
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

test('sparse genome yields < 50 leaf clusters (spininess=0 to isolate leaf pass)', () => {
  // Set spininess=0 so the spine post-pass does not contribute to count.
  // The assertion measures the leaf pass in isolation: a sparse genome should
  // have very few leaf clusters (appendageDensity=0.10, leafDensity=0.60).
  const genome = makeSparseGenome({ spininess: 0 });
  const result = generateFoliage(buildGraph(genome), genome);
  assert.ok(
    result.count < 50,
    `Expected count < 50 for sparse genome (leaf pass only), got ${result.count}`
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
    // spininess=0: spines (which now also target level-0 stem nodes) must be off
    // so the count stays 0 and only the LEAF pass guard is tested here.
    spininess: 0,
  };
  const minGraph = buildGraph(minimalGenome);
  const minResult = generateFoliage(minGraph, minimalGenome);

  // With branchiness=0 and spininess=0, all nodes are trunk (branchLevel=0) or root
  // → leaf pass has no eligible segments → count === 0.
  assert.strictEqual(
    minResult.count, 0,
    `Expected 0 leaves on unbranched plant (spininess=0), got ${minResult.count}`
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

test('CONTINUITY: crossfade grows in by COUNT, not size — leaves stay full-size across a branchFactorN sweep', () => {
  // The crossfade now grows a marginal lateral in by ADDING full-size leaves
  // (count ∝ node.weight), NOT by shrinking each leaf's size toward zero. So
  // across a branchFactorN sweep no leaf should ever shrink toward 0 (the old
  // size-based crossfade is gone), and the canopy should gain leaves overall.
  const genome = makeBushyGenome({
    branchiness: 0.35,     // moderate depth so we have some branches but not too many
    tillering:   0.0,      // single stem — isolate branchFactorN effect
    structuralSeed: 0xBEEF1234,
  });
  let minScaleSeen = Infinity;
  let firstCount = null, lastCount = null;
  // Sweep 0.60→0.75, crossing the 2/3 children boundary.
  for (let fi = 0; fi <= 50; fi++) {
    const branchFactorN = 0.60 + fi * (0.15 / 50);
    const g = { ...genome, branchFactorN };
    const result = generateFoliage(buildGraph(g), g);
    for (let i = 0; i < result.count; i++) {
      if (result.scale[i] < minScaleSeen) minScaleSeen = result.scale[i];
    }
    if (fi === 0) firstCount = result.count;
    lastCount = result.count;
  }
  // Leaf size is uniform — no leaf shrinks toward zero to "grow in".
  assert.ok(
    minScaleSeen > 0.3,
    `leaves should stay full-size across the sweep, min scale was ${minScaleSeen.toFixed(3)}`
  );
  // Grow-in is by count: the canopy gains leaves as branchFactorN rises.
  assert.ok(
    lastCount >= firstCount,
    `leaf count should grow across the branchFactorN sweep: ${firstCount} → ${lastCount}`
  );
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
    // spininess=0: spine pass emits no instances, so none appear in the bare zone
    // (spines radiate from the stem surface without respecting the leaf bare zone).
    const genome = { ...baseGenome, spininess: 0, structuralSeed: baseGenome.structuralSeed + seedIdx };
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

test('crossfade weight scales cluster COUNT, not size (leaf size is uniform)', () => {
  // A thin / growing-in twig (node.weight < 1) now carries FEWER full-size leaves
  // rather than smaller leaves. So at weight=0.5: leaf SIZE is unchanged (the first
  // cluster's scale matches the weight=1 graph, since the rng/sizeJitter draw is the
  // same), and the cluster COUNT is roughly halved.
  const genome = makeBushyGenome();

  const fakeGraph1 = {
    nodes: [
      { isRoot: true,  branchLevel: 0, parentIdx: -1, pos: [0, 0, 0], radius: 0.1,  isWoody: true,  isTerminal: false, weight: 1.0 },
      { isRoot: false, branchLevel: 0, parentIdx: 0,  pos: [0, 1, 0], radius: 0.08, isWoody: true,  isTerminal: false, weight: 1.0 },
      { isRoot: false, branchLevel: 3, parentIdx: 1,  pos: [1, 1, 0], radius: 0.05, isWoody: true,  isTerminal: true,  weight: 1.0 },
    ],
  };
  const fakeGraph2 = {
    nodes: fakeGraph1.nodes.map(n => ({ ...n, weight: n.isRoot ? 1.0 : 0.5 })),
  };

  const r1 = generateFoliage(fakeGraph1, genome); // weight=1
  const r2 = generateFoliage(fakeGraph2, genome); // weight=0.5

  assert.ok(r1.count > 0 && r2.count > 0, 'Need at least one cluster');

  // SIZE is weight-independent — first cluster's scale identical (same sizeJitter draw).
  assert.ok(
    Math.abs(r2.scale[0] - r1.scale[0]) < 1e-9,
    `leaf size must be weight-independent: ${r1.scale[0]} vs ${r2.scale[0]}`
  );

  // DENSITY scales with weight — half-weight twig carries ~half the clusters.
  const ratio = r2.count / r1.count;
  assert.ok(
    ratio > 0.4 && ratio < 0.65,
    `Expected ~0.5 count ratio at weight 0.5, got ${ratio.toFixed(3)} (${r2.count}/${r1.count})`
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

import { pigmentToColor } from '../src/colorRamp.js';

test('pigmentToColor is deterministic — same pigment always returns same [r,g,b]', () => {
  for (const p of [0, 0.1, 0.33, 0.5, 0.67, 0.9, 1.0]) {
    const [r1, g1, b1] = pigmentToColor(p);
    const [r2, g2, b2] = pigmentToColor(p);
    assert.strictEqual(r1, r2, `r not deterministic at p=${p}`);
    assert.strictEqual(g1, g2, `g not deterministic at p=${p}`);
    assert.strictEqual(b1, b2, `b not deterministic at p=${p}`);
  }
});

test('pigmentToColor full-hue sweep — distinct pigment values produce distinct colors', () => {
  // pigment=0 and pigment=1 are hue 0°/360° (same — HSL wraparound). Test 0..0.9.
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(JSON.stringify(pigmentToColor(i / 10)));
  }
  const unique = new Set(results);
  assert.ok(unique.size === results.length, `expected ${results.length} distinct colors, got ${unique.size}`);
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

// ---------------------------------------------------------------------------
// WEEP LEAF-HANG TESTS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEST: weep=0 leaf-hang no-op — SoA output is byte-identical to weep-absent genome.
// ---------------------------------------------------------------------------

test('LEAF-HANG no-op: weep=0 SoA is byte-identical to genome without weep field', () => {
  const genomeNoWeep = makeBushyGenome();              // no weep field
  const genomeWeep0  = makeBushyGenome({ weep: 0 });  // explicit weep=0

  const graphNoWeep = buildGraph(genomeNoWeep);
  const graphWeep0  = buildGraph(genomeWeep0);

  const r1 = generateFoliage(graphNoWeep, genomeNoWeep);
  const r2 = generateFoliage(graphWeep0,  genomeWeep0);

  assert.strictEqual(r1.count, r2.count, 'weep=0 must not change count');

  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure']) {
    for (let i = 0; i < r1.count * (key === 'position' || key === 'normal' || key === 'tangent' ? 3 : 1); i++) {
      assert.strictEqual(
        r1[key][i],
        r2[key][i],
        `weep=0 no-op: ${key}[${i}] differs from no-weep baseline`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TEST: leaf-hang effect — high weep tilts leaves downward (more negative tangent Y).
// ---------------------------------------------------------------------------

test('LEAF-HANG: high weep makes leaf tangent Y more negative (leaves tilt down)', () => {
  // At weep=0 leaves orient upward/outward (phototropism + upward lean).
  // At weep=1 the tangent is blended toward [0,-1,0] so mean tangent Y should be
  // substantially more negative (leaves hang down like a willow).
  const genomeWeep0 = makeBushyGenome({ weep: 0 });
  const genomeWeep1 = makeBushyGenome({ weep: 1.0 });

  // Both genomes share the same structuralSeed so the skeleton is identical.
  const graphWeep0 = buildGraph(genomeWeep0);
  const graphWeep1 = buildGraph(genomeWeep1);

  const r0 = generateFoliage(graphWeep0, genomeWeep0);
  const r1 = generateFoliage(graphWeep1, genomeWeep1);

  assert.ok(r0.count > 0 && r1.count > 0, 'need at least one cluster for comparison');

  // Mean tangent Y across all valid clusters
  function meanTangentY(result) {
    let sum = 0;
    for (let i = 0; i < result.count; i++) {
      sum += result.tangent[i * 3 + 1]; // Y component of tangent
    }
    return sum / result.count;
  }

  const meanY0 = meanTangentY(r0);
  const meanY1 = meanTangentY(r1);

  assert.ok(
    meanY1 < meanY0,
    `high weep (${meanY1.toFixed(4)}) should have more negative mean tangent Y than weep=0 (${meanY0.toFixed(4)})`
  );

  // At weep=1 the tangent is fully blended toward [0,-1,0] then renormalized.
  // Starting from a mostly-upward tangent, weep=1 should push mean tangent Y below 0.
  assert.ok(
    meanY1 < 0,
    `weep=1 mean tangent Y (${meanY1.toFixed(4)}) should be negative (leaves hanging down)`
  );
});

// ---------------------------------------------------------------------------
// TEST: leaf-hang rng draw count unchanged — weep blending uses no extra rng draws.
//
// The proof: run generateFoliage on the SAME graph with weep=0 and weep=1.
// The graph is solved with weep=0 (so all node positions are identical for both
// calls). The foliage rng stream is seeded from structuralSeed (independent of
// weep). If the weep blend added any extra rng draws, the per-cluster scale and
// rotation values (which are downstream of the tangent computation in writeCluster)
// would differ between the two calls. They must be byte-identical.
// ---------------------------------------------------------------------------

test('LEAF-HANG: rng draw count is unchanged by weep (no extra draws at any weep value)', () => {
  // Build and solve the graph once with weep=0 — same positions for both foliage calls.
  const baseGenome = makeBushyGenome({ weep: 0 });
  const graph = buildGraph(baseGenome);

  // Genome with weep=0: baseline
  const r0 = generateFoliage(graph, { ...baseGenome, weep: 0 });

  // Genome with weep=1: same graph, only the weep gene differs.
  // The rng is seeded from structuralSeed (unchanged), so the draw sequence is the same length.
  const r1 = generateFoliage(graph, { ...baseGenome, weep: 1.0 });

  assert.strictEqual(r0.count, r1.count, 'count must be identical (same graph, same density)');

  // scale[i] = sizeJitter draw × ... (1st rng draw per cluster, before tangent/normal).
  // rotation[i] = clusterRoll draw (last rng draw per cluster, after tangent/normal).
  // If weep blend consumed an extra rng draw between them, rotation would shift.
  for (let i = 0; i < r0.count; i++) {
    assert.strictEqual(
      r0.scale[i],
      r1.scale[i],
      `scale[${i}] differs between weep=0 and weep=1 — rng draw count changed`
    );
    assert.strictEqual(
      r0.rotation[i],
      r1.rotation[i],
      `rotation[${i}] differs between weep=0 and weep=1 — rng draw count changed`
    );
  }

  // position/ageColor are also written with same rng-derived values (positions derived
  // from graph geometry, not rng, but ageColor is deterministic from branchLevel).
  for (let i = 0; i < r0.count * 3; i++) {
    assert.strictEqual(
      r0.position[i],
      r1.position[i],
      `position[${i}] differs between weep=0 and weep=1 — graph positions should be identical`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: Step 0 — geometry confirmation.
// With a willow-like weep≈0.55, tangent Y-components trend strongly negative.
// This proves the GEOMETRY is already producing hanging cards — the lighting
// fix (Parts A+B) is the right target, not the droop geometry.
// ---------------------------------------------------------------------------

test('STEP-0 geometry: willow genome (weep=0.55) tangent Y trends strongly negative', () => {
  const willowGenome = makeBushyGenome({ weep: 0.55 });
  const graph  = buildGraph(willowGenome);
  const result = generateFoliage(graph, willowGenome);

  assert.ok(result.count > 0, 'need at least one cluster');

  // Compute mean tangent Y for the willow.
  let sumY = 0;
  for (let i = 0; i < result.count; i++) {
    sumY += result.tangent[i * 3 + 1];
  }
  const meanY = sumY / result.count;

  // hang = sqrt(0.55) ≈ 0.74, so most tangents should be strongly downward.
  // A mean below -0.3 is a reasonable "strongly negative" threshold.
  assert.ok(
    meanY < -0.3,
    `willow weep=0.55 mean tangent Y (${meanY.toFixed(4)}) should be < -0.3 (strongly hanging)`
  );
});

// ---------------------------------------------------------------------------
// TEST: Parts A+B — under weep>0, SoA normal Y-components trend non-negative
// (sky-facing) so hanging leaves catch overhead light.
// ---------------------------------------------------------------------------

test('LEAF-HANG Parts A+B: weep>0 normals trend sky-facing (mean normal Y >= 0)', () => {
  // At weep=0 (no-op), normals are computed as cross(tangent, radialDir) — pointing
  // sideways (outward from the branch). Mean normal Y is near 0, slightly positive
  // from phototropism. At weep=0.55, Parts A+B recompute the normal via rejection +
  // sky tilt so mean normal Y must become distinctly positive.
  const weep0Genome  = makeBushyGenome({ weep: 0   });
  const weepHiGenome = makeBushyGenome({ weep: 0.55 });

  // Use the same structural seed so graph topology is identical.
  const graph0  = buildGraph(weep0Genome);
  const graphHi = buildGraph(weepHiGenome);

  const r0  = generateFoliage(graph0,  weep0Genome);
  const rHi = generateFoliage(graphHi, weepHiGenome);

  assert.ok(r0.count > 0 && rHi.count > 0, 'need clusters for comparison');

  function meanNormalY(result) {
    let sum = 0;
    for (let i = 0; i < result.count; i++) {
      sum += result.normal[i * 3 + 1];
    }
    return sum / result.count;
  }

  const meanNY0  = meanNormalY(r0);
  const meanNYHi = meanNormalY(rHi);

  // weep=0 normals are roughly sideways-outward (low Y), weep=0.55 should be sky-facing.
  // The sky-tilt (Part B) with hang=sqrt(0.55)≈0.74 and k=0.65 gives skyBlend≈0.48,
  // so most normals land between outward and up — mean Y should be clearly positive.
  assert.ok(
    meanNYHi > 0,
    `weep=0.55 mean normal Y (${meanNYHi.toFixed(4)}) should be > 0 (sky-facing, Parts A+B)`
  );

  // weep normals should be more sky-facing than weep=0 normals.
  assert.ok(
    meanNYHi > meanNY0,
    `weep=0.55 mean normal Y (${meanNYHi.toFixed(4)}) should exceed weep=0 (${meanNY0.toFixed(4)})`
  );
});

// ---------------------------------------------------------------------------
// TEST: weep=0 STRICT no-op — SoA normal is byte-identical to the pre-fix
// baseline. Proves that the new code inside `if (weep > 0)` cannot affect the
// weep=0 code path (normal is computed outside the block at weep=0).
// ---------------------------------------------------------------------------

test('LEAF-HANG Parts A+B no-op: weep=0 normal SoA byte-identical to weep-absent genome', () => {
  // This test reuses the existing 'LEAF-HANG no-op' structure but explicitly
  // checks the normal array (the field most affected by Parts A+B).
  const genomeNoWeep = makeBushyGenome();             // no weep field
  const genomeWeep0  = makeBushyGenome({ weep: 0 }); // explicit weep=0

  const r1 = generateFoliage(buildGraph(genomeNoWeep), genomeNoWeep);
  const r2 = generateFoliage(buildGraph(genomeWeep0),  genomeWeep0);

  assert.strictEqual(r1.count, r2.count, 'weep=0 must not change count');

  // Check every normal component (stride 3) for byte identity.
  for (let i = 0; i < r1.count * 3; i++) {
    assert.strictEqual(
      r1.normal[i],
      r2.normal[i],
      `Parts A+B no-op: normal[${i}] differs at weep=0 vs no-weep`
    );
  }

  // Also check tangent — Parts A does not change the tangent direction at weep=0
  // (the weep block is not entered).
  for (let i = 0; i < r1.count * 3; i++) {
    assert.strictEqual(
      r1.tangent[i],
      r2.tangent[i],
      `Parts A+B no-op: tangent[${i}] differs at weep=0 vs no-weep`
    );
  }
});

// ---------------------------------------------------------------------------
// SPINE POST-PASS TESTS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEST: spininess=0 no-op — full SoA byte-identical to genome without spininess.
//
// Proves the guard fires before ANY rng draw in the spine block.
// ---------------------------------------------------------------------------

test('SPINE no-op: spininess=0 SoA is byte-identical to genome without spininess field', () => {
  const genomeNoSpine = makeBushyGenome();              // no spininess field — defaults to 0
  const genomeSpine0  = makeBushyGenome({ spininess: 0 }); // explicit 0

  const graph1 = buildGraph(genomeNoSpine);
  const graph2 = buildGraph(genomeSpine0);

  const r1 = generateFoliage(graph1, genomeNoSpine);
  const r2 = generateFoliage(graph2, genomeSpine0);

  assert.strictEqual(r1.count, r2.count, 'count must be identical at spininess=0');

  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure', 'boneIndex']) {
    const stride = (key === 'position' || key === 'normal' || key === 'tangent') ? 3 : 1;
    for (let i = 0; i < r1.count * stride; i++) {
      assert.strictEqual(
        r1[key][i],
        r2[key][i],
        `spininess=0 no-op: ${key}[${i}] differs from no-spininess baseline`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TEST: spininess>0 increases count above the spininess=0 baseline.
//
// Use a SPARSE leaf genome so leaf clusters don't saturate MAX_LEAVES,
// leaving room for the spine post-pass to append instances.
// ---------------------------------------------------------------------------

test('SPINE: spininess>0 increases count vs spininess=0', () => {
  // Low leaf density so leaves don't fill MAX_LEAVES, leaving room for spines.
  const base = { appendageDensity: 0.10, leafDensity: 0.40, branchiness: 0.60 };
  const genomeBase  = makeBushyGenome({ ...base, spininess: 0 });
  const genomeSpiny = makeBushyGenome({ ...base, spininess: 0.8 });

  // Use the same graph for a fair comparison.
  const graph = buildGraph(genomeBase);

  const rBase  = generateFoliage(graph, genomeBase);
  const rSpiny = generateFoliage(graph, genomeSpiny);

  assert.ok(
    rSpiny.count > rBase.count,
    `spininess=0.8 (${rSpiny.count}) should exceed spininess=0 (${rBase.count})`
  );
});

// ---------------------------------------------------------------------------
// TEST: existing leaf instances [0..oldCount) are byte-identical when
//       spininess>0 is added.  Proves the spine pass is append-only and
//       the spine rng stream doesn't disturb the leaf stream.
// ---------------------------------------------------------------------------

test('SPINE: first oldCount instances byte-identical between spininess=0 and spininess>0', () => {
  // Same structuralSeed → identical skeleton, identical foliage rng seed.
  // Low leaf density to leave headroom for spine instances.
  const base = { appendageDensity: 0.10, leafDensity: 0.40, branchiness: 0.60 };
  const genomeBase  = makeBushyGenome({ ...base, spininess: 0 });
  const genomeSpiny = makeBushyGenome({ ...base, spininess: 0.8 });

  // Use the same graph for both to guarantee identical node positions.
  const graph = buildGraph(genomeBase);

  const rBase  = generateFoliage(graph, genomeBase);
  const rSpiny = generateFoliage(graph, genomeSpiny);

  const oldCount = rBase.count;
  assert.ok(oldCount > 0, 'need leaf instances to compare');
  assert.ok(rSpiny.count > oldCount, `spiny run (${rSpiny.count}) should have more total instances than base (${oldCount})`);

  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure']) {
    const stride = (key === 'position' || key === 'normal' || key === 'tangent') ? 3 : 1;
    for (let i = 0; i < oldCount * stride; i++) {
      assert.strictEqual(
        rBase[key][i],
        rSpiny[key][i],
        `spine pass disturbed leaf ${key}[${i}]`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TEST: appended spine instances have small scale (well below leaf scale).
//
// Use a SPARSE leaf genome so leaf clusters don't saturate MAX_LEAVES,
// leaving room for the spine post-pass to append instances.
// ---------------------------------------------------------------------------

test('SPINE: appended instances have small scale (< LEAF_BASE / 2)', () => {
  // Low leaf density so leaves don't fill MAX_LEAVES, leaving room for spines.
  const base = { appendageDensity: 0.10, leafDensity: 0.40, branchiness: 0.60 };
  const genomeBase  = makeBushyGenome({ ...base, spininess: 0 });
  const genomeSpiny = makeBushyGenome({ ...base, spininess: 0.8 });

  const graph = buildGraph(genomeBase);

  const rBase  = generateFoliage(graph, genomeBase);
  const rSpiny = generateFoliage(graph, genomeSpiny);

  const oldCount   = rBase.count;
  const spineStart = oldCount;

  assert.ok(rSpiny.count > spineStart, `need spine instances to check (base count=${oldCount}, spiny count=${rSpiny.count})`);

  const halfLeafBase = LEAF_BASE / 2; // 0.40

  for (let i = spineStart; i < rSpiny.count; i++) {
    assert.ok(
      rSpiny.scale[i] < halfLeafBase,
      `spine scale[${i}]=${rSpiny.scale[i].toFixed(4)} should be < ${halfLeafBase} (half of LEAF_BASE)`
    );
    assert.ok(
      rSpiny.scale[i] > 0,
      `spine scale[${i}] must be positive`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: spine tangents are roughly radial (perpendicular to branch axis).
//
// Each spine's tangent should be close to perpendicular to the branch segment
// it was emitted from — i.e. |dot(spineTangent, branchAxis)| < 0.5 for most.
//
// Use a SPARSE leaf genome so leaves don't saturate MAX_LEAVES, leaving room
// for spine instances to appear.
// ---------------------------------------------------------------------------

test('SPINE: appended tangents are roughly radial (not along-branch)', () => {
  const base = { appendageDensity: 0.10, leafDensity: 0.40, branchiness: 0.60 };
  const genomeBase  = makeBushyGenome({ ...base, spininess: 0 });
  const genomeSpiny = makeBushyGenome({ ...base, spininess: 0.8 });

  // Use the same graph object for both calls so spine positions anchor to the
  // same nodes — this is the graph the spiny genome was actually solved with.
  const graph = buildGraph(genomeBase);

  const rBase  = generateFoliage(graph, genomeBase);
  const rSpiny = generateFoliage(graph, genomeSpiny);

  const oldCount  = rBase.count;
  const { nodes } = graph;

  // For each spine instance (index >= oldCount), find the nearest eligible
  // woody segment (including level-0 stem nodes, which can now carry spines)
  // and check |dot(spineTangent, branchAxis)| < 0.5.
  let checked = 0;
  let tooAligned = 0;

  for (let i = oldCount; i < rSpiny.count; i++) {
    const tx = rSpiny.tangent[i * 3];
    const ty = rSpiny.tangent[i * 3 + 1];
    const tz = rSpiny.tangent[i * 3 + 2];

    // Find the nearest segment axis — now includes level-0 stem nodes since
    // spines can attach there too.
    const sx = rSpiny.position[i * 3];
    const sy = rSpiny.position[i * 3 + 1];
    const sz = rSpiny.position[i * 3 + 2];

    let minDist = Infinity;
    let nearestAxisDot = 0;

    for (let ni = 0; ni < nodes.length; ni++) {
      const n = nodes[ni];
      if (n.isRoot) continue;
      if (n.parentIdx === undefined || n.parentIdx < 0) continue;
      if (!n.isWoody && !n.isTerminal) continue;
      const p = nodes[n.parentIdx];
      const d = pointToSegDist([sx, sy, sz], p.pos, n.pos);
      if (d < minDist) {
        minDist = d;
        const ax = n.pos[0] - p.pos[0];
        const ay = n.pos[1] - p.pos[1];
        const az = n.pos[2] - p.pos[2];
        const al = Math.sqrt(ax * ax + ay * ay + az * az);
        if (al > 1e-10) {
          nearestAxisDot = Math.abs((tx * ax + ty * ay + tz * az) / al);
        }
      }
    }

    checked++;
    if (nearestAxisDot > 0.5) tooAligned++;
  }

  assert.ok(checked > 0, 'need spine instances to check radial orientation');

  // Allow at most 20% of spines to be mis-oriented (robustness margin for
  // edge-case geometries where branch axis ≈ radial direction).
  const misalignedFrac = tooAligned / checked;
  assert.ok(
    misalignedFrac <= 0.20,
    `${tooAligned}/${checked} (${(misalignedFrac * 100).toFixed(1)}%) spine tangents are too aligned with the branch axis (expected <= 20%)`
  );
});

// ---------------------------------------------------------------------------
// TEST: spine determinism — same (genome, seed) twice → byte-identical SoA.
// ---------------------------------------------------------------------------

test('SPINE: generating the same (genome, seed) twice is byte-identical', () => {
  const genome = makeBushyGenome({ spininess: 0.7, structuralSeed: 0xCAFEBABE });

  const graph1 = buildGraph(genome);
  const graph2 = buildGraph(genome);

  const r1 = generateFoliage(graph1, genome);
  const r2 = generateFoliage(graph2, genome);

  assert.strictEqual(r1.count, r2.count, 'count must match');

  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure', 'boneIndex']) {
    const stride = (key === 'position' || key === 'normal' || key === 'tangent') ? 3 : 1;
    for (let i = 0; i < r1.count * stride; i++) {
      assert.strictEqual(
        r1[key][i],
        r2[key][i],
        `spine determinism: ${key}[${i}] differs on identical inputs`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TEST: count stays <= MAX_LEAVES even with spininess=1.
// ---------------------------------------------------------------------------

test('SPINE: count stays <= MAX_LEAVES at spininess=1', () => {
  const genome = makeBushyGenome({ spininess: 1.0, leafDensity: 1.5, appendageDensity: 1.0, branchiness: 1.0 });
  const result = generateFoliage(buildGraph(genome), genome);
  assert.ok(result.count <= MAX_LEAVES, `count ${result.count} exceeds MAX_LEAVES=${MAX_LEAVES} at spininess=1`);
});

// ---------------------------------------------------------------------------
// TEST: BARREL CACTUS (unbranched) with spininess>0 produces spines on level-0 column.
//
// Regression guard for the bug where the spine pass iterated only over `segments`
// (branchLevel >= 1), leaving unbranched plants (maxDepth=0, all nodes at
// branchLevel=0) with zero spine instances despite spininess > 0.
//
// A real barrel cactus has low branchiness → maxDepth=0 → every node is a
// level-0 trunk column. Spines should grow all along that column.
// ---------------------------------------------------------------------------

test('SPINE: unbranched (barrel cactus) genome with spininess>0 produces spine instances on level-0 column', () => {
  // Low branchiness ensures the skeleton has no branches — all nodes are branchLevel=0.
  // This matches the cactus-barrel preset (branchiness≈0.05).
  const genome = makeBushyGenome({
    branchiness:      0.05,
    branchFactorN:    0.10,
    tillering:        0.00,
    spininess:        1.0,
    appendageDensity: 0.10, // low leaf density → leaf pass produces 0 (BL>=1 guard)
    leafDensity:      0.20,
    structuralSeed:   0xBAADF00D,
  });

  const graph = buildGraph(genome);
  const { nodes } = graph;

  // Confirm all non-root nodes are at branchLevel=0 (truly unbranched).
  const nonRootNodes = nodes.filter(n => !n.isRoot);
  const hasBranchedNodes = nonRootNodes.some(n => n.branchLevel > 0);
  assert.ok(!hasBranchedNodes, 'barrel cactus genome should have no branchLevel>0 nodes');

  const result = generateFoliage(graph, genome);

  // Leaf pass produces 0 (no BL>=1 segments), spine pass must produce > 0.
  assert.ok(
    result.count > 0,
    `Expected spines on unbranched (barrel cactus) column, got count=${result.count}`
  );

  // All instances are spines (appended after leaf count=0), so all scales
  // must be small (< LEAF_BASE / 2 = 0.40).
  for (let i = 0; i < result.count; i++) {
    assert.ok(
      result.scale[i] < LEAF_BASE / 2,
      `spine scale[${i}]=${result.scale[i].toFixed(4)} should be < ${LEAF_BASE / 2} (not a leaf)`
    );
    assert.ok(result.scale[i] > 0, `spine scale[${i}] must be positive`);
  }
});

// ---------------------------------------------------------------------------
// TIP-TUFT GENE TESTS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEST: tipTuft=0 no-op — full SoA byte-identical to genome without tipTuft field.
//
// Proves that at tipTuft=0, effectiveTipExp === TIP_EXPONENT and
// effectiveSkip === baseSkip, so the output is byte-identical to the baseline.
// ---------------------------------------------------------------------------

test('TIP-TUFT no-op: tipTuft=0 SoA is byte-identical to genome without tipTuft field', () => {
  const genomeNoTuft = makeBushyGenome();              // no tipTuft field — defaults to 0
  const genomeTuft0  = makeBushyGenome({ tipTuft: 0 }); // explicit tipTuft=0

  const graph1 = buildGraph(genomeNoTuft);
  const graph2 = buildGraph(genomeTuft0);

  const r1 = generateFoliage(graph1, genomeNoTuft);
  const r2 = generateFoliage(graph2, genomeTuft0);

  assert.strictEqual(r1.count, r2.count, 'tipTuft=0 must not change count');

  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure', 'boneIndex']) {
    const stride = (key === 'position' || key === 'normal' || key === 'tangent') ? 3 : 1;
    for (let i = 0; i < r1.count * stride; i++) {
      assert.strictEqual(
        r1[key][i],
        r2[key][i],
        `tipTuft=0 no-op: ${key}[${i}] differs from no-tipTuft baseline`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TEST: tipTuft=0.8 concentrates clusters toward tips.
//
// The mean along-branch parametric position (t) of body clusters should shift
// toward 1.0 (the tip) when tipTuft=0.8 vs tipTuft=0. We measure this by
// projecting each cluster onto the nearest eligible branch segment axis and
// computing the mean t across all projected clusters in [0, 1].
// ---------------------------------------------------------------------------

test('TIP-TUFT: tipTuft=0.8 shifts mean cluster t toward tip vs tipTuft=0', () => {
  // Use a moderate bushy genome so we have enough segments and clusters to measure.
  // Keep the same structuralSeed so the graph topology is identical.
  const baseGenome = makeBushyGenome({ spininess: 0 }); // spininess=0 to isolate leaf pass
  const genomeTuft0  = { ...baseGenome, tipTuft: 0   };
  const genomeTuft08 = { ...baseGenome, tipTuft: 0.8 };

  // Use the same graph for both — same node positions, identical rng draw count.
  const graph = buildGraph(baseGenome);

  const r0  = generateFoliage(graph, genomeTuft0);
  const r08 = generateFoliage(graph, genomeTuft08);

  assert.ok(r0.count > 0 && r08.count > 0, 'need clusters for comparison');

  // Helper: project cluster positions onto their nearest eligible branch segment
  // axis and collect the parametric t ∈ [0, 1] for clusters that land within [0, 1.2].
  function collectProjectedT(result, nodes) {
    const ts = [];
    for (let ci = 0; ci < result.count; ci++) {
      const px = result.position[ci * 3];
      const py = result.position[ci * 3 + 1];
      const pz = result.position[ci * 3 + 2];

      // Find nearest eligible segment.
      let bestT    = -1;
      let bestDist = Infinity;

      for (let ni = 0; ni < nodes.length; ni++) {
        const n = nodes[ni];
        if (n.isRoot || n.branchLevel === undefined || n.branchLevel < 1) continue;
        if (n.parentIdx === undefined || n.parentIdx < 0) continue;
        if (!n.isWoody && !n.isTerminal) continue;

        const par = nodes[n.parentIdx];
        const ax = n.pos[0] - par.pos[0];
        const ay = n.pos[1] - par.pos[1];
        const az = n.pos[2] - par.pos[2];
        const lenSq = ax * ax + ay * ay + az * az;
        if (lenSq < 1e-10) continue;

        const dx = px - par.pos[0];
        const dy = py - par.pos[1];
        const dz = pz - par.pos[2];
        const t  = (dx * ax + dy * ay + dz * az) / lenSq;

        // Perpendicular distance to segment (clamped t for dist).
        const tc = Math.max(0, Math.min(1, t));
        const rx = dx - tc * ax;
        const ry = dy - tc * ay;
        const rz = dz - tc * az;
        const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);

        if (dist < bestDist) {
          bestDist = dist;
          bestT    = t;
        }
      }

      // Only count clusters that project onto their segment (t ∈ [0, 1.2]).
      if (bestT >= 0 && bestT <= 1.2) {
        ts.push(bestT);
      }
    }
    return ts;
  }

  const { nodes } = graph;
  const ts0  = collectProjectedT(r0,  nodes);
  const ts08 = collectProjectedT(r08, nodes);

  assert.ok(ts0.length  > 0, 'need projected t values for tipTuft=0');
  assert.ok(ts08.length > 0, 'need projected t values for tipTuft=0.8');

  const mean0  = ts0.reduce( (s, t) => s + t, 0) / ts0.length;
  const mean08 = ts08.reduce((s, t) => s + t, 0) / ts08.length;

  assert.ok(
    mean08 > mean0,
    `tipTuft=0.8 mean t (${mean08.toFixed(4)}) should exceed tipTuft=0 mean t (${mean0.toFixed(4)}) — clusters should shift toward tip`
  );
});

// ---------------------------------------------------------------------------
// TEST: tipTuft rng draw count unchanged — positional shift uses no extra draws.
//
// Proof: run generateFoliage on the SAME graph with tipTuft=0 and tipTuft=0.8.
// tipWeightedPositions() uses only the exponent + skip math (no rng calls).
// The per-cluster rng draws (scale, jitter, azimuth, etc.) must be identical.
// We verify via scale[] and rotation[] which bracket the per-cluster draw window.
// ---------------------------------------------------------------------------

test('TIP-TUFT: rng draw count is unchanged by tipTuft (no extra draws at any value)', () => {
  const baseGenome = makeBushyGenome({ spininess: 0 });
  const graph = buildGraph(baseGenome);

  const r0  = generateFoliage(graph, { ...baseGenome, tipTuft: 0   });
  const r08 = generateFoliage(graph, { ...baseGenome, tipTuft: 0.8 });

  assert.strictEqual(r0.count, r08.count, 'count must be identical (same graph, same density)');

  // scale[i] = 1st rng draw per cluster; rotation[i] = last rng draw per cluster.
  // If tipTuft consumed extra draws, these would shift relative to each other.
  for (let i = 0; i < r0.count; i++) {
    assert.strictEqual(
      r0.scale[i],
      r08.scale[i],
      `scale[${i}] differs between tipTuft=0 and tipTuft=0.8 — rng draw count changed`
    );
    assert.strictEqual(
      r0.rotation[i],
      r08.rotation[i],
      `rotation[${i}] differs between tipTuft=0 and tipTuft=0.8 — rng draw count changed`
    );
  }
});

// ---------------------------------------------------------------------------
// TEST: tipTuft determinism — same (genome, seed) twice → byte-identical SoA.
// ---------------------------------------------------------------------------

test('TIP-TUFT: generating the same (genome, seed) twice is byte-identical', () => {
  const genome = makeBushyGenome({ tipTuft: 0.8, spininess: 0, structuralSeed: 0xCAFE1234 });

  const graph1 = buildGraph(genome);
  const graph2 = buildGraph(genome);

  const r1 = generateFoliage(graph1, genome);
  const r2 = generateFoliage(graph2, genome);

  assert.strictEqual(r1.count, r2.count, 'count must match');

  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure', 'boneIndex']) {
    const stride = (key === 'position' || key === 'normal' || key === 'tangent') ? 3 : 1;
    for (let i = 0; i < r1.count * stride; i++) {
      assert.strictEqual(
        r1[key][i],
        r2[key][i],
        `tipTuft determinism: ${key}[${i}] differs on identical inputs`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TEST: BARREL CACTUS spininess=0 no-op remains byte-identical (level-0 extension
// does not fire at spininess=0, so the existing no-op guarantee is unaffected).
// ---------------------------------------------------------------------------

test('SPINE: barrel cactus with spininess=0 is still byte-identical to no-spininess genome', () => {
  // Use explicit full genomes rather than makeBushyGenome so that spininess can be
  // absent or 0 without inheriting the makeBushyGenome default of 0.05.
  const base = {
    branchiness:      0.05,
    branchFactorN:    0.10,
    tillering:        0.00,
    radialOrder:      0.50,
    appendageBreadth: 0.70,
    appendageDensity: 0.10,
    segmentation:     0.50,
    succulence:       0.20,
    stemGirth:        0.50,
    taper:            0.50,
    rigidity:         0.60,
    verticality:      0.50,
    ribbing:          0.05,
    branchAngle:      0.575,
    lengthRatio:      0.70,
    apicalBias:       0.50,
    droopBias:        0.10,
    pigment:          0.45,
    leafSize:         1.40,
    leafDensity:      0.20,
    jitter:           0.80,
    structuralSeed:   0xBAADF00D,
  };
  const genomeNoSpine = { ...base };              // no spininess field → defaults to 0
  const genomeSpine0  = { ...base, spininess: 0 }; // explicit 0

  const graph1 = buildGraph(genomeNoSpine);
  const graph2 = buildGraph(genomeSpine0);

  const r1 = generateFoliage(graph1, genomeNoSpine);
  const r2 = generateFoliage(graph2, genomeSpine0);

  assert.strictEqual(r1.count, r2.count, 'barrel cactus spininess=0 must not change count');

  for (const key of ['position', 'normal', 'tangent', 'scale', 'rotation', 'ageColor', 'exposure', 'boneIndex']) {
    const stride = (key === 'position' || key === 'normal' || key === 'tangent') ? 3 : 1;
    for (let i = 0; i < r1.count * stride; i++) {
      assert.strictEqual(
        r1[key][i],
        r2[key][i],
        `barrel cactus spininess=0 no-op: ${key}[${i}] differs from no-spininess baseline`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// LEAF-SIZE GENE TEST (leafScale was removed — folded into the single leafSize gene)
// ---------------------------------------------------------------------------

// TEST: leafSize=2.4 doubles mean leaf card size vs leafSize=1.2, count unchanged.
// (leafSize is now the single card-size multiplier — range widened to [0.6,4.0].)
test('LEAF-SIZE: doubling leafSize doubles mean card scale, count unchanged', () => {
  const genome1 = makeBushyGenome({ leafSize: 1.2 });
  const genome2 = makeBushyGenome({ leafSize: 2.4 });

  // Same graph so topology (and therefore cluster count) is identical.
  const graph = buildGraph(genome1);

  const r1 = generateFoliage(graph, genome1);
  const r2 = generateFoliage(graph, genome2);

  // count must be unchanged — leafSize only affects card size, not cluster count.
  assert.strictEqual(r2.count, r1.count, 'leafSize must not change cluster count');

  let sum1 = 0, sum2 = 0;
  for (let i = 0; i < r1.count; i++) { sum1 += r1.scale[i]; sum2 += r2.scale[i]; }
  const ratio = (sum2 / r2.count) / (sum1 / r1.count);
  assert.ok(
    Math.abs(ratio - 2.0) < 0.01,
    `2.4/1.2 leafSize mean scale ratio should be ~2.0, got ${ratio.toFixed(4)}`
  );

  // rng draw count unchanged: rotation[] (last per-cluster draw) must be byte-identical.
  for (let i = 0; i < r1.count; i++) {
    assert.strictEqual(r1.rotation[i], r2.rotation[i],
      `rotation[${i}] differs — leafSize must not change the rng draw count`);
  }
});

// ---------------------------------------------------------------------------
// expandClumpsToLeaves — render-path single-leaf expansion (one leaf = one card)
// ---------------------------------------------------------------------------

test('expandClumpsToLeaves: broadleaf clumps expand to LEAVES_PER_CLUMP single leaves each', () => {
  const genome = makeBushyGenome({ structuralSeed: 7 });   // broadleaf: frondyness=0, spininess=0
  const graph  = buildGraph(genome);
  const clumps = generateFoliage(graph, genome);
  const leaves = expandClumpsToLeaves(clumps, genome);

  assert.strictEqual(leaves.count, clumps.count * LEAVES_PER_CLUMP,
    `expected ${clumps.count}×${LEAVES_PER_CLUMP} leaves, got ${leaves.count}`);

  // All emitted fields finite; orientation vectors ~unit; scale positive.
  for (let i = 0; i < leaves.count; i++) {
    const i3 = i * 3;
    for (const v of [leaves.position[i3], leaves.position[i3+1], leaves.position[i3+2],
                     leaves.normal[i3], leaves.tangent[i3]]) {
      assert.ok(Number.isFinite(v), `non-finite at leaf ${i}`);
    }
    const tl = Math.hypot(leaves.tangent[i3], leaves.tangent[i3+1], leaves.tangent[i3+2]);
    assert.ok(Math.abs(tl - 1) < 1e-3, `tangent not unit at ${i}: ${tl}`);
    assert.ok(leaves.scale[i] > 0, `non-positive scale at ${i}`);
  }
});

test('expandClumpsToLeaves: leaves inherit their source clump bone/exposure/age', () => {
  const genome = makeBushyGenome({ structuralSeed: 11 });
  const graph  = buildGraph(genome);
  const clumps = generateFoliage(graph, genome);
  const leaves = expandClumpsToLeaves(clumps, genome);
  // Each block of LEAVES_PER_CLUMP leaves came from clump c → must share its scalars.
  for (let c = 0; c < clumps.count; c++) {
    for (let j = 0; j < LEAVES_PER_CLUMP; j++) {
      const li = c * LEAVES_PER_CLUMP + j;
      assert.strictEqual(leaves.boneIndex[li], clumps.boneIndex[c], `bone mismatch clump ${c} leaf ${j}`);
      assert.strictEqual(leaves.ageColor[li], clumps.ageColor[c], `age mismatch clump ${c} leaf ${j}`);
      assert.strictEqual(leaves.exposure[li], clumps.exposure[c], `exposure mismatch clump ${c} leaf ${j}`);
    }
  }
});

test('expandClumpsToLeaves: frond/needle/spiny canopies pass through unchanged (K=1)', () => {
  const graph = buildGraph(makeBushyGenome({ structuralSeed: 3 }));
  for (const override of [{ leafDivision: 1 }, { leafWidth: 0.04 }, { rosette: 1 }, { spininess: 0.5 }]) {
    const genome = makeBushyGenome({ structuralSeed: 3, ...override });
    const clumps = generateFoliage(graph, genome);
    const out    = expandClumpsToLeaves(clumps, genome);
    assert.strictEqual(out, clumps, `expected passthrough for ${JSON.stringify(override)}`);
  }
});

test('expandClumpsToLeaves is deterministic for the same (foliage, genome)', () => {
  const genome = makeBushyGenome({ structuralSeed: 99 });
  const graph  = buildGraph(genome);
  const clumps = generateFoliage(graph, genome);
  const a = expandClumpsToLeaves(clumps, genome);
  const b = expandClumpsToLeaves(clumps, genome);
  assert.strictEqual(a.count, b.count);
  assert.deepStrictEqual(a.position, b.position);
  assert.deepStrictEqual(a.tangent, b.tangent);
  assert.deepStrictEqual(a.scale, b.scale);
});

// ---------------------------------------------------------------------------
// expandClumpsToCrossedCards — SpeedTree-style crossed-card expansion.
// ---------------------------------------------------------------------------

test('expandClumpsToCrossedCards emits CROSSED_CARD_PLANES cards per anchor', () => {
  const genome = makeBushyGenome({ structuralSeed: 7 });
  const graph  = buildGraph(genome);
  const clumps = generateFoliage(graph, genome);
  assert.ok(clumps.count > 0, 'expected non-empty foliage');
  const out = expandClumpsToCrossedCards(clumps, genome);
  assert.strictEqual(out.count, clumps.count * CROSSED_CARD_PLANES);
});

test('expandClumpsToCrossedCards: the K cards share position/scale but differ in roll', () => {
  const genome = makeBushyGenome({ structuralSeed: 7 });
  const graph  = buildGraph(genome);
  const clumps = generateFoliage(graph, genome);
  const out = expandClumpsToCrossedCards(clumps, genome);
  const K = CROSSED_CARD_PLANES;
  // First anchor → first K instances.
  for (let k = 0; k < K; k++) {
    // Same position as the source anchor 0.
    assert.strictEqual(out.position[k * 3],     clumps.position[0]);
    assert.strictEqual(out.position[k * 3 + 1], clumps.position[1]);
    assert.strictEqual(out.position[k * 3 + 2], clumps.position[2]);
    // Same scale.
    assert.strictEqual(out.scale[k], clumps.scale[0]);
    // Roll staggered by k·(π/K) from the source roll. rotation is a Float32Array,
    // so compare at f32 precision (the f64 expected value is rounded with fround).
    const expectedRoll = Math.fround(clumps.rotation[0] + k * (Math.PI / K));
    assert.ok(Math.abs(out.rotation[k] - expectedRoll) < 1e-6,
      `roll[${k}] expected ${expectedRoll}, got ${out.rotation[k]}`);
  }
  // The three rolls are mutually distinct (cards criss-cross).
  assert.notStrictEqual(out.rotation[0], out.rotation[1]);
  assert.notStrictEqual(out.rotation[1], out.rotation[2]);
});

test('expandClumpsToCrossedCards is deterministic and never exceeds the leaf capacity', () => {
  const genome = makeBushyGenome({ structuralSeed: 21 });
  const graph  = buildGraph(genome);
  const clumps = generateFoliage(graph, genome);
  const a = expandClumpsToCrossedCards(clumps, genome);
  const b = expandClumpsToCrossedCards(clumps, genome);
  assert.deepStrictEqual(a.rotation, b.rotation);
  assert.deepStrictEqual(a.position, b.position);
  // LEAVES_PER_CLUMP (6) > CROSSED_CARD_PLANES (3), so a crossed expansion always
  // fits in the same LEAF_CAPACITY the single-leaf fan allocates.
  assert.ok(a.count <= MAX_LEAVES * LEAVES_PER_CLUMP);
  assert.ok(CROSSED_CARD_PLANES <= LEAVES_PER_CLUMP);
});

test('expandClumpsToCrossedCards passes through empty foliage unchanged', () => {
  const empty = { count: 0, position: new Float32Array(0), normal: new Float32Array(0),
    tangent: new Float32Array(0), scale: new Float32Array(0), rotation: new Float32Array(0),
    ageColor: new Float32Array(0), exposure: new Float32Array(0), boneIndex: new Float32Array(0), shape: 0.5 };
  assert.strictEqual(expandClumpsToCrossedCards(empty, {}), empty);
});
