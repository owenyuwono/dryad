# WIND_HIERARCHICAL_PLAN.md — Full Hierarchical (SpeedTree-grade) Tree Wind

> Target: Vite + Three.js **r160** (WebGL2), procedural tree. Replace the single global
> displacement-field wind (`src/windGlsl.js`) with a **hierarchical skeletal wind model**:
> each branch rotates about its own pivot with its own phase, composed down the ancestry
> (trunk → branch → twig follow-through), each leaf rides its attachment branch and adds
> individual flutter/tumble. Trunk/roots rigid; motion is **rotational (bending)**, not
> translational (shearing).
>
> Gates: `npm run build` + `node --test test/*.mjs test/*.js`.
> Rendering is **USER-VERIFIED** — no browser, no Playwright. Reason about shaders from code.

---

## 0. Code-grounding (everything below cites the real source)

- **`src/branchMesh.js`** builds ONE merged static `BufferGeometry`. It already walks the
  graph into **chains** (`chains[]`, `branchMesh.js:299-314`), records the fork-parent of each
  chain start (`parentOfChainStart`, `branchMesh.js:286-294`), computes per-node radius, AO,
  and the per-vertex `windWeight` (`branchMesh.js:421-437`, written per-ring at `:626`,
  apex at `:647`). The mesh is at the world origin with identity modelMatrix — object space
  == world space (asserted in `barkMaterial.js:333-338`). **Chains are the natural bone unit.**
- **`src/barkMaterial.js`** = `MeshStandardMaterial` + `onBeforeCompile`. Vertex hook injects
  `vObjPos = position` (`:313-316`) and the current global wind (`VERTEX_WIND_INJECT`,
  `:333-339`) right after `<begin_vertex>`. Bark albedo/normal/roughness all sample
  **`vObjPos` (rest/object space)** in the fragment (`:373-418`). Stable cache key
  `'bark-wind'` (`:460`). Wind uniforms exposed via `material._windUniforms` (`:474`).
- **`src/leafMesh.js`** = ONE `InstancedMesh` (`MAX_LEAVES=6000`), `MeshStandardMaterial` +
  `onBeforeCompile`. Per-instance `instanceMatrix` (rotation+scale+translation), plus
  instanced attrs `aExposure` (`:453`) and `aCanopyNormal` (`:468`). Reads the leaf world
  anchor from `instanceMatrix[3].xyz` (`:255`). Already has **local-space flutter** at
  `<begin_vertex>` (`:265-269`) and **post-instance primary sway** in view space at
  `<project_vertex>` (`:283-291`). Has a separate `customDepthMaterial` (MeshDepthMaterial,
  `:409-412`) for cutout shadows — that depth material currently does **NOT** run any wind.
- **`src/foliage.js`** produces the leaf SoA. The attachment node of each leaf is `nodeIdx`
  in the `segments` list (`foliage.js:281`), passed into `writeCluster(... node ...)`
  (`:334`, body pass `:427-494`, apical pass `:506-533`). `node` carries `branchLevel`,
  `parentIdx`, `isWoody`, `isTerminal`. The leaf SoA has **no bone index today** — we add one.
- **`src/skeleton.js`** graph: `nodes[]` `{pos,radius,branchLevel,parentIdx,isRoot,isStem,
  isWoody,isTerminal,weight,...}`, `bones[]` `{a,b}` with **`a < b`** (parents precede
  children — `skeleton.js` always pushes child after parent; `roots.js:18` upholds it too).
  `MAX_BONES = 900` (`skeleton.js:339`) — but that is the **bone-budget ceiling on
  branch SEGMENTS (graph bones)**, not chains. `structuralSeed` ∈ uint32 is available for
  deterministic per-bone phase (`genome.js:366`, consumed only via `mulberry32` substreams).
- **`src/viewer.js`** owns the render loop. It already advances `windTime` every frame
  (`:525`), gates strength on `windEnabled` (`:526`), and pushes uniforms to both materials
  via `applyWindUniforms` (`:387-393`, called `:527-528`). It builds the branch geometry in
  `setPlant` (`:565-581`), sets the `windWeight` attribute (`:578`), wires `setWindEnabled`
  (`:812`) / `setWindStrength` (`:827`). **The branch mesh is a plain `THREE.Mesh`** (`:311`)
  with `barkCtl.material`. AABB-fit uses `g.bounds` from branchMesh (`:614-690`).
  `setRootsRevealed` (`:847`) reframes from cached `lastBounds`.
- **`src/renderModes.js`** swaps `branchMesh.material` and `leafMesh.material` per-mesh
  (`:85-271`). It caches the real material objects (`:73-80`) and restores them on `'lit'`.
  **It assumes the mesh OBJECT is stable across `setPlant` and that swapping its `.material`
  is sufficient.** Swapping a SkinnedMesh's material to a non-skinning material (e.g.
  `MeshNormalMaterial` in `'normals'`) silently drops skinning → debug modes would show the
  REST pose, which is acceptable, but the override materials must still accept the skin
  attributes/defines without erroring.
- **`src/main.js`** wires `#wind-toggle-btn` and `#wind-strength-slider` (`main.js:144-162`).
  No change required by this work — the existing toggle/strength API is preserved.
- **Tests**: `test/branchMesh.test.mjs` already asserts determinism, strides, `windWeight ∈
  [0,1]`, `windWeight.length === vertexCount`, connectivity, normals-unit. `test/windGlsl.test.mjs`
  asserts the GLSL string contracts. Our new attributes/data must extend — not break — these.

---

## 1. RECOMMENDED APPROACH

### Decision 1 — composition + skinning approach: **(B) custom bone-matrix DataTexture + skinning injected via `onBeforeCompile`.**

We evaluated three:

