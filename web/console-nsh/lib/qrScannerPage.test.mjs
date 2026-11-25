// The QR scanner's page (lib/qrScannerPage.js) against a browser made of fakes: what it tells the
// app, and that the camera is released whenever a scan ends, however it ends.
//   node --test lib/qrScannerPage.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { PIXEL_SIDE, SCAN_INTERVAL_MS, SCANNER_SCRIPT, scannerPage } from "./qrScannerPage.js";
import { JSQR_SOURCE } from "./vendor/jsqr.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function named(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

function fakeStream() {
  const listeners = [];
  const track = {
    stopped: 0,
    stop() {
      this.stopped++;
    },
    addEventListener(name, listener) {
      if (name === "ended") listeners.push(listener);
    },
  };
  return { track, getTracks: () => [track], end: () => listeners.forEach((listener) => listener()) };
}

/**
 * A page: `camera` is what getUserMedia answers (a stream, an error, or a promise of either; null
 * for a browser without it), `detector` false for a browser without BarcodeDetector, `formats`
 * what it reads, `frames` what each look at the picture finds. `jsQR`: a stand-in for jsQR (the
 * page's other script), told each frame's pixels as a canvas gives them, answering from `frames`.
 */
function page({ camera, detector = true, formats = ["qr_code"], frames = [], jsQR = false } = {}) {
  const posts = [];
  const timers = new Map();
  let nextTimer = 1;
  const windowListeners = {};
  const documentListeners = {};
  const asked = [];
  const looks = [];
  const drawn = [];
  const video = {
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: 4,
    srcObject: null,
    paused: false,
    play() {
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };
  const document = {
    hidden: false,
    getElementById: (id) => (id === "camera" ? video : null),
    createElement: (name) => {
      const canvas = { name, width: 0, height: 0 };
      canvas.getContext = () => ({
        drawImage: (source, x, y, w, h) => drawn.push({ source, w, h }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      });
      return canvas;
    },
    addEventListener: (name, listener) => (documentListeners[name] = listener),
  };
  const window = {
    nsh: { postMessage: (data) => posts.push(JSON.parse(data)) },
    addEventListener: (name, listener) => (windowListeners[name] = listener),
  };
  if (jsQR) {
    window.jsQR = (data, w, h, options) => {
      looks.push({ pixels: data.length, w, h, options });
      const next = frames.length ? frames.shift() : null;
      if (next instanceof Error) throw next;
      return next;
    };
  }
  if (detector) {
    window.BarcodeDetector = class {
      static getSupportedFormats() {
        return Promise.resolve(formats);
      }
      constructor(options) {
        this.options = options;
      }
      detect(source) {
        looks.push(source);
        const next = frames.length ? frames.shift() : [];
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
    };
  }
  const navigator =
    camera === null
      ? {}
      : {
          mediaDevices: {
            getUserMedia(constraints) {
              asked.push(constraints);
              return Promise.resolve(camera).then((got) => {
                if (got instanceof Error) throw got;
                return got;
              });
            },
          },
        };
  const context = vm.createContext({
    window,
    document,
    navigator,
    Promise,
    JSON,
    String,
    Math,
    Uint8ClampedArray,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(SCANNER_SCRIPT, context);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    posts,
    video,
    asked,
    looks,
    drawn,
    timers,
    settle,
    /** Runs the pending look at the picture, if one is due. */
    async tick() {
      const [id, timer] = [...timers.entries()][0] ?? [];
      if (!timer) return false;
      timers.delete(id);
      timer.fn();
      await settle();
      return true;
    },
    say: (data) => windowListeners.message?.({ data }),
    hide() {
      document.hidden = true;
      documentListeners.visibilitychange?.();
    },
    leave: () => windowListeners.pagehide?.(),
  };
}

test("the page is one document with the script in it, and asks for nothing but the camera", () => {
  const html = scannerPage();
  assert.match(html, /<video id="camera" playsinline muted autoplay><\/video>/);
  assert.ok(html.includes(SCANNER_SCRIPT));
  // jsQR, whole, before the scanner's script; it has no `</script` that could end its element.
  assert.ok(html.includes(JSQR_SOURCE));
  assert.ok(html.indexOf(JSQR_SOURCE) < html.indexOf(SCANNER_SCRIPT));
  assert.equal(/<\/script/i.test(JSQR_SOURCE), false);
  // No address is read, opened or sent from the page: its own parts, and jsQR (whose "location" is
  // a finder pattern's, never the page's).
  const own = html.replace(JSQR_SOURCE, "");
  for (const word of ["fetch(", "XMLHttpRequest", "location", "WebSocket", "sendBeacon", "localStorage", "cookie", "<a ", "src="]) {
    assert.ok(!own.includes(word), word);
  }
  for (const word of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "localStorage", "cookie", "window.location", "document.location", "location.href", "eval(", "new Function"]) {
    assert.ok(!JSQR_SOURCE.includes(word), `jsQR: ${word}`);
  }
});

test("without BarcodeDetector jsQR reads the frames' pixels, a small copy of each, and the first code is told", async () => {
  const stream = fakeStream();
  const p = page({ camera: stream, detector: false, jsQR: true, frames: [null, { data: "" }, { data: "https://morph.example.com" }] });
  await p.settle();
  assert.deepEqual(p.posts, [{ type: "ready" }]);
  for (let i = 0; i < 3; i++) await p.tick();
  assert.deepEqual(p.posts, [{ type: "ready" }, { type: "result", text: "https://morph.example.com" }]);
  assert.equal(stream.track.stopped, 1);
  // A 1920 × 1080 frame is read at PIXEL_SIDE on its long side, the picture itself drawn.
  const side = Math.round((1080 * PIXEL_SIDE) / 1920);
  assert.deepEqual(p.drawn.map(({ source, w, h }) => [source === p.video, w, h]), [[true, PIXEL_SIDE, side], [true, PIXEL_SIDE, side], [true, PIXEL_SIDE, side]]);
  assert.equal(JSON.stringify(p.looks[0]), JSON.stringify({ pixels: PIXEL_SIDE * side * 4, w: PIXEL_SIDE, h: side, options: { inversionAttempts: "dontInvert" } }));
});

/** A QR code's modules (true: dark), row by row, from lib/vendor/qrcode.js. */
async function qrModules(text) {
  const { create } = await import("./vendor/qrcode.js");
  const matrix = create(text, { errorCorrectionLevel: "M" }).modules;
  const modules = [];
  for (let y = 0; y < matrix.size; y++) {
    const row = [];
    for (let x = 0; x < matrix.size; x++) row.push(Boolean(matrix.get(y, x)));
    modules.push(row);
  }
  return { modules };
}

test("the real jsQR reads a QR code from its pixels", async () => {
  // jsQR's own build, run as the page runs it (a global jsQR), on a code drawn by lib/vendor/qrcode.js.
  const context = vm.createContext({ self: {}, Uint8ClampedArray, Math, Array, Object, Number, String, Error, Int32Array, Uint8Array, Float32Array });
  vm.runInContext(JSQR_SOURCE, context);
  const jsQR = context.self.jsQR;
  assert.equal(typeof jsQR, "function");
  const { modules } = await qrModules("https://morph.example.com:9080");
  const scale = 6;
  const quiet = 4;
  const side = (modules.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const at = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
          data[at] = data[at + 1] = data[at + 2] = 0;
        }
    }),
  );
  assert.equal(jsQR(data, side, side, { inversionAttempts: "dontInvert" })?.data, "https://morph.example.com:9080");
});

