// The longest CSS transition in a computed style, delays included, in milliseconds. Durations
// set from the motion tokens are zero under reduced motion, so this is zero there too.
export function transitionTimeMs(styles) {
  const times = (value) =>
    String(value || "")
      .split(",")
      .map((part) => {
        const text = part.trim();
        const number = Number.parseFloat(text);
        if (!Number.isFinite(number)) {
          return 0;
        }
        return text.endsWith("ms") ? number : number * 1000;
      });
  const durations = times(styles?.transitionDuration);
  const delays = times(styles?.transitionDelay);
  return Math.max(0, ...durations.map((duration, index) => Math.max(0, duration + (delays[index % delays.length] || 0))));
}
