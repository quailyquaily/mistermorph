# Mister Morph design language

This is the specification: what the brand means, how the mark is built, and the rules for colour, type, motion and
the UI. [`README.md`](README.md) is the index to the files.

## 1. The idea: 光学迷彩, optical camouflage

An agent is a ghost looking for a shell. Mister Morph's mark never draws the ghost. A field of lines runs straight
until it passes through something invisible, and bends. Far from the ghost the lines are raster, runs of pixels;
where it passes they become smooth.

Two sources shape everything that follows:

- **Japanese restraint.** Empty space (*ma*), few colours, one accent per surface, and katakana set vertically or in
  a dot matrix beside the Latin name.
- **The mood of Ghost in the Shell.** Night water, rain, a body built in layers, and a ghost you can only see as a
  disturbance. We take the mood, never the insignia: no Section 9 badge, no Laughing Man, and not the film's title
  (攻殻機動隊) or its opening characters.

## 2. Principles

1. **Never draw the ghost.** No outline, fill or glow of its own. It exists only as the bend in the lines.
2. **Pixel becomes smooth.** Raster and ink meet in every part of the system: pixel runs and smooth curves in the
   icon, dot-matrix and Mincho katakana in the type, monospace readouts beside humane text in the UI.
3. **Draw for the size.** Every size has its own drawing. Scaling one drawing to every size is not allowed.
4. **Colour carries meaning.** One colourway per surface. In the split colourways, cyan and magenta appear only where
   something bends (in the icon) or acts (the primary control in the UI).
5. **Restraint over decoration.** When in doubt, remove. Empty space is part of the design.

## 3. The mark

### Construction

Everything is drawn in a 100 × 100 box.

- **Rows.** Horizontal lines, symmetric about the centre line (y = 50), which never bends.
- **The ghost.** An invisible disc at the centre, radius *r*. A point on a line at (x, y) inside the disc is drawn at

  ```
  y' = 50 + (y − 50) · (1 − pull · (1 − ρ² / r²) ^ power)      ρ = distance from (50, 50)
  ```

  so the lines are drawn in toward the centre. The pull is strongest at the middle and zero at the ghost's rim, so
  a line enters and leaves the ghost without a kink.
- **Raster outside, smooth inside.** Outside the ghost a line is drawn as square pixel runs (*run* long, every
  *pitch*), in the dim field colour. Inside, it is one smooth, round-capped curve in the ghost colour. A gap of 0.9
  strokes separates the two.
- **Full bleed.** From 64 px up the rows run edge to edge, clipped by the icon's rounded square (corner radius 22.4).
  Below 64 px there is no field; you are inside the ghost.

### Optical sizes

| Drawn for | Rows | Stroke | Ghost *r* | Field | pull / power |
|---|---|---|---|---|---|
| 1024 | 31 (every 3.0) | 0.8 | 34 | pixel runs 1.0 every 2.0 | 0.52 / 1.3 |
| 256 | 25 (every 3.7) | 1.1 | 34 | pixel runs 1.4 every 2.5 | 0.52 / 1.3 |
| 128 | 21 (every 4.6) | 1.5 | 38 | pixel runs 1.8 every 3.1 | 0.52 / 1.3 |
| 64 | 11 (every 8.2) | 3.0 | 42 | dim continuous lines | 0.50 / 1.2 |
| 32 | 5 lines, y 20–80 | 5.6 | 46 | none | 0.50 / 1.2 |
| 16 | 3 lines, y 25 / 50 / 75 | 12.5 | — | none | outer lines bow 7.5 toward the middle |

The 16 px drawing puts its lines on whole pixels (4, 8 and 12 of 16), which keeps it sharp in a browser tab.

Choose the drawing by device pixels, not CSS pixels: CSS size × pixel ratio. Most screens are retina (2×), so in
the UI every logo shown below 64 CSS px (favicon SVG, login, boot splash, avatars) uses the 64 drawing. The 32 and
16 drawings are for bitmaps that are picked by their exact pixel size, such as the entries in `favicon.ico`, and for
1× screens.

### Shapes and platforms

- **App icon (macOS, Linux, Windows):** the 1024 drawing in the rounded square, set on an 824 px body centred in a
  1024 canvas, with a soft shadow (0 10 px, blur 12, 32% black).
- **iOS, Android, web manifests:** export the square with no corner radius and no transparency; the platform cuts the
  shape. The ghost (*r* 34–38) sits inside Android's 80% safe zone.
