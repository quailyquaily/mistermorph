"""Round 8: a cyberpunk colourway for the icon, after Ghost in the Shell. Same geometry as wa5's full-bleed ladder;
new colour, plus two effects that only make sense at large sizes: phosphor glow, and chromatic dispersion where the
ghost refracts the lines (the more a line bends, the further its colours split)."""
import itertools, math, sys

from base import f, sq  # noqa: E402
from meisai import pinch  # noqa: E402
from sizes import squircle_span, pathd, BLEED  # noqa: E402

_ids = itertools.count()

PALETTES = {
    # name: bg, field (dim pixel runs), ghost line, edge, (cyan, magenta) for dispersion or None, glow colour or None
    'rinko': dict(bg='#03100E', field='#0F3A32', line='#7CFFC4', edge='#0E2622', split=None, glow='#3DFFA8'),
    'bunko': dict(bg='#07080F', field='#1C2342', line='#F2F7FF', edge='#1A1F33', split=('#1FE5FF', '#FF2E8A'), glow=None),
    'denko': dict(bg='#0B0A1A', field='#34204A', line='#4DF3FF', edge='#221A36', split=None, glow='#28D8FF'),
    'kohaku': dict(bg='#0C0A08', field='#3A2A14', line='#FFB547', edge='#261D12', split=None, glow='#FF9A1F'),
    'aojashin': dict(bg='#2463AE', field='#5287C7', line='#FFFFFF', edge='#1D5496', split=None, glow=None),
    'suimen': dict(bg='#041417', field='#12403F', line='#D6FFF6', edge='#0F2A2C', split=('#22F2D0', '#FF3D7F'), glow=None),
}


def curve_pts(y, xa, xb, disp, ghost, dx=0.8):
    cx, cy, r = ghost
    pts, x = [], xa
    while x <= xb + 1e-6:
        pts.append((x, disp(x, y, cx, cy, r)))
        x += dx
    if pts[-1][0] < xb:
        pts.append((xb, disp(xb, y, cx, cy, r)))
    return pts


def cyber(label, pal, glow=True, split=True, split_k=0.22, square=False):
    """One optical size in a cyber palette. Large sizes carry the effects; 32 and 16 stay plain."""
    p = PALETTES[pal]
    spec = {b[0]: b for b in BLEED}[label]
    _, step, sw, r, ras, pull, power = spec
    big = int(label) >= 128
    uid = next(_ids)
    cx = cy = 50.0
    disp = pinch(pull, power)
    rx = 0 if square else 22.4
    margin = 1.6 if int(label) >= 64 else 0.8
    span = (lambda y, m: (m, 100 - m)) if square else squircle_span
    defs, field, lines = [], [], []
    use_glow = glow and big and p['glow']
    use_split = split and int(label) >= 64 and p['split']
    if use_glow:
        defs.append(f'<filter id="g{uid}" x="-10%" y="-10%" width="120%" height="120%">'
                    f'<feGaussianBlur in="SourceGraphic" stdDeviation="{f(sw * 1.1)}" result="b"></feGaussianBlur>'
                    '<feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter>')
    ys = [50.0]
    k = 0
    while True:
        k += 1
        if 50 - k * step < margin + sw:
            break
        ys += [50 - k * step, 50 + k * step]
    for y in sorted(ys):
        s = span(y, margin)
        if not s:
            continue
        a, b = s
        dy = abs(y - cy)
        h = math.sqrt(r * r - dy * dy) if dy < r else 0.0
        segs = [(a, b)] if h == 0 else [(a, cx - h - sw * 0.9), (cx + h + sw * 0.9, b)]
        for s0, e0 in segs:
            if e0 - s0 <= sw:
                continue
            if ras == 'cont':
                field.append(sq(s0, y - sw / 2, e0 - s0, sw, p['field']))
            else:
                pitch, run = ras
                j = math.floor((s0 - cx) / pitch - 0.5) - 1
                while True:
                    xc = cx + (j + 0.5) * pitch
                    if xc - run / 2 > e0:
                        break
                    if xc - run / 2 >= s0 - 1e-6 and xc + run / 2 <= e0 + 1e-6:
                        field.append(sq(xc - run / 2, y - sw / 2, run, sw, p['field']))
                    j += 1
        if h > 0:
            xa, xb = max(a, cx - h), min(b, cx + h)
            pts = curve_pts(y, xa, xb, disp, (cx, cy, r))
            if use_split:
                c, m = p['split']
                cyan = [(x, yy - split_k * (yy - y) * 1.0 - 0.0) for x, yy in pts]
                mag = [(x, yy + split_k * (yy - y)) for x, yy in pts]
                lines.append(f'<path d="{pathd(mag)}" fill="none" stroke="{m}" stroke-width="{f(sw)}" stroke-linecap="round" style="mix-blend-mode: screen"></path>')
                lines.append(f'<path d="{pathd(cyan)}" fill="none" stroke="{c}" stroke-width="{f(sw)}" stroke-linecap="round" style="mix-blend-mode: screen"></path>')
                lines.append(f'<path d="{pathd(pts)}" fill="none" stroke="{p["line"]}" stroke-width="{f(sw * 0.5)}" stroke-linecap="round"></path>')
            else:
                lines.append(f'<path d="{pathd(pts)}" fill="none" stroke="{p["line"]}" stroke-width="{f(sw)}" stroke-linecap="round"></path>')
    out = [f'<defs>{"".join(defs)}</defs>' if defs else '',
           f'<rect width="100" height="100" rx="{f(rx)}" fill="{p["bg"]}"></rect>', ''.join(field)]
    body = ''.join(lines)
    out.append(f'<g filter="url(#g{uid})">{body}</g>' if use_glow else f'<g style="isolation: isolate">{body}</g>')
    if int(label) >= 64 and not square:
        out.append(f'<rect x="0.5" y="0.5" width="99" height="99" rx="22" fill="none" stroke="{p["edge"]}" stroke-width="1"></rect>')
    return ''.join(out)


def small(label, pal, rx=22.4):
    """32 and 16: the clean drawings from the main ladder, recoloured. In a dispersion palette the split survives in its
    simplest form: the top line cyan, the bottom line magenta, the middle white."""
    from marks import five, three
    p = PALETTES[pal]
    svg = five(p['line'], p['bg'], rx) if label == '32' else three(p['line'], p['bg'], rx)
    if p['split']:
        c, m = p['split']
        parts = svg.split('<path ')
        head, paths = parts[0], ['<path ' + q for q in parts[1:]]
        paths[0] = paths[0].replace(f'stroke="{p["line"]}"', f'stroke="{c}"')
        paths[-1] = paths[-1].replace(f'stroke="{p["line"]}"', f'stroke="{m}"')
        svg = head + ''.join(paths)
    return svg


def icon(label, pal, **kw):
    return small(label, pal) if label in ('32', '16') else cyber(label, pal, **kw)
