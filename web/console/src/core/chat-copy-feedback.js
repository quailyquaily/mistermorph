// Copying a chat message: the clipboard write, and the short "copied" state its button shows.

export const COPY_FEEDBACK_DURATION_MS = 1200;

function saveSelection(doc) {
  const selection = typeof doc.getSelection === "function" ? doc.getSelection() : null;
  const ranges = [];
  for (let index = 0; index < (selection?.rangeCount || 0); index += 1) {
    ranges.push(selection.getRangeAt(index).cloneRange());
  }
  return { activeElement: doc.activeElement || null, ranges, selection };
}

function restoreSelection({ activeElement, ranges, selection }) {
  if (activeElement && typeof activeElement.focus === "function" && activeElement.isConnected !== false) {
    activeElement.focus({ preventScroll: true });
  }
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  for (const range of ranges) {
    selection.addRange(range);
  }
}

// Puts text on the clipboard. Resolves once it is there and rejects when it is not, so a caller
// only reports success for a copy that happened. Without the Clipboard API (or when it refuses),
// it copies from a hidden field and then gives the focus and selection back without scrolling.
export async function writeClipboardText(text, env = {}) {
  const nav = env.navigator ?? globalThis.navigator;
  const doc = env.document ?? globalThis.document;
  const value = String(text ?? "");
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to the copy command below.
    }
  }
  if (!doc?.body || typeof doc.execCommand !== "function") {
    throw new Error("Clipboard is unavailable.");
  }
  const saved = saveSelection(doc);
  const textarea = doc.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  doc.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    copied = doc.execCommand("copy") === true;
  } finally {
    textarea.remove();
    restoreSelection(saved);
  }
  if (!copied) {
    throw new Error("Copy command failed.");
  }
}

// The copied state of the history's copy buttons. Each successful copy raises the pulse, which the
// button turns into its animation, so a repeated copy plays it again; a failed one clears the state.
// Only the latest copy settles it: an earlier copy that finishes later is ignored.
export function createCopyFeedback({
  apply,
  durationMs = COPY_FEEDBACK_DURATION_MS,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (id) => globalThis.clearTimeout(id),
}) {
  let timerID = 0;
  let pulse = 0;
  let attempt = 0;

  function clear() {
    if (timerID) {
      clearTimer(timerID);
      timerID = 0;
    }
  }

  function reset() {
    attempt += 1;
    clear();
    apply({ id: "", pulse });
  }

  async function copy(id, write) {
    const current = ++attempt;
    let copied = false;
    try {
      await write();
      copied = true;
    } catch {
      copied = false;
    }
    if (current !== attempt) {
      return false;
    }
    clear();
    if (!copied) {
      apply({ id: "", pulse });
      return false;
    }
    pulse += 1;
    apply({ id: String(id || ""), pulse });
    timerID = setTimer(() => {
      timerID = 0;
      apply({ id: "", pulse });
    }, durationMs);
    return true;
  }

  return { copy, reset };
}
