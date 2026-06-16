# ROOTS_PLAN.md — Full Procedural Root System

Implementation spec for adding a complete underground root system (central taproot +
N radial laterals curving down + recursive sub-branching + above-ground buttress/flare)
to the procedural-flora generator. Roots are a continuous region of the SAME morphospace,
reuse the existing tube-mesh/bark/shadow path, and dive below y=0. A ground-reveal toggle
lets the user verify the otherwise-hidden roots.

Gates: `npm run build` AND `node --test test/*.mjs test/*.js`. No browser verification.

---

## 0. Grounded facts (verified file:line — TRUST these)

- `resolve(genome, env)` — `src/genome.js:377-412`. Sequence:
  `rng = mulberry32(genome.structuralSeed)` (379) → `buildSkeleton(genome, rng, genome.jitter)` (382)
  → `solveProportions(graph, env, genome)` (386) → `skin(graph, env, genome)` (390)
  → `generateFoliage(graph, genome)` (394) → returns `{...skinData, boneCount: graph.bones.length, graph, ...}` (396).
- Root-flare STUB — `src/skeleton.js:552-574`. 3 fixed offsets at y=−0.20, each
  `{isRoot:true, branchLevel:0, parentIdx:0, radius:0.07, weight:1.0}`, bones pushed to
  `firstTrunkBaseIdx (=0)`. `boneCounter = bones.length` is set AFTER (576). Returns
  `{nodes, bones, meta:{bodyAxis:[0,1,0], lightDir}}` (862-869). `MAX_BONES = 900` (339).
- proportions — `src/proportions.js`. isRoot radius set at 579 (`n.radius = rootBaseRadius`),
  `rootBaseRadius = 0.18 * gravPow(gravity,0.5)` (428-429). isRoot SKIPPED in bend pass at 681.
  Tip-taper pass (667-672) sets ANY childless node to `max(0.012, r*0.08)` — this currently
  fires on root-flare tips. Guards: isFrond throw (199-208), `parentIdx < ownIndex` (213-224).
- foliage — `src/foliage.js:276` skips `node.isRoot`; `277` skips `branchLevel < 1`. Isolated
  rng stream `mulberry32((genome.structuralSeed ^ 0x1EAF1EAF) >>> 0)` (262).
- branchMesh — `src/branchMesh.js:189-192`. `opts.includeRoot !== false` (default true);
  filters bones touching isRoot nodes when false (237-240). `bounds` = AABB over emitted verts (636-645).
- viewer — `src/viewer.js`. `buildBranchGeometry(resolved.graph)` (524, NO opts → includeRoot=true).
  `ground.setBaseY(g.bounds.min[1])` (578) ← ROOTS-GO-NEGATIVE RISK. `computeFitFromBounds(g.bounds)` (627).
  Public API returned at 507-738. `createGround()` — `src/ground.js`, opaque MeshStandardMaterial,
  returns `{mesh, setBaseY, dispose}`.
- genomeSchema — `src/genomeSchema.js`. `FLORA_SCHEMA` frozen (32-219). Tier arrays DERIVED via
  `Object.keys(FLORA_SCHEMA).filter(...)` (226-238). `clampField` (261), `genomeDistance` (294)
  both iterate ALL schema keys → new genes auto-participate.
- genome — `src/genome.js`. `NEUTRAL` frozen (131-157), `computeEnvOffset` (178-254),
  `randomGenome` draws 01-23 in FIXED order (296-326), explicit return object (328-355).
- main.js — `MORPH_GENES` (15-26), `GENE_SLIDER_ID` (29-52), `TREE_DEFAULT` (256-280),
  render-mode wiring `wireRenderModePanel` IIFE (95-114).
- index.html — tab panels with `data-gene`/`data-display` sliders, `#rendermode-panel`
  with `data-mode` buttons (570-617), `#stats-panel` (541-567), tab-switch IIFE (623-646).

---

## 1. FROZEN INTERFACES

### 1.1 New genes (append to `FLORA_SCHEMA` in `src/genomeSchema.js`)

All `tier:'structural'`, `kind:'continuous'`. Add AFTER the existing structural block
(insertion position in the object is cosmetic for the schema, but see §1.6 for the
draw-order rule that actually protects determinism). Use the same `Object.freeze` form.

