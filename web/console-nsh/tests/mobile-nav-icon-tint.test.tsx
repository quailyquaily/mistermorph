// The phone's bottom navigation draws the selected slot's glyph in the primary buttons' colour
// (`primary`, the dark blue of the Send and Save buttons), not the lighter `blue`, and the other
// glyphs quiet (`muted-foreground`): a primary page's slot while its page is open, More while its
// sheet is open or while a page kept under it is open. Headless nsh has no image query, so each
// glyph carries a testID naming its tint: `mobile-nav-<slot>-icon.<token>`
// (components/frame/MobileBottomNav.tsx). The pill behind the selected slot keeps its own tint.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import theme from "../theme.json";
import { openConsole } from "./harness";

const SLOTS = ["chat", "contacts", "todo", "more"] as const;
type Slot = (typeof SLOTS)[number];
const EMPTY = { body: { items: [] } };

function lastLocation(app: App) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String((writes.at(-1)?.data as any)?.url || "");
}

/** Slot `selected`'s glyph is primary and every other one quiet (none selected: all quiet); none is `blue`. */
async function expectSelected(app: App, selected: Slot | null) {
  for (const slot of SLOTS) {
    const tint = slot === selected ? "primary" : "muted-foreground";
    await app.waitFor(`id:mobile-nav-${slot}-icon.${tint}`);
    expect(app.count(`id:mobile-nav-${slot}-icon.${tint === "primary" ? "muted-foreground" : "primary"}`)).toBe(0);
    expect(app.count(`id:mobile-nav-${slot}-icon.blue`)).toBe(0);
  }
}

test("the selected glyph's primary is the primary buttons' own colour in both themes, not the accent", () => {
  const vars = (theme as { cssVars: Record<string, Record<string, string>> }).cssVars;
  const primary: Record<string, string> = { light: "#4e527c", dark: "#5d6296" };
  for (const scheme of ["light", "dark"]) {
    expect(vars[scheme].primary.toLowerCase()).toBe(primary[scheme]);
    expect(vars[scheme].primary.toLowerCase()).not.toBe(vars[scheme].blue.toLowerCase());
    expect(vars[scheme]["muted-foreground"]).toBeDefined();
  }
});

test("on a phone the selected page's glyph and More's are primary, the others quiet", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    width: 390,
    height: 844,
    api: {
      "GET /proxy:/tasks": EMPTY,
      "GET /proxy:/todo/tasks": EMPTY,
      "GET /proxy:/topics": EMPTY,
      "GET /proxy:/contacts/list": EMPTY,
      "GET /proxy:/memories": EMPTY,
    },
  });
  await app.waitFor("id:mobile-bottom-nav");
  // The page the console opened on.
  await expectSelected(app, "todo");

  // Another primary page.
  await app.press("id:mobile-nav-contacts");
  await app.waitUntil(() => lastLocation(app) === "/e/default/contacts");
  await expectSelected(app, "contacts");

  // More open takes the selection; closed, it goes back to the page.
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more");
  await expectSelected(app, "more");
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more", { state: "gone" });
  await expectSelected(app, "contacts");

  // A page kept under More: More's slot (with that page's glyph) is the selected one.
  await app.press("id:mobile-nav-more");
  await app.press("id:mobile-more-memories");
  await app.waitFor("id:mobile-more", { state: "gone" });
  await app.waitUntil(() => lastLocation(app) === "/e/default/memories");
  await app.waitFor("label:Memories · More");
  await expectSelected(app, "more");

  // The agents' sheet selects the agent's slot: no glyph is primary while it is open.
  await app.press("id:mobile-nav-agent");
  await app.waitFor("id:mobile-agents-list");
  await expectSelected(app, null);
  await app.keyboard.press("escape");
  await app.waitFor("id:mobile-agents-list", { state: "gone" });
  await expectSelected(app, "more");

  // Back on a primary page, More is quiet again.
  await app.press("id:mobile-nav-chat");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/chat"));
  await expectSelected(app, "chat");
});
