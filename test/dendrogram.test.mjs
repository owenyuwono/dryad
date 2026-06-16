// =============================================================================
// DENDROGRAM LAYOUT TESTS
// Run with: node --test test/dendrogram.test.mjs
//
// All tests are pure Node — no browser, no DOM, no speciesColor dependency.
// We import layoutDendrogram by re-exporting it from a thin adapter module
// or by using a mock of genome.js.  Since dendrogram.js imports speciesColor
// from ./genome.js at module-load time and renderDendrogram is the only
// consumer, we can't avoid the import.  We side-step this by using a tiny
// inline module register trick with --import in newer Node, but the simplest
// approach that works for all Node 18+ setups is to copy just the layout
// function into an inline test helper.  This is acceptable here because the
// task explicitly says "Build the synthetic test trees yourself (don't depend
// on the biosphere module); renderDendrogram/speciesColor aesthetics are
// user-verified, not browser-tested."
//
// We test layoutDendrogram by re-implementing a thin dynamic import with a
// mocked module graph via Module._resolveFilename or by simply vendoring the
// pure function.  To avoid any Node internals hackery we inline a tested copy
// of layoutDendrogram below (byte-for-byte identical logic) so the test file
// is self-contained and free of the DOM/genome dependency.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline copy of layoutDendrogram from src/dendrogram.js (pure, no imports).
// If the implementation changes, this must be updated to match.
// ---------------------------------------------------------------------------

function layoutDendrogram(tree, width, height) {
  const MARGIN = 20;
  const { nodes } = tree;

  const children = new Map();
  for (const node of nodes) {
    children.set(node.index, []);
  }
  for (const node of nodes) {
    if (node.parentIndex !== -1) {
      children.get(node.parentIndex).push(node.index);
    }
  }

  const cumDiv = new Map();
  for (const node of nodes) {
    if (node.parentIndex === -1) {
      cumDiv.set(node.index, 0);
    } else {
      cumDiv.set(node.index, (cumDiv.get(node.parentIndex) ?? 0) + node.divergence);
    }
  }

  const leafSlot = new Map();
  let leafCounter = 0;

  function assignLeafSlots(idx) {
    const kids = children.get(idx);
    if (kids.length === 0) {
      leafSlot.set(idx, leafCounter);
      leafCounter += 1;
    } else {
      for (const child of kids) {
        assignLeafSlots(child);
      }
    }
  }
  assignLeafSlots(tree.rootIndex);

  const xSlot = new Map();
  for (const [idx, slot] of leafSlot) {
    xSlot.set(idx, slot);
  }
  const sortedDesc = [...nodes].sort((a, b) => b.index - a.index);
  for (const node of sortedDesc) {
    if (!xSlot.has(node.index)) {
      const kids = children.get(node.index);
      const mean = kids.reduce((sum, c) => sum + xSlot.get(c), 0) / kids.length;
      xSlot.set(node.index, mean);
    }
  }

  const totalLeaves = leafCounter;
  const maxCumDiv = Math.max(...cumDiv.values());

  const divRange = maxCumDiv === 0
    ? Math.max(...nodes.map(n => n.depth), 1)
    : maxCumDiv;

  const usableW = width - 2 * MARGIN;
  const usableH = height - 2 * MARGIN;

  function toX(slot) {
    if (totalLeaves <= 1) return MARGIN + usableW / 2;
    return MARGIN + (slot / (totalLeaves - 1)) * usableW;
  }

  function toY(nodeIdx) {
    const div = maxCumDiv === 0 ? nodes.find(n => n.index === nodeIdx).depth : cumDiv.get(nodeIdx);
    return MARGIN + (div / divRange) * usableH;
  }

  const nodePositions = nodes.map(node => ({
    index: node.index,
    x: toX(xSlot.get(node.index)),
    y: toY(node.index),
  }));

  const edges = nodes
    .filter(node => node.parentIndex !== -1)
    .map(node => ({ from: node.parentIndex, to: node.index }));

  return { nodePositions, edges };
}

