"""Round 6: Kōgaku meisai, dug further. A field of lines with an invisible ghost in it; the ghost is visible only as
the way it bends the lines. Every mark lives in a 100×100 box."""
import json, math, sys

from base import f, sq, icon  # noqa: E402

YORU, PHOS, KIRI, HONE = '#0B1012', '#7CF5BF', '#7F8F8C', '#E7E4DA'
KINARI, SUMI = '#F2EDE2', '#1E1E20'


# Displacements: each takes (x, y) and the ghost (cx, cy, r) and returns where that point of the line is drawn.

def pinch(pull=0.42, power=1.5):
    """A glass ball: inside the ghost, lines are drawn in toward its centre; at the rim they are untouched."""
    def fn(x, y, cx, cy, r):
        rho2 = (x - cx) ** 2 + (y - cy) ** 2
        if rho2 >= r * r:
            return y
        return cy + (y - cy) * (1 - pull * (1 - rho2 / (r * r)) ** power)
    return fn


def rim(amp=2.4, width=4.2):
    """The film's camouflage: the inside is nearly clear; only the edge refracts, pushing lines outward."""
    def fn(x, y, cx, cy, r):
        rho = math.hypot(x - cx, y - cy)
        if rho < 1e-6:
            return y
        return y + amp * ((y - cy) / rho) * math.exp(-((rho - r) / width) ** 2)
    return fn


def field(fg, ghost=(50, 50, 26), disp=None, step=3.1, sw=0.6, box=(10, 10, 90, 90), dx=0.5, vertical=False):
    """Horizontal (or vertical) hairlines across the box, each bent by `disp` near the ghost."""
    disp = disp or pinch()
    cx, cy, r = ghost
    x0, y0, x1, y1 = box
    out = []
    a, a1 = (x0, x1) if vertical else (y0, y1)
    b0, b1 = (y0, y1) if vertical else (x0, x1)
    while a <= a1 + 0.01:
        pts = []
        b = b0
        while b <= b1 + 0.01:
            if vertical:
                # Swap axes: the line is x = a, bent sideways.
                pts.append((disp(b, a, cy, cx, r), b))
            else:
                pts.append((b, disp(b, a, cx, cy, r)))
            b += dx
        out.append('<path d="M' + ' L'.join(f'{f(p)} {f(q)}' for p, q in pts)
                   + f'" fill="none" stroke="{fg}" stroke-width="{f(sw)}"></path>')
        a += step
    return ''.join(out)


def raster(fg, ghost=(50, 50, 26), disp=None, step=3.1, sw=0.6, box=(10, 10, 90, 90), pitch=2.3, run=1.5):
    """Outside the ghost the lines are raster: runs of pixels. Where the ghost passes, each line is one smooth curve."""
    disp = disp or pinch(0.46)
    cx, cy, r = ghost
    x0, y0, x1, y1 = box
    out = []
    y = y0
    while y <= y1 + 0.01:
        dy = abs(y - cy)
        h = math.sqrt(r * r - dy * dy) if dy < r else 0
        xa, xb = cx - h, cx + h
        x = x0
        while x < x1 - 0.01:
            s, e = x, min(x + run, x1)
            if h > 0:
                if e > xa and s < xb:
                    s2, e2 = s, min(e, xa)
                    if e2 - s2 > 0.3:
                        out.append(sq(s2, y - sw / 2, e2 - s2, sw, fg))
                    s2, e2 = max(s, xb), e
                    if e2 - s2 > 0.3:
                        out.append(sq(s2, y - sw / 2, e2 - s2, sw, fg))
                    x += pitch
                    continue
            out.append(sq(s, y - sw / 2, e - s, sw, fg))
            x += pitch
        if h > 0.5:
            pts = []
            n = 60
            for i in range(n + 1):
                xx = xa + (xb - xa) * i / n
                pts.append((xx, disp(xx, y, cx, cy, r)))
            out.append('<path d="M' + ' L'.join(f'{f(p)} {f(q)}' for p, q in pts)
                       + f'" fill="none" stroke="{fg}" stroke-width="{f(sw)}"></path>')
        y += step
    return ''.join(out)


def drift(fg, frames=24, dur=14, step=3.4, sw=0.6, box=(10, 10, 90, 90), r=24, dx=1.25, disp=None):
    """The ghost drifts on a slow ellipse. Each line is one path whose shape is animated (SMIL) through precomputed
    frames; every frame has the same number of points, so the browser interpolates between them."""
    disp = disp or pinch(0.44)
    x0, y0, x1, y1 = box
    path_frames = []
    for k in range(frames + 1):
        th = 2 * math.pi * (k % frames) / frames
        cx, cy = 50 + 17 * math.cos(th), 50 + 11 * math.sin(th)
        lines = []
        y = y0
        while y <= y1 + 0.01:
            pts = []
            x = x0
            while x <= x1 + 0.01:
                pts.append((x, disp(x, y, cx, cy, r)))
                x += dx
            lines.append('M' + ' L'.join(f'{f(p)} {f(q)}' for p, q in pts))
            y += step
        path_frames.append(lines)
    out = []
    for i in range(len(path_frames[0])):
        values = ';'.join(fr[i] for fr in path_frames)
        out.append(f'<path d="{path_frames[0][i]}" fill="none" stroke="{fg}" stroke-width="{f(sw)}">'
                   f'<animate attributeName="d" dur="{dur}s" repeatCount="indefinite" values="{values}"></animate></path>')
    return ''.join(out)


