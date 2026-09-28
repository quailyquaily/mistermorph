// The Mister Morph icon in motion, for loading states. It is the icon's 64 drawing (the one the
// console's logos use) in Aojashin: rows of dim lines across the tile, and inside the ghost (an
// invisible glass ball) the lines are drawn in toward its centre in blueprint blue. Here the ghost
// drifts on a small figure of eight, the bend travels with it and the field closes behind it: the brand's
// drift (design/DESIGN.md, Motion), quickened to a loader's pace.
//
// The geometry is design/brand/generator's (sizes.bleed with the 64 row of BLEED, meisai.pinch).
// With the ghost at the centre, the scene is that drawing.

const STEP = 8.2; // between rows
const WEIGHT = 3; // line weight
const RADIUS = 42; // the ghost
const PULL = 0.5;
const POWER = 1.2;
const MARGIN = 1.6; // rows stop this far inside the tile's edge
const CORNER = 22.4;
const CURVE_POINTS = 48;
const ORBIT = { x: 9, y: 6 };
const LAP_MS = 2400;

const COLORS = { tile: "#F1F4F8", field: "#B8C9E2", ghost: "#2463AE", edge: "#D5DFEC" };

const ROWS = (() => {
  const ys = [50];
  for (let k = 1; 50 - k * STEP >= MARGIN + WEIGHT; k++) {
    ys.push(50 - k * STEP, 50 + k * STEP);
  }
  return ys.sort((a, b) => a - b);
})();

// Where row y runs inside the tile's rounded square.
function span(y) {
  const r = CORNER - MARGIN;
  const top = MARGIN + r;
  const bottom = 100 - MARGIN - r;
  const d = y < top ? top - y : y > bottom ? y - bottom : 0;
  const half = d ? Math.sqrt(r * r - d * d) : r;
  return [MARGIN + r - half, 100 - MARGIN - r + half];
}

function pinch(x, y, cx, cy) {
  const rho2 = (x - cx) ** 2 + (y - cy) ** 2;
  if (rho2 >= RADIUS * RADIUS) {
    return y;
  }
  return cy + (y - cy) * (1 - PULL * (1 - rho2 / (RADIUS * RADIUS)) ** POWER);
}

const round = (value) => Math.round(value * 100) / 100;

// Every row with the ghost at (cx, cy): the dim runs left and right of the ghost, and the bent line
// inside it. A row the ghost doesn't reach is one dim run, and its curve has no width.
export function ghostScene(cx = 50, cy = 50) {
  return ROWS.map((y) => {
    const [a, b] = span(y);
    const dy = Math.abs(y - cy);
    const h = dy < RADIUS ? Math.sqrt(RADIUS * RADIUS - dy * dy) : 0;
    const xa = Math.max(a, Math.min(b, cx - h));
    const xb = Math.max(a, Math.min(b, cx + h));
    const left = h ? [a, cx - h - WEIGHT * 0.9] : [a, b];
    const right = h ? [cx + h + WEIGHT * 0.9, b] : [b, b];
    const points = [];
    for (let i = 0; i < CURVE_POINTS; i++) {
      const x = xa + ((xb - xa) * i) / (CURVE_POINTS - 1);
      points.push(`${round(x)} ${round(pinch(x, y, cx, cy))}`);
    }
    return {
      y,
      runs: [left, right].map(([x0, x1]) => ({ x: round(x0), width: round(Math.max(0, x1 - x0)) })),
      curve: `M${points.join(" L")}`,
      curveWidth: xb - xa > 0.5 ? WEIGHT : 0,
    };
  });
}

// SVG markup for the icon, still, with the ghost at the centre.
export function ghostMarkSVG({ className = "" } = {}) {
  const rows = ghostScene()
    .map(({ y, runs, curve, curveWidth }) =>
      runs
        .map((run) => `<rect data-run x="${run.x}" y="${round(y - WEIGHT / 2)}" width="${run.width}" height="${WEIGHT}" fill="${COLORS.field}"></rect>`)
        .join("") + `<path data-curve d="${curve}" fill="none" stroke="${COLORS.ghost}" stroke-width="${curveWidth}" stroke-linecap="round"></path>`,
    )
    .join("");
  const cls = className ? ` class="${className}"` : "";
  return (
    `<svg${cls} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    `<rect width="100" height="100" rx="${CORNER}" fill="${COLORS.tile}"></rect>${rows}` +
    `<rect x="0.5" y="0.5" width="99" height="99" rx="22" fill="none" stroke="${COLORS.edge}" stroke-width="1"></rect></svg>`
  );
}

// Sets the ghost drifting in an SVG made by ghostMarkSVG. The drawing holds still for `delay` ms,
// then the drift eases in from rest over `ease` ms. Returns a function that stops it.
export function animateGhostMark(svg, { delay = 0, ease = 0 } = {}) {
  const runs = [...svg.querySelectorAll("[data-run]")];
  const curves = [...svg.querySelectorAll("[data-curve]")];
  let frame = 0;
  let start = 0;
  const draw = (now) => {
    start ||= now;
    const elapsed = now - start - delay;
    if (elapsed > 0) {
      const t = ease ? Math.min(1, elapsed / ease) : 1;
      const reach = t * t * (3 - 2 * t);
      const angle = (2 * Math.PI * elapsed) / LAP_MS;
      // A figure of eight through the centre, so the drift starts from the still drawing.
      ghostScene(50 + reach * ORBIT.x * Math.sin(angle), 50 + reach * ORBIT.y * Math.sin(2 * angle)).forEach((row, index) => {
        row.runs.forEach((run, side) => {
          runs[index * 2 + side].setAttribute("x", run.x);
          runs[index * 2 + side].setAttribute("width", run.width);
        });
        curves[index].setAttribute("d", row.curve);
        curves[index].setAttribute("stroke-width", row.curveWidth);
      });
    }
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(frame);
}
