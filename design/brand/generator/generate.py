"""Regenerate the Mister Morph icon family: every colourway at every optical size, the marks, the motion pieces and
the colour tokens. Writes SVGs into design/brand/ and a PNG job list for render.mjs.

    python3 design/brand/generator/generate.py
    node design/brand/generator/render.mjs        # optional: PNGs, needs playwright-core and a Chromium
"""
import json, os, sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cyber  # noqa: E402
import meisai  # noqa: E402
import sizes  # noqa: E402
from marks import five, three, split  # noqa: E402

BRAND = os.path.dirname(HERE)
SIZES = ['1024', '256', '128', '64', '32', '16']
HONE, YORU, SUMI, KINARI = '#E7E4DA', '#0B1012', '#1E1E20', '#F2EDE2'

COLOURWAYS = {
    'night': dict(kanji='夜', name='Yoru', role='The default: app icon, favicon, dark surfaces.',
                  ground=YORU, field='#44504E', ghost=HONE),
    'paper': dict(kanji='和紙', name='Washi', role='Light surfaces, print, the docs in light mode.',
                  ground=KINARI, field='#BDB7AC', ghost=SUMI),
    'aojashin': dict(kanji='青写真', name='Aojashin', role='Paper, drawn in blueprint blue: a cooler light mode.'),
    'suimen': dict(kanji='水面', name='Suimen', role='The cyber edition: dark themes, launches, the alternate icon.'),
    'rinko': dict(kanji='燐光', name='Rinkō', role='Phosphor: terminals, CLI output, special editions.'),
    'bunko': dict(kanji='分光', name='Bunkō', role='Dispersion on indigo: an alternate icon.'),
    'denko': dict(kanji='電光', name='Denkō', role='Cyan on violet: an alternate icon.'),
}


def icon(colourway, label):
    """The drawing for one colourway at one optical size."""
    if colourway in ('night', 'paper'):
        dark = colourway == 'night'
        fg, bg = (HONE, YORU) if dark else (SUMI, KINARI)
        if label == '32':
            return five(fg, bg)
        if label == '16':
            return three(fg, bg)
        return sizes.bleed_icon(label, dark)
    return cyber.icon(label, colourway)


def doc(inner, size, viewbox='0 0 100 100', title='Mister Morph'):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" width="{size}" height="{size}" role="img" '
            f'aria-label="{title}">{inner}</svg>\n')


def write(rel, text):
    path = os.path.join(BRAND, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        fh.write(text)
    return path


def main():
    jobs = []
    # Icons: one drawing per colourway per optical size.
    for cw in COLOURWAYS:
        for label in SIZES:
            rel = f'icons/{cw}/icon-{label}.svg'
            write(rel, doc(icon(cw, label), int(label)))
            jobs.append({'svg': rel, 'png': rel[:-4] + '.png', 'size': int(label)})
    # Marks: no background, for lockups and inline use.
    write('marks/mark.svg', doc(five('currentColor'), 100))
    write('marks/mark-16.svg', doc(three('currentColor'), 16))
    write('marks/mark-suimen.svg', doc(split(five('#D6FFF6'), '#D6FFF6', '#22F2D0', '#FF3D7F'), 100))
    # Motion: the drifting ghost (hero, splash) and the breathing icon (the working state). SVG animation (SMIL).
    write('motion/ugoki.svg', doc(f'<rect width="100" height="100" fill="{YORU}"></rect>' + meisai.drift(HONE), 800))
    write('motion/kangae.svg', doc(meisai.breathe(HONE, YORU, n=5, sw=5.6, box=(16, 20, 84, 80), r=46), 128))
    # Tokens.
    tokens = {'colourways': {}}
    for cw, meta in COLOURWAYS.items():
        entry = dict(meta)
        if cw in cyber.PALETTES:
            p = cyber.PALETTES[cw]
            entry.update(ground=p['bg'], field=p['field'], ghost=p['line'], edge=p['edge'])
            if p['split']:
                entry['split'] = list(p['split'])
            if p['glow']:
                entry['glow'] = p['glow']
        tokens['colourways'][cw] = entry
    tokens['optical_sizes'] = {lab: spec for lab, spec in (
        ('1024', '31 rows of pixel runs, full bleed; the ghost smooth and bright'),
        ('256', '25 rows'), ('128', '21 rows'), ('64', '11 rows of dim continuous lines'),
        ('32', '5 lines, no field'), ('16', '3 lines on whole pixels'))}
    tokens['type'] = {
        'voice': 'Shippori Mincho', 'machine': 'DotGothic16', 'wordmark': 'Geist Mono', 'text': 'Zen Kaku Gothic New'}
    write('tokens.json', json.dumps(tokens, ensure_ascii=False, indent=2) + '\n')
    write('generator/render-jobs.json', json.dumps(jobs, indent=1) + '\n')
    print(f'wrote {len(jobs)} icons, 3 marks, 2 motion files, tokens.json')


if __name__ == '__main__':
    main()