| | (A) three `SkinnedMesh`+`Skeleton` | (B) custom bone-matrix DataTexture + onBeforeCompile *(RECOMMENDED)* | (C) in-shader bounded additive ancestry |
|---|---|---|---|
| Bone-matrix composition | three composes via `Bone` parent/child each frame | **we compose top-down in JS each frame** (cheap, exact control) | composed implicitly per-vertex by summing N ancestor rotations |
| High bone counts | three's `boneTexture` path (auto in r160 when bones > limit) | **our own `DataTexture` (RGBA32F), N bones, no uniform-array limit** | bounded to ~3-4 ancestors per vertex (loses deep follow-through) |
| Coexists with bark `onBeforeCompile`? | **RISK**: three injects `<skinning_vertex>`, `<skinbase_vertex>`, `<skinnormal_vertex>`, and a `<begin_vertex>`-adjacent `<skinning_vertex>` chunk. Our bark vertex hook already rewrites `<begin_vertex>`. Two systems both mutating `transformed`/`objectNormal` ordering is the exact class of "compiles, breaks in browser" we must avoid. | **We own the single vertex hook** — skinning math is OUR code placed deterministically relative to `vObjPos = position` and `<project_vertex>`. No interaction with three's skinning chunks (we do NOT set `material.skinning`/use `SkinnedMesh`). | We own the hook, but per-vertex ancestor loop is heavy and caps depth. |
| Bark texture stability | bark samples `vObjPos = position` (rest space) — **safe** if we capture `vObjPos` before skinning | **safe**: we set `vObjPos = position` (rest) and skin a separate `transformed` copy | safe |
| Shadow/depth pass | three auto-skins `MeshDepthMaterial` for SkinnedMesh | **we must inject the SAME skinning into a custom branch depth material** (explicit, but fully in our control) | same |
| Render-mode swap (`renderModes.js`) | SkinnedMesh + `MeshNormalMaterial` works (three skins it) but our cached-material assumptions and `geometry.bindMatrix`/`skeleton` plumbing add surface area | **plain `THREE.Mesh`** stays — `renderModes` swap logic is unchanged; override mats just ignore the skin attrs (rest pose in debug modes, acceptable) | plain Mesh |
| AABB-fit / `setRootsRevealed` | `SkinnedMesh.boundingBox` semantics differ; `computeFitFromBounds` reads `g.bounds` (from branchMesh, rest space) — still fine | **unchanged**: fit reads rest-space `g.bounds`; wind is a small bounded rotation so rest AABB + existing `FIT_MARGIN`(1.25)/`foliageFactor`(1.15) absorb sway | unchanged |

**Why (B):** the single hard constraint in this repo is *"GLSL that passes build+tests but
breaks only in-browser"* (CLAUDE.md, memory). Three's `SkinnedMesh` injects multiple skinning
chunks that **interleave with our existing bark `<begin_vertex>` rewrite** — an untestable,
browser-only interaction. (B) keeps the branch mesh a plain `THREE.Mesh`, gives us **one**
vertex hook we fully control, removes any dependency on three's skinning chunk ordering, keeps
`renderModes.js` / AABB-fit / roots-reveal / the existing wind toggle **untouched**, and uses a
`DataTexture` so bone count is not bounded by uniform-array limits. We pay for it by composing
bone matrices in JS each frame (Decision 4) — but that is ~chain-count (typically low hundreds)
4×4 multiplies, trivially within frame budget and fully Node-testable in isolation.

We do **not** use three's `bindMatrix`/`Skeleton`/`Bone` at all. "Bone" below means **our**
per-chain transform, uploaded as a row in a `DataTexture`.

### Decision 2 — bone granularity: **one bone per CHAIN, with per-vertex *intra-chain fraction*.**

