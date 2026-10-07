"""The circle drawing: no rounded square and no field texture. A round panel holds the ghost, which is drawn larger
and at one proportion for every size; only the bright lines inside the ghost remain. The optical sizes still differ in
how many lines they carry and how heavy those lines are.

generate.py writes it beside the regular icons, as icon-circle-<size>, for the colourways in COLOURWAYS.
"""
import itertools, math, os, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from base import f  # noqa: E402
from cyber import PALETTES, curve_pts  # noqa: E402
from meisai import pinch  # noqa: E402
from sizes import pathd, HONE, YORU, SUMI, KINARI, EDGE_DARK, EDGE_LIGHT  # noqa: E402

# The colourways that also get the circle alternative.
COLOURWAYS = ('night', 'paper', 'aojashin', 'suimen', 'rinko', 'bunko', 'denko')

# Night and paper aren't cyber palettes; give them the same shape, with no effects.
COLOURS = dict(PALETTES,
               night=dict(bg=YORU, line=HONE, edge=EDGE_DARK, split=None, glow=None),
               paper=dict(bg=KINARI, line=SUMI, edge=EDGE_LIGHT, split=None, glow=None))

# Filter ids of our own, so the cyber drawings keep their numbering.
_ids = itertools.count()

# Every size: the panel fills the canvas less a hairline, and the ghost sits inside it at the same ratio.
PANEL_R = 49.0
GHOST_R = 43.0  # 0.88 of the panel

# Optical sizes: (label, row step, line weight, pull, power, row y positions or None for a step ladder).
# 16 keeps three lines on whole pixels (6.25 units each); 32 keeps the five-line drawing's rhythm.
SIZES = [
    ('1024', 3.0, 0.8, 0.52, 1.3, None),
    ('256', 3.7, 1.1, 0.52, 1.3, None),
    ('128', 4.6, 1.5, 0.52, 1.3, None),
    ('64', 8.2, 3.0, 0.5, 1.2, None),
    ('32', None, 5.6, 0.5, 1.2, (20, 35, 50, 65, 80)),
    ('16', None, 12.5, 0.46, 1.1, (25, 50, 75)),
]


def rows(step, sw):
    """Rows of the ladder that cross the ghost with enough length to read as a line."""
    ys, k = [50.0], 0
    while True:
        k += 1
        y = 50 - k * step
        if 50 - y >= GHOST_R:
            break
        ys += [y, 100 - y]
    return sorted(y for y in ys if chord(y) >= max(4 * sw, 6))


def chord(y):
    dy = abs(y - 50)
    return 2 * math.sqrt(GHOST_R ** 2 - dy ** 2) if dy < GHOST_R else 0.0


def circle_icon(label, pal='aojashin', split_k=0.22):
    """One optical size. As in the rounded square, glow shows from 128 up and dispersion from 64 up; at 32 and 16 a
    dispersion palette keeps only its simplest form, the top line cyan and the bottom line magenta."""
    p = COLOURS[pal]
    spec = {s[0]: s for s in SIZES}[label]
    _, step, sw, pull, power, fixed = spec
    n = int(label)
    disp = pinch(pull, power)
    ys = list(fixed) if fixed else rows(step, sw)
    use_glow = n >= 128 and p['glow']
    use_split = n >= 64 and p['split']
    uid = next(_ids)
    out = []
    if use_glow:
        out.append(f'<defs><filter id="cg{uid}" x="-10%" y="-10%" width="120%" height="120%">'
                   f'<feGaussianBlur in="SourceGraphic" stdDeviation="{f(sw * 1.1)}" result="b"></feGaussianBlur>'
                   '<feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>'
                   '</filter></defs>')
    out.append(f'<circle cx="50" cy="50" r="{f(PANEL_R)}" fill="{p["bg"]}"></circle>')
    lines = []
    for i, y in enumerate(ys):
        half = chord(y) / 2
        # Round caps reach sw/2 past each end; pull the ends in so the caps stay on the ghost.
        xa, xb = 50 - half + sw / 2, 50 + half - sw / 2
        if xb <= xa:
            continue
        pts = curve_pts(y, xa, xb, disp, (50, 50, GHOST_R))
        if use_split:
            c, m = p['split']
            cyan = [(x, yy - split_k * (yy - y)) for x, yy in pts]
            mag = [(x, yy + split_k * (yy - y)) for x, yy in pts]
            lines.append(stroke(mag, m, sw, 'style="mix-blend-mode: screen"'))
            lines.append(stroke(cyan, c, sw, 'style="mix-blend-mode: screen"'))
            lines.append(stroke(pts, p['line'], sw * 0.5))
        else:
            colour = p['line']
            if p['split'] and i in (0, len(ys) - 1):
                colour = p['split'][0] if i == 0 else p['split'][1]
            lines.append(stroke(pts, colour, sw))
    body = ''.join(lines)
    out.append(f'<g filter="url(#cg{uid})">{body}</g>' if use_glow else f'<g style="isolation: isolate">{body}</g>')
    if n >= 64:
        out.append(f'<circle cx="50" cy="50" r="{f(PANEL_R - 0.5)}" fill="none" stroke="{p["edge"]}" '
                   f'stroke-width="1"></circle>')
    return ''.join(out)


def stroke(pts, colour, sw, extra=''):
    tail = f' {extra}' if extra else ''
    return (f'<path d="{pathd(pts)}" fill="none" stroke="{colour}" stroke-width="{f(sw)}" '
            f'stroke-linecap="round"{tail}></path>')
