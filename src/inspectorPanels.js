// =============================================================================
// inspectorPanels.js — the "part inspector" dock: small 2D-canvas previews of
// individual procedural parts + isolate-part toggles on the main hero viewer.
//
// DESIGN (see the design-inspector-panels workflow):
//   - Everything here is RENDER-ONLY. Panels consume the already-resolved
//     organism (resolve() output) and re-derive their canvas on every refresh()
//     — they NEVER touch the generation pipeline, never draw rng for generation,
//     never add a gene. (The bark 3D swatch lives in barkSwatch.js; it is the
//     only WebGL context. This module is pure 2D canvas + DOM and imports NO
//     three.js, so its math is Node-testable.)
//   - 2D panels reuse already-exported PURE functions:
//       leafBaseParams + superformulaOutline  (leaf silhouette)   leafTexture.js
//       makeLeafClusterTexture                (the real sprite)   leafTexture.js
//       pigmentToColor                        (pigment chip/ramp) colorRamp.js
//       ringProfile                           (branch x-section)  branchMesh.js
//   - Isolate-part toggles are pure .visible/reveal flips on the existing viewer
//     (setFoliageVisible / setStructureVisible / setRootsRevealed).
// =============================================================================

import { leafBaseParams, superformulaOutline, pinnateVenation, makeLeafClusterTexture } from './leafTexture.js';
import { ringProfile } from './branchMesh.js';
import { pigmentToColor } from './colorRamp.js';

// ---------------------------------------------------------------------------
// PURE sampling helpers (no canvas, no three) — Node-testable.
// ---------------------------------------------------------------------------

/** Normalized leaf outline points {x,y} (y in [0,1], base→tip) for `genes`. */
export function leafSilhouettePoints(genes, steps = 160) {
  return superformulaOutline(leafBaseParams(genes || {}), steps);
}

/**
 * Closed polar cross-section of the branch tube for the given stem-profile
 * genes. Returns {x,y} points normalized so the max radius is 1.
 * Mirrors branchMesh's ring offset: (rScale·cosθ·uScale, rScale·sinθ).
 */
export function crossSectionPoints({ ribbing = 0, ribCount = 10, flatness = 0 } = {}, steps = 180) {
  const pts = [];
  let maxR = 1e-6;
  for (let i = 0; i < steps; i++) {
    const theta = (2 * Math.PI * i) / steps;
    const { rScale, uScale } = ringProfile(theta, { ribbing, ribCount, flatness });
    const x = rScale * Math.cos(theta) * uScale;
    const y = rScale * Math.sin(theta);
    pts.push({ x, y });
    const rr = Math.hypot(x, y);
    if (rr > maxR) maxR = rr;
  }
  return pts.map((p) => ({ x: p.x / maxR, y: p.y / maxR }));
}

/** N evenly-spaced pigment colors across the full hue wheel (pigment 0→1). */
export function pigmentRampColors(steps = 64) {
  const out = [];
  for (let i = 0; i < steps; i++) out.push(pigmentToColor(steps === 1 ? 0 : i / (steps - 1)));
  return out;
}

// ---------------------------------------------------------------------------
// Small canvas utilities (render-only; need a 2D context).
// ---------------------------------------------------------------------------

const ri = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
const rgb = ([r, g, b]) => `rgb(${ri(r)},${ri(g)},${ri(b)})`;

function clear2d(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
}

// Uniformly fit normalized points into a (w,h) box with padding, returning a
// mapper to canvas coords with +Y pointing UP (tip at top for leaves).
function fitMapper(pts, w, h, pad) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  const ox = (w - drawW) / 2 - minX * scale;
  const oy = h - (h - drawH) / 2 + minY * scale;   // flip Y (canvas y grows down)
  return (p) => ({ x: ox + p.x * scale, y: oy - p.y * scale });
}

function strokePolygon(ctx, pts, map, { fill, stroke, lineWidth = 1 }) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const c = map(p);
    if (i === 0) ctx.moveTo(c.x, c.y);
    else ctx.lineTo(c.x, c.y);
  });
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

