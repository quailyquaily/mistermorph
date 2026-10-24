// Dialogs grow out of the control that opened them and shrink back into it, rather than appearing
// from nowhere in the middle of the window. The control last pressed (or activated from the
// keyboard) is remembered for a moment; when a dialog appears within that moment, its scale is
// anchored on the control (styles/base.css runs the motion, from a smaller scale than a dialog
// opened any other way). The origin is set before the dialog's first frame, from the observer's
// microtask.

const RECENT_MS = 900;

function installDialogOrigin(doc = typeof document === "undefined" ? null : document) {
  if (!doc?.body || doc.documentElement.dataset.appDialogOrigin) {
    return;
  }
  doc.documentElement.dataset.appDialogOrigin = "on";
  let source = null;
  let at = 0;

  const remember = (event) => {
    const el = event.target?.closest?.("button, a, [role='button'], [role='menuitem'], .q-dropdown-menu-action");
    if (el) {
      source = el;
      at = performance.now();
    }
  };
  doc.addEventListener("pointerdown", remember, { capture: true, passive: true });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      remember(event);
    }
  }, { capture: true });

  const anchor = (dialog) => {
    if (!source?.isConnected || performance.now() - at > RECENT_MS || dialog.contains(source)) {
      return;
    }
    const from = source.getBoundingClientRect();
    const box = dialog.getBoundingClientRect();
    if (!box.width || !box.height) {
      return;
    }
    const x = from.left + from.width / 2 - box.left;
    const y = from.top + from.height / 2 - box.top;
    dialog.style.transformOrigin = `${Math.round(x)}px ${Math.round(y)}px`;
    dialog.classList.add("is-from-source");
  };

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) {
          continue;
        }
        const dialogs = node.matches?.(".q-dialog") ? [node] : [...(node.querySelectorAll?.(".q-dialog") || [])];
        dialogs.forEach(anchor);
      }
    }
  }).observe(doc.body, { childList: true, subtree: true });
}

export { installDialogOrigin };
