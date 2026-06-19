// =============================================================================
// roots.js — Procedural root system generator.
//
// growRootSystem(graph, genome, rootRng, opts) → graph (mutated in place)
//
// Appends root nodes and bones to an existing skeleton graph:
//   - One downward-curving taproot (geotropism toward −Y)
//   - N major laterals (fractional crossfade idiom) that spread outward then
//     dive downward (geotropism)
//   - Recursive sub-branches off laterals (depthFrac crossfade at deepest level)
//   - Above-ground buttress/flare wings at the trunk base
//
// ROOT NODE CONTRACT (§1.2):
//   Every appended node must have:
//     isRoot:     true
//     branchLevel: 0        (keeps foliage branchLevel<1 skip working)
//     rootLevel:   int ≥ 0  (root-internal depth; 0 = taproot/major-lateral primary)
//     parentIdx:   int      (parentIdx < ownIndex — upheld automatically by append-only)
//     weight:      number   (1.0, or crossfade frac for the nth lateral / deepest level)
//     radius:      number   (placeholder; proportions.js owns final values)
//
// Root nodes MUST NOT set isStem, isWoody, isTerminal, or attachPos.
//
// GEOTROPISM (Risk A):
//   Each root chain actively bends TOWARD −Y as it extends (sign INVERTED
//   vs canopy anti-gravity droop). The geometry is baked entirely here.
//   proportions.js keeps `if (n.isRoot) continue;` in the bending pass —
//   no double-application.
//
// DETERMINISM:
//   All randomness comes exclusively from the passed `rootRng` (an isolated
//   sub-stream: mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0)).
//   Never touches Math.random or the main skeleton rng.
//   Deterministic curvature uses sin-hash of structuralSeed + index + level
//   (same idiom as skeleton.js) — no extra rng draws consumed for curvature.
//
// BONE BUDGET:
//   Roots use their own ROOT_BONE_BUDGET, independent of the canopy MAX_BONES.
//   Sub-branches stop spawning once ROOT_BONE_BUDGET root bones have been appended.
//
// No three.js import. Pure ESM. Node-testable.
// =============================================================================

import { deriveTraits } from './allometry.js';

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/** Dedicated root bone budget — independent of canopy MAX_BONES. */
export const ROOT_BONE_BUDGET = 220;

/** Sub-stream salt — distinct from foliage's 0x1EAF1EAF. */
export const ROOT_SALT = 0x900D5EED;

// ---------------------------------------------------------------------------
// Math helpers (copied here to keep roots.js dependency-free,
// matching the per-module-helper convention in skeleton.js / foliage.js)
// ---------------------------------------------------------------------------