// ---------------------------------------------------------------------------
// 2D panel draw functions. Each takes (ctx, {genome, resolved}, w, h).
// ---------------------------------------------------------------------------

function drawLeafShapePanel(ctx, { genome, resolved }, w, h, wireframe = false) {
  clear2d(ctx, w, h);
  const genes = genome || resolved?.genome || {};
  const baseParams = leafBaseParams(genes);
  const pts = superformulaOutline(baseParams, 200);
  const pigment = resolved?.pigment ?? genes.pigment ?? 0.33;
  const map = fitMapper(pts, w, h, 12);

  if (!wireframe) {
    strokePolygon(ctx, pts, map, {
      fill: rgb(pigmentToColor(pigment)),
      stroke: 'rgba(10,16,12,0.45)',
      lineWidth: 1.25,
    });
    return;
  }

  // Wireframe: the outline edge-loop + the pinnate vein skeleton + the vertices,
  // no fill — so the actual silhouette geometry AND venation structure are visible.
  // Vein midrib (depth 0) drawn thicker than the secondaries.
  const veinPairs = Math.max(6, Math.min(9, Math.round((baseParams.serrationFreq ?? 10) * 0.4)));
  const ven = pinnateVenation(pts, { pairs: veinPairs });
  ctx.strokeStyle = 'rgba(90,170,110,0.85)';
  for (const e of ven.edges) {
    const a = map(ven.nodes[e.from]);
    const b = map(ven.nodes[e.to]);
    ctx.lineWidth = ven.nodes[e.to].depth === 0 ? 1.6 : 0.7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  // Outline edge-loop
  ctx.strokeStyle = 'rgba(130,220,150,0.95)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const c = map(p);
    if (i === 0) ctx.moveTo(c.x, c.y);
    else ctx.lineTo(c.x, c.y);
  });
  ctx.closePath();
  ctx.stroke();
  // Vertices
  ctx.fillStyle = 'rgba(190,235,200,0.9)';
  for (const p of pts) {
    const c = map(p);
    ctx.fillRect(c.x - 0.75, c.y - 0.75, 1.5, 1.5);
  }
}

function drawCrossSectionPanel(ctx, { genome, resolved }, w, h) {
  clear2d(ctx, w, h);
  const ribbing  = resolved?.ribbing  ?? genome?.ribbing  ?? 0;
  const flatness = resolved?.flatness ?? genome?.flatness ?? 0;
  const ribCount = resolved?.ribCount
    ?? Math.max(8, Math.min(16, 8 + Math.round((genome?.segmentation ?? 0) * 8)));
  const pts = crossSectionPoints({ ribbing, ribCount, flatness }, 200);
  const map = fitMapper(pts, w, h, 14);
  strokePolygon(ctx, pts, map, {
    fill: 'rgba(120,86,52,0.85)',
    stroke: 'rgba(60,40,24,0.9)',
    lineWidth: 1.25,
  });
}

function drawPigmentSwatchPanel(ctx, { genome, resolved }, w, h) {
  clear2d(ctx, w, h);
  const pigment = resolved?.pigment ?? genome?.pigment ?? 0.33;
  const [r, g, b] = pigmentToColor(pigment);
  ctx.fillStyle = rgb([r, g, b]);
  ctx.fillRect(0, 0, w, h);
  // hex readout
  const hex = '#' + [r, g, b].map((v) => ri(v).toString(16).padStart(2, '0')).join('');
  ctx.font = '11px monospace';
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  ctx.fillStyle = lum > 0.5 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
  ctx.fillText(`${hex}  p=${pigment.toFixed(2)}`, 8, h - 8);
}

