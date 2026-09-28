import "../styles/boot-splash.css";
import { animateGhostMark, ghostMarkSVG } from "../core/ghost-mark";

// The loader is the icon itself, the ghost drifting through its lines. A fast load shows nothing:
// the icon appears only after REVEAL_MS, whole and still, and the drift eases in from there. Once
// shown it stays at least MIN_SHOWN_MS, so it never flickers. Anyone who prefers reduced motion
// gets the still icon.
const REVEAL_MS = 300;
const MIN_SHOWN_MS = 500;
const EASE_IN_MS = 600;

const bootSplashMarkup = `
  <div class="boot-splash" role="status" aria-live="polite" aria-label="Loading application" aria-busy="true">
    <div class="boot-splash__center" aria-hidden="true">${ghostMarkSVG({ className: "boot-splash__logo" })}</div>
  </div>
`;

let stopDrift = null;
let mountedAt = 0;

function mountBootSplash(target) {
  if (!target) {
    return;
  }
  target.innerHTML = bootSplashMarkup;
  target.style.setProperty("--boot-reveal", `${REVEAL_MS}ms`);
  mountedAt = performance.now();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const logo = target.querySelector(".boot-splash__logo");
  if (logo && !reduced) {
    stopDrift = animateGhostMark(logo, { delay: REVEAL_MS, ease: EASE_IN_MS });
  }
}

function clear(target) {
  stopDrift?.();
  stopDrift = null;
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

const BootSplash = {
  name: "BootSplash",
  template: bootSplashMarkup,
};

export { bootSplashMarkup, mountBootSplash, dismissBootSplash };

export default BootSplash;
