// =============================================================================
// DENDROGRAM — phylogeny tree layout + SVG renderer for the biosphere viewer.
//
// layoutDendrogram(tree, width, height) -> { nodePositions, edges }
//   PURE and deterministic — safe to run in Node, no DOM access.
//
// renderDendrogram(container, layout, tree)
//   Draws an SVG into `container`. Imports speciesColor from ./genome.js.
// =============================================================================

import { speciesColor } from './genome.js';

// ---------------------------------------------------------------------------
// LAYOUT
// ---------------------------------------------------------------------------

/**
 * Compute a 2D tidy-tree layout for the phylogeny.
 *
 * Y axis (main axis, top → bottom): cumulative divergence along the path from
 * the root to each node, scaled to fit [MARGIN, height - MARGIN].
 *
 * X axis (cross axis, left → right): leaves are assigned consecutive integer
 * slots [0 .. leafCount-1]; each internal node is placed at the mean of its
 * children's final X coordinates.  The result is then linearly scaled to
 * [MARGIN, width - MARGIN].
 *
 * @param {{ rootIndex: number, nodes: Array<{index:number, parentIndex:number, depth:number, divergence:number, genome:*}> }} tree
 * @param {number} width
 * @param {number} height
 * @returns {{ nodePositions: Array<{index:number,x:number,y:number}>, edges: Array<{from:number,to:number}> }}
 */
export function layoutDendrogram(tree, width, height) {
  const MARGIN = 20;
  const { nodes } = tree;

  // --- Step 1: build children map (index → [child indices]) ---
  const children = new Map();
  for (const node of nodes) {
    children.set(node.index, []);
  }
  for (const node of nodes) {
    if (node.parentIndex !== -1) {
      children.get(node.parentIndex).push(node.index);
    }
  }

  // --- Step 2: compute cumulative divergence (Y) for each node ---
  // cumDiv[i] = sum of divergence from root to node i.
  // We process in ascending index order; the spec guarantees children have
  // larger indices than their parents, so parent is always resolved first.
  const cumDiv = new Map();
  for (const node of nodes) {
    if (node.parentIndex === -1) {
      cumDiv.set(node.index, 0);
    } else {
      cumDiv.set(node.index, (cumDiv.get(node.parentIndex) ?? 0) + node.divergence);
    }
  }

  // --- Step 3: assign leaf slots (X) in depth-first, left-to-right order ---
  // A post-order DFS ensures siblings are adjacent; leaf counter increments
  // only at leaves so their slots are consecutive integers 0,1,2,...
  const leafSlot = new Map();
  let leafCounter = 0;

  function assignLeafSlots(idx) {
    const kids = children.get(idx);
    if (kids.length === 0) {
      // Leaf
      leafSlot.set(idx, leafCounter);
      leafCounter += 1;
    } else {
      // Internal: visit children first (left-to-right, i.e. ascending index)
      for (const child of kids) {
        assignLeafSlots(child);
      }
    }
  }
  assignLeafSlots(tree.rootIndex);

  // --- Step 4: assign X slot to each internal node = mean of children's slots ---
  // We need a bottom-up pass (leaves → root), which is reverse index order
  // since children always have larger indices.
  const xSlot = new Map();
  // First seed leaves
  for (const [idx, slot] of leafSlot) {
    xSlot.set(idx, slot);
  }
  // Process in descending index order so children are done before parents
  const sortedDesc = [...nodes].sort((a, b) => b.index - a.index);
  for (const node of sortedDesc) {
    if (!xSlot.has(node.index)) {
      // Internal node: mean of children
      const kids = children.get(node.index);
      const mean = kids.reduce((sum, c) => sum + xSlot.get(c), 0) / kids.length;
      xSlot.set(node.index, mean);
    }
  }

  // --- Step 5: scale to pixel space ---
  const totalLeaves = leafCounter; // slots run [0 .. totalLeaves-1]
  const maxCumDiv = Math.max(...cumDiv.values());

  // Guard: if all nodes share the same cumDiv (all divergence = 0), avoid
  // division by zero and spread them by depth instead.
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

  // --- Step 6: build output arrays ---
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
// RENDERER
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/**
 * Draw the dendrogram into `container` as an SVG.
 * Clears any prior SVG before rendering.
 *
 * @param {HTMLElement} container
 * @param {{ nodePositions: Array<{index:number,x:number,y:number}>, edges: Array<{from:number,to:number}> }} layout
 * @param {{ nodes: Array<{index:number,genome:*}> }} tree
 */
export function renderDendrogram(container, layout, tree) {
  // Remove any existing SVG
  const existing = container.querySelector('svg');
  if (existing) existing.remove();

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  const svg = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    style: 'display:block;background:#0a0a0f;',
  });

  // --- Build position lookup ---
  const pos = new Map();
  for (const p of layout.nodePositions) {
    pos.set(p.index, p);
  }

  // --- Build genome lookup ---
  const genomeMap = new Map();
  for (const node of tree.nodes) {
    genomeMap.set(node.index, node.genome);
  }

  // --- Draw edges first (behind nodes) ---
  const edgeGroup = svgEl('g', { class: 'edges', opacity: '0.55' });
  for (const edge of layout.edges) {
    const p0 = pos.get(edge.from);
    const p1 = pos.get(edge.to);
    if (!p0 || !p1) continue;

    // Elbow path: horizontal jog at parent's Y, then vertical to child's Y.
    // This gives the "comb" look typical of cladograms.
    const line = svgEl('path', {
      d: `M ${p0.x} ${p0.y} L ${p1.x} ${p0.y} L ${p1.x} ${p1.y}`,
      fill: 'none',
      stroke: '#4a6fa5',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
    });
    edgeGroup.appendChild(line);
  }
  svg.appendChild(edgeGroup);

  // --- Draw node markers ---
  const nodeGroup = svgEl('g', { class: 'nodes' });
  for (const p of layout.nodePositions) {
    const genome = genomeMap.get(p.index);
    const color = speciesColor(genome);
    const r = 5;

    const circle = svgEl('circle', {
      cx: p.x,
      cy: p.y,
      r,
      fill: color,
      stroke: '#ffffff',
      'stroke-width': '0.8',
    });
    nodeGroup.appendChild(circle);

    // Small index label, offset so it doesn't overlap the circle
    const label = svgEl('text', {
      x: p.x + r + 2,
      y: p.y + 4,
      'font-size': '9',
      'font-family': 'monospace',
      fill: '#cccccc',
      'pointer-events': 'none',
    });
    label.textContent = String(p.index);
    nodeGroup.appendChild(label);
  }
  svg.appendChild(nodeGroup);

  container.appendChild(svg);
}