- A "bone" = one chain (a maximal linear run between forks/tips), exactly the `chains[]` that
  `branchMesh.js:299` already computes. Rotation is applied **about the chain's start pivot**
  (the chain's first node `pos`), and the **amount scales by the vertex's normalized arc
  position along the chain** (0 at pivot → 1 at chain end). This makes a straight chain *bend*
  into a smooth arc (natural branch curve) using a single rotation per chain — no per-node bone.
- **Bone count = chain count.** Instrumentation reasoning from the code: chains are created at
  the bone-graph root and at every fork child (`branchMesh.js:262-281`). For the densest genome
  (`bushyGenome`), graph bones peg near `SOFT_CEILING = MAX_BONES − 20 = 880`
  (`skeleton.js:446`, confirmed by the comment at `skeleton.js:558-563`). With `intNodes ∈ [2,3]`
  segments per chain, **chain count ≈ graph-bones / intNodes ≈ 300–450 canopy chains**, plus
  root chains (`ROOT_BONE_BUDGET = 220` → ~70–110 root chains, all rigid). **Upper bound we
  budget for: `MAX_WIND_BONES = 1024`** (power-of-two texture-friendly; comfortably above the
  realistic worst case and verifiable by an instrumentation test, Task 0).
- **Why a DataTexture, not a uniform array:** a `mat4` uniform array of 1024 entries =
  16384 floats — far over the WebGL2 vertex uniform vector ceiling (`MAX_VERTEX_UNIFORM_VECTORS`,
  commonly 1024–4096 vec4). A `DataTexture` of `N×... ` RGBA32F sidesteps the limit entirely and
  is the same technique three uses for its own bone texture. We pack **4 RGBA32F texels per bone**
  (one mat4) → texture width = 4, height = `MAX_WIND_BONES` (or a square `texSize × texSize`
  packing; width-4 keeps addressing trivial). Vertex shader fetches via `texelFetch` (WebGL2).

### Decision 3 — hierarchy & ordering: **bone parent = the chain containing the parent node of this chain's start; trunk chain = root bone; parents always precede children.**

- For chain `c`, its **start node** is `chain[0]` after the fork-parent prepend (`branchMesh.js:303`).
  The chain's **structural attach node** is the fork node `parentOfChainStart[start]`
  (`branchMesh.js:286-294`), or, for the root chain, `-1` (no parent). The **parent bone** is the
  chain that *contains* that fork node. Because chains are emitted in node-index order
  (`chainStarts` collected ascending, `branchMesh.js:278-281`) and `bone.a < bone.b`, a chain's
  parent chain always has a **lower bone index** than the child chain. Task 1 asserts this
  (`parentBone[c] < c` for all non-root chains; root chain's parent = `-1`).
- This guarantees a single **top-down** composition pass in frame order (Decision 4): when we
  reach bone `c`, its parent `parentBone[c]` is already composed.
- The **trunk chain is bone 0** (root, parent `-1`) and carries the primary trunk bend
  amplitude. (Note: trunk/root vertices still get `windWeight≈0` from the existing thinness
  map, so even the root bone's small rotation produces near-zero motion at the base — see
  Decision 8 on how weight folds into per-vertex blend.)

### Decision 4 — per-frame wind solver: **JS, in the viewer render loop, top-down matrix product, deterministic per-bone phase, uploaded to the DataTexture.**

- **Where:** a new pure module `src/windSolver.js` (no three import — Node-testable), driven
  from `viewer.js`'s `frame()` (next to the existing `windTime += dt`, `viewer.js:525`).
- **Per bone, compute a LOCAL rotation** (quaternion or 3×3) about a **horizontal axis
  ⟂ windDir**, by a small angle:
  ```
  angle_c = windStrength
          * stiffness(boneRadius_c, branchLevel_c)        // thick/low-level → ~0
          * ( A1 * sin(t * f1 + phase_c)                   // primary gust
            + A2 * sin(t * f2 + phase_c * 2.17 + 1.3) )    // turbulence (irrational ratio)
  phase_c = hash(structuralSeed, boneIndex_c)              // deterministic, NO new rng draws
  ```
  `stiffness` reuses the **same thinness curve** the mesh already bakes (thick trunk rigid,
  thin twigs flex — `branchMesh.js:421-437`), exposed per-bone (Task 1 emits `boneStiffness`).
  `windDir` is the existing `WIND_DIR_DEFAULT` (`viewer.js:87`). Rotation axis =
  `normalize(cross(up, windDir3))` so the branch **bends downwind** (rotational, not shearing).
- **Compose top-down:** `world_c = world_{parent(c)} · local_c`, where each matrix is a pure
  rotation about the **chain pivot** `pivot_c` expressed as
  `T(pivot_c) · R(axis, angle_c) · T(-pivot_c)`. Root bone's parent is identity. Because
  `parentBone[c] < c` (Decision 3), a single ascending loop suffices.
- **Upload:** write each `world_c` (4×4, column-major) into the bone `DataTexture`
  (`texture.needsUpdate = true` once per frame). Pre-size to `MAX_WIND_BONES`; only the first
  `boneCount` rows are meaningful (rest are identity).
- **Determinism contract:** the solver is a pure function of `(boneData, t, windStrength,
  windDir)`. `t` is wall-clock animation time (NOT generation). `phase_c` derives from
  `structuralSeed` + bone index via an integer hash — **consumes no `mulberry32` draws and does
  not touch any generation rng**. Generation output (geometry, foliage) is **byte-identical** to
  today except for the *added* skin attributes (Task 1) — the existing
  `positions/normals/uvs/ao/indices` arrays are bit-for-bit unchanged (Task 1 acceptance + test).
- **Calm guarantee:** every term multiplies `windStrength`; `windStrength == 0` (wind off, the
  default — `viewer.js:382` `windEnabled=false`) → all `angle_c = 0` → all bone matrices
  identity → mesh renders exactly the rest pose. Same guard the global field had
  (`windGlsl.js:53-58`).

### Decision 5 — leaves follow bones: **each leaf carries a per-instance `aBoneIndex`; the leaf vertex shader samples the SAME bone DataTexture and rides its attachment bone's composed transform, then adds local flutter/tumble.**

- `foliage.js` already knows each leaf's attachment **node** (`nodeIdx`, `foliage.js:281/334`).
  Task 2 maps `nodeIdx → boneIndex` (via the chain table from Task 1, passed into
  `generateFoliage` or applied in a thin post-step) and emits a new SoA field
  `boneIndex: Float32Array(MAX_LEAVES)`.
- `leafMesh.js` adds an instanced attribute `aBoneIndex` (float, 1 comp), like `aExposure`
  (`leafMesh.js:452-454`). In the vertex shader the leaf reads `mat4 bone = fetchBone(aBoneIndex)`
  from the bone texture and applies the bone's **rotation about the bone pivot** to the leaf's
  world anchor + the leaf card, so the leaf moves **identically to the branch tube it sits on**
  (stays attached). Then it adds:
  - the existing **per-leaf flutter** (local-space shimmer, `leafMesh.js:265-269`) — **kept**;
  - a new **tumble** (small per-leaf roll about the leaf tangent, phase from anchor hash) —
    added in local space before instanceMatrix, amplitude ∝ `uWindStrength`.
- **Why same texture (not a second buffer):** one source of truth → leaf and branch agree
  exactly at the attachment point (no drift, no detach). The bone texture is already uploaded
  for the branch; the leaf material just binds the same `THREE.DataTexture` uniform.
- **Attachment math must avoid the current warp trap:** the existing code warns that adding a
  world displacement to the pre-instance `transformed` gets warped by the leaf's instanceMatrix
  rotation/scale (`leafMesh.js:229-234, 270-272`). We follow the SAME proven pattern: apply the
  bone-follow as a **view-space displacement of the world anchor at `<project_vertex>`**
  (mirroring `leafMesh.js:283-291`), computed as `boneRotate(anchor) − anchor` so it is a pure
  world-space delta added with `w=0` — identical treatment to today's primary sway, so leaves
  stay attached and are not warped per-instance.

### Decision 6 — bark texture stability: **bark already samples rest space; we keep `vObjPos = position` (REST) and only skin a COPY of `transformed`.**

- Bark albedo/normal/roughness read `vObjPos` (`barkMaterial.js:373-418`), and `vObjPos` is set
  from `position` (rest) at `barkMaterial.js:313-316`. Task 3 leaves that assignment **before**
  the skinning block, so bark continues to sample the **rest** position → **no texture swim**
  while the mesh skins. The skinning modifies `transformed` only (consumed by `<project_vertex>`),
  never `vObjPos`. This is the single most important shader-stability invariant; Task 3
  acceptance pins it explicitly and a string-order assertion guards it (Task 3 test).

### Decision 7 — shadows: **branch depth pass must skin with the SAME bone math; leaf custom depth material must apply bone-follow + flutter.**

- Because we do NOT use `SkinnedMesh`, three will **not** auto-skin any depth material. The
  branch mesh currently uses three's default depth material (no custom one — `viewer.js:312`
  just sets `castShadow`). Task 3 adds a **custom branch depth/distance material**
  (`MeshDepthMaterial` with `onBeforeCompile`) that runs the **identical** vertex skinning
  injection (shared GLSL string from `windSkinGlsl.js`, Task 0) so the shadow silhouette tracks
  the swaying branch. Assigned via `branchMesh.customDepthMaterial`.
- The leaf already has `customDepthMaterial` (`leafMesh.js:409-412`). Task 2 injects the SAME
  bone-follow (and ideally flutter) into it via `onBeforeCompile` so leaf shadows track sway and
  do not detach from their (also-swaying) branch shadows.
- **Risk flagged (browser-only):** depth materials use a different chunk set
  (`<begin_vertex>`/`<project_vertex>` exist, but no lighting). We reuse the same string and the
  same injection tokens; Task 6 (build gate) + reasoning verify token presence, but final shadow
  correctness is USER-VERIFIED.

### Decision 8 — retire/repurpose the global field + `windWeight`:

- **REMOVE** from the active path: `WIND_FUNCTION_GLSL` (global `windOffset`) usage in
  `barkMaterial.js` (`VERTEX_WIND_INJECT`, `:333-339`) — replaced by skinning.
- **KEEP** `windWeight` **as data**, but **repurpose** it: the per-vertex thinness weight
  (`branchMesh.js:421-437`) is still useful as the **per-vertex blend factor** between rest and
  skinned position (`transformed = mix(rest, skinned, windWeight)`), so the trunk base stays
  pinned even though its (low-level) bone has a tiny rotation. We do **not** delete the attribute
  or its computation (tests at `branchMesh.test.mjs:344-358` keep passing).
- **KEEP** leaf **flutter** (`leafMesh.js:265-269`) and **ADD tumble** (Decision 5). The leaf's
  old global `windOffset` *primary sway* (`leafMesh.js:283-291`) is **replaced** by bone-follow.
- **`src/windGlsl.js`**: keep the file (still imported by `windGlsl.test.mjs` and possibly the
  parked path). It MAY be trimmed to just the uniform decls/defaults (`uTime`, `uWindStrength`,
  `uWindDir`), but to avoid breaking `windGlsl.test.mjs` we **leave `WIND_FUNCTION_GLSL`
  exported and intact** (dead but harmless) and simply stop injecting it into the branch/leaf
  primary path. Net: zero churn to `windGlsl.test.mjs`. New skin GLSL lives in a new
  `src/windSkinGlsl.js` (Task 0).

---

## 2. FROZEN INTERFACES

### 2.1 `branchMesh.js` — added per-vertex skin attributes + bone tables (Task 1)

`buildBranchGeometry(graph, opts)` return object gains:

```
// Per-vertex (length === vertexCount), appended to existing return:
boneIndex:     Float32Array(V)   // which wind-bone (chain) this vertex belongs to; 0..boneCount-1
boneFraction:  Float32Array(V)   // normalized arc position along its chain [0,1]: 0=pivot, 1=chain end
//   (windWeight stays as-is — now the rest↔skinned blend factor, Decision 8)

// Bone tables (length === boneCount; the wind-bone hierarchy):
bones_wind: {
  count:        number,                 // number of wind bones (chains), <= MAX_WIND_BONES
  parent:       Int32Array(count),      // parent wind-bone index, or -1 for the root (trunk) chain
  pivot:        Float32Array(3*count),  // chain-start world position (rotation pivot)
  axisHint:     Float32Array(3*count),  // unit chain-start tangent (for optional per-bone axis shaping; solver may ignore)
  stiffness:    Float32Array(count),    // [0,1]: 0 = rigid (trunk/root), 1 = max flex — derived from chain mean thinness & branchLevel
  branchLevel:  Int32Array(count),      // chain's branchLevel (== nodes[chain[0]].branchLevel)
  isRigid:      Uint8Array(count),      // 1 if this chain is trunk/root (force angle 0); else 0
}
```

Constraints (Task 1 acceptance):
- `boneIndex[v] ∈ [0, count)` for **every** vertex (no -1, no out-of-range).
- `boneFraction[v] ∈ [0,1]`.
- `parent[c] < c` for all `c` with `parent[c] !== -1`; exactly one `c` has `parent[c] === -1`
  (the trunk/root chain), and that chain has `branchLevel === 0`.
- `count <= MAX_WIND_BONES` (1024). Export `MAX_WIND_BONES` from `branchMesh.js` (or a shared
  const module) so viewer/tests reference it.
- **Existing arrays unchanged:** `positions/normals/uvs/ao/windWeight/indices/vertexCount/
  triangleCount/bounds` are byte-identical to the pre-change output for any given graph
  (regression-pinned in Task 1 test against a captured baseline).
- Determinism: pure function of `graph`; two calls → byte-identical including new arrays.
- Root chains (`nodes[chain[0]].isRoot`) get `isRigid = 1`, `stiffness = 0`.

### 2.2 `src/windSkinGlsl.js` — shared GLSL (Task 0, NEW, dependency-free)

```
export const WIND_BONE_UNIFORM_DECLS;   // 'uniform sampler2D uBoneTex; uniform float uBoneCount; uniform float uWindStrength; ...'
export const WIND_BONE_FETCH_GLSL;       // 'mat4 fetchBone(float idx){ ... texelFetch 4 RGBA32F texels ... }'
export const WIND_SKIN_VERTEX_GLSL;      // applies bone rot about pivot to a position, returns skinned pos
export const WIND_LEAF_FOLLOW_GLSL;      // helper: world-space delta = boneRotate(anchor)-anchor  (for view-space add)
export const WIND_BONE_UNIFORM_DEFAULTS; // { uBoneCount:0, uWindStrength:0 }  (no THREE types — Node-testable)
export const WIND_TEX_WIDTH = 4;         // RGBA32F texels per bone (one mat4)
```

Frozen GLSL contracts (asserted by a `windSkinGlsl.test.mjs`, mirroring `windGlsl.test.mjs`):
- `WIND_SKIN_VERTEX_GLSL` defines a function with signature
  `vec3 windSkinPosition(vec3 restPos, float boneIdx, float boneFraction, float windWeight)`.
- balanced braces; references `uWindStrength` (calm ⇒ identity); references `uBoneTex`.
- `fetchBone` uses `texelFetch` (WebGL2) — no `texture2D`/manual filtering.

### 2.3 `src/windSolver.js` — per-frame solver (Task 4, NEW, dependency-free)

```
// Pure, no three import. Operates on plain Float32Array IO so it is Node-testable
// AND directly usable by viewer (which writes the result into a THREE.DataTexture).

createWindSolver(bones_wind) -> {
  boneCount: number,
  // Writes one mat4 (16 floats, column-major) per bone into `out` (Float32Array(16*boneCount)),
  // composing top-down. Pure function of (out, time, windStrength, windDirX, windDirZ).
  solve(out, time, windStrength, windDirX, windDirZ): void,
}
```

Frozen behavior:
- `windStrength === 0` ⇒ every bone matrix is the identity (calm == rest).
- Deterministic: same `(bones_wind, time, strength, dir)` ⇒ identical `out` bytes.
- `phase_c = hashPhase(structuralSeed, c)` — but `windSolver` must NOT need the rng; it takes
  `bones_wind` which already carries everything. Phase is derived from the bone **index** plus
  an optional `seed` field on `bones_wind` (pass `genome.structuralSeed` through `buildBranchGeometry`
  opts, or hash from `pivot`+index). **Chosen:** hash from `(c, pivot_c)` only — no seed plumbing
  needed, still deterministic and per-organism-distinct because pivots differ per organism.
- `out` row `c` composed as `parent[c]>=0 ? mul(out[parent], local_c) : local_c`.

### 2.4 `viewer.js` — wiring (Task 5)

- Build solver from `g.bones_wind` in `setPlant` after geometry build (`viewer.js:565`).
- Allocate/resize a `THREE.DataTexture(boneMatrixFloats, WIND_TEX_WIDTH, boneCount, RGBAFormat,
  FloatType)` once per `setPlant` (dispose previous); set `.needsUpdate` each frame after solve.
- Pass the DataTexture + `uBoneCount` into both `barkCtl.material._windUniforms` and
  `leafCtl` material via the existing `applyWindUniforms` path (extended).
- In `frame()` (`viewer.js:504-542`): `solver.solve(boneFloats, windTime, activeStrength,
  dirX, dirZ); boneTex.needsUpdate = true;` — keep the existing `windTime += dt` and the
  `activeStrength = windEnabled ? windStrength : 0` guard (`viewer.js:525-526`).
- `setWindEnabled`/`setWindStrength` (`viewer.js:812/827`) unchanged in signature; they keep
  setting strength, which the solver reads → off path = identity matrices = rest pose.
- **No change** to AABB-fit (`computeFitFromBounds` still uses rest-space `g.bounds`),
  `setRootsRevealed`, render-mode controller wiring, or `main.js`.

### 2.5 `foliage.js` → `leafMesh.js` — leaf bone contract (Task 2)

- `generateFoliage(graph, genome, opts?)` gains an OPTIONAL `opts.nodeToBone: Int32Array`
  (node index → wind-bone index, length `nodes.length`, `-1` if node has no bone). When present,
  the SoA gains `boneIndex: Float32Array(MAX_LEAVES)` written in `writeCluster` from the
  attachment `node`'s index. When **absent**, `boneIndex` defaults to `0` (so existing foliage
  tests that call `generateFoliage(graph, genome)` keep passing and remain deterministic).
