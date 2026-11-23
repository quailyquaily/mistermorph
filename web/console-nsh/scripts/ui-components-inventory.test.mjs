// The UI component gallery's inventory against the sources. The gallery lists the console's reused
// UI components (pages/ui-components/inventory.js says what that means); this checks that
// - every entry names a component its file exports,
// - every entry is still reused: at least two areas of the console use it (a component of the
//   shared kit, components/shared/, needs one user: it is reusable by where it is),
// - the entries and the demos match one to one.
// It does not ask for every reused component to be listed.
//   node --test scripts/ui-components-inventory.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GALLERY_ENTRIES, GALLERY_GROUPS } from "../pages/ui-components/inventory.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The console's sources, the gallery's own left out: `[path, text]`. */
function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(app, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (rel !== "pages/ui-components" && !entry.name.startsWith(".")) walk(rel);
      } else if (/\.(tsx|ts|js)$/.test(entry.name)) found.push(rel);
    }
  };
  for (const dir of ["components", "pages", "lib"]) walk(dir);
  found.push("App.tsx");
  return new Map(found.map((file) => [file, fs.readFileSync(path.join(app, file), "utf8")]));
}

/** A file's area: its folder under `components/` or `pages/` (`settings-page` counts with `settings`). */
function areaOf(file) {
  const parts = file.split("/");
  if (parts.length === 1) return "app";
  if (parts.length === 2) return parts[0] === "components" ? "shared" : parts[1];
  return parts[1] === "settings-page" ? "settings" : parts[1];
}

const SOURCES = sources();

test("the inventory names only components their files export", () => {
  const gone = GALLERY_ENTRIES.filter((entry) => !new RegExp(`export (function|const) ${entry.name}\\b`).test(SOURCES.get(entry.file) ?? "")).map((entry) => `${entry.file}#${entry.name}`);
  assert.deepEqual(gone, [], "remove these from pages/ui-components/inventory.js (and their demos)");
});

test("every listed component is reused: at least two areas of the console use it, or it is in the shared kit and used", () => {
  const single = [];
  for (const entry of GALLERY_ENTRIES) {
    const named = new RegExp(`\\b${entry.name}\\b`);
    const users = [...SOURCES].filter(([file, text]) => file !== entry.file && named.test(text)).map(([file]) => file);
    const kit = entry.file.startsWith("components/shared/");
    if (kit ? users.length < 1 : users.length < 2 || new Set(users.map(areaOf)).size < 2) single.push(`${entry.file}#${entry.name}`);
  }
  assert.deepEqual(single, [], "no longer reused: remove these from pages/ui-components/inventory.js (and their demos)");
});

test("the entries and the demos match one to one", () => {
  const dir = path.join(app, "pages/ui-components/demos");
  const keys = new Set();
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".tsx"))) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const from = source.search(/export const [A-Z_]+_DEMOS: DemoMap = \{/);
    assert.ok(from >= 0, `${name}: no demo map`);
    // A demo's key: a name at the map's own indent (two spaces), plain or quoted.
    for (const match of source.slice(from).matchAll(/^  (?:"([^"]+)"|([A-Za-z0-9_$]+)): /gm)) keys.add(match[1] ?? match[2]);
  }
  const ids = new Set(GALLERY_ENTRIES.map((entry) => entry.id));
  assert.deepEqual([...ids].filter((id) => !keys.has(id)).sort(), [], "listed without a demo");
  assert.deepEqual([...keys].filter((key) => !ids.has(key)).sort(), [], "a demo of a component that is not listed");
});

test("entries are well formed", () => {
  const ids = new Set();
  const groups = new Set(GALLERY_GROUPS.map((group) => group.id));
  for (const entry of GALLERY_ENTRIES) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(groups.has(entry.group), `${entry.id}: unknown group ${entry.group}`);
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
