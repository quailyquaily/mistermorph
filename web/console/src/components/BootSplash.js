import "../styles/boot-splash.css";

// The startup loader: the name, assembled from mosaic pieces. Each letter is a 5x7 pixel glyph
// whose pixels are loose pieces: they hop about the letter's box, then, letter by letter, glide to
// their places and darken, so the word forms out of its own mosaic. It holds, drifts apart into
// pieces again, and forms again.
//
// A fast load shows nothing: the loader appears only after REVEAL_MS, and once shown it stays at
// least MIN_SHOWN_MS, so it never flickers. With reduced motion it shows the word, still.
const REVEAL_MS = 300;
const MIN_SHOWN_MS = 500;

const WORD = "morph is loading";
const GLYPHS = {
  m: [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#...#"],
  r: [".....", ".....", "#.##.", "##..#", "#....", "#....", "#...."],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  p: [".....", ".....", "####.", "#...#", "####.", "#....", "#...."],
  h: ["#....", "#....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  i: ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
  s: [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
  l: [".##..", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  a: [".....", ".....", ".###.", "....#", ".####", "#...#", ".####"],
  d: ["....#", "....#", ".##.#", "#..##", "#...#", "#...#", ".####"],
  n: [".....", ".....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  g: [".....", ".....", ".####", "#...#", ".####", "....#", ".###."],
  " ": ["..", "..", "..", "..", "..", "..", ".."],
};

const PIECE = 2; // px, a piece's side
const PITCH = 2.5; // px, from one pixel to the next
const LETTER_GAP = 1; // columns between letters
const ROWS = 7;
// Where each character starts, in pixel columns; a glyph is as wide as its rows (a space is narrow).
const LETTER_COLS = [...WORD].map((letter) => GLYPHS[letter][0].length);
const LETTER_LEFT = LETTER_COLS.map((_, index) =>
  LETTER_COLS.slice(0, index).reduce((sum, cols) => sum + cols + LETTER_GAP, 0)
);
// Whole pixels, so the canvas is never resampled.
const WIDTH = Math.ceil((LETTER_LEFT[LETTER_LEFT.length - 1] + LETTER_COLS[LETTER_COLS.length - 1]) * PITCH);
const HEIGHT = Math.ceil(ROWS * PITCH);

const LOOSE = [165, 186, 208]; // #a5bad0, the theme's line colour
const INK = [60, 74, 90]; // #3c4a5a

const HOP_MS = 260; // loose pieces glide to a new cell this often
const SCRAMBLE_MS = 600; // before the first letter forms
const FORM_EVERY_MS = 70; // between letters starting to form
const GLIDE_MS = 420; // a piece gliding into place, or out of it
const HOLD_MS = 1000;
const CYCLE_MS = SCRAMBLE_MS + (WORD.length - 1) * FORM_EVERY_MS + GLIDE_MS + HOLD_MS + GLIDE_MS;

// Every piece: its letter and the pixel it belongs to.
const PIECES = [...WORD].flatMap((letter, index) =>
  GLYPHS[letter].flatMap((row, y) =>
    [...row].flatMap((cell, x) => (cell === "#" ? [{ letter: index, x, y }] : []))
  )
);

const bootSplashMarkup = `
  <div class="boot-splash" role="status" aria-live="polite" aria-label="Loading application" aria-busy="true">
    <div class="boot-splash__center" aria-hidden="true">
      <canvas class="boot-mosaic" width="${WIDTH}" height="${HEIGHT}" style="width:${WIDTH}px;height:${HEIGHT}px"></canvas>
    </div>
  </div>
`;

// A repeatable random number in [0, 1) for a piece at a moment.
function noise(piece, cycle, hop) {
  let h = Math.imul(piece + 1, 374761393) ^ Math.imul(cycle + 7, 668265263) ^ Math.imul(hop + 13, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Where a loose piece is headed at a hop: any cell of its letter's box.
function looseCell(index, cycle, hop) {
  const cols = LETTER_COLS[PIECES[index].letter];
  return [Math.floor(noise(index, cycle, hop) * cols), Math.floor(noise(index + 9973, cycle, hop) * ROWS)];
}

// Where a loose piece is at time t of a cycle: gliding from one hop's cell to the next.
function loosePosition(index, cycle, t) {
  const hop = Math.floor(t / HOP_MS);
  const [fromX, fromY] = looseCell(index, cycle, hop);
  const [toX, toY] = looseCell(index, cycle, hop + 1);
  const k = easeInOut((t - hop * HOP_MS) / HOP_MS);
  return [mix(fromX, toX, k), mix(fromY, toY, k)];
}

// The colour from loose to ink in fixed steps, made once, so drawing builds no strings.
const SHADES = 24;
const SHADE_COLORS = Array.from({ length: SHADES + 1 }, (_, step) =>
  `rgb(${LOOSE.map((channel, c) => Math.round(channel + (INK[c] - channel) * (step / SHADES))).join(",")})`
);

function easeOut(t) {
  return 1 - (1 - t) ** 3;
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Draws the word at a moment of the cycle; formed draws it whole and still.
function drawMosaic(context, elapsed, formed = false) {
  context.clearRect(0, 0, WIDTH, HEIGHT);
  const cycle = Math.floor(elapsed / CYCLE_MS);
  const t = elapsed % CYCLE_MS;
  const dissolveAt = CYCLE_MS - GLIDE_MS;
  PIECES.forEach((piece, index) => {
    const formsAt = SCRAMBLE_MS + piece.letter * FORM_EVERY_MS;
    let x = piece.x;
    let y = piece.y;
    let ink = 1;
    if (!formed) {
      if (t < formsAt) {
        [x, y] = loosePosition(index, cycle, t);
        ink = 0;
      } else if (t < formsAt + GLIDE_MS) {
        // Gliding in from where it was when the letter's turn came.
        const [fromX, fromY] = loosePosition(index, cycle, formsAt);
        const k = easeOut((t - formsAt) / GLIDE_MS);
        x = mix(fromX, piece.x, k);
        y = mix(fromY, piece.y, k);
        ink = k;
      } else if (t >= dissolveAt) {
        // Drifting out to where it starts the next cycle.
        const [toX, toY] = looseCell(index, cycle + 1, 0);
        const k = easeInOut((t - dissolveAt) / GLIDE_MS);
        x = mix(piece.x, toX, k);
        y = mix(piece.y, toY, k);
        ink = 1 - k;
      }
    }
    const left = (LETTER_LEFT[piece.letter] + x) * PITCH;
    context.fillStyle = SHADE_COLORS[Math.round(ink * SHADES)];
    context.fillRect(left, y * PITCH, PIECE, PIECE);
  });
}

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// Animates the mosaic in element; returns its stop.
function startMosaic(element) {
  const canvas = element.querySelector(".boot-mosaic");
  const context = canvas?.getContext("2d");
  if (!context) return () => {};
  // Sharp on high-density screens.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(WIDTH * ratio);
  canvas.height = Math.round(HEIGHT * ratio);
  context.scale(ratio, ratio);
  if (reducedMotion()) {
    drawMosaic(context, 0, true);
    return () => {};
  }
  const startedAt = performance.now();
  let frame = 0;
  const tick = (now) => {
    drawMosaic(context, now - startedAt);
    frame = window.requestAnimationFrame(tick);
  };
  tick(startedAt);
  return () => window.cancelAnimationFrame(frame);
}

let mountedAt = 0;
let stopMosaic = () => {};

function mountBootSplash(target) {
  if (!target) {
    return;
  }
  target.innerHTML = bootSplashMarkup;
  target.style.setProperty("--boot-reveal", `${REVEAL_MS}ms`);
  mountedAt = performance.now();
  stopMosaic = startMosaic(target);
}

function clear(target) {
  stopMosaic();
  stopMosaic = () => {};
  target.innerHTML = "";
}

function dismissBootSplash(target) {
  if (!target) {
    return Promise.resolve();
  }
  const splash = target.firstElementChild;
  const shownFor = performance.now() - mountedAt - REVEAL_MS;
  // Not revealed yet: remove it before it ever shows.
  if (!splash || shownFor < 0) {
    clear(target);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clear(target);
      resolve();
    };
    window.setTimeout(() => {
      splash.addEventListener("transitionend", finish, { once: true });
      splash.classList.add("is-exiting");
      window.setTimeout(finish, 320);
    }, Math.max(0, MIN_SHOWN_MS - shownFor));
  });
}

// /__boot-preview: the loader on its own, running.
const BootSplash = {
  name: "BootSplash",
  mounted() {
    this.$el.innerHTML = bootSplashMarkup;
    this.stop = startMosaic(this.$el);
  },
  unmounted() {
    this.stop?.();
  },
  template: `<div class="boot-splash-preview"></div>`,
};

export { bootSplashMarkup, mountBootSplash, dismissBootSplash };

export default BootSplash;
