// =============================================================================
// STUB EXTENSION POINTS — v2 hooks with comments
// =============================================================================

// placeOrgans(graph, slots)
// v2: Given a skeleton graph and named attachment "slots" (head, thorax, flank),
// place organ SDFs (eye clusters, mouth/beak, sensory pits) as additional
// SDF primitives in the uniform arrays. Organs are driven by energy source:
// predation -> forward-facing eyes + mouth; photo -> pigment patches on dorsal;
// chemo -> sensory antennae at extremities.
export function placeOrgans(graph, slots) { /* stub */ }

// patternSurface(surfacePoint, envelope, rng)
// v2: Evaluate a layered surface pattern at a given world-space point on the SDF
// surface. Returns color/roughness perturbation. carbon -> procedural scales/skin
// texture using FBM noise; silicon -> voronoi crystal cell coloring with sharp edges.
export function patternSurface(surfacePoint, envelope, rng) { /* stub */ }

// applyCaste(archetype, casteRole, rng) -> modified archetype
// v2: Given a social caste ('worker'|'soldier'|'queen'|'scout'), modify the
// archetype (e.g. soldier -> larger radialN, bigger proportions, weapon appendages;
// queen -> unsegmented, massive torso; scout -> elongated, light). Enables
// generating eusocial creature variants from one species definition.
export function applyCaste(archetype, casteRole, rng) { /* stub */ return archetype; }

// generateStructures(graph, archetype, rng)
// v2: Add secondary structural SDFs to the skeleton: dermal spines (sharp cone SDFs
// at spine nodes), fin membranes (interpolated box SDFs between appendage pairs),
// antenna (thin swept capsule), bioluminescent organ bulbs. All driven by appendageKind
// and energy source. Returns additional primitive list to extend uBoneA/uBoneB arrays.
export function generateStructures(graph, archetype, rng) { /* stub */ return []; }
