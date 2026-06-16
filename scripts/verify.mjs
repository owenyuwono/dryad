// =============================================================================
// scripts/verify.mjs — end-to-end acceptance gate for the FLORA pipeline.
//
// Runs the full integrated pipeline (pickArchetype → buildSkeleton →
// solveProportions → skin) exactly as main.js's generate() does.
//
// Usage: node scripts/verify.mjs
// Exit 0 = all assertions passed. Exit 1 = one or more failures.
// =============================================================================

import assert from 'assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Import real pipeline modules (no Three.js, no main.js)
// ---------------------------------------------------------------------------
const { mulberry32 }       = await import(resolve(ROOT, 'src/rng.js'));
const { pickArchetype }    = await import(resolve(ROOT, 'src/archetype.js'));
const { buildSkeleton }    = await import(resolve(ROOT, 'src/skeleton.js'));
const { solveProportions } = await import(resolve(ROOT, 'src/proportions.js'));
const { skin }             = await import(resolve(ROOT, 'src/skin.js'));

// ---------------------------------------------------------------------------
// Failure collection
// ---------------------------------------------------------------------------
const failures = [];

function fail(msg) {
  failures.push(msg);
}

// ---------------------------------------------------------------------------
// Run the pipeline exactly as generate() does in main.js
// ---------------------------------------------------------------------------
function runPipeline(envelope, seed) {
  const rng = mulberry32(seed);
  const archetype = pickArchetype(envelope, rng);
  const graph = buildSkeleton(archetype, rng);
  solveProportions(graph, envelope);
  const skinData = skin(graph, envelope);
  return { archetype, graph, skinData };
}

// ---------------------------------------------------------------------------
// Sweep parameters
// ---------------------------------------------------------------------------
const SEEDS       = Array.from({ length: 201 }, (_, i) => i); // 0..200
const MEDIUMS     = ['air', 'water', 'dense_air'];
const GRAVITIES   = [0.1, 1.0, 3.0];
const KNOB_CASES  = buildKnobCases();

