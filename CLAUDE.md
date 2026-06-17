# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser prototype that **procedurally generates flora** (currently focused on a single, increasingly photoreal tree) and renders it with Three.js. The thesis that drives the whole design: an organism's form is **derived from a planet's physics + a deterministic seed**, not hand-authored — and the generation logic is meant to eventually span a planet-wide ecology (grass, cactus, kelp, trees, later fauna). Everything is procedural: no authored 3D model files. The one binary asset is a CC0 HDRI for lighting.

Stack: Vite + Three.js 0.160 (WebGL2), ES modules, `vite-plugin-glsl` for `.glsl?raw` imports.

## Commands

```bash
npm run dev        # Vite dev server → http://localhost:5173  (the way to actually see the tree)
npm run build      # vite build (also the fastest "does it compile" check)
npm run preview    # serve the production build

# Tests (there is NO `test` npm script — node:test is run directly):
node --test test/*.mjs test/*.js          # full suite
node --test test/skeleton.test.mjs        # a single test file
```

Note: `node --test test/` (a bare directory) does NOT work in this Node version — always pass file globs.

## Critical working norms (read before doing anything)

- **NEVER open a browser / Playwright / chrome-devtools / a dev server to "verify" rendering or UI.** The user runs and verifies the app themselves. All visual/rendering correctness is **USER-VERIFIED** — reason about it from the code instead. (Build + Node tests are fine and expected.)
- **Determinism is load-bearing.** All generation randomness comes from `mulberry32` (`src/rng.js`). `(envelope, seed)` MUST always produce an identical organism. There is **no `Math.random` in the generation pipeline** (the only `crypto`/random use is the "randomize seed" UI button, which is not generation). When editing a generation stage, do not change the **count or order of `rng()` draws** unless you intend to (it reshuffles every downstream value).
- **The seed never sets thickness.** Radii/proportions come from physics (`solveProportions`), not from the seed. Topology is seeded; proportions are physics.
- **Adding a new gene: append its `randomGenome` draw LAST.** Insert the draw strictly AFTER the current final draw so existing seeds' other genes + canopy + foliage stay byte-identical (otherwise every downstream draw reshuffles). A generation-affecting gene (e.g. `weep`, `trunkHeight`) MUST have an IDENTITY default value that is a no-op, so existing trees and the golden-pin canopy tests stay valid. Add the new gene to EVERY hand-built genome test fixture (`genomeSchema`/`genome`/`morphospace`/`mutate`/`presets`/`roots-determinism`) or `genomeDistance`/`resolve` will `NaN`.
- **`onBeforeCompile` GLSL is NOT caught by CI.** Shader code injected via `material.onBeforeCompile` (`barkMaterial`, `leafMesh`, `windSkinGlsl`) is compiled only at runtime in the browser — `npm run build` and node tests pass even when it's broken, and the mesh then silently VANISHES in-browser. Verify every identifier against the INSTALLED three r160 source under `node_modules/three/src/renderers/shaders/` (chunk order matters — e.g. `normal` only exists from `normal_fragment_begin` onward; r160 removed the `geometry.` struct → use `geometryViewDir`). `texelFetch`/two-arg `atan` are core GLSL ES 3.00 (WebGL2). NO backticks inside `/* glsl */`...`` comment text (closes the JS string). For INSTANCED meshes, a world-space displacement must be applied POST-`instanceMatrix` (a `project_vertex` hook), never added to the pre-instance `transformed`.

## Architecture: the two pipelines

The codebase is two halves that meet at `resolve(genome, env)`:

### 1. Generation pipeline (pure ESM, no three.js, Node-testable)

