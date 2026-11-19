// Dialogs over the right sidebar. Every console dialog (DialogLayer: Modal, MessageDialog, the
// phone's popups) is a modal layer of nsh's on every platform, so one opened from the sidebar (the
// chat's WorkspaceSheet, a SidePane) goes above it, scrim and paper, and takes the presses, Back
// and Escape while it is open; closing it leaves the sidebar open as it was. On Android the dialogs
// were Overlays in the app's own root, and nsh 0.6's sheets are modal roots above that root: the
// sheet covered the rename dialog. Fixture: tests/fixtures/dialogs-over-sheet-app.tsx; the rest
// runs the whole console.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { openConsole } from "./harness";

const PHONES = [
  { name: "an Android phone", options: { platform: "android" as const } },
  { name: "a phone-sized browser", options: { platform: "linux" as const } },
];
const state = (app: App) => app.texts().find((text) => text.startsWith("sheet=")) ?? "";

async function openFixture(options: { platform: "android" | "linux" }) {
  const app = await open("./fixtures/dialogs-over-sheet-app.tsx", { width: 390, height: 844, locale: "en-US", ...options });
  await app.waitFor("id:state");
  return app;
}

for (const phone of PHONES) {
  for (const sheet of ["workspace-sheet", "side-pane"]) {
    test(`on ${phone.name} a dialog opened from the ${sheet} is above it and takes the presses; the sheet stays as it was`, async () => {
      const app = await openFixture(phone.options);
      await app.press(`id:open-${sheet}`);
      await app.waitFor("id:sheet-body");
      await app.press("id:sheet-bump");
      await app.waitFor("text:count=1");

      await app.press("id:sheet-open-modal");
      await app.waitFor("id:over-modal-inside");
      // The dialog's middle is over the sheet's plain paper: the press reaches the dialog (a press
      // the sheet took would fail the step as covered).
      await app.press("id:over-modal-inside");
      await app.waitUntil(() => state(app).includes("dialog pressed"));
      // A press on its scrim, over the sheet too, closes the dialog and only the dialog.
      await app.press("id:over-modal-scrim");
      await app.waitFor("id:over-modal", { state: "gone" });
      expect(state(app)).toContain("dialog closed (modal)");
      expect(state(app)).not.toContain("sheet closed");
      // The sheet is open as it was, and usable.
      expect(app.shows("text:count=1")).toBe(true);
      await app.press("id:sheet-bump");
      await app.waitFor("text:count=2");

      // A message dialog: above the sheet too.
      await app.press("id:sheet-open-message");
      await app.waitFor("id:over-message");
      await app.press("id:over-message-scrim");
      await app.waitFor("id:over-message", { state: "gone" });
      expect(state(app)).toContain("dialog closed (message)");
      await app.press("id:sheet-open-message");
      await app.press("Understood");
      await app.waitFor("id:over-message", { state: "gone" });
      expect(state(app)).toContain("dialog closed (ok)");
      expect(state(app)).not.toContain("sheet closed");
      expect(app.shows("text:count=2")).toBe(true);
    });
  }
}

for (const sheet of ["workspace-sheet", "side-pane"]) {
  test(`on Android Back closes a dialog over the ${sheet} first, then the sheet`, async () => {
    const app = await openFixture({ platform: "android" });
    await app.press(`id:open-${sheet}`);
    await app.press("id:sheet-bump");
    await app.press("id:sheet-open-modal");
    await app.waitFor("id:over-modal-inside");
    await app.back();
    await app.waitFor("id:over-modal", { state: "gone" });
    expect(state(app)).toContain("dialog closed (modal)");
    expect(state(app)).not.toContain("sheet closed");
    expect(app.shows("text:count=1")).toBe(true);
    await app.back();
    await app.waitFor("id:sheet-body", { state: "gone" });
    expect(state(app)).toContain("sheet closed");
  });
}

test("on a wide window Escape in a dialog opened from a side column is the dialog's: the column stays open", async () => {
  const app = await open("./fixtures/dialogs-over-sheet-app.tsx", { width: 1280, height: 800, locale: "en-US", platform: "linux" });
  await app.waitFor("id:state");
  await app.press("id:open-side-column");
  await app.waitFor("id:sheet-body");
  await app.press("id:sheet-bump");
  for (const kind of ["modal", "message"]) {
    await app.press(`id:sheet-open-${kind}`);
    await app.waitFor(`id:over-${kind}`);
    // The column's own Escape steps aside while the dialog is open: Escape closes the dialog.
    await app.keyboard.press("escape");
    await app.waitFor(`id:over-${kind}`, { state: "gone" });
    expect(state(app)).toContain(`dialog closed (${kind})`);
    expect(state(app)).not.toContain("sheet closed");
    expect(app.shows("text:count=1")).toBe(true);
  }
  // Its own buttons close only the dialog too (the scrim's middle is under the wide panel).
  await app.press("id:sheet-open-modal");
  await app.press("id:over-modal-inside");
  await app.waitUntil(() => state(app).includes("dialog pressed"));
  await app.press("id:over-modal-done");
  await app.waitFor("id:over-modal", { state: "gone" });
  expect(state(app)).not.toContain("sheet closed");
  // With the dialogs gone, Escape is the column's again.
  await app.keyboard.press("escape");
  await app.waitFor("id:sheet-body", { state: "gone" });
  expect(state(app)).toContain("sheet closed (column)");
});