```js
rootCount:    { tier:'structural', kind:'continuous', range:[0, 1] }, // → fractional 2..6 major laterals (crossfade)
rootDepth:    { tier:'structural', kind:'continuous', range:[0, 1] }, // → taproot dive depth multiplier
rootSpread:   { tier:'structural', kind:'continuous', range:[0, 1] }, // → radial reach of laterals before diving
rootFlare:    { tier:'structural', kind:'continuous', range:[0, 1] }, // → above-ground trunk-base flare girth
rootButtress: { tier:'structural', kind:'continuous', range:[0, 1] }, // → buttress wing prominence (0=none,1=fig-like)
rootBranchiness: { tier:'structural', kind:'continuous', range:[0, 1] }, // → fractional sub-branch depth 0..3
rootTaper:    { tier:'structural', kind:'continuous', range:[0, 1] }, // → root pipe-model taper aggressiveness
```

NEUTRAL defaults (add to `NEUTRAL` in `src/genome.js`, same append rule):

```
rootCount: 0.45, rootDepth: 0.45, rootSpread: 0.50, rootFlare: 0.30,
rootButtress: 0.15, rootBranchiness: 0.45, rootTaper: 0.50,
```

### 1.2 Root-node flag contract (what marks a root node)

Every node produced by the root system MUST carry:

```
{
  pos: [x,y,z],            // y MAY be < 0 (underground) or ≥ 0 (buttress/flare above ground)
  isRoot: true,            // PRIMARY marker. proportions/foliage/branchMesh all key off this.
  branchLevel: 0,          // KEEP 0 for ALL root nodes (matches stub; keeps foliage's
                           //   `branchLevel < 1` skip working AND keeps the canopy
                           //   maxBranchLevel/ageColor normalization untouched).
  rootLevel: <int ≥ 0>,    // NEW field, root-internal depth: 0 = taproot/major-lateral
                           //   primary chain, 1.. = recursive sub-branches. Used by roots.js
                           //   for taper + by tests; ignored by canopy code.
  parentIdx: <int>,        // INVARIANT parentIdx < ownIndex. Roots are appended at the END of
                           //   nodes[], and the taproot's first node parents to firstTrunkBaseIdx (0),
                           //   so the invariant holds automatically.
  weight: 1.0,             // crossfade weight (rootCount fractional crossfade scales this on the
                           //   one extra lateral; see §1.4).
  radius: <placeholder>,   // OVERWRITTEN by proportions.js (physics-only). Any value is fine here.
}
```

Underground marker = `isRoot === true`. There is NO separate `isUnderground` flag — a node is
underground iff `isRoot && pos[1] < 0`, which callers compute directly when needed (ground/camera).
Root nodes MUST NOT set `isStem`, `isWoody`, `isTerminal`, or `attachPos` (those route nodes into
canopy/leaf code paths). A childless root tip is fine; proportions tip-taper handles it.

### 1.3 `growRootSystem(...)` — NEW pure module `src/roots.js`

```js
// src/roots.js — pure ESM, no three.js. Node-testable.
// Appends a full root system to an existing skeleton graph IN PLACE.
//
// CONTRACT:
//   - Reads only graph.nodes[firstTrunkBaseIdx].pos as the origin (= [0,0,0] by stub convention).
//   - Appends new root nodes to graph.nodes and bones to graph.bones (mutates arrays).
//   - Consumes draws ONLY from the passed `rootRng` (an isolated sub-stream). NEVER touches
//     the main skeleton rng.
//   - Sets radius to a placeholder; proportions.js owns final root radii.
//   - Guarantees parentIdx < ownIndex for every appended node (append-only ordering).
//   - Honors a bone budget separate from canopy (see §1.5).
//
// SIGNATURE:
export function growRootSystem(graph, genome, rootRng, opts = {}) → graph  // returns same graph (mutated)
//
//   graph    — { nodes, bones, meta } AFTER buildSkeleton has run (root STUB already removed; see §2 Task 4).
//   genome   — flora genome; reads rootCount, rootDepth, rootSpread, rootFlare,
//              rootButtress, rootBranchiness, rootTaper, structuralSeed.
//   rootRng  — function():number, = mulberry32(structuralSeed ^ ROOT_SALT). See §1.6.
//   opts.env — optional environment envelope; if present, roots.js may read aridity/wind to
//              bias geometry (see §3 env-directional). If absent, geometry uses gene values only.
//   opts.maxRootBones — hard cap on appended root bones (default ROOT_BONE_BUDGET, §1.5).
//
// Exported constants (for tests + tuning):
export const ROOT_BONE_BUDGET;   // see §1.5
export const ROOT_SALT;          // see §1.6
```

