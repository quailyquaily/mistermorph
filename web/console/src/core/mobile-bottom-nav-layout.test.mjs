import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [navCSS, baseCSS, switcherSource, navSource] = await Promise.all([
  read("../components/AppMobileBottomNav.css"),
  read("../styles/base.css"),
  read("../components/AppMobileAgentSwitcher.js"),
  read("../components/AppMobileBottomNav.js"),
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

function triggerTemplate() {
  const start = switcherSource.indexOf('class="mobile-bottom-nav-item mobile-agent-switcher-trigger"');
  assert.ok(start > 0, "agent trigger markup not found");
  const end = switcherSource.indexOf("</button>", start);
  return switcherSource.slice(switcherSource.lastIndexOf("<button", start), end + "</button>".length);
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

test("the agent portrait draws no ring, status square or press fill in any state", () => {
  for (const rule of navRules) {
    if (!rule.selector.includes("mobile-agent-switcher-trigger")) {
      continue;
    }
    for (const property of ["box-shadow", "outline", "border", "border-color"]) {
      assert.equal(rule.declarations[property], undefined, `${rule.selector} sets ${property}`);
    }
  }
  assert.ok(!navRules.some((rule) => rule.selector.includes("mobile-agent-switcher-mark")));
  assert.ok(!navRules.some((rule) => rule.selector.includes("mobile-agent-switcher-face")));
  assert.equal(declarationsFor(".mobile-agent-switcher-trigger:active").background, "transparent");

  const avatar = declarationsFor(".mobile-agent-switcher-trigger .mobile-agent-switcher-avatar");
  assert.equal(avatar.width, "22px");
  assert.equal(avatar.height, "22px");
  // The portrait keeps its own round crop.
  assert.equal(declarationsFor(".mobile-agent-switcher-avatar")["border-radius"], "50%");
});

test("keyboard focus on a mobile nav slot, the agent slot included, stays visible", () => {
  const focus = declarationsFor(".mobile-bottom-nav-item:focus-visible");
  assert.match(focus.outline, /^1px solid /);
  for (const rule of navRules) {
    if (rule.selector.includes(":focus")) {
      assert.notEqual(rule.declarations.outline, "none", `${rule.selector} hides focus`);
    }
  }
});

test("the agent slot renders the portrait alone, with its label and fallback", () => {
  const trigger = triggerTemplate();
  assert.doesNotMatch(trigger, /mobile-agent-switcher-mark|mobile-agent-switcher-face|selectedOnline/);
  assert.match(trigger, /<img v-if="selectedAvatar" class="mobile-agent-switcher-avatar" :src="selectedAvatar" alt="" \/>/);
  assert.match(trigger, /<span v-else class="mobile-agent-switcher-avatar is-empty" aria-hidden="true"><\/span>/);
  assert.match(trigger, /:aria-label="t\('nav_agent'\) \+ ': ' \+ selectedName"/);
  assert.match(trigger, /:aria-expanded="modelValue \? 'true' : 'false'"/);
  assert.match(trigger, /aria-haspopup="dialog"/);
  assert.match(trigger, /@click="toggle"/);
  // The switcher list still shows each agent's connection status.
  assert.match(switcherSource, /class="mobile-agent-switcher-status is-online"/);
  assert.match(switcherSource, /class="mobile-agent-switcher-status is-offline"/);
});

test("the agent slot still takes the strip's selected mark", () => {
  assert.match(navSource, /:active="activeSlot === slotCount - 1"/);
  assert.match(triggerTemplate(), /:class="\{ 'is-active': active \}"/);
});
