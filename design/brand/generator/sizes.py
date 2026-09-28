"""Round 7: the icon as an optical-size family. Large sizes carry more lines and the raster detail; small sizes keep the gesture."""
import json, math, sys

from base import f, sq  # noqa: E402
from meisai import pinch, rim, YORU, PHOS, KIRI, HONE, KINARI, SUMI  # noqa: E402

EDGE_DARK, EDGE_LIGHT = '#1C2527', '#DDD6C8'


def lines_y(n, y0, y1):
    return [y0 + (y1 - y0) * j / (n - 1) for j in range(n)]


def curve(y, xa, xb, disp, ghost, dx=0.8):
    cx, cy, r = ghost
    pts, x = [], xa
    while x <= xb + 1e-6:
        pts.append((x, disp(x, y, cx, cy, r)))
        x += dx
    if pts[-1][0] < xb:
        pts.append((xb, disp(xb, y, cx, cy, r)))
    return pts


def pathd(pts):
    return 'M' + ' L'.join(f'{f(a)} {f(b)}' for a, b in pts)


def tier(fg, n, sw, box=(14, 16, 86, 84), ghost=(50, 50, 46), pull=0.5, power=1.2, raster=False, pitch=None,
         run=None, axis=None, rimamp=0.0, cap='round', dim=None):
    """One optical size of the icon drawing. raster=True: outside the ghost each line is pixel runs, inside it is
    one smooth curve. axis: colour for the one line through the ghost's centre, which never bends."""
    x0, y0, x1, y1 = box
    cx, cy, r = ghost
    base = pinch(pull, power)
    disp = base if not rimamp else (lambda x, y, a, b, c: rim(rimamp, 3.0)(x, base(x, y, a, b, c), a, b, c))
    out = []
    for y in lines_y(n, y0, y1):
        color = axis if (axis and abs(y - cy) < 1e-6) else fg
        dy = abs(y - cy)
        h = math.sqrt(r * r - dy * dy) if dy < r else 0.0
        xa, xb = max(x0, cx - h), min(x1, cx + h)
        if not raster or h == 0:
            if raster:
                out.append(runs(y, x0, x1, sw, dim or color, pitch, run))
            else:
                out.append(f'<path d="{pathd(curve(y, x0, x1, disp, ghost))}" fill="none" stroke="{color}" '
                           f'stroke-width="{f(sw)}" stroke-linecap="{cap}"></path>')
            continue
        if xa > x0:
            out.append(runs(y, x0, xa - sw * 0.9, sw, dim or color, pitch, run))
        if xb < x1:
            out.append(runs(y, xb + sw * 0.9, x1, sw, dim or color, pitch, run, align_right=True))
        out.append(f'<path d="{pathd(curve(y, xa, xb, disp, ghost))}" fill="none" stroke="{color}" '
                   f'stroke-width="{f(sw)}" stroke-linecap="{cap}"></path>')
    return ''.join(out)


def runs(y, a, b, sw, color, pitch, run, align_right=False):
    """Pixel runs along a line, square-ended: the raster part."""
    pitch = pitch or sw * 2
    run = run or sw * 1.2
    out = []
    if align_right:
        x = b - run
        while x >= a - 1e-6:
            out.append(sq(x, y - sw / 2, run, sw, color))
            x -= pitch
    else:
        x = a
        while x + run <= b + 1e-6:
            out.append(sq(x, y - sw / 2, run, sw, color))
            x += pitch
    return ''.join(out)


def squircle(bg, edge, inner, stroke=True):
    e = f'<rect x="0.5" y="0.5" width="99" height="99" rx="22" fill="none" stroke="{edge}" stroke-width="1"></rect>' if stroke else ''
    return f'<rect width="100" height="100" rx="22.4" fill="{bg}"></rect>{inner}{e}'


DIM_DARK, DIM_LIGHT = '#5E6B69', '#A8A39A'
B = (13, 15, 87, 85)

# Each optical size: (label, drawn for, line count, weight, ghost radius, raster pitch/run or None).
TIERS = [
    ('1024', 23, 0.8, 33, (2.0, 1.0), B),
    ('256', 19, 1.1, 32, (2.5, 1.4), B),
    ('128', 15, 1.5, 36, (3.1, 1.8), B),
    ('64', 7, 3.8, 45, None, (15, 18, 85, 82)),
    ('32', 5, 5.6, 46, None, (16, 20, 84, 80)),
    ('16', 4, 8.5, 48, None, (16, 20, 84, 80)),
]


def tier_icon(label, dark=True):
    for lab, n, sw, r, ras, box in TIERS:
        if lab == label:
            fg, dim, bg, edge = (HONE, DIM_DARK, YORU, EDGE_DARK) if dark else (SUMI, DIM_LIGHT, KINARI, EDGE_LIGHT)
            kw = dict(box=box, ghost=(50, 50, r), pull=0.52 if ras else 0.5, power=1.3 if ras else 1.2)
            if ras:
                kw.update(raster=True, pitch=ras[0], run=ras[1], dim=dim)
            return squircle(bg, edge, tier(fg, n, sw, **kw), stroke=int(label) >= 64)
    raise KeyError(label)


