// The UI component gallery's inventory against the sources: every component a .tsx file under
// components/ and pages/ declares (exported or file-private) has an entry in
// pages/ui-components/inventory.js, and no entry names a component that is gone.
//   node --test scripts/ui-components-inventory.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GALLERY_ENTRIES, GALLERY_GROUPS } from "../pages/ui-components/inventory.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tsxFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(app, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // The gallery's demos are fixtures around the components, not components of the console.
      if (rel === "pages/ui-components/demos") continue;
      found.push(...tsxFiles(rel));
    } else if (entry.name.endsWith(".tsx") && rel !== "pages/ui-components/demo.tsx") found.push(rel);
  }
  return found;
}

/** The components a file declares: top-level functions (and arrow consts) with a capital name. */
function componentsIn(file) {
  const source = fs.readFileSync(path.join(app, file), "utf8");
  const names = new Set();
  for (const match of source.matchAll(/^(?:export )?function ([A-Z][A-Za-z0-9]*)\s*[<(]/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^(?:export )?const ([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)|[a-z]\w*)\s*=>/gm)) names.add(match[1]);
  return [...names];
}

const declared = new Set();
for (const file of [...tsxFiles("components"), ...tsxFiles("pages")]) {
  for (const name of componentsIn(file)) declared.add(`${file}#${name}`);
}
const listed = new Set(GALLERY_ENTRIES.map((entry) => `${entry.file}#${entry.name}`));

test("every component of the console is in the gallery's inventory", () => {
  const missing = [...declared].filter((key) => !listed.has(key)).sort();
  assert.deepEqual(missing, [], "add these to pages/ui-components/inventory.js");
});

test("the inventory names only components that exist", () => {
  const gone = [...listed].filter((key) => !declared.has(key)).sort();
  assert.deepEqual(gone, [], "remove these from pages/ui-components/inventory.js");
});

test("entries are well formed", () => {
  const ids = new Set();
  const groups = new Set(GALLERY_GROUPS.map((group) => group.id));
  const byId = new Map(GALLERY_ENTRIES.map((entry) => [entry.id, entry]));
  const names = new Set(GALLERY_ENTRIES.map((entry) => entry.name));
  for (const entry of GALLERY_ENTRIES) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(groups.has(entry.group), `${entry.id}: unknown group ${entry.group}`);
    if (entry.mode === "composed") {
      // What a composed entry is shown inside must itself be on the page.
      const host = byId.get(entry.via) ?? GALLERY_ENTRIES.find((other) => other.name === entry.via && other.mode === "demo");
      assert.ok(host && host.mode === "demo", `${entry.id}: shown inside ${entry.via}, which has no demo`);
    } else if (entry.mode === "listed") {
      assert.ok(entry.reason, `${entry.id}: a component that is not mounted says why`);
      if (entry.reason === "part") assert.ok(entry.via, `${entry.id}: a private part names what it is part of`);
      if (entry.via) assert.ok(names.has(entry.via), `${entry.id}: ${entry.via} is not a component`);
    } else {
      assert.equal(entry.mode, "demo");
    }
  }
  for (const group of GALLERY_GROUPS) {
    assert.ok(GALLERY_ENTRIES.some((entry) => entry.group === group.id), `group ${group.id} is empty`);
  }
});

// A button shows text or a glyph, never both (docs/console/ui-components.md): the demos show the two
// apart, and none hands a Button an icon together with a label (which would draw the glyph alone).
test("no demo shows a button with both an icon and a label", () => {
  const dir = path.join(app, "pages/ui-components/demos");
  const both = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".tsx"))) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    for (const match of source.matchAll(/<Button\b/g)) {
      // The opening tag: up to the `>` outside every `{…}`.
      let depth = 0;
      let end = match.index;
      for (; end < source.length; end++) {
        const char = source[end];
        if (char === "{") depth++;
        else if (char === "}") depth--;
        else if (char === ">" && depth === 0 && source[end - 1] !== "=") break;
      }
      const tag = source.slice(match.index, end + 1);
      if (/\sicon=/.test(tag) && /\slabel=/.test(tag)) both.push(`${name}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(both, []);
});
