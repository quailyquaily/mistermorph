import assert from "node:assert/strict";
import test from "node:test";

import { GLYPHS, drawMosaicText, layoutMosaicText, shadeColors } from "./mosaic-text.js";

test("every glyph is 7 rows of one width", () => {
  for (const [letter, glyph] of Object.entries(GLYPHS)) {
    assert.equal(glyph.length, 7, letter);
    assert.ok(glyph.every((row) => row.length === glyph[0].length && /^[.#]+$/.test(row)), letter);
  }
  for (const letter of "abcdefghijklmnopqrstuvwxyz") assert.ok(GLYPHS[letter], letter);
});

test("text is laid out letter by letter, a space narrow and unknown letters blank", () => {
  const layout = layoutMosaicText("Hi z");
  // h(5) gap i(5) gap space(2) gap z(5)
  assert.deepEqual(layout.left, [0, 6, 12, 15]);
  assert.equal(layout.widthCols, 20);
  assert.equal(layoutMosaicText("h?").pieces.length, layoutMosaicText("h").pieces.length);
});

function record() {
  const rects = [];
  return { rects, context: { clearRect() {}, fillRect: (x, y) => rects.push([x, y]), fillStyle: "" } };
}

const size = { pitch: 2, piece: 2 };
const shades = shadeColors([0, 0, 0], [255, 255, 255]);

test("formed text puts every piece on its pixel", () => {
  const layout = layoutMosaicText("o");
  const { rects, context } = record();
  drawMosaicText(context, layout, shades, size, 0, true);
  const drawn = rects.map(([x, y]) => `${x / 2},${y / 2}`).sort();
  const expected = layout.pieces.map((piece) => `${piece.x},${piece.y}`).sort();
  assert.deepEqual(drawn, expected);
});

test("a cycle ends where the next begins, so the loop does not jump", () => {
  const layout = layoutMosaicText("morph");
  const end = record();
  drawMosaicText(end.context, layout, shades, size, layout.cycle - 0.001);
  const start = record();
  drawMosaicText(start.context, layout, shades, size, layout.cycle);
  end.rects.forEach(([x, y], index) => {
    assert.ok(Math.abs(x - start.rects[index][0]) < 0.01 && Math.abs(y - start.rects[index][1]) < 0.01, `piece ${index}`);
  });
});
