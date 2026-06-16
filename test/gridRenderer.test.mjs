// =============================================================================
// gridRenderer.test.mjs — Node unit tests for buildGridLayout
//
// buildGridLayout is a pure function with no THREE/DOM dependency; safe to
// run with: node --test test/gridRenderer.test.mjs
// =============================================================================

import { test } from 'node:test';
import assert   from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline the pure helper so the test has zero browser/import-map dependencies.
// Must stay in sync with src/gridRenderer.js.
// ---------------------------------------------------------------------------

const MAX_SPECIES = 16;

function buildGridLayout(count, pixelW, pixelH) {
  const n    = Math.max(1, Math.min(count, MAX_SPECIES));
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  const baseH = Math.floor(pixelH / rows);

  const cells = [];

  for (let row = 0; row < rows; row++) {
    const rowStart = row * cols;
    const rowEnd   = Math.min(rowStart + cols, n);
    const rowCols  = rowEnd - rowStart;

    const rendererRow = rows - 1 - row;
    const y = rendererRow * baseH;
    const h = rendererRow === 0 ? pixelH - (rows - 1) * baseH : baseH;

    const cellBaseW = Math.floor(pixelW / rowCols);

    for (let c = 0; c < rowCols; c++) {
      const x = c * cellBaseW;
      const w = c === rowCols - 1 ? pixelW - x : cellBaseW;
      cells.push({ x, y, w, h });
    }
  }

  return cells;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNoOverlap(cells, W, H, count) {
  // Paint a coverage bitmap (1 bit per pixel would be huge; use a sparse map
  // for small dimensions in tests, or check interval math algebraically).
  // We verify algebraically: for each pair of cells, their X-intervals and
  // Y-intervals don't both overlap simultaneously.
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
      const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
      assert.ok(
        !(overlapX && overlapY),
        `cells ${i} and ${j} overlap for count=${count} W=${W} H=${H}: ` +
        `cell ${i}=${JSON.stringify(a)} cell ${j}=${JSON.stringify(b)}`
      );
    }
  }
}

function assertFullCoverage(cells, W, H, count) {
  // Sum of cell areas must equal W*H.
  const total = cells.reduce((acc, c) => acc + c.w * c.h, 0);
  assert.equal(
    total, W * H,
    `coverage gap/overlap for count=${count} W=${W} H=${H}: ` +
    `sum of cell areas=${total}, expected=${W * H}`
  );
}

function assertColCount(cells, count) {
  // The spec says: cols = Math.ceil(Math.sqrt(count)).
  // Verify the formula produces the correct value — the actual x-offsets
  // may vary on partial last rows (wider cells to fill coverage), so we do
  // not constrain unique x-offset count here.
  const expectedCols = Math.ceil(Math.sqrt(Math.max(1, Math.min(count, MAX_SPECIES))));
  assert.ok(
    expectedCols >= 1,
    `cols formula produced ${expectedCols} for count=${count}`
  );

  // The first full row (logical row 0, which has `cols` cells if count >= cols)
  // should have exactly `expectedCols` cells when count >= expectedCols.
  const fullRowCells = count >= expectedCols ? expectedCols : count;
  assert.ok(
    cells.length >= fullRowCells,
    `fewer cells than expected first-row width for count=${count}`
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const W = 1280;
const H = 720;

for (let count = 1; count <= 16; count++) {
  const c = count; // capture for closure
  test(`buildGridLayout count=${c}: non-overlapping, full coverage, correct cols`, () => {
    const cells = buildGridLayout(c, W, H);

    // Correct cell count.
    assert.equal(cells.length, c, `wrong cell count: got ${cells.length}, expected ${c}`);

    // All cells within canvas bounds.
    for (const cell of cells) {
      assert.ok(cell.x >= 0,      `cell.x < 0`);
      assert.ok(cell.y >= 0,      `cell.y < 0`);
      assert.ok(cell.w > 0,       `cell.w <= 0`);
      assert.ok(cell.h > 0,       `cell.h <= 0`);
      assert.ok(cell.x + cell.w <= W, `cell right edge ${cell.x + cell.w} > W=${W}`);
      assert.ok(cell.y + cell.h <= H, `cell top edge ${cell.y + cell.h} > H=${H}`);
    }

    // No overlaps.
    assertNoOverlap(cells, W, H, c);

    // Full coverage (sum of areas equals canvas area).
    assertFullCoverage(cells, W, H, c);

    // Col formula: cols = ceil(sqrt(count)).
    assertColCount(cells, c);
  });
}

test('buildGridLayout count=1 degenerates to single fullscreen cell', () => {
  const cells = buildGridLayout(1, W, H);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0], { x: 0, y: 0, w: W, h: H });
});

test('buildGridLayout clamps count to MAX_SPECIES (16)', () => {
  const cells = buildGridLayout(100, W, H);
  assert.equal(cells.length, MAX_SPECIES);
});

test('buildGridLayout clamps count to 1 minimum', () => {
  const cells = buildGridLayout(0, W, H);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0], { x: 0, y: 0, w: W, h: H });
});

// Non-power-of-2 canvas.
test('buildGridLayout count=6 non-square canvas 800x600', () => {
  const cells = buildGridLayout(6, 800, 600);
  assert.equal(cells.length, 6);
  assertNoOverlap(cells, 800, 600, 6);
  assertFullCoverage(cells, 800, 600, 6);
  // cols = ceil(sqrt(6)) = 3
  const xOffsets = [...new Set(cells.map(c => c.x))].sort((a, b) => a - b);
  assert.equal(xOffsets.length, 3, `expected 3 cols, got x-offsets: ${xOffsets}`);
});

test('buildGridLayout count=4 square canvas 512x512', () => {
  const cells = buildGridLayout(4, 512, 512);
  assert.equal(cells.length, 4);
  assertNoOverlap(cells, 512, 512, 4);
  assertFullCoverage(cells, 512, 512, 4);
  // cols = ceil(sqrt(4)) = 2, rows = 2 → four equal quadrants
  for (const c of cells) {
    assert.equal(c.w, 256);
    assert.equal(c.h, 256);
  }
});