def build():
    d = {}
    for lab, *_ in TIERS:
        d[f'n{lab}'] = tier_icon(lab, True)
        d[f'p{lab}'] = tier_icon(lab, False)
    return d


if __name__ == '__main__':
    d = build()
    json.dump(d, open(sys.argv[1], 'w'), indent=1)
    print({k: len(v) for k, v in d.items()})


def squircle_span(y, m=0.0, rx=22.4):
    """Horizontal extent of the icon's rounded square at height y, inset by m."""
    r = rx - m
    top, bot = m + r, 100 - m - r
    if y < top:
        d = top - y
    elif y > bot:
        d = y - bot
    else:
        return m, 100 - m
    if d >= r:
        return None
    half = math.sqrt(r * r - d * d)
    return m + r - half, 100 - m - r + half


def bleed(fg, dim, bg, step, sw, r, pitch=None, run=None, pull=0.52, power=1.3, margin=1.6, cont=False, edge=None):
    """The texture fills the whole icon: every row runs edge to edge (clipped by the rounded corners), dim pixel runs
    outside the ghost, bright smooth curves inside it. cont=True draws the outside as dim continuous lines instead."""
    cx = cy = 50.0
    disp = pinch(pull, power)
    out = [f'<rect width="100" height="100" rx="22.4" fill="{bg}"></rect>']
    k = 0
    ys = [50.0]
    while True:
        k += 1
        if 50 - k * step < margin + sw:
            break
        ys += [50 - k * step, 50 + k * step]
    for y in sorted(ys):
        span = squircle_span(y, margin)
        if not span:
            continue
        a, b = span
        dy = abs(y - cy)
        h = math.sqrt(r * r - dy * dy) if dy < r else 0.0
        segs = [(a, b)] if h == 0 else [(a, cx - h - sw * 0.9), (cx + h + sw * 0.9, b)]
        for s, e in segs:
            if e - s <= sw:
                continue
            if cont:
                out.append(sq(s, y - sw / 2, e - s, sw, dim))
            else:
                j = math.floor((s - cx) / pitch - 0.5) - 1
                while True:
                    xc = cx + (j + 0.5) * pitch
                    if xc - run / 2 > e:
                        break
                    if xc - run / 2 >= s - 1e-6 and xc + run / 2 <= e + 1e-6:
                        out.append(sq(xc - run / 2, y - sw / 2, run, sw, dim))
                    j += 1
        if h > 0:
            xa, xb = max(a, cx - h), min(b, cx + h)
            out.append(f'<path d="{pathd(curve(y, xa, xb, disp, (cx, cy, r)))}" fill="none" stroke="{fg}" '
                       f'stroke-width="{f(sw)}" stroke-linecap="round"></path>')
    if edge:
        out.append(f'<rect x="0.5" y="0.5" width="99" height="99" rx="22" fill="none" stroke="{edge}" stroke-width="1"></rect>')
    return ''.join(out)


DIMB_DARK, DIMB_LIGHT = '#44504E', '#BDB7AC'
CONT_DARK, CONT_LIGHT = '#34403E', '#CFC8BB'

# Full-bleed optical sizes: (label, row step, weight, ghost radius, (pitch, run) or 'cont', pull, power)
BLEED = [
    ('1024', 3.0, 0.8, 34, (2.0, 1.0), 0.52, 1.3),
    ('256', 3.7, 1.1, 34, (2.5, 1.4), 0.52, 1.3),
    ('128', 4.6, 1.5, 38, (3.1, 1.8), 0.52, 1.3),
    ('64', 8.2, 3.0, 42, 'cont', 0.5, 1.2),
    ('32', 12.5, 4.6, 42, 'cont', 0.5, 1.2),
    ('16', 19, 7.5, 40, 'cont', 0.46, 1.1),
]


def bleed_icon(label, dark=True):
    for lab, step, sw, r, ras, pull, power in BLEED:
        if lab != label:
            continue
        fg, bg, edge = (HONE, YORU, EDGE_DARK) if dark else (SUMI, KINARI, EDGE_LIGHT)
        big = int(lab) >= 64
        if ras == 'cont':
            return bleed(fg, CONT_DARK if dark else CONT_LIGHT, bg, step, sw, r, cont=True, pull=pull, power=power,
                         margin=1.6 if big else 0.8, edge=edge if big else None)
        return bleed(fg, DIMB_DARK if dark else DIMB_LIGHT, bg, step, sw, r, ras[0], ras[1], pull, power, edge=edge)
    raise KeyError(label)


def build_bleed():
    d = {}
    for lab, *_ in BLEED:
        d[f'n{lab}'] = bleed_icon(lab, True)
        d[f'p{lab}'] = bleed_icon(lab, False)
    return d
