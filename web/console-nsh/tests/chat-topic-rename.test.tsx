// Renaming a topic from the topic panel: Rename opens a dialog with the topic's name in a field,
// Regenerate puts a generated name in the field without saving it, and Save renames the topic
// everywhere it shows. Cancel and the close button leave the name; blank names, failed suggestions
// and failed saves keep the dialog, what was typed and the field's focus. Regenerate is an icon with
// its name kept for assistive tech. Each opening focuses the field, and every closing leaves no
// field focused (what happens while the dialog goes out: dialog-field-focus.test.tsx). A TODO
// item's topic keeps its icon regeneration and has no rename. Late answers are covered on the
// module (topic-rename.test.tsx).
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const PANEL_OPEN = { mistermorph_console_workspace_sidebar_open_v1: "true" };

function topic(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, created_at: NOW, updated_at: NOW, ...extra };
}

function doneTask(id: string, task: string, output: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "done", created_at: NOW, started_at: NOW, finished_at: NOW, result: { final: { output } } };
}

function history(request: ApiRequest) {
  const uri = request.uri || "";
  if (uri.includes("topic_id=topic-1")) return { body: { items: [doneTask("t1", "Where to go?", "Try **Lisbon**.", "topic-1")] } };
  if (uri.includes("topic_id=topic-2")) return { body: { items: [doneTask("t2", "Soup ideas", "Make a miso soup.", "topic-2")] } };
  return { body: { items: [] } };
}

/** A runtime that keeps its topics, so a reload shows what was saved. */
function runtime() {
  const state = {
    topics: [topic("topic-1", "Trip plans"), topic("topic-2", "Recipes", { title_revision: 1 }), topic("topic-3", "")],
    saveFail: "",
    suggestFail: "",
    suggestion: "Miso soup ideas",
  };
  const api = {
    "GET /proxy:/topics": () => ({ body: { items: state.topics } }),
    "GET /proxy:/tasks": history,
    "GET /proxy:/todo/tasks": { body: { tasks: [] } },
    "POST /proxy:/topics/topic-2/title-suggestion": () =>
      state.suggestFail ? { status: 503, body: { error: state.suggestFail } } : { body: { title: state.suggestion, icon: "cooking-pot" } },
    "PUT /proxy:/topics/topic-2/title": (request: ApiRequest) => {
      if (state.saveFail) return { status: 503, body: { error: state.saveFail } };
      const title = String(request.json?.title || "").trim();
      state.topics = state.topics.map((item) => (item.id === "topic-2" ? { ...item, title, title_customized: true, title_revision: 2 } : item));
      return { body: state.topics.find((item) => item.id === "topic-2") };
    },
    "PUT /proxy:/topics/topic-3/title": (request: ApiRequest) => {
      const title = String(request.json?.title || "").trim();
      state.topics = state.topics.map((item) => (item.id === "topic-3" ? { ...item, title, title_customized: true, title_revision: 1 } : item));
      return { body: state.topics.find((item) => item.id === "topic-3") };
    },
  };
  return { state, api };
}

const isRename = (call: ApiRequest, id = "topic-2") => call.method === "PUT" && call.uri === `/topics/${id}/title`;
const isSuggestion = (call: ApiRequest) => call.method === "POST" && (call.uri || "").endsWith("/title-suggestion");

async function openRename(app: Awaited<ReturnType<typeof openConsole>>["app"]) {
  await app.waitFor("id:chat-topic-rename");
  await app.press("id:chat-topic-rename");
  await app.waitFor("id:chat-topic-rename-dialog");
  await app.waitFor("id:chat-topic-rename-input");
}

