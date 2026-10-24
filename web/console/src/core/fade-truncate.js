// v-fade-truncate: a one-line text that does not fit fades out over its last letters instead of
// ending in "…" (styles/base.css). The element is marked "is-truncated" only while its text
// overflows, so a text that fits is never faded; while it is cut, the full text is its tooltip
// unless the element has a tooltip of its own. One ResizeObserver serves every element.

const STATE = Symbol("fadeTruncate");
let observer = null;

function check(el) {
  const state = el[STATE];
  if (!state) {
    return;
  }
  const truncated = el.scrollWidth > el.clientWidth + 0.5;
  state.truncated = truncated;
  el.classList.toggle("is-truncated", truncated);
  const text = el.textContent.trim();
  if (truncated && text && (!el.hasAttribute("title") || state.ownTitle)) {
    el.setAttribute("title", text);
    state.ownTitle = true;
  } else if (!truncated && state.ownTitle) {
    el.removeAttribute("title");
    state.ownTitle = false;
  }
}

function sharedObserver() {
  if (!observer && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        check(entry.target);
      }
    });
  }
  return observer;
}

const vFadeTruncate = {
  mounted(el) {
    el[STATE] = { ownTitle: false, text: el.textContent };
    el.classList.add("fade-truncate");
    sharedObserver()?.observe(el);
    requestAnimationFrame(() => check(el));
  },
  updated(el) {
    const state = el[STATE];
    if (!state) {
      return;
    }
    // A :class binding may have replaced the classes. The parent re-renders often (a streaming
    // reply re-renders the whole chat), so the text is measured again only when it changed; a
    // change of size is the ResizeObserver's.
    el.classList.add("fade-truncate");
    el.classList.toggle("is-truncated", state.truncated === true);
    if (el.textContent !== state.text) {
      state.text = el.textContent;
      requestAnimationFrame(() => check(el));
    }
  },
  unmounted(el) {
    observer?.unobserve(el);
    delete el[STATE];
  },
};

export { vFadeTruncate };
