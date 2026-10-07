# Mister Morph design

The brand identity. [`DESIGN.md`](DESIGN.md) is the specification: the idea, how the
mark is built, and the rules for colour, type, motion and the UI. The living design canvas, with every board and the
exploration rounds, is at <https://claude.ai/artifact/6TyRi4ba7hmnEWbw75BuhM> (private until its owner shares it).

![Brand · Identity](boards/01-brand-identity.png)

## What's here

| Path | Contents |
|---|---|
| `DESIGN.md` | The design language and its rules |
| `brand/icons/<colourway>/icon-<size>.{svg,png}` | The app icon in seven colourways, each drawn separately at six optical sizes |
| `brand/icons/<colourway>/icon-circle-<size>.{svg,png}` | The circle alternative: a round panel, no field texture, the ghost at one proportion for every size |
| `brand/marks/` | The mark without a background: `mark.svg` (five lines, `currentColor`), `mark-16.svg` (three lines), `mark-suimen.svg` (cyan and magenta split) |
| `brand/motion/` | `ugoki.svg`, the ghost drifting through the lines (splash, hero); `kangae.svg`, the icon breathing (the working state). Both animate with SVG SMIL |
| `brand/tokens.json` | Colourway palettes, optical-size notes, typefaces |
| `brand/generator/` | The Python that draws all of the above, and `render.mjs` for the PNGs |
| `boards/` | Every canvas board as a PNG: the brand sheet (`01`, `02`), the Aojashin colourway (`03`) and the exploration rounds (`10`–`13`) |

## Regenerating

```sh
python3 design/brand/generator/generate.py      # SVGs, tokens.json, and the PNG job list
node design/brand/generator/render.mjs          # PNGs; needs playwright-core, and CHROMIUM_PATH if Chromium isn't found
```

The generator is deterministic: running it again reproduces these files exactly.

The app icon for each platform comes from `platforms.py`, which writes straight into the product:

```sh
python3 design/brand/generator/platforms.py                                          # SVG sources and job list
node design/brand/generator/render.mjs design/brand/generator/platform-jobs.json .   # PNGs, from the repo root
python3 design/brand/generator/platforms.py --pack                                   # the .ico files, and copies
```

## In the product

Every icon in the product but the boot splash uses the circle drawing. The console's logos and favicons use Aojashin for
the light theme and Suimen for the dark theme. The login and default avatar are Aojashin, since the console has only a
light theme so far; the boot splash is the Aojashin 64 drawing with the ghost drifting through it
(`web/console/src/core/ghost-mark.js`, the drift quickened to a 2.4 s figure of eight); `favicon.svg` carries both and
follows the browser's colour scheme. The console's SVG logos all use the 64 drawing, because they are shown below 64 CSS
px on screens that are mostly retina.

The app icons can't follow a theme, so they are the Aojashin circle. Each platform gets its own spec, and every bitmap
uses the drawing made for its size (16 below 24 px, then 32, 64 from 48, 128 from 96, 256 from 192, 1024 from 512):

| Platform | Files | Spec |
|---|---|---|
| macOS | `desktop/wails/packaging/icons/macos/`, the iconset `package-darwin.sh` turns into the `.icns`; `packaging/appicon.png` is its 1024 | Big Sur's grid: the tile is 824/1024 of the canvas, centred over a soft shadow |
| Windows | `desktop/wails/packaging/icons/windows/appicon.ico`: 16, 20, 24, 32, 40, 48, 64, 96, 256 | The tile fills the canvas, margin 1/32 |
| Linux | `desktop/wails/packaging/icons/linux/hicolor/`: 16 to 512 and `scalable/`, installed as the icon theme by the `.deb` and the AppImage | As Windows |
| Window icon | macOS: `appicon.png`; Linux and Windows: the 256 Linux icon (`desktop/wails/icon*.go`) | |
| Web | `web/console/public/`: `favicon.ico` (16, 32, 48) and `android-chrome-*` for the manifest's `any`; `maskable-*` and `apple-touch-icon.png`, full-bleed squares for the platform to mask; `safari-pinned-tab.svg`, the 16 drawing's lines in one colour | The circle, scaled to 0.9, keeps the ghost inside the maskable safe zone |

Not done yet:

- The docs site and the project site (`web/vitepress`, `theme/`) keep their previous logo and favicons.

- Suimen, in the dark favicon, is the only cyber colourway in the product so far.
- The console still has one light theme; the other UI themes are specified in `DESIGN.md` §7.