test("the camera starts, the first QR code is told, and the camera is released before it is", async () => {
  const stream = fakeStream();
  const p = page({ camera: stream, frames: [[], named("InvalidStateError"), [{ rawValue: "" }, { rawValue: "http://192.168.1.20:9080" }]] });
  await p.settle();
  // (The page's objects are another realm's: compared as JSON.)
  assert.equal(JSON.stringify(p.asked), JSON.stringify([{ audio: false, video: { facingMode: { ideal: "environment" } } }]));
  assert.deepEqual(p.posts, [{ type: "ready" }]);
  assert.equal(p.video.srcObject, stream);
  assert.equal([...p.timers.values()][0].ms, SCAN_INTERVAL_MS);
  // Nothing in the picture, then a frame that cannot be read: it keeps looking.
  await p.tick();
  await p.tick();
  assert.deepEqual(p.posts, [{ type: "ready" }]);
  assert.equal(stream.track.stopped, 0);
  await p.tick();
  assert.deepEqual(p.posts, [{ type: "ready" }, { type: "result", text: "http://192.168.1.20:9080" }]);
  assert.equal(stream.track.stopped, 1);
  assert.equal(p.video.srcObject, null);
  assert.equal(p.timers.size, 0);
  // Over: nothing more is looked at or said.
  assert.equal(await p.tick(), false);
  p.say("stop");
  p.hide();
  assert.equal(p.posts.length, 2);
  assert.equal(stream.track.stopped, 1);
});

