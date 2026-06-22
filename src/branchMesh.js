// =============================================================================
// branchMesh.js — buildBranchGeometry(graph, opts)
//
// Converts a solved skeleton graph (from buildSkeleton + solveProportions) into
// merged tapered-tube mesh geometry. Pure ESM, no three.js import, pure typed-array
// output, node-testable.
//
// EXPORTED API:
//   buildBranchGeometry(graph, opts = {}) -> {
//     // --- existing arrays (byte-identical to pre-wind-bone version) ---
//     positions:     Float32Array(3*V),   // xyz per vertex
//     normals:       Float32Array(3*V),   // outward tube normal per vertex
//     uvs:           Float32Array(2*V),   // [u=angle/2π, v=arcLen] per vertex
//     ao:            Float32Array(V),     // ambient occlusion [0,1], darker at trunk base and fork crotches
//     windWeight:    Float32Array(V),     // wind sway weight [0,1]: 0=rigid (trunk/roots), 1=max flex (thin twigs)
//     indices:       Uint32Array(3*T),    // triangle indices
//     vertexCount:   V,
//     triangleCount: T,
//     bounds: { min:[x,y,z], max:[x,y,z] },
//     // --- new: per-vertex bone skin data ---
//     boneIndex:     Float32Array(V),     // which wind-bone (chain) this vertex belongs to; 0..boneCount-1
//     boneFraction:  Float32Array(V),     // normalized arc position along chain [0=pivot, 1=chain end]
//     // --- new: wind-bone hierarchy tables ---
//     bones_wind: {
//       count:        number,             // number of wind bones (chains), <= MAX_WIND_BONES
//       parent:       Int32Array(count),  // parent wind-bone index, or -1 for the root (trunk) chain
//       pivot:        Float32Array(3*count), // chain-start world position (rotation pivot)
//       axisHint:     Float32Array(3*count), // unit chain-start tangent
//       stiffness:    Float32Array(count),   // [0,1]: 0=rigid, 1=max flex
//       branchLevel:  Int32Array(count),     // chain's branchLevel
//       isRigid:      Uint8Array(count),     // 1 if trunk/root chain (force angle=0); else 0
//     },
//     // --- new: node-to-bone mapping ---
//     nodeToBone:    Int32Array(nodes.length), // graph node index → wind-bone index (-1 = not rendered)
//   }
//
// MAX_WIND_BONES is exported as a named constant (1024, power-of-two, DataTexture-friendly).
// One bone per chain. Bone ordering guarantees parent[c] < c for all non-root bones.
//
// CONSTRUCTION OVERVIEW:
//
//   CHAIN WALKING:
//     A chain is a run of nodes where each node has exactly one child that is
//     also the next bone in a linear sequence. Forks (multi-child nodes) and
//     tips break chains. For each chain we emit one RING of vertices per node.
//
//   RINGS AND QUADS:
//     Between consecutive rings r[i] and r[i+1] we emit a quad-strip: for each
//     radial segment pair (j, j+1 mod segs) we emit 2 triangles.
//
//   RADIAL SEGMENTS (default, overridable via opts.radialSegsFor(level)):
//     branchLevel 0 → 16 segments  (trunk — smoothly round)
//     branchLevel 1 → 10 segments  (primary branches)
//     branchLevel 2 →  7 segments
//     branchLevel ≥3 →  5 segments  (fine twigs — kept cheap)
//
//   PER-RING RADIUS:
//     max(node.radius, opts.minRadius ?? 0.004)
//     Tip nodes already have near-zero radius from proportions.js tip-taper pass
//     (≈0.012), which reads as a natural cone tip.
//
//   TIP APEX COLLAPSE:
//     For a childless chain end (tip node), the final "ring" collapses to a
//     single apex vertex. That apex fans into triangles connecting to the
//     previous ring. This produces a clean pointed tip with no degenerate quads.
//
//   PARALLEL-TRANSPORT FRAMES (rotation-minimizing):
//     Along a chain, each ring's tangential frame is carried from the previous
//     ring by rotating the previous {u, v} basis minimally to align with the
//     new tangent. This eliminates the twist you'd get from naively re-computing
//     perpTo(tangent) at each node.
//     At each fork (start of a new chain), the frame resets via perpTo(tangent).
//
//   NORMALS:
//     Per-vertex outward tube normals computed from the ring basis vectors:
//       normal[j] = cos(θ[j])*u + sin(θ[j])*v   (already unit if u,v are unit)
//
//   UVs:
//     u = j / segs   (angle around tube, 0..1)
//     v = accumulated arc length from chain start (world units)
//     Bark grain flows along the branch. Arc length is the distance between
//     consecutive node positions along the chain.
//
//   AO:
//     Per-vertex ambient occlusion in [0.35, 1.0].  Darker at the trunk base
//     (thicker/inner nodes) and at fork crotches (nodes with ≥2 children or
//     direct children of fork nodes).  Deterministic — geometry only, no rng.
//
//   WIND WEIGHT:
//     Per-vertex sway weight in [0, 1].  Root nodes are anchored (0).  All other
//     nodes are mapped by thinness: thick trunk→≈0, thin twigs→≈1, sharpened by
//     pow(thinness, 1.5).  Deterministic — geometry only, no rng.
//
//   BOUNDS:
//     AABB computed over all emitted vertex positions. Guaranteed to contain
//     every rendered node position (ring vertices are placed at node.pos ±radius
//     in the ring plane, so the AABB is naturally wider than node positions alone).
//
//   EMPTY GRAPH:
//     Zero bones → returns zero-length typed arrays, vertexCount/triangleCount=0,
//     degenerate bounds at origin. Never throws.
//
//   DETERMINISM:
//     Pure function of graph. No Math.random, no Date, no global state.
//     Two calls on the same solved graph → byte-identical output arrays.
// =============================================================================

// ---------------------------------------------------------------------------
// Math helpers (pure, no allocations beyond return arrays)
// ---------------------------------------------------------------------------

function v3len(v) {
  return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
}

function v3norm(v) {
  const len = v3len(v);
  if (len < 1e-12) return [1, 0, 0];
  return [v[0]/len, v[1]/len, v[2]/len];
}