test("Rename opens a dialog with the topic's name, and a saved name shows everywhere and after a reload", async () => {
  const { state, api } = runtime();
  const { app, calls } = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
  await app.waitFor("id:chat-topic-panel");
  // The panel offers Rename where the regenerate button was, beside Delete.
  expect(app.shows("id:chat-topic-regenerate")).toBe(false);
  expect(app.shows("id:chat-topic-delete")).toBe(true);
  await openRename(app);
  expect(app.shows("Rename topic")).toBe(true);
  expect(app.value("id:chat-topic-rename-input")).toBe("Recipes");
  expect(app.shows("id:chat-topic-rename-regenerate")).toBe(true);
  expect(app.enabled("id:chat-topic-rename-save")).toBe(true);
  await app.clear("id:chat-topic-rename-input");
  await app.type("id:chat-topic-rename-input", "  Weekly soups  ");
  await app.press("id:chat-topic-rename-save");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  const saves = calls.filter((call) => isRename(call));
  expect(saves.length).toBe(1);
  expect(saves[0].json).toEqual({ title: "Weekly soups" });
  // The panel and the list show it at once.
  await app.waitUntil(() => app.texts().filter((text) => text === "Weekly soups").length >= 2);
  expect(app.shows("Recipes")).toBe(false);
  expect(calls.some(isSuggestion)).toBe(false);
  expect(calls.some((call) => (call.uri || "").endsWith("/regenerate-title"))).toBe(false);
  await app.dispose();
  // A reload reads it back from the runtime.
  const again = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
  await again.app.waitFor("id:chat-topic-panel");
  await again.app.waitUntil(() => again.app.texts().filter((text) => text === "Weekly soups").length >= 2);
  expect(state.topics.find((item) => item.id === "topic-2")?.title).toBe("Weekly soups");
});

test("Regenerate puts a generated name in the field without saving it; the edit is what Save keeps", async () => {
  const { state, api } = runtime();
  const { app, calls } = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
  await openRename(app);
  await app.press("id:chat-topic-rename-regenerate");
  await app.waitUntil(() => app.value("id:chat-topic-rename-input") === "Miso soup ideas");
  expect(calls.filter(isSuggestion).length).toBe(1);
  // Nothing is saved yet: the list still has the old name.
  expect(calls.some((call) => isRename(call))).toBe(false);
  expect(state.topics.find((item) => item.id === "topic-2")?.title).toBe("Recipes");
  expect(app.shows("id:chat-topic-topic-2 >> text:Recipes")).toBe(true);
  await app.type("id:chat-topic-rename-input", " for winter");
  // Enter saves too.
  await app.submit("id:chat-topic-rename-input");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(calls.filter((call) => isRename(call)).map((call) => call.json)).toEqual([{ title: "Miso soup ideas for winter" }]);
  await app.waitFor("id:chat-topic-topic-2 >> text:Miso soup ideas for winter");
});

test("Regenerate shows its icon alone and keeps its name for assistive tech, in each language", async () => {
  for (const [language, name] of [
    ["en", "Regenerate"],
    ["zh", "重新生成"],
  ]) {
    const { api } = runtime();
    const { app, calls } = await openConsole({ location: "/e/default/chat/topic-2", kv: { ...PANEL_OPEN, "quail-language": language }, api });
    await openRename(app);
    expect(app.shows(`id:chat-topic-rename-regenerate >> text:${name}`)).toBe(false);
    expect(app.texts().includes(name)).toBe(false);
    expect(app.shows(`label:${name}`)).toBe(true);
    // It still regenerates.
    await app.press(`label:${name}`);
    await app.waitUntil(() => app.value("id:chat-topic-rename-input") === "Miso soup ideas");
    expect(calls.filter(isSuggestion).length).toBe(1);
    await app.dispose();
  }
});

test("Cancel and the close button leave the name, and reopening starts from it again", async () => {
  const { api } = runtime();
  const { app, calls } = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
  await openRename(app);
  await app.type("id:chat-topic-rename-input", " draft");
  await app.press("id:chat-topic-rename-cancel");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  await openRename(app);
  expect(app.value("id:chat-topic-rename-input")).toBe("Recipes");
  await app.press("id:chat-topic-rename-regenerate");
  await app.waitUntil(() => app.value("id:chat-topic-rename-input") === "Miso soup ideas");
  await app.press("id:chat-topic-rename-dialog-close");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(calls.some((call) => isRename(call))).toBe(false);
  expect(app.shows("id:chat-topic-topic-2 >> text:Recipes")).toBe(true);
  await openRename(app);
  expect(app.value("id:chat-topic-rename-input")).toBe("Recipes");
});