Internal structure roots.js must produce (deterministic, gene-driven):
- One **taproot**: a downward-curving chain from origin, depth ∝ `rootDepth` (and arid bias).
- **N major laterals** (`N = floor(2 + rootCount*4)` full + 1 fractional crossfade at weight `frac`),
  splayed radially (azimuth evenly spaced + small `rootRng` jitter), growing outward to
  `rootSpread` reach then curving downward (geotropism: each lateral chain bends toward −Y as it
  extends — INVERTED sign vs canopy anti-gravity droop; see §4 Risk A).
- **Recursive sub-branches** off laterals to fine tips, depth ∝ `rootBranchiness`
  (fractional crossfade on the deepest level, same idiom as `skeleton.js` depthFrac).
- **Buttress/flare**: short above-ground wings at the trunk base, count/prominence ∝
  `rootButtress`, girth ∝ `rootFlare`. These are the ONLY root nodes allowed `pos[1] ≥ 0`.

Reuse `skeleton.js`'s deterministic curvature idiom (sin-hash of structuralSeed + index + level)
where possible for stable per-organism character; per-node jitter comes from `rootRng` draws.

### 1.4 Fractional-count crossfade (rootCount)

Identical idiom to tillering/branchFactorN in `skeleton.js`: build `floor(2+rootCount*4)` full
laterals at weight 1.0 + 1 crossfade lateral at `weight = frac` (scale BOTH its radius placeholder
AND its chain length by `frac`). ALWAYS consume the same number of `rootRng` draws for the crossfade
lateral regardless of `frac` (determinism).

### 1.5 Bone budget — roots get their OWN budget (do NOT compete with canopy MAX_BONES)

DECISION: roots use a dedicated `ROOT_BONE_BUDGET = 220` (export from roots.js), independent of the
canopy `SOFT_CEILING`/`MAX_BONES`. Rationale: roots run as a post-pass after the canopy BFS has
already terminated, so they cannot starve the canopy, and a fixed root budget keeps total bone count
bounded and predictable (`graph.bones.length ≤ MAX_BONES + ROOT_BONE_BUDGET`). roots.js stops
spawning new sub-branches once it has appended `ROOT_BONE_BUDGET` bones (graceful tip termination,
same pattern as canopy SOFT_CEILING). Tests assert the combined ceiling.

### 1.6 `ROOT_SALT` sub-stream derivation (CRITICAL for determinism)

```js
// src/roots.js
export const ROOT_SALT = 0x900D5EED;   // distinct from foliage's 0x1EAF1EAF
// In resolve():  const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);
```

Two-part determinism guarantee:
1. **Skeleton/foliage stream isolation**: roots.js consumes ZERO draws from the main skeleton
   `rng` (the `mulberry32(structuralSeed)` created at genome.js:379). It uses only `rootRng`.
   Therefore canopy node positions + foliage SoA are BYTE-IDENTICAL to pre-roots output for every
   existing seed.
2. **randomGenome stream isolation**: the new gene draws in `randomGenome` MUST be appended
   STRICTLY AFTER the existing final draw (draw 23 = structuralSeed at genome.js:326). New genes
   are drawn as draws 24-30 AFTER `structuralSeed` is consumed. This keeps draws 01-23 (every
   existing gene + structuralSeed) bit-identical, so existing seeds produce the same canopy genes
   AND the same structuralSeed → same canopy + foliage.

### 1.7 proportions contract for roots

Root nodes are detected by `n.isRoot === true` (already at proportions.js:579). Required changes
(Task 2 owns proportions.js):
- The current single-line `n.radius = rootBaseRadius` (579-582) is REPLACED by a root pipe-model:
  taproot base = `rootBaseRadius * (1 + genome.rootFlare)`; children taper by `rootTaper`-derived
  ratio (`0.60 + rootTaper*0.25`), residual-area split for sub-branch forks (same sqrt residual
  formula as canopy, lines 638-643). This requires a forward pass over root nodes ordered by
  parentIdx (already guaranteed `parentIdx < ownIndex`).
- **Geotropism is GEOMETRY, owned by roots.js, NOT proportions.js.** proportions.js MUST NOT apply
  the canopy droop/phototropism/verticality bending to root nodes — keep the `if (n.isRoot) continue;`
  skip in the bending pass (681). Roots already point downward from roots.js; re-bending them would
  double-apply and is the trickiest sign-flip bug (Risk A). proportions.js only sizes radii for roots.
