// Number tweening for figures that roll to a new value.

export function easeOutCubic(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

// Value at elapsed/duration of the way from `from` to `to`; non-numbers jump straight to `to`.
export function tweenValue(from, to, elapsed, duration) {
  const a = from === null || from === undefined ? NaN : Number(from);
  const b = to === null || to === undefined ? NaN : Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || duration <= 0) {
    return to;
  }
  return a + (b - a) * easeOutCubic(elapsed / duration);
}

// Honour the OS setting; figures then change without rolling.
export function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
