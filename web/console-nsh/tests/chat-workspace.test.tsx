// The workspace panel, artifacts and received files, and the phone layout of the chat.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Project", created_at: NOW, updated_at: NOW }] } };
const PANEL_OPEN = { mistermorph_console_workspace_sidebar_open_v1: "true" };

function listOf(...items: unknown[]) {
  return (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items } } : { body: { items: [] } });
}

const DONE = { id: "t1", task: "Build it", topic_id: "topic-1", status: "done", created_at: NOW, finished_at: NOW, result: { final: { output: "Built." } } };

test("the workspace tab lists the files, downloads one, and detaches the directory", async () => {
  let detached = false;
  const { app, calls } = await openConsole({
    location: "/e/default/chat/topic-1",
    kv: PANEL_OPEN,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(DONE),
      "GET /proxy:/topic/topic-1/metadata": () => ({
        body: { workspace: detached ? { workspace_dir: "", source: "none" } : { workspace_dir: "/home/me/project", source: "attachment" } },
      }),
      "GET /proxy:/workspace/tree": {
        body: {
          items: [
            { name: "src", path: "src", is_dir: true, has_children: true },
            { name: "README.md", path: "README.md", is_dir: false, size_bytes: 2048 },
          ],
        },
      },
      "DELETE /proxy:/workspace": () => {
        detached = true;
        return { body: { workspace_dir: "", source: "none" } };
      },
    },
    host: { "morph.file.save": "saved" },
  });
  await app.waitFor("id:chat-workspace-panel");
  await app.press("role:tab[Workspace]");
  await app.waitFor("id:chat-workspace-path");
  await app.waitFor("README.md");
  await app.press("label:README.md");
  await app.waitFor("id:chat-workspace-selection");
  await app.waitFor("2.00 KiB");
  await app.press("id:chat-workspace-download");
  await app.waitUntil(() => app.host.calls().some((call) => call.name === "morph.file.save"));
  const save = app.host.calls().find((call) => call.name === "morph.file.save")!.data as any;
  expect(save.name).toBe("README.md");
  expect(save.url).toContain("/api/proxy/download");
  expect(decodeURIComponent(save.url)).toContain("dir_name=workspace_dir");
  expect(save.headers.Authorization).toBe("Bearer token-1");
  await app.press("id:chat-workspace-detach");
  await app.waitFor("No workspace attached");
  expect(calls.some((call) => call.method === "DELETE" && call.uri?.startsWith("/workspace"))).toBe(true);
});

test("an artifact in a reply previews in a web view and downloads", async () => {
  const artifact = ["Here it is:", "", "```artifact", "dir_name=workspace_dir", "path=site/index.html", "```"].join("\n");
  const { app, calls } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf({ ...DONE, result: { final: { output: artifact } } }),
      "POST /artifacts/preview-ticket": { body: { ticket: "tk-1", entry_url: "http://console.test/artifacts/tk-1/index.html", expires_at: new Date(Date.now() + 600000).toISOString() } },
    },
    host: { "morph.file.save": "saved" },
  });
  await app.waitFor("id:chat-artifact");
  await app.waitFor("Web Artifact");
  await app.waitFor("index.html");
  // The latest finished reply opens its preview by itself.
  await app.waitUntil(() => calls.some((call) => call.path === "/artifacts/preview-ticket"));
  const ticket = calls.find((call) => call.path === "/artifacts/preview-ticket")!;
  expect(ticket.json).toMatchObject({ dir_name: "workspace_dir", path: "site/index.html", topic_id: "topic-1" });
  await app.press("label:Download");
  await app.waitUntil(() => app.host.calls().some((call) => call.name === "morph.file.save"));
});

test("an artifact whose preview fails says so", async () => {
  const artifact = ["```artifact", "dir_name=file_cache_dir", "path=chart.png", "```"].join("\n");
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf({ ...DONE, result: { final: { output: artifact } } }),
      "POST /artifacts/preview-ticket": { status: 500, body: { error: "preview service down" } },
    },
  });
  await app.waitFor("id:chat-artifact");
  await app.waitFor("preview service down");
});

test("a file the agent sent offers its download", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat/topic-1",
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf({ ...DONE, attachments: [{ id: "a1", name: "report.pdf", content_type: "application/pdf" }] }),
    },
    host: { "morph.file.save": "saved" },
  });
  await app.waitFor("report.pdf");
  await app.press("label:report.pdf >> role:button[Download]");
  await app.waitUntil(() => app.host.calls().some((call) => call.name === "morph.file.save"));
  const save = app.host.calls().find((call) => call.name === "morph.file.save")!.data as any;
  expect(save.url).toContain("/api/attachments?");
  expect(save.name).toBe("report.pdf");
});

