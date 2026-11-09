// Theme colours for drawings: a token's colour (hex, with or without alpha, or rgb()/rgba()) as
// its channels, and back as `#rrggbbaa`, which canvases and `interpolate` both take.

/** A colour's red, green, blue (0–255) and alpha (0–1); black for anything unreadable. */
export function channels(color: string): [number, number, number, number] {
  const value = String(color).trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? hex.split("").map((c) => c + c).join("") : hex;
    const at = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [at(0), at(2), at(4), full.length >= 8 ? at(6) / 255 : 1];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1];
  }
  return [0, 0, 0, 1];
}

/** `color` at `alpha` (0–1, times its own), as `#rrggbbaa`. */
export function withAlpha(color: string, alpha = 1): string {
  const [r, g, b, a] = channels(color);
  const two = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}${two(a * alpha * 255)}`;
}

/** The colour `t` of the way from `from` to `to`, as `#rrggbbaa`. */
export function mix(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  const at = (i: number) => a[i] + (b[i] - a[i]) * t;
  return withAlpha(`rgba(${at(0)}, ${at(1)}, ${at(2)}, ${at(3)})`);
}
