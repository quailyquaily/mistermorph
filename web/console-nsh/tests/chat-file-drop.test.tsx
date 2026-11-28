// FT195: files and directories dragged from the system's file manager onto the desktop app's
// composer.
//
// The composer's frame is the drop target (nsh gives a drop to the closest listening view where it
// lands): a drop elsewhere on the page, on another part's target, or on an open dialog is not the
// composer's, and in a browser the composer is no target at all. The host says what was dropped
// (`morph.file.drop`), all of it at once: files become the draft's attachments in the order of the
// drop, through the upload every picked file takes; one directory becomes the workspace of the
// next message, as Attach Workspace chooses one, on the desktop app's own agent only. A drop the
// host or the page refuses says why and leaves the draft, its files and its workspace alone. No
// drop sends a message. An answer that comes after the conversation changed lands nowhere.
//
// `app.dropFiles` is the drop itself (`onFileDrop`); the drag's enter and leave, which show and
// clear the frame's mark, have no headless step (the runtime's own tests cover them).
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { createComposerDrop, dropRefusalKey, droppedNames, droppedURIs, type ComposerDropHost } from "../components/chat/fileDrop";
import type { DroppedFiles, PickedFile } from "../lib/platform";
import { localEndpoint, openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const FEATURES = ["pickFile", "saveFile", "pickDirectory", "fileDrop"];
const REMOTE = { endpoint_ref: "ep_remote", name: "Remote", url: "https://agent.example.com", connected: true, agent_name: "Atlas", mode: "console", can_submit: true, avatar_url: "" };

const picked = (id: string, name: string, type = "text/plain"): PickedFile => ({ id, name, size: 10, type, preview: "" });
const uri = (path: string) => `file://${path.split("/").map(encodeURIComponent).join("/")}`;

/* ---------- the drop's handling, with a stand-in host ---------- */

function fakeDrop(overrides: Partial<ComposerDropHost> = {}) {
  const seen = { resolved: [] as string[][], released: [] as string[], workspaces: [] as string[], files: [] as string[][], refused: [] as string[], order: [] as string[] };
  const state = { draft: "d1", blocked: "", workspaceRefusal: "" };
  const held: { uris: string[]; settle: (answer: DroppedFiles) => void; fail: (error: Error) => void }[] = [];
  const drop = createComposerDrop({
    resolve: (uris) => {
      seen.resolved.push(uris);
      return new Promise<DroppedFiles>((settle, fail) => held.push({ uris, settle, fail }));
    },
    release: (file) => void seen.released.push(file.id),
    draft: () => state.draft,
    blocked: () => state.blocked,
    workspaceRefusal: () => state.workspaceRefusal,
    takeWorkspace: (dir) => {
      seen.workspaces.push(dir);
      seen.order.push("workspace");
    },
    takeFiles: (files) => {
      seen.files.push(files.map((file) => file.id));
      seen.order.push("files");
    },
    refuse: (text, type) => void seen.refused.push(`${type}: ${text}`),
    refusalText: (key, names) => `${key}(${names})`,
    failedText: (error) => `failed(${(error as Error).message})`,
    ...overrides,
  });
  return { drop, seen, state, held };
}

test("a drop event's URLs are read in order, and a refusal names what it is about", () => {
  expect(droppedURIs({ uris: ["file:///a", " ", "", "file:///b%20c"] })).toEqual(["file:///a", "file:///b%20c"]);
  expect(droppedURIs({})).toEqual([]);
  expect(droppedURIs(null)).toEqual([]);
  expect(droppedNames(["a", "b"])).toBe("a, b");
  expect(droppedNames(["a", "b", "c", "d", "e"])).toBe("a, b, c +2");
  expect(dropRefusalKey("multiple_directories")).toBe("chat_composer_drop_multiple_directories");
  expect(dropRefusalKey("unreadable")).toBe("chat_composer_drop_unreadable");
  expect(dropRefusalKey("something new")).toBe("chat_composer_drop_invalid");
});

test("a drop is taken whole: the directory first, then the files in their order; an empty one asks nothing", async () => {
  const { drop, seen, held } = fakeDrop();
  expect(await drop([])).toBe("empty");
  expect(await drop([" ", ""])).toBe("empty");
  expect(seen.resolved).toEqual([]);

  const taking = drop(["file:///b.txt", "file:///work", " ", "file:///a.txt"]);
  expect(seen.resolved).toEqual([["file:///b.txt", "file:///work", "file:///a.txt"]]);
  held[0].settle({ ok: true, files: [picked("1", "b.txt"), picked("2", "a.txt")], directory: "/work" });
  expect(await taking).toBe("taken");
  expect(seen.workspaces).toEqual(["/work"]);
  expect(seen.files).toEqual([["1", "2"]]);
  expect(seen.order).toEqual(["workspace", "files"]);
  expect(seen.released).toEqual([]);
  expect(seen.refused).toEqual([]);

  // The host found nothing to use (blank entries only): nothing changes.
  const nothing = drop(["file:///x"]);
  held[1].settle({ ok: true, files: [], directory: "" });
  expect(await nothing).toBe("empty");
  expect(seen.order).toEqual(["workspace", "files"]);
});

test("a refused drop says why and takes nothing, by the host, by the composer before or after the host answered, and for a directory that cannot be used", async () => {
  const { drop, seen, state, held } = fakeDrop();
  const refused = drop(["file:///one", "file:///two"]);
  held[0].settle({ ok: false, reason: "multiple_directories", names: ["one", "two"] });
  expect(await refused).toBe("refused");
  expect(seen.refused).toEqual(["error: chat_composer_drop_multiple_directories(one, two)"]);

  // The host could not answer.
  const failed = drop(["file:///a"]);
  held[1].fail(new Error("no host"));
  expect(await failed).toBe("refused");
  expect(seen.refused.at(-1)).toBe("error: failed(no host)");

  // Closed before the drop: the host is not asked.
  state.blocked = "sending";
  expect(await drop(["file:///a"])).toBe("refused");
  expect(seen.resolved.length).toBe(2);
  expect(seen.refused.at(-1)).toBe("warning: sending");

  // Closed while the host read the disk: the files go back.
  state.blocked = "";
  const late = drop(["file:///a", "file:///dir"]);
  state.blocked = "editing";
  held[2].settle({ ok: true, files: [picked("7", "a")], directory: "/dir" });
  expect(await late).toBe("refused");
  expect(seen.released).toEqual(["7"]);
  expect(seen.refused.at(-1)).toBe("warning: editing");

  // A directory where none can be used: the files of the same drop are not taken either.
  state.blocked = "";
  state.workspaceRefusal = "remote agent";
  const remote = drop(["file:///a", "file:///dir"]);
  held[3].settle({ ok: true, files: [picked("8", "a")], directory: "/dir" });
  expect(await remote).toBe("refused");
  expect(seen.released).toEqual(["7", "8"]);
  expect(seen.refused.at(-1)).toBe("error: remote agent");
  // Files alone are taken there.
  const files = drop(["file:///a"]);
  held[4].settle({ ok: true, files: [picked("9", "a")], directory: "" });
  expect(await files).toBe("taken");

  expect(seen.workspaces).toEqual([]);
  expect(seen.files).toEqual([["9"]]);
});

test("an answer for a draft that is no longer on screen lands nowhere: its files go back to the host, without a word", async () => {
  const { drop, seen, state, held } = fakeDrop();
  // Two drops on one draft, then the conversation changes (another topic, another agent, a send).
  const first = drop(["file:///a", "file:///dir"]);
  const second = drop(["file:///gone"]);
  const third = drop(["file:///b"]);
  state.draft = "d2";
  // A drop on the new draft, made before the old ones are answered.
  const fresh = drop(["file:///c"]);
  held[0].settle({ ok: true, files: [picked("1", "a")], directory: "/dir" });
  held[1].settle({ ok: false, reason: "unreadable", names: ["gone"] });
  held[2].fail(new Error("no host"));
  expect(await first).toBe("stale");
  expect(await second).toBe("stale");
  expect(await third).toBe("stale");
  expect(seen.released).toEqual(["1"]);
  expect(seen.workspaces).toEqual([]);
  expect(seen.files).toEqual([]);
  expect(seen.refused).toEqual([]);
  // The new draft's own drop is taken.
  held[3].settle({ ok: true, files: [picked("2", "c")], directory: "" });
  expect(await fresh).toBe("taken");
  expect(seen.files).toEqual([["2"]]);
  // Back on the first draft, a late answer of the second is still not the first's.
  const other = drop(["file:///d"]);
  state.draft = "d1";
  held[4].settle({ ok: true, files: [picked("3", "d")], directory: "" });
  expect(await other).toBe("stale");
  expect(seen.released).toEqual(["1", "3"]);
});

/* ---------- which view a drop belongs to ---------- */

test("a drop is heard once, by the closest target where it lands: the composer, not what is around it, and not from elsewhere", async () => {
  const app = await open("./fixtures/composer-drop-app.tsx", { width: 800, height: 600, platform: "linux", locale: "en-US" });
  await app.waitFor("id:chat-composer-input");
  // The mark of a drag over the frame shows only during one: the fixture draws one by itself,
  // the composer none.
  expect(app.count("id:chat-composer-drop-mark")).toBe(1);
  expect(app.count("id:chat-composer-frame >> id:chat-composer-drop-mark")).toBe(0);
  expect(app.count("text:Drop here")).toBe(0);
  const log = () => JSON.parse(app.texts().find((text) => text.startsWith("[")) ?? "[]") as string[];

  // On the field, on the frame and on a control in it: the composer, and not the box around it.
  await app.dropFiles("id:chat-composer-input", ["file:///tmp/a%20b.txt", "file:///tmp/c.txt"]);
  await app.waitUntil(() => log().length === 1);
  await app.dropFiles("id:chat-composer-frame", ["file:///tmp/d.txt"]);
  await app.waitUntil(() => log().length === 2);
  await app.dropFiles("id:chat-composer-send", ["file:///tmp/e.txt"]);
  await app.waitUntil(() => log().length === 3);
  expect(log()).toEqual(["composer:file:///tmp/a%20b.txt|file:///tmp/c.txt", "composer:file:///tmp/d.txt", "composer:file:///tmp/e.txt"]);

  // Beside the composer, in the box around it: the box, not the composer.
  await app.dropFiles("id:around-pad", ["file:///tmp/f.txt"]);
  await app.waitUntil(() => log().length === 4);
  // Another part's target: that part alone.
  await app.dropFiles("id:other", ["file:///tmp/g.txt"]);
  await app.waitUntil(() => log().length === 5);
  expect(log().slice(3)).toEqual(["around:file:///tmp/f.txt", "other:file:///tmp/g.txt"]);

  // Where nothing listens, nobody hears.
  await expect(app.dropFiles("id:plain", ["file:///tmp/h.txt"])).rejects.toThrow();
  // A drop without files is nothing.
  await app.dropFiles("id:chat-composer-input", []);
  expect(log().length).toBe(5);
  expect(app.value("id:chat-composer-input")).toBe("");
});

/* ---------- in the console ---------- */

function uploadAnswer(names: Record<string, string>, uploads: any[], fail: Set<string> = new Set()) {
  return (data: any) => {
    uploads.push(data);
    const name = names[data.id] ?? "file";
    if (fail.has(data.id)) {
      fail.delete(data.id);
      return { ok: false, status: 500, statusText: "Internal Server Error", body: JSON.stringify({ error: "disk full" }) };
    }
    return { ok: true, status: 200, statusText: "OK", body: JSON.stringify({ files: [{ name, dir_name: "workspace_dir", path: name }] }) };
  };
}

/** A desktop app whose host answers drops from `answers`, in turn, and records what it was asked. */
async function openDesktop(options: {
  location?: string;
  answers: unknown[];
  names?: Record<string, string>;
  fail?: Set<string>;
  remote?: boolean;
  api?: Record<string, any>;
}) {
  const drops: string[][] = [];
  const uploads: any[] = [];
  const released: string[] = [];
  let created = false;
  const posts: any[] = [];
  const answers = [...options.answers];
  const { app, calls } = await openConsole({
    location: options.location ?? "/e/default/chat/topic-1",
    runtime: "desktop",
    features: FEATURES,
    endpoints: options.remote ? [localEndpoint(), REMOTE] : undefined,
    api: {
      "GET /proxy:/topics": () => ({ body: { items: created || options.location !== "/e/default/chat" ? TOPICS.body.items : [] } }),
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/tasks/task-1": { body: { id: "task-1", task: "see", status: "running", topic_id: "topic-1", created_at: NOW } },
      "POST /proxy:/tasks": (request: ApiRequest) => {
        created = true;
        posts.push(request.json);
        return { body: { id: "task-1", status: "queued", topic_id: "topic-1" } };
      },
      ...(options.api || {}),
    },
    host: {
      "morph.file.drop": (data: any) => {
        drops.push(data.uris);
        return answers.shift() ?? { ok: true, files: [], directory: "" };
      },
      "morph.file.upload": uploadAnswer(options.names ?? {}, uploads, options.fail),
      "morph.file.release": (data: any) => {
        released.push(data.id);
        return null;
      },
    },
  });
  await app.waitFor("id:chat-composer-input");
  const sent = () => calls.some((call) => call.method === "POST" && call.uri === "/tasks");
  return { app, calls, drops, uploads, released, posts, sent };
}

/** Whether the composer shows `dir` as the workspace of the next message. */
function workspace(app: App, dir: string): boolean {
  return app.count("id:chat-composer-workspace") === 1 && app.count(`label:Workspace for the next message: ${dir}`) === 1;
}

/** Closes the notices: they lie over the foot of the window, where Send is. */
async function dismissNotices(app: App) {
  while (app.count("role:button[Dismiss]") > 0) await app.press("role:button[Dismiss] >> nth=0");
}

test("dropped files become the draft's attachments in their order, can be removed and retried, and go with the message", async () => {
  const names = { f1: "报告 final.txt", f2: "b.png", f3: "a.txt", f4: "late.txt" };
  const { app, drops, uploads, released, posts, sent } = await openDesktop({
    answers: [
      { ok: true, files: [picked("f1", names.f1), picked("f2", names.f2, "image/png"), picked("f3", names.f3)], directory: "" },
      { ok: true, files: [picked("f4", names.f4)], directory: "" },
    ],
    names,
    fail: new Set(["f3"]),
  });
  await app.type("id:chat-composer-input", "look at these");
  const dropped = [uri("/home/me/报告 final.txt"), uri("/home/me/b.png"), uri("/home/me/a.txt")];
  await app.dropFiles("id:chat-composer-input", dropped);
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("disk full")));
  // The host was asked once, with the URLs as they were dropped (spaces and Unicode escaped).
  expect(drops).toEqual([dropped]);
  expect(dropped[0]).toBe("file:///home/me/%E6%8A%A5%E5%91%8A%20final.txt");
  expect(uploads.map((upload) => upload.id)).toEqual(["f1", "f2", "f3"]);
  expect(decodeURIComponent(uploads[0].url)).toContain("endpoint=ep_console_local");
  // The pills stand in the order of the drop; nothing was sent and the draft's text is as it was.
  const pills = () => app.texts().filter((text) => Object.values(names).includes(text));
  expect(pills()).toEqual([names.f1, names.f2, names.f3]);
  expect(sent()).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("look at these");
  // A failed upload holds Send back until it is retried or removed.
  expect(app.enabled("id:chat-composer-send")).toBe(false);
  await app.press("role:button[Retry upload]");
  await app.waitUntil(() => !app.texts().some((text) => text.startsWith("disk full")));
  expect(uploads.map((upload) => upload.id)).toEqual(["f1", "f2", "f3", "f3"]);

  // A second drop adds after the first; removing one gives it back to the host (the image was kept
  // for its preview).
  await app.dropFiles("id:chat-composer-frame", [uri("/home/me/late.txt")]);
  await app.waitUntil(() => pills().length === 4);
  expect(pills()).toEqual([names.f1, names.f2, names.f3, names.f4]);
  await app.press(`role:button[Remove from task: ${names.f2}]`);
  await app.waitUntil(() => released.includes("f2"));
  expect(pills()).toEqual([names.f1, names.f3, names.f4]);
  expect(sent()).toBe(false);

  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].task).toContain("look at these");
  expect(posts[0].topic_id).toBe("topic-1");
  expect(posts[0].workspace_dir ?? "").toBe("");
  expect(posts[0].file_references).toEqual([
    { dir_name: "workspace_dir", path: names.f1 },
    { dir_name: "workspace_dir", path: names.f3 },
    { dir_name: "workspace_dir", path: names.f4 },
  ]);
});