test("the picture is not looked at before the camera gives one", async () => {
  const stream = fakeStream();
  const p = page({ camera: stream, frames: [[{ rawValue: "http://a.test" }]] });
  p.video.readyState = 0;
  await p.settle();
  await p.tick();
  assert.equal(p.looks.length, 0);
  p.video.readyState = 4;
  await p.tick();
  assert.equal(p.posts.at(-1).text, "http://a.test");
});

test("stop releases the camera and says nothing", async () => {
  const stream = fakeStream();
  const p = page({ camera: stream, frames: [[{ rawValue: "http://a.test" }]] });
  await p.settle();
  p.say("something else");
  assert.equal(stream.track.stopped, 0);
  p.say("stop");
  assert.equal(stream.track.stopped, 1);
  assert.equal(p.video.srcObject, null);
  assert.equal(p.timers.size, 0);
  p.say("stop");
  assert.equal(stream.track.stopped, 1);
  assert.deepEqual(p.posts, [{ type: "ready" }]);
});

test("a code read while the scanner closes is dropped", async () => {
  const stream = fakeStream();
  const found = deferred();
  // The look at the picture is still under way as the app says stop.
  const p = page({ camera: stream, frames: [found.promise] });
  await p.settle();
  const [id, pending] = [...p.timers.entries()][0];
  p.timers.delete(id);
  pending.fn();
  p.say("stop");
  found.resolve([{ rawValue: "http://a.test" }]);
  await p.settle();
  assert.equal(p.looks.length, 1);
  assert.deepEqual(p.posts, [{ type: "ready" }]);
  assert.equal(p.timers.size, 0);
  assert.equal(stream.track.stopped, 1);
});

test("a permission answered after stop releases the camera it was given at once", async () => {
  const stream = fakeStream();
  const answer = deferred();
  const p = page({ camera: answer.promise });
  await p.settle();
  assert.equal(p.asked.length, 1);
  p.say("stop");
  answer.resolve(stream);
  await p.settle();
  assert.equal(stream.track.stopped, 1);
  assert.equal(p.video.srcObject, null);
  assert.deepEqual(p.posts, []);
  assert.equal(p.timers.size, 0);
});

test("a permission refused after stop says nothing", async () => {
  const answer = deferred();
  const p = page({ camera: answer.promise });
  await p.settle();
  p.say("stop");
  answer.resolve(named("NotAllowedError"));
  await p.settle();
  assert.deepEqual(p.posts, []);
});

test("why there is no camera is told: refused, none, busy, anything else", async () => {
  const cases = [
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no_camera"],
    ["OverconstrainedError", "no_camera"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
    ["TypeError", "failed"],
  ];
  for (const [name, code] of cases) {
    const p = page({ camera: named(name) });
    await p.settle();
    assert.deepEqual(p.posts, [{ type: "error", code, detail: name }], name);
    assert.equal(p.timers.size, 0);
  }
});

test("a browser without a camera API, a detector or the QR format says unsupported and never asks for the camera", async () => {
  const none = page({ camera: null });
  await none.settle();
  assert.deepEqual(none.posts, [{ type: "error", code: "unsupported", detail: "camera" }]);

  const noDetector = page({ camera: fakeStream(), detector: false });
  await noDetector.settle();
  assert.deepEqual(noDetector.posts, [{ type: "error", code: "unsupported", detail: "detector" }]);
  assert.equal(noDetector.asked.length, 0);

  const noQr = page({ camera: fakeStream(), formats: ["ean_13"] });
  await noQr.settle();
  assert.deepEqual(noQr.posts, [{ type: "error", code: "unsupported", detail: "format" }]);
  assert.equal(noQr.asked.length, 0);
});

test("a hidden page, a page left and a camera taken away release the camera and say interrupted, once", async () => {
  for (const [what, act] of [
    ["hidden", (p) => p.hide()],
    ["pagehide", (p) => p.leave()],
    ["ended", (p, stream) => stream.end()],
  ]) {
    const stream = fakeStream();
    const p = page({ camera: stream });
    await p.settle();
    act(p, stream);
    assert.deepEqual(p.posts, [{ type: "ready" }, { type: "error", code: "interrupted", detail: what }], what);
    assert.equal(stream.track.stopped, 1, what);
    assert.equal(p.timers.size, 0, what);
    p.hide();
    p.leave();
    assert.equal(p.posts.length, 2, what);
  }
});
