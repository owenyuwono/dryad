# dryad

A browser prototype that **procedurally generates flora** — no authored 3D models, no textures on disk. A tree's whole form comes from a planet's physics plus a deterministic seed, rendered with Three.js.

The genome is a continuous gene vector, not a set of plant "types": grass, cactus, kelp and oak are regions of one morphospace you can slide between.

> **Note on leaf rendering:** leaves come in three render modes. `cluster` — one multi-leaf sprite per anchor — is the production-style approach: it's how real-time foliage keeps instance counts sane, and it's the mode a game would ship. `single` (one card per individual leaf) and `crossed` are fidelity experiments — explorations of how far per-leaf rendering can be pushed, kept for look-dev rather than as a viable runtime technique.

## Run it

```bash
npm install
npm run dev        # → http://localhost:5173
npm run build      # also the fastest "does it compile" check
npm run preview
```

Tests (no `test` script — `node:test` is run directly; a bare directory doesn't work, pass globs):

```bash
node --test test/*.mjs test/*.js
node --test test/skeleton.test.mjs
```

## How it works

```
PlanetEnvelope (gravity, light, wind, aridity, …) + seed
  → randomGenome      genome.js       continuous gene vector, biased by the environment
  → deriveTraits      allometry.js    scaling laws (size → girth, leaf area, tier count)
  → buildSkeleton     skeleton.js     recursive branch graph
  → solveProportions  proportions.js  radii via the pipe model, gravity droop, taper
  → generateFoliage   foliage.js      leaf-cluster instances
  → resolve()         genome.js       sequences it all
```

Generation is pure ESM with no Three.js import, so it's unit-testable in Node. Rendering (`viewer.js`, `branchMesh.js`, `barkMaterial.js`, `leafMesh.js`, `leafTexture.js`) is the other half: one merged tube mesh for wood, one instanced mesh for leaves, procedural bark and leaf sprites in shaders, HDRI lighting, skeletal wind.

Everything random comes from `mulberry32` (`src/rng.js`) — the same `(envelope, seed)` always gives the same organism. Seeds set topology; physics sets thickness.

## UI

Left panel: preset dropdown plus gene/climate sliders. Top-left: render modes (lit / unlit / wireframe / normals / furrows / ao) and toggles for wind and root reveal. Top-right: stats. "Generate" rolls a new climate-adapted genome; ↻ rerolls only the seed (same genes, new individual).

## More

`CLAUDE.md` is the real architecture doc — data structures, tuning constants, the decisions that shouldn't be re-litigated, and the working norms (chief among them: don't reorder RNG draws, and shader code injected via `onBeforeCompile` isn't caught by CI). `docs/SUMMARY.md` has the project narrative.

The one binary asset is a CC0 HDRI in `public/env/`.