test("in a new conversation a dropped directory is the workspace of the first message, and the files of the same drop are uploaded into it", async () => {
  const names = { f1: "notes.txt", f2: "plan.md" };
  const { app, uploads, posts, sent, calls } = await openDesktop({
    location: "/e/default/chat",
    answers: [{ ok: true, files: [picked("f1", names.f1), picked("f2", names.f2)], directory: "/home/me/my project 目录" }],
    names,
  });
  await app.type("id:chat-composer-input", "start here");
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/notes.txt"), uri("/home/me/my project 目录"), uri("/home/me/plan.md")]);
  // The workspace shows in the composer before anything is sent.
  await app.waitFor("id:chat-composer-workspace");
  expect(workspace(app, "/home/me/my project 目录")).toBe(true);
  expect(app.texts().includes("/home/me/my project 目录")).toBe(true);
  await app.waitUntil(() => uploads.length === 2);
  expect(uploads.map((upload) => [upload.id, upload.fields.workspace_dir])).toEqual([
    ["f1", "/home/me/my project 目录"],
    ["f2", "/home/me/my project 目录"],
  ]);
  expect(sent()).toBe(false);
  // The drop bound nothing by itself.
  expect(calls.some((call) => call.method === "PUT" && call.uri === "/workspace")).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("start here");

  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].workspace_dir).toBe("/home/me/my project 目录");
  expect(posts[0].topic_id ?? "").toBe("");
  expect(posts[0].file_references).toEqual([
    { dir_name: "workspace_dir", path: names.f1 },
    { dir_name: "workspace_dir", path: names.f2 },
  ]);
});