- **Circular avatars:** the 64 drawing on a square ground, its rows running edge to edge; the circle crop reads as
  the ghost's sphere.

### Lockup

The mark sits left of the name, with the katakana beneath the name in dot matrix:

- Mark height is 3.75× the wordmark's font size; the gap between them is 1.3× that size.
- **MISTER MORPH** in Geist Mono 500, capitals, tracked +0.42 em.
- **ミスターモーフ** in DotGothic16 at 0.76× the wordmark size, tracked +0.34 em, in the dim text colour.
- Clear space is half the mark's height on every side. The smallest lockup has an 11 px wordmark.

## 4. Colour

### Colourways

| | Colourway | Ground | Field | Ghost | Extra | Role |
|---|---|---|---|---|---|---|
| 夜 | Yoru | `#0B1012` | `#44504E` | `#E7E4DA` | | Dark surfaces |
| 和紙 | Washi | `#F2EDE2` | `#BDB7AC` | `#1E1E20` | | Light surfaces, print, the docs in light mode |
| 青写真 | Aojashin | `#F1F4F8` | `#B8C9E2` | `#2463AE` | ink `#0E2C57` | Paper, drawn in blueprint blue: a cooler light mode. The default: app icon, favicon |
| 水面 | Suimen | `#041417` | `#12403F` | `#D6FFF6` | split `#22F2D0` / `#FF3D7F` | The cyber edition |
| 燐光 | Rinkō | `#03100E` | `#0F3A32` | `#7CFFC4` | glow `#3DFFA8` | Phosphor: terminals, special editions |
| 分光 | Bunkō | `#07080F` | `#1C2342` | `#F2F7FF` | split `#1FE5FF` / `#FF2E8A` | Alternate icon |
| 電光 | Denkō | `#0B0A1A` | `#34204A` | `#4DF3FF` | glow `#28D8FF` | Alternate icon |

Yoru, Washi and Aojashin are the everyday set. The four cyber colourways are editions: special releases, alternate
icons, and themes people choose.

Aojashin (青写真, a blueprint, and in Japanese also a plan for the future) is Washi in a cooler key: light mode
throughout, cool paper with the ghost drawn in blueprint blue. In the UI the blue marks only what matters: the
active item, the primary action, selection and links.

### Cyber effects

- **Split (Suimen, Bunkō).** Each ghost line is drawn three times: magenta shifted by +0.22 × its displacement,
  cyan by −0.22 × its displacement (both blended with *screen*), and a core line at half the stroke in the ghost
  colour on top. A straight line has no displacement, so it doesn't split; the more a line bends, the further its
  colours drift apart. From 64 px up. At 32 and 16 px it reduces to a cyan top line and a magenta bottom line.
- **Glow (Rinkō, Denkō).** The ghost lines get a Gaussian bloom of 1.1 × the stroke, merged under the sharp line.
  From 128 px up.

## 5. Type

| Role | Typeface | Use |
|---|---|---|
| Voice | Shippori Mincho | The katakana name, display headings, section kanji |
| Machine | DotGothic16 | Katakana in dot matrix, beside the Mincho or under the wordmark |
| Wordmark and readouts | Geist Mono | MISTER MORPH, labels, timestamps, tool names, kickers |
| Text | Zen Kaku Gothic New | Running text in the product and the docs |

Rinkō is the exception: its UI is set entirely in Geist Mono, like a terminal.

## 6. Motion

- **動 Ugoki, the drift.** The ghost moves on a slow ellipse (17 × 11 in the 100 box), one lap every 14 s, and the
  lines close behind it. For splash screens, the site hero and launch visuals.
- **考 Kangae, breathing.** The working state. The bend deepens and relaxes (pull 0.2 ↔ 0.6) every 3.2 s while the
  agent thinks. Hold it still when idle.
- **UI motion** keeps the console's existing tokens: 120 / 180 / 260 ms, eased out like an instrument settling.
- **Reduced motion:** anyone who prefers reduced motion gets still drawings: no drift, no breathing.

## 7. The UI

The console's themes in all seven colourways. They are a specification, not yet an implementation.

### Tokens