- The leaf SoA new field:
  ```
  boneIndex: Float32Array(MAX_LEAVES)  // wind-bone index of each leaf's attachment branch; default 0
  ```
- `leafMesh.update(instanceSet)` reads `instanceSet.boneIndex ?? null`; writes per-instance
  `aBoneIndex` InstancedBufferAttribute (default 0.0 when null — backward compatible, like
  `exposure`/`aExposure` at `leafMesh.js:519-521,588-589`).
- **Determinism preserved:** the `nodeToBone` map is a pure function of the graph (built by
  Task 1's chain assignment); applying it consumes **no rng draws** and does not reorder the
  `segments` loop — foliage rng draw order is untouched (`foliage.test.mjs` determinism passes).

### 2.6 Shader injection points (exact tokens, r160)

Branch (`barkMaterial.js`, Task 3):
- vertex pars: prepend `WIND_BONE_UNIFORM_DECLS + WIND_BONE_FETCH_GLSL + WIND_SKIN_VERTEX_GLSL`
  and `attribute float boneIndex; attribute float boneFraction;` (replace the old
  `WIND_UNIFORM_DECLS + WIND_FUNCTION_GLSL` prepend at `barkMaterial.js:479`).
- after `#include <begin_vertex>`: keep `vObjPos = position; vAo = ao;` (rest, FIRST), THEN
  replace `VERTEX_WIND_INJECT` with:
  ```
  { transformed = windSkinPosition(position, boneIndex, boneFraction, windWeight); }
  ```
  (still before `<project_vertex>`, which consumes `transformed`).
- bump `customProgramCacheKey` from `'bark-wind'` → `'bark-windskin'` (`barkMaterial.js:460`)
  so the new variant is not served a stale cached program.

Leaf (`leafMesh.js`, Task 2):
- before `#include <common>` (vertex): add `attribute float aBoneIndex;` and prepend
  `WIND_BONE_UNIFORM_DECLS + WIND_BONE_FETCH_GLSL + WIND_LEAF_FOLLOW_GLSL` (replacing the old
  `WIND_UNIFORM_DECLS + WIND_FUNCTION_GLSL` at `leafMesh.js:206`).
- at `<begin_vertex>`: keep flutter (`leafMesh.js:265-269`); add **tumble**.
- at `<project_vertex>`: replace the primary-sway line (`leafMesh.js:288`) with the
  bone-follow view-space delta:
  ```
  vec3 followDelta = windBoneFollowDelta(leafWorldAnchor, aBoneIndex);  // world-space
  gl_Position = projectionMatrix * (mvPosition + viewMatrix * vec4(followDelta, 0.0));
  ```

Branch depth material (`barkMaterial.js` new export or `viewer.js`, Task 3): same vertex skin
injection into a `MeshDepthMaterial.onBeforeCompile` (tokens `<begin_vertex>`, `<project_vertex>`).

### 2.7 Determinism contract (single statement)

> Generation (`buildSkeleton`/`solveProportions`/`generateFoliage`/`buildBranchGeometry`) remains
> a pure function of `(genome, env)` / `(graph)`. The ONLY additions are **new** output arrays
> (`boneIndex`, `boneFraction`, `bones_wind`, leaf `boneIndex`); all pre-existing arrays are
> **byte-identical** to before. No `mulberry32` draw count or order changes anywhere. Wind motion
> is a pure function of wall-clock `time` + `windStrength` + `windDir`, computed at render time,
> consuming **no** generation rng. `windStrength == 0` ⇒ exact rest pose.

---

## 3. TASK BREAKDOWN (parallelizable; disjoint files where possible)

```
Dependency graph:
  Task 0 (windSkinGlsl) ──┐
                          ├─> Task 3 (bark skin)   ─┐
  Task 1 (branchMesh) ────┼─> Task 2 (foliage+leaf)─┼─> Task 5 (viewer wiring) ─> Task 6 (build gate / e2e)
                          └─> Task 4 (windSolver)  ─┘
  Task 1 also feeds Task 5 (bone tables) and Task 4 (bones_wind shape).
```

Tasks **0, 1** can start immediately and in parallel (disjoint files). **3, 4** depend on 0+1.
**2** depends on 0+1. **5** integrates 1–4. **6** is the final gate.

---

### Task 0 — `src/windSkinGlsl.js` (NEW) + `test/windSkinGlsl.test.mjs` (NEW)
- **Files owned:** `src/windSkinGlsl.js`, `test/windSkinGlsl.test.mjs`.
- **Implements:** the frozen GLSL strings & defaults in §2.2. `fetchBone` (texelFetch, 4
  RGBA32F texels → mat4), `windSkinPosition(restPos, boneIdx, boneFraction, windWeight)`
  (fetch bone matrix, rotate `restPos` about bone pivot scaled by `boneFraction`, then
  `mix(restPos, skinned, windWeight)`), `windBoneFollowDelta(anchor, boneIdx)` for leaves.
  Dependency-free (no THREE).
- **Depends on:** none.
- **Acceptance:**
  - [ ] Exports `WIND_BONE_UNIFORM_DECLS`, `WIND_BONE_FETCH_GLSL`, `WIND_SKIN_VERTEX_GLSL`,
        `WIND_LEAF_FOLLOW_GLSL`, `WIND_BONE_UNIFORM_DEFAULTS`, `WIND_TEX_WIDTH`.
  - [ ] `WIND_SKIN_VERTEX_GLSL` contains `vec3 windSkinPosition(` with the frozen signature.
  - [ ] All GLSL strings have balanced `{}` (mirror `windGlsl.test.mjs:72-76`).
  - [ ] references `uWindStrength`, `uBoneTex`, `texelFetch`.
  - [ ] `WIND_BONE_UNIFORM_DEFAULTS` is a plain object, no THREE objects (mirror
        `windGlsl.test.mjs:101-109`).
- **Complexity:** medium.
- **Notes:** This is the highest browser-only-risk artifact. Keep math minimal and explicit;
  document the texel layout (row `c`, texels 0..3 = mat4 columns). Pivot is applied as
  `R*(restPos - pivot) + pivot` where `R` is the bone's *composed* rotation extracted from the
  uploaded mat4 (the mat4 IS `T(pivot)·R·T(-pivot)` already composed by the solver, so the shader
  just does `boneMat * vec4(restPos,1)` then `mix` by `windWeight`; `boneFraction` is folded by
  the **solver** OR the shader — DECIDE: fold `boneFraction` in the shader by slerp/scaling the
  rotation per vertex is expensive; instead the solver bakes the *full* chain-end rotation and the
  shader scales displacement by `boneFraction` linearly: `skinned = restPos + boneFraction *
  (boneMat*restPos - restPos)`. This is the SpeedTree "amount grows along the chain" trick and
  keeps the shader cheap. Document this clearly.)

### Task 1 — `src/branchMesh.js` (MODIFY) + `test/branchMesh.test.mjs` (EXTEND)
- **Files owned:** `src/branchMesh.js`, `test/branchMesh.test.mjs`.
- **Implements:** assign a wind-bone index per chain; emit per-vertex `boneIndex` +
  `boneFraction`; build the `bones_wind` tables (§2.1); export `MAX_WIND_BONES`. Reuse the
  EXISTING chain walk (`:299-314`), `parentOfChainStart` (`:286-294`), and the thinness map
  (`:421-437`) for `stiffness`. Set `boneFraction` from accumulated arc length / chain total
  (the code already accumulates `arcLen` at `:622-623`; normalize per chain). Root chains:
  `isRigid=1, stiffness=0`.
- **Depends on:** none (pure data; GLSL not needed here).
- **Acceptance:**
  - [ ] Every vertex has `boneIndex ∈ [0, bones_wind.count)` and `boneFraction ∈ [0,1]`.
  - [ ] `bones_wind.parent[c] < c` for non-root; exactly one root with `parent===-1` and
        `branchLevel===0`.
  - [ ] `bones_wind.count <= MAX_WIND_BONES`.
  - [ ] **Regression:** `positions/normals/uvs/ao/windWeight/indices/vertexCount/triangleCount/
        bounds` are byte-identical to a captured baseline for bushy/tree/sparse × seeds 0..10.
  - [ ] Determinism: two calls → byte-identical including the new arrays/tables.
  - [ ] Existing `branchMesh.test.mjs` suite still passes unchanged.
  - [ ] Instrumentation sub-test: across bushy×seeds 0..50, `bones_wind.count` stays
        `<= MAX_WIND_BONES` (proves the budget; this is the "instrument chain count" ask).
- **Complexity:** large.
- **Notes:** Build a `nodeToBone: Int32Array(nodes.length)` as a byproduct and **return it**
  (Task 2 needs it). A node may appear in two chains only via the fork-parent prepend
  (`:303`) — assign a leaf's node to the chain where it is a *non-prepended* member (its own
  chain), i.e. map by the chain that *starts at or contains* the node as a real segment, not the
  bridging copy. Document the tie-break.