test("in a conversation with a workspace a dropped directory replaces it when the message is sent; a later drop replaces the choice", async () => {
  const { app, posts, sent, calls } = await openDesktop({
    answers: [
      { ok: true, files: [], directory: "/home/me/first" },
      { ok: true, files: [], directory: "/home/me/second" },
    ],
    api: { "GET /proxy:/topic/topic-1/metadata": { body: { workspace: { workspace_dir: "/home/me/old", source: "attachment" } } } },
  });
  await app.type("id:chat-composer-input", "move over");
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/first")]);
  await app.waitUntil(() => workspace(app, "/home/me/first"));
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/second")]);
  await app.waitUntil(() => workspace(app, "/home/me/second"));
  expect(app.count("id:chat-composer-workspace")).toBe(1);
  expect(sent()).toBe(false);
  expect(calls.some((call) => call.method === "PUT" && call.uri === "/workspace")).toBe(false);
  expect(app.value("id:chat-composer-input")).toBe("move over");

  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].topic_id).toBe("topic-1");
  expect(posts[0].workspace_dir).toBe("/home/me/second");
  // Sent, it is the conversation's workspace and no longer a choice in the composer.
  await app.waitFor("id:chat-composer-workspace", { state: "gone" });
});

test("the dropped workspace can be taken back before sending: the files uploaded into it go with it, the others stay", async () => {
  const names = { f1: "before.txt", f2: "inside.txt" };
  const { app, uploads, released, posts } = await openDesktop({
    location: "/e/default/chat",
    answers: [
      { ok: true, files: [picked("f1", names.f1)], directory: "" },
      { ok: true, files: [picked("f2", names.f2)], directory: "/home/me/project" },
    ],
    names,
    api: {},
  });
  await app.type("id:chat-composer-input", "changed my mind");
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/before.txt")]);
  await app.waitUntil(() => uploads.length === 1);
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/project"), uri("/home/me/inside.txt")]);
  await app.waitUntil(() => uploads.length === 2);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  expect(uploads.map((upload) => upload.fields.workspace_dir ?? "")).toEqual(["", "/home/me/project"]);
  expect(app.texts().includes(names.f2)).toBe(true);

  await app.press("role:button[Remove workspace]");
  await app.waitFor("id:chat-composer-workspace", { state: "gone" });
  expect(app.texts().includes(names.f2)).toBe(false);
  expect(app.texts().includes(names.f1)).toBe(true);
  expect(app.value("id:chat-composer-input")).toBe("changed my mind");
  expect(released).toEqual(["f1", "f2"]);

  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].workspace_dir ?? "").toBe("");
  expect(posts[0].file_references).toEqual([{ dir_name: "workspace_dir", path: names.f1 }]);
});