The **genome IS the archetype/grammar** — a continuous gene vector (No Man's Sky-style morphospace), NOT discrete "plant types". Flow:

```
PlanetEnvelope (gravity/medium/light/sunAngle/wind/aridity/temperature; energy='photo', biochem='carbon' locked)
  + seed
  → randomGenome(env, seed)          [genome.js]   build the continuous gene vector; env "evolves"/biases it
  → buildSkeleton(genome, rng, jit)  [skeleton.js] recursive branch graph (trunk → branches → fine twigs)
  → solveProportions(graph, env, g)  [proportions.js] radii (pipe model), gravity droop, tip taper — ZERO rng
  → generateFoliage(graph, genome)   [foliage.js]  leaf-cluster instance set (Structure-of-Arrays)
  → resolve(genome, env)             [genome.js]   sequences the above; returns { graph, foliage, pigment, woodiness, lightDir, ... }
```

Key data structures:
- **genome**: continuous genes (branchiness, branchFactorN, tillering, radialOrder, succulence, stemGirth, taper, rigidity, verticality, ribbing, spininess, segmentation, appendageBreadth/Density, branchAngle, lengthRatio, apicalBias, droopBias) + cosmetic (pigment, leafSize, leafDensity, jitter) + `structuralSeed`. Grass/cactus/kelp/tree are **regions of this continuous space**, reached by interpolation — there are NO `if (type === ...)` branches. Schema (tiers, ranges, distance metric) lives in `src/genomeSchema.js` (`FLORA_SCHEMA`).
- **graph** = `{ nodes:[{pos,radius,branchLevel,parentIdx,isRoot,isWoody,isTerminal,weight,flatNormal,...}], bones:[{a,b}], meta:{bodyAxis,lightDir} }`. Invariant: `parentIdx < ownIndex` (parents precede children), single origin, single dominant trunk. `MAX_BONES` (skeleton.js, ~900) caps geometry; it is NOT a render limit anymore (mesh), so it can be raised for denser trees.
- **foliage SoA** = `{ count, position(3N), normal(3N), tangent(3N), scale(N), rotation(N), ageColor(N), exposure(N), shape }`. `exposure` (0=inner/shaded, 1=outer/sunlit) drives canopy light/shadow depth. Caps/density in `foliage.js` (`MAX_LEAVES`, `BASE_DENSITY`, `LEAF_BASE`, etc.).

`colorRamp.js` is the single source for pigment→color (shared by leaf texture + dendrogram). `archetype.js` (`pickArchetype`) maps env→genome grammar.

### 2. Render pipeline (Three.js, DOM — visual, user-verified)

`main.js` builds the single-specimen viewer and the UI; `viewer.js` owns the whole render path:

- **One Three.js scene**, a `PerspectiveCamera` with custom orbit/pan/zoom + auto-spin + AABB auto-fit, and `getStats()` (fps/triangles/drawCalls/leafClusters/bones/resolution → the top-right stats panel).
- **Branch mesh**: `buildBranchGeometry(graph)` (`branchMesh.js`) walks the graph into ONE merged tapered-tube `BufferGeometry` (parallel-transport framed, fork joints bridged, tip apex-collapse, per-vertex `ao` + along-branch UVs). Material: `createBarkMaterial()` (`barkMaterial.js`) = `MeshStandardMaterial` + `onBeforeCompile` injecting the procedural ridged-FBM/voronoi-plate bark (albedo/normal/roughness/AO) so it gets real PBR lighting + IBL.
- **Leaves**: ONE `InstancedMesh` (`leafMesh.js`, `MeshStandardMaterial` + onBeforeCompile) of alpha-cutout cards; preserves per-instance `instanceColor` tint, `aExposure` canopy darkening, backlit translucency, and **canopy sphere-normals** (leaves lit by an outward-from-canopy-center normal so the crown shades as a soft volume, not flat cards). Cutout shadows via a matching `customDepthMaterial`. Sprite from `leafTexture.js` (`makeLeafClusterTexture`) — procedural leaf SHAPE via the **Gielis superformula** (per-leaf variation) + vein network via **space colonization** (Runions).
- **Lighting/scene**: HDRI image-based lighting (`environment.js` loads `public/env/kloofendal_43d_clear_1k.hdr` → PMREM → `scene.environment`), a procedural `Sky` as the visible background, a `DirectionalLight` (sun, synced to `lightDir`) with PCFSoft shadow maps, and a `ground.js` plane (receives shadow).
- **Post-processing**: `EffectComposer`: `RenderPass → UnrealBloom (subtle) → SMAA → OutputPass`. **`renderer.outputColorSpace = LinearSRGBColorSpace`** and `OutputPass` does the single final ACES tonemap + sRGB encode — do NOT also set sRGB on the renderer or you get double-tonemapping (the "muddy brown" bug). SMAA (not MSAA) because the alpha-cutout foliage shimmers.
- **Render-mode toggle** (`renderModes.js` + the `#rendermode-panel` in `index.html`): lit / unlit / wireframe / normals / ao — swaps per-mesh materials (instancing-aware), persists across regenerate. `viewer.attachRenderModeController(...)` / `viewer.setRenderMode(mode)`.

`viewer.js` exposes `branchMesh`, `leafMesh`, `barkCtl`, `leafCtl`, `setRenderMode`, `attachRenderModeController`, `setPlant`, `getStats`, `resize`, `dispose`.

### UI (`index.html` + `main.js`)

Left panel: a **Preset** dropdown (header) + tabbed gene/climate sliders (Climate / Form / Stem / App / Posture / Look) — Sims-CAS style. `TREE_DEFAULT` (now in `src/presets.js`) is the genome loaded on page load so reloading shows a tree. Top-right: stats. Top-left (right of the controls): the render-mode panel (lit/unlit/wireframe/normals/ao + reveal-roots + wind toggle). Morphological sliders edit the genome directly; "Generate" rolls a climate-adapted `randomGenome`; the ↻ button rerolls only the seed (new individual, same genes); the preset dropdown loads a gene-vector bookmark.

## Where the "look" is tuned (named constants)

Most visual tuning is named constants, not logic:
- **Tree shape/density**: `MAX_BONES`, `BASE_BRANCH_LENGTH`, branch/depth mapping in `skeleton.js`; `TREE_DEFAULT` genes in `main.js` (branchiness, branchFactorN, lengthRatio, branchAngle, succulence, stemGirth, rigidity, etc.).
- **Canopy**: `MAX_LEAVES`, `BASE_DENSITY`, `LEAF_BASE`, `RADIAL_OFFSET_FRAC`, `BARE_FRACTION`, `TIP_EXPONENT`, `JITTER_FRAC` in `foliage.js` (clumping, gaps, fullness, no detached leaves).
- **Bark**: `BARK_*` constants (ridge freq, furrow depth, plate scale, palette) in `barkMaterial.js`.
- **Lighting/realism**: HDRI choice (`environment.js`), sun/ambient intensity + `toneMappingExposure` + shadow softness + bloom + ground color in `viewer.js`/`ground.js`.

## Major architectural decisions (so they aren't re-litigated)

- **Raymarched SDF → procedural mesh** (the big pivot). The body used to be a raymarched SDF in a fragment shader (capped at 64 "bone" uniforms, opaque, no transparency/textures/LOD). It was replaced by real **tube mesh** geometry generated from the same skeleton. This removed the bone cap as a render limit, the depth-compositing hacks, and unlocked PBR/shadows/textures. The old SDF shaders (`src/shaders/creature.frag.glsl` / `.vert.glsl`) survive only because the **parked** gallery renderer still references them.
- **Continuous morphospace, NOT discrete archetypes.** Forms emerge from interpolating continuous genes; integer-count genes (branch/stem counts) use a **fractional crossfade** (new branches grow in from zero) so sliders morph smoothly instead of stepping.
- **Foliage is mesh cards, off the bone budget.** Leaves can't be SDF (transparency, count). They're an instanced quad mesh with procedural alpha sprites.
- **Photoreal rendering overhaul.** PBR materials + HDRI IBL + sun shadows + ground + post/AA. Honest ceiling: this targets "convincingly realistic CG", not photo-indistinguishable (that's SpeedTree/ray-traced territory). The realism work is mostly *rendering* (lighting/material/post), separate from the *generation* logic.

## Generative capabilities (genes, presets, wind, roots)

Added on top of the base morphospace; all genes are continuous, in `FLORA_SCHEMA`, drawn at the END of `randomGenome` (see the "append draws LAST" norm).

- **Leaf-shape genes** (cosmetic; drive the Gielis superformula in `leafTexture.js`): `leafWidth` (breadth), `leafLength` (axialStretch), `leafTip` (n1 sharpness), `leafSerration` (margin teeth), `leafLobing` (m → palmate/maple, deep sinuses). Simple ovate at `leafLobing=0`. Shape math is pure + Node-tested (monotonic per-axis assertions).
- **Bark genes** (cosmetic; drive `barkMaterial` uniforms via `setGenome`): `barkColor` (1=brown furrowed identity → 0=white/cream **birch**), `barkPattern` (1=furrowed → 0=smooth + horizontal **lenticels**). **1.0/1.0 = the prior brown-furrowed identity** (don't regress non-birch trees).
- **`weep`** (proportions): willow cascade droop, a post-pass at the end of `solveProportions`. **0 = strict no-op.** ⚠️ KNOWN BUG: the current per-level rotation *accumulates* and spirals/over-droops on deep canopies (tips to y≈−42); needs a bounded blend-toward-down rewrite. Willow preset kept shallow until fixed.
- **`trunkHeight`** (structural): overall vertical stature, scaled in `skeleton.js`. **0.5 = identity (1.0×)**, 0≈0.45× (short bush), 1≈1.7× (tall).
- **`pigment`** is now a FULL HSL hue wheel (any leaf color) — `colorRamp.js` `pigmentToColor` maps hue=pigment at fixed S/L; the old green→brown ramp is gone.

**Presets** — `src/presets.js`: named gene-vector "bookmarks" `{ id, label, genome:{...TREE_DEFAULT, ...overrides, structuralSeed} }`. **Pure parameters, ZERO custom logic** — selecting one (dropdown in the header) loads the vector → syncs sliders → same `resolve()`. `TREE_DEFAULT` now lives HERE (moved out of `main.js`). A preset only looks right if the morphospace can express it.

**Hierarchical skeletal wind** (render-only vertex displacement): each branch chain is a "wind bone". `branchMesh` bakes per-vertex `boneIndex`/`boneFraction` + a `bones_wind` hierarchy; `windSolver.js` composes per-bone rotation matrices top-down each frame into a `DataTexture`; `windSkinGlsl.js` is the shared bone-skinning GLSL injected into `barkMaterial` (branch) + `leafMesh` (leaf bone-follow + flutter/tumble); `viewer.js` builds/uploads the texture, runs the solver in the render loop, and owns the Wind toggle/strength. `windStrength=0` = exactly static. (`windGlsl.js` is the older global-field wind, retained but superseded.)

**Roots** (now ACTIVE): `roots.js` `growRootSystem(graph, genome, rootRng)` — taproot + lateral network + buttress, appended in `resolve()` AFTER `buildSkeleton` using an ISOLATED `mulberry32(structuralSeed ^ ROOT_SALT)` sub-stream so roots never perturb canopy/foliage determinism. Roots dive below y=0; a ground-reveal toggle (`viewer`/`ground`) fades the ground to inspect them.

**Other UI**: a reroll-seed button (changes only `structuralSeed` → a new individual of the same genes); the stats panel triangle/draw-call counts are real per-frame totals (`renderer.info.autoReset=false` + `reset()` each frame; the number includes the shadow + post passes).

## Active vs. parked

**Active** (single-specimen tree, the current focus): `genome`, `genomeSchema`, `archetype`, `skeleton`, `proportions`, `foliage`, `roots`, `colorRamp`, `rng`, `envelope`, `branchMesh`, `barkMaterial`, `leafMesh`, `leafTexture`, `windSolver`, `windSkinGlsl`, `windGlsl`, `presets`, `environment`, `ground`, `renderModes`, `viewer`, `main` + `index.html`.

**Parked** (on disk, intentionally NOT in the active path — the future "planet-wide ecology" / earlier explorations):
- `biosphere.js` (`generateBiosphere` — rolls one ancestral genome and branch-mutates it into a related FAMILY of N species), `mutate.js` (schema-driven, genome-type-agnostic mutation with tier rates), `dendrogram.js` (phylogeny tree view), `gridRenderer.js` (multi-species gallery; still uses the SDF shaders). This whole layer is intact and tested — it's how an ecology of related plants would be generated.
- `src/shaders/creature.frag.glsl` / `creature.vert.glsl` — legacy raymarched-SDF body, superseded by mesh; only the parked `gridRenderer` imports them.
- `stubs.js` — named v2 extension points (organs, reaction-diffusion patterning, castes, structures). `FAUNA_SCHEMA_STUB` in `genomeSchema.js` — the hook for a future `FaunaGenome` (mutate is already genome-agnostic).
- `skin.js` — still called by `resolve()` (returns bone uniform arrays + boneCount), but its packed bone data is **no longer rendered** (the mesh reads the graph directly; AABB-fit moved to geometry bounds). Kept because it's cheap and tested.
- `scripts/verify.mjs` — a headless, browser-free integration harness that runs the full generation pipeline across a seed/gene grid and asserts the invariants.

**Not yet done**: the non-tree morphospace forms (grass, cactus, kelp, etc.) currently render as plain tubes — their surface features (ribbing/spines/lamina) were SDF tricks that haven't been re-implemented for the mesh path. LOD is structured-for (leaf texture takes a `resolution` arg) but not wired.

## Testing notes

Pure generation modules (`skeleton`, `proportions`, `foliage`, `genome`, `genomeSchema`, `mutate`, `branchMesh`, `dendrogram`, `leafTexture` shape math, `skin`) have no three.js import and are unit-tested with `node:test` — assert **determinism** (deep-equal on repeat), invariants (bone budget, `parentIdx<ownIndex`, pipe-model radius, no detached leaves, tier mutation rates, etc.), and **directional** behavior (e.g. dim light → deeper tree). Rendering/material modules (`viewer`, `barkMaterial`, `leafMesh`, `environment`, `ground`, `renderModes`) are NOT unit-tested — their correctness is visual and user-verified; `npm run build` is the compile gate.