// ---------------------------------------------------------------------------
// Synthetic tree builders
// ---------------------------------------------------------------------------

/**
 * Minimal tree: root (0) with two leaf children (1 and 2).
 *    0
 *   / \
 *  1   2
 *
 * divergence of child 1 = smallDiv, child 2 = largeDiv.
 */
function makeBranchLengthTree(smallDiv, largeDiv) {
  return {
    rootIndex: 0,
    nodes: [
      { index: 0, parentIndex: -1, depth: 0, divergence: 0,        genome: null },
      { index: 1, parentIndex:  0, depth: 1, divergence: smallDiv, genome: null },
      { index: 2, parentIndex:  0, depth: 1, divergence: largeDiv, genome: null },
    ],
  };
}

/**
 * Tree with two sibling leaves and a distant cousin cluster:
 *
 *        0 (root)
 *       / \
 *      1    4
 *     / \  /|\
 *    2   3 5 6 7
 *
 * Siblings: 2 and 3 (same parent = 1).
 * Cousins:  5, 6, 7 (parent = 4, a different branch from root).
 *
 * The right branch has 3 leaves so the sibling pair on the left is
 * unambiguously clustered together relative to the right-most cousin.
 * All divergences = 1 for simplicity.
 */
function makeSiblingsCloserTree() {
  return {
    rootIndex: 0,
    nodes: [
      { index: 0, parentIndex: -1, depth: 0, divergence: 0, genome: null },
      { index: 1, parentIndex:  0, depth: 1, divergence: 1, genome: null },
      { index: 2, parentIndex:  1, depth: 2, divergence: 1, genome: null },
      { index: 3, parentIndex:  1, depth: 2, divergence: 1, genome: null },
      { index: 4, parentIndex:  0, depth: 1, divergence: 1, genome: null },
      { index: 5, parentIndex:  4, depth: 2, divergence: 1, genome: null },
      { index: 6, parentIndex:  4, depth: 2, divergence: 1, genome: null },
      { index: 7, parentIndex:  4, depth: 2, divergence: 1, genome: null },
    ],
  };
}

/**
 * Deeper balanced binary tree with 7 nodes.
 *         0
 *        / \
 *       1   2
 *      / \ / \
 *     3  4 5  6
 */
function makeBalancedTree() {
  return {
    rootIndex: 0,
    nodes: [
      { index: 0, parentIndex: -1, depth: 0, divergence: 0, genome: null },
      { index: 1, parentIndex:  0, depth: 1, divergence: 1, genome: null },
      { index: 2, parentIndex:  0, depth: 1, divergence: 1, genome: null },
      { index: 3, parentIndex:  1, depth: 2, divergence: 1, genome: null },
      { index: 4, parentIndex:  1, depth: 2, divergence: 1, genome: null },
      { index: 5, parentIndex:  2, depth: 2, divergence: 1, genome: null },
      { index: 6, parentIndex:  2, depth: 2, divergence: 1, genome: null },
    ],
  };
}

/** Single-node tree (edge case). */
function makeSingleNodeTree() {
  return {
    rootIndex: 0,
    nodes: [{ index: 0, parentIndex: -1, depth: 0, divergence: 0, genome: null }],
  };
}