function drawPigmentRampPanel(ctx, { genome, resolved }, w, h) {
  clear2d(ctx, w, h);
  const cols = pigmentRampColors(w);   // one column per pixel
  for (let x = 0; x < cols.length; x++) {
    ctx.fillStyle = rgb(cols[x]);
    ctx.fillRect(x, 0, 1, h);
  }
  // marker at the current pigment
  const pigment = Math.max(0, Math.min(1, resolved?.pigment ?? genome?.pigment ?? 0.33));
  const mx = Math.round(pigment * (w - 1));
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(mx - 1, 0, 2, h);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(mx - 2, 0, 1, h);
  ctx.fillRect(mx + 1, 0, 1, h);
}

// Leaf-texture panel is the expensive one (makeLeafClusterTexture runs venation
// space-colonization). It is debounced and blits the returned .source canvas
// over an alpha checkerboard so the cutout reads.
function drawCheckerboard(ctx, w, h, cell = 8) {
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const on = ((x / cell) + (y / cell)) % 2 === 0;
      ctx.fillStyle = on ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

function blitLeafTexture(ctx, { genome, resolved }, w, h) {
  clear2d(ctx, w, h);
  drawCheckerboard(ctx, w, h);
  const genes = genome || resolved?.genome || {};
  // Read every leaf-shape arg from `resolved` FIRST (the same source viewer.js
  // feeds makeLeafClusterTexture), falling back to the raw genome. Today they
  // are identical (resolve passes these through), but preferring resolved keeps
  // the preview faithful even if a future allometry derives a leaf-shape gene.
  const tex = makeLeafClusterTexture({
    pigment:       resolved?.pigment       ?? genes.pigment       ?? 0.33,
    breadth:       resolved?.foliage?.shape,
    seed:          1,
    leafWidth:     resolved?.leafWidth     ?? genes.leafWidth     ?? 0.5,
    leafLength:    resolved?.leafLength    ?? genes.leafLength    ?? 0.45,
    leafTip:       resolved?.leafTip       ?? genes.leafTip       ?? 0.4,
    leafSerration: resolved?.leafSerration ?? genes.leafSerration ?? 0.0,
    leafLobing:    resolved?.leafLobing    ?? genes.leafLobing    ?? 0.0,
    leafSkew:      resolved?.leafSkew      ?? genes.leafSkew      ?? 0.5,
    leafDivision:  resolved?.leafDivision  ?? genes.leafDivision  ?? 0,
    frondFan:      resolved?.frondFan      ?? genes.frondFan      ?? 0,
  });
  if (tex === null || !tex.source) return;   // null in Node / headless — guarded
  // Fit the square sprite into the panel, centered.
  const s = Math.min(w, h);
  ctx.drawImage(tex.source, (w - s) / 2, (h - s) / 2, s, s);
}

// ---------------------------------------------------------------------------
// Registry — uniform bookkeeping so adding the Nth panel is one register call.
// ---------------------------------------------------------------------------

/**
 * createInspectorRegistry({ getGenome, getResolved })
 *
 * @returns {{
 *   register(def): void,
 *   refresh(): void,
 *   resize(): void,
 *   dispose(): void,
 *   panels: object[],
 * }}
 *
 * A panel def is { id, update?({genome, resolved}), resize?(), dispose?() }.
 * One panel throwing never breaks the others (isolated try/catch).
 */
export function createInspectorRegistry({ getGenome, getResolved } = {}) {
  const panels = [];
  return {
    panels,
    register(def) {
      if (def) panels.push(def);
      return def;
    },
    refresh() {
      const genome = getGenome ? getGenome() : undefined;
      const resolved = getResolved ? getResolved() : undefined;
      for (const p of panels) {
        try { p.update?.({ genome, resolved }); }
        catch (err) { if (typeof console !== 'undefined') console.warn(`inspector panel "${p.id}" update failed:`, err); }
      }
    },
    resize() {
      for (const p of panels) {
        try { p.resize?.(); } catch (_) { /* ignore */ }
      }
    },
    dispose() {
      for (const p of panels) {
        try { p.dispose?.(); } catch (_) { /* ignore */ }
      }
      panels.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Canvas-panel factory — binds a draw fn to a <canvas>, handling DPR + resize.
// ---------------------------------------------------------------------------

function makeCanvasPanel(id, canvas, drawFn, { debounceMs = 0 } = {}) {
  if (!canvas) return { id, update() {}, resize() {}, dispose() {} };
  const ctx = canvas.getContext('2d');
  let lastArgs = null;
  let timer = 0;

  function sizeToClient() {
    // Bail when the canvas has no laid-out box (dock collapsed / detached) —
    // sizing/painting at 0 would bake a stale/blank frame. The expand handler
    // re-paints (main.js calls inspector.resize() on expand), so this is safe.
    const w = canvas.clientWidth || 0;
    const h = canvas.clientHeight || 0;
    if (!w || !h) return { w: 0, h: 0 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function paint() {
    if (!ctx || !lastArgs) return;
    const { w, h } = sizeToClient();
    if (!w || !h) return;   // collapsed/detached — nothing to paint
    drawFn(ctx, lastArgs, w, h);
  }

  return {
    id,
    update(args) {
      lastArgs = args;
      if (debounceMs > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = 0; paint(); }, debounceMs);
      } else {
        paint();
      }
    },
    resize() { paint(); },
    dispose() { if (timer) clearTimeout(timer); },
  };
}

// ---------------------------------------------------------------------------
// High-level mount — wires the dock's canvases + toggle buttons to the viewer.
// ---------------------------------------------------------------------------

/**
 * mountInspectorPanels({ viewer, getGenome, getResolved, elements })
 *
 * `elements` holds the dock DOM nodes (any may be null/absent):
 *   { leafShape, leafTexture, pigment, pigmentRamp, crossSection,   // <canvas>
 *     toggleLeaves, toggleBranches }                                 // <button>
 * (roots reveal is owned by the existing render-mode reveal-roots button.)
 *
 * Returns the registry { refresh, resize, dispose, panels } so the caller can
 * refresh() at the setPlant chokepoint.
 */
export function mountInspectorPanels({ viewer, getGenome, getResolved, elements = {} }) {
  const reg = createInspectorRegistry({ getGenome, getResolved });

  // Leaf-shape panel has a wireframe toggle (outline + vein skeleton vs filled).
  const leafShapeState = { wireframe: false };
  const leafShapePanel = makeCanvasPanel('leaf-shape', elements.leafShape,
    (ctx, args, w, h) => drawLeafShapePanel(ctx, args, w, h, leafShapeState.wireframe));
  reg.register(leafShapePanel);
  if (elements.leafWireBtn) {
    const btn = elements.leafWireBtn;
    btn.addEventListener('click', () => {
      leafShapeState.wireframe = !leafShapeState.wireframe;
      btn.classList.toggle('active', leafShapeState.wireframe);
      leafShapePanel.resize();   // repaint with the last args in the new mode
    });
  }

  reg.register(makeCanvasPanel('leaf-texture',   elements.leafTexture,  blitLeafTexture, { debounceMs: 160 }));
  reg.register(makeCanvasPanel('pigment',        elements.pigment,      drawPigmentSwatchPanel));
  reg.register(makeCanvasPanel('pigment-ramp',   elements.pigmentRamp,  drawPigmentRampPanel));
  reg.register(makeCanvasPanel('cross-section',  elements.crossSection, drawCrossSectionPanel));

  // --- Isolate-part toggles (independent, composable) ---
  // Each button reflects "this part is shown"; .is-off marks a hidden part.
  function wireToggle(btn, initial, apply) {
    if (!btn) return;
    let on = initial;
    const sync = () => btn.classList.toggle('is-off', !on);
    sync();
    btn.addEventListener('click', () => { on = !on; apply(on); sync(); });
  }
  if (viewer) {
    wireToggle(elements.toggleLeaves,   true, (on) => viewer.setFoliageVisible?.(on));
    wireToggle(elements.toggleBranches, true, (on) => viewer.setStructureVisible?.(on));
  }

  return reg;
}
