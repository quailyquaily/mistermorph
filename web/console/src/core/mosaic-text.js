// Mosaic text: a word in 5x7 pixel letters whose pixels are loose pieces. The pieces drift about
// each letter's box, then, letter by letter, glide into place and darken; the word holds, drifts
// apart, and forms again. Used for waits: the startup loader, a reply on its way.
//
// Plain JavaScript with no Vue, so the startup loader can use it before the app loads.

// 5x7 lowercase letters; "." is empty. A glyph is as wide as its rows, so a space is narrow.
// Letters without a descender row: p, g, q, y and j sit on the line, so every word fits 7 rows.
const GLYPHS = {
  a: [".....", ".....", ".###.", "....#", ".####", "#...#", ".####"],
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
  c: [".....", ".....", ".####", "#....", "#....", "#....", ".####"],
  d: ["....#", "....#", ".##.#", "#..##", "#...#", "#...#", ".####"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  f: ["..##.", ".#...", "####.", ".#...", ".#...", ".#...", ".#..."],
  g: [".....", ".....", ".####", "#...#", ".####", "....#", ".###."],
  h: ["#....", "#....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  i: ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
  j: ["...#.", ".....", "..##.", "...#.", "...#.", "#..#.", ".##.."],
  k: ["#....", "#....", "#..#.", "#.#..", "##...", "#.#..", "#..#."],
  l: [".##..", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  m: [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#...#"],
  n: [".....", ".....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  p: [".....", ".....", "####.", "#...#", "####.", "#....", "#...."],
  q: [".....", ".....", ".####", "#...#", ".####", "....#", "....#"],
  r: [".....", ".....", "#.##.", "##..#", "#....", "#....", "#...."],
  s: [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
  t: [".#...", ".#...", "####.", ".#...", ".#...", ".#..#", "..##."],
  u: [".....", ".....", "#...#", "#...#", "#...#", "#..##", ".##.#"],
  v: [".....", ".....", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  w: [".....", ".....", "#...#", "#...#", "#.#.#", "#.#.#", ".#.#."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  y: [".....", ".....", "#...#", "#...#", ".####", "....#", ".###."],
  z: [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
  ".": [".", ".", ".", ".", ".", ".", "#"],
  " ": ["..", "..", "..", "..", "..", "..", ".."],
};

const ROWS = 7;
const LETTER_GAP = 1; // columns between letters

const HOP_MS = 260; // loose pieces glide to a new cell this often
const SCRAMBLE_MS = 600; // before the first letter forms
const FORM_EVERY_MS = 70; // between letters starting to form
const GLIDE_MS = 420; // a piece gliding into place, or out of it
const HOLD_MS = 1000;
const SHADES = 24; // colour steps from loose to ink

// The pieces of a text: every pixel of every letter, with where each letter starts. Letters the
// font lacks are drawn as spaces.
function layoutMosaicText(text) {
  const letters = [...String(text || "").toLowerCase()].map((letter) => GLYPHS[letter] || GLYPHS[" "]);
  const cols = letters.map((glyph) => glyph[0].length);
  const left = cols.map((_, index) => cols.slice(0, index).reduce((sum, width) => sum + width + LETTER_GAP, 0));
  const pieces = letters.flatMap((glyph, letter) =>
    glyph.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === "#" ? [{ letter, x, y }] : [])))
  );
  const widthCols = letters.length ? left[left.length - 1] + cols[cols.length - 1] : 0;
  const cycle = SCRAMBLE_MS + Math.max(0, letters.length - 1) * FORM_EVERY_MS + GLIDE_MS + HOLD_MS + GLIDE_MS;
  return { pieces, cols, left, widthCols, rows: ROWS, cycle };
}

// A repeatable random number in [0, 1) for a piece at a moment.
function noise(piece, cycle, hop) {
  let h = Math.imul(piece + 1, 374761393) ^ Math.imul(cycle + 7, 668265263) ^ Math.imul(hop + 13, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function easeOut(t) {
  return 1 - (1 - t) ** 3;
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Where a loose piece is headed at a hop: any cell of its letter's box.
function looseCell(layout, index, cycle, hop) {
  const cols = layout.cols[layout.pieces[index].letter];
  return [Math.floor(noise(index, cycle, hop) * cols), Math.floor(noise(index + 9973, cycle, hop) * ROWS)];
}

// Where a loose piece is at time t of a cycle: gliding from one hop's cell to the next.
function loosePosition(layout, index, cycle, t) {
  const hop = Math.floor(t / HOP_MS);
  const [fromX, fromY] = looseCell(layout, index, cycle, hop);
  const [toX, toY] = looseCell(layout, index, cycle, hop + 1);
  const k = easeInOut((t - hop * HOP_MS) / HOP_MS);
  return [mix(fromX, toX, k), mix(fromY, toY, k)];
}

// The colours from loose to ink in fixed steps, made once per text, so drawing builds no strings.
function shadeColors(loose, ink) {
  return Array.from({ length: SHADES + 1 }, (_, step) =>
    `rgb(${loose.map((channel, c) => Math.round(channel + (ink[c] - channel) * (step / SHADES))).join(",")})`
  );
}

// Draws the text at a moment of its cycle; formed draws it whole and still.
function drawMosaicText(context, layout, shades, size, elapsed, formed = false) {
  const { pitch, piece: side } = size;
  context.clearRect(0, 0, layout.widthCols * pitch, ROWS * pitch);
  const cycle = Math.floor(elapsed / layout.cycle);
  const t = elapsed % layout.cycle;
  const dissolveAt = layout.cycle - GLIDE_MS;
  layout.pieces.forEach((piece, index) => {
    const formsAt = SCRAMBLE_MS + piece.letter * FORM_EVERY_MS;
    let x = piece.x;
    let y = piece.y;
    let ink = 1;
    if (!formed) {
      if (t < formsAt) {
        [x, y] = loosePosition(layout, index, cycle, t);
        ink = 0;
      } else if (t < formsAt + GLIDE_MS) {
        // Gliding in from where it was when its letter's turn came.
        const [fromX, fromY] = loosePosition(layout, index, cycle, formsAt);
        const k = easeOut((t - formsAt) / GLIDE_MS);
        x = mix(fromX, piece.x, k);
        y = mix(fromY, piece.y, k);
        ink = k;
      } else if (t >= dissolveAt) {
        // Drifting out to where it starts the next cycle.
        const [toX, toY] = looseCell(layout, index, cycle + 1, 0);
        const k = easeInOut((t - dissolveAt) / GLIDE_MS);
        x = mix(piece.x, toX, k);
        y = mix(piece.y, toY, k);
        ink = 1 - k;
      }
    }
    context.fillStyle = shades[Math.round(ink * SHADES)];
    context.fillRect((layout.left[piece.letter] + x) * pitch, y * pitch, side, side);
  });
}

function reducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// Sizes the canvas for the text and animates it; returns a stop. Options: pitch (px from one pixel
// to the next, default 2.5), piece (px, a piece's side, default 80% of pitch), loose and ink
// ([r, g, b]). Under reduced motion it draws the formed text once.
function startMosaicText(canvas, text, options = {}) {
  const context = canvas?.getContext?.("2d");
  if (!context) return () => {};
  const layout = layoutMosaicText(text);
  const pitch = options.pitch || 2.5;
  const size = { pitch, piece: options.piece || pitch * 0.8 };
  const shades = shadeColors(options.loose || [165, 186, 208], options.ink || [60, 74, 90]);
  // Whole CSS pixels, so the canvas is never resampled, and sharp on high-density screens.
  const width = Math.ceil(layout.widthCols * pitch);
  const height = Math.ceil(ROWS * pitch);
  const ratio = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (reducedMotion()) {
    drawMosaicText(context, layout, shades, size, 0, true);
    return () => {};
  }
  const startedAt = performance.now();
  let frame = 0;
  const tick = (now) => {
    drawMosaicText(context, layout, shades, size, now - startedAt);
    frame = requestAnimationFrame(tick);
  };
  tick(startedAt);
  return () => cancelAnimationFrame(frame);
}

export { GLYPHS, drawMosaicText, layoutMosaicText, shadeColors, startMosaicText };
