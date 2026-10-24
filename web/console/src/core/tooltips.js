// Tooltips: every element's title shows as a small paper card instead of the browser's grey box.
// It appears after a short pause over the element (or at once when moving between tooltips),
// centred above it, below when there is no room, kept inside the window; keyboard focus shows it
// too, which a native tooltip never does. A shortcut at the end of the text, like "(Ctrl+K)" or
// "(Esc)", is set as key caps.
//
// While the pointer is over an element its title is lifted off, so the browser does not show its
// own tooltip as well, and put back when the pointer leaves; if the title was the element's only
// accessible name it stands in as aria-label meanwhile. Focus leaves the title in place (the
// browser shows nothing on focus). One listener set on the document serves the whole app.

const SHOW_DELAY = 420;
// Moving from one tooltip to the next within this time shows the next at once.
const WARM_WINDOW = 300;
const GAP = 6;
const EDGE = 8;
const SHORTCUT = /\s*\(((?:(?:Ctrl|Cmd|Alt|Option|Shift|Meta|⌘|⌥|⇧|⌃)\s*\+?\s*)*(?:[A-Z0-9]|Enter|Esc|Escape|Tab|Space|Delete|Backspace|↑|↓|←|→|\/|\?|,|\.))\)\s*$/;

function textOf(el) {
  return (el.dataset.tooltipText || el.getAttribute("title") || "").trim();
}

// splitShortcut splits a tooltip's text into its label and the keys of a shortcut at its end:
// "New topic (Ctrl+N)" is "New topic" and ["Ctrl", "N"].
function splitShortcut(text) {
  const match = String(text || "").match(SHORTCUT);
  if (!match) {
    return { label: String(text || ""), keys: [] };
  }
  return { label: text.slice(0, match.index), keys: match[1].split(/\s*\+\s*|\s+/).filter(Boolean) };
}

function renderInto(tip, text) {
  tip.textContent = "";
  const { label, keys: shortcut } = splitShortcut(text);
  tip.append(document.createTextNode(label));
  if (shortcut.length) {
    const keys = document.createElement("span");
    keys.className = "app-tooltip-keys";
    for (const key of shortcut) {
      const cap = document.createElement("kbd");
      cap.textContent = key;
      keys.append(cap);
    }
    tip.append(keys);
  }
}

function installTooltips(doc = typeof document === "undefined" ? null : document) {
  if (!doc?.body || doc.documentElement.dataset.appTooltips) {
    return;
  }
  doc.documentElement.dataset.appTooltips = "on";
  const tip = doc.createElement("div");
  tip.className = "app-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.id = "app-tooltip";
  doc.body.append(tip);

  let owner = null;
  let timer = 0;
  let hiddenAt = 0;

  function lift(el) {
    const title = el.getAttribute("title");
    if (title === null) {
      return;
    }
    el.dataset.tooltipText = title;
    el.removeAttribute("title");
    if (!el.hasAttribute("aria-label") && !el.textContent.trim()) {
      el.setAttribute("aria-label", title);
      el.dataset.tooltipLabel = "1";
    }
  }

  function restore(el) {
    if (el.dataset.tooltipText === undefined) {
      return;
    }
    // The page may have set a new title meanwhile; that one wins.
    if (!el.hasAttribute("title")) {
      el.setAttribute("title", el.dataset.tooltipText);
    }
    if (el.dataset.tooltipLabel) {
      el.removeAttribute("aria-label");
      delete el.dataset.tooltipLabel;
    }
    delete el.dataset.tooltipText;
  }

  function place(el) {
    const rect = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const view = doc.documentElement;
    let top = rect.top - box.height - GAP;
    let below = false;
    if (top < EDGE) {
      top = rect.bottom + GAP;
      below = true;
    }
    const left = Math.min(Math.max(rect.left + rect.width / 2 - box.width / 2, EDGE), view.clientWidth - box.width - EDGE);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    tip.classList.toggle("is-below", below);
  }

  function show(el) {
    const text = textOf(el);
    if (!text || !el.isConnected) {
      return;
    }
    renderInto(tip, text);
    tip.classList.remove("is-shown");
    tip.style.transform = "translate(-9999px, -9999px)";
    tip.style.display = "block";
    place(el);
    el.setAttribute("aria-describedby", tip.id);
    requestAnimationFrame(() => tip.classList.add("is-shown"));
  }

  function hide() {
    clearTimeout(timer);
    timer = 0;
    if (owner) {
      if (owner.getAttribute("aria-describedby") === tip.id) {
        owner.removeAttribute("aria-describedby");
      }
      restore(owner);
      if (tip.classList.contains("is-shown")) {
        hiddenAt = performance.now();
      }
      owner = null;
    }
    tip.classList.remove("is-shown");
    tip.style.display = "none";
  }

  function arm(el, viaPointer) {
    if (owner === el) {
      return;
    }
    hide();
    owner = el;
    if (viaPointer) {
      lift(el);
    }
    const warm = performance.now() - hiddenAt < WARM_WINDOW;
    timer = setTimeout(() => show(el), warm ? 0 : SHOW_DELAY);
  }

  const target = (node) => node?.closest?.("[title], [data-tooltip-text]");

  doc.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") {
      return;
    }
    const el = target(event.target);
    if (el && el !== owner) {
      arm(el, true);
    }
  });
  doc.addEventListener("pointerout", (event) => {
    if (owner && !owner.contains(event.relatedTarget)) {
      hide();
    }
  });
  doc.addEventListener("focusin", (event) => {
    const el = target(event.target);
    if (el && el.matches(":focus-visible")) {
      arm(el, false);
    }
  });
  doc.addEventListener("focusout", (event) => {
    if (owner && owner === event.target) {
      hide();
    }
  });
  for (const type of ["pointerdown", "wheel", "scroll"]) {
    doc.addEventListener(type, hide, { capture: true, passive: true });
  }
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide();
    }
  });
}

export { installTooltips, splitShortcut };