### Task 2 — `src/foliage.js` (MODIFY) + `src/leafMesh.js` (MODIFY) + tests (EXTEND)
- **Files owned:** `src/foliage.js`, `src/leafMesh.js`, `test/foliage.test.mjs`.
- **Implements:**
  - foliage: optional `opts.nodeToBone`; emit `boneIndex` SoA (default 0 when absent).
  - leafMesh: `aBoneIndex` instanced attribute; swap the vertex pars import to
    `windSkinGlsl` (Task 0); keep flutter, add tumble; replace primary-sway with
    `windBoneFollowDelta` view-space add (§2.6); inject the same bone-follow into the
    leaf `customDepthMaterial.onBeforeCompile` for shadow sync.
- **Depends on:** Task 0 (GLSL), Task 1 (`nodeToBone` shape + bone-tex contract).
- **Acceptance:**
  - [ ] `generateFoliage(graph, genome)` (no opts) still returns deterministic, byte-identical
        SoA for the existing fields (foliage determinism test passes); `boneIndex` defaults to 0.
  - [ ] `generateFoliage(graph, genome, { nodeToBone })`: every active leaf's `boneIndex` equals
        `nodeToBone[attachmentNodeIdx]` and is `>= 0` (valid bone) for all `count` leaves.
  - [ ] `leafMesh.update` writes `aBoneIndex` and `needsUpdate`s it; default 0 when SoA lacks it.
  - [ ] `npm run build` compiles (shader injection tokens present).
