"""The app icon for each platform, drawn to that platform's spec from the per-size circle drawings.

    python3 design/brand/generator/platforms.py            # SVG sources and the PNG job list
    node design/brand/generator/render.mjs design/brand/generator/platform-jobs.json .
    python3 design/brand/generator/platforms.py --pack     # .ico files, and copies

Every bitmap uses the drawing made for its size, never a scaled-down large one:

- macOS (desktop/wails/packaging/icons/macos): the iconset for iconutil, 16 to 1024 px. Big Sur's
  icon grid: the tile is 824/1024 of the canvas, centred, over a soft shadow.
- Windows (desktop/wails/packaging/icons/windows/appicon.ico): 16, 20, 24, 32, 40, 48, 64, 96 and
  256 px, the tile filling the canvas with a margin of 1/32.
- Linux (desktop/wails/packaging/icons/linux/hicolor): the freedesktop icon theme's sizes, 16 to
  512 px, plus scalable/apps/icon.svg; the tile fills the canvas with a margin of 1/32.
- Web (web/console/public): favicon.ico (16, 32, 48) and the manifest's "any" icons; full-bleed
  squares for its "maskable" icons and for apple-touch-icon.png (both masked by the platform), the
  circle inside the safe zone.
- Console SVGs (web/console): the logos and favicon.svg, the drawing at 64 (they show below 64 CSS
  px on screens that are mostly retina); favicon.svg is Aojashin in light mode, Suimen in dark.
  safari-pinned-tab.svg is the 16 drawing's lines in one colour.
"""
import json, os, shutil, struct, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import circle  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
BUILD = os.path.join(ROOT, 'design', 'brand', 'platforms', '.build')
PACKAGING = os.path.join(ROOT, 'desktop', 'wails', 'packaging', 'icons')
WEB = os.path.join(ROOT, 'web', 'console', 'public')
WEB_ASSETS = os.path.join(ROOT, 'web', 'console', 'src', 'assets', 'images')
COLOURWAY = 'aojashin'

# Big Sur's grid: an 824 px tile centred on 1024, and the shadow under it.
MAC_TILE = 824 / 1024
MAC_SHADOW = dict(dy=10 / 1024, blur=12 / 1024, opacity=0.33)
MAC_ICONSET = [('icon_16x16.png', 16), ('icon_16x16@2x.png', 32), ('icon_32x32.png', 32), ('icon_32x32@2x.png', 64),
               ('icon_128x128.png', 128), ('icon_128x128@2x.png', 256), ('icon_256x256.png', 256),
               ('icon_256x256@2x.png', 512), ('icon_512x512.png', 512), ('icon_512x512@2x.png', 1024)]
WINDOWS_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 256]
LINUX_SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 256, 512]
FAVICON_SIZES = [16, 32, 48]


def drawing_for(pixels):
    """The optical size drawn for a tile this many pixels across."""
    for label, least in (('1024', 512), ('256', 192), ('128', 96), ('64', 48), ('32', 24)):
        if pixels >= least:
            return label
    return '16'


def tile(pixels, square=False):
    """The circle icon at the drawing for its size, in the 100-unit box. A square is for a platform that masks the
    icon to its own shape: the ground fills it, and the circle shrinks to 0.9 so the ghost (radius 43 x 0.9 = 38.7)
    stays inside the maskable safe zone (radius 40)."""
    drawing = circle.circle_icon(drawing_for(pixels), COLOURWAY)
    if not square:
        return drawing
    return (f'<rect width="100" height="100" fill="{circle.COLOURS[COLOURWAY]["bg"]}"></rect>'
            f'<g transform="translate(5 5) scale(0.9)">{drawing}</g>')


def svg(size, body, defs=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
            f'{defs}{body}</svg>\n')


def placed(size, inner_px, square=False, shadow=None):
    """A tile of inner_px, centred on a canvas of size, optionally over a shadow."""
    offset = (size - inner_px) / 2
    group = f'<g transform="translate({offset:g} {offset:g}) scale({inner_px / 100:g})">{tile(inner_px, square)}</g>'
    if not shadow:
        return svg(size, group)
    defs = (f'<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
            f'<feDropShadow dx="0" dy="{shadow["dy"] * size:g}" stdDeviation="{shadow["blur"] * size:g}" '
            f'flood-color="#000" flood-opacity="{shadow["opacity"]:g}"/></filter></defs>')
    return svg(size, f'<g filter="url(#shadow)">{group}</g>', defs)


def filled(size):
    """The tile filling the canvas with a margin of 1/32 (Windows, Linux)."""
    margin = round(size / 32)
    return placed(size, size - 2 * margin)