function v3dot(a, b) {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

function v3cross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

function v3sub(a, b) {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}

// Compute a stable perpendicular to a unit vector.
// Matches the same approach used in skeleton.js `perpTo`.
function perpTo(dir) {
  if (Math.abs(v3dot(dir, [1,0,0])) < 0.9) {
    return v3norm(v3cross(dir, [1,0,0]));
  }
  return v3norm(v3cross(dir, [0,0,1]));
}

// Rotate frame basis {u,v} to align with newTangent using the parallel-transport
// (rotation-minimizing) update. The previous tangent is prevTangent.
// Returns updated [u, v] (both unit, orthogonal to newTangent).
function transportFrame(prevTangent, newTangent, u, v) {
  // Rodrigues rotation of u and v by the rotation that maps prevTangent → newTangent.
  // axis = normalize(prevTangent × newTangent)
  // angle = acos(clamp(dot, -1, 1))
  const d = Math.max(-1, Math.min(1, v3dot(prevTangent, newTangent)));
  if (d > 1 - 1e-10) {
    // Already aligned — no rotation needed.
    return [u, v];
  }
  const axisRaw = v3cross(prevTangent, newTangent);
  const axisLen = v3len(axisRaw);
  if (axisLen < 1e-12) {
    // Anti-parallel: flip both basis vectors.
    return [[-u[0],-u[1],-u[2]], [-v[0],-v[1],-v[2]]];
  }
  const ax = [axisRaw[0]/axisLen, axisRaw[1]/axisLen, axisRaw[2]/axisLen];
  const angle = Math.acos(d);
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  function rotVec(vec) {
    const dt = v3dot(ax, vec);
    const cr = v3cross(ax, vec);
    return [
      vec[0]*c + cr[0]*s + ax[0]*dt*(1-c),
      vec[1]*c + cr[1]*s + ax[1]*dt*(1-c),
      vec[2]*c + cr[2]*s + ax[2]*dt*(1-c),
    ];
  }

  return [v3norm(rotVec(u)), v3norm(rotVec(v))];
}

// ---------------------------------------------------------------------------
// Default radial segment count by branch level.
// opts.radialSegsFor(level) overrides this.
// ---------------------------------------------------------------------------
function defaultRadialSegs(level) {
  if (level <= 0) return 16;
  if (level === 1) return 10;
  if (level === 2) return 7;
  return 5;
}

// ---------------------------------------------------------------------------
// ringProfile — pure, exported, unit-testable cross-section modulator.
//
// Returns { rScale, uScale, nU, nV } where:
//   rScale : radial scale factor (1.0 = no rib modulation)
//   uScale : u-axis squash factor (1.0 = no flatness)
//   nU     : analytic in-plane normal component along the u-axis basis vector
//   nV     : analytic in-plane normal component along the v-axis basis vector
//
// The actual ring vertex offset is:
//   offset = r * rScale * (cosθ · u · uScale + sinθ · v)
//
// The outward normal in 3D is:
//   normal = normalize(nU · u + nV · v)
//
// IDENTITY AT ZERO:
//   At ribbing=0 AND flatness=0:
//     rScale = 1, uScale = 1
//     dRscale/dθ = 0
//     nU = 0*sinθ + 1*cosθ = cosθ
//     nV = 1*sinθ*1 - 0   = sinθ
//   → normal = cosθ·u + sinθ·v  (exact radial normal, byte-identical to prior code)
//
// DERIVATION:
//   P(θ) = rScale * (cosθ·uScale, sinθ)  in the (u,v) cross-section plane.
//   dP/dθ = (dRscale/dθ·cosθ·uScale - rScale·sinθ·uScale,
//             dRscale/dθ·sinθ        + rScale·cosθ)
//   Outward normal = tangent rotated −90° (CW) = (T_v, −T_u):
//     nU =  T_v = dRscale/dθ·sinθ + rScale·cosθ
//     nV = −T_u = rScale·sinθ·uScale − dRscale/dθ·cosθ·uScale
// ---------------------------------------------------------------------------
const RIB_DEPTH = 0.35;  // maximum fractional cut depth of a rib
const FLAT_MAX  = 0.80;  // maximum fractional squash along u-axis

export function ringProfile(theta, { ribbing = 0, ribCount = 10, flatness = 0 } = {}) {
  const ct = Math.cos(theta);
  const st = Math.sin(theta);

  // Radial modulation: flutes cut inward between ribs.
  const rScale = 1 - ribbing * RIB_DEPTH * 0.5 * (1 + Math.cos(ribCount * theta));

  // u-axis squash.
  const uScale = 1 - flatness * FLAT_MAX;

  // Derivative of rScale w.r.t. theta:
  //   d/dθ [1 - ribbing*RIB_DEPTH*0.5*(1 + cos(ribCount*θ))]
  //   = ribbing * RIB_DEPTH * 0.5 * ribCount * sin(ribCount*θ)
  const dRscale = ribbing * RIB_DEPTH * 0.5 * ribCount * Math.sin(ribCount * theta);

  // Analytic outward normal (in local (u, v) 2D cross-section coordinates):
  const nU = dRscale * st + rScale * ct;          // T_v
  const nV = rScale * st * uScale - dRscale * ct * uScale;  // −T_u

  return { rScale, uScale, nU, nV };
}

// ---------------------------------------------------------------------------
// buildBranchGeometry
// ---------------------------------------------------------------------------

/**
 * Build merged tapered-tube mesh geometry from a solved skeleton graph.
 *
 * @param {object} graph - { nodes, bones } from buildSkeleton + solveProportions.
 *   nodes[i] = { pos:[x,y,z], radius, branchLevel, parentIdx, isRoot, isStem,
 *                isWoody, isTerminal, weight, ... }
 *   bones[i] = { a, b }  — a=parent node index, b=child node index, a < b.
 *
 * @param {object} [opts={}]
 *   opts.includeRoot     {boolean} — include root-flare bones (default: true).
 *   opts.minRadius       {number}  — minimum ring radius in world units (default: 0.004).
 *   opts.radialSegsFor   {function(level):number} — radial segment override.
 *     Default: level 0→16, level 1→10, level 2→7, level ≥3→5.
 *   opts.ribbing         {number}  — rib/flute depth [0,1] (default: 0 = perfect circle).
 *   opts.flatness        {number}  — u-axis squash [0,1] (default: 0 = perfect circle).
 *   opts.ribCount        {number}  — number of ribs around the circumference (default: 10).
 *     Typically derived from the `segmentation` gene by the caller.
 *
 * At opts.ribbing=0 AND opts.flatness=0 (the defaults), output is BYTE-IDENTICAL
 * to the pre-change code path — the perfect-circle identity is preserved exactly.
 *
 * @returns {{ positions, normals, uvs, ao, indices, vertexCount, triangleCount, bounds }}
 */
// ---------------------------------------------------------------------------
// MAX_WIND_BONES — budget for the DataTexture (one bone = one chain).
// Power-of-two is texture-friendly. The realistic worst case (bushy genome) is
// ~300–450 canopy chains + ~70–110 root chains = well under 1024.
// ---------------------------------------------------------------------------
export const MAX_WIND_BONES = 1024;

export function buildBranchGeometry(graph, opts = {}) {
  const { nodes, bones } = graph;
  const includeRoot = opts.includeRoot !== false;
  const minRadius = opts.minRadius !== undefined ? opts.minRadius : 0.004;
  const radialSegsFor = opts.radialSegsFor || defaultRadialSegs;
  // Cross-section modulation genes (defaults produce a perfect circle, byte-identical to old code).
  const ribbing  = opts.ribbing  !== undefined ? opts.ribbing  : 0;
  const flatness = opts.flatness !== undefined ? opts.flatness : 0;
  const ribCount = opts.ribCount !== undefined ? opts.ribCount : 10;

  // Guard: empty graph.
  if (!bones || bones.length === 0 || !nodes || nodes.length === 0) {
    return _emptyResult();
  }

  // -------------------------------------------------------------------------
  // Build children map: childrenOf[i] = sorted list of child node indices.
  // We need child counts to detect forks and tips.
  // -------------------------------------------------------------------------
  const childrenOf = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) childrenOf[i] = [];

  for (const bone of bones) {
    // bone.a < bone.b by contract; bone.a is the parent, bone.b is the child.
    childrenOf[bone.a].push(bone.b);
  }

  // -------------------------------------------------------------------------
  // Walk chains.
  //
  // A chain starts at any node that is:
  //   (a) the bone-graph root (no bone has it as child), OR
  //   (b) a child of a fork node (childrenOf[parent].length > 1).
  //
  // The chain continues as long as childrenOf[current].length === 1.
  // A chain ends when:
  //   - childrenOf[current].length === 0  → tip (apex collapse)
  //   - childrenOf[current].length > 1    → fork (next chain starts from each child)
  //
  // We include only bones that connect included nodes. Root-flare bones connect
  // to isRoot nodes; we skip them when !includeRoot.
  //
  // Chain representation: ordered array of node indices.
  // -------------------------------------------------------------------------

  // Determine which nodes appear as a bone's child side.
  const hasBoneParent = new Uint8Array(nodes.length);
  for (const bone of bones) {
    hasBoneParent[bone.b] = 1;
  }

  // Filter bones by includeRoot flag; rebuild childrenOf from the filtered set.
  const filteredBones = bones.filter(bone => {
    if (!includeRoot && (nodes[bone.a].isRoot || nodes[bone.b].isRoot)) return false;
    return true;
  });

  // Rebuild children from filtered bone set.
  const filteredChildrenOf = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) filteredChildrenOf[i] = [];
  const filteredHasBoneParent = new Uint8Array(nodes.length);
  for (const bone of filteredBones) {
    filteredChildrenOf[bone.a].push(bone.b);
    filteredHasBoneParent[bone.b] = 1;
  }

  // Chain-start nodes: appear in filtered bones but have no filtered bone parent,
  // OR are children of a filtered fork (multi-child) node.
  //
  // Strategy: collect chain starts by iterating filtered bones and tracking which
  // nodes need a chain started from them.
  const isChainStart = new Uint8Array(nodes.length);

  // Root of the bone graph (no parent in filtered set)
  for (const bone of filteredBones) {
    if (!filteredHasBoneParent[bone.a]) {
      isChainStart[bone.a] = 1;
    }
    // Children of forks also start new chains
    if (filteredChildrenOf[bone.a].length > 1) {
      for (const ci of filteredChildrenOf[bone.a]) {
        isChainStart[ci] = 1;
      }
    }
  }

  // Build list of chain start indices in node index order (deterministic).
  const chainStarts = [];
  for (let i = 0; i < nodes.length; i++) {
    if (isChainStart[i]) chainStarts.push(i);
  }

  // For each chain-start that is a child of a fork, record its fork parent so we
  // can prepend the fork node as an extra bridging ring.
  // parentOfChainStart[nodeIdx] = parent node index, or -1 if none.
  const parentOfChainStart = new Int32Array(nodes.length).fill(-1);
  for (const bone of filteredBones) {
    if (filteredChildrenOf[bone.a].length > 1) {
      // bone.a is a fork; each of its children starts a chain — record bone.a as parent.
      for (const ci of filteredChildrenOf[bone.a]) {
        parentOfChainStart[ci] = bone.a;
      }
    }
  }

  // Walk each chain into an ordered list of node indices.
  // When a chain starts at a child of a fork, the chain is prepended with the fork
  // parent node so that the fork→child bone is covered by geometry (no gap).
  const chains = [];
  for (const start of chainStarts) {
    const forkParent = parentOfChainStart[start];
    // Prepend fork parent if this chain starts at a child of a fork.
    const chain = forkParent >= 0 ? [forkParent, start] : [start];
    let cur = start;
    while (filteredChildrenOf[cur].length === 1) {
      cur = filteredChildrenOf[cur][0];
      chain.push(cur);
    }
    // chain may be a single node if it was a tip or fork endpoint; skip single-node degenerate chains
    // (single-node chains with no children produce no geometry)
    if (chain.length >= 2 || filteredChildrenOf[chain[chain.length - 1]].length === 0) {
      chains.push(chain);
    }
  }

  // -------------------------------------------------------------------------
  // First pass: count total vertices and triangles for typed-array allocation.
  //
  // For a chain of N nodes:
  //   If tip (last node childless): (N-1) rings * segs vertices + 1 apex = (N-1)*segs + 1
  //   Otherwise (chain ends at fork): N rings * segs vertices = N*segs
  //
  // Triangles:
  //   Quad-strip between rings r[i] and r[i+1]: segs*2 triangles each pair
  //   There are (N-1) consecutive ring pairs for non-tip, (N-2) pairs + 1 fan for tip.
  //   Tip fan: segs triangles (apex to previous ring).
  //   All other quads: (N-2)*segs*2 for non-tip; (N-2)*segs*2 + segs for tip (still N-2 quads then fan).
  //   Wait: for a non-tip chain with N nodes, there are N-1 quad-strip bands, each segs*2 tris.
  //   For a tip chain: N-2 quad-strip bands + 1 fan (segs tris).
  // -------------------------------------------------------------------------
  let totalV = 0;
  let totalT = 0;

  for (const chain of chains) {
    const N = chain.length;
    const level = nodes[chain[0]].branchLevel || 0;
    const segs = radialSegsFor(level);
    const isTip = filteredChildrenOf[chain[N-1]].length === 0;

    if (N === 1) {
      // Single node with no children — just one ring (or apex), no triangles.
      if (isTip) {
        totalV += 1; // apex only
        // No triangles (nothing to connect to)
      } else {
        totalV += segs; // one ring
        // No triangles
      }
      continue;
    }

    if (isTip) {
      // (N-1) full rings + 1 apex vertex
      totalV += (N - 1) * segs + 1;
      // (N-2) quad strips + 1 fan
      totalT += (N - 2) * segs * 2 + segs;
    } else {
      // N full rings
      totalV += N * segs;
      // (N-1) quad strips
      totalT += (N - 1) * segs * 2;
    }
  }

  // -------------------------------------------------------------------------
  // Allocate output buffers.
  // -------------------------------------------------------------------------
  const positions   = new Float32Array(totalV * 3);
  const normals     = new Float32Array(totalV * 3);
  const uvs         = new Float32Array(totalV * 2);
  const ao          = new Float32Array(totalV);
  const windWeight  = new Float32Array(totalV);
  const indices     = new Uint32Array(totalT * 3);
  // New: per-vertex bone skin data.
  const boneIndexAttr    = new Float32Array(totalV);
  const boneFractionAttr = new Float32Array(totalV);
  // New: per-vertex LOCAL TUBE RADIUS (world units) — the true ring radius, baked so the
  // bark shader can scale its feature size to actual thickness. (The old shader proxy
  // length(vObjPos.xz) measured distance from the world Y-axis, which is wrong on any
  // leaning/offset trunk — it varied the texture frequency wildly around the trunk.)
  const radii = new Float32Array(totalV);
  // Per-vertex branch FRAME (parallel-transported), so the bark shader can sample its pattern
  // in a coordinate that FOLLOWS the branch axis instead of world-Y. tangents = the branch
  // axial direction (T = u×v); frameUs = one cross-section basis (u). Both are constant around
  // a ring and vary along the branch (rotation-minimizing), so they interpolate smoothly.
  const tangents = new Float32Array(totalV * 3);
  const frameUs  = new Float32Array(totalV * 3);

  // Per-node AO — deterministic, geometry-only (no rng):
  //   - Inner / thick nodes (low branchLevel, large radius) are more occluded.
  //   - Fork adjacency (node is a fork, or its parent is a fork) darkens crotches.
  //
  // Base AO: normalize radius against the maximum in the graph so thick trunk
  // sections map to lower (darker) values.  Clamped to [0.35, 1.0].
  // Fork penalty: subtract 0.20 from nodes that are a fork (≥2 children in
  // filtered set) or are direct children of a fork, to darken crotch seams.
  //
  // This is pure geometry — two calls on the same graph produce identical results.

  // Find max and min radius for normalization (use all nodes).
  let maxRadius = 0;
  let minRadius_nodes = Infinity;
  for (let ni = 0; ni < nodes.length; ni++) {
    const r = nodes[ni].radius || 0;
    if (r > maxRadius) maxRadius = r;
    if (r < minRadius_nodes) minRadius_nodes = r;
  }
  if (maxRadius < 1e-8) maxRadius = 1; // degenerate guard
  // Guard: if all nodes have the same radius, avoid division by zero.
  if (minRadius_nodes >= maxRadius) minRadius_nodes = 0;

  // Identify fork nodes (≥2 children in the filtered bone set) and their children.
  const isFork           = new Uint8Array(nodes.length);
  const isForkChild      = new Uint8Array(nodes.length);
  for (const bone of filteredBones) {
    if (filteredChildrenOf[bone.a].length >= 2) {
      isFork[bone.a] = 1;
      isForkChild[bone.b] = 1;
    }
  }

  // Compute per-node AO.
  const nodeAO = new Float32Array(nodes.length);
  for (let ni = 0; ni < nodes.length; ni++) {
    const r = nodes[ni].radius || 0;
    // thicker → darker (more occluded): base = 1 - (r/maxRadius), remapped to [0.35, 1.0]
    const thicknessDark = r / maxRadius; // 0=thin(bright) .. 1=thick(dark)
    let aoVal = 1.0 - thicknessDark * 0.65; // [0.35, 1.0]
    // Fork adjacency penalty: darken crotch junctions
    if (isFork[ni])      aoVal -= 0.18;
    if (isForkChild[ni]) aoVal -= 0.10;
    nodeAO[ni] = Math.max(0.35, Math.min(1.0, aoVal));
  }

  // Compute per-node windWeight [0, 1]: 0 = rigid, 1 = max flex.
  //   - Root nodes are anchors and must never sway.
  //   - All other nodes: thinness = (maxR - r) / (maxR - minR), clamped [0,1].
  //     thinness ≈ 0 for the thick trunk, ≈ 1 for the finest twigs.
  //   - Sharpened with pow(thinness, 1.5) to keep the trunk firmly rigid while
  //     ramping sway up quickly in the thinner branches.
  const nodeWindWeight = new Float32Array(nodes.length);
  const rRange = maxRadius - minRadius_nodes;
  for (let ni = 0; ni < nodes.length; ni++) {
    if (nodes[ni].isRoot) {
      nodeWindWeight[ni] = 0;
      continue;
    }
    const r = nodes[ni].radius || 0;
    const thinness = rRange > 1e-8 ? Math.max(0, Math.min(1, (maxRadius - r) / rRange)) : 0;
    nodeWindWeight[ni] = Math.pow(thinness, 1.5);
  }

  // -------------------------------------------------------------------------
  // Assign wind-bone index per chain and build supporting tables.
  //
  // One bone per chain. Chains were emitted in node-index (ascending) order
  // (chainStarts collected ascending above). Because a chain's start node always
  // has a higher index than its fork-parent's start node, a chain's parent bone
  // always has a lower bone index → parent[c] < c guaranteed.
  //
  // nodeToBone maps each graph node to its "owning" bone (the chain that
  // contains the node as a non-prepended member). Fork nodes appear at the
  // START of child chains as a prepended bridging ring — they belong to their
  // OWN (parent) chain, not to the child chains. Tie-break rule: first-claim
  // wins. The true chain for a fork node processes it at chain[0] with no
  // prepend (parentOfChainStart[chain[0]] === -1), so it gets assigned first.
  // -------------------------------------------------------------------------

  const boneCount = chains.length;

  // Build nodeToBone: -1 = not rendered.
  const nodeToBone = new Int32Array(nodes.length).fill(-1);
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    for (let ni = 0; ni < chain.length; ni++) {
      const nodeIdx = chain[ni];
      // First-claim wins. The prepended fork node (chain[0] when
      // parentOfChainStart[chain[0]] >= 0) is already assigned by its own chain
      // (processed first, lower chain start index).
      if (nodeToBone[nodeIdx] === -1) {
        nodeToBone[nodeIdx] = ci;
      }
    }
  }

  // Build bones_wind tables.
  const bw_parent      = new Int32Array(boneCount).fill(-1);
  const bw_pivot       = new Float32Array(boneCount * 3);
  const bw_axisHint    = new Float32Array(boneCount * 3);
  const bw_stiffness   = new Float32Array(boneCount);
  const bw_branchLevel = new Int32Array(boneCount);
  const bw_isRigid     = new Uint8Array(boneCount);

  // nodeToBone is complete; use it to find parent bone for each chain.
  //
  // A chain is prepended with a fork-parent node when parentOfChainStart[realStart] >= 0.
  // The "real start" of the chain is the node that came from chainStarts — it is chain[1]
  // when there's a prepend, chain[0] otherwise.
  // Detection: chain[0] was prepended iff chain.length >= 2 AND
  //   parentOfChainStart[chain[1]] === chain[0] (chain[0] is the fork parent of chain[1]).
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    // Determine whether this chain has a prepended fork-parent bridging copy.
    const hasPrepend = chain.length >= 2 && parentOfChainStart[chain[1]] === chain[0];
    // Real chain start index within the chain array.
    const realStartIdx = hasPrepend ? 1 : 0;
    // The fork-parent node index (the node prepended as bridging copy), if any.
    const forkParentNodeIdx = hasPrepend ? chain[0] : -1;
    // Pivot: the FIRST node of the chain (= the fork-attachment node when this
    // chain was prepended with its fork parent, otherwise the chain's own start).
    // The bone must rotate about the attachment point so that point stays fixed
    // (it only moves with the parent, via composition) and the branch hinges from
    // it. Using the real start (chain[1]) instead left the bridging fork ring
    // BELOW the pivot, so it swung away from the trunk — the "branch root moves"
    // artifact. chain[0] keeps the attachment pinned to the parent.
    const pivotNodeIdx = chain[0];
    const pivotNode = nodes[pivotNodeIdx];
    const firstRealNode = nodes[chain[realStartIdx]];
    const branchLevelVal = firstRealNode.branchLevel || 0;

    // Pivot position.
    bw_pivot[ci*3]   = pivotNode.pos[0];
    bw_pivot[ci*3+1] = pivotNode.pos[1];
    bw_pivot[ci*3+2] = pivotNode.pos[2];

    // Axis hint: unit tangent from pivot toward next node.
    if (chain.length > realStartIdx + 1) {
      const p0 = nodes[chain[realStartIdx]].pos;
      const p1 = nodes[chain[realStartIdx + 1]].pos;
      const ax = v3norm(v3sub(p1, p0));
      bw_axisHint[ci*3]   = ax[0];
      bw_axisHint[ci*3+1] = ax[1];
      bw_axisHint[ci*3+2] = ax[2];
    } else {
      // Single-node real chain: default tangent up.
      bw_axisHint[ci*3]   = 0;
      bw_axisHint[ci*3+1] = 1;
      bw_axisHint[ci*3+2] = 0;
    }

    bw_branchLevel[ci] = branchLevelVal;

    // isRigid: the TRUNK base chain (ci===0) and root-flare chains (real start
    // node has isRoot===true) are rigid anchors that must NOT sway. The trunk
    // chain pivots at the world origin, so any rotation there would swing the
    // ENTIRE tree about the base (displacement ∝ distance from origin) and,
    // composed down the hierarchy, blow every descendant outward — the
    // exploding-spikes artifact. Pinning chain 0 keeps the base fixed; upper
    // trunk-continuation and branch chains still sway about their own pivots.
    const isRigid = (ci === 0 || firstRealNode.isRoot) ? 1 : 0;
    bw_isRigid[ci] = isRigid;

    // Stiffness: same thinness curve as windWeight. Rigid → 0; otherwise mean
    // per-node windWeight across the real nodes of this chain.
    if (isRigid) {
      bw_stiffness[ci] = 0;
    } else {
      let thinSum = 0;
      let thinCount = 0;
      for (let ni = realStartIdx; ni < chain.length; ni++) {
        thinSum += nodeWindWeight[chain[ni]];
        thinCount++;
      }
      bw_stiffness[ci] = thinCount > 0 ? thinSum / thinCount : 0;
    }

    // Parent bone: the chain that owns the fork-parent bridging node.
    // For prepended chains, the fork parent node (chain[0]) owns this chain's parent.
    if (forkParentNodeIdx >= 0) {
      const parentBone = nodeToBone[forkParentNodeIdx];
      // Guard against a self/forward parent. The fork-parent node can be owned by
      // THIS same chain: once the root system makes the origin (node 0) a fork,
      // the trunk chain prepends node 0 AND claims it (first-claim), so its
      // fork-parent resolves to its own bone → parent===ci. The solver also
      // requires parent < child for top-down composition. Fall back to -1
      // (hierarchy root) when the parent bone isn't a strictly-earlier bone.
      bw_parent[ci] = (parentBone >= 0 && parentBone < ci) ? parentBone : -1;
    }
    // else stays -1 (root chain — no prepend means no fork parent)
  }

  // Bounds tracking.
  let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
  let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;

  let vCursor = 0; // next vertex slot
  let iCursor = 0; // next index slot (in triangle triplets, i.e. iCursor*3)

  // -------------------------------------------------------------------------
  // Helpers to write a single vertex.
  // boneIdx: which wind-bone (chain index) this vertex belongs to.
  // boneFrac: normalized arc position along the chain [0=pivot, 1=chain end].
  // -------------------------------------------------------------------------
  function writeVertex(px, py, pz, nx, ny, nz, u, v, aoVal, windWeightVal, boneIdx, boneFrac, radiusVal,
                       tx, ty, tz, fux, fuy, fuz) {
    const vi = vCursor;
    positions[vi*3]   = px;
    positions[vi*3+1] = py;
    positions[vi*3+2] = pz;
    normals[vi*3]   = nx;
    normals[vi*3+1] = ny;
    normals[vi*3+2] = nz;
    uvs[vi*2]   = u;
    uvs[vi*2+1] = v;
    ao[vi]         = aoVal;
    windWeight[vi] = windWeightVal;
    boneIndexAttr[vi]    = boneIdx;
    boneFractionAttr[vi] = boneFrac;
    radii[vi]      = radiusVal || 0;
    // Branch frame (T = axis, u = cross-section basis). Default to world-Y up / X if absent.
    tangents[vi*3]   = (tx !== undefined) ? tx : 0;
    tangents[vi*3+1] = (tx !== undefined) ? ty : 1;
    tangents[vi*3+2] = (tx !== undefined) ? tz : 0;
    frameUs[vi*3]    = (fux !== undefined) ? fux : 1;
    frameUs[vi*3+1]  = (fux !== undefined) ? fuy : 0;
    frameUs[vi*3+2]  = (fux !== undefined) ? fuz : 0;
    // Expand bounds
    if (px < bMinX) bMinX = px; if (px > bMaxX) bMaxX = px;
    if (py < bMinY) bMinY = py; if (py > bMaxY) bMaxY = py;
    if (pz < bMinZ) bMinZ = pz; if (pz > bMaxZ) bMaxZ = pz;
    vCursor++;
    return vi;
  }

  // Emit a ring of segs vertices at node position pos with radius r and frame {u,v,tangent}.
  // arcLen: accumulated arc length from chain start (for UV.v).
  // aoVal: per-vertex ambient occlusion for all vertices in this ring.
  // windWeightVal: per-vertex wind sway weight [0,1] for all vertices in this ring.
  // boneIdx: wind-bone index (chain index) for all vertices in this ring.
  // boneFrac: normalized arc position along the chain [0=pivot, 1=chain end].
  // Returns the index of the first vertex of this ring.
  function emitRing(pos, r, u, v, segs, arcLen, aoVal, windWeightVal, boneIdx, boneFrac) {
    const firstVert = vCursor;
    const TWO_PI = 2 * Math.PI;
    // Branch axial tangent for this ring: T = u × v (frame is orthonormal). Constant for all
    // vertices in the ring; baked per-vertex so the bark shader can align its pattern to it.
    const tgx = u[1]*v[2] - u[2]*v[1];
    const tgy = u[2]*v[0] - u[0]*v[2];
    const tgz = u[0]*v[1] - u[1]*v[0];
    for (let j = 0; j < segs; j++) {
      const theta = (j / segs) * TWO_PI;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);

      // Compute cross-section modulation (identity at ribbing=0, flatness=0).
      const { rScale, uScale, nU, nV } = ringProfile(theta, { ribbing, flatness, ribCount });

      // Position: pos + r * rScale * (cosθ·u·uScale + sinθ·v)
      const px = pos[0] + r * rScale * (ct * u[0] * uScale + st * v[0]);
      const py = pos[1] + r * rScale * (ct * u[1] * uScale + st * v[1]);
      const pz = pos[2] + r * rScale * (ct * u[2] * uScale + st * v[2]);

      // Analytic outward normal in 3D: nU * u + nV * v, then normalize.
      let nx = nU * u[0] + nV * v[0];
      let ny = nU * u[1] + nV * v[1];
      let nz = nU * u[2] + nV * v[2];
      const nLen = Math.sqrt(nx*nx + ny*ny + nz*nz);
      if (nLen > 1e-12) {
        nx /= nLen; ny /= nLen; nz /= nLen;
      } else {
        // Degenerate fallback: use radial direction.
        nx = ct*u[0] + st*v[0];
        ny = ct*u[1] + st*v[1];
        nz = ct*u[2] + st*v[2];
      }

      const uCoord = j / segs;
      writeVertex(px, py, pz, nx, ny, nz, uCoord, arcLen, aoVal, windWeightVal, boneIdx, boneFrac, r,
                  tgx, tgy, tgz, u[0], u[1], u[2]);
    }
    return firstVert;
  }

  // Emit a quad strip between two consecutive rings.
  // ringA: index of first vertex of the "lower" ring (closer to root)
  // ringB: index of first vertex of the "upper" ring
  // segs: number of radial segments
  function emitQuadStrip(ringA, ringB, segs) {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      // Two triangles per quad, wound CCW as seen from OUTSIDE the tube so the
      // front face (THREE.FrontSide) faces outward and matches the outward radial
      // vertex normals. With the frame v = T×u, the order A[j],A[j1],B[j] gives an
      // outward-pointing geometric normal; the reverse (A[j],B[j],A[j1]) points
      // inward and culls the visible outer surface (hollow-shell artifact).
      //   A[j], A[j1], B[j]
      //   B[j], A[j1], B[j1]
      const base = iCursor * 3;
      indices[base]   = ringA + j;
      indices[base+1] = ringA + j1;
      indices[base+2] = ringB + j;
      iCursor++;
      indices[base+3] = ringB + j;
      indices[base+4] = ringA + j1;
      indices[base+5] = ringB + j1;
      iCursor++;
    }
  }

  // Emit a fan from a single apex vertex to a ring.
  // apexVert: vertex index of apex
  // ringBase: first vertex index of the ring
  // segs: ring vertex count
  function emitApexFan(apexVert, ringBase, segs) {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      const base = iCursor * 3;
      // Wind so apex points outward: ring[j], ring[j1], apex
      indices[base]   = ringBase + j;
      indices[base+1] = ringBase + j1;
      indices[base+2] = apexVert;
      iCursor++;
    }
  }

  // -------------------------------------------------------------------------
  // Second pass: emit geometry for each chain.
  //
  // Per-chain bone data:
  //   boneIdx = chain index in chains[] (sequential, 0..boneCount-1).
  //   boneFraction = normalized arc distance from the chain's PIVOT node to
  //     the current ring node, divided by the total arc from pivot to chain end.
  //     0 at the pivot (chain-start, possibly after prepended fork copy), 1 at
  //     the tip/fork-end. The prepended fork copy node (chain[0] when a fork
  //     parent is prepended) gets boneFraction=0 since it is the "root" of the
  //     bridging ring; the REAL pivot is chain[1], so we measure from chain[1].
  //     Actually, the plan specifies pivot = chain-start world pos (real pivot),
  //     so boneFraction = 0 at the pivot node (chain[1] if prepended, chain[0]
  //     if not) and 1 at chain end. The prepended fork copy ring (ni=0 when
  //     forkParentIdx>=0) gets boneFraction=0 too (it IS the pivot or just
  //     before it), keeping it pinned (zero displacement = stays at pivot).
  //
  // Pre-compute per-chain total arc length (from pivot node to end) for normalization.
  // -------------------------------------------------------------------------

  // Pre-compute per-chain arc segments (node[ni] → node[ni+1] distance) for normalization.
  // arcFromPivot[chainIdx][ni] = cumulative arc from pivot node to chain node ni.
  // We store only a flat array indexed by (chainIdx → computed on the fly during emission).
  // Instead, compute total arc length for each chain once here.
  const chainTotalArcFromPivot = new Float32Array(chains.length);
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const N = chain.length;
    // Same prepend detection as in bone table building.
    const hasPrepend = N >= 2 && parentOfChainStart[chain[1]] === chain[0];
    // Pivot is chain[1] if prepended, else chain[0].
    // We sum arc from pivot to end (including tip arc if tip chain).
    const pivotNi = hasPrepend ? 1 : 0;
    let arc = 0;
    for (let ni = pivotNi + 1; ni < N; ni++) {
      arc += v3len(v3sub(nodes[chain[ni]].pos, nodes[chain[ni-1]].pos));
    }
    chainTotalArcFromPivot[ci] = arc > 1e-12 ? arc : 1; // avoid div-by-zero
  }

  // Per-node frame storage so a child chain can INHERIT its parent's parallel-transport frame
  // across a fork (continuous bark around-coordinate → no furrow seam at branch junctions).
  // Filled as each chain emits its rings; chains are processed parent-before-child (bone order),
  // so a child's fork node already has the parent's frame stored when the child starts.
  const nodeFrameU   = new Float32Array(nodes.length * 3);
  const nodeFrameT   = new Float32Array(nodes.length * 3);
  const nodeFrameSet = new Uint8Array(nodes.length);
  // Global arc length from the root (continuous ACROSS forks), inherited at a chain's start node
  // like the frame, so UV.v doesn't reset at junctions → no bark texture seam at forks.
  const nodeArc      = new Float32Array(nodes.length);
  const nodeArcSet   = new Uint8Array(nodes.length);

  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const N = chain.length;
    const firstNode = nodes[chain[0]];
    const level = firstNode.branchLevel || 0;
    const segs = radialSegsFor(level);
    const isTip = filteredChildrenOf[chain[N-1]].length === 0;
    // Detect prepend using the same rule as the bone table building above.
    // chain[0] was prepended iff chain.length >= 2 AND parentOfChainStart[chain[1]] === chain[0].
    const hasPrepend = N >= 2 && parentOfChainStart[chain[1]] === chain[0];
    // Pivot node index within the chain array (0 if no prepend, 1 if prepend).
    const pivotNi = hasPrepend ? 1 : 0;
    const totalArc = chainTotalArcFromPivot[ci];

    // Compute tangent at chain start for the initial frame.
    // Use chain[0]→chain[1] direction if we have at least 2 nodes.
    let tangent;
    if (N >= 2) {
      const p0 = nodes[chain[0]].pos;
      const p1 = nodes[chain[1]].pos;
      tangent = v3norm(v3sub(p1, p0));
    } else {
      // Single node chain: use Y up as tangent
      tangent = [0, 1, 0];
    }

    // Initialize the frame. If the chain's start node already carries a frame (its parent
    // chain emitted it at the fork), INHERIT it — transport the parent's frame from its tangent
    // at the fork to this chain's start tangent — so the bark around-coordinate flows across the
    // junction instead of jumping (the fork-seam fix). Otherwise (root chain) fall back to perpTo.
    let frameU, frameV;
    const startNode = chain[0];
    if (nodeFrameSet[startNode]) {
      const pU = [nodeFrameU[startNode*3], nodeFrameU[startNode*3+1], nodeFrameU[startNode*3+2]];
      const pT = [nodeFrameT[startNode*3], nodeFrameT[startNode*3+1], nodeFrameT[startNode*3+2]];
      const pV = v3norm(v3cross(pT, pU));
      const tr = transportFrame(pT, tangent, pU, pV);
      frameU = v3norm(tr[0]);
      frameV = v3norm(v3cross(tangent, frameU));
    } else {
      frameU = perpTo(tangent);
      frameV = v3norm(v3cross(tangent, frameU));
    }

    // Global arc from root for this chain's start (inherited from the parent fork node like the
    // frame), so UV.v is continuous across forks → no bark texture seam at junctions.
    const globalArcStart = nodeArcSet[startNode] ? nodeArc[startNode] : 0;

    // Single-node chain: minimal geometry.
    if (N === 1) {
      const node = nodes[chain[0]];
      const r = Math.max(node.radius, minRadius);
      const singleNodeAO = nodeAO[chain[0]];
      const singleNodeWW = nodeWindWeight[chain[0]];
      // Record frame so anything forking from this node inherits it — but don't overwrite a
      // frame the parent already set (preserve a shared fork node's parent frame for siblings).
      if (nodeFrameSet[chain[0]] === 0) {
        nodeFrameU[chain[0]*3] = frameU[0]; nodeFrameU[chain[0]*3+1] = frameU[1]; nodeFrameU[chain[0]*3+2] = frameU[2];
        nodeFrameT[chain[0]*3] = tangent[0]; nodeFrameT[chain[0]*3+1] = tangent[1]; nodeFrameT[chain[0]*3+2] = tangent[2];
        nodeFrameSet[chain[0]] = 1;
      }
      if (nodeArcSet[chain[0]] === 0) { nodeArc[chain[0]] = globalArcStart; nodeArcSet[chain[0]] = 1; }
      if (isTip) {
        // Apex only; boneFraction=0 (single node, at pivot). UV.v = global arc start.
        writeVertex(node.pos[0], node.pos[1], node.pos[2],
                    0, 1, 0, 0, globalArcStart, singleNodeAO, singleNodeWW, ci, 0, r,
                    tangent[0], tangent[1], tangent[2], frameU[0], frameU[1], frameU[2]);
      } else {
        // One ring, no triangles; boneFraction=0. UV.v = global arc start.
        emitRing(node.pos, r, frameU, frameV, segs, globalArcStart, singleNodeAO, singleNodeWW, ci, 0);
      }
      continue;
    }

    // Multi-node chain: emit rings along the chain.
    let arcLen = 0;         // arc from chain[0] along chain (UV.v)
    let arcFromPivot = 0;   // arc from pivot node (chain[pivotNi]) — for boneFraction
    const ringIndices = []; // first vertex index of each emitted ring
    let prevTangent = tangent;
    let [curU, curV] = [frameU, frameV];

    // Determine how many nodes get full rings (all except the last if tip).
    const ringCount = isTip ? N - 1 : N;

    for (let ni = 0; ni < ringCount; ni++) {
      const nodeIdx = chain[ni];
      const node = nodes[nodeIdx];
      const r = Math.max(node.radius, minRadius);

      // Update frame via parallel transport (skip on first node — frame already set).
      if (ni > 0) {
        // Tangent for this node: direction to next node (if exists), or from prev to this.
        const prevPos = nodes[chain[ni-1]].pos;
        const curPos = node.pos;
        let newTangent;
        if (ni < N - 1) {
          const nextPos = nodes[chain[ni+1]].pos;
          // Average of incoming and outgoing directions for smoother frames.
          const incoming = v3norm(v3sub(curPos, prevPos));
          const outgoing = v3norm(v3sub(nextPos, curPos));
          newTangent = v3norm([
            incoming[0]+outgoing[0],
            incoming[1]+outgoing[1],
            incoming[2]+outgoing[2],
          ]);
          // If averaging collapses (anti-parallel), fall back to incoming.
          if (v3len(newTangent) < 0.5) newTangent = incoming;
          newTangent = v3norm(newTangent);
        } else {
          // Last ring node: use direction from prev to here.
          newTangent = v3norm(v3sub(curPos, prevPos));
        }

        // Transport frame.
        [curU, curV] = transportFrame(prevTangent, newTangent, curU, curV);
        prevTangent = newTangent;

        const segLen = v3len(v3sub(curPos, prevPos));
        // Accumulate arc length (for UV.v — unchanged from before).
        arcLen += segLen;
        // Accumulate arc from pivot (for boneFraction — only count from pivotNi onward).
        if (ni >= pivotNi) arcFromPivot += segLen;
      }

      // boneFraction: 0 at pivot node, 1 at chain end.
      // Nodes before the pivot (i.e., the prepended fork copy, ni=0 when hasPrepend)
      // get boneFraction=0 (pinned at pivot, no additional displacement).
      const boneFrac = ni < pivotNi ? 0 : Math.min(1, arcFromPivot / totalArc);

      const ringStart = emitRing(node.pos, r, curU, curV, segs, globalArcStart + arcLen, nodeAO[nodeIdx], nodeWindWeight[nodeIdx], ci, boneFrac);
      ringIndices.push(ringStart);
      // Record this node's GLOBAL arc so child chains forking here inherit a continuous UV.v
      // (same overwrite guard as the frame: don't clobber a fork node the parent already set).
      if (ni > 0 || nodeArcSet[nodeIdx] === 0) { nodeArc[nodeIdx] = globalArcStart + arcLen; nodeArcSet[nodeIdx] = 1; }
      // Record this node's frame so child chains forking here inherit it. Do NOT overwrite a
      // fork node already set by the PARENT (the shared ni===0 node): otherwise the 2nd+ sibling
      // child would inherit the 1st child's frame (an extra rotation) and that branch's bark
      // would come out twisted relative to the trunk. ni>0 nodes belong to this chain alone, so
      // always store those (a grandchild forking there should inherit THIS chain's frame).
      if (ni > 0 || nodeFrameSet[nodeIdx] === 0) {
        nodeFrameU[nodeIdx*3] = curU[0]; nodeFrameU[nodeIdx*3+1] = curU[1]; nodeFrameU[nodeIdx*3+2] = curU[2];
        nodeFrameT[nodeIdx*3] = prevTangent[0]; nodeFrameT[nodeIdx*3+1] = prevTangent[1]; nodeFrameT[nodeIdx*3+2] = prevTangent[2];
        nodeFrameSet[nodeIdx] = 1;
      }
    }

    // Emit quad strips between consecutive rings.
    for (let ri = 0; ri < ringIndices.length - 1; ri++) {
      emitQuadStrip(ringIndices[ri], ringIndices[ri+1], segs);
    }

    if (isTip) {
      // Tip: collapse last node to apex vertex.
      const tipNode = nodes[chain[N-1]];
      const prevPos = nodes[chain[N-2]].pos;
      const tipArcLen = arcLen + v3len(v3sub(tipNode.pos, prevPos));
      const tipArcFromPivot = arcFromPivot + v3len(v3sub(tipNode.pos, prevPos));
      const tipBoneFrac = Math.min(1, tipArcFromPivot / totalArc);

      // Apex normal: average outward from last ring, or just use tangent.
      // Use the chain tangent (pointing outward from the tip) as a reasonable apex normal.
      const apexNormal = prevTangent;
      const apexVert = writeVertex(
        tipNode.pos[0], tipNode.pos[1], tipNode.pos[2],
        apexNormal[0], apexNormal[1], apexNormal[2],
        0.5, globalArcStart + tipArcLen, nodeAO[chain[N-1]], nodeWindWeight[chain[N-1]], ci, tipBoneFrac,
        Math.max(tipNode.radius || 0, minRadius),
        prevTangent[0], prevTangent[1], prevTangent[2], curU[0], curU[1], curU[2]
      );

      // Fan from last ring to apex.
      emitApexFan(apexVert, ringIndices[ringIndices.length - 1], segs);
    }
  }

  // -------------------------------------------------------------------------
  // Build bounds.
  // -------------------------------------------------------------------------
  let bounds;
  if (vCursor === 0) {
    bounds = { min: [0,0,0], max: [0,0,0] };
  } else {
    bounds = {
      min: [bMinX, bMinY, bMinZ],
      max: [bMaxX, bMaxY, bMaxZ],
    };
  }

  const bones_wind = {
    count:       boneCount,
    parent:      bw_parent.subarray(0, boneCount),
    pivot:       bw_pivot.subarray(0, boneCount * 3),
    axisHint:    bw_axisHint.subarray(0, boneCount * 3),
    stiffness:   bw_stiffness.subarray(0, boneCount),
    branchLevel: bw_branchLevel.subarray(0, boneCount),
    isRigid:     bw_isRigid.subarray(0, boneCount),
  };

  return {
    positions:  positions.subarray(0, vCursor * 3),
    normals:    normals.subarray(0, vCursor * 3),
    uvs:        uvs.subarray(0, vCursor * 2),
    ao:         ao.subarray(0, vCursor),
    windWeight: windWeight.subarray(0, vCursor),
    radii:      radii.subarray(0, vCursor),
    tangents:   tangents.subarray(0, vCursor * 3),
    frameUs:    frameUs.subarray(0, vCursor * 3),
    indices:    indices.subarray(0, iCursor * 3),
    vertexCount:   vCursor,
    triangleCount: iCursor,
    bounds,
    // New: per-vertex bone skin data.
    boneIndex:     boneIndexAttr.subarray(0, vCursor),
    boneFraction:  boneFractionAttr.subarray(0, vCursor),
    // New: wind-bone hierarchy tables.
    bones_wind,
    // New: node-to-bone mapping (needed by foliage/Task 2).
    nodeToBone,
  };
}

// ---------------------------------------------------------------------------
// Empty result helper
// ---------------------------------------------------------------------------
function _emptyResult() {
  return {
    positions:     new Float32Array(0),
    normals:       new Float32Array(0),
    uvs:           new Float32Array(0),
    ao:            new Float32Array(0),
    windWeight:    new Float32Array(0),
    radii:         new Float32Array(0),
    tangents:      new Float32Array(0),
    frameUs:       new Float32Array(0),
    indices:       new Uint32Array(0),
    vertexCount:   0,
    triangleCount: 0,
    bounds: { min: [0,0,0], max: [0,0,0] },
    boneIndex:     new Float32Array(0),
    boneFraction:  new Float32Array(0),
    bones_wind: {
      count:       0,
      parent:      new Int32Array(0),
      pivot:       new Float32Array(0),
      axisHint:    new Float32Array(0),
      stiffness:   new Float32Array(0),
      branchLevel: new Int32Array(0),
      isRigid:     new Uint8Array(0),
    },
    nodeToBone: new Int32Array(0),
  };
}
