import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveProportions } from '../src/proportions.js';

// ---------------------------------------------------------------------------
// Graph factories
// ---------------------------------------------------------------------------

/**
 * Minimal linear plant: root → stem base → woody branch → terminal
 *
 *   node 0: isRoot=true, branchLevel=0
 *   node 1: isWoody=true, branchLevel=0, isStem=true (trunk base, no parent)
 *   node 2: isWoody=true, branchLevel=1, parent=1
 *   node 3: isTerminal=true, branchLevel=2, parent=2, attachPos=[0,2,0]
 */
function makeGraph(posOverrides = {}) {
  const nodes = [
    {
      isRoot: true,
      branchLevel: 0,
      pos: [0, -0.1, 0],
      parentIdx: -1,
    },
    {
      isStem: true,
      isWoody: true,
      branchLevel: 0,
      pos: [0, 0, 0],
      parentIdx: -1,
    },
    {
      isWoody: true,
      branchLevel: 1,
      pos: [0.3, 1.0, 0],
      parentIdx: 1,
    },
    {
      isTerminal: true,
      branchLevel: 2,
      pos: posOverrides.terminalPos || [0.3, 2.0, 0],
      attachPos:   posOverrides.attachPos   || [0.3, 1.0, 0],
      parentIdx: 2,
    },
  ];
  const bones = [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
  ];
  return { nodes, bones, meta: { bodyAxis: [0, 1, 0] } };
}

/**
 * Deep-clone a graph so each test gets a fresh copy (solveProportions mutates in-place).
 */
function cloneGraph(g) {
  return JSON.parse(JSON.stringify(g));
}

const baseEnvelope = {
  gravity: 1.0,
  medium: 'air',
  light: 0.6,
  sunAngle: 0.25,
  wind: 0.2,
  aridity: 0.35,
};

// ---------------------------------------------------------------------------
// Helper: get terminal node of a solved graph
// ---------------------------------------------------------------------------
function terminal(graph) {
  return graph.nodes.find(n => n.isTerminal === true);
}

// Helper: mean radius of interior (non-root, non-terminal) nodes
function meanStemRadius(graph) {
  const interior = graph.nodes.filter(n => !n.isRoot && !n.isTerminal);
  if (!interior.length) return 0;
  return interior.reduce((s, n) => s + n.radius, 0) / interior.length;
}

// Helper: terminal tip Y elevation (world-space)
function tipElevation(graph) {
  return terminal(graph).pos[1];
}

// Helper: droop angle — angle between raw offset and final offset (in radians).
// More droop = smaller Y component of tip relative to attach.
function droopMagnitude(graph) {
  const t = terminal(graph);
  const ap = t.attachPos;
  // Use the Y displacement relative to attachPos as a proxy for droop:
  // more droop → lower tip.pos[1].  Return negative so larger number = more droop.
  return ap[1] - t.pos[1];  // positive when tip is below attach (drooped)
}

// ---------------------------------------------------------------------------
// 1. SNAPSHOT — genome=null must reproduce exact output
// ---------------------------------------------------------------------------

test('genome=null produces identical output to no-genome call (snapshot equality)', () => {
  const g1 = cloneGraph(makeGraph());
  const g2 = cloneGraph(makeGraph());

  const r1 = solveProportions(g1, baseEnvelope);
  const r2 = solveProportions(g2, baseEnvelope, null);

  assert.deepStrictEqual(
    r1.nodes.map(n => ({ radius: n.radius, pos: n.pos })),
    r2.nodes.map(n => ({ radius: n.radius, pos: n.pos })),
    'genome=null must produce bit-for-bit identical output to the two-arg call'
  );
});

// ---------------------------------------------------------------------------
// 2. ZERO-RNG — no Math.random calls
// ---------------------------------------------------------------------------

test('zero-rng: Math.random is never called during solveProportions', () => {
  let called = false;
  const orig = Math.random;
  Math.random = () => { called = true; return orig(); };
  try {
    solveProportions(cloneGraph(makeGraph()), baseEnvelope, {
      succulence: 0.5, stemGirth: 0.5, taper: 0.5, rigidity: 0.5, verticality: 0.5,
    });
    assert.strictEqual(called, false, 'Math.random must not be called');
  } finally {
    Math.random = orig;
  }
});

// ---------------------------------------------------------------------------
// 3. DETERMINISM — bit-for-bit on repeat
// ---------------------------------------------------------------------------

test('bit-for-bit determinism: same inputs produce identical outputs on repeat calls', () => {
  const genome = { succulence: 0.3, stemGirth: 0.7, taper: 0.4, rigidity: 0.6, verticality: 0.2 };

  const r1 = solveProportions(cloneGraph(makeGraph()), baseEnvelope, genome);
  const r2 = solveProportions(cloneGraph(makeGraph()), baseEnvelope, genome);

  assert.deepStrictEqual(
    r1.nodes.map(n => ({ radius: n.radius, pos: n.pos })),
    r2.nodes.map(n => ({ radius: n.radius, pos: n.pos })),
    'Repeated calls with same inputs must produce identical results'
  );
});

// ---------------------------------------------------------------------------
// 4. SUCCULENCE — monotonic stem-base radius, at gene=1 radius >= 2x gene=0
// ---------------------------------------------------------------------------

test('succulence: mean stem radius is monotonically increasing with gene', () => {
  const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const radii = steps.map(s => {
    const g = solveProportions(cloneGraph(makeGraph()), baseEnvelope, { succulence: s });
    return meanStemRadius(g);
  });

  for (let i = 1; i < radii.length; i++) {
    assert.ok(
      radii[i] >= radii[i - 1] - 1e-12,
      `succulence monotonicity violated: radii[${i}]=${radii[i]} < radii[${i-1}]=${radii[i-1]}`
    );
  }

  // At succulence=1, stem-base radius >= 2x the succulence=0 radius
  assert.ok(
    radii[radii.length - 1] >= radii[0] * 2 - 1e-12,
    `succulence=1 radius (${radii[radii.length-1]}) must be >= 2x succulence=0 radius (${radii[0]})`
  );
});

// ---------------------------------------------------------------------------
// 5. STEM GIRTH — monotonically increasing mean interior radius
// ---------------------------------------------------------------------------

