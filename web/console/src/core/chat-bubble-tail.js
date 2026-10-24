// The user bubble's tail, drawn on the device pixel grid the way the browser draws the bubble's
// border, so the two read as one line at any pixel density.
//
// A 1px CSS border is drawn whole device pixels wide (at 1.5x: one device pixel) and on device
// pixel edges. A stroke in an SVG is not: at 1.5x a 1px stroke is 1.5 device pixels, smoothed across
// two, so the tail would look wider and paler than the border it continues. So the tail's masks are
// built for the current density: the line is the border's width in device pixels, and its straight
// parts sit on the same pixels as the border's. installChatBubbleTail sets them as CSS variables
// and builds them again when the density changes (another screen, zoom).

// The tail's shape, in CSS px: how far its tip reaches past the bubble's border, how far down the
// right edge its slope meets it, the concave fillet there and the rounding of the tip.
const TAIL_REACH = 8;
const TAIL_RISE = 11.5;
const TAIL_FILLET = 4;
const TAIL_TIP = 1.6;

// The width the browser draws a 1px border at this density, in CSS px: whole device pixels, at
// least one.
function borderWidth(dpr) {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(1, Math.floor(ratio + 1e-6)) / ratio;
}

function num(value) {
  return Number(value.toFixed(3)).toString();
}

function point(p) {
  return `${num(p[0])} ${num(p[1])}`;
}

function svgURL(width, height, body) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${num(width)}' height='${num(height)}' viewBox='0 0 ${num(width)} ${num(height)}'>${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// chatBubbleTail returns the tail's masks for a pixel density. The masks' origin is the outer
// corner of the bubble's top and right borders' meeting, less the border width to the left: their
// first column is the right border, their first row the top border.
function chatBubbleTail(dpr) {
  const line = borderWidth(dpr);
  const half = line / 2;
  // The border lines' centres: the right border's (x) and the top border's (y).
  const edgeX = half;
  const topY = half;
  const corner = [edgeX, topY + TAIL_RISE]; // the slope meets the right edge
  const tip = [line + TAIL_REACH - half, topY];
  const dx = tip[0] - corner[0];
  const dy = tip[1] - corner[1];
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const filletStart = [edgeX, corner[1] + TAIL_FILLET]; // on the right edge
  const filletEnd = [corner[0] + ux * TAIL_FILLET, corner[1] + uy * TAIL_FILLET]; // on the slope
  const tipStart = [tip[0] - ux * TAIL_TIP, tip[1] - uy * TAIL_TIP]; // on the slope
  const tipEnd = [tip[0] - TAIL_TIP, topY]; // on the top edge
  const width = Math.ceil(tip[0] + line);
  const height = Math.ceil(filletStart[1] + line);

  const outline =
    `M${point(filletStart)} Q${point(corner)} ${point(filletEnd)} L${point(tipStart)} ` +
    `Q${point(tip)} ${point(tipEnd)} L0 ${num(topY)}`;
  // The fill covers the bubble's own borders under the tail, up to the outline's centre.
  const fill =
    `M0 0 L${point(tipEnd)} Q${point(tip)} ${point(tipStart)} L${point(filletEnd)} ` +
    `Q${point(corner)} ${point(filletStart)} L0 ${num(filletStart[1])} Z`;
  return {
    line,
    width,
    height,
    fill: svgURL(width, height, `<path d='${fill}' fill='black'/>`),
    stroke: svgURL(
      width,
      height,
      `<path d='${outline}' fill='none' stroke='black' stroke-width='${num(line)}' stroke-linejoin='round'/>`,
    ),
  };
}

function applyChatBubbleTail(root, dpr) {
  const tail = chatBubbleTail(dpr);
  root.style.setProperty("--chat-tail-line", `${num(tail.line)}px`);
  root.style.setProperty("--chat-tail-width", `${tail.width}px`);
  root.style.setProperty("--chat-tail-height", `${tail.height}px`);
  root.style.setProperty("--chat-tail-fill", tail.fill);
  root.style.setProperty("--chat-tail-stroke", tail.stroke);
}

// installChatBubbleTail sets the tail's masks for the window's pixel density, and again whenever
// it changes.
function installChatBubbleTail(win = typeof window === "undefined" ? null : window) {
  if (!win?.document?.documentElement) {
    return;
  }
  const root = win.document.documentElement;
  const watch = () => {
    const dpr = win.devicePixelRatio || 1;
    applyChatBubbleTail(root, dpr);
    // A media query for this exact density stops matching when it changes.
    const query = win.matchMedia?.(`(resolution: ${dpr}dppx)`);
    query?.addEventListener?.("change", watch, { once: true });
  };
  watch();
}

export { borderWidth, chatBubbleTail, installChatBubbleTail };