- Tip-taper pass (667-672) MAY continue to fire on childless root tips (gives a clean cone tip) —
  this is acceptable and desirable.

### 1.8 foliage exclusion

NO change required. `src/foliage.js:276` (`if (node.isRoot) continue;`) plus `:277`
(`branchLevel < 1`) already exclude every root node (all root nodes keep `branchLevel: 0`).
Task 3 adds a regression TEST asserting zero foliage clusters originate on root nodes.

### 1.9 Reveal-toggle API (ground hide/fade)

```js
// src/ground.js — extend the returned controller object:
createGround() → {
  mesh,
  setBaseY(y),
  setRevealed(revealed: boolean),   // NEW. revealed=true → ground hidden/faded so roots are visible.
                                    //   Implementation: mesh.visible = !revealed  (simplest, opaque flip).
                                    //   OPTIONAL nicety: set mat.transparent=true, mat.opacity=revealed?0.15:1.0
                                    //   and keep mesh.visible=true so roots show through a ghost ground.
                                    //   Either is acceptable; pick the opacity-fade if shadows must persist.
  dispose(),
}

// src/viewer.js — extend the public factory return object:
viewer.setRootsRevealed(revealed: boolean): void   // NEW. Calls ground.setRevealed(revealed).
                                                   // Also adjusts ground baseline so it does NOT
                                                   // sit at bounds.min[1] when roots are present
                                                   // (see Risk B fix in §2 Task 5).
```

Ground/camera MUST NOT follow roots underground (Risk B). Task 5 changes viewer.js so:
- `ground.setBaseY(...)` uses a SURFACE Y of `0` (the trunk-base origin plane), NOT `g.bounds.min[1]`.
  (Roots originate at trunk base y≈0 and dive below; the visible ground belongs at y≈0.)
- `computeFitFromBounds` ignores below-ground extent: compute the fit from a bounds whose
  `min[1]` is clamped to `max(bounds.min[1], 0)` when roots are NOT revealed, so the camera frames
  the canopy, not the buried roots. When roots ARE revealed, use the true bounds so roots fit in view.

---

## 2. TASKS (5, parallelizable against the frozen interface above)

> File-ownership rule: `src/genome.js` has ONE owner (Task 1). `src/main.js` and `index.html`
> are split BY SECTION between Task 1 (gene sliders) and Task 5 (reveal toggle) — see notes.
> `src/roots.js` (NEW), `src/proportions.js`, and `src/ground.js`+`src/viewer.js` are disjoint.

### Task 1: Genome schema + genes + resolve() wiring  (the integration spine)
- OWNS: `src/genomeSchema.js`, `src/genome.js`, AND the gene-slider SECTIONS of `src/main.js`
  (`MORPH_GENES`, `GENE_SLIDER_ID`, `TREE_DEFAULT`) + `index.html` (the Form/new "Roots" tab sliders).
- Implements:
  1. Append the 7 root genes to `FLORA_SCHEMA` (§1.1) with matching frozen format.
  2. Append the 7 NEUTRAL defaults (§1.1) and 7 `computeEnvOffset` entries
     (init to 0; add env bias: `aridity → rootDepth += 0.30*aridHeat`, `rootTaper += 0.10*aridHeat`;
     `wind → rootFlare += 0.30*windDelta`, `rootButtress += 0.20*windDelta`;
     `medium==='water' || low-aridity-wet → rootSpread += 0.20, rootDepth -= 0.20` for plate roots).
  3. In `randomGenome`, draw the 7 root genes as draws 24-30, STRICTLY AFTER structuralSeed (draw 23,
     genome.js:326). Add them to the explicit return object (328-355).
  4. In `resolve()`, after `buildSkeleton` returns (genome.js:382) and BEFORE `solveProportions`
     (386): `const rootRng = mulberry32((genome.structuralSeed ^ ROOT_SALT) >>> 0);`
     then `growRootSystem(graph, genome, rootRng, { env });`. Import `growRootSystem`, `ROOT_SALT`
     from `./roots.js`.
  5. Add 7 root genes to `MORPH_GENES` + `GENE_SLIDER_ID` in main.js, 7 entries to `TREE_DEFAULT`,
     and a new "Roots" tab (or extend "Form") in index.html with 7 sliders (`data-gene`/`data-display`
     matching the existing pattern at index.html:422-435).