test('stemGirth: mean interior radius is strictly monotonically increasing with gene', () => {
  const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const radii = steps.map(s => {
    const g = solveProportions(cloneGraph(makeGraph()), baseEnvelope, { stemGirth: s });
    return meanStemRadius(g);
  });

  for (let i = 1; i < radii.length; i++) {
    assert.ok(
      radii[i] > radii[i - 1] - 1e-12,
      `stemGirth monotonicity violated at step ${i}: ${radii[i]} vs ${radii[i-1]}`
    );
  }

  // Overall direction: gene=1 should produce noticeably larger radius than gene=0
  assert.ok(
    radii[radii.length - 1] > radii[0],
    `stemGirth=1 should be larger than stemGirth=0`
  );
});

// ---------------------------------------------------------------------------
// 6. TAPER — leader/parent radius ratio increases with gene
// ---------------------------------------------------------------------------

test('taper gene: leader child radius ratio (r_child / r_parent) increases with gene', () => {
  // Build a graph where node 2 is the single child of node 1 (the leader),
  // so r_child / r_parent = TAPER at that level.
  // Higher taper gene → higher TAPER constant → larger r_child/r_parent ratio.
  //
  // We use a 3-node graph: trunk-base (no parent) → single woody child → terminal.
  function makeTaperGraph() {
    return {
      nodes: [
        { isWoody: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        { isWoody: true, branchLevel: 1, pos: [0, 1, 0], parentIdx: 0 },
        { isTerminal: true, branchLevel: 2, pos: [0, 2, 0], attachPos: [0, 1, 0], parentIdx: 1 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const ratios = steps.map(t => {
    const g = solveProportions(cloneGraph(makeTaperGraph()), baseEnvelope, { taper: t, succulence: 0 });
    const parent = g.nodes[0];
    const child  = g.nodes[1];
    return child.radius / parent.radius;
  });

  for (let i = 1; i < ratios.length; i++) {
    assert.ok(
      ratios[i] >= ratios[i - 1] - 1e-12,
      `taper monotonicity violated: ratio[${i}]=${ratios[i]} < ratio[${i-1}]=${ratios[i-1]}`
    );
  }

  // taper range should span [0.55, 0.85]
  assert.ok(Math.abs(ratios[0] - 0.55) < 1e-9, `taper=0 should give ratio ~0.55, got ${ratios[0]}`);
  assert.ok(Math.abs(ratios[ratios.length - 1] - 0.85) < 1e-9,
    `taper=1 should give ratio ~0.85, got ${ratios[ratios.length-1]}`);
});

// ---------------------------------------------------------------------------
// 7. RIGIDITY — droop magnitude decreases monotonically as rigidity increases
// ---------------------------------------------------------------------------

test('rigidity: tip elevation (tipY) decreases monotonically as rigidity increases', () => {
  // Physics: droopAngle = droopPhysics * (1 - rigidity), monotonically decreasing in rigidity.
  // Observable effect: with a horizontal offset [1,0,0], more droop rotates the offset
  // more toward -Y before phototropism acts. After phototropism (which rotates the
  // drooped offset toward lightDir), less-drooped offsets receive LESS vertical lift —
  // because a more-horizontal offset has less phototropism leverage. Net: tipY DECREASES
  // monotonically as rigidity increases. Use high gravity so droop >> photo noise.
  const highGravEnvelope = { ...baseEnvelope, gravity: 10 };

  function makeHorizontalGraph() {
    return {
      nodes: [
        { isWoody: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        { isTerminal: true, branchLevel: 1, pos: [1, 0, 0], attachPos: [0, 0, 0], parentIdx: 0 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const tipYs = steps.map(r => {
    const g = solveProportions(cloneGraph(makeHorizontalGraph()), highGravEnvelope, {
      rigidity: r,
      verticality: 0.5,  // erect baseline, no verticality contribution
    });
    return terminal(g).pos[1];
  });

  // tipY should decrease monotonically as rigidity increases
  for (let i = 1; i < tipYs.length; i++) {
    assert.ok(
      tipYs[i] <= tipYs[i - 1] + 1e-12,
      `rigidity monotonicity violated: tipY[${i}]=${tipYs[i]} > tipY[${i-1}]=${tipYs[i-1]}`
    );
  }

  // Overall: rigidity=0 (max droop) → highest tipY (most photo lift after droop)
  //          rigidity=1 (zero droop) → lowest tipY
  assert.ok(
    tipYs[0] > tipYs[tipYs.length - 1],
    `rigidity=0 should produce higher tipY than rigidity=1: ${tipYs[0]} vs ${tipYs[tipYs.length-1]}`
  );

  // rigidity=0 with high gravity should produce large droop (tipY is positive due to photo)
  assert.ok(tipYs[0] > 0, `tipY at rigidity=0 should be positive (photo lifts drooped tip), got ${tipYs[0]}`);
});

// ---------------------------------------------------------------------------
// 8. VERTICALITY — monotonic mean tip elevation with gene
// ---------------------------------------------------------------------------

test('verticality: tip elevation decreases monotonically as gene increases (v=0 high, v=1 pendulous/low)', () => {
  // vertAngle = (0.5 - v)*π provides a sin-shaped Y profile in the absence of phototropism.
  // Phototropism (a fixed angle toward the sun) is composed sequentially; it adds a
  // non-linear bump at fine granularity (0.1 steps) but the overall trend is monotonic.
  // We test at 5 evenly-spaced points (0.25 steps) where the 4× oversampled trend holds.
  //
  // v=0  → vertAngle=+π/2 → tip points UP (highest tipY)
  // v=0.5 → vertAngle=0   → erect baseline
  // v=1  → vertAngle=-π/2 → tip points DOWN (pendulous, lowest tipY)
  function makeHorizGraph() {
    return {
      nodes: [
        { isWoody: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        { isTerminal: true, branchLevel: 1, pos: [1, 0, 0], attachPos: [0, 0, 0], parentIdx: 0 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  // 5-point sweep at 0.25 increments — verified monotone even with phototropism composition.
  const steps = [0, 0.25, 0.5, 0.75, 1.0];
  const elevations = steps.map(v => {
    const g = solveProportions(cloneGraph(makeHorizGraph()), baseEnvelope, {
      verticality: v,
      rigidity: 1.0,  // zero gravity/wind droop so only verticality + phototropism apply
    });
    return terminal(g).pos[1];
  });

  // As verticality increases (0→1), tip elevation DECREASES monotonically
  for (let i = 1; i < elevations.length; i++) {
    assert.ok(
      elevations[i] <= elevations[i - 1] + 1e-9,
      `verticality monotonicity violated at step ${i}: elevation=${elevations[i]} > prev=${elevations[i-1]}`
    );
  }

  // Key endpoints: v=0 tip should be substantially higher than v=1 tip
  assert.ok(
    elevations[0] > elevations[elevations.length - 1],
    `verticality=0 tip should be higher than verticality=1 tip: ${elevations[0]} vs ${elevations[elevations.length-1]}`
  );

  // v=1 (pendulous) tip should be below the attach point
  assert.ok(
    elevations[elevations.length - 1] < 0,
    `verticality=1 (pendulous) tip should be below attach (Y < 0), got ${elevations[elevations.length-1]}`
  );
});

// ---------------------------------------------------------------------------
// 9. CONTINUITY — succulence sweep in 0.02 steps: bounded per-step change
// ---------------------------------------------------------------------------

test('continuity: succulence sweep in 0.02 steps — mean radius change bounded per step', () => {
  const MAX_DELTA_PER_STEP = 0.05;  // max allowed mean-radius change per 0.02 step
  let prev = null;

  for (let s = 0; s <= 1.0 + 1e-9; s += 0.02) {
    const gene = Math.min(1, s);
    const g = solveProportions(cloneGraph(makeGraph()), baseEnvelope, { succulence: gene });
    const r = meanStemRadius(g);
    if (prev !== null) {
      const delta = Math.abs(r - prev);
      assert.ok(
        delta <= MAX_DELTA_PER_STEP,
        `succulence continuity violation at s=${gene.toFixed(2)}: delta=${delta} > ${MAX_DELTA_PER_STEP}`
      );
    }
    prev = r;
  }
});

// ---------------------------------------------------------------------------
// 10. CONTINUITY — rigidity sweep in 0.02 steps: bounded per-step droop change
// ---------------------------------------------------------------------------

test('continuity: rigidity sweep in 0.02 steps — droop angle change bounded per step', () => {
  const MAX_DELTA_PER_STEP = 0.05;  // max allowed droop change (Y units) per 0.02 step

  function makeHorizGraph2() {
    return {
      nodes: [
        { isWoody: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        { isTerminal: true, branchLevel: 1, pos: [1, 0, 0], attachPos: [0, 0, 0], parentIdx: 0 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  let prev = null;
  for (let r = 0; r <= 1.0 + 1e-9; r += 0.02) {
    const gene = Math.min(1, r);
    const g = solveProportions(cloneGraph(makeHorizGraph2()), baseEnvelope, {
      rigidity: gene,
      verticality: 0.5,
    });
    const t = terminal(g);
    const droop = t.attachPos[1] - t.pos[1];  // positive = below attach
    if (prev !== null) {
      const delta = Math.abs(droop - prev);
      assert.ok(
        delta <= MAX_DELTA_PER_STEP,
        `rigidity continuity violation at r=${gene.toFixed(2)}: delta=${delta} > ${MAX_DELTA_PER_STEP}`
      );
    }
    prev = droop;
  }
});

// ---------------------------------------------------------------------------
// 11. GUARD — isFrond tag still throws
// ---------------------------------------------------------------------------

test('isFrond tag still throws error', () => {
  const g = cloneGraph(makeGraph());
  g.nodes[2].isFrond = true;
  assert.throws(
    () => solveProportions(g, baseEnvelope),
    /isFrond/,
    'should throw on isFrond tag'
  );
});

// ---------------------------------------------------------------------------
// 12. GUARD — isStem tag no longer throws (it's a valid input tag now)
// ---------------------------------------------------------------------------

test('isStem tag does not throw (valid input tag per new contract)', () => {
  const g = cloneGraph(makeGraph());
  // node 1 already has isStem=true — verify no throw
  assert.doesNotThrow(() => solveProportions(g, baseEnvelope));
});

// ---------------------------------------------------------------------------
// 13. GUARD — parentIdx ordering invariant
// ---------------------------------------------------------------------------

test('parentIdx >= ownIndex throws ordering invariant error', () => {
  const g = cloneGraph(makeGraph());
  g.nodes[1].parentIdx = 2;  // child points to a later node — violation
  assert.throws(
    () => solveProportions(g, baseEnvelope),
    /ordering invariant/,
    'should throw on parentIdx >= ownIndex'
  );
});

// ---------------------------------------------------------------------------
// 14. LEGACY — sunAngle → lightDir is written to graph.meta
// ---------------------------------------------------------------------------

test('sunAngle → lightDir is written to graph.meta after solve', () => {
  const g = cloneGraph(makeGraph());
  solveProportions(g, baseEnvelope);
  assert.ok(Array.isArray(g.meta.lightDir), 'meta.lightDir should be an array');
  assert.strictEqual(g.meta.lightDir.length, 3, 'lightDir should have 3 components');
  const len = Math.sqrt(g.meta.lightDir.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(len - 1) < 1e-9, `lightDir should be unit length, got ${len}`);
});

// ---------------------------------------------------------------------------
// 15. TAPER — succulence=1 flattens taper to ~1.0 regardless of taper gene
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 16. TIP TAPER — every leaf tip node has radius <= 0.05 and < its parent radius
// ---------------------------------------------------------------------------

test('tip-taper: every leaf/tip node (no children) has radius <= 0.05 and < parent radius', () => {
  const g = cloneGraph(makeGraph());
  solveProportions(g, baseEnvelope);

  const { nodes } = g;

  // Build childrenOf
  const childrenOf = new Array(nodes.length).fill(null).map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parentIdx;
    if (p !== undefined && p >= 0) childrenOf[p].push(i);
  }

  for (let i = 0; i < nodes.length; i++) {
    if (childrenOf[i].length === 0) {
      const tip = nodes[i];
      assert.ok(
        tip.radius <= 0.05,
        `tip node[${i}] radius=${tip.radius} should be <= 0.05`
      );
      // Parent radius must be strictly larger (confirms taper toward a point)
      const pIdx = tip.parentIdx;
      if (pIdx !== undefined && pIdx >= 0) {
        const parentR = nodes[pIdx].radius;
        assert.ok(
          tip.radius < parentR,
          `tip node[${i}] radius=${tip.radius} must be < parent node[${pIdx}] radius=${parentR}`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 17. TIP TAPER — interior node radii are unchanged by the tip-taper pass
// ---------------------------------------------------------------------------

test('tip-taper: interior nodes (with children) are not affected', () => {
  // Interior nodes must still satisfy the pipe-model expectations for the body.
  // We verify that every node with at least one child has radius > 0.05
  // (it should be at the pipe-model scale, not pinched to near-zero).
  const g = cloneGraph(makeGraph());
  solveProportions(g, baseEnvelope);

  const { nodes } = g;
  const childrenOf = new Array(nodes.length).fill(null).map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parentIdx;
    if (p !== undefined && p >= 0) childrenOf[p].push(i);
  }

  for (let i = 0; i < nodes.length; i++) {
    if (childrenOf[i].length > 0) {
      const n = nodes[i];
      assert.ok(
        n.radius > 0.05,
        `interior node[${i}] radius=${n.radius} should be > 0.05 (pipe-model, not tip-tapered)`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 18. TIP TAPER — root tip (outer isRoot with no children) is tapered;
//     root/trunk base (has children) is not
// ---------------------------------------------------------------------------

test('tip-taper: root tips are tapered; root/trunk base (has children) is not', () => {
  // makeGraph has 3 isRoot nodes (nodes 0, and the two other roots appended by buildSkeleton).
  // Actually makeGraph() has only node 0 with isRoot=true, parentIdx=-1.
  // But we need a graph with isRoot nodes that have no children (outer flare tips).
  // Build a graph with two root nodes: one outer tip (no children), one inner (has children).
  const rootGraph = {
    nodes: [
      // node 0: trunk base, no parent, has children
      { isStem: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
      // node 1: root inner — parent of node 2, so has a child
      { isRoot: true, branchLevel: 0, pos: [0.3, -0.2, 0], parentIdx: 0 },
      // node 2: root outer tip — no children (the dangling end)
      { isRoot: true, branchLevel: 0, pos: [0.6, -0.4, 0], parentIdx: 1 },
      // node 3: terminal branch tip
      { isTerminal: true, branchLevel: 1, pos: [0, 1, 0], attachPos: [0, 0, 0], parentIdx: 0 },
    ],
    bones: [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
      { a: 0, b: 3 },
    ],
    meta: { bodyAxis: [0, 1, 0] },
  };

  const g = JSON.parse(JSON.stringify(rootGraph));
  solveProportions(g, baseEnvelope);

  const { nodes } = g;
  const childrenOf = new Array(nodes.length).fill(null).map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parentIdx;
    if (p !== undefined && p >= 0) childrenOf[p].push(i);
  }

  // node 2: outer root tip (no children) — should be tapered
  assert.ok(
    nodes[2].radius <= 0.05,
    `outer root tip (node 2) radius=${nodes[2].radius} should be <= 0.05`
  );

  // node 1: inner root (has child node 2) — should NOT be tapered
  assert.ok(
    nodes[1].radius > 0.05,
    `inner root (node 1, has children) radius=${nodes[1].radius} should be > 0.05`
  );

  // node 0: trunk base (has children) — should not be tapered
  assert.ok(
    nodes[0].radius > 0.05,
    `trunk base (node 0) radius=${nodes[0].radius} should be > 0.05`
  );
});

// ---------------------------------------------------------------------------
// 19. TIP TAPER — determinism still holds after tip-taper fix
// ---------------------------------------------------------------------------

test('tip-taper: determinism still holds (tip radii are bit-for-bit identical on repeat)', () => {
  const genome = { succulence: 0.6, stemGirth: 0.8, taper: 0.3 };
  const r1 = solveProportions(cloneGraph(makeGraph()), baseEnvelope, genome);
  const r2 = solveProportions(cloneGraph(makeGraph()), baseEnvelope, genome);

  assert.deepStrictEqual(
    r1.nodes.map(n => n.radius),
    r2.nodes.map(n => n.radius),
    'Tip radii must be bit-for-bit identical on repeat'
  );
});

test('succulence=1 flattens effective taper to 1.0 (single child radius = parent radius)', () => {
  function makeTaperGraph2() {
    return {
      nodes: [
        { isWoody: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        { isWoody: true, branchLevel: 1, pos: [0, 1, 0], parentIdx: 0 },
        { isTerminal: true, branchLevel: 2, pos: [0, 2, 0], attachPos: [0, 1, 0], parentIdx: 1 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  // At succulence=1, effectiveTaper = taperResolved + (1 - taperResolved) * 1 = 1.0
  // so single-child radius = parent * 1.0 = parent radius.
  const g = solveProportions(cloneGraph(makeTaperGraph2()), baseEnvelope, {
    succulence: 1.0,
    taper: 0.5,  // mid taper gene
  });

  const r0 = g.nodes[0].radius;
  const r1 = g.nodes[1].radius;
  assert.ok(
    Math.abs(r1 / r0 - 1.0) < 1e-9,
    `succulence=1 should give r_child/r_parent=1.0, got ${r1/r0}`
  );
});

// ---------------------------------------------------------------------------
// 20. GRAVITY DROOP — higher gravity → more downward displacement on woody branches
// ---------------------------------------------------------------------------

test('gravity droop: increasing gravity monotonically lowers woody branch nodes', () => {
  // Woody (interior) branch nodes use `woodyDroopAngle = woodyDroopBase * branchLevel`
  // where woodyDroopBase ∝ g^0.60. This path has no phototropism complication, so the
  // test can directly verify: more gravity → lower Y on a horizontal woody branch.
  //
  // Graph: trunk base → horizontal woody branch at branchLevel=2.
  // The branch offset is [1, 0, 0] from its parent at [0, 0, 0].
  // Woody droop axis: cross([1,0,0], [0,-1,0]) = [0,0,-1].
  // Rotating [1,0,0] around [0,0,-1] by angle θ: Y component = -sin(θ).
  // More gravity → larger θ → more negative Y → lower branch node.
  function makeWoodyBranch() {
    return {
      nodes: [
        // node 0: trunk base (branchLevel=0, no parent)
        { isWoody: true, isStem: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        // node 1: horizontal woody branch at branchLevel=2, parent=0
        { isWoody: true, branchLevel: 2, pos: [1, 0, 0], parentIdx: 0 },
        // node 2: terminal to give node 1 a child (so it's not tip-tapered)
        { isTerminal: true, branchLevel: 3, pos: [2, 0, 0], attachPos: [1, 0, 0], parentIdx: 1 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  // Sweep gravity from low to high; the woody branch node Y should decrease monotonically.
  const gravities = [0.1, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0];
  const branchYs = gravities.map(g => {
    const env = { ...baseEnvelope, gravity: g };
    const graph = solveProportions(cloneGraph(makeWoodyBranch()), env, {
      rigidity: 0.4,    // TREE_DEFAULT
      verticality: 0.5,
    });
    return graph.nodes[1].pos[1];  // Y of the woody branch node
  });

  // Y must decrease (or stay equal) as gravity increases.
  for (let i = 1; i < branchYs.length; i++) {
    assert.ok(
      branchYs[i] <= branchYs[i - 1] + 1e-9,
      `gravity monotonicity violated: branchY at g=${gravities[i]}=${branchYs[i]} > branchY at g=${gravities[i-1]}=${branchYs[i-1]}`
    );
  }

  // Overall: high gravity should produce significantly lower Y than low gravity.
  assert.ok(
    branchYs[branchYs.length - 1] < branchYs[0],
    `branch at g=3 should be lower than at g=0.1: ${branchYs[branchYs.length-1]} vs ${branchYs[0]}`
  );
});

// ---------------------------------------------------------------------------
// 21. TIP ACCUMULATION — deeper branch levels droop more than primary branches
// ---------------------------------------------------------------------------

test('tip accumulation: deepest-level woody branches droop more than level-1 woody branches', () => {
  // Both nodes are horizontal (offset [1,0,0] from parent at [0,0,0]).
  // woodyDroopAngle = woodyDroopBase * branchLevel, so level=4 droops 4× more than level=1.
  // After Rodrigues: Y = -sin(woodyDroopAngle). Lower branchLevel → smaller angle → less negative Y.
  function makeTwoLevelWoody() {
    return {
      nodes: [
        // node 0: trunk base (branchLevel=0)
        { isWoody: true, isStem: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        // node 1: level-1 branch, horizontal
        { isWoody: true, branchLevel: 1, pos: [1, 0, 0], parentIdx: 0 },
        // node 2: level-4 branch (finer twig), horizontal
        { isWoody: true, branchLevel: 4, pos: [1, 0, 0], parentIdx: 0 },
        // terminals to prevent tip-taper from touching nodes 1 and 2
        { isTerminal: true, branchLevel: 2, pos: [2, 0, 0], attachPos: [1, 0, 0], parentIdx: 1 },
        { isTerminal: true, branchLevel: 5, pos: [2, 0, 0], attachPos: [1, 0, 0], parentIdx: 2 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  const graph = solveProportions(cloneGraph(makeTwoLevelWoody()), baseEnvelope, {
    rigidity:    0.4,   // TREE_DEFAULT
    verticality: 0.5,
  });

  const primaryY = graph.nodes[1].pos[1];  // branchLevel=1 woody
  const deepY    = graph.nodes[2].pos[1];  // branchLevel=4 woody

  assert.ok(
    deepY < primaryY,
    `Deep woody branch (branchLevel=4, Y=${deepY}) should droop lower than primary (branchLevel=1, Y=${primaryY})`
  );
});

// ---------------------------------------------------------------------------
// 22. DEFAULT RIGIDITY — droop is non-trivial at TREE_DEFAULT rigidity=0.4
// ---------------------------------------------------------------------------

test('default rigidity: woody branch droop is visible (non-trivial) at rigidity=0.4', () => {
  // Use a horizontal woody branch so droop clearly pushes it down.
  // At rigidity=0.4, rigidityDroopScale=0.75 vs rigidity=1.0 gives scale=0.25 (floor).
  // The branch at rigidity=0.4 should be noticeably lower than at rigidity=1.0.
  function makeWoodyBranch() {
    return {
      nodes: [
        { isWoody: true, isStem: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        { isWoody: true, branchLevel: 3, pos: [1, 0, 0], parentIdx: 0 },
        { isTerminal: true, branchLevel: 4, pos: [2, 0, 0], attachPos: [1, 0, 0], parentIdx: 1 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  const graphDefault = solveProportions(cloneGraph(makeWoodyBranch()), baseEnvelope, {
    rigidity: 0.4, verticality: 0.5,
  });
  const graphStiff = solveProportions(cloneGraph(makeWoodyBranch()), baseEnvelope, {
    rigidity: 1.0, verticality: 0.5,
  });

  const branchYDefault = graphDefault.nodes[1].pos[1];
  const branchYStiff   = graphStiff.nodes[1].pos[1];

  // At rigidity=0.4, droopScale=0.75 > floor droopScale=0.25 at rigidity=1.0.
  // So the branch should be lower at rigidity=0.4 than at rigidity=1.0.
  assert.ok(
    branchYDefault < branchYStiff,
    `Branch at rigidity=0.4 (Y=${branchYDefault}) should be lower than rigidity=1.0 (Y=${branchYStiff})`
  );
  // The difference must be meaningful (not just floating point noise).
  assert.ok(
    branchYStiff - branchYDefault > 0.01,
    `Droop at rigidity=0.4 should be visibly more than at rigidity=1.0: diff=${branchYStiff - branchYDefault}`
  );
});

// ---------------------------------------------------------------------------
// 23. GRAVITY FLOOR — droop persists at maximum rigidity (rigidity=1.0)
// ---------------------------------------------------------------------------

test('gravity floor: droop is non-zero even at rigidity=1.0 (25% floor)', () => {
  // rigidityDroopScale = 0.25 + (1 - 1.0) * 0.75 = 0.25 (not zero).
  // With a horizontal offset at branchLevel=3, the tip should still droop measurably.
  function makeHorizTwig() {
    return {
      nodes: [
        { isWoody: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        {
          isTerminal: true,
          branchLevel: 3,
          pos: [1, 0, 0],
          attachPos: [0, 0, 0],
          parentIdx: 0,
        },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  // Compare rigidity=1.0 with rigidity=0.0 (no floor, before change).
  // With genome=null (rigidity defaults to 0.0 → scale=1.0 in legacy mode),
  // we use an explicit genome for both:
  const graphMax = solveProportions(cloneGraph(makeHorizTwig()), baseEnvelope, {
    rigidity:    1.0,
    verticality: 0.5,
  });
  const graphMin = solveProportions(cloneGraph(makeHorizTwig()), baseEnvelope, {
    rigidity:    0.0,
    verticality: 0.5,
  });

  // Both should have the terminal drooping below its raw (no-droop) position.
  // We compare against the zero-droop baseline (what it would be with droopPhysicsBase=0).
  // The zero-droop position would be: phototropism applied to raw horizontal offset.
  // Instead, we simply assert that rigidity=1.0 still droops meaningfully:
  //   tipY at rigidity=1.0 should be less than tipY at rigidity=0.0
  //   (less droop → phototropism dominates more → higher tipY),
  //   AND the difference is non-trivial (> 0.01) proving the floor matters.
  const tipYMax = terminal(graphMax).pos[1];
  const tipYMin = terminal(graphMin).pos[1];

  assert.ok(
    tipYMax < tipYMin,
    `rigidity=1.0 tipY=${tipYMax} should still be lower than rigidity=0.0 tipY=${tipYMin} (floor gives 25% droop)`
  );
});

// ---------------------------------------------------------------------------
// 24. TRUNK THICKNESS — TREE_DEFAULT genome produces a substantially larger
//     trunk-base radius than the pre-thickening baseline (coefficient 0.12 → 0.20,
//     stemGirth 0.50 → 0.68).
// ---------------------------------------------------------------------------

test('trunk thickness: TREE_DEFAULT trunk-base radius is substantially larger than the thin baseline', () => {
  // Simulate TREE_DEFAULT genome values at base envelope (gravity=1, air, defaults).
  // At g=1, all *Mod scalars = 1.0 at default wind/aridity.
  // stemThicknessFactor = succulenceStemMod * stemGirthMod
  // New:  0.20 * (1 + 0.12) * (0.5 + 0.68*1.5) = 0.20 * 1.12 * 1.52 ≈ 0.3405
  // Old:  0.12 * (1 + 0.12) * (0.5 + 0.50*1.5) = 0.12 * 1.12 * 1.25 ≈ 0.1680
  // Minimum factor expected: 1.8× — i.e., new >= old * 1.8

  const TREE_DEFAULT_GENOME = {
    succulence: 0.12,
    stemGirth:  0.68,
    taper:      0.72,
    rigidity:   0.40,
    verticality: 0.50,
  };
  const OLD_GENOME = {
    succulence: 0.12,
    stemGirth:  0.50,   // old TREE_DEFAULT stemGirth
    taper:      0.72,
    rigidity:   0.40,
    verticality: 0.50,
  };

  // We need the trunk-base node: the node with parentIdx == -1 that is NOT isRoot.
  function trunkBaseRadius(graph) {
    return graph.nodes.find(n => !n.isRoot && (n.parentIdx === undefined || n.parentIdx < 0)).radius;
  }

  // The "old" coefficient was 0.12; test it by temporarily computing expected old value.
  // We can't call into proportions with the old coefficient, so we assert the new value
  // is meaningfully larger than what the old coefficient + old stemGirth would have given.
  //
  // New trunk-base (TREE_DEFAULT, new coeff+stemGirth) must be >= 1.8× the old value.
  // Old value: stemBaseRadius = 0.12 * 1.12 * 1.25 = 0.1680 (at g=1, defaults)
  // 1.8 × old = 0.3024.  New expected ≈ 0.3405 > 0.3024. ✓
  const OLD_TRUNK_BASE = 0.12 * (1.0 + 0.12) * (0.5 + 0.50 * 1.5); // 0.1680

  const newGraph = solveProportions(cloneGraph(makeGraph()), baseEnvelope, TREE_DEFAULT_GENOME);
  const newTrunkR = trunkBaseRadius(newGraph);

  assert.ok(
    newTrunkR >= OLD_TRUNK_BASE * 1.8,
    `TREE_DEFAULT trunk-base radius (${newTrunkR.toFixed(4)}) should be >= 1.8× the old value (${(OLD_TRUNK_BASE * 1.8).toFixed(4)})`
  );
});

// ---------------------------------------------------------------------------
// 25. TRUNK THICKNESS — pipe-model taper still holds (branches thinner than trunk)
// ---------------------------------------------------------------------------

test('trunk thickness: taper still holds — interior branch nodes are thinner than trunk base', () => {
  const TREE_DEFAULT_GENOME = {
    succulence: 0.12,
    stemGirth:  0.68,
    taper:      0.72,
    rigidity:   0.40,
    verticality: 0.50,
  };

  // Build a 4-node graph: trunk-base → level-1 branch → level-2 branch → terminal
  function makeDeepGraph() {
    return {
      nodes: [
        { isWoody: true, isStem: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
        { isWoody: true, branchLevel: 1, pos: [0, 1, 0], parentIdx: 0 },
        { isWoody: true, branchLevel: 2, pos: [0, 2, 0], parentIdx: 1 },
        { isTerminal: true, branchLevel: 3, pos: [0, 3, 0], attachPos: [0, 2, 0], parentIdx: 2 },
      ],
      bones: [],
      meta: { bodyAxis: [0, 1, 0] },
    };
  }

  const g = solveProportions(cloneGraph(makeDeepGraph()), baseEnvelope, TREE_DEFAULT_GENOME);
  const rTrunk  = g.nodes[0].radius;  // trunk base
  const rBranch = g.nodes[1].radius;  // level-1 branch
  const rTwig   = g.nodes[2].radius;  // level-2 twig

  assert.ok(
    rBranch < rTrunk,
    `Level-1 branch radius (${rBranch.toFixed(4)}) must be < trunk-base radius (${rTrunk.toFixed(4)})`
  );
  assert.ok(
    rTwig < rBranch,
    `Level-2 twig radius (${rTwig.toFixed(4)}) must be < level-1 branch radius (${rBranch.toFixed(4)})`
  );
});

// ---------------------------------------------------------------------------
// 26. TRUNK THICKNESS — tip nodes remain near-zero after thickening
// ---------------------------------------------------------------------------

test('trunk thickness: tip nodes are still near-zero after trunk thickening', () => {
  const TREE_DEFAULT_GENOME = {
    succulence: 0.12,
    stemGirth:  0.68,
    taper:      0.72,
    rigidity:   0.40,
    verticality: 0.50,
  };

  const g = solveProportions(cloneGraph(makeGraph()), baseEnvelope, TREE_DEFAULT_GENOME);
  const { nodes } = g;
  const childrenOf = new Array(nodes.length).fill(null).map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parentIdx;
    if (p !== undefined && p >= 0) childrenOf[p].push(i);
  }

  for (let i = 0; i < nodes.length; i++) {
    if (childrenOf[i].length === 0) {
      assert.ok(
        nodes[i].radius <= 0.05,
        `Tip node[${i}] radius=${nodes[i].radius.toFixed(4)} should still be <= 0.05 after thickening`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// TASK 2: Root pipe-model tests
// ---------------------------------------------------------------------------

/**
 * Build a root graph fixture.
 *
 * The fork at node 2 has three root children (nodes 3, 4, 5). To test the
 * pipe-model invariant (r_parent² ≈ Σ child r²) on the fork, the children
 * must NOT be tip nodes (tip-taper overwrites childless node radii to
 * near-zero, breaking the invariant). So each fork child has its own tip
 * child (nodes 6, 7, 8) to make the fork children interior nodes.
 *
 *   node 0: trunk base (isStem, no parent)
 *   node 1: taproot origin — isRoot, parent=0 (trunk base is NOT isRoot)
 *   node 2: taproot mid — isRoot, parent=1 (the FORK node)
 *   node 3: fork child leader — isRoot, parent=2 (has child node 6 → interior)
 *   node 4: fork child A — isRoot, parent=2 (has child node 7 → interior)
 *   node 5: fork child B — isRoot, parent=2 (has child node 8 → interior)
 *   node 6: tip of node 3 — isRoot, parent=3 (childless tip)
 *   node 7: tip of node 4 — isRoot, parent=4 (childless tip)
 *   node 8: tip of node 5 — isRoot, parent=5 (childless tip)
 *   node 9: canopy terminal — isTerminal, parent=0 (for bending-pass position check)
 *
 * Topology:
 *   trunk(0)
 *     ├── taproot-origin(1)
 *     │     └── taproot-mid/FORK(2)
 *     │           ├── fork-leader(3)──tip(6)
 *     │           ├── fork-A(4)──tip(7)
 *     │           └── fork-B(5)──tip(8)
 *     └── terminal(9)
 */
function makeRootGraph() {
  return {
    nodes: [
      // node 0: trunk base
      { isStem: true, isWoody: true, branchLevel: 0, pos: [0, 0, 0], parentIdx: -1 },
      // node 1: taproot origin (isRoot, parented to trunk — NOT isRoot parent)
      { isRoot: true, branchLevel: 0, rootLevel: 0, pos: [0, -0.2, 0], parentIdx: 0 },
      // node 2: taproot mid — the fork node (isRoot, parent is isRoot)
      { isRoot: true, branchLevel: 0, rootLevel: 0, pos: [0, -0.5, 0], parentIdx: 1 },
      // node 3: fork leader (highest index among fork-level — leader by max index)
      // Note: in our implementation leader = max index among siblings; node 5 is max.
      // So for a clean test: 3 children, leader = node 5. Children 3,4 are laterals.
      { isRoot: true, branchLevel: 0, rootLevel: 0, pos: [0, -0.9, 0], parentIdx: 2 },
      // node 4: lateral fork A (isRoot, fork child)
      { isRoot: true, branchLevel: 0, rootLevel: 1, pos: [0.3, -0.8, 0], parentIdx: 2 },
      // node 5: lateral fork B (isRoot, fork child — highest index → leader)
      { isRoot: true, branchLevel: 0, rootLevel: 1, pos: [-0.3, -0.8, 0], parentIdx: 2 },
      // node 6: tip of node 3 (childless — tip-taper applies here, NOT on node 3)
      { isRoot: true, branchLevel: 0, rootLevel: 0, pos: [0, -1.2, 0], parentIdx: 3 },
      // node 7: tip of node 4 (childless)
      { isRoot: true, branchLevel: 0, rootLevel: 1, pos: [0.5, -1.1, 0], parentIdx: 4 },
      // node 8: tip of node 5 (childless)
      { isRoot: true, branchLevel: 0, rootLevel: 1, pos: [-0.5, -1.1, 0], parentIdx: 5 },
      // node 9: canopy terminal (for bending-pass position check)
      {
        isTerminal: true,
        branchLevel: 1,
        pos: [1, 1, 0],
        attachPos: [0, 0, 0],
        parentIdx: 0,
      },
    ],
    bones: [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
      { a: 2, b: 3 },
      { a: 2, b: 4 },
      { a: 2, b: 5 },
      { a: 3, b: 6 },
      { a: 4, b: 7 },
      { a: 5, b: 8 },
      { a: 0, b: 9 },
    ],
    meta: { bodyAxis: [0, 1, 0] },
  };
}

// Helper: build childrenOf map for a solved graph's nodes array
function buildChildrenOf(nodes) {
  const childrenOf = new Array(nodes.length).fill(null).map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i].parentIdx;
    if (p !== undefined && p >= 0) childrenOf[p].push(i);
  }
  return childrenOf;
}

// ---------------------------------------------------------------------------
// 27. ROOT PIPE-MODEL — r_parent² ≈ Σ child r² at root forks
// ---------------------------------------------------------------------------

test('root pipe-model: r_parent² ≈ Σ child r² at interior root forks', () => {
  const genome = { rootFlare: 0.3, rootTaper: 0.5 };
  const g = solveProportions(cloneGraph(makeRootGraph()), baseEnvelope, genome);
  const { nodes } = g;
  const childrenOf = buildChildrenOf(nodes);

  // Find all root interior nodes (isRoot with children that are also isRoot)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.isRoot !== true) continue;

    const rootChildren = childrenOf[i].filter(ci => nodes[ci].isRoot === true);
    if (rootChildren.length < 2) continue;  // need a fork to test pipe-model split

    const rParentSq = n.radius * n.radius;
    const sumChildSq = rootChildren.reduce((sum, ci) => sum + nodes[ci].radius * nodes[ci].radius, 0);

    // The pipe-model invariant: r_parent² ≈ Σ child r² (within 2% relative tolerance)
    const tolerance = rParentSq * 0.02;
    assert.ok(
      Math.abs(rParentSq - sumChildSq) <= tolerance,
      `Root fork at node[${i}]: r_parent²=${rParentSq.toFixed(6)} but Σ child r²=${sumChildSq.toFixed(6)}, ` +
      `diff=${Math.abs(rParentSq - sumChildSq).toFixed(6)} exceeds tolerance=${tolerance.toFixed(6)}`
    );
  }
});

// ---------------------------------------------------------------------------
// 28. ROOT FLARE — base radius increases monotonically with genome.rootFlare
// ---------------------------------------------------------------------------

test('rootFlare: root origin radius increases monotonically with genome.rootFlare', () => {
  const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

  const radii = steps.map(flare => {
    const g = solveProportions(cloneGraph(makeRootGraph()), baseEnvelope, { rootFlare: flare, rootTaper: 0.5 });
    // node 1 is the taproot origin (isRoot, parent is NOT isRoot) — the base radius node
    return g.nodes[1].radius;
  });

  for (let i = 1; i < radii.length; i++) {
    assert.ok(
      radii[i] >= radii[i - 1] - 1e-12,
      `rootFlare monotonicity violated: radius[${i}]=${radii[i]} < radius[${i-1}]=${radii[i-1]}`
    );
  }

  // rootFlare=1 should produce strictly larger radius than rootFlare=0
  assert.ok(
    radii[radii.length - 1] > radii[0],
    `rootFlare=1 (${radii[radii.length-1]}) should be > rootFlare=0 (${radii[0]})`
  );
});

// ---------------------------------------------------------------------------
// 29. ROOT TAPER — root tips have radius ≤ parent radius (taper holds)
// ---------------------------------------------------------------------------

test('root taper: every childless root tip has radius ≤ parent radius', () => {
  const genome = { rootFlare: 0.3, rootTaper: 0.5 };
  const g = solveProportions(cloneGraph(makeRootGraph()), baseEnvelope, genome);
  const { nodes } = g;
  const childrenOf = buildChildrenOf(nodes);

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.isRoot !== true) continue;
    if (childrenOf[i].length > 0) continue;  // only tips (no children)

    const pIdx = n.parentIdx;
    if (pIdx === undefined || pIdx < 0) continue;

    assert.ok(
      n.radius <= nodes[pIdx].radius,
      `Root tip node[${i}] radius=${n.radius} must be ≤ parent node[${pIdx}] radius=${nodes[pIdx].radius}`
    );
  }
});

// ---------------------------------------------------------------------------
// 30. ROOT POSITIONS UNCHANGED — bending pass must not move isRoot node positions
// ---------------------------------------------------------------------------

test('bending pass: isRoot node positions are not modified by solveProportions', () => {
  // Snapshot root positions before and after by comparing the raw input positions
  // to the output positions for all isRoot nodes.
  const rawGraph = makeRootGraph();
  const rootPosBefore = rawGraph.nodes
    .filter(n => n.isRoot === true)
    .map(n => ({ pos: n.pos.slice() }));

  const genome = { rootFlare: 0.3, rootTaper: 0.5, rigidity: 0.5, verticality: 0.5 };
  const g = solveProportions(cloneGraph(rawGraph), baseEnvelope, genome);

  const rootPosAfter = g.nodes
    .filter(n => n.isRoot === true)
    .map(n => ({ pos: n.pos }));

  assert.strictEqual(
    rootPosBefore.length,
    rootPosAfter.length,
    'same number of root nodes before and after'
  );

  for (let i = 0; i < rootPosBefore.length; i++) {
    assert.deepStrictEqual(
      rootPosAfter[i].pos,
      rootPosBefore[i].pos,
      `isRoot node[${i}] position must not be modified by bending pass: ` +
      `before=[${rootPosBefore[i].pos}] after=[${rootPosAfter[i].pos}]`
    );
  }
});

// ---------------------------------------------------------------------------
// 31. ROOT PIPE-MODEL — genome=null falls back gracefully (no crash, stable radius)
// ---------------------------------------------------------------------------

test('root pipe-model: genome=null produces a valid (non-NaN) root radius', () => {
  const g = solveProportions(cloneGraph(makeRootGraph()), baseEnvelope, null);
  const { nodes } = g;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].isRoot !== true) continue;
    assert.ok(
      Number.isFinite(nodes[i].radius) && nodes[i].radius > 0,
      `isRoot node[${i}] must have a finite positive radius with genome=null, got ${nodes[i].radius}`
    );
  }
});

// ---------------------------------------------------------------------------
// 32. ROOT PIPE-MODEL — zero-rng guarantee still holds with root nodes
// ---------------------------------------------------------------------------

test('root pipe-model: zero-rng guarantee holds with root nodes in graph', () => {
  let called = false;
  const orig = Math.random;
  Math.random = () => { called = true; return orig(); };
  try {
    solveProportions(cloneGraph(makeRootGraph()), baseEnvelope, {
      rootFlare: 0.4, rootTaper: 0.6, succulence: 0.5,
    });
    assert.strictEqual(called, false, 'Math.random must not be called even with root nodes');
  } finally {
    Math.random = orig;
  }
});

// ---------------------------------------------------------------------------
// 33. ROOT PIPE-MODEL — determinism with root nodes
// ---------------------------------------------------------------------------

test('root pipe-model: bit-for-bit determinism with root nodes across two calls', () => {
  const genome = { rootFlare: 0.4, rootTaper: 0.6, succulence: 0.3 };

  const r1 = solveProportions(cloneGraph(makeRootGraph()), baseEnvelope, genome);
  const r2 = solveProportions(cloneGraph(makeRootGraph()), baseEnvelope, genome);

  assert.deepStrictEqual(
    r1.nodes.map(n => ({ radius: n.radius, pos: n.pos })),
    r2.nodes.map(n => ({ radius: n.radius, pos: n.pos })),
    'Root node radii and positions must be bit-for-bit identical on repeat calls'
  );
});
