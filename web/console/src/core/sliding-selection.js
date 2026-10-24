// v-sliding-selection: one highlight behind a list, which glides from the selected item to the
// next instead of each item lighting up on its own. It takes the item's position and size, so it
// stretches between rows of different heights, and follows the list as it changes: items added or
// removed, a new selection, a resize. The first placement, and a selection after none, sets it in
// place without motion, and so does reduced motion.
//
//   <div class="workspace-sidebar-list" v-sliding-selection>            (selects ".is-active")
//   <div class="sidebar-nav" v-sliding-selection="'.nav-link.is-active'">
//
// The glide is a FLIP: the highlight takes the new item's box at once, then a transform carries it
// from where it was (mid-glide included) to there. Only the transform animates, so the compositor
// runs it and it stays smooth while the page the click opened is still rendering. The list becomes a
// stacking context with the highlight at its back, so items paint over it; the items' own selected
// background gives way to it (styles/base.css).

const STATE = Symbol("slidingSelection");
const DEFAULT_SELECTOR = ".is-active";
const GLIDE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

function selectorOf(binding) {
  return typeof binding?.value === "string" && binding.value.trim() ? binding.value.trim() : DEFAULT_SELECTOR;
}

// The glide's length: the --motion-slow token, which reduced motion sets to 0.
function glideDuration(indicator) {
  const value = getComputedStyle(indicator).getPropertyValue("--motion-slow").trim();
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : 260;
}

// A box in the list's coordinates, which scroll with its content.
function boxIn(el, rect, listRect) {
  return {
    x: rect.left - listRect.left + el.scrollLeft - el.clientLeft,
    y: rect.top - listRect.top + el.scrollTop - el.clientTop,
    w: rect.width,
    h: rect.height,
  };
}

function sameBox(a, b) {
  return (
    a && b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5
  );
}

function place(state) {
  state.frame = 0;
  const { el, indicator } = state;
  if (!el.isConnected) {
    return;
  }
  const target = el.querySelector(state.selector);
  if (!target || target.offsetParent === null) {
    state.animation?.cancel();
    indicator.classList.remove("is-shown");
    state.shown = false;
    state.box = null;
    return;
  }
  const listRect = el.getBoundingClientRect();
  const box = boxIn(el, target.getBoundingClientRect(), listRect);
  if (state.target !== target) {
    if (state.target) {
      state.resizer?.unobserve(state.target);
    }
    state.target = target;
    state.resizer?.observe(target);
  }
  // The list changed but the selection did not move: leave a glide in flight alone.
  if (state.shown && sameBox(state.box, box)) {
    return;
  }
  // Where the highlight is now: mid-glide, its animated box; at rest, the box it took.
  let from = null;
  if (state.shown && state.box) {
    from = state.animation?.playState === "running" ? boxIn(el, indicator.getBoundingClientRect(), listRect) : state.box;
  }
  state.animation?.cancel();
  indicator.style.width = `${box.w}px`;
  indicator.style.height = `${box.h}px`;
  indicator.style.transform = `translate(${box.x}px, ${box.y}px)`;
  indicator.style.borderRadius = getComputedStyle(target).borderRadius;
  indicator.classList.add("is-shown");
  state.shown = true;
  state.box = box;
  const duration = glideDuration(indicator);
  if (from && duration > 0 && box.w > 0 && box.h > 0 && typeof indicator.animate === "function") {
    state.animation = indicator.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px) scale(${from.w / box.w}, ${from.h / box.h})` },
        { transform: `translate(${box.x}px, ${box.y}px)` },
      ],
      { duration, easing: GLIDE_EASING },
    );
  }
}

function schedule(state) {
  if (!state.frame) {
    state.frame = requestAnimationFrame(() => place(state));
  }
}

const vSlidingSelection = {
  mounted(el, binding) {
    const indicator = document.createElement("span");
    indicator.className = "sliding-selection";
    indicator.setAttribute("aria-hidden", "true");
    el.prepend(indicator);
    el.classList.add("has-sliding-selection");
    const state = { el, indicator, selector: selectorOf(binding), frame: 0, shown: false, target: null, box: null, animation: null };
    // The highlight's own class changes are not the list's.
    state.mutations = new MutationObserver((records) => {
      if (records.some((record) => record.target !== indicator)) {
        schedule(state);
      }
    });
    state.mutations.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    if (typeof ResizeObserver !== "undefined") {
      state.resizer = new ResizeObserver(() => schedule(state));
      state.resizer.observe(el);
    }
    el[STATE] = state;
    schedule(state);
  },
  updated(el, binding) {
    const state = el[STATE];
    if (!state) {
      return;
    }
    // A :class binding on the list replaces its classes when it changes.
    el.classList.add("has-sliding-selection");
    // Vue may have moved its own nodes in front of the highlight; it belongs at the back.
    if (el.firstChild !== state.indicator) {
      el.prepend(state.indicator);
    }
    // A new selection, items added or removed, a class change: the mutation observer sees those,
    // so a parent render (often, while a reply streams) measures nothing unless the selector did.
    const selector = selectorOf(binding);
    if (selector !== state.selector) {
      state.selector = selector;
      schedule(state);
    }
  },
  unmounted(el) {
    const state = el[STATE];
    if (!state) {
      return;
    }
    cancelAnimationFrame(state.frame);
    state.animation?.cancel();
    state.mutations.disconnect();
    state.resizer?.disconnect?.();
    state.indicator.remove();
    delete el[STATE];
  },
};

export { vSlidingSelection };
