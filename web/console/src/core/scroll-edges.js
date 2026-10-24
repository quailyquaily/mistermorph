// v-scroll-edges: marks a scrolling element with which of its edges hide content, so CSS can soften
// only those edges (styles/base.css): "is-scrolled" while content is scrolled away above, and
// "has-more-end" while there is more below. A list under a pinned head shows the head's hairline
// instead of a top fade. It follows scrolling, resizes and content changes (new messages, a filter).

const STATE = Symbol("scrollEdges");

function update(state) {
  state.frame = 0;
  const { el } = state;
  if (!el.isConnected) {
    return;
  }
  state.scrolled = el.scrollTop > 1;
  state.more = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  mark(state);
}

function mark(state) {
  state.el.classList.add("has-scroll-edges");
  state.el.classList.toggle("is-scrolled", state.scrolled === true);
  state.el.classList.toggle("has-more-end", state.more === true);
}

function schedule(state) {
  if (!state.frame) {
    state.frame = requestAnimationFrame(() => update(state));
  }
}

const vScrollEdges = {
  mounted(el) {
    const state = { el, frame: 0 };
    state.onScroll = () => schedule(state);
    el.addEventListener("scroll", state.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      state.resizer = new ResizeObserver(() => schedule(state));
      state.resizer.observe(el);
    }
    state.mutations = new MutationObserver(() => schedule(state));
    state.mutations.observe(el, { subtree: true, childList: true, characterData: true });
    el[STATE] = state;
    update(state);
  },
  updated(el) {
    // A :class binding replaces the element's classes when it changes; put back what is known.
    // Scrolling, resizes and content changes are the listeners' and observers', so a parent render
    // (often, while a reply streams) reads no layout.
    const state = el[STATE];
    if (state) {
      mark(state);
    }
  },
  unmounted(el) {
    const state = el[STATE];
    if (!state) {
      return;
    }
    cancelAnimationFrame(state.frame);
    el.removeEventListener("scroll", state.onScroll);
    state.resizer?.disconnect?.();
    state.mutations.disconnect();
    delete el[STATE];
  },
};

export { vScrollEdges };
