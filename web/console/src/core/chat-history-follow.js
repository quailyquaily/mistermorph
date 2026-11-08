// Follow-at-bottom for the chat history viewport.
//
// The history follows its bottom while the reader is at it: new messages, streamed text and
// background refreshes (a TODO topic reloads its runs every few seconds) keep the latest content in
// view. A reader who scrolls up stops following, and the view then stays where they put it.
//
// Following is decided from where the view is, not only from scroll events. Opening or closing a
// progress panel changes the layout under the reader without scrolling: opening one near the bottom
// pushes the bottom out of view with no scroll event, so a flag kept from scroll events alone would
// still say "following" and the next background update would pull the panel away. A reader's own
// layout change therefore holds the view still until the layout settles, then follows again only if
// the view is still at the bottom.
//
// Scrolls are deferred (after Vue's render, then to the next frame), so each deferred step checks
// again that the view still follows and still shows the same history; a reader who started
// scrolling, or a topic switch, in between wins over a scroll that was requested earlier.

// How close to the bottom still counts as at the bottom.
export const HISTORY_BOTTOM_SLACK_PX = 28;
// How long after a wheel, touch or scrollbar drag a scroll counts as the reader's.
export const HISTORY_SCROLL_INTENT_MS = 1200;
// How long a reader's layout change (a progress panel opening or closing) takes to settle. Covers
// the panel's open (220ms) and close (150ms) transitions.
export const HISTORY_LAYOUT_SETTLE_MS = 320;

export function historyDistanceFromBottom(node) {
  if (!node) {
    return 0;
  }
  return node.scrollHeight - node.clientHeight - node.scrollTop;
}

export function historyAtBottom(node) {
  return historyDistanceFromBottom(node) <= HISTORY_BOTTOM_SLACK_PX;
}

// options:
//   viewport()        the scrolling history element, or null
//   following         a ref ({ value }) holding whether the view follows the bottom
//   scope()           a token for the history on screen; deferred work is dropped when it changes
//   nextTick(fn)      runs fn after the pending render
//   frame(fn)         runs fn on the next animation frame
//   delay(fn, ms)     schedules fn and returns a handle; cancelDelay(handle) cancels it
//   now()             the current time in milliseconds
//   reducedMotion()   whether the reader asked for reduced motion
export function createHistoryFollower(options) {
  const {
    viewport,
    following,
    scope = () => "",
    nextTick = (fn) => Promise.resolve().then(fn),
    frame = (fn) => window.requestAnimationFrame(fn),
    delay = (fn, ms) => window.setTimeout(fn, ms),
    cancelDelay = (handle) => window.clearTimeout(handle),
    now = () => Date.now(),
    reducedMotion = () => false,
  } = options;
  let intentAt = Number.NEGATIVE_INFINITY;
  let settleHandle = 0;
  let settleSequence = 0;

  function atBottom() {
    return historyAtBottom(viewport());
  }

  function markIntent() {
    intentAt = now();
  }

  function hasRecentIntent() {
    return now() - intentAt <= HISTORY_SCROLL_INTENT_MS;
  }

  // At the bottom the view follows, however it got there. Away from it the view stops following
  // only when the reader moved it; a scroll the layout caused (content shrinking, a clamp) leaves
  // following as it was.
  function handleScroll() {
    if (atBottom()) {
      following.value = true;
      return;
    }
    if (hasRecentIntent()) {
      following.value = false;
    }
  }

  // smooth: glide down to a message that just arrived (one sent), when it is near; a streaming
  // reply, a load and a long way down still jump, so the view never lags the text.
  // force: scroll even when the view does not follow (a newly loaded history starts at its bottom).
  function scrollToBottom(scrollOptions = {}) {
    const force = Boolean(scrollOptions.force);
    const smooth = Boolean(scrollOptions.smooth);
    const token = scope();
    const stillWanted = () => scope() === token && (force || following.value);
    nextTick(() => {
      const node = viewport();
      if (!node || !stillWanted()) {
        return;
      }
      frame(() => {
        if (viewport() !== node || !stillWanted()) {
          return;
        }
        const distance = historyDistanceFromBottom(node);
        if (smooth && !reducedMotion() && distance > 0 && distance < node.clientHeight * 1.5) {
          node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
        } else {
          node.scrollTop = node.scrollHeight;
        }
        following.value = true;
      });
    });
  }

  // Content finished rendering or changed size (Markdown, images): keep the bottom in view if the
  // view follows it.
  function handleContentRendered() {
    if (following.value) {
      scrollToBottom();
    }
  }

  // The reader changed the layout in place (opened or closed a progress panel). The view holds
  // still while it settles, then follows only if it is still at the bottom.
  function holdForLayoutChange() {
    following.value = false;
    settleSequence += 1;
    const sequence = settleSequence;
    const token = scope();
    if (settleHandle) {
      cancelDelay(settleHandle);
    }
    settleHandle = delay(() => {
      settleHandle = 0;
      if (sequence !== settleSequence || scope() !== token) {
        return;
      }
      following.value = atBottom();
    }, HISTORY_LAYOUT_SETTLE_MS);
  }

  function dispose() {
    settleSequence += 1;
    if (settleHandle) {
      cancelDelay(settleHandle);
      settleHandle = 0;
    }
  }

  return {
    atBottom,
    dispose,
    handleContentRendered,
    handleScroll,
    hasRecentIntent,
    holdForLayoutChange,
    markIntent,
    scrollToBottom,
  };
}