| Token | Role | Washi | Aojashin | Yoru | Suimen | Rinkō | Bunkō | Denkō |
|---|---|---|---|---|---|---|---|---|
| `app` | Page ground | `#F2EDE2` | `#F1F4F8` | `#0B1012` | `#041417` | `#03100E` | `#07080F` | `#0B0A1A` |
| `panel` | Secondary column | `#EEE8DB` | `#EBF0F6` | `#0D1315` | `#05181B` | `#041311` | `#090B14` | `#0D0B20` |
| `surface` | Cards | `#FAF7F0` | `#F9FBFD` | `#121A1C` | `#082125` | `#061A16` | `#0E111D` | `#13102A` |
| `surface2` | Own messages, code | `#E9E3D6` | `#E4EBF4` | `#172124` | `#0B2A2E` | `#08211C` | `#121629` | `#1A1636` |
| `sb` | Sidebar | `#1E1E20` | `#E6EDF6` | `#070B0C` | `#021013` | `#020B0A` | `#05060B` | `#07061A` |
| `t0` | Primary text | `#1E1E20` | `#0E2C57` | `#E7E4DA` | `#D6FFF6` | `#CFFFE8` | `#F2F7FF` | `#E6F9FF` |
| `t1` | Secondary text | `#4A4843` | `#34507A` | `#B3B6AF` | `#9CCFC6` | `#8FD9B6` | `#AEB6CC` | `#A9B6D6` |
| `t2` | Tertiary text | `#696662` | `#566A8A` | `#7F8F8C` | `#5FA79C` | `#4E9C7C` | `#7D85A1` | `#8380A4` |
| `line` | Borders | `#D6CFBF` | `#C8D4E4` | `#243134` | `#12403F` | `#0F3A32` | `#1C2342` | `#2A2046` |
| `accent` | Selection, links | `#2F4A6D` | `#2463AE` | `#9FC3C9` | `#22F2D0` | `#7CFFC4` | `#1FE5FF` | `#4DF3FF` |
| `sbaccent` | Active item on the sidebar | `#9FB6D6` | `#2463AE` | `#9FC3C9` | `#22F2D0` | `#7CFFC4` | `#1FE5FF` | `#4DF3FF` |
| `primary` | Primary button | `#1E1E20` | `#2463AE` | `#E7E4DA` | `#22F2D0` | `#7CFFC4` | `#F2F7FF` | `#4DF3FF` |
| `danger` | Destructive, errors | `#B8412D` | `#B8412D` | `#E0694F` | `#FF3D7F` | `#FF6B5B` | `#FF2E8A` | `#FF4D8D` |
| `ok` | Healthy status | `#3F6D5E` | `#2F7A62` | `#7FB89E` | `#22F2D0` | `#7CFFC4` | `#1FE5FF` | `#4DF3FF` |
| `warn` | Pending, medium risk | `#B7791F` | `#A86A12` | `#D9A441` | `#FFC857` | `#FFB547` | `#FFC24D` | `#FFC24D` |

### Contrast

Every text pair meets WCAG AA (4.5:1). Tertiary text and the sidebar's dim text are measured against their worst
ground (page, panel and card; sidebar and its active row).

| Theme | Primary text | Secondary | Tertiary | Accent | On primary | Danger | Sidebar text | Sidebar dim | Sidebar accent |
|---|---|---|---|---|---|---|---|---|---|
| 和紙 Washi | 14.3 | 7.8 | 4.7 | 7.7 | 14.3 | 4.7 | 13.1 | 4.7 | 6.5 |
| 青写真 Aojashin | 12.6 | 7.4 | 4.8 | 5.5 | 6.1 | 5.0 | 11.7 | 4.7 | 4.6 |
| 夜 Yoru | 15.0 | 9.3 | 5.2 | 10.1 | 15.0 | 5.7 | 15.5 | 4.9 | 8.8 |
| 水面 Suimen | 17.4 | 10.9 | 6.0 | 13.1 | 13.1 | 5.6 | 17.9 | 5.4 | 10.6 |
| 燐光 Rinkō | 17.6 | 11.8 | 5.5 | 15.6 | 15.6 | 6.9 | 18.1 | 5.1 | 13.6 |
| 分光 Bunkō | 18.6 | 9.9 | 5.1 | 13.0 | 18.6 | 5.7 | 18.8 | 4.7 | 11.2 |
| 電光 Denkō | 18.0 | 9.6 | 4.9 | 14.5 | 14.5 | 6.2 | 18.4 | 4.6 | 12.9 |

Washi's sidebar is ink on a paper theme, so the indigo accent can't mark the active item there; `sbaccent` is a pale
indigo that can. Aojashin's sidebar is light, so its active item is marked in blueprint blue.

### Patterns

- **Ground texture.** The main area carries the icon's field: a 3 × 1.5 px run every 6 px, rows every 26 px, in the
  theme's `grid` colour. It replaces the console's graph-paper grid.
