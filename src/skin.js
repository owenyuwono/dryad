// =============================================================================
// STAGE 5 — skin(graph, envelope) -> uniforms for shader
// SDF capsules (round cones) per bone, smooth-unioned in shader.
// =============================================================================

export function skin(graph, envelope, genome = null) {
  const { nodes, bones } = graph;
  const { biochem } = envelope;

  // Genome-controlled leaf parameters. When genome is null (legacy 2-arg call),
  // leafSizeMul defaults to 1.0 so output is byte-identical to the pre-genome version.
  const leafSizeMul = (genome !== null && genome.leafSize !== undefined) ? genome.leafSize : 1.0;

  const MAX_BONES = 64;
  const count = Math.min(bones.length, MAX_BONES);

  const boneAData = [];    // vec4 * 64: xyz=posA, w=radiusA
  const boneBData = [];    // vec4 * 64: xyz=posB, w=radiusB
  const boneFlatData = []; // vec4 * 64: xyz=leafPlaneNormal, w=flattenFactor (always 0 — foliage is now instanced mesh cards)

  for (let i = 0; i < MAX_BONES; i++) {
    if (i < count) {
      const bone = bones[i];
      const na = nodes[bone.a];
      const nb = nodes[bone.b];
      // isTerminal nodes have their radius scaled by leafSizeMul.
      // Terminal detection: nb.isTerminal (set by skeleton stage).
      const isTerminalBone = nb.isTerminal === true;
      const radiusB = isTerminalBone ? nb.radius * leafSizeMul : nb.radius;

      boneAData.push(na.pos[0], na.pos[1], na.pos[2], na.radius);
      boneBData.push(nb.pos[0], nb.pos[1], nb.pos[2], radiusB);

      // Flatten (boneFlatData[i].w) is always 0: leaves moved to instanced mesh cards.
      // Normal channel (xyz) is preserved for future use but w=0 makes it a no-op in shader.
      // Non-terminal bones: normal [0,1,0], flatten 0.
      const fn = nb.flatNormal;
      let fx, fy, fz;

      if (isTerminalBone) {
        fx = fn ? fn[0] : 0;
        fy = fn ? fn[1] : 1;
        fz = fn ? fn[2] : 0;
      } else {
        fx = 0;
        fy = 1;
        fz = 0;
      }

      boneFlatData.push(fx, fy, fz, 0);
    } else {
      // Padding: zero-length degenerate capsule that contributes nothing significant
      boneAData.push(0, -9999, 0, 0.001);
      boneBData.push(0, -9999, 0, 0.001);
      // Padding: identity normal (up), zero flatten — no leaf plane influence
      boneFlatData.push(0, 1, 0, 0);
    }
  }

  // biochem controls blend hardness and material mode.
  // carbon (plant): soft organic blends (large k), materialMode=0.
  // silicon: hard crystalline blends (small k), materialMode=1.
  //   PARKED — silicon is unreachable from the UI this phase; kept for future biochem expansion.
  const blendK = biochem === 'carbon' ? 0.30 : 0.05;
  const materialMode = biochem === 'carbon' ? 0 : 1;

  // v2 stub: leaf-card / instanced-mesh terminal rendering — parked pending renderer B/C decision.

  // v2 stub: patternSurface — reaction-diffusion leaf venation; after smin
  // accumulation, modulate surface with a Turing-pattern UV field derived
  // from frond flatNormal projection to produce vein/margin detail.

  // v2 stub: generateStructures — would add stipules, thorns, tendrils as
  // additional SDF primitives (thin extruded SDFs, box-sdf fins, cone spines)
  // bolted onto the skeleton attachment sites.

  // v2 stub: crystal/gas/swarm rendering branch — PARKED.
  // crystal: IFS (iterated function system) SDF.
  // gas: volumetric raymarching with density accumulation.
  // swarm: point-cloud instanced rendering.

  // When genome is provided, attach its fields to the return so callers can
  // forward them to the shader without needing to re-read the genome separately.
  // When genome is null (legacy 2-arg call), no extra fields are added.
  const genomeFields = genome !== null ? {
    pigment:     genome.pigment,
    leafSize:    genome.leafSize
  } : {};

  // Surface-relief scalars for shader uniforms uRibbing, uSpininess, uSegmentation.
  // Passed through directly from genome; default 0 when genome is null.
  const uRibbing     = (genome !== null && genome.ribbing     !== undefined) ? genome.ribbing     : 0;
  const uSpininess   = (genome !== null && genome.spininess   !== undefined) ? genome.spininess   : 0;
  const uSegmentation = (genome !== null && genome.segmentation !== undefined) ? genome.segmentation : 0;

  return {
    boneAData, boneBData, boneFlatData, boneCount: count,
    blendK, materialMode,
    uRibbing, uSpininess, uSegmentation,
    ...genomeFields
  };
}