def breathe(fg, bg, n=5, sw=5.4, frames=10, dur=3.2, box=(16, 18, 84, 82), r=30):
    """The icon's thinking state: the same field, with the ghost's pull breathing in and out."""
    x0, y0, x1, y1 = box
    step = (y1 - y0) / (n - 1)
    lines = []
    for k in range(frames + 1):
        pull = 0.2 + 0.4 * (0.5 - 0.5 * math.cos(2 * math.pi * k / frames))
        disp = pinch(pull, 1.2)
        fr = []
        for j in range(n):
            y = y0 + j * step
            pts = []
            x = x0
            while x <= x1 + 0.01:
                pts.append((x, disp(x, y, 50, 50, r)))
                x += 1.7
            fr.append('M' + ' L'.join(f'{f(p)} {f(q)}' for p, q in pts))
        lines.append(fr)
    body = ''.join(
        f'<path d="{lines[0][j]}" fill="none" stroke="{fg}" stroke-width="{f(sw)}" stroke-linecap="round">'
        f'<animate attributeName="d" dur="{dur}s" repeatCount="indefinite" values="{";".join(fr[j] for fr in lines)}"></animate></path>'
        for j in range(n))
    return f'<rect width="100" height="100" rx="22.4" fill="{bg}"></rect>' + body


def mark(fg, n=5, sw=5.4, box=(16, 18, 84, 82), r=30, pull=0.4, power=1.2, cap='round', ghost=(50, 50)):
    """The icon drawing: few, heavy lines, so the bend still reads at small sizes."""
    x0, y0, x1, y1 = box
    step = (y1 - y0) / (n - 1)
    disp = pinch(pull, power)
    out = []
    for j in range(n):
        y = y0 + j * step
        pts = []
        x = x0
        while x <= x1 + 0.01:
            pts.append((x, disp(x, y, ghost[0], ghost[1], r)))
            x += 1.7
        out.append('<path d="M' + ' L'.join(f'{f(p)} {f(q)}' for p, q in pts)
                   + f'" fill="none" stroke="{fg}" stroke-width="{f(sw)}" stroke-linecap="{cap}"></path>')
    return ''.join(out)


def vmark(fg, n=5, sw=5.6, box=(18, 16, 82, 84), r=44, pull=0.5, power=1.2, ghost=(50, 50)):
    """The sudare icon: vertical lines, a ghost standing behind the blind."""
    x0, y0, x1, y1 = box
    step = (x1 - x0) / (n - 1)
    disp = pinch(pull, power)
    out = []
    for j in range(n):
        x = x0 + j * step
        pts = []
        y = y0
        while y <= y1 + 0.01:
            pts.append((disp(y, x, ghost[1], ghost[0], r), y))
            y += 1.7
        out.append('<path d="M' + ' L'.join(f'{f(p)} {f(q)}' for p, q in pts)
                   + f'" fill="none" stroke="{fg}" stroke-width="{f(sw)}" stroke-linecap="round"></path>')
    return ''.join(out)


ICON = dict(n=5, sw=5.6, box=(16, 20, 84, 80), r=46, pull=0.5, power=1.2)
FAV = dict(n=4, sw=8.5, box=(16, 20, 84, 80), r=48, pull=0.5, power=1.2)


def build():
    d = {}
    d['m1'] = drift(HONE)
    d['m2'] = field(HONE, ghost=(56, 52, 25), disp=rim(1.1, 3.2), step=2.4, sw=0.45)
    d['m3'] = field(HONE, ghost=(52, 46, 22), disp=pinch(0.5), step=2.6, sw=0.45, vertical=True)
    d['m4'] = raster(HONE, ghost=(54, 52, 25))
    d['m5'] = field(SUMI, ghost=(60, 58, 22), disp=pinch(0.46), step=3.4, sw=0.6)
    d['i_dark'] = icon(YORU, mark(HONE, **ICON), 1.0)
    d['i_light'] = icon(KINARI, mark(SUMI, **ICON), 1.0)
    d['i_sudare'] = icon(YORU, vmark(HONE), 1.0)
    d['f_dark'] = icon(YORU, mark(HONE, **FAV), 1.0)
    d['f_light'] = icon(KINARI, mark(SUMI, **FAV), 1.0)
    d['f_sudare'] = icon(YORU, vmark(HONE, n=4, sw=8.5, r=48), 1.0)
    d['i_breathe'] = breathe(HONE, YORU, n=5, sw=5.6, box=(16, 20, 84, 80), r=46)
    d['lock'] = mark(HONE, **ICON)
    d['lock_sumi'] = mark(SUMI, **ICON)
    return d


if __name__ == '__main__':
    d = build()
    json.dump(d, open(sys.argv[1], 'w'), indent=1)
    print({k: len(v) for k, v in d.items()})
