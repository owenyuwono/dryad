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

Left panel: tabbed gene/climate sliders (Climate / Form / Stem / App / Posture / Look) — Sims-CAS style. `TREE_DEFAULT` (in `main.js`) is the genome loaded on page load so reloading shows a tree. Top-right: stats. Top-left (right of the controls): the render-mode panel. Morphological sliders edit the genome directly; "Generate" rolls a climate-adapted `randomGenome`.

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

## Active vs. parked

**Active** (single-specimen tree, the current focus): `genome`, `genomeSchema`, `archetype`, `skeleton`, `proportions`, `foliage`, `colorRamp`, `rng`, `envelope`, `branchMesh`, `barkMaterial`, `leafMesh`, `leafTexture`, `environment`, `ground`, `renderModes`, `viewer`, `main` + `index.html`.

**Parked** (on disk, intentionally NOT in the active path — the future "planet-wide ecology" / earlier explorations):
- `biosphere.js` (`generateBiosphere` — rolls one ancestral genome and branch-mutates it into a related FAMILY of N species), `mutate.js` (schema-driven, genome-type-agnostic mutation with tier rates), `dendrogram.js` (phylogeny tree view), `gridRenderer.js` (multi-species gallery; still uses the SDF shaders). This whole layer is intact and tested — it's how an ecology of related plants would be generated.
- `src/shaders/creature.frag.glsl` / `creature.vert.glsl` — legacy raymarched-SDF body, superseded by mesh; only the parked `gridRenderer` imports them.
- `stubs.js` — named v2 extension points (organs, reaction-diffusion patterning, castes, structures). `FAUNA_SCHEMA_STUB` in `genomeSchema.js` — the hook for a future `FaunaGenome` (mutate is already genome-agnostic).
- `skin.js` — still called by `resolve()` (returns bone uniform arrays + boneCount), but its packed bone data is **no longer rendered** (the mesh reads the graph directly; AABB-fit moved to geometry bounds). Kept because it's cheap and tested.
- `scripts/verify.mjs` — a headless, browser-free integration harness that runs the full generation pipeline across a seed/gene grid and asserts the invariants.

**Not yet done**: the non-tree morphospace forms (grass, cactus, kelp, etc.) currently render as plain tubes — their surface features (ribbing/spines/lamina) were SDF tricks that haven't been re-implemented for the mesh path. LOD is structured-for (leaf texture takes a `resolution` arg) but not wired.

## Testing notes

Pure generation modules (`skeleton`, `proportions`, `foliage`, `genome`, `genomeSchema`, `mutate`, `branchMesh`, `dendrogram`, `leafTexture` shape math, `skin`) have no three.js import and are unit-tested with `node:test` — assert **determinism** (deep-equal on repeat), invariants (bone budget, `parentIdx<ownIndex`, pipe-model radius, no detached leaves, tier mutation rates, etc.), and **directional** behavior (e.g. dim light → deeper tree). Rendering/material modules (`viewer`, `barkMaterial`, `leafMesh`, `environment`, `ground`, `renderModes`) are NOT unit-tested — their correctness is visual and user-verified; `npm run build` is the compile gate.
