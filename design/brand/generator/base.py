"""Round 4 geometry: Ensō, Tsuki and Karesansui, each dug further. Every mark lives in a 100×100 box."""
import math, json, sys

K, S, SHU, AI, U = '#F2EDE2', '#1E1E20', '#D23F2B', '#1E3553', '#8C8984'
B4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def thr(i, j):
    """Ordered (Bayer) dither threshold for cell (i, j)."""
    return (B4[j % 4][i % 4] + 0.5) / 16


def f(v):
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def pt(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def sm(e0, e1, x):
    if x <= e0:
        return 0.0
    if x >= e1:
        return 1.0
    u = (x - e0) / (e1 - e0)
    return u * u * (3 - 2 * u)


def sq(x, y, w, h, fill):
    return f'<rect x="{f(x)}" y="{f(y)}" width="{f(w)}" height="{f(h)}" fill="{fill}"></rect>'


def circ(cx, cy, r, fill='none', stroke=None, sw=None):
    st = f' stroke="{stroke}" stroke-width="{f(sw)}"' if stroke else ''
    return f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="{fill}"{st}></circle>'


def poly(pts, fill):
    return '<path d="M' + ' L'.join(f'{f(x)} {f(y)}' for x, y in pts) + f'Z" fill="{fill}"></path>'


def path(pts, stroke, sw):
    return ('<path d="M' + ' L'.join(f'{f(x)} {f(y)}' for x, y in pts)
            + f'" fill="none" stroke="{stroke}" stroke-width="{f(sw)}" stroke-linecap="round" stroke-linejoin="round"></path>')


# ── Ensō ────────────────────────────────────────────────────────────────────


class Brush:
    """One ensō stroke: a slightly eccentric circle, pressed at the entry, losing ink as it goes, lifting at the end."""

    def __init__(self, cx=50, cy=50, r=34, start=150, sweep=336, w=6.4, ecc=1.3):
        self.cx, self.cy, self.r, self.start, self.sweep, self.w, self.ecc = cx, cy, r, start, sweep, w, ecc

    def at(self, t):
        a = self.start + self.sweep * t
        rr = self.r + self.ecc * math.sin(math.radians(a + 60))
        press = 0.8 + 0.2 * sm(0, 0.06, t)
        body = 1 - 0.42 * sm(0.08, 1.0, t)
        lift = 1 - 0.3 * sm(0.84, 1.0, t)
        w = self.w * press * body * lift
        tilt = 0.14 * math.sin(math.radians(a * 2 + 20))
        return a, rr, w * (1 + tilt), w * (1 - tilt)

    def outline(self, t0, t1, n=150):
        out, inn = [], []
        for i in range(n + 1):
            t = t0 + (t1 - t0) * i / n
            a, rr, wo, wi = self.at(t)
            out.append(pt(self.cx, self.cy, rr + wo, a))
            inn.append(pt(self.cx, self.cy, rr - wi, a))
        return out + inn[::-1]

    def cap(self, t, ink):
        a, rr, wo, wi = self.at(t)
        x, y = pt(self.cx, self.cy, rr + (wo - wi) / 2, a)
        return circ(x, y, (wo + wi) / 2, ink)

    def inside(self, x, y):
        a = math.degrees(math.atan2(y - self.cy, x - self.cx))
        t = ((a - self.start) % 360) / self.sweep
        if t > 1:
            return None
        _, rr, wo, wi = self.at(t)
        rho = math.hypot(x - self.cx, y - self.cy)
        if rr - wi <= rho <= rr + wo:
            return t, (rho - rr) / (wo if rho > rr else wi)
        return None


def cells(b, cell, pick, ink, gap=0.08):
    """Rasterise the part of the brush that `pick(t, u, i, j)` keeps, on a lattice centred on the ensō."""
    out, g, n = [], cell * gap, int(50 / cell) + 2
    for j in range(-n, n):
        for i in range(-n, n):
            x, y = b.cx + (i + 0.5) * cell, b.cy + (j + 0.5) * cell
            h = b.inside(x, y)
            if h and pick(h[0], h[1], i, j):
                out.append(sq(x - cell / 2 + g / 2, y - cell / 2 + g / 2, cell - g, cell - g, ink))
    return ''.join(out)


def enso_kasure(ink=S, cell=2.3, t0=0.58, floor=0.1, b=None, streaks=0.0):
    """The ink runs dry at the tail, and the dry brush (kasure) breaks up into pixels."""
    b = b or Brush()

    def pick(t, u, i, j):
        if t < t0 - 0.04:
            return False
        d = 1 - (1 - floor) * sm(t0 + 0.03, 1.0, t)
        d *= 1 - 0.3 * abs(u) ** 4
        if streaks:
            d *= 1 - streaks * sm(t0 + 0.06, t0 + 0.2, t) * (0.5 + 0.5 * math.cos(3.4 * math.pi * u + 0.7))
        return d > thr(i, j)

    return poly(b.outline(0, t0), ink) + b.cap(0, ink) + cells(b, cell, pick, ink)


def enso_resolution(ink=S, sizes=(8.4, 6, 4.2, 2.9, 2), span=0.1, b=None):
    """The stroke gains resolution as it goes round: it lands as big pixels and finishes as ink."""
    b = b or Brush(w=6.8)
    out = []
    for k, c in enumerate(sizes):
        lo, hi = k * span, (k + 1) * span
        out.append(cells(b, c, lambda t, u, i, j, lo=lo, hi=hi: lo <= t < hi, ink, gap=0.06))
    out.append(poly(b.outline(len(sizes) * span, 1), ink))
    return ''.join(out)


def enso_entry(ink=S, cell=2.6, t1=0.34, b=None):
    """The reverse of kasure: the brush touches down as scattered pixels and becomes ink."""
    b = b or Brush()

    def pick(t, u, i, j):
        if t >= t1:
            return False
        d = 0.34 + 0.66 * sm(0.0, t1 - 0.04, t)
        d *= 1 - 0.3 * abs(u) ** 3
        return d > thr(i, j)

    return cells(b, cell, pick, ink) + poly(b.outline(t1 - 0.05, 1), ink)


def hanko_seal(x, y, size, seal=SHU, paper=K):
    """The small vermilion seal from round 3, placed at (x, y) in a 100 box scaled to `size`."""
    s = size / 100
    body = (f'<rect x="4" y="4" width="92" height="92" rx="7" fill="{seal}"></rect>'
            + ''.join(f'<rect x="{px}" y="{py}" width="11" height="11" fill="{paper}"></rect>'
                      for px, py in [(20, 22), (20, 42), (20, 62), (33, 32), (33, 52)])
            + f'<path d="M48 18A32 32 0 0 1 48 82Z" fill="{paper}"></path>')
    return f'<g transform="translate({f(x)} {f(y)}) scale({f(s)})">{body}</g>'


# ── Tsuki ───────────────────────────────────────────────────────────────────


def moon(cx=50, cy=50, r=30, a=0.5, lit=K, cell=2.5, gap=0.14, shape='gibbous', dens=None):
    """A moon with a true curved terminator; the unlit part is 1-bit ordered dither, the lit part smooth."""
    ar = r * a
    parts = []
    if shape == 'gibbous':
        parts.append(f'<path d="M{f(cx)} {f(cy - r)}A{f(r)} {f(r)} 0 0 1 {f(cx)} {f(cy + r)}A{f(ar)} {f(r)} 0 0 1 {f(cx)} {f(cy - r)}Z" fill="{lit}"></path>')
    elif shape == 'crescent':
        parts.append(f'<path d="M{f(cx)} {f(cy - r)}A{f(r)} {f(r)} 0 0 1 {f(cx)} {f(cy + r)}A{f(ar)} {f(r)} 0 0 0 {f(cx)} {f(cy - r)}Z" fill="{lit}"></path>')
    elif shape == 'full':
        return circ(cx, cy, r, lit)
    dens = dens or (lambda s: 0.06 + 0.86 * (1 - s) ** 1.6)
    g, n = cell * gap, int(r / cell) + 1
    for j in range(-n, n):
        for i in range(-n, n):
            x, y = cx + (i + 0.5) * cell, cy + (j + 0.5) * cell
            if math.hypot(x - cx, y - cy) > r - cell * 0.2:
                continue
            v = (y - cy) / r
            k = math.sqrt(max(0.0, 1 - v * v))
            if shape == 'new':
                xt = cx + r * k
            else:
                xt = cx - ar * k if shape == 'gibbous' else cx + ar * k
            xl = cx - r * k
            if x >= xt:
                continue
            s = (xt - x) / max(1e-6, xt - xl)
            if dens(s) > thr(i, j):
                parts.append(sq(x - cell / 2 + g / 2, y - cell / 2 + g / 2, cell - g, cell - g, lit))
    return ''.join(parts)


CRESCENT_ROWS = [
    (0.5, [(0.12, 1)]),
    (0.8, [(0.22, 0.94)]),
    (0.95, [(0.3, 0.62), (0.8, 1.04)]),
    (0.85, [(0.4, 0.66)]),
    (0.6, [(0.5, 0.74)]),
]

SUIGETSU_ROWS = [
    (0.55, [(-1, 1)]),
    (0.85, [(-1, -0.18), (0.1, 1)]),
    (1.0, [(-1, -0.5), (-0.28, 0.62), (0.82, 1.08)]),
    (0.92, [(-0.86, -0.52), (-0.3, 0.12), (0.36, 0.74)]),
    (0.7, [(-0.64, -0.4), (-0.02, 0.26), (0.56, 0.74)]),
    (0.42, [(-0.2, -0.04), (0.3, 0.44)]),
]


def suigetsu(moonc=K, bars=K, cx=50, cy=30, r=17, y0=58, step=5.2, h=2.4, cell=2.4, rows=None, moon_svg=None):
    """Suigetsu, the moon in the water: the moon is smooth; its reflection is scanlines, snapped to pixels."""
    parts = [moon_svg or circ(cx, cy, r, moonc)]
    for k, (wf, segs) in enumerate(rows or SUIGETSU_ROWS):
        y = y0 + k * step
        W = r * wf * 1.08
        for a, b in segs:
            x0 = round(a * W / cell) * cell + cx
            x1 = round(b * W / cell) * cell + cx
            if x1 - x0 < cell:
                x1 = x0 + cell
            parts.append(sq(x0, y - h / 2, x1 - x0, h, bars))
    return ''.join(parts)


def phases(lit=K, cy=50, r=7.4, cell=1.25):
    """Five nights, new to full: the moon resolves as it fills."""
    out = []
    specs = [('new', 0, lambda s: 0.1), ('crescent', 0.45, lambda s: 0.1 + 0.4 * (1 - s) ** 2),
             ('gibbous', 0.0, None), ('gibbous', 0.6, None), ('full', 0, None)]
    for k, (shape, a, dens) in enumerate(specs):
        out.append(moon(14 + 18 * k, cy, r, a, lit, cell, 0.12, shape, dens))
    return ''.join(out)


# ── Karesansui ──────────────────────────────────────────────────────────────


def intervals(y, x0, x1, holes):
    cuts = []
    for cx, cy, R in holes:
        dy = abs(y - cy)
        if dy < R:
            h = math.sqrt(R * R - dy * dy)
            cuts.append((cx - h, cx + h))
    cuts.sort()
    out, cur = [], x0
    for a, b in cuts:
        if b <= cur:
            continue
        if a > cur:
            out.append((cur, min(a, x1)))
        cur = max(cur, b)
        if cur >= x1:
            break
    if cur < x1:
        out.append((cur, x1))
    return [(a, b) for a, b in out if b - a > 0.6]


def grain_row(y, a, b, holes, lines, sw, pitch, reach):
    """Gravel is the pixel: far from a stone the raked line is loose grains; near it they close into a line."""
    out = []
    c0 = math.floor(a / pitch)
    c1 = math.ceil(b / pitch)
    for c in range(c0, c1 + 1):
        xc = c * pitch
        D = min(math.hypot(xc - hx, y - hy) - R for hx, hy, R in holes) if holes else 99
        t = 1 - sm(0, reach, D)
        L = sw * 1.05 + (pitch + 0.12 - sw * 1.05) * t
        x0, x1 = max(a, xc - L / 2), min(b, xc + L / 2)
        if x1 - x0 > sw * 0.5:
            out.append(sq(x0, y - sw / 2, x1 - x0, sw, lines))
    return ''.join(out)


def garden(stones, lines=U, sw=1.1, step=4.2, pitch=2.8, reach=26, box=(10, 10, 90, 90), grains=True, ring_color=None):
    """stones: (cx, cy, stone radius, rings, fill). Straight raked rows, rings round each stone."""
    x0, y0, x1, y1 = box
    holes = [(cx, cy, rs + step * n + step / 2) for cx, cy, rs, n, _ in stones]
    out = []
    y = y0
    while y <= y1 + 0.01:
        for a, b in intervals(y, x0, x1, holes):
            if grains:
                out.append(grain_row(y, a, b, holes, lines, sw, pitch, reach))
            else:
                out.append(sq(a, y - sw / 2, b - a, sw, lines))
        y += step
    for cx, cy, rs, n, fill in stones:
        for k in range(1, n + 1):
            out.append(circ(cx, cy, rs + step * k, 'none', ring_color or lines, sw))
        out.append(circ(cx, cy, rs, fill))
    return ''.join(out)


def morph_garden(cx=56, cy=54, half=6.5, n=4, lines=U, stone=S, sw=1.1, step=4.2, grains=False, pitch=2.8, reach=24,
                 rounds=(0.18, 0.45, 0.75, 1.0), box=(10, 10, 90, 90)):
    """The stone is a square; its ripples round off as they spread, and the last one is a circle."""
    x0, y0, x1, y1 = box
    R = half + step * n + step / 2
    holes = [(cx, cy, R)]
    out = []
    y = y0
    while y <= y1 + 0.01:
        for a, b in intervals(y, x0, x1, holes):
            out.append(grain_row(y, a, b, holes, lines, sw, pitch, reach) if grains else sq(a, y - sw / 2, b - a, sw, lines))
        y += step
    for k in range(1, n + 1):
        s = half + step * k
        rr = s * rounds[k - 1]
        out.append(f'<rect x="{f(cx - s)}" y="{f(cy - s)}" width="{f(2 * s)}" height="{f(2 * s)}" rx="{f(rr)}" fill="none" stroke="{lines}" stroke-width="{f(sw)}"></rect>')
    out.append(sq(cx - half, cy - half, 2 * half, 2 * half, stone))
    return ''.join(out)


def flow(cx=52, cy=50, R=10.5, rs=6.5, lines=U, stone=S, sw=1.1, step=4.2, pitch=2.8, box=(10, 10, 90, 90)):
    """Streamlines past a stone: upstream the raked line is loose grains, downstream it has become one smooth line."""
    x0, y0, x1, y1 = box
    out = []
    m = 0
    while True:
        p = step * (m + 0.5)
        if p > max(cy - y0, y1 - cy) + 6:
            break
        for sign in (-1, 1):
            psi = sign * p
            pts = []
            n = 200
            for s in range(n + 1):
                x = x0 + (x1 - x0) * s / n
                X = x - cx
                lo, hi = p, p + 2 * R
                for _ in range(48):
                    mid = (lo + hi) / 2
                    if mid * (1 - R * R / (X * X + mid * mid)) < p:
                        lo = mid
                    else:
                        hi = mid
                pts.append((x, cy + math.copysign((lo + hi) / 2, psi)))
            if not any(y0 - 0.01 <= y <= y1 + 0.01 for _, y in pts):
                continue
            # Downstream from just before the stone: one smooth line.
            split = -R * 0.9
            smooth_pts = [(x, y) for x, y in pts if x - cx >= split and y0 - 0.01 <= y <= y1 + 0.01]
            if len(smooth_pts) > 1:
                out.append(f'<path d="M' + ' L'.join(f'{f(x)} {f(y)}' for x, y in smooth_pts)
                           + f'" fill="none" stroke="{lines}" stroke-width="{f(sw)}"></path>')
            # Upstream: grains at a fixed pitch, lengthening as they near the stone.
            xg = x0
            while xg - cx < split:
                X = xg - cx
                lo, hi = p, p + 2 * R
                for _ in range(48):
                    mid = (lo + hi) / 2
                    if mid * (1 - R * R / (X * X + mid * mid)) < p:
                        lo = mid
                    else:
                        hi = mid
                y = cy + math.copysign((lo + hi) / 2, psi)
                t = sm(-R * 4, split, X)
                L = sw * 1.05 + (pitch + 0.12 - sw * 1.05) * t
                if y0 - 0.01 <= y <= y1 + 0.01:
                    xa = max(x0, xg - L / 2)
                    xb = min(cx + split, xg + L / 2)
                    if xb > xa:
                        out.append(sq(xa, y - sw / 2, xb - xa, sw, lines))
                xg += pitch
        m += 1
    out.append(circ(cx, cy, rs, stone))
    return ''.join(out)


# ── Icons ───────────────────────────────────────────────────────────────────


def icon(bg, inner, scale=1.0, dx=None, dy=None, rx=22.4):
    t = (100 - 100 * scale) / 2
    return (f'<rect width="100" height="100" rx="{rx}" fill="{bg}"></rect>'
            f'<g transform="translate({f(dx if dx is not None else t)} {f(dy if dy is not None else t)}) scale({f(scale)})">{inner}</g>')


def ripple_icon(bg, lines, stone):
    """Karesansui as an app icon: a framed patch of raked gravel, kept clear of the squircle's corners."""
    return icon(bg, morph_garden(cx=54, cy=53, half=7, n=2, sw=2.4, step=7, lines=lines, stone=stone,
                                 rounds=(0.4, 1.0), box=(17, 18, 83, 82)), 1.0)


def ripple_fav(bg, lines, stone):
    """16 px: the stone, one ring, and a raked line above and below, so it doesn't read as a stop button."""
    return icon(bg, sq(40, 40, 20, 20, stone) + circ(50, 50, 23, 'none', lines, 6.5)
                + sq(16, 10, 68, 7, lines) + sq(16, 83, 68, 7, lines), 1.0)


KASURE = dict(t0=0.64, floor=0.44)
FINE = dict(cell=1.2, t0=0.6, floor=0.36, streaks=0.75)


def build():
    d = {}
    # Ensō
    d['e1'] = enso_kasure(**KASURE)
    d['e2'] = enso_kasure(**FINE)
    d['e3'] = enso_entry()
    d['e4'] = enso_kasure(**FINE)
    d['e5'] = enso_kasure(ink=SHU, **FINE)
    d['e6'] = enso_kasure(ink=K, **FINE)
    d['seal'] = hanko_seal(0, 0, 100)
    d['i_e1'] = icon(K, enso_kasure(cell=3.6, t0=0.64, floor=0.3, b=Brush(w=7.6)), 0.86)
    d['i_e3'] = icon(K, enso_entry(cell=3.6, t1=0.36, b=Brush(w=7.6)), 0.86)
    d['i_e6'] = icon(S, enso_kasure(ink=K, cell=2.2, t0=0.6, floor=0.2, streaks=0.7, b=Brush(w=7.6)), 0.86)
    d['f_e1'] = icon(K, enso_kasure(cell=8, t0=0.66, floor=0.4, b=Brush(w=11, r=32)), 1.0)
    d['f_e3'] = icon(K, enso_entry(cell=8, t1=0.4, b=Brush(w=11, r=32)), 1.0)
    d['f_e6'] = icon(S, enso_kasure(ink=K, cell=8, t0=0.66, floor=0.4, b=Brush(w=11, r=32)), 1.0)
    # Tsuki
    jusanya = lambda s: 0.16 + 0.76 * (1 - s) ** 1.4
    earthshine = lambda s: 0.1 + 0.5 * (1 - s) ** 2
    d['t1'] = moon(a=0.34, dens=jusanya)
    d['t2'] = moon(a=0.58, shape='crescent', dens=earthshine)
    d['t3'] = suigetsu()
    d['t4'] = suigetsu(moonc=SHU, bars=S)
    d['t5'] = moon(a=0.58, lit=S, shape='crescent', dens=earthshine)
    d['t6'] = phases()
    d['i_t3'] = icon(S, suigetsu(cy=31, r=19, y0=62, step=7, h=3.6, cell=3.6, rows=SUIGETSU_ROWS[:4]), 1.0)
    d['i_t2'] = icon(AI, moon(r=34, a=0.58, cell=4.4, gap=0.12, shape='crescent', dens=earthshine), 1.0)
    d['i_t5'] = icon(K, moon(r=34, a=0.58, lit=S, cell=4.4, gap=0.12, shape='crescent', dens=earthshine), 1.0)
    d['f_t3'] = icon(S, suigetsu(cy=32, r=21, y0=66, step=12, h=7, cell=7, rows=[(0.8, [(-1, 1)]), (0.9, [(-0.9, -0.1), (0.3, 0.9)])]), 1.0)
    d['f_t2'] = icon(AI, moon(r=38, a=0.55, cell=12, gap=0.1, shape='crescent', dens=lambda s: 0.3), 1.0)
    d['f_t5'] = icon(K, moon(r=38, a=0.55, lit=S, cell=12, gap=0.1, shape='crescent', dens=lambda s: 0.3), 1.0)
    # Karesansui
    d['k1'] = garden([(58, 54, 7, 4, S)])
    d['k2'] = morph_garden()
    d['k3'] = flow()
    d['k4'] = garden([(40, 42, 8, 4, S), (73, 72, 3.2, 2, SHU)])
    d['k5'] = morph_garden(grains=True)
    d['k6'] = morph_garden(lines=U, stone=SHU, grains=True)
    d['i_k2'] = ripple_icon(K, S, S)
    d['i_k5'] = icon(K, morph_garden(cx=54, cy=53, half=7, n=2, sw=2.4, step=7, lines=S, stone=S, grains=True, pitch=4.8, reach=18,
                                     rounds=(0.4, 1.0), box=(17, 18, 83, 82)), 1.0)
    d['i_k6'] = ripple_icon(S, U, SHU)
    d['f_k2'] = ripple_fav(K, S, S)
    d['f_k5'] = d['f_k2']
    d['f_k6'] = ripple_fav(S, U, SHU)
    return d


if __name__ == '__main__':
    d = build()
    json.dump(d, open(sys.argv[1], 'w'), indent=1)
    print({k: len(v) for k, v in d.items()})