- Depends on: roots.js EXPORT SIGNATURE (§1.3) only — code against the frozen contract; does NOT
  need roots.js implemented to compile-check the import. Order: can start immediately; full
  determinism tests (Task in §3) require Task 4 done.
- Acceptance criteria:
  - [ ] `npm run build` passes.
  - [ ] `FLORA_SCHEMA` has the 7 new genes, each `{tier:'structural', kind:'continuous', range:[..]}`.
  - [ ] `STRUCTURAL_FIELDS` (derived) now includes all 7 (no manual list edit needed).
  - [ ] `randomGenome(env, seed)` returns an object containing all 7 root genes within their ranges.
  - [ ] For ANY seed, the first 23 rng draws are UNCHANGED: a snapshot of every pre-existing gene +
        structuralSeed for seeds 0..50 equals the pre-roots values (regression test, §3).
  - [ ] `resolve()` output `graph.nodes` contains `isRoot` nodes beyond the old 3-node stub.
  - [ ] Each root gene has a working slider that re-resolves on input (manual code path, build-verified).
- Complexity: medium
- Notes: This is the ONLY task touching genome.js/genomeSchema.js. The main.js/index.html slice here
  is GENE SLIDERS ONLY — the reveal toggle button is Task 5's slice (different DOM region + different
  main.js wiring block), so no file conflict.

### Task 2: Root proportions (pipe-model sizing, NO geotropism)
- OWNS: `src/proportions.js`.
- Implements: replace the isRoot branch (579-582) with a root pipe-model forward pass
  (§1.7): taproot base radius `rootBaseRadius*(1+genome.rootFlare)`, per-level taper from
  `genome.rootTaper`, residual-area split at forks. Keep the bending-pass skip `if (n.isRoot) continue;`
  (681) so NO canopy droop/photo/verticality is applied to roots. Read genome defensively
  (genome may be null → fall back to existing `rootBaseRadius`).
- Depends on: root-node flag contract (§1.2) + roots.js producing isRoot nodes (Task 4) for the
  full integration test, but proportions.js compiles and unit-tests against any graph with isRoot
  nodes (can use a hand-built fixture). Can start immediately.
- Acceptance criteria:
  - [ ] `npm run build` passes; `node --test test/proportions.test.mjs` passes (existing tests green).
  - [ ] Given a graph with a taproot chain (isRoot, parentIdx<own), radii satisfy pipe-model:
        `r_parent² ≈ Σ child r²` at each interior root fork (within tolerance, matching the canopy
        assertion in verify.mjs).
  - [ ] Root base radius increases monotonically with `genome.rootFlare`.
  - [ ] Root tips (childless isRoot nodes) have radius ≤ root parent radius (taper holds; tip-taper floor 0.012 ok).
  - [ ] NO root node position is modified by the bending pass (assert pos before/after bending equal
        for isRoot nodes — proves geotropism stays owned by roots.js).
- Complexity: medium
- Notes: The `parentIdx<ownIndex` and isFrond guards (199-224) already cover root nodes — do not
  weaken them. Watch the children-map (563-572): it already includes root nodes, so the forward
  radius pass naturally orders parents-before-children for roots too.

### Task 3: roots.js generator (the new module) + foliage exclusion regression test
- OWNS: `src/roots.js` (NEW FILE), and ADDS a test in `test/foliage.test.mjs` (foliage owner is
  not otherwise touched in this plan, so adding a test block there is conflict-free).
- Implements the full `growRootSystem` per §1.3-1.6: taproot, N crossfade laterals with downward
  geotropism (bend toward −Y as chains extend — sign INVERTED vs canopy), recursive sub-branching
  with depthFrac crossfade, buttress/flare wings (the only `pos[1]≥0` root nodes), ROOT_BONE_BUDGET
  graceful termination, ROOT_SALT export. ALL randomness from `rootRng`; deterministic curvature
  from sin-hash idiom.
- Depends on: NONE for the module itself (pure, frozen contract). It is the dependency FOR Tasks 1/2/3-test
  integration, so prioritize finishing it. Can start immediately in parallel.
