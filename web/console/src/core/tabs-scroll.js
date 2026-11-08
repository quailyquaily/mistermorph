// AppTabs in a row too narrow for its options scrolls sideways. These place the active option in
// view and tell which ends hide options, from plain measurements so tests can check them.

// The scrollLeft that brings an option spanning [start, end) into view, keeping `inset` pixels of
// the track beside it, or null when the row does not scroll or the option is already in view.
export function tabsScrollTarget({ scrollLeft = 0, clientWidth = 0, scrollWidth = 0, start = 0, end = 0, inset = 2 } = {}) {
  if (scrollWidth <= clientWidth + 1) {
    return null;
  }
  const from = Math.max(0, start - inset);
  const to = end + inset;
  let left = scrollLeft;
  if (from < left) {
    left = from;
  } else if (to > left + clientWidth) {
    left = to - clientWidth;
  }
  left = Math.max(0, Math.min(left, scrollWidth - clientWidth));
  return Math.abs(left - scrollLeft) < 1 ? null : left;
}

// Which ends of the row hide options.
export function tabsOverflowEdges({ scrollLeft = 0, clientWidth = 0, scrollWidth = 0 } = {}) {
  const max = scrollWidth - clientWidth;
  return {
    start: max > 1 && scrollLeft > 1,
    end: max > 1 && scrollLeft < max - 1,
  };
}