- **Complexity:** medium.
- **Notes:** Do NOT change the `segments` collection or rng draw order in `foliage.js`
  (`:273-282`, `:334-416`). Tumble amplitude must be `∝ uWindStrength` so calm = no motion.
  Leaf depth material currently has no wind — adding bone-follow there is the shadow-sync fix
  (Decision 7); flag as browser-verified.

### Task 3 — `src/barkMaterial.js` (MODIFY) + branch custom depth material
- **Files owned:** `src/barkMaterial.js`.
- **Implements:** replace global-wind vertex injection with the Task-0 skin injection
  (§2.6); keep `vObjPos = position` (rest) BEFORE skinning (Decision 6); bump cache key to
  `'bark-windskin'`; add `material._windUniforms` entries for `uBoneTex`/`uBoneCount`; export a
  **branch depth material factory** (or augment `createBarkMaterial` to also return a
  `depthMaterial` that runs the same skin injection) for `viewer.js` to assign to
  `branchMesh.customDepthMaterial` (Decision 7).
- **Depends on:** Task 0.
- **Acceptance:**
  - [ ] Fragment bark math still reads `vObjPos` (rest) — assert injection order: `vObjPos =
        position` appears in the string BEFORE the `windSkinPosition` call (string-order test
        in a new/extended bark unit check, OR reasoned + build gate since bark is render-only).
  - [ ] Vertex shader no longer references the global `windOffset`; uses `windSkinPosition`.
  - [ ] `material._windUniforms` exposes `uTime`?/`uWindStrength`/`uWindDir`/`uBoneTex`/`uBoneCount`
        (whatever the solver/viewer needs).
  - [ ] `npm run build` compiles.
