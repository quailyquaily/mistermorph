// Every Image clips its source (`overflow-hidden`). nsh 0.6 lays an Image out at the size it is
// given but counts its source's natural size (a Phosphor icon's 256pt, a photo's pixels) in the
// content of a scroll view around it: an 18pt icon near the end of a short list made the list
// scroll by 238pt of nothing (the settings index's bar). Clipping the Image keeps the source inside
// its box, on the web and the desktop alike. See PORTING.md.
//   node --test scripts/image-clip.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The `.tsx` sources: `[path, text]`. */
function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(app, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "vendor" && !entry.name.startsWith(".")) walk(rel);
      } else if (entry.name.endsWith(".tsx")) found.push(rel);
    }
  };
  for (const dir of ["components", "pages"]) walk(dir);
  found.push("App.tsx");
  return found.map((rel) => [rel, fs.readFileSync(path.join(app, rel), "utf8")]);
}

/** The text of the JSX tag that starts at `start`, through its `>` or `/>` (braces skipped). */
function tagAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && c === ">") return text.slice(start, i + 1);
  }
  return text.slice(start);
}

test("every Image clips its source to its box", () => {
  const open = [];
  let seen = 0;
  for (const [rel, text] of sources()) {
    for (const match of text.matchAll(/<Image(?=[\s/>])/g)) {
      seen++;
      if (!tagAt(text, match.index).includes("overflow-hidden")) {
        open.push(`${rel}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
  }
  assert.ok(seen > 20, `found only ${seen} Images: the pattern no longer matches the sources`);
  assert.deepEqual(open, [], "an Image without overflow-hidden lets its source's natural size scroll");
});
