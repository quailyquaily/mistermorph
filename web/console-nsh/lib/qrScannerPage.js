// The page the QR scanner's web view shows (pages/login/QrScanner.tsx): the camera's picture, and
// the browser's own detector (`BarcodeDetector`) reading it. nsh has neither a camera nor a
// decoder, a web view's page has both where the system's browser does, so the camera is asked for
// in there and the app only hears what was read (lib/qrScan.ts takes the messages).
//
// The page tells the app, as JSON through `window.nsh.postMessage`:
//   { type: "ready" }                    the camera runs and codes are looked for
//   { type: "result", text }             the first QR code read; the camera is released first
//   { type: "error", code, detail }      why there is no scan; the camera is released first
// with `code` one of "unsupported" (no camera API, no detector, no QR format), "denied" (the
// permission), "no_camera", "busy" (another app holds it), "interrupted" (the page was hidden or
// the camera taken away) and "failed". The app tells the page "stop" (a `message` event): the
// camera is released and nothing more is said. A permission answered after "stop" releases what it
// was given at once. The page reads no address, opens no link and sends nothing anywhere.
//
// Kept as text: the app's own code is compiled, so a function's source cannot be taken from it.
// lib/qrScannerPage.test.mjs runs this text against a browser made of fakes.

/** How often a frame is looked at, in milliseconds. */
export const SCAN_INTERVAL_MS = 160;

export const SCANNER_SCRIPT = `(function () {
  var video = document.getElementById("camera");
  var stream = null;
  var detector = null;
  var stopped = false;
  var timer = 0;

  function post(message) {
    try {
      window.nsh.postMessage(JSON.stringify(message));
    } catch (error) {}
  }

  function stopTracks(media) {
    try {
      media.getTracks().forEach(function (track) {
        try {
          track.stop();
        } catch (error) {}
      });
    } catch (error) {}
  }

  function release() {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (stream) stopTracks(stream);
    stream = null;
    if (video) {
      try {
        video.pause();
      } catch (error) {}
      try {
        video.srcObject = null;
      } catch (error) {}
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    release();
  }

  function fail(code, detail) {
    if (stopped) return;
    stop();
    post({ type: "error", code: code, detail: String(detail || "") });
  }

  function codeOf(error) {
    var name = String((error && error.name) || "");
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "no_camera";
    if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
    return "failed";
  }

  function later() {
    if (stopped) return;
    timer = setTimeout(look, ${SCAN_INTERVAL_MS});
  }

  function look() {
    timer = 0;
    if (stopped) return;
    if (!video || video.readyState < 2) return later();
    var found;
    try {
      found = detector.detect(video);
    } catch (error) {
      return later();
    }
    Promise.resolve(found).then(
      function (codes) {
        if (stopped) return;
        for (var i = 0; codes && i < codes.length; i++) {
          var text = codes[i] && codes[i].rawValue;
          if (typeof text === "string" && text) {
            stop();
            post({ type: "result", text: text });
            return;
          }
        }
        later();
      },
      // A frame that could not be read: the next one may.
      function () {
        later();
      },
    );
  }

  function start() {
    var media = navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== "function") return fail("unsupported", "camera");
    if (typeof window.BarcodeDetector !== "function") return fail("unsupported", "detector");
    var Detector = window.BarcodeDetector;
    Promise.resolve()
      .then(function () {
        return typeof Detector.getSupportedFormats === "function" ? Detector.getSupportedFormats() : ["qr_code"];
      })
      .then(function (formats) {
        if (stopped) return;
        if (!formats || formats.indexOf("qr_code") < 0) return fail("unsupported", "format");
        detector = new Detector({ formats: ["qr_code"] });
        return media.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } }).then(function (got) {
          // Answered after the scanner was closed: the camera is not kept.
          if (stopped) return stopTracks(got);
          stream = got;
          got.getTracks().forEach(function (track) {
            if (typeof track.addEventListener !== "function") return;
            track.addEventListener("ended", function () {
              fail("interrupted", "ended");
            });
          });
          video.srcObject = got;
          var playing;
          try {
            playing = video.play();
          } catch (error) {}
          if (playing && typeof playing.catch === "function") playing.catch(function () {});
          post({ type: "ready" });
          later();
        });
      })
      .catch(function (error) {
        fail(codeOf(error), (error && error.name) || error);
      });
  }

  window.addEventListener("message", function (event) {
    if (event && event.data === "stop") stop();
  });
  window.addEventListener("pagehide", function () {
    fail("interrupted", "pagehide");
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) fail("interrupted", "hidden");
  });
  start();
})();`;

/** The scanner's page: the camera's picture edge to edge with a frame to aim with, and the script. */
export function scannerPage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
html, body { margin: 0; height: 100%; background: #111318; overflow: hidden; }
video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.aim { position: absolute; left: 50%; top: 50%; width: 62%; aspect-ratio: 1; max-height: 78%; transform: translate(-50%, -50%);
  border: 2px solid rgba(255, 255, 255, 0.85); border-radius: 14px; box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.28); }
</style>
</head>
<body>
<video id="camera" playsinline muted autoplay></video>
<div class="aim"></div>
<script>${SCANNER_SCRIPT}</script>
</body>
</html>`;
}