function len3(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function norm3(v) {
  const l = len3(v);
  if (l < 1e-10) return [1, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Rodrigues rotation: rotate v around unit axis ax by angle (radians). */
function rotateAround(v, ax, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot3(v, ax);
  const cr = cross3(ax, v);
  return [
    v[0] * c + cr[0] * s + ax[0] * d * (1 - c),
    v[1] * c + cr[1] * s + ax[1] * d * (1 - c),
    v[2] * c + cr[2] * s + ax[2] * d * (1 - c),
  ];
}

/** Return a unit vector perpendicular to dir (arbitrary but stable). */
function perpTo(dir) {
  if (Math.abs(dot3(dir, [1, 0, 0])) < 0.9) {
    return norm3(cross3(dir, [1, 0, 0]));
  }
  return norm3(cross3(dir, [0, 0, 1]));
}

// ---------------------------------------------------------------------------
// Deterministic curvature helpers (no rng draws consumed)
// Mirrors the sin-hash idiom in skeleton.js buildCurvedChain / computeCurvatureArc.
// ---------------------------------------------------------------------------

/** Deterministic arc angle for a root segment (in radians). */
function rootCurvatureArc(structuralSeed, lateralIndex, level) {
  const h = Math.sin(structuralSeed * 5.1234 + lateralIndex * 1.8765 + level * 2.4567);
  return h * 0.18; // gentle structural character, ±0.18 rad per segment
}

/** Deterministic axis (perpendicular to dir) for the curvature arc. */
function rootCurvatureAxis(dir, structuralSeed, lateralIndex, level) {
  const h = Math.sin(structuralSeed * 8.6543 + lateralIndex * 3.1415 + level * 1.4142);
  const base = perpTo(dir);
  const planeAngle = h * Math.PI;
  return norm3(rotateAround(base, dir, planeAngle));
}

// ---------------------------------------------------------------------------
// buildRootChain
//
// Places `numSegments` nodes along a root chain, applying geotropism
// (bending progressively toward −Y) plus deterministic curvature.
//
// startPos:      [x,y,z] first node position
// initialDir:    [x,y,z] unit initial direction
// segLen:        length of each segment
// numSegments:   number of nodes to emit (= number of bones in this chain)
// geoStrength:   radians/segment toward −Y (positive = geotropism pull toward down)
// structuralSeed: for deterministic curvature
// lateralIndex:  which lateral/taproot this is (for unique curvature character)
// rootLevel:     root-internal depth (for curvature hash)
// weight:        crossfade weight (scales segLen)
// parentIdx0:    index of the parent of the first node in this chain
// nodes:         the shared nodes array (mutated in place)
// bones:         the shared bones array (mutated in place)
//
// Returns: { tipIdx, tipPos, tipDir }
//   tipIdx: index of the last node placed
//   tipPos: position of the last node placed
//   tipDir: direction at the tip (for spawning sub-branches)
// ---------------------------------------------------------------------------
function buildRootChain(
  startPos, initialDir, segLen, numSegments,
  geoStrength, structuralSeed, lateralIndex, rootLevel,
  weight, parentIdx0, nodes, bones
) {
  let pos = startPos;
  let dir = norm3(initialDir);
  const WORLD_DOWN = [0, -1, 0];

  // Deterministic arc for this chain (no rng draw)
  const arcAngle = rootCurvatureArc(structuralSeed, lateralIndex, rootLevel);
  const arcAxis  = rootCurvatureAxis(dir, structuralSeed, lateralIndex, rootLevel);
  const arcPerSeg = numSegments > 1 ? arcAngle / numSegments : 0;

  let parentIdx = parentIdx0;
  let tipIdx = parentIdx0;

  for (let j = 0; j < numSegments; j++) {
    // Structural arc (deterministic character — no rng)
    if (Math.abs(arcPerSeg) > 1e-6) {
      dir = norm3(rotateAround(dir, arcAxis, arcPerSeg));
    }

    // Geotropism: bend toward −Y (inverted vs canopy anti-gravity droop).
    // We rotate dir around a horizontal axis that is perpendicular to both
    // dir and WORLD_DOWN — this pulls the direction downward progressively.
    if (geoStrength > 1e-6) {
      // Axis is the cross product of dir and WORLD_DOWN (or a horizontal fallback
      // when dir is already nearly vertical).
      const geoAx = cross3(dir, WORLD_DOWN);
      const geoAxLen = len3(geoAx);
      if (geoAxLen > 1e-6) {
        const geoAxUnit = [geoAx[0] / geoAxLen, geoAx[1] / geoAxLen, geoAx[2] / geoAxLen];
        dir = norm3(rotateAround(dir, geoAxUnit, geoStrength));
      }
      // If dir is already [0,-1,0] no rotation needed (already fully down).
    }

    // Advance position (scaled by weight so crossfade chains grow from zero)
    const effectiveLen = segLen * weight;
    pos = [
      pos[0] + dir[0] * effectiveLen,
      pos[1] + dir[1] * effectiveLen,
      pos[2] + dir[2] * effectiveLen,
    ];

    const idx = nodes.length;
    nodes.push({
      pos: [...pos],
      radius: 0.04,   // placeholder — proportions.js overwrites
      weight,
      isRoot: true,
      branchLevel: 0,
      rootLevel,
      parentIdx,
    });
    bones.push({ a: parentIdx, b: idx });

    parentIdx = idx;
    tipIdx = idx;
  }

  return { tipIdx, tipPos: [...pos], tipDir: [...dir] };
}

// ---------------------------------------------------------------------------
// growRootSystem — public API
// ---------------------------------------------------------------------------

/**
 * Append a full root system to an existing skeleton graph IN PLACE.
 *
 * @param {object} graph      — { nodes, bones, meta } after buildSkeleton has run.
 * @param {object} genome     — flora genome; reads root* genes + structuralSeed.
 * @param {function} rootRng  — mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0)
 * @param {object} [opts]     — optional overrides
 * @param {object} [opts.env] — optional environment envelope (aridity/wind for bias)
 * @param {number} [opts.maxRootBones] — hard cap on appended root bones (default ROOT_BONE_BUDGET)
 * @returns {object} graph    — same object (mutated)
 */
export function growRootSystem(graph, genome, rootRng, opts = {}) {
  const { nodes, bones } = graph;

  // -------------------------------------------------------------------------
  // Woodiness gate: herbaceous plants (grass/fern/kelp) have no woody root
  // system. At woodiness >= 1 the FULL existing code path runs byte-identical.
  // Below WOODINESS_ROOT_THRESHOLD (0.25) we return immediately with no root
  // nodes appended — the rootRng sub-stream is isolated from the canopy rng so
  // skipping draws here never affects canopy or foliage determinism.
  // -------------------------------------------------------------------------
  const woodiness = genome.woodiness !== undefined ? genome.woodiness : 1.0;

  // Root EXTENT ramps in continuously with woodiness instead of the old hard binary
  // cliff at 0.25 (no roots ↔ full roots, with nothing between). woodinessRootScale
  // smoothsteps 0→1 across [0.12, 0.30]: a herbaceous plant (woodiness < ~0.12, e.g.
  // fern/kelp holdfasts) is still effectively rootless, a semi-woody one (cactus ~0.15)
  // grows a small root system that scales up, and a fully woody one (>=0.30, all trees)
  // is identity (×1.0). It multiplies rootScale below, so it scales the whole system's
  // EXTENTS (not node counts), giving a smooth grow-in.
  const _wt = Math.max(0, Math.min(1, (woodiness - 0.12) / (0.30 - 0.12)));
  const woodinessRootScale = _wt * _wt * (3 - 2 * _wt);   // smoothstep

  // Below the ramp, roots would be ~zero size — skip building them (no visible cliff,
  // since they've already faded to nothing by this point).
  if (woodinessRootScale <= 0) {
    return graph;
  }

  // -------------------------------------------------------------------------
  // Root genome genes with safe defaults (genome.js Task 1 adds these;
  // guard with defaults so roots.js works before Task 1 lands).
  // -------------------------------------------------------------------------
  const rootCount      = genome.rootCount      !== undefined ? genome.rootCount      : 0.45;
  const rootDepth      = genome.rootDepth      !== undefined ? genome.rootDepth      : 0.45;
  const rootSpread     = genome.rootSpread     !== undefined ? genome.rootSpread     : 0.50;
  const rootFlare      = genome.rootFlare      !== undefined ? genome.rootFlare      : 0.30;
  const rootButtress   = genome.rootButtress   !== undefined ? genome.rootButtress   : 0.15;
  const rootBranchiness = genome.rootBranchiness !== undefined ? genome.rootBranchiness : 0.45;
  const rootTaper      = genome.rootTaper      !== undefined ? genome.rootTaper      : 0.50;
  const structuralSeed = genome.structuralSeed !== undefined ? genome.structuralSeed : 0.0;

  // Optional env bias
  const env = opts.env || null;
  let aridBias = 0;
  let windBias = 0;
  if (env) {
    aridBias = env.aridity !== undefined ? Math.max(0, Math.min(1, env.aridity)) : 0;
    const CALM_WIND = 0.2;
    windBias = env.wind !== undefined ? Math.max(0, env.wind - CALM_WIND) : 0;
  }

  const maxRootBones = opts.maxRootBones !== undefined ? opts.maxRootBones : ROOT_BONE_BUDGET;

  // ALLOMETRY: a bigger canopy needs a proportionally bigger anchor. rootScale ∝
  // sizeFactor scales the root EXTENTS (taproot depth, lateral reach, buttress flare)
  // with overall stature, so the root plate tracks the tree it supports instead of
  // being a fixed footprint. Identity (×1.0) at default stature (trunkHeight=0.5), so
  // default-height plants' roots are byte-identical. Segment COUNTS are unchanged
  // (still gene-driven), so only positions scale — never the root bone count.
  // rootScale = allometric stature scaling × continuous woodiness ramp (replaces the
  // old binary woodiness<0.25 gate). At woodiness>=0.30 the ramp is 1.0 (identity).
  const { rootScale: _allometricRootScale } = deriveTraits(genome);
  const rootScale = _allometricRootScale * woodinessRootScale;

  // Counter for root bones appended in this call (separate from canopy budget)
  let rootBonesAdded = 0;

  // -------------------------------------------------------------------------
  // Geometry parameters derived from genes
  // -------------------------------------------------------------------------

  // Taproot: depth (world-units) and segment count. Depth scales with stature (rootScale).
  const taprootDepth    = (0.8 + rootDepth * 1.2 + aridBias * 0.6) * rootScale;    // 0.8..2.6 × size
  const taprootSegs     = Math.max(3, Math.round(4 + rootDepth * 4));   // 4..8 segments
  const taprootSegLen   = taprootDepth / taprootSegs;

  // Laterals: count crossfade
  const fractLaterals = 2 + rootCount * 4;                // 2.0..6.0
  const fullLaterals  = Math.floor(fractLaterals);        // 2..6 full
  const lateralFrac   = fractLaterals - fullLaterals;     // 0.0..1.0 crossfade weight

  // Lateral geometry. Radial reach scales with stature (rootScale).
  const spreadRadius   = (0.5 + rootSpread * 0.8 + windBias * 0.3) * rootScale;     // radial reach before diving
  const lateralSegs    = Math.max(3, Math.round(3 + rootSpread * 3));  // 3..6 segs outward
  const lateralSegLen  = spreadRadius / lateralSegs;

  // Sub-branch depth crossfade (depthFrac idiom from skeleton.js)
  const fractSubDepth  = rootBranchiness * 3;              // 0..3
  const maxSubDepth    = Math.floor(fractSubDepth);        // 0..3
  const subDepthFrac   = fractSubDepth - maxSubDepth;      // crossfade at deepest level

  // Geotropism strength per segment
  const taprootGeo    = 0.12;                              // taproot is already going down
  const lateralGeo    = 0.06 + rootDepth * 0.08;          // laterals gradually bend down

  // Buttress parameters — fractional-crossfade idiom (same as rootCount): the marginal
  // wing grows in from zero LENGTH as rootButtress rises, instead of the old hard jump
  // to 2 wings at 0.05 then integer 2→3→4 stepping. rootButtress=0 → no wings (clean).
  const fractButtress  = rootButtress * 6;                 // 0..6 wings
  const fullButtress   = Math.floor(fractButtress);
  const buttressFrac   = fractButtress - fullButtress;     // crossfade weight for the +1 wing
  const buttressCount  = fullButtress + (buttressFrac > 0 ? 1 : 0);
  const buttressLen    = (0.10 + rootFlare * 0.35) * rootScale;          // above-ground flare length × size
  const buttressSegs   = 2;                                // short 2-segment wings

  // -------------------------------------------------------------------------
  // Origin: first trunk base node (always index 0 by skeleton.js convention)
  // -------------------------------------------------------------------------
  const firstTrunkBaseIdx = 0;
  const origin = nodes[firstTrunkBaseIdx].pos;

  // -------------------------------------------------------------------------
  // 1. TAPROOT
  //
  // Grows straight down from origin with a gentle deterministic arc and
  // progressive geotropism.
  // -------------------------------------------------------------------------
  const taprootDir = [0, -1, 0]; // initial direction: straight down

  const taproot = buildRootChain(
    origin,
    taprootDir,
    taprootSegLen,
    taprootSegs,
    taprootGeo,
    structuralSeed,
    -1,          // lateralIndex = -1 for taproot (distinct hash from laterals)
    0,           // rootLevel 0
    1.0,         // full weight
    firstTrunkBaseIdx,
    nodes,
    bones
  );
  rootBonesAdded += taprootSegs;

  // -------------------------------------------------------------------------
  // 2. BUTTRESS / FLARE WINGS
  //
  // Short above-ground nodes at trunk base (the ONLY root nodes allowed pos[1]≥0).
  // Evenly spaced azimuthally around the trunk.
  //
  // rng draws: buttressCount draws for azimuth jitter.
  // -------------------------------------------------------------------------
  if (buttressCount > 0 && rootBonesAdded + buttressCount * buttressSegs <= maxRootBones) {
    for (let b = 0; b < buttressCount; b++) {
      // Base azimuth evenly spaced + small rng jitter
      const baseAz     = (b / buttressCount) * Math.PI * 2;
      const azJitter   = (rootRng() - 0.5) * 0.5;
      const az         = baseAz + azJitter;

      // Buttress direction: outward and slightly upward from the trunk base
      const buttressDir = norm3([Math.cos(az) * 0.85, 0.15, Math.sin(az) * 0.85]);
      // Crossfade wing (the last one) grows in by LENGTH (proportions owns the radius,
      // so length is the effective grow-in): scale its segment length by buttressFrac.
      const wWeight = (b === fullButtress && buttressFrac > 0) ? buttressFrac : 1.0;
      const buttressSegLen = (buttressLen / buttressSegs) * wWeight;

      // Place buttress segments — these stay near/above ground (pos[1] ≥ 0)
      let pos = origin;
      let parentIdx = firstTrunkBaseIdx;
      for (let s = 0; s < buttressSegs; s++) {
        pos = [
          pos[0] + buttressDir[0] * buttressSegLen,
          pos[1] + buttressDir[1] * buttressSegLen,
          pos[2] + buttressDir[2] * buttressSegLen,
        ];
        const idx = nodes.length;
        nodes.push({
          pos: [...pos],
          radius: 0.04 + rootFlare * 0.06,  // placeholder (proportions overwrites)
          weight: wWeight,
          isRoot: true,
          branchLevel: 0,
          rootLevel: 0,
          parentIdx,
        });
        bones.push({ a: parentIdx, b: idx });
        parentIdx = idx;
        rootBonesAdded++;
      }
    }
  } else if (buttressCount > 0) {
    // Budget full — consume jitter draws for determinism anyway
    for (let b = 0; b < buttressCount; b++) {
      rootRng(); // consume azimuth jitter draw
    }
  }

  // -------------------------------------------------------------------------
  // 3. MAJOR LATERALS + fractional crossfade
  //
  // N = floor(2 + rootCount*4) full laterals at weight=1.0
  // 1 crossfade lateral at weight=lateralFrac
  //
  // DETERMINISM INVARIANT: the crossfade lateral's rng draws are ALWAYS consumed
  // (whether lateralFrac > 0 or == 0), so rng draw count is identical for any
  // value of rootCount with the same floor().
  //
  // For each lateral:
  //   1 draw: azimuth jitter
  //   builds a horizontal+outward initial chain, then sub-branches
  // -------------------------------------------------------------------------
  const totalLaterals = fullLaterals + 1; // always include slot for crossfade

  for (let li = 0; li < totalLaterals; li++) {
    const isCrossfade = li === fullLaterals;
    const weight      = isCrossfade ? lateralFrac : 1.0;

    // Azimuth draw — always consumed (crossfade too, for determinism)
    const baseAz   = (li / fullLaterals) * Math.PI * 2;
    const azJitter = (rootRng() - 0.5) * 0.8;
    const az       = baseAz + azJitter;

    // Initial direction: outward along the horizontal plane
    const lateralInitDir = norm3([Math.cos(az), 0, Math.sin(az)]);

    // Build the main lateral chain (outward then geotropically curving down)
    // Skip geometry if crossfade weight is 0, but draws already consumed above
    if (isCrossfade && lateralFrac === 0) {
      // Still need to consume the sub-branch rng draws for this slot
      // We run the sub-branch draw-consumption loop with zero budget
      _consumeSubBranchDraws(rootRng, maxSubDepth);
      continue;
    }

    if (rootBonesAdded >= maxRootBones) {
      // Budget exhausted — consume draws for determinism
      _consumeSubBranchDraws(rootRng, maxSubDepth);
      continue;
    }

    const segsAvail = Math.min(lateralSegs, maxRootBones - rootBonesAdded);
    if (segsAvail < 1) {
      _consumeSubBranchDraws(rootRng, maxSubDepth);
      continue;
    }

    const lateral = buildRootChain(
      origin,
      lateralInitDir,
      lateralSegLen,
      segsAvail,
      lateralGeo,
      structuralSeed,
      li,
      0,       // rootLevel 0
      weight,
      firstTrunkBaseIdx,
      nodes,
      bones
    );
    rootBonesAdded += segsAvail;

    // Sub-branches off this lateral
    _growSubBranches(
      lateral.tipIdx,
      lateral.tipPos,
      lateral.tipDir,
      li,
      1,             // rootLevel 1 for first sub-branch level
      maxSubDepth,
      subDepthFrac,
      weight,
      structuralSeed,
      lateralGeo,
      rootRng,
      nodes,
      bones,
      maxRootBones,
      { current: rootBonesAdded }
    );
    rootBonesAdded = _countRootBones(nodes, firstTrunkBaseIdx);
  }

  return graph;
}

// ---------------------------------------------------------------------------
// _growSubBranches — recursive sub-branch emitter
//
// Spawns 2 sub-branches off the lateral tip (or further sub-branches of those),
// up to maxSubDepth levels deep, with a crossfade at the deepest level.
//
// rng draws per call: 2 draws (one per sub-branch, for azimuth/angle jitter)
// The draw count is fixed regardless of budget — determinism.
// ---------------------------------------------------------------------------
function _growSubBranches(
  parentIdx, parentPos, parentDir,
  lateralIndex, depth,
  maxSubDepth, subDepthFrac,
  parentWeight, structuralSeed,
  lateralGeo, rootRng,
  nodes, bones,
  maxRootBones, counter
) {
  // Always consume 2 draws for this level regardless of depth/budget (determinism)
  const draw0 = rootRng();
  const draw1 = rootRng();

  if (depth > maxSubDepth) return;

  // At the deepest depth level, apply depthFrac crossfade weight
  const depthWeight = (depth === maxSubDepth && subDepthFrac < 1.0)
    ? subDepthFrac
    : 1.0;
  const effectiveWeight = parentWeight * depthWeight;

  const subSegs = 3; // 3 nodes per sub-branch

  for (let si = 0; si < 2; si++) {
    const draw = si === 0 ? draw0 : draw1;

    // §1.4 draw-purity: on ANY skip path, still consume the draws the recursive
    // call would have consumed so that total rootRng draw count is independent
    // of effective weight and budget.
    if (counter.current >= maxRootBones) {
      // Budget exhausted — geometry skipped, but consume downstream draws.
      _consumeSubBranchDrawsAt(rootRng, depth + 1, maxSubDepth);
      continue;
    }
    if (effectiveWeight < 0.02) {
      // Invisible weight — geometry skipped, but consume downstream draws.
      _consumeSubBranchDrawsAt(rootRng, depth + 1, maxSubDepth);
      continue;
    }

    // Rotate sub-branch dir: spread in the horizontal plane then add downward pull
    const azOffset = si === 0 ? 0.6 : -0.6;
    const spreadDir = norm3(rotateAround(parentDir, [0, 1, 0], azOffset + (draw - 0.5) * 0.4));

    const subSegLen = 0.12 + draw * 0.10;  // 0.12..0.22 per segment

    const segsAvail = Math.min(subSegs, maxRootBones - counter.current);
    if (segsAvail < 1) {
      // Budget just ran out mid-loop — consume downstream draws.
      _consumeSubBranchDrawsAt(rootRng, depth + 1, maxSubDepth);
      continue;
    }

    const sub = buildRootChain(
      parentPos,
      spreadDir,
      subSegLen,
      segsAvail,
      lateralGeo * 1.2,     // sub-branches geo-trope slightly more aggressively
      structuralSeed,
      lateralIndex * 10 + si,  // unique hash per sub-branch
      depth,
      effectiveWeight,
      parentIdx,
      nodes,
      bones
    );
    counter.current += segsAvail;

    // Recurse
    _growSubBranches(
      sub.tipIdx, sub.tipPos, sub.tipDir,
      lateralIndex, depth + 1,
      maxSubDepth, subDepthFrac,
      effectiveWeight, structuralSeed,
      lateralGeo, rootRng,
      nodes, bones,
      maxRootBones, counter
    );
  }
}

// ---------------------------------------------------------------------------
// _consumeSubBranchDraws
//
// Consume the same number of rootRng draws that _growSubBranches would consume
// for a lateral that is skipped due to budget or zero weight.
// Called for the crossfade lateral when lateralFrac===0 AND for budget-full laterals.
//
// Draw count per level: 2 draws at each depth level, recursed to maxSubDepth.
// Total draws = 2 * (2^(maxSubDepth+1) - 1)  ... but in practice we recurse
// identically to the real code so draw count is always matched.
// ---------------------------------------------------------------------------
function _consumeSubBranchDraws(rootRng, maxSubDepth) {
  _consumeSubBranchDrawsAt(rootRng, 1, maxSubDepth);
}

function _consumeSubBranchDrawsAt(rootRng, depth, maxSubDepth) {
  // Mirror _growSubBranches: always consume 2 draws per call
  rootRng(); // draw0
  rootRng(); // draw1

  if (depth > maxSubDepth) return;

  // Recurse twice (one per sub-branch), mirroring the 2-branch structure
  _consumeSubBranchDrawsAt(rootRng, depth + 1, maxSubDepth);
  _consumeSubBranchDrawsAt(rootRng, depth + 1, maxSubDepth);
}

// ---------------------------------------------------------------------------
// _countRootBones — count appended root bones since the canopy finished.
//
// We count bones whose both endpoints are isRoot nodes (or whose `a` endpoint
// is the trunk base, which is the attachment point for buttresses/laterals).
// Simpler: just track the count via the counter object and recount from nodes.
// ---------------------------------------------------------------------------
function _countRootBones(nodes, firstTrunkBaseIdx) {
  let count = 0;
  for (let i = firstTrunkBaseIdx + 1; i < nodes.length; i++) {
    if (nodes[i].isRoot) count++;
  }
  return count;
}