/* ---------- the whole console: the chat's right sidebar ---------- */

const NOW = new Date().toISOString();
const topic = (id: string, title: string) => ({ id, title, created_at: NOW, updated_at: NOW });
const CHAT_API = {
  "GET /proxy:/topics": { body: { items: [topic("topic-1", "Trip plans"), topic("topic-2", "Recipes")] } },
  "GET /proxy:/tasks": { body: { items: [] } },
  "GET /proxy:/todo/tasks": { body: { tasks: [] } },
  "GET /proxy:/topic/topic-2/metadata": { body: { workspace: { workspace_dir: "", source: "none" } } },
};

async function openChatSidebar(options: { platform?: "android" | "linux"; width?: number; wide?: boolean }) {
  const { app, calls } = await openConsole({
    platform: options.platform === "android" ? "android" : undefined,
    width: options.width,
    location: "/e/default/chat/topic-2",
    kv: options.wide ? { mistermorph_console_workspace_sidebar_open_v1: "true" } : undefined,
    api: CHAT_API,
  });
  if (!options.wide) {
    await app.waitFor("id:chat-workspace-toggle");
    await app.press("id:chat-workspace-toggle");
  }
  await app.waitFor("id:chat-topic-panel");
  await app.waitFor("id:chat-topic-rename");
  return { app, calls };
}

for (const phone of [
  { name: "an Android phone", options: { platform: "android" as const } },
  { name: "a phone-sized browser", options: { platform: "linux" as const, width: 390 } },
]) {
  test(`on ${phone.name} Rename and Delete from the chat's right sheet open above it, and closing them leaves the sheet as it was`, async () => {
    const { app, calls } = await openChatSidebar(phone.options);
    // Rename: the dialog's field and buttons take the presses, the sheet's paper is under them.
    await app.press("id:chat-topic-rename");
    await app.waitFor("id:chat-topic-rename-input");
    await app.type("id:chat-topic-rename-input", " draft");
    expect(app.value("id:chat-topic-rename-input")).toBe("Recipes draft");
    // Its scrim covers the sheet: a press there closes the dialog, not the sheet.
    await app.press("id:chat-topic-rename-dialog-scrim");
    await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
    expect(app.shows("id:chat-workspace-panel")).toBe(true);
    expect(app.shows("id:chat-topic-panel")).toBe(true);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    // Delete: a message dialog over the sheet the same way; Cancel leaves the sheet usable.
    await app.press("id:chat-topic-delete");
    await app.waitFor("id:chat-topic-delete-dialog");
    await app.press("id:chat-topic-delete-dialog-scrim");
    await app.waitFor("id:chat-topic-delete-dialog", { state: "gone" });
    await app.press("id:chat-topic-delete");
    await app.waitFor("id:chat-topic-delete-dialog");
    await app.press("Cancel");
    await app.waitFor("id:chat-topic-delete-dialog", { state: "gone" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(app.shows("id:chat-topic-panel")).toBe(true);
    // The sheet still answers: its tabs switch.
    await app.press("role:tab[Workspace]");
    await app.waitFor("No workspace attached");
  });
}

test("on an Android phone Back closes the rename dialog over the chat's sheet, then the sheet", async () => {
  const { app } = await openChatSidebar({ platform: "android" });
  await app.press("id:chat-topic-rename");
  await app.waitFor("id:chat-topic-rename-input");
  await app.back();
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(app.shows("id:chat-topic-panel")).toBe(true);
  await app.back();
  await app.waitFor("id:chat-workspace-panel", { state: "gone" });
  // The topic stays open under it.
  expect(app.shows("id:chat-back")).toBe(true);
});

test("on a wide window Rename and Delete from the right panel open above it; Escape and closing leave the panel open", async () => {
  const { app } = await openChatSidebar({ wide: true });
  await app.press("id:chat-topic-rename");
  await app.waitFor("id:chat-topic-rename-input");
  // Escape is never the panel's while the dialog is open (headless, the focused name field keeps
  // it, as on master); Cancel closes the dialog alone.
  await app.keyboard.press("escape");
  expect(app.shows("id:chat-right-panel")).toBe(true);
  await app.press("id:chat-topic-rename-cancel");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(app.shows("id:chat-right-panel")).toBe(true);
  expect(app.shows("id:chat-topic-panel")).toBe(true);
  await app.press("id:chat-topic-delete");
  await app.waitFor("id:chat-topic-delete-dialog");
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-topic-delete-dialog", { state: "gone" });
  expect(app.shows("id:chat-right-panel")).toBe(true);
  await app.press("role:tab[Workspace]");
  await app.waitFor("No workspace attached");
});