- Acceptance criteria:
  - [ ] `npm run build` passes.
  - [ ] `growRootSystem(graph, genome, rootRng)` appends ≥ 1 taproot chain + `floor(2+rootCount*4)`
        major laterals; returns the same graph object (mutated).
  - [ ] Every appended node has `isRoot===true`, `branchLevel===0`, `rootLevel≥0`, `parentIdx<ownIndex`.
  - [ ] Determinism: two calls with fresh `mulberry32(s ^ ROOT_SALT)` on a fresh graph copy produce
        deep-equal node/bone arrays.
  - [ ] Appended root bones ≤ `ROOT_BONE_BUDGET` for genome extremes × seeds 0..50.
  - [ ] rootCount crossfade: the (floor+1)th lateral's `weight` equals `frac` and its chain length
        scales with `frac`; draw count is identical whether `frac` is 0 or >0.
  - [ ] At least one taproot tip has `pos[1] < 0` (roots dive below ground); buttress nodes (if
        rootButtress>0) have `pos[1] ≥ 0`.
  - [ ] (foliage test) `generateFoliage` produces ZERO clusters whose source segment node `isRoot` —
        assert by reconstructing eligible segments and confirming none are isRoot, for a genome with
        a large root system.
- Complexity: large
- Notes: This is the long pole. Geotropism sign is Risk A — write a focused assertion that lateral
  chain tip Y decreases along the chain. Reuse `rotateAround`/`perpTo`/`buildCurvedChain` patterns
  from skeleton.js (copy the small helpers into roots.js to keep it dependency-free, matching the
  existing per-module-helper convention).

### Task 4: Remove the stub from skeleton.js + wire root removal point
- OWNS: `src/skeleton.js`.
- Implements: DELETE the 3-node root-flare stub block (552-574) so the ONLY source of root nodes is
  roots.js (called from resolve, post-skeleton). `firstTrunkBaseIdx` and `boneCounter` logic stays:
  after removing the stub, `let boneCounter = bones.length;` (576) still works (now counts trunk
  bones only). The BFS SOFT_CEILING comment referencing "Root flare: 3 bones" (78, 444-445) should
  be updated for accuracy (roots are now out-of-band), but the numeric SOFT_CEILING is unchanged.
- Depends on: NONE structurally, BUT this changes skeleton output (removes 3 nodes), so it MUST land
  together with Task 1's resolve() wiring for the app to still show roots. Sequence: Task 4 + Task 1
  resolve()-wiring are the atomic "switchover". Build is green either order; the determinism
  regression (canopy unchanged) only makes sense once roots.js runs in resolve.
- Acceptance criteria:
  - [ ] `npm run build` passes; `node --test test/skeleton.test.mjs` passes EXCEPT the test that
        counts/asserts the 3 stub root nodes — that assertion must be UPDATED (skeleton alone now
        emits zero isRoot nodes). Confirm which skeleton tests reference isRoot and update them to
        assert `nodes.filter(n=>n.isRoot).length === 0` for skeleton-only output.
  - [ ] `buildSkeleton` output has NO `isRoot` nodes.
  - [ ] `bones.length <= MAX_BONES` still holds for seeds 0..200 (existing test green).
  - [ ] Canopy node positions for a fixed (genome, seed) are bit-identical before/after stub removal
        (the stub never affected canopy BFS, since it was appended after trunks and before BFS but
        consumed no rng — verify boneCounter starting value change does not alter SOFT_CEILING math:
        it does NOT, because boneCounter was set to bones.length AFTER the stub either way; removing
        3 stub bones makes boneCounter START 3 lower, giving the BFS 3 MORE bones of headroom →
        THIS COULD CHANGE CANOPY for budget-bound genomes). SEE Risk D — mitigation below.
- Complexity: small (code) / medium (determinism reasoning)
- Notes: Risk D mitigation is owned here — see §4.

### Task 5: Ground reveal toggle (ground.js + viewer.js + UI button)
- OWNS: `src/ground.js`, `src/viewer.js`, and the REVEAL-TOGGLE section of `src/main.js` + `index.html`
  (a new button in/near `#rendermode-panel`, wired in a NEW IIFE block separate from
  `wireRenderModePanel`).
- Implements:
  1. `ground.setRevealed(revealed)` (§1.9).
  2. `viewer.setRootsRevealed(revealed)` on the public return object (after `setRenderMode`, ~730).
  3. Fix ground baseline: replace `ground.setBaseY(g.bounds.min[1])` (578) with `ground.setBaseY(0)`
     (surface plane at trunk-base origin; roots dive below it). Keep the empty-graph fallback.
  4. Fix camera fit (Risk B): when computing `computeFitFromBounds(g.bounds)` (627), pass bounds whose
     `min[1]` is clamped to `Math.max(bounds.min[1], 0)` UNLESS roots are revealed (track a
     `rootsRevealed` flag in the closure; when revealed, use true bounds so roots are framed).
  5. Update shadow camera similarly so shadows still cover the canopy.
  6. UI: add a "Reveal roots" toggle button (data-attr in index.html, near rendermode-panel) and a
     small IIFE in main.js that calls `viewer.setRootsRevealed(state)` and toggles button active class.
