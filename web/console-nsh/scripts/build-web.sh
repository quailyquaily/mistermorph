#!/bin/sh
# Builds the console as a static site for `console serve --console-static-dir` (or the embedded
# assets). Usage: scripts/build-web.sh [output dir]   (default: web/console-nsh/dist)
set -eu
app=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$app/dist"}
node "$app/scripts/generate.mjs"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$app" && nsh package App.tsx --target web --out "$work")
site="$work/Mister Morph"
# The Go server fills these in per request: where the console is mounted, and the base every
# relative URL of the page resolves against, so /console/e/default/chat still finds its files.
node - "$site/index.html" <<'JS'
const fs = require("node:fs");
const file = process.argv[2];
let html = fs.readFileSync(file, "utf8");
html = html.replace(
  "<head>",
  '<head>\n<meta name="mistermorph-base-path" content="__MISTERMORPH_BASE_PATH__">\n<base href="__MISTERMORPH_BASE_HREF__">',
);
html = html.replace('<meta name="theme-color" content="#ffffff">', '<meta name="theme-color" content="#edf3f8">');
html = html.replace("html, body { background: #ffffff; color: #1c1c1e; }", "html, body { background: #edf3f8; color: #181832; }");
html = html.replace("<title>Mister Morph</title>", "<title>Mistermorph Console</title>");
fs.writeFileSync(file, html);
JS
# The page changed, so its precompressed copies would be stale.
rm -f "$site/index.html.gz" "$site/index.html.br"
cp "$app/assets/favicon.ico" "$app/assets/favicon.svg" "$site/" 2>/dev/null || true
rm -rf "$out"
mkdir -p "$out"
cp -R "$site/." "$out/"
echo "console site: $out"