def plan():
    """Every file to render: (svg text, png path, size)."""
    jobs = []
    for name, size in MAC_ICONSET:
        jobs.append((placed(size, size * MAC_TILE, shadow=MAC_SHADOW), os.path.join(PACKAGING, 'macos', name), size))
    for size in WINDOWS_SIZES:
        jobs.append((filled(size), os.path.join(BUILD, 'windows', f'{size}.png'), size))
    for size in LINUX_SIZES:
        jobs.append((filled(size), os.path.join(PACKAGING, 'linux', 'hicolor', f'{size}x{size}', 'apps', 'icon.png'), size))
    for size in FAVICON_SIZES:
        jobs.append((placed(size, size), os.path.join(BUILD, 'favicon', f'{size}.png'), size))
    for size in (192, 512):
        jobs.append((placed(size, size), os.path.join(WEB, f'android-chrome-{size}x{size}.png'), size))
        jobs.append((placed(size, size, square=True), os.path.join(WEB, f'maskable-{size}x{size}.png'), size))
    jobs.append((placed(180, 180, square=True), os.path.join(WEB, 'apple-touch-icon.png'), 180))
    return jobs


def console_svgs():
    """The console's own SVGs: the logos and the favicon that follows the colour scheme."""
    attrs = 'viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mister Morph"'
    light, dark = circle.circle_icon('64', 'aojashin'), circle.circle_icon('64', 'suimen')
    files = {
        os.path.join(WEB_ASSETS, 'app_logo.svg'): f'<svg width="512" height="512" {attrs}>{light}</svg>',
        os.path.join(WEB_ASSETS, 'app_logo_current.svg'):
            f'<svg class="sidebar-brand-logo" width="512" height="512" {attrs}>{light}</svg>',
        os.path.join(WEB, 'favicon.svg'):
            f'<svg width="32" height="32" {attrs}><style>.dark{{display:none}}@media (prefers-color-scheme: dark)'
            f'{{.light{{display:none}}.dark{{display:inline}}}}</style><g class="light">{light}</g>'
            f'<g class="dark">{dark}</g></svg>',
    }
    # Safari's pinned tab is a one-colour silhouette: the lines of the 16 drawing, without the panel.
    lines = circle.circle_icon('16', 'aojashin').split('</circle>', 1)[1]
    lines = lines.replace(circle.COLOURS['aojashin']['line'], '#000')
    files[os.path.join(WEB, 'safari-pinned-tab.svg')] = f'<svg width="16" height="16" {attrs}>{lines}</svg>'
    for path, text in files.items():
        with open(path, 'w') as fh:
            fh.write(text + '\n')


def write_sources():
    shutil.rmtree(BUILD, ignore_errors=True)
    listed = []
    for i, (text, png, size) in enumerate(plan()):
        source = os.path.join(BUILD, 'svg', f'{i:02d}.svg')
        os.makedirs(os.path.dirname(source), exist_ok=True)
        os.makedirs(os.path.dirname(png), exist_ok=True)
        with open(source, 'w') as fh:
            fh.write(text)
        listed.append({'svg': os.path.relpath(source, ROOT), 'png': os.path.relpath(png, ROOT), 'size': size})
    with open(os.path.join(HERE, 'platform-jobs.json'), 'w') as fh:
        fh.write(json.dumps(listed, indent=1) + '\n')
    # The scalable Linux icon: the largest drawing, at the same margin as the bitmaps.
    scalable = os.path.join(PACKAGING, 'linux', 'hicolor', 'scalable', 'apps', 'icon.svg')
    os.makedirs(os.path.dirname(scalable), exist_ok=True)
    with open(scalable, 'w') as fh:
        fh.write(filled(512).replace('width="512" height="512"', 'width="512" height="512" role="img" aria-label="Mister Morph"'))
    console_svgs()
    print(f'wrote {len(listed)} jobs to platform-jobs.json, the scalable Linux icon and the console SVGs')


def ico(pngs, path):
    """A .ico of PNG images, one per size (Windows Vista and later, and every browser)."""
    images = [open(p, 'rb').read() for p in pngs]
    sizes = [struct.unpack('>II', data[16:24]) for data in images]
    header = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b'', b''
    for data, (w, h) in zip(images, sizes):
        entries += struct.pack('<BBBBHHII', w % 256, h % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(header + entries + blobs)


def pack():
    ico([os.path.join(BUILD, 'windows', f'{s}.png') for s in WINDOWS_SIZES], os.path.join(PACKAGING, 'windows', 'appicon.ico'))
    ico([os.path.join(BUILD, 'favicon', f'{s}.png') for s in FAVICON_SIZES], os.path.join(WEB, 'favicon.ico'))
    # The console also bundles these two, and the desktop app's macOS icon keeps its old path.
    for name in ('favicon.ico', 'apple-touch-icon.png'):
        shutil.copyfile(os.path.join(WEB, name), os.path.join(WEB_ASSETS, name))
    shutil.copyfile(os.path.join(PACKAGING, 'macos', 'icon_512x512@2x.png'), os.path.join(ROOT, 'desktop', 'wails', 'packaging', 'appicon.png'))
    shutil.rmtree(BUILD, ignore_errors=True)
    print('packed appicon.ico and favicon.ico; copied favicon.ico, apple-touch-icon.png and appicon.png')


if __name__ == '__main__':
    pack() if '--pack' in sys.argv else write_sources()
