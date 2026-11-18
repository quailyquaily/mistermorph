// A button shows text or a glyph, never both (components/ui.tsx, ButtonProps.icon): given an icon
// and a label it is a square icon button, and the label is its accessible name and its tooltip
// instead of being drawn (a title beside it does not replace it). The busy beam is a state, not a glyph: a text button keeps its label
// while it runs. The folded agent switcher (components/frame/AgentSwitcher.tsx) shows its avatar
// without the caret, closed or open, with or without a selected agent; unfolded it keeps the caret.
import { expect, open, test } from "nsh/test";

async function openGallery() {
  return open("./fixtures/icon-buttons-app.tsx", { width: 900, height: 700, platform: "linux", locale: "en-US" });
}

const presses = (app: { texts(): string[] }) =>
  JSON.parse((app.texts().find((text) => text.startsWith("presses=")) ?? "presses={}").slice("presses=".length)) as Record<string, number>;

test("a button given an icon and a label draws the glyph alone, named by the label", async () => {
  const app = await openGallery();
  // A text button draws its label.
  expect(app.texts()).toContain("Rename");
  // The labels of the buttons with a glyph are not drawn, and name them.
  for (const label of ["Refresh", "Stop", "Delete", "Send", "Attach", "Add a profile"]) {
    expect(app.texts()).not.toContain(label);
    expect(app.count(`label:${label}`)).toBe(1);
  }
  expect(app.count("label:Close")).toBe(1);

  // They are pressed by their names, and by their ids, as before.
  await app.press("label:Refresh");
  await app.press("id:both-titled");
  await app.press("label:Add a profile");
  await app.press("label:Attach");
  expect(presses(app)).toEqual({ both: 1, "both-titled": 1, placeholder: 1, block: 1 });

  // Disabled stays disabled.
  expect(app.enabled("id:both-disabled")).toBe(false);
  await expect(app.press("id:both-disabled")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
});

test("the label is the icon button's tooltip, even beside a title; a title names a button without a label", async () => {
  const app = await openGallery();
  // A tooltip's text is on screen while it shows (a bare selector would match the name as well).
  const shown = (text: string) => app.texts().includes(text);
  await app.hover("id:both");
  await app.waitUntil(() => shown("Refresh"));

  // A title beside the label does not replace it: the tooltip is the former label.
  await app.hover("id:both-titled");
  await app.waitUntil(() => shown("Stop"));
  expect(shown("Stop this run")).toBe(false);
  // The last tooltip goes out over a few frames (nsh 0.6), not at once.
  await app.waitUntil(() => !shown("Refresh"));

  // Without a label, the title is the tooltip.
  await app.hover("id:icon-only");
  await app.waitUntil(() => shown("Close"));

  await app.hover("id:placeholder");
  await app.waitUntil(() => shown("Add a profile"));

  await app.hover("id:both-disabled");
  await app.waitUntil(() => shown("Delete"));

  // A text button has no tooltip: its label is on it, once.
  await app.hover("id:text");
  await app.waitUntil(() => !shown("Delete"));
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(app.texts().filter((text) => text === "Rename")).toHaveLength(1);
});

test("loading keeps a text button's label under the beam, and an icon button's glyph alone", async () => {
  const app = await openGallery();
  expect(app.texts()).toContain("Start");
  expect(app.count("id:busy-text-loading")).toBe(0);
  expect(app.count("id:busy-both-loading")).toBe(0);

  await app.press("id:toggle-busy");
  // The text button: its (changed) label, the beam, no presses.
  expect(app.texts()).toContain("Working");
  expect(app.shows("id:busy-text-loading")).toBe(true);
  expect(app.enabled("id:busy-text")).toBe(false);
  // The icon button: the beam, still no label drawn, still named.
  expect(app.shows("id:busy-both-loading")).toBe(true);
  expect(app.enabled("id:busy-both")).toBe(false);
  expect(app.texts()).not.toContain("Send");
  expect(app.count("label:Send")).toBe(1);

  await app.press("id:toggle-busy");
  expect(app.count("id:busy-text-loading")).toBe(0);
  expect(app.count("id:busy-both-loading")).toBe(0);
  expect(app.texts()).toContain("Start");
});

test("the folded agent switcher has no caret, closed or open; unfolded it keeps it", async () => {
  const app = await openGallery();
  // Unfolded: the name and the caret, closed and open.
  await app.waitFor("id:agent-switcher-trigger >> text:Agent One");
  expect(app.count("id:agent-switcher-caret")).toBe(1);
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("id:agent-switcher-list");
  expect(app.count("id:agent-switcher-caret")).toBe(1);
  await app.press("id:agent-switcher-option-ep_two");
  await app.waitFor("id:agent-switcher-list", { state: "gone" });

  // Folded: no caret, closed or open.
  await app.press("id:toggle-compact");
  expect(app.count("id:agent-switcher-caret")).toBe(0);
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("id:agent-switcher-list");
  expect(app.count("id:agent-switcher-caret")).toBe(0);
  await app.press("id:agent-switcher-option-ep_two");
  await app.waitFor("id:agent-switcher-list", { state: "gone" });
  expect(app.count("id:agent-switcher-caret")).toBe(0);

  // Folded with no agent selected: still none.
  await app.press("id:toggle-selected");
  expect(app.count("id:agent-switcher-caret")).toBe(0);
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("id:agent-switcher-list");
  expect(app.count("id:agent-switcher-caret")).toBe(0);
  await app.press("id:agent-switcher-option-ep_two");
  await app.waitFor("id:agent-switcher-list", { state: "gone" });

  // Unfolded again, the caret is back, selected or not.
  await app.press("id:toggle-compact");
  expect(app.count("id:agent-switcher-caret")).toBe(1);
});
