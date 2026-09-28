"""The small drawings of the mark: five lines (drawn for 32 px) and three lines on whole pixels (drawn for 16 px)."""
from base import f
from sizes import pathd


def five(fg, bg=None, rx=22.4):
    """The 32 px drawing: five heavy lines, every one bent by the ghost."""
    from meisai import mark
    body = mark(fg, n=5, sw=5.6, box=(16, 20, 84, 80), r=46, pull=0.5, power=1.2)
    return (f'<rect width="100" height="100" rx="{f(rx)}" fill="{bg}"></rect>' if bg else '') + body


def three(fg, bg=None, rx=22.4, sw=12.5, bend=7.5, x0=12.5, x1=87.5):
    """The 16 px drawing: three lines on whole pixels; the outer two bow toward the straight middle one."""
    out = [f'<rect width="100" height="100" rx="{f(rx)}" fill="{bg}"></rect>'] if bg else []
    for y, s in ((25, 1), (50, 0), (75, -1)):
        pts, x = [], x0
        while x <= x1 + 1e-6:
            t = (x - 50) / ((x1 - x0) / 2)
            pts.append((x, y + s * bend * (1 - t * t) ** 1.5))
            x += 2.5
        out.append(f'<path d="{pathd(pts)}" fill="none" stroke="{fg}" stroke-width="{f(sw)}" stroke-linecap="butt"></path>')
    return ''.join(out)


def split(svg, line, top, bottom):
    """Recolour the first and last line of a drawing: the colour split of the cyber editions, at its simplest."""
    parts = svg.split('<path ')
    paths = ['<path ' + q for q in parts[1:]]
    paths[0] = paths[0].replace(f'stroke="{line}"', f'stroke="{top}"')
    paths[-1] = paths[-1].replace(f'stroke="{line}"', f'stroke="{bottom}"')
    return parts[0] + ''.join(paths)