test("a drop the host refuses says why and keeps the draft, its files and its workspace", async () => {
  const names = { f1: "kept.txt" };
  const { app, drops, uploads, released, posts, sent } = await openDesktop({
    answers: [
      { ok: true, files: [picked("f1", names.f1)], directory: "/home/me/kept" },
      { ok: false, reason: "multiple_directories", names: ["one", "two"] },
      { ok: false, reason: "unreadable", names: ["gone.txt"] },
      { ok: false, reason: "invalid", names: ["https://example.com/a.txt"] },
    ],
    names,
  });
  await app.type("id:chat-composer-input", "keep me");
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/kept.txt"), uri("/home/me/kept")]);
  await app.waitUntil(() => uploads.length === 1);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  expect(workspace(app, "/home/me/kept")).toBe(true);

  await app.dropFiles("id:chat-composer-input", [uri("/home/me/one"), uri("/home/me/x.txt"), uri("/home/me/two")]);
  await app.waitFor("text:Nothing was added: a task works in one workspace, and one, two are several folders. Drop one folder.");
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/gone.txt"), uri("/home/me/x.txt")]);
  await app.waitFor("text:Nothing was added: gone.txt could not be read. Check that it still exists and that this app may open it, then drop again.");
  await app.dropFiles("id:chat-composer-input", ["https://example.com/a.txt"]);
  await app.waitFor("text:Nothing was added: only files and folders on this computer can be dropped here (https://example.com/a.txt).");
  // A drop without files asks the host nothing.
  await app.dropFiles("id:chat-composer-input", []);
  expect(drops.length).toBe(4);

  expect(uploads.length).toBe(1);
  expect(released).toEqual(["f1"]); // uploaded, a text file went back as every uploaded one does
  expect(app.value("id:chat-composer-input")).toBe("keep me");
  expect(app.texts().includes(names.f1)).toBe(true);
  expect(workspace(app, "/home/me/kept")).toBe(true);
  expect(sent()).toBe(false);
  await dismissNotices(app);
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].workspace_dir).toBe("/home/me/kept");
  expect(posts[0].file_references).toEqual([{ dir_name: "workspace_dir", path: names.f1 }]);
});