- Depends on: viewer/ground public API only (frozen §1.9). roots.js NOT required to compile/build.
  Can start immediately. For meaningful manual verification, needs Tasks 1+3+4 (so roots exist).
- Acceptance criteria:
  - [ ] `npm run build` passes.
  - [ ] `viewer.setRootsRevealed(true)` hides/fades the ground (mesh.visible=false or opacity≈0.15);
        `false` restores it.
  - [ ] Ground sits at y=0 (NOT at bounds.min[1]); does not sink when roots extend below ground
        (code inspection + the fact setBaseY(0) is now constant).
  - [ ] First-plant camera fit frames the canopy (uses clamped bounds when roots hidden) and frames
        roots when revealed (uses true bounds).
  - [ ] `viewer.setRootsRevealed` is present on the returned object (matches the documented factory JSDoc).
- Complexity: medium
- Notes: ground.js + viewer.js are not touched by any other task. The main.js/index.html slice here is
  the toggle button DOM + its own wiring IIFE — disjoint from Task 1's gene-slider DOM region. If both
  Task 1 and Task 5 must edit `index.html`, coordinate by region: Task 1 edits the tab-panels block
  (lines ~420-535), Task 5 edits the rendermode-panel block (~569-617). No overlapping lines.

---

## 3. TEST PLAN

Run via `node --test test/*.mjs test/*.js`. Add new tests in the owning module's test file
(roots → new `test/roots.test.mjs`; foliage exclusion → `test/foliage.test.mjs`;
determinism regression → `test/genome.test.mjs` or new `test/roots-determinism.test.mjs`).

1. **Determinism (deep-equal on repeat)** — `roots.test.mjs`:
   - `growRootSystem` on two fresh graph copies with two fresh `mulberry32(s^ROOT_SALT)` → `assert.deepStrictEqual`.
   - `resolve(genome, env)` twice → deep-equal full output (extends existing resolve determinism).

2. **Invariants**:
   - `parentIdx < ownIndex` for ALL nodes (canopy + roots) across seeds 0..50 × genome extremes.
   - No foliage on roots: every eligible foliage segment has `!node.isRoot` (foliage.test.mjs).
   - Pipe-model radii on roots: `r_parent² ≈ Σ child r²` at root forks (proportions.test.mjs).
   - Bone budget incl. roots: `graph.bones.length ≤ MAX_BONES + ROOT_BONE_BUDGET` across extremes×seeds.
   - rootCount crossfade: fractional lateral weight == frac; identical draw count for frac=0 vs frac>0.
   - skeleton-alone emits zero isRoot nodes (skeleton.test.mjs, updated).

3. **Env-directional**:
   - arid → deeper taproot: build genomes from `randomGenome(aridEnv, seed)` vs `randomGenome(wetEnv, seed)`
     (same seed), resolve both, assert min taproot tip Y (most negative) is LOWER (more negative) for
     arid. Aggregate over seeds 0..20 to avoid single-seed noise (assert mean depth arid < mean depth wet).
   - wind → wider flare: `rootFlare` gene from `randomGenome(windyEnv,...)` > from calm env (mean over seeds).

4. **Regression — existing seeds' canopy + foliage UNCHANGED**:
   - BEFORE landing roots, capture a golden snapshot (commit a small fixture) of, for seeds 0..50:
     (a) the first 23 randomGenome draws / resulting non-root genes + structuralSeed,
     (b) all NON-root `graph.nodes` positions+radii from `resolve()`,
     (c) the foliage SoA `count` + first K position/scale values.
   - AFTER: assert byte-identical for (a), (b filtered to !isRoot), (c). This proves ROOT_SALT
     isolation + draw-order append did not perturb canopy/foliage.
   - PRACTICAL approach (no separate golden file needed): in one test, build the canopy two ways —
     once by calling a helper that runs ONLY buildSkeleton+solveProportions(skip roots)+foliage, and
     once via full `resolve()` then filtering out isRoot nodes — and assert the non-root subsets match.
     This is self-checking and survives in-repo without a frozen blob.

