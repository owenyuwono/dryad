# Dryad — Project Summary

A browser prototype that **procedurally generates flora** and renders it photorealistically
with Three.js. The current focus is a single, increasingly photoreal **tree**, but the
generation logic is designed to eventually span a planet-wide ecology (grass, cactus, kelp,
trees, later fauna).

## The thesis

An organism's form is **derived from a planet's physics + a deterministic seed** — not
hand-authored. Everything is procedural: there are **no authored 3D model files**. The only
binary asset is a CC0 HDRI used for image-based lighting.

Two principles fall out of this:

- **Determinism is load-bearing.** All generation randomness comes from one seeded PRNG
  (`mulberry32`, `src/rng.js`). The pair `(environment, seed)` *always* produces a
  byte-identical organism. There is no `Math.random` in the generation pipeline.
- **The seed sets topology, physics sets proportions.** Branch structure is seeded; radii,
  taper, droop and girth are *solved* from physics (`solveProportions`), never stored in the
  seed.

## Tech stack

- **Vite** + **Three.js 0.160** (WebGL2), ES modules.
- `vite-plugin-glsl` for `.glsl?raw` imports.
- Tests via Node's built-in `node:test` (no test framework, no browser).

## Commands

```bash
npm run dev        # Vite dev server → http://localhost:5173  (the way to actually see the tree)
npm run build      # vite build (also the fastest "does it compile" check)
npm run preview    # serve the production build

# Tests (no `test` npm script — node:test is run directly; pass file globs, not a bare dir):
node --test test/*.mjs test/*.js          # full suite
node --test test/skeleton.test.mjs        # a single file
```

## Architecture: two pipelines

The codebase is two halves that meet at `resolve(genome, env)`.

### 1. Generation pipeline (pure ESM, no Three.js, Node-testable)

The **genome IS the grammar** — a continuous gene vector (a No Man's Sky-style
*morphospace*), NOT discrete "plant types". Grass / cactus / kelp / tree are *regions* of
this continuous space, reached by interpolation; there are no `if (type === ...)` branches.

```
PlanetEnvelope (gravity, medium, light, sunAngle, wind, aridity, temperature; energy/biochem locked)
  + seed
  → randomGenome(env, seed)        [genome.js]        build the continuous gene vector; env biases it
  → deriveTraits(genome, env)      [allometry.js]     continuous scaling LAWS (one "size" driver →
                                                      coupled girth / leaf size / tier count / root scale)
  → buildSkeleton(genome, rng)     [skeleton.js]      recursive branch graph (trunk → branches → twigs)
  → solveProportions(graph, env)   [proportions.js]   radii (pipe model), gravity droop, taper — ZERO rng
  → generateFoliage(graph, genome) [foliage.js]       leaf-cluster instance set (Structure-of-Arrays)
  → growRootSystem(graph, genome)  [roots.js]         taproot + laterals + buttress (isolated rng sub-stream)
  → resolve(genome, env)           [genome.js]        sequences the above → { graph, foliage, pigment, … }
```

- **Allometry (`allometry.js`)** is the one place a value is *derived* rather than a free
  slider — and it is a physical *law*, not an archetype. It couples girth, leaf size, tier
  count, branch-recursion depth and root extent to a single size driver, identity-centered so
  default-stature plants stay byte-identical.
- **Schema** (gene tiers, ranges, distance metric) lives in `src/genomeSchema.js`
  (`FLORA_SCHEMA`). Adding a gene appends its draw **last** in `randomGenome` with an identity
  default, so existing seeds stay byte-identical.

Key data structures:

- **graph**: `{ nodes:[{pos, radius, branchLevel, parentIdx, isWoody, …}], bones:[{a,b}], meta }`.
  Invariant: `parentIdx < ownIndex`, single origin, single dominant trunk.
- **foliage SoA**: `{ count, position, normal, tangent, scale, rotation, ageColor, exposure, … }`
  — typed arrays, one entry per leaf cluster.

### 2. Render pipeline (Three.js, DOM — visual, user-verified)

`viewer.js` owns the whole render path; `main.js` builds the viewer and the UI.

- **One Three.js scene** with a perspective camera (custom orbit / pan / zoom + auto-spin +
  AABB auto-fit) and a first-person **walk mode** (WASD + pointer-lock).
- **Branch mesh**: `buildBranchGeometry` (`branchMesh.js`) walks the graph into one merged
  tapered-tube `BufferGeometry`. Material: `createBarkMaterial` (`barkMaterial.js`) — a
  `MeshStandardMaterial` whose albedo / normal / roughness / AO are computed **procedurally in
  the fragment shader** via `onBeforeCompile` (no bark texture image).