function buildKnobCases() {
  // Each knob independently at {0, default, 1}; remaining knobs at defaults.
  const defaults = { light: 0.6, sunAngle: 0.25, wind: 0.2, aridity: 0.35 };
  const cases = [defaults]; // include the all-defaults case first

  for (const knob of ['light', 'sunAngle', 'wind', 'aridity']) {
    for (const val of [0, 1]) {
      cases.push({ ...defaults, [knob]: val });
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// CHECK 6: Source-level assertions (read once, checked once)
// ---------------------------------------------------------------------------
const skeletonSrc = readFileSync(resolve(ROOT, 'src/skeleton.js'), 'utf8');
const fragSrc     = readFileSync(resolve(ROOT, 'src/shaders/creature.frag.glsl'), 'utf8');

// CHECK 6a: exactly one applySymmetry function definition
{
  // Count occurrences of "function applySymmetry(" and "export function applySymmetry("
  const funcDefMatches = (skeletonSrc.match(/function applySymmetry\s*\(/g) || []).length;
  if (funcDefMatches !== 1) {
    fail(`CHECK6a: expected exactly 1 applySymmetry function definition in skeleton.js, found ${funcDefMatches}`);
  } else {
    process.stdout.write('CHECK6a PASS: exactly 1 applySymmetry definition\n');
  }
}

// CHECK 6b: buildSkeleton body contains no per-symmetry branching
{
  // Extract the buildSkeleton body (from "export function buildSkeleton" to end of file)
  const buildSkeletonIdx = skeletonSrc.indexOf('export function buildSkeleton');
  const buildSkeletonBody = buildSkeletonIdx >= 0 ? skeletonSrc.slice(buildSkeletonIdx) : '';

  const hasIfSymmetry     = /if\s*\(\s*symmetry\s*===/.test(buildSkeletonBody);
  const hasSwitchSymmetry = /switch\s*\(\s*symmetry\s*\)/.test(buildSkeletonBody);

  if (hasIfSymmetry) {
    fail('CHECK6b: buildSkeleton body contains "if (symmetry ===" — per-symmetry branching must be in applySymmetry only');
  } else if (hasSwitchSymmetry) {
    fail('CHECK6b: buildSkeleton body contains "switch (symmetry)" — per-symmetry branching must be in applySymmetry only');
  } else {
    process.stdout.write('CHECK6b PASS: buildSkeleton has no per-symmetry branching\n');
  }
}

// CHECK 7: shader source assertions
{
  // 7a: smin function body exists
  const hasSmin = /float\s+smin\s*\(/.test(fragSrc);
  if (!hasSmin) {
    fail('CHECK7: smin() function body not found in creature.frag.glsl');
  } else {
    process.stdout.write('CHECK7a PASS: smin() function present\n');
  }

  // 7b: sdRoundCone function body exists
  const hasSdRoundCone = /float\s+sdRoundCone\s*\(/.test(fragSrc);
  if (!hasSdRoundCone) {
    fail('CHECK7: sdRoundCone() function body not found in creature.frag.glsl');
  } else {
    process.stdout.write('CHECK7b PASS: sdRoundCone() function present\n');
  }

  // 7c: the per-junction k fix is present:
  //   k_i must be a function of min(A.w, B.w) multiplied by uBlendK
  //   Pattern: uBlendK * min(A.w, B.w)  or  min(A.w, B.w) * uBlendK
  const hasPerJunctionK = /uBlendK\s*\*\s*min\s*\(\s*[AB]\.w\s*,\s*[AB]\.w\s*\)/.test(fragSrc) ||
                          /min\s*\(\s*[AB]\.w\s*,\s*[AB]\.w\s*\)\s*\*\s*uBlendK/.test(fragSrc);
  if (!hasPerJunctionK) {
    fail('CHECK7c: per-junction blend k fix not found — expected "uBlendK * min(A.w, B.w)" or equivalent in sceneSDF');
  } else {
    process.stdout.write('CHECK7c PASS: per-junction k = uBlendK * min(A.w, B.w) * scale present\n');
  }
}

// ---------------------------------------------------------------------------
// Build the full sweep (all combinations for checks 1-5)
// ---------------------------------------------------------------------------

// For determinism check (CHECK 5): collect 30 representative cases
const determinismCases = [];
let deterIdx = 0;

let totalCases = 0;
let check1Failures = 0;
let check2Failures = 0;
let check3Failures = 0;
let check4Failures = 0;
let check5Failures = 0;

process.stdout.write(`\nStarting sweep: ${SEEDS.length} seeds × ${KNOB_CASES.length} knob cases × ${MEDIUMS.length} mediums × ${GRAVITIES.length} gravities\n`);

const EXPECTED_TOTAL = SEEDS.length * KNOB_CASES.length * MEDIUMS.length * GRAVITIES.length;
process.stdout.write(`Total cases: ${EXPECTED_TOTAL}\n\n`);

for (const seed of SEEDS) {
  for (const knobs of KNOB_CASES) {
    for (const medium of MEDIUMS) {
      for (const gravity of GRAVITIES) {
        totalCases++;

        const envelope = {
          gravity,
          medium,
          energy:   'photo',
          biochem:  'carbon',
          light:    knobs.light,
          sunAngle: knobs.sunAngle,
          wind:     knobs.wind,
          aridity:  knobs.aridity,
        };

        let archetype, graph, skinData;
        try {
          ({ archetype, graph, skinData } = runPipeline(envelope, seed));
        } catch (err) {
          fail(`PIPELINE ERROR seed=${seed} medium=${medium} gravity=${gravity} knobs=${JSON.stringify(knobs)}: ${err.message}`);
          continue;
        }

        const caseId = `seed=${seed} medium=${medium} gravity=${gravity} light=${knobs.light} sunAngle=${knobs.sunAngle} wind=${knobs.wind} aridity=${knobs.aridity}`;

        // ------------------------------------------------------------------
        // CHECK 1: BUDGET
        // ------------------------------------------------------------------
        if (skinData.boneCount > 64) {
          check1Failures++;
          if (failures.filter(f => f.startsWith('CHECK1')).length < 5) {
            fail(`CHECK1: boneCount=${skinData.boneCount} > 64 [${caseId}]`);
          }
        }
        if (skinData.boneAData.length !== 256) {
          check1Failures++;
          if (failures.filter(f => f.startsWith('CHECK1')).length < 5) {
            fail(`CHECK1: boneAData.length=${skinData.boneAData.length} !== 256 [${caseId}]`);
          }
        }
        if (skinData.boneBData.length !== 256) {
          check1Failures++;
          if (failures.filter(f => f.startsWith('CHECK1')).length < 5) {
            fail(`CHECK1: boneBData.length=${skinData.boneBData.length} !== 256 [${caseId}]`);
          }
        }
        if (skinData.boneFlatData.length !== 256) {
          check1Failures++;
          if (failures.filter(f => f.startsWith('CHECK1')).length < 5) {
            fail(`CHECK1: boneFlatData.length=${skinData.boneFlatData.length} !== 256 [${caseId}]`);
          }
        }

        // ------------------------------------------------------------------
        // CHECK 2: LEVELS — max branchLevel ≥ 2 when archetype.maxDepth ≥ 3
        // ------------------------------------------------------------------
        if (archetype.maxDepth >= 3) {
          const { nodes } = graph;
          let maxBranchLevel = 0;
          for (const n of nodes) {
            if (n.branchLevel !== undefined && n.branchLevel > maxBranchLevel) {
              maxBranchLevel = n.branchLevel;
            }
          }
          if (maxBranchLevel < 2) {
            check2Failures++;
            if (failures.filter(f => f.startsWith('CHECK2')).length < 5) {
              fail(`CHECK2: maxBranchLevel=${maxBranchLevel} < 2 (maxDepth=${archetype.maxDepth}) [${caseId}]`);
            }
          }
        }

        // ------------------------------------------------------------------
        // CHECK 3: GRAPH INTEGRITY
        // ------------------------------------------------------------------
        {
          const { nodes } = graph;
          const n = nodes.length;

          // 3a: parentIdx < ownIndex for all non-trunk-base nodes
          for (let i = 1; i < n; i++) {
            const node = nodes[i];
            if (node.parentIdx !== undefined && node.parentIdx !== -1) {
              if (node.parentIdx >= i) {
                check3Failures++;
                if (failures.filter(f => f.startsWith('CHECK3a')).length < 3) {
                  fail(`CHECK3a: nodes[${i}].parentIdx=${node.parentIdx} >= ownIndex [${caseId}]`);
                }
              }
            }
          }

          // 3b: connected — every node reaches trunk base via parentIdx chain
          for (let i = 1; i < n; i++) {
            let cur = i;
            let steps = 0;
            let reached = false;
            while (cur !== -1 && steps < n + 1) {
              const curNode = nodes[cur];
              const p = curNode.parentIdx !== undefined ? curNode.parentIdx : -1;
              if (p === -1) { reached = true; break; }
              cur = p;
              steps++;
            }
            if (!reached) {
              check3Failures++;
              if (failures.filter(f => f.startsWith('CHECK3b')).length < 3) {
                fail(`CHECK3b: node[${i}] does not reach trunk base — cycle or disconnected [${caseId}]`);
              }
              break; // one report per case is enough
            }
          }

          // 3c: exactly one of isWoody/isTerminal true on each non-root branch node
          // "non-root branch node" = branchLevel > 0, not isRoot
          for (let i = 0; i < n; i++) {
            const node = nodes[i];
            if (node.isRoot) continue;
            if (node.branchLevel === 0) continue; // trunk nodes exempt
            const woody    = node.isWoody    === true;
            const terminal = node.isTerminal === true;
            if (woody && terminal) {
              check3Failures++;
              if (failures.filter(f => f.startsWith('CHECK3c')).length < 3) {
                fail(`CHECK3c: nodes[${i}] has BOTH isWoody and isTerminal true [${caseId}]`);
              }
            } else if (!woody && !terminal) {
              check3Failures++;
              if (failures.filter(f => f.startsWith('CHECK3c')).length < 3) {
                fail(`CHECK3c: nodes[${i}] has NEITHER isWoody nor isTerminal (branchLevel=${node.branchLevel}) [${caseId}]`);
              }
            }
          }
        }

        // ------------------------------------------------------------------
        // CHECK 4: PIPE MODEL — r² ≈ Σ(child r²) for interior nodes
        //
        // The proportions contract (see src/proportions.js "RADIUS CONCEPT 2")
        // specifies the pipe-model invariant only for non-root, non-terminal
        // children in the taper chain.  Root flare nodes (isRoot: true) are set
        // by a completely separate physics formula (rootBaseRadius) and must NOT
        // be included in the child-sum.  Therefore:
        //   - We count only non-root children when computing Σ(child r²).
        //   - We skip any node whose non-root child count is ≤ 1 (c==1 chain
        //     or leaf has no taper-chain split to verify).
        // ------------------------------------------------------------------
        {
          const { nodes } = graph;
          const childrenOf = new Array(nodes.length).fill(null).map(() => []);
          for (let i = 0; i < nodes.length; i++) {
            const p = nodes[i].parentIdx;
            if (p !== undefined && p >= 0) childrenOf[p].push(i);
          }

          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            // Skip: the node itself is a root flare or a terminal leaf
            if (node.isRoot) continue;
            if (node.isTerminal) continue;

            const allChildren = childrenOf[i];

            // Only count non-root children for the pipe model sum
            const pipeChildren = allChildren.filter(ci => !nodes[ci].isRoot);

            // Skip: c == 1 chains (per spec: "skip c==1 chains")
            if (pipeChildren.length <= 1) continue;

            const r = node.radius;
            if (!r || r <= 0) continue;

            const sumChildR2 = pipeChildren.reduce((sum, ci) => {
              return sum + nodes[ci].radius * nodes[ci].radius;
            }, 0);
            const r2 = r * r;

            const relErr = Math.abs(r2 - sumChildR2) / r2;
            if (relErr > 0.05) {
              check4Failures++;
              if (failures.filter(f => f.startsWith('CHECK4')).length < 5) {
                fail(`CHECK4: pipe model violation at nodes[${i}] r²=${r2.toFixed(6)}, Σchild_r²=${sumChildR2.toFixed(6)}, relErr=${relErr.toFixed(4)} (>0.05) pipeChildren=${pipeChildren.length} [${caseId}]`);
              }
            }
          }
        }

        // ------------------------------------------------------------------
        // CHECK 5: DETERMINISM — collect representative cases (every ~7th)
        // ------------------------------------------------------------------
        if (deterIdx % 7 === 0 && determinismCases.length < 30) {
          determinismCases.push({ envelope: JSON.parse(JSON.stringify(envelope)), seed });
        }
        deterIdx++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CHECK 5: Run determinism check on collected cases
// ---------------------------------------------------------------------------
process.stdout.write(`\nRunning determinism check on ${determinismCases.length} representative cases...\n`);

for (const { envelope, seed } of determinismCases) {
  let r1, r2;
  try {
    r1 = runPipeline(envelope, seed);
    r2 = runPipeline(envelope, seed);
  } catch (err) {
    // If pipeline throws, CHECK 5 can't run for this case — already caught above
    continue;
  }

  // Deep-compare final skin output
  const skin1 = r1.skinData;
  const skin2 = r2.skinData;

  if (skin1.boneCount !== skin2.boneCount) {
    check5Failures++;
    fail(`CHECK5: boneCount not deterministic (${skin1.boneCount} vs ${skin2.boneCount}) seed=${seed} medium=${envelope.medium}`);
    continue;
  }

  // Compare packed float arrays element-by-element
  let mismatch = false;
  for (let i = 0; i < 256; i++) {
    if (skin1.boneAData[i] !== skin2.boneAData[i]) {
      mismatch = true;
      check5Failures++;
      fail(`CHECK5: boneAData[${i}] not deterministic (${skin1.boneAData[i]} vs ${skin2.boneAData[i]}) seed=${seed} medium=${envelope.medium} gravity=${envelope.gravity}`);
      break;
    }
    if (skin1.boneBData[i] !== skin2.boneBData[i]) {
      mismatch = true;
      check5Failures++;
      fail(`CHECK5: boneBData[${i}] not deterministic seed=${seed} medium=${envelope.medium}`);
      break;
    }
    if (skin1.boneFlatData[i] !== skin2.boneFlatData[i]) {
      mismatch = true;
      check5Failures++;
      fail(`CHECK5: boneFlatData[${i}] not deterministic seed=${seed} medium=${envelope.medium}`);
      break;
    }
  }

  // Also compare graph radii and positions
  if (!mismatch) {
    const nodes1 = r1.graph.nodes;
    const nodes2 = r2.graph.nodes;
    if (nodes1.length !== nodes2.length) {
      check5Failures++;
      fail(`CHECK5: node count not deterministic (${nodes1.length} vs ${nodes2.length}) seed=${seed}`);
    } else {
      for (let i = 0; i < nodes1.length; i++) {
        const n1 = nodes1[i]; const n2 = nodes2[i];
        if (n1.radius !== n2.radius ||
            n1.pos[0] !== n2.pos[0] ||
            n1.pos[1] !== n2.pos[1] ||
            n1.pos[2] !== n2.pos[2]) {
          check5Failures++;
          fail(`CHECK5: graph node[${i}] not deterministic seed=${seed} medium=${envelope.medium}`);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
process.stdout.write('\n=== VERIFY RESULTS ===\n');
process.stdout.write(`Total cases swept: ${totalCases}\n`);
process.stdout.write(`Determinism cases checked: ${determinismCases.length}\n`);
process.stdout.write('\nCheck summary:\n');
process.stdout.write(`  CHECK1 (budget): ${check1Failures === 0 ? 'PASS' : `FAIL (${check1Failures} violations)`}\n`);
process.stdout.write(`  CHECK2 (levels): ${check2Failures === 0 ? 'PASS' : `FAIL (${check2Failures} violations)`}\n`);
process.stdout.write(`  CHECK3 (graph integrity): ${check3Failures === 0 ? 'PASS' : `FAIL (${check3Failures} violations)`}\n`);
process.stdout.write(`  CHECK4 (pipe model): ${check4Failures === 0 ? 'PASS' : `FAIL (${check4Failures} violations)`}\n`);
process.stdout.write(`  CHECK5 (determinism): ${check5Failures === 0 ? 'PASS' : `FAIL (${check5Failures} violations)`}\n`);
process.stdout.write(`  CHECK6 (single applySymmetry + no per-symmetry branching in buildSkeleton): see above\n`);
process.stdout.write(`  CHECK7 (shader smin/sdRoundCone/per-junction-k): see above\n`);

if (failures.length > 0) {
  process.stdout.write(`\n=== FAILURES (${failures.length}) ===\n`);
  for (const f of failures) {
    process.stdout.write(`  FAIL: ${f}\n`);
  }
  process.stdout.write('\nResult: FAILED\n');
  process.exit(1);
} else {
  process.stdout.write('\nResult: ALL CHECKS PASSED\n');
  process.exit(0);
}