test("a blank name cannot be saved, and Enter says why", async () => {
  const { api } = runtime();
  const { app, calls } = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
  await openRename(app);
  await app.clear("id:chat-topic-rename-input");
  await app.type("id:chat-topic-rename-input", "   ");
  expect(app.enabled("id:chat-topic-rename-save")).toBe(false);
  await app.submit("id:chat-topic-rename-input");
  await app.waitFor("id:chat-topic-rename-error");
  expect(app.shows("Enter a topic name.")).toBe(true);
  expect(app.shows("id:chat-topic-rename-dialog")).toBe(true);
  // Typing clears the error.
  await app.type("id:chat-topic-rename-input", "Soups");
  await app.waitFor("id:chat-topic-rename-error", { state: "gone" });
  expect(app.enabled("id:chat-topic-rename-save")).toBe(true);
  expect(calls.some((call) => isRename(call))).toBe(false);
});

test("a failed suggestion and a failed save say why and keep what was typed", async () => {
  const { state, api } = runtime();
  const { app, calls } = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
  await openRename(app);
  await app.clear("id:chat-topic-rename-input");
  await app.type("id:chat-topic-rename-input", "My soups");
  state.suggestFail = "naming is offline";
  await app.press("id:chat-topic-rename-regenerate");
  await app.waitFor("naming is offline");
  expect(app.value("id:chat-topic-rename-input")).toBe("My soups");
  expect(app.enabled("id:chat-topic-rename-regenerate")).toBe(true);
  state.saveFail = "store is down";
  await app.press("id:chat-topic-rename-save");
  await app.waitFor("store is down");
  expect(app.shows("id:chat-topic-rename-dialog")).toBe(true);
  expect(app.value("id:chat-topic-rename-input")).toBe("My soups");
  expect(app.shows("id:chat-topic-topic-2 >> text:Recipes")).toBe(true);
  // A retry once it works.
  state.saveFail = "";
  await app.press("id:chat-topic-rename-save");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(calls.filter((call) => isRename(call)).length).toBe(2);
  await app.waitFor("id:chat-topic-topic-2 >> text:My soups");
});

test("a topic without a name or messages can be named, but not regenerated", async () => {
  const { api } = runtime();
  const { app, calls } = await openConsole({ location: "/e/default/chat/topic-3", kv: PANEL_OPEN, api });
  await openRename(app);
  expect(app.value("id:chat-topic-rename-input")).toBe("");
  expect(app.enabled("id:chat-topic-rename-save")).toBe(false);
  expect(app.enabled("id:chat-topic-rename-regenerate")).toBe(false);
  await app.type("id:chat-topic-rename-input", "Ideas");
  await app.press("id:chat-topic-rename-save");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(calls.filter((call) => isRename(call, "topic-3")).map((call) => call.json)).toEqual([{ title: "Ideas" }]);
  await app.waitFor("id:chat-topic-topic-3 >> text:Ideas");
});

test("a TODO item's topic keeps its icon regeneration and has no rename", async () => {
  let regenerations = 0;
  const { app, calls } = await openConsole({
    location: "/e/default/chat/_cron_job1",
    kv: PANEL_OPEN,
    api: {
      "GET /proxy:/topics": { body: { items: [topic("_cron_job1", "Daily digest")] } },
      "GET /proxy:/tasks": { body: { items: [doneTask("r1", "Summarize the news", "Done.", "_cron_job1")] } },
      "GET /proxy:/todo/tasks": { body: { tasks: [{ id: "job1", llm_profile: "" }] } },
      "POST /proxy:/topics/_cron_job1/regenerate-title": () => {
        regenerations += 1;
        return { body: topic("_cron_job1", "Daily digest", { icon: "newspaper", title_revision: 2 }) };
      },
    },
  });
  await app.waitFor("id:chat-topic-panel");
  await app.waitFor("id:chat-topic-regenerate");
  expect(app.shows("id:chat-topic-rename")).toBe(false);
  expect(app.shows("id:chat-topic-delete")).toBe(false);
  expect(app.shows("label:Regenerate icon")).toBe(true);
  await app.waitUntil(() => app.enabled("id:chat-topic-regenerate"));
  await app.press("id:chat-topic-regenerate");
  await app.waitUntil(() => regenerations === 1);
  expect(calls.some((call) => isRename(call, "_cron_job1") || isSuggestion(call))).toBe(false);
});