---

## 4. RISKS & MITIGATIONS

**Risk A — Geotropism sign inversion (TRICKIEST).** Roots grow TOWARD gravity (−Y); canopy droop is
anti-gravity/phototropic. Mitigation: geotropism lives ENTIRELY in roots.js geometry (bend each root
chain toward `[0,-1,0]` as it extends — positive bend angle about a horizontal axis rotates the
direction downward). proportions.js MUST keep `if (n.isRoot) continue;` in the bending pass so canopy
droop is NEVER applied to roots (double-bend / wrong-sign bug). Test: assert lateral chain tip Y
monotonically decreases along the chain, and assert proportions does not move isRoot positions.

**Risk B — Ground/camera follow roots underground.** `viewer.js:578` `ground.setBaseY(g.bounds.min[1])`
and `computeFitFromBounds` use bounds that now include below-ground roots → ground sinks, camera zooms
out to frame buried roots. Mitigation (Task 5): pin ground to y=0; clamp `bounds.min[1]` to ≥0 for the
camera fit when roots are hidden; use true bounds only when `setRootsRevealed(true)`. Update shadow
camera the same way.

**Risk C — Bone budget.** DECISION: roots use a SEPARATE `ROOT_BONE_BUDGET` (220), not the canopy
`MAX_BONES` (§1.5). Roots run as a post-pass so they cannot starve the canopy. Total ceiling
`MAX_BONES + ROOT_BONE_BUDGET` is asserted. Watch triangle count in stats (user-verified) — if roots
add too many tris, lower ROOT_BONE_BUDGET or the root radial-seg counts in branchMesh's
`radialSegsFor` (roots are branchLevel 0 → would default to 16 segs; consider passing a custom
`radialSegsFor` that gives roots fewer segments, OR accept 16 since root chains are few).

**Risk D — Stub removal shifts canopy budget (SUBTLE determinism trap).** The stub pushed 3 bones
BEFORE `boneCounter = bones.length` (skeleton.js:576). Removing the stub makes `boneCounter` start 3
LOWER, giving the BFS 3 extra bones of headroom — which CAN change topology for budget-bound genomes
(branchiness≈1). Mitigation (Task 4): after deleting the stub, ensure the canopy BFS sees the SAME
starting budget by either (a) confirming via test that no seed in 0..200 is actually budget-bound at
the stub boundary (3 bones is below typical SOFT_CEILING headroom — likely safe), OR (b) if any seed
differs, subtract a constant 3 from the BFS budget to preserve exact pre-roots canopy. Prefer (a) with
an explicit regression test (§3.4); fall back to (b) only if the test catches a diff. Document the
chosen path in the skeleton.js comment.

**Risk E — Schema iteration side-effects.** `genomeDistance`/`mutate` iterate ALL `FLORA_SCHEMA` keys,
so the 7 new genes change phylogeny distance values and participate in mutation. This is fine (parked
biosphere layer), but note: their tier is `structural` (×3 distance weight). If parked
mutate/dendrogram tests assert specific distance numbers, they may need updating. Mitigation: run the
full suite; update any parked-layer numeric assertions that move (they are not in the active path).

**Risk F — branchMesh root rendering already on.** `viewer.js:524` calls `buildBranchGeometry` with NO
opts → `includeRoot` defaults true, so roots render automatically once they exist. No viewer geometry
change needed for roots to appear (only the reveal toggle + ground/camera fixes). Confirm the merged
geometry's `bounds` now includes roots (it will) — which is exactly why Risk B's camera/ground fix is
required.

---

## 5. SELF-REVIEW NOTES

- File conflicts checked: genome.js/genomeSchema.js → Task 1 only. proportions.js → Task 2 only.
  roots.js → Task 3 only. skeleton.js → Task 4 only. ground.js/viewer.js → Task 5 only.
  main.js/index.html shared by Task 1 (gene sliders, tab-panel region) and Task 5 (reveal button,
  rendermode-panel region) — split by DOM region + separate wiring IIFEs; no overlapping lines.
- Hidden dependency: Task 1's `resolve()` wiring + Task 4's stub removal form the atomic switchover;
  land together. All other tasks build/green independently against the frozen contract.
- Riskiest first: Task 3 (roots.js geotropism) is the long pole and the source of Risk A — start it
  first / give it the strongest engineer. Task 4's Risk D needs the §3.4 regression test as a guard.
