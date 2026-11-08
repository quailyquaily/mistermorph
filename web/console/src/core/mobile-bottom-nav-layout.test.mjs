import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [navCSS, baseCSS] = await Promise.all([
  read("../components/AppMobileBottomNav.css"),
  read("../styles/base.css"),
]);

// Top-level rules of a flat stylesheet: each selector in a list maps to its declarations.
function cssRules(source) {
  const rules = [];
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = {};
    for (const part of match[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon > 0) {
        declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
    }
    for (const selector of match[1].split(",")) {
      rules.push({ selector: selector.trim().replace(/\s+/g, " "), declarations });
    }
  }
  return rules;
}

const navRules = cssRules(navCSS);

function declarationsFor(selector) {
  const found = navRules.filter((rule) => rule.selector === selector);
  assert.ok(found.length > 0, `missing rule for ${selector}`);
  return Object.assign({}, ...found.map((rule) => rule.declarations));
}

test("mobile nav slots fill one row above the safe area, so icons centre in the visible strip", () => {
  const nav = declarationsFor(".mobile-bottom-nav");
  assert.equal(nav["grid-template-rows"], "minmax(0, 1fr)");
  assert.equal(nav.height, "calc(var(--mobile-nav-height) + env(safe-area-inset-bottom, 0px))");
  assert.equal(nav.padding, "0 4px env(safe-area-inset-bottom, 0px)");

  const item = declarationsFor(".mobile-bottom-nav-item");
  assert.equal(item.display, "flex");
  assert.equal(item["align-items"], "center");
  assert.equal(item["justify-content"], "center");
  assert.equal(item["align-self"], "stretch");
  assert.equal(item.padding, "0");
  assert.equal(item.margin, "0");
  // A fixed full-strip height overflows the row by the top rule and lowers every icon.
  assert.notEqual(item.height, "var(--mobile-nav-height)");
  assert.equal(item["flex-direction"], undefined);
});

test("mobile nav slots keep a comfortable touch target", () => {
  const height = Number(baseCSS.match(/--mobile-nav-height:\s*(\d+)px/)?.[1]);
  // The slot is the strip less its 1px top rule.
  assert.ok(height - 1 >= 44, `slot height ${height - 1}px is below 44px`);
});