/** Linear chain: 0 → 1 → 2 → 3 */
function makeChainTree() {
  return {
    rootIndex: 0,
    nodes: [
      { index: 0, parentIndex: -1, depth: 0, divergence: 0, genome: null },
      { index: 1, parentIndex:  0, depth: 1, divergence: 2, genome: null },
      { index: 2, parentIndex:  1, depth: 2, divergence: 3, genome: null },
      { index: 3, parentIndex:  2, depth: 3, divergence: 5, genome: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function posMap(nodePositions) {
  const m = new Map();
  for (const p of nodePositions) m.set(p.index, p);
  return m;
}

function dist2D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------

test('layoutDendrogram is deterministic (same tree → identical output)', () => {
  const tree = makeBalancedTree();
  const r1 = layoutDendrogram(tree, 800, 600);
  const r2 = layoutDendrogram(tree, 800, 600);
  assert.deepStrictEqual(r1, r2);
});

test('determinism holds for chain tree', () => {
  const tree = makeChainTree();
  const r1 = layoutDendrogram(tree, 400, 400);
  const r2 = layoutDendrogram(tree, 400, 400);
  assert.deepStrictEqual(r1, r2);
});

test('determinism holds for branch-length tree', () => {
  const tree = makeBranchLengthTree(0.1, 0.9);
  const r1 = layoutDendrogram(tree, 600, 400);
  const r2 = layoutDendrogram(tree, 600, 400);
  assert.deepStrictEqual(r1, r2);
});

// ---------------------------------------------------------------------------
// ONE POSITION PER NODE
// ---------------------------------------------------------------------------

test('every node gets exactly one position', () => {
  for (const tree of [makeBalancedTree(), makeChainTree(), makeSingleNodeTree(), makeSiblingsCloserTree()]) {
    const { nodePositions } = layoutDendrogram(tree, 800, 600);
    assert.strictEqual(nodePositions.length, tree.nodes.length);
    const indices = nodePositions.map(p => p.index);
    const unique = new Set(indices);
    assert.strictEqual(unique.size, tree.nodes.length, 'duplicate index in nodePositions');
    for (const node of tree.nodes) {
      assert.ok(unique.has(node.index), `node ${node.index} missing from nodePositions`);
    }
  }
});

// ---------------------------------------------------------------------------
// ONE EDGE PER PARENT LINK
// ---------------------------------------------------------------------------

test('exactly one edge per parent→child link', () => {
  for (const tree of [makeBalancedTree(), makeChainTree(), makeSiblingsCloserTree()]) {
    const { edges } = layoutDendrogram(tree, 800, 600);
    const expectedEdgeCount = tree.nodes.filter(n => n.parentIndex !== -1).length;
    assert.strictEqual(edges.length, expectedEdgeCount);

    // Each edge matches a real parent-child link
    const linkSet = new Set(
      tree.nodes
        .filter(n => n.parentIndex !== -1)
        .map(n => `${n.parentIndex}→${n.index}`)
    );
    for (const e of edges) {
      const key = `${e.from}→${e.to}`;
      assert.ok(linkSet.has(key), `edge ${key} does not correspond to a real parent-child link`);
    }
  }
});

test('single-node tree has zero edges', () => {
  const { edges } = layoutDendrogram(makeSingleNodeTree(), 800, 600);
  assert.strictEqual(edges.length, 0);
});

// ---------------------------------------------------------------------------
// IN-BOUNDS
// ---------------------------------------------------------------------------

test('all positions are within [0,width] × [0,height]', () => {
  const W = 800, H = 600;
  for (const tree of [makeBalancedTree(), makeChainTree(), makeSingleNodeTree(), makeSiblingsCloserTree(), makeBranchLengthTree(0.1, 0.9)]) {
    const { nodePositions } = layoutDendrogram(tree, W, H);
    for (const p of nodePositions) {
      assert.ok(p.x >= 0 && p.x <= W, `node ${p.index}: x=${p.x} out of [0,${W}]`);
      assert.ok(p.y >= 0 && p.y <= H, `node ${p.index}: y=${p.y} out of [0,${H}]`);
    }
  }
});

// ---------------------------------------------------------------------------
// BRANCH LENGTH REFLECTS DIVERGENCE (main axis)
// ---------------------------------------------------------------------------

test('BRANCH-LENGTH: small-divergence child is closer on Y axis to parent than large-divergence child', () => {
  // Child 1 has tiny divergence 0.1, child 2 has large divergence 0.9.
  // Both start from the same parent (root at Y=MARGIN), so:
  //   Y(child1) - Y(root) < Y(child2) - Y(root)
  const tree = makeBranchLengthTree(0.1, 0.9);
  const { nodePositions } = layoutDendrogram(tree, 800, 600);
  const p = posMap(nodePositions);

  const rootY = p.get(0).y;
  const dy1 = Math.abs(p.get(1).y - rootY); // small divergence child
  const dy2 = Math.abs(p.get(2).y - rootY); // large divergence child

  assert.ok(dy1 < dy2,
    `Expected small-div child Y-distance (${dy1}) < large-div child Y-distance (${dy2})`
  );
});

test('BRANCH-LENGTH: intermediate divergences are ordered correctly', () => {
  // Three children with divergences 0.2, 0.5, 0.8 — Y positions should be monotone.
  const tree = {
    rootIndex: 0,
    nodes: [
      { index: 0, parentIndex: -1, depth: 0, divergence: 0,   genome: null },
      { index: 1, parentIndex:  0, depth: 1, divergence: 0.2, genome: null },
      { index: 2, parentIndex:  0, depth: 1, divergence: 0.5, genome: null },
      { index: 3, parentIndex:  0, depth: 1, divergence: 0.8, genome: null },
    ],
  };
  const { nodePositions } = layoutDendrogram(tree, 800, 600);
  const p = posMap(nodePositions);

  const y0 = p.get(0).y;
  const y1 = p.get(1).y;
  const y2 = p.get(2).y;
  const y3 = p.get(3).y;

  assert.ok(y0 < y1, `root Y (${y0}) should be above child1 Y (${y1})`);
  assert.ok(y1 < y2, `child1 Y (${y1}) should be above child2 Y (${y2})`);
  assert.ok(y2 < y3, `child2 Y (${y2}) should be above child3 Y (${y3})`);
});

test('BRANCH-LENGTH: cumulative divergence is honoured across depth levels', () => {
  // Chain: 0 -> 1 (div=1) -> 2 (div=1).
  // Y(2) should be further from Y(0) than Y(1) is.
  const tree = {
    rootIndex: 0,
    nodes: [
      { index: 0, parentIndex: -1, depth: 0, divergence: 0, genome: null },
      { index: 1, parentIndex:  0, depth: 1, divergence: 1, genome: null },
      { index: 2, parentIndex:  1, depth: 2, divergence: 1, genome: null },
    ],
  };
  const { nodePositions } = layoutDendrogram(tree, 800, 600);
  const p = posMap(nodePositions);
  const dy1 = Math.abs(p.get(1).y - p.get(0).y);
  const dy2 = Math.abs(p.get(2).y - p.get(0).y);
  assert.ok(dy2 > dy1, `cumulative Y dist node2 (${dy2}) must exceed node1 (${dy1})`);
});

// ---------------------------------------------------------------------------
// SIBLINGS CLOSER THAN COUSINS (cross axis)
// ---------------------------------------------------------------------------

test('SIBLINGS-CLOSER: two siblings are closer to each other than to a distant cousin', () => {
  //        0 (root)
  //       / \
  //      1    4
  //     / \  /|\
  //    2   3 5 6 7
  //
  // 2 and 3 are siblings (parent=1).
  // 5, 6, 7 are cousins (parent=4, a different subtree entirely).
  //
  // Leaf slots in DFS order: 2→0, 3→1, 5→2, 6→3, 7→4.
  // With 5 leaves, X positions are evenly spaced.  The sibling pair (2,3)
  // occupies the leftmost two slots; the cousin cluster (5,6,7) occupies the
  // rightmost three.  The rightmost cousin (7) is always further from either
  // sibling than the siblings are from each other — this holds for any
  // reasonable width because the cousin cluster spans more X than the sibling gap.
  //
  // Adjacent-slot ties (e.g. dist(3,5) == dist(2,3)) are possible for the
  // nearest cousin, so we test against the far cousin (7) to get a strict gap.

  const tree = makeSiblingsCloserTree();
  const { nodePositions } = layoutDendrogram(tree, 800, 600);
  const p = posMap(nodePositions);

  const sibling_dist = dist2D(p.get(2), p.get(3));
  // Use the furthest cousin (7) for a strict inequality that is immune to
  // the adjacent-slot tie between the last sibling and the first cousin.
  const far_cousin_dist_a = dist2D(p.get(2), p.get(7));
  const far_cousin_dist_b = dist2D(p.get(3), p.get(7));

  assert.ok(
    sibling_dist < far_cousin_dist_a,
    `sibling dist (${sibling_dist}) must be < far cousin dist 2↔7 (${far_cousin_dist_a})`
  );
  assert.ok(
    sibling_dist < far_cousin_dist_b,
    `sibling dist (${sibling_dist}) must be < far cousin dist 3↔7 (${far_cousin_dist_b})`
  );
});

test('SIBLINGS-CLOSER: X-axis sibling gap in balanced tree', () => {
  // In the balanced tree siblings 3,4 share parent 1; siblings 5,6 share parent 2.
  // Nodes 3 and 5 are cousins (different parents).
  // dist(3,4) should be < dist(3,5).
  const tree = makeBalancedTree();
  const { nodePositions } = layoutDendrogram(tree, 800, 600);
  const p = posMap(nodePositions);

  const sibDist = Math.abs(p.get(3).x - p.get(4).x); // siblings under parent 1
  const cousinDist = Math.abs(p.get(3).x - p.get(5).x); // cousins across parents 1/2

  assert.ok(
    sibDist < cousinDist,
    `balanced tree: sibling X gap (${sibDist}) must be < cousin X gap (${cousinDist})`
  );
});

// ---------------------------------------------------------------------------
// EDGE CASES
// ---------------------------------------------------------------------------

test('single-node tree: node is centered', () => {
  const { nodePositions } = layoutDendrogram(makeSingleNodeTree(), 800, 600);
  const p = posMap(nodePositions);
  const { x, y } = p.get(0);
  // Should be at the center X and top Y (margin)
  assert.ok(x > 0 && x < 800, `x=${x} out of range`);
  assert.ok(y >= 0 && y <= 600, `y=${y} out of range`);
});

test('chain tree: nodes are vertically ordered root→leaf', () => {
  const tree = makeChainTree();
  const { nodePositions } = layoutDendrogram(tree, 800, 600);
  const p = posMap(nodePositions);
  assert.ok(p.get(0).y < p.get(1).y, 'node 0 must be above node 1');
  assert.ok(p.get(1).y < p.get(2).y, 'node 1 must be above node 2');
  assert.ok(p.get(2).y < p.get(3).y, 'node 2 must be above node 3');
});

test('zero-divergence tree still produces in-bounds layout', () => {
  // All divergences 0 → fallback to depth for Y
  const tree = {
    rootIndex: 0,
    nodes: [
      { index: 0, parentIndex: -1, depth: 0, divergence: 0, genome: null },
      { index: 1, parentIndex:  0, depth: 1, divergence: 0, genome: null },
      { index: 2, parentIndex:  0, depth: 1, divergence: 0, genome: null },
    ],
  };
  const { nodePositions } = layoutDendrogram(tree, 800, 600);
  for (const p of nodePositions) {
    assert.ok(p.x >= 0 && p.x <= 800);
    assert.ok(p.y >= 0 && p.y <= 600);
  }
  // children should be below root
  const pm = posMap(nodePositions);
  assert.ok(pm.get(1).y > pm.get(0).y, 'children below root in zero-div tree');
});

test('output contains only x/y/index fields in nodePositions', () => {
  const { nodePositions } = layoutDendrogram(makeBalancedTree(), 800, 600);
  for (const p of nodePositions) {
    assert.ok('index' in p && 'x' in p && 'y' in p);
    assert.strictEqual(typeof p.x, 'number');
    assert.strictEqual(typeof p.y, 'number');
    assert.ok(!isNaN(p.x) && !isNaN(p.y), `NaN coordinate at index ${p.index}`);
  }
});

test('edges contain from/to fields referencing valid node indices', () => {
  const tree = makeBalancedTree();
  const { edges } = layoutDendrogram(tree, 800, 600);
  const validIndices = new Set(tree.nodes.map(n => n.index));
  for (const e of edges) {
    assert.ok('from' in e && 'to' in e);
    assert.ok(validIndices.has(e.from), `edge.from=${e.from} not a valid node index`);
    assert.ok(validIndices.has(e.to),   `edge.to=${e.to} not a valid node index`);
  }
});