- **Complexity:** medium.
- **Notes:** `barkMaterial.js` is render-only (not Node-unit-tested per CLAUDE.md). The build is
  the compile gate; correctness is USER-VERIFIED. The bark-swim invariant (Decision 6) is the
  one thing to get exactly right — pin the injection ordering.

### Task 4 — `src/windSolver.js` (NEW) + `test/windSolver.test.mjs` (NEW)
- **Files owned:** `src/windSolver.js`, `test/windSolver.test.mjs`.
- **Implements:** `createWindSolver(bones_wind)` + `solve(out, time, strength, dirX, dirZ)`
  (§2.3): per-bone local rotation (angle from time+phase+stiffness+strength, axis ⟂ windDir),
  top-down composition into `out` (mat4 per bone, column-major), pivot baked as
  `T(pivot)·R·T(-pivot)`. Pure, no THREE.
- **Depends on:** Task 1 (the `bones_wind` shape).
- **Acceptance:**
  - [ ] `strength === 0` ⇒ all `out` matrices are identity (deep-equal to identity rows).
  - [ ] Determinism: same args ⇒ byte-identical `out`.
  - [ ] Composition: a child bone's matrix equals `parentMat · localMat` (assert on a
        hand-built 3-bone chain: root→mid→tip).
  - [ ] Rigid bones (`isRigid===1`) contribute identity local rotation regardless of strength.
  - [ ] No NaN/Inf across a battery of (time, strength, dir) and a synthetic `bones_wind`.
- **Complexity:** medium.
- **Notes:** Use a stable integer/sin hash for `phase_c` from `(c, pivot)` — document it; it must
  not depend on `Math.random`. Keep `out` preallocated by the caller (viewer reuses the backing
  Float32Array of the DataTexture).