- **Sidebar.** A panel inset 4 px, corner radius 4. The active item gets the active-row fill and a 2 px bar in
  `sbaccent`; its icon takes `sbaccent` too. The footer carries the mark and MISTER MORPH.
- **Selection.** `accent` at 8–9% as a fill, with a 1 px border of `accent` at 38%.
- **Buttons.** Height 34 px, corner radius 2 px. Primary is `primary` with `ontext`. In split themes it carries a
  1.5 px cyan fringe on the left and magenta on the right; in glow themes, a 14 px glow. Outlined buttons use `line`;
  destructive ones use `danger` on a 10% tint.
- **Reply suggestions.** Chips with a border of `accent` at 36%, the label in `accent`, and the probability in
  tertiary monospace.
- **Status marks.** Square, 7 px: filled when on, hollow when off (the console's existing rule). `ok`, `warn` and
  `danger` colour them.
- **Kickers and labels.** Geist Mono, 10.5 px, capitals, tracked +0.16 em, in `t2`, with a hairline running to the
  column's edge.
- **Type sizes.** UI text 14 px; messages 15 px at 1.7 line height; screen titles 20 px bold.
- **Working state.** The breathing mark (Kangae) in the accent colour, beside "waiting for you" or "thinking".
- **Icons.** 16 px line icons at a 1.3 stroke. The console already uses Phosphor; keep it at a regular weight.

### Implementing the themes

The console uses Quail UI, which sets `data-theme` on `<body>` (currently always `morph`) and styles its components
under `body[data-theme=morph]`. The plan:

1. Keep `data-theme="morph"` so Quail's component rules still apply, and add `data-brand="<theme>"`. Each brand theme
   re-declares Quail's `--q-*` variables and the console's own tokens under `body[data-theme][data-brand=…]`, which
   outranks Quail's selector.
2. Map the tokens: `app` → `--bg-0` and `--q-bg-light`; `panel` → `--bg-1`; `surface` → `--bg-2`, `--q-bg-white`
   and `--q-card-bg`; `t0`–`t2` → `--text-0`–`--text-2` and `--q-c-dark`–`--q-c-dark-3`; `line` and `soft` →
   `--line` and `--line-soft`; `accent` → `--accent-1` and `--q-c-blue` (the console reserves blue for selection);
   `primary` → `--q-button-primary-bg`; `danger` → `--danger` and `--q-c-red`; `ok` → `--ok` and `--status-on`;
   `warn` → `--status-pending` and `--q-c-orange`.
3. Add a theme picker to Settings, and set `color-scheme` to match (light for Washi and Aojashin, dark for the rest).
4. The five dark themes are new: the console has never had a dark mode, so every page needs a visual check,
   including Quail components that carry fixed light colours.

## 8. How we got here

Eight rounds of exploration, all on the design canvas, in order:

1. **Early drafts.** A route-inspired "M", a morphing "M" with a top hat, six broad directions. Dropped: the letter M
   read badly in every form and is now banned from the mark. The one idea that survived was pixel becoming smooth.
2. **A hundred samples** of pixel → smooth: grids, dither, splits and cell shapes. The concept held; the drawings
   still lacked an aesthetic of their own.
3. **和, Japanese aesthetics.** Eight compositions (ensō, moon, seal, round window, rock garden and others). The
   language arrived here: *ma*, restraint, one accent.
4. **Three directions, dug deeper.** Ensō, Tsuki and Karesansui. We learned that dots trailing into a gap read as a
   loading spinner, and that a moon split with a straight edge reads as a chart.
5. **電脳, cyber-wa.** The mood of Ghost in the Shell. Striped suns were cut as synthwave clichés; optical
   camouflage (hairlines bent by something invisible) emerged as the strongest idea.
6. **光学迷彩, chosen.** Straight lines in an icon read as a hamburger menu, so the icon enlarges the ghost until
   every line curves.
7. **Optical sizes.** One drawing per size, and the texture filling the whole icon from 64 px up.
8. **Cyber colourways.** Four editions after the film, including the split where the ghost refracts light.

The brand sheet and the UI mockups followed. Two refinements came after:

- **青写真 Aojashin.** A paper clone in blueprint blue. The first version painted the whole UI blue, which was too dark
  and too heavy for a page people read on for hours. The page became cool paper, then the whole colourway moved to
  light mode: a paper icon with blue lines, and a light sidebar.
- **Retina.** Most screens are 2×, so the drawing is chosen by device pixels, and UI logos below 64 CSS px use the
  64 drawing.