- **Leaves**: one `InstancedMesh` (`leafMesh.js`) of alpha-cutout cards with canopy
  sphere-normals, backlit translucency and cutout shadows; sprite from `leafTexture.js`
  (Gielis superformula leaf shape + space-colonization veins). Three leaf modes: single /
  cluster / crossed-card.
- **Lighting**: HDRI image-based lighting (`environment.js`) + a procedural `Sky` background +
  a `DirectionalLight` sun with PCF soft shadows + a ground plane.
- **Post**: `EffectComposer`: RenderPass → subtle UnrealBloom → SMAA → OutputPass (single ACES
  tonemap + sRGB encode).
- **Render modes** (`renderModes.js`): lit / unlit / wireframe / normals / ao.

## Features

- **Single specimen** tree — the primary view; every slider/preset/reroll funnels through one
  `setPlant()`.
- **Forest mode** (`forest.js`) — a Poisson-disk-placed stand of N varied individuals (same
  genome, different seeds) rendered in the hero scene, driven by a count input.
- **Hierarchical skeletal wind** (`windSolver.js` + `windSkinGlsl.js`) — each branch chain is a
  "wind bone"; a per-frame solver composes bone matrices into a `DataTexture` and the shared
  GLSL skins both bark and leaves. `strength = 0` is exactly static. **The forest stand follows
  the same wind** (each tree gets its own bone texture/solver; the world wind direction is
  rotated into each tree's object space so the whole stand bends coherently).
- **Roots** (`roots.js`) — taproot + lateral network + buttress, on an isolated rng sub-stream
  so they never perturb canopy/foliage determinism; a ground-reveal toggle inspects them.
- **Procedural bark** (`barkMaterial.js`) — oak/ash "block" model: voronoi cells are raised
  scale **plates**, the disconnected border network is recessed into **cracks** darkened by
  procedural ambient occlusion + crack-aligned albedo, with ridged-FBM fine grain on the block
  faces. Orthogonal continuous axes (relief / orientation / scale / plates / shed + hue /
  lightness / lenticels).
- **Procedural leaves** — continuous leaf-shape genes (width, length, tip, serration, lobing)
  drive the Gielis superformula; pigment is a full HSL hue wheel.
- **Presets** (`presets.js`) — named gene-vector bookmarks (pure parameters, zero custom
  logic). `TREE_DEFAULT` is the genome loaded on page load.
- **Inspector dock** — live preview panels (leaf shape/texture, pigment ramp, bark swatch,
  crossed-card leaf preview) + isolate-part toggles (foliage-only / structure-only).
- **Stats panel** — real per-frame fps / triangles / draw calls / leaf clusters / bones /
  resolution.

## Module map (active path)

| Area | Modules |
| --- | --- |
| Generation | `genome`, `genomeSchema`, `archetype`, `allometry`, `skeleton`, `proportions`, `foliage`, `roots`, `colorRamp`, `rng`, `envelope` |
| Geometry / material | `branchMesh`, `barkMaterial`, `leafMesh`, `leafTexture` |
| Wind | `windSolver`, `windSkinGlsl` (current), `windGlsl` (older global-field, superseded) |
| Scene / render | `viewer`, `environment`, `ground`, `renderModes`, `forest`, `presets`, `main` + `index.html` |
| Inspector previews | `inspectorPanels`, `barkSwatch`, `leafCardPreview`, `poisson` |

## Parked / future (on disk, intentionally not in the active path)

The "planet-wide ecology" layer and earlier explorations, intact and tested:

- `biosphere.js` — rolls one ancestral genome and branch-mutates it into a related *family* of
  N species.
- `mutate.js` — schema-driven, genome-type-agnostic mutation with per-tier rates.
- `dendrogram.js` — phylogeny tree view; `gridRenderer.js` — multi-species gallery (still uses
  the legacy SDF shaders in `src/shaders/`).
- `skin.js`, `stubs.js`, `FAUNA_SCHEMA_STUB` — extension points (the original raymarched-SDF
  body was replaced by the tube mesh; `skin` is kept because it's cheap and tested).

**Not yet done:** the non-tree morphospace forms (grass, cactus, kelp) currently render as
plain tubes — their surface features were SDF tricks not yet re-implemented for the mesh path.
LOD is structured-for but not wired.

## Testing approach

Pure generation modules have no Three.js import and are unit-tested with `node:test`. Tests
assert **determinism** (deep-equal on repeat), **invariants** (bone budget, `parentIdx <
ownIndex`, pipe-model radius, no detached leaves, mutation tier rates), and **directional**
behavior (e.g. dim light → deeper tree).

Rendering/material modules (`viewer`, `barkMaterial`, `leafMesh`, `environment`, …) are **not**
unit-tested — their correctness is visual and **user-verified**. `npm run build` is the compile
gate. Note: shader code injected via `onBeforeCompile` is compiled only at runtime in the
browser, so it is *not* caught by the build or Node tests.
