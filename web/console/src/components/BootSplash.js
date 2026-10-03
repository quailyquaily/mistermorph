import "../styles/boot-splash.css";
import { startMosaicText } from "../core/mosaic-text";

// The startup loader: "morph is loading" assembled from mosaic pieces (core/mosaic-text.js).
//
// A fast load shows nothing: the loader appears only after REVEAL_MS, and once shown it stays at
// least MIN_SHOWN_MS, so it never flickers. With reduced motion it shows the words, still.
const REVEAL_MS = 300;
const MIN_SHOWN_MS = 500;

const TEXT = "morph is loading";

const bootSplashMarkup = `
  <div class="boot-splash" role="status" aria-live="polite" aria-label="Loading application" aria-busy="true">
    <div class="boot-splash__center" aria-hidden="true"><canvas class="boot-mosaic"></canvas></div>
  </div>
`;

// Quail's theme is not loaded yet at startup, so the morph theme's colours are written out:
// loose pieces in the line colour #a5bad0, formed letters in ink #3c4a5a.
function startMosaic(element) {
  return startMosaicText(element.querySelector(".boot-mosaic"), TEXT, {
    loose: [165, 186, 208],
    ink: [60, 74, 90],
  });
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