test("on a phone the topic list and the conversation are separate views", async () => {
  const { app } = await openConsole({
    location: "/e/default/chat",
    width: 390,
    height: 844,
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": listOf(DONE) },
  });
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-topic-new-fab");
  expect(app.shows("id:chat-main")).toBe(false);
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:Built.");
  await app.waitFor("id:chat-back");
  expect(app.shows("id:chat-topic-sidebar")).toBe(false);
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  // The floating button starts a new topic.
  await app.press("id:chat-topic-new-fab");
  await app.waitFor("id:chat-placeholder");
});

// The path in the workspace tab: the home directory of the host the workspace is on (`home_dir`,
// as that runtime reports it) is `~`, the path on one line, cut in the middle when the panel is
// narrow. Screen readers, the tooltip and every request keep the raw path.
async function openWorkspacePath(workspace: Record<string, unknown>, options: { width?: number } = {}) {
  const opened = await openConsole({
    location: "/e/default/chat/topic-1",
    kv: PANEL_OPEN,
    width: options.width,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(DONE),
      "GET /proxy:/topic/topic-1/metadata": { body: { workspace: { source: "attachment", ...workspace } } },
      "GET /proxy:/workspace/tree": { body: { items: [{ name: "README.md", path: "README.md", is_dir: false, size_bytes: 10 }] } },
      "POST /proxy:/workspace/open": { body: { ok: true } },
    },
  });
  await opened.app.waitFor("id:chat-workspace-panel");
  await opened.app.press("role:tab[Workspace]");
  await opened.app.waitFor("id:chat-workspace-path");
  return opened;
}

/** A `label:` selector for exactly `label` (a selector starting with `/` is a regex). */
function exactLabel(label: string) {
  return `label:/^${label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/`;
}

/** What the path line shows: the texts after the panel's WORKSPACE kicker (the first is the line). */
function shownPath(texts: string[]) {
  return texts[texts.indexOf("WORKSPACE") + 1];
}

const HOME_CASES = [
  { name: "the host's home is ~", dir: "/home/me", home: "/home/me", shown: "~" },
  { name: "a folder in the host's home is ~/…", dir: "/home/me/project", home: "/home/me", shown: "~/project" },
  { name: "a sibling of the home stays whole", dir: "/home/me2/project", home: "/home/me", shown: "/home/me2/project" },
  { name: "the home's text further in stays whole", dir: "/srv/home/me/project", home: "/home/me", shown: "/srv/home/me/project" },
  { name: "another user's home on the host stays whole", dir: "/home/me/project", home: "/home/agent", shown: "/home/me/project" },
  { name: "a host that reports no home shows the path whole", dir: "/home/me/project", home: undefined, shown: "/home/me/project" },
];

for (const item of HOME_CASES) {
  test(`workspace path: ${item.name}`, async () => {
    const { app } = await openWorkspacePath({ workspace_dir: item.dir, ...(item.home ? { home_dir: item.home } : {}) });
    await app.waitUntil(() => shownPath(app.texts()) === item.shown);
    expect(app.shows(exactLabel(item.dir))).toBe(true);
  });
}

test("workspace path: a long path is cut in the middle on one line, resized with the panel, and requests keep it raw", async () => {
  const dir = "/home/me/code/clients/acme/monorepo/services/billing-gateway/internal/reconciliation-worker";
  const display = "~/code/clients/acme/monorepo/services/billing-gateway/internal/reconciliation-worker";
  const { app, calls } = await openWorkspacePath({ workspace_dir: dir, home_dir: "/home/me" });
  await app.waitUntil(() => shownPath(app.texts()).includes("..."));
  const desktop = shownPath(app.texts());
  const [head, tail] = desktop.split("...");
  expect(display.startsWith(head)).toBe(true);
  expect(display.endsWith(tail)).toBe(true);
  expect(head.startsWith("~/code")).toBe(true);
  expect(tail.endsWith("-worker")).toBe(true);
  expect(app.shows(exactLabel(dir))).toBe(true);
  // The phone layout gives the panel the whole window: more of the path shows.
  await app.setViewport(900, 800);
  await app.waitUntil(() => shownPath(app.texts()) !== desktop);
  const wider = shownPath(app.texts());
  expect(wider.length).toBeGreaterThan(desktop.length);
  // Back to the desktop: cut as before.
  await app.setViewport(1280, 800);
  await app.waitUntil(() => shownPath(app.texts()) === desktop);
  // Opening a file asks for it by its raw path in the workspace, as before.
  await app.press("label:README.md");
  await app.waitFor("id:chat-workspace-selection");
  await app.press("role:button[Open]");
  await app.waitUntil(() => calls.some((call) => call.uri === "/workspace/open"));
  expect(calls.find((call) => call.uri === "/workspace/open")!.json).toMatchObject({ topic_id: "topic-1", path: "README.md" });
  expect(calls.every((call) => !String(call.json?.workspace_dir ?? "").includes("~"))).toBe(true);
});