test("an agent on another machine takes dropped files but never a directory of this computer", async () => {
  const names = { f1: "a.txt", f2: "b.txt" };
  const { app, uploads, released, posts, sent } = await openDesktop({
    location: "/e/ep_remote/chat/topic-1",
    remote: true,
    answers: [
      { ok: true, files: [picked("f1", names.f1)], directory: "/home/me/project" },
      { ok: true, files: [picked("f2", names.f2)], directory: "" },
    ],
    names,
  });
  await app.type("id:chat-composer-input", "remote work");
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/a.txt"), uri("/home/me/project")]);
  await app.waitFor(
    "text:Nothing was added: Remote runs on another machine and cannot work in a folder of this computer. Use Attach Workspace to choose a folder on its machine.",
  );
  // Nothing of that drop was taken: its file went back to the host unsent.
  expect(uploads).toEqual([]);
  expect(released).toEqual(["f1"]);
  expect(app.texts().includes(names.f1)).toBe(false);
  expect(app.count("id:chat-composer-workspace")).toBe(0);
  expect(app.value("id:chat-composer-input")).toBe("remote work");
  await dismissNotices(app);

  // Files alone go to that agent as picked ones do.
  await app.dropFiles("id:chat-composer-input", [uri("/home/me/b.txt")]);
  await app.waitUntil(() => uploads.length === 1);
  expect(decodeURIComponent(uploads[0].url)).toContain("endpoint=ep_remote");
  expect(uploads[0].fields.workspace_dir ?? "").toBe("");
  expect(sent()).toBe(false);
  await app.waitUntil(() => app.enabled("id:chat-composer-send"));
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => posts.length === 1);
  expect(posts[0].workspace_dir ?? "").toBe("");
  expect(posts[0].file_references).toEqual([{ dir_name: "workspace_dir", path: names.f2 }]);
});

test("only the composer takes a drop: not the conversation, not the topic list, not an open dialog, and not in a browser", async () => {
  const { app, drops } = await openDesktop({ answers: [] });
  await expect(app.dropFiles("id:chat-page", [uri("/home/me/a.txt")])).rejects.toThrow();
  await expect(app.dropFiles("text:Ops", [uri("/home/me/a.txt")])).rejects.toThrow();
  // The workspace dialog lies over the page: a drop on it is not the composer's.
  await app.press("id:chat-composer-add");
  await app.press("role:menuitem[Attach Workspace]");
  await app.waitFor("id:workspace-cancel");
  await expect(app.dropFiles("id:workspace-cancel", [uri("/home/me/project")])).rejects.toThrow();
  expect(drops).toEqual([]);

  // A browser's page is told no paths: its composer listens to no drop.
  const web = await openConsole({
    location: "/e/default/chat/topic-1",
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { body: { items: [] } } },
    host: { "morph.file.drop": () => drops.push(["web"]) },
  });
  await web.app.waitFor("id:chat-composer-input");
  await expect(web.app.dropFiles("id:chat-composer-input", [uri("/home/me/a.txt")])).rejects.toThrow();
  expect(drops).toEqual([]);
});