test("on an Android phone the rename dialog opens from the topic sheet and saves", async () => {
  const { api } = runtime();
  const { app, calls } = await openConsole({ platform: "android", location: "/e/default/chat/topic-2", api });
  await app.waitFor("id:chat-workspace-toggle");
  await app.press("id:chat-workspace-toggle");
  await app.waitFor("id:chat-topic-panel");
  await openRename(app);
  expect(app.value("id:chat-topic-rename-input")).toBe("Recipes");
  await app.clear("id:chat-topic-rename-input");
  await app.type("id:chat-topic-rename-input", "Soups");
  await app.press("id:chat-topic-rename-save");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(calls.filter((call) => isRename(call)).map((call) => call.json)).toEqual([{ title: "Soups" }]);
  await app.waitFor("Soups");
  // Back after the dialog closed goes to the sheet, as before.
  await app.back();
  await app.waitFor("id:chat-workspace-panel", { state: "gone" });
});

test("Back on an Android phone closes the rename dialog without saving", async () => {
  const { api } = runtime();
  const { app, calls } = await openConsole({ platform: "android", location: "/e/default/chat/topic-2", api });
  await app.waitFor("id:chat-workspace-toggle");
  await app.press("id:chat-workspace-toggle");
  await openRename(app);
  await app.type("id:chat-topic-rename-input", " draft");
  await app.back();
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(app.shows("id:chat-topic-panel")).toBe(true);
  expect(calls.some((call) => isRename(call))).toBe(false);
});

/** Where a typed key lands: the name field, the composer, or nowhere (no field has the focus). */
async function keyLands(app: Awaited<ReturnType<typeof openConsole>>["app"]) {
  const field = app.value("id:chat-topic-rename-input");
  const composer = app.value("id:chat-composer-input") ?? "";
  await app.keyboard.press("`");
  const landed =
    field !== null && app.value("id:chat-topic-rename-input") !== field ? "field" : (app.value("id:chat-composer-input") ?? "") !== composer ? "composer" : "nowhere";
  // Take the probe back out.
  if (landed !== "nowhere") await app.keyboard.press("backspace");
  return landed;
}

for (const item of [
  { name: "Cancel", close: (app: any) => app.press("id:chat-topic-rename-cancel") },
  { name: "the close button", close: (app: any) => app.press("id:chat-topic-rename-dialog-close") },
  { name: "Save", close: (app: any) => app.press("id:chat-topic-rename-save") },
  { name: "Enter", close: (app: any) => app.submit("id:chat-topic-rename-input") },
]) {
  test(`the name field has the focus on each opening, and ${item.name} closes the dialog with no field focused`, async () => {
    const { api } = runtime();
    const { app } = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
    for (let round = 0; round < 2; round += 1) {
      await openRename(app);
      expect(await keyLands(app)).toBe("field");
      expect(app.value("id:chat-topic-rename-input")).toBe("Recipes");
      await item.close(app);
      await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
      expect(await keyLands(app)).toBe("nowhere");
    }
  });
}

test("a blank Enter and a failed save keep the dialog usable, its field focused", async () => {
  const { state, api } = runtime();
  const { app } = await openConsole({ location: "/e/default/chat/topic-2", kv: PANEL_OPEN, api });
  await openRename(app);
  await app.clear("id:chat-topic-rename-input");
  await app.submit("id:chat-topic-rename-input");
  await app.waitFor("id:chat-topic-rename-error");
  expect(await keyLands(app)).toBe("field");
  await app.type("id:chat-topic-rename-input", "Soups");
  state.saveFail = "store is down";
  await app.submit("id:chat-topic-rename-input");
  await app.waitFor("store is down");
  expect(app.shows("id:chat-topic-rename-dialog")).toBe(true);
  expect(await keyLands(app)).toBe("field");
  expect(app.value("id:chat-topic-rename-input")).toBe("Soups");
  state.saveFail = "";
  await app.submit("id:chat-topic-rename-input");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(await keyLands(app)).toBe("nowhere");
});

test("on an Android phone Back and Save close the rename dialog with no field focused", async () => {
  const { api } = runtime();
  const { app } = await openConsole({ platform: "android", location: "/e/default/chat/topic-2", api });
  await app.waitFor("id:chat-workspace-toggle");
  await app.press("id:chat-workspace-toggle");
  await openRename(app);
  expect(await keyLands(app)).toBe("field");
  await app.back();
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(await keyLands(app)).toBe("nowhere");
  await openRename(app);
  expect(await keyLands(app)).toBe("field");
  await app.press("id:chat-topic-rename-save");
  await app.waitFor("id:chat-topic-rename-dialog", { state: "gone" });
  expect(await keyLands(app)).toBe("nowhere");
});
