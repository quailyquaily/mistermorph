// The colour scheme's rules against the sources (pages/ui-components/colorRules.js says what they
// are, and the gallery's Colors section shows them):
// - a colour's fills and borders at a share keep to the tint steps;
// - nsh's names are the same colours as the console's tokens they stand for, and the console's
//   code uses the console's names.
//   node --test scripts/color-steps.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NSH_NAMES, TINT_HUES, TINT_STEPS } from "../pages/ui-components/colorRules.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const theme = JSON.parse(fs.readFileSync(path.join(app, "theme.json"), "utf8")).cssVars;

/** The console's sources: `[path, text]`. */
function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(app, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "vendor" && !entry.name.startsWith(".")) walk(rel);
      } else if (/\.(tsx|ts|js)$/.test(entry.name)) found.push(rel);
    }
  };
  for (const dir of ["components", "pages", "lib"]) walk(dir);
  found.push("App.tsx");
  return found.map((rel) => [rel, fs.readFileSync(path.join(app, rel), "utf8")]);
}

/** Every match of `pattern` in the sources, as `path:line match`, with its groups. */
function find(pattern) {
  const found = [];
  for (const [rel, text] of sources()) {
    text.split("\n").forEach((line, i) => {
      for (const match of line.matchAll(pattern)) found.push({ at: `${rel}:${i + 1} ${match[0]}`, match });
    });
  }
  return found;
}

test("a colour's fills and borders at a share keep to the steps", () => {
  const steps = { bg: TINT_STEPS.bg.map((step) => step.share), border: TINT_STEPS.border.map((step) => step.share) };
  const found = find(new RegExp(`\\b(bg|border)-(${TINT_HUES.join("|")})/(\\d+)\\b`, "g"));
  assert.ok(found.length > 50, `found only ${found.length} tinted classes: the pattern no longer matches the sources`);
  const off = found.filter(({ match }) => !steps[match[1]].includes(Number(match[3]))).map(({ at }) => at);
  assert.deepEqual(off, [], `off the steps (fills ${steps.bg.join(", ")}; borders ${steps.border.join(", ")})`);
});

test("nsh's names are the colours of the console's tokens they stand for, in both palettes", () => {
  for (const scheme of ["light", "dark"]) {
    for (const [name, ours] of Object.entries(NSH_NAMES)) {
      assert.equal(theme[scheme][name]?.toLowerCase(), theme[scheme][ours]?.toLowerCase(), `${scheme}: ${name} is not ${ours}`);
    }
  }
});

test("the console's code uses its own names, not nsh's", () => {
  const names = Object.keys(NSH_NAMES).join("|");
  const classes = find(new RegExp(`(?<![\\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|placeholder|caret|decoration)-(?:${names})(?![\\w-])`, "g"));
  const tokens = find(new RegExp(`token\\("(?:${names})"\\)`, "g"));
  assert.deepEqual([...classes, ...tokens].map(({ at }) => at), []);
});