### Task 5 — `src/viewer.js` (MODIFY)
- **Files owned:** `src/viewer.js`.
- **Implements:** build `DataTexture` (size `WIND_TEX_WIDTH × boneCount`, RGBA32F) + solver in
  `setPlant` from `g.bones_wind` (dispose previous on regenerate); set the new branch
  attributes `boneIndex`/`boneFraction` on `branchGeometry` (next to `windWeight` at
  `viewer.js:578`); pass `nodeToBone` (from `g`) into `generateFoliage`? — NOTE foliage is
  produced in `resolve()` (`genome.js:458`), NOT in viewer. **Decision:** viewer cannot inject
  `nodeToBone` into `resolve`'s foliage. Two clean options:
  - (5a, RECOMMENDED) viewer maps `resolved.foliage` leaf `boneIndex` itself: after building
    geometry it has `g.nodeToBone` and `resolved.foliage` (which we extend in Task 2 to also keep
    each leaf's attachment node index, OR derive bone from world position). **Cleanest:** Task 1
    returns `nodeToBone`; Task 2 has `foliage` carry the attachment `nodeIdx` per leaf
    (`foliage.js` already has it at write time — emit `attachNode: Float32Array`), and viewer
    fills `boneIndex[i] = nodeToBone[attachNode[i]]` before `leaves.update(...)`. This keeps
    `resolve()`/determinism untouched and the leaf→bone join in the render layer where the bone
    table lives.
  - (5b) thread `nodeToBone` through `resolve` opts — rejected: pollutes the pure pipeline.
  Wire solver into `frame()` (solve + `boneTex.needsUpdate`); extend `applyWindUniforms` to set
  `uBoneTex`/`uBoneCount` on both materials; assign branch `customDepthMaterial` (Task 3).
- **Depends on:** Tasks 1, 2, 3, 4.
- **Acceptance:**
  - [ ] `setPlant` sets `boneIndex`/`boneFraction` branch attributes and builds the bone texture;
        regenerate disposes the previous texture (no leak — mirror `branchGeometry.dispose()`
        pattern `viewer.js:568`).
  - [ ] `frame()` solves + uploads only when needed; `windEnabled=false` ⇒ identity ⇒ rest pose.
  - [ ] `setWindEnabled`/`setWindStrength` still work via the existing strength path.
  - [ ] render-mode swap, AABB-fit, `setRootsRevealed` behave exactly as before (branch mesh is
        still a plain `THREE.Mesh`; bone attrs are inert in override materials).
  - [ ] `npm run build` compiles.
- **Complexity:** large.
- **Notes:** Choose **5a**. Confirm `THREE.DataTexture` with `FloatType`/`RGBAFormat` is
  filterable as `NearestFilter` (we `texelFetch`, so no filtering needed). One texture shared by
  bark + leaf materials (same uniform object).

### Task 6 — Build + full-suite gate (no new files)
- **Files owned:** none (runs gates, reports).
- **Implements:** run `npm run build` and `node --test test/*.mjs test/*.js`; confirm green.
- **Depends on:** Tasks 1–5.
- **Acceptance:**
  - [ ] `npm run build` succeeds.
  - [ ] Full `node --test` suite passes (incl. new windSkinGlsl/windSolver tests and extended
        branchMesh/foliage tests).
- **Complexity:** small.

#### File-ownership table (no two tasks edit the same file)

| Task | Files (owned) |
|------|---------------|
| 0 | `src/windSkinGlsl.js`, `test/windSkinGlsl.test.mjs` |
| 1 | `src/branchMesh.js`, `test/branchMesh.test.mjs` |
| 2 | `src/foliage.js`, `src/leafMesh.js`, `test/foliage.test.mjs` |
| 3 | `src/barkMaterial.js` |
| 4 | `src/windSolver.js`, `test/windSolver.test.mjs` |
| 5 | `src/viewer.js` |
| 6 | (gates only) |

`src/windGlsl.js` and `test/windGlsl.test.mjs` are intentionally **untouched** (Decision 8).

---

## 4. TEST PLAN

Pure-module unit tests (`node:test`, the repo convention — assert determinism via deep-equal on
repeat, invariants, directional behavior):

1. **Determinism (deep-equal):**
   - `branchMesh`: two calls on the same graph ⇒ byte-identical `boneIndex/boneFraction` +
     `bones_wind` tables (extend `branchMesh.test.mjs:303`).
   - `windSolver`: same `(bones,time,strength,dir)` ⇒ identical `out`.
   - `foliage`: `generateFoliage(graph,genome)` unchanged byte-identical (existing test);
     with `nodeToBone`, `boneIndex` is a deterministic function of the graph.
2. **Bone-data invariants (branchMesh):** `boneIndex ∈ [0,count)`, `boneFraction ∈ [0,1]`,
   `parent[c] < c`, single root with `branchLevel 0`, `count <= MAX_WIND_BONES`.
3. **Every vertex has a valid bone:** assert no `boneIndex` is `-1` / `>= count` /NaN, across
   bushy/tree/sparse × seeds 0..50.
4. **Hierarchy parent<child ordering:** `parent[c] < c` for all non-root bones (top-down
   composition precondition); cross-check with composition test in `windSolver`.
5. **Existing-seed geometry unchanged:** capture a baseline of
   `positions/normals/uvs/ao/windWeight/indices` for a fixed genome battery × seeds, assert
   byte-identical after the change (regression guard — the load-bearing determinism contract).
6. **Leaf→bone mapping valid:** for `generateFoliage(graph,genome,{nodeToBone})`, every leaf in
   `[0,count)` has `boneIndex === nodeToBone[its attachment node]` and `>= 0`.
7. **Calm == rest:** `windSolver.solve(out, t, 0, ...)` ⇒ identity matrices for all `t`
   (mirrors the `uWindStrength==0` guarantee).
8. **GLSL string contracts:** `windSkinGlsl.test.mjs` (signature, balanced braces, texelFetch,
   `uWindStrength`/`uBoneTex` references) — mirrors `windGlsl.test.mjs`.

**Build gate:** `npm run build` (the compile check for all shader injections — bark, leaf, depth
materials — since those are render-only and not Node-unit-tested).

**Out of scope for automated tests (USER-VERIFIED, per CLAUDE.md):** actual sway look, bark
no-swim, leaf-stays-attached, shadow sway, perf — reasoned from code + build gate; user runs
`npm run dev`.

---

## 5. RISKS & MITIGATIONS

- **[HIGH — browser-only] Shader-chunk interaction.** This repo has *repeatedly shipped GLSL
  that passed build+tests but broke only in-browser* (CLAUDE.md). Every `onBeforeCompile`
  injection here is high-risk:
  - *Bark* vertex hook now does skinning + must keep `vObjPos=position` first (Decision 6). Mit:
    one injection block, explicit ordering, string-order assertion, cache-key bump
    (`'bark-windskin'`) to avoid stale programs.
  - *Leaf* hook mixes flutter (begin_vertex) + bone-follow (project_vertex, view space) — the
    existing warp trap (`leafMesh.js:229-234`) is real; we reuse the proven view-space pattern.
  - *Depth materials* (branch new, leaf existing) use a different chunk set; same string reused.
  - Mit overall: shared GLSL in ONE module (`windSkinGlsl.js`) so bark/leaf/depth can't diverge;
    `WIND_TEX_WIDTH`/layout documented once; USER verifies in browser.
- **[MED] Bone count vs GPU limits.** Uniform-array `mat4[1024]` would blow
  `MAX_VERTEX_UNIFORM_VECTORS`. Mit: `DataTexture` + `texelFetch` (WebGL2 guaranteed in this
  stack), `MAX_WIND_BONES=1024` budget, Task-1 instrumentation test proves real chain counts stay
  well under it. `texelFetch` needs WebGL2 — the project IS WebGL2 (CLAUDE.md), and `MeshStandard`
  + `THREE.WebGLRenderer` default is WebGL2 in r160.
- **[MED] Leaf stays attached.** Leaf must move IDENTICALLY to its branch at the attach point.
  Mit: leaf samples the SAME bone texture and applies the SAME pivot rotation as the branch
  vertex at `boneFraction≈1` (twig tip) → matched motion; view-space add (not pre-instance) avoids
  per-instance warp. USER-verified.
- **[MED] Bark-texture swim.** Mit: Decision 6 — bark fragment samples rest `vObjPos`; skinning
  only touches `transformed`. String-order pinned.
- **[MED] Shadow skinning.** No `SkinnedMesh` ⇒ no auto-skinned depth. Mit: explicit custom depth
  materials for branch (Task 3) and leaf (Task 2) running the same skin GLSL. USER-verified shadows.
- **[LOW-MED] Per-frame solver perf.** ~300–450 canopy chains × (1 sin eval + 1 mat4 mul) per
  frame in JS + one `DataTexture` upload. Trivial vs the existing per-frame leaf `update` cost
  (which rebuilds up to 6000 instance matrices, `leafMesh.js:543-609`). Mit: preallocate `out`
  (= the DataTexture backing array), no per-frame allocation; only upload when wind enabled.
- **[LOW] SkinnedMesh would break render-mode/AABB/roots-reveal/wind-toggle.** Avoided entirely by
  choosing (B): branch stays a plain `THREE.Mesh`. `renderModes.js` swap logic, `computeFitFromBounds`
  (rest-space `g.bounds`), `setRootsRevealed`, and `setWindEnabled/Strength` are all unchanged.
  The only behavioral nuance: debug render modes (`normals`/`wireframe`/`ao`/`unlit`) show the
  **rest pose** (their materials don't skin). Acceptable — they are static-inspection modes.
- **[LOW] `windWeight` repurposing.** Kept as data + tests; now also the rest↔skinned blend.
  Trunk base stays pinned because its (root/level-0) bone is `isRigid` AND its `windWeight≈0`.
- **[LOW] `MAX_BONES` (900) vs `MAX_WIND_BONES` (1024) confusion.** They are different axes
  (graph *segments* vs wind *chains*). Documented; `MAX_WIND_BONES` is the wind-only budget.

---

## 6. OPEN ASSUMPTIONS / QUESTIONS

- **A1 (assumed):** WebGL2 + `texelFetch` is available (CLAUDE.md says WebGL2). If a WebGL1
  fallback were ever needed, the bone texture path would need a `texture2D`+manual-addressing
  variant — out of scope, flagged.
- **A2 (assumed):** Render-mode debug views showing the **rest** pose (no sway) is acceptable.
  If live sway is required in `normals`/`wireframe`/`ao`, those override materials in
  `renderModes.js` would each need the skin injection too — a follow-up, not in this plan.
- **A3 (decided 5a):** leaf→bone mapping is applied in the **viewer** (render layer), not in
  `resolve()`, to keep the pure generation pipeline and its determinism untouched. Foliage emits
  the attachment node index per leaf; viewer joins it against `g.nodeToBone`.
- **A4 (decided):** `boneFraction` scales the **displacement linearly** in the shader (cheap,
  SpeedTree-style "grows along the chain"); the solver bakes the full chain rotation. If a true
  per-vertex rotation is later desired, the solver could emit per-segment matrices (more bones)
  — deferred.
