"""The app icon for each platform, drawn to that platform's spec from the per-size drawings.

    python3 design/brand/generator/platforms.py            # SVG sources and the PNG job list
    node design/brand/generator/render.mjs design/brand/generator/platform-jobs.json .
    python3 design/brand/generator/platforms.py --pack     # .ico files, and copies

Every bitmap uses the drawing made for its size, never a scaled-down large one:

- macOS (desktop/wails/packaging/icons/macos): the iconset for iconutil, 16 to 1024 px. Big Sur's
  icon grid: the rounded tile is 824/1024 of the canvas, centred, over a soft shadow.
- Windows (desktop/wails/packaging/icons/windows/appicon.ico): 16, 20, 24, 32, 40, 48, 64, 96 and
  256 px, the tile filling the canvas with a margin of 1/32.
- Linux (desktop/wails/packaging/icons/linux/hicolor): the freedesktop icon theme's sizes, 16 to
  512 px, plus scalable/apps/icon.svg; the tile fills the canvas with a margin of 1/32.
- Web (web/console/public): favicon.ico (16, 32, 48), the rounded tile for the manifest's "any"
  icons, full-bleed squares for its "maskable" icons and for apple-touch-icon.png (both masked
  by the platform).
"""
import json, os, shutil, struct, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cyber  # noqa: E402

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
    """The icon at the drawing for its size, in the 100-unit box."""
    label = drawing_for(pixels)
    if label in ('32', '16'):
        return cyber.small(label, COLOURWAY, rx=0 if square else 22.4)
    return cyber.cyber(label, COLOURWAY, square=square)


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
    print(f'wrote {len(listed)} jobs to platform-jobs.json and the scalable Linux icon')


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
