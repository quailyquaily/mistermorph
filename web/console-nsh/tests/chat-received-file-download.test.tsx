// Downloading a file the agent sent (a task attachment): an icon button named for the file, busy
// while the host saves it, a check once it is saved, nothing after a cancel, and the reason after a
// failure, with the button ready to try again. In a browser the host downloads it (host.js); in the
// Android app the app's own host (lib/mobileHost.ts) hands it to the APK's native part, which asks
// where to save it with the system's picker and writes the console's bytes there: here the test
// plays that native part (`morph.file.saveSupport`, `morph.file.save`).
import { expect, test } from "nsh/test";
import { openConsole, ORIGIN } from "./harness";
import { nativeSaveRequest } from "../lib/mobileHost";
import { saveFile as hostSaveFile } from "../host.js";
import { createReceivedFiles, receivedFileButtonSize, SAVED_MS } from "../components/chat/ReceivedFile";
import { SAVE_UNAVAILABLE } from "../lib/platform";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Files", created_at: NOW, updated_at: NOW }] } };
const FILE = { id: "a1", name: "notes.txt", content_type: "text/plain" };
const DONE = {
  id: "t1",
  task: "Send the notes",
  topic_id: "topic-1",
  status: "done",
  created_at: NOW,
  finished_at: NOW,
  result: { final: { output: "Here are the notes." } },
  attachments: [FILE],
};
const CHAT = {
  "GET /proxy:/topics": TOPICS,
  "GET /proxy:/tasks": { body: { items: [DONE] } },
  "GET /proxy:/todo/tasks": { body: { items: [] } },
};

/** The download button of the file, in a size and state: `button("xs", "idle")`. */
const button = (size: string, state: "idle" | "busy" | "saved") => `id:chat-received-file-download.${size}.${state}`;
const saves = (app: { host: { calls(): { name: string; data: unknown }[] } }) =>
  app.host.calls().filter((call) => call.name === "morph.file.save");
const alerts = (app: { texts(): string[] }) => app.texts().filter((text) => text.startsWith("Download failed") || text.startsWith("Saving files"));

async function openBrowser(save: unknown) {
  const opened = await openConsole({ location: "/e/default/chat/topic-1", api: CHAT, host: { "morph.file.save": save } });
  await opened.app.waitFor("notes.txt");
  await opened.app.waitFor(button("xs", "idle"));
  return opened;
}

async function openPhone(host: Record<string, unknown>) {
  const opened = await openConsole({ platform: "android", location: "/e/default/chat/topic-1", api: CHAT, host });
  await opened.app.waitFor("notes.txt");
  await opened.app.waitFor(button("md", "idle"));
  return opened;
}

test("the download is an icon button named for the file, 32pt beside it on a desktop and a 44pt touch target on a phone", async () => {
  expect(receivedFileButtonSize(false)).toBe("xs");
  expect(receivedFileButtonSize(true)).toBe("md");
  const { app } = await openBrowser("saved");
  expect(app.count("label:Download notes.txt")).toBe(1);
  // A glyph, not a word: "Download" names it (and is its tooltip) but is not drawn.
  expect(app.texts().includes("Download")).toBe(false);
});

test("in a browser the host downloads the console's attachment with the session's token; the check shows, then the glyph is back", async () => {
  const { app } = await openBrowser("saved");
  await app.press("label:Download notes.txt");
  await app.waitFor(button("xs", "saved"));
  expect(app.count("label:Saved notes.txt")).toBe(1);
  const save = saves(app)[0].data as any;
  expect(save.name).toBe("notes.txt");
  expect(save.url.startsWith(`${ORIGIN}/api/attachments?`)).toBe(true);
  expect(save.headers.Authorization).toBe("Bearer token-1");
  expect(alerts(app)).toEqual([]);
  await app.waitFor(button("xs", "idle"), { timeout: 5000 });
  expect(app.count("label:Download notes.txt")).toBe(1);
});

test("a cancelled save says nothing and leaves the button as it was", async () => {
  const { app } = await openBrowser("cancelled");
  await app.press("label:Download notes.txt");
  await app.waitUntil(() => saves(app).length === 1);
  await app.waitFor(button("xs", "idle"));
  expect(app.count(button("xs", "saved"))).toBe(0);
  expect(alerts(app)).toEqual([]);
});

test("a failed save says why, and the button tries again", async () => {
  let attempt = 0;
  const { app } = await openBrowser(() => {
    attempt += 1;
    if (attempt === 1) throw new Error("HTTP 404");
    return "saved";
  });
  await app.press("label:Download notes.txt");
  await app.waitFor("text:Download failed: HTTP 404");
  await app.waitFor(button("xs", "idle"));
  await app.press("label:Download notes.txt");
  await app.waitFor(button("xs", "saved"));
  expect(alerts(app)).toEqual([]);
  expect(saves(app).length).toBe(2);
});

test("in the Android app the native part saves it: the file's name and the console's URL, with the session's token, and the check once written", async () => {
  const { app } = await openPhone({
    "morph.file.saveSupport": "",
    "morph.file.save": "saved",
  });
  await app.press("label:Download notes.txt");
  await app.waitFor(button("md", "saved"));
  const save = saves(app)[0].data as any;
  expect(save.name).toBe("notes.txt");
  expect(save.url.startsWith(`${ORIGIN}/api/attachments?`)).toBe(true);
  expect(save.headers.Authorization).toBe("Bearer token-1");
  expect(save.text).toBe(undefined);
  expect(alerts(app)).toEqual([]);
});

test("in the Android app backing out of the picker says nothing; a failure says why and the next press tries again", async () => {
  const answers: Array<() => unknown> = [
    () => "cancelled",
    () => {
      throw new Error("attachment not found");
    },
    () => "saved",
  ];
  const { app } = await openPhone({
    "morph.file.saveSupport": "",
    "morph.file.save": () => answers.shift()!(),
  });
  await app.press("label:Download notes.txt");
  await app.waitUntil(() => saves(app).length === 1);
  await app.waitFor(button("md", "idle"));
  expect(alerts(app)).toEqual([]);
  await app.press("label:Download notes.txt");
  await app.waitFor("text:Download failed: attachment not found");
  await app.waitFor(button("md", "idle"));
  await app.press("label:Download notes.txt");
  await app.waitFor(button("md", "saved"));
  expect(alerts(app)).toEqual([]);
  expect(saves(app).length).toBe(3);
});

for (const [name, host] of [
  ["an APK without the native part", {}],
  ["a device without a picker for new documents", { "morph.file.saveSupport": "unsupported", "morph.file.save": "saved" }],
] as const) {
  test(`in the Android app, ${name} says saving is not available and asks nothing`, async () => {
    const { app } = await openPhone(host);
    await app.press("label:Download notes.txt");
    await app.waitFor("text:Saving files is not available in this version of the phone app.");
    expect(saves(app).length).toBe(0);
    await app.waitFor(button("md", "idle"));
  });
}

test("the native part's request: the console server's URLs alone get the headers; text, bytes and empty files go as they are", () => {
  const headers = { Authorization: "Bearer token-1" };
  expect(nativeSaveRequest({ name: "a.pdf", url: `${ORIGIN}/api/attachments?id=1`, headers }, ORIGIN)).toEqual({
    name: "a.pdf",
    url: `${ORIGIN}/api/attachments?id=1`,
    headers,
    type: "application/octet-stream",
  });
  for (const url of ["https://elsewhere.test/api/attachments?id=1", "http://console.test.evil/x", "file:///etc/passwd", "javascript:alert(1)"]) {
    expect(() => nativeSaveRequest({ name: "a.pdf", url, headers }, ORIGIN)).toThrow("The file is not on this console server.");
  }
  // No server saved yet: nothing gets the headers.
  expect(() => nativeSaveRequest({ name: "a.pdf", url: `${ORIGIN}/x`, headers }, "")).toThrow("The file is not on this console server.");
  expect(() => nativeSaveRequest({ name: "a.pdf", url: "not a url" }, ORIGIN)).toThrow("The file's address is not a URL.");
  expect(() => nativeSaveRequest({ name: "a.pdf" }, ORIGIN)).toThrow("Nothing to save.");
  expect(nativeSaveRequest({ name: "run.log", text: "", type: "text/plain" }, ORIGIN)).toEqual({ name: "run.log", text: "", type: "text/plain" });
  expect(nativeSaveRequest({ name: " ", base64: "AP8=" }, ORIGIN)).toEqual({ name: "download", base64: "AP8=", type: "application/octet-stream" });
});

// The row's state, without an app: a host's save that ends when the test says (a held host call
// would hold a headless app's every step).
function heldSaves() {
  const pending: Array<{ pathname: string; name: string; settle: (answer: "saved" | "cancelled" | Error) => void }> = [];
  const files = createReceivedFiles({
    save: (pathname, name) =>
      new Promise((resolve, reject) => {
        pending.push({ pathname, name, settle: (answer) => (answer instanceof Error ? reject(answer) : resolve(answer)) });
      }),
  });
  return { files, pending };
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("while the save runs the row is busy and a second press asks nothing; saved only once the host answered, the check then goes", async () => {
  const { files, pending } = heldSaves();
  const run = files.download("k", FILE, "topic-1", "t1");
  expect(files.state("k")).toMatchObject({ busy: true, saved: false, error: "" });
  void files.download("k", FILE, "topic-1", "t1");
  expect(pending.length).toBe(1);
  expect(pending[0].name).toBe("notes.txt");
  expect(pending[0].pathname.startsWith("/attachments?")).toBe(true);
  await tick();
  expect(files.state("k").saved).toBe(false);
  pending[0].settle("saved");
  await run;
  expect(files.state("k")).toMatchObject({ busy: false, saved: true, error: "" });
  await tick(SAVED_MS + 100);
  expect(files.state("k").saved).toBe(false);
  files.dispose();
});

test("a cancelled save leaves the row as it was; a failure says why and the next press clears it", async () => {
  const { files, pending } = heldSaves();
  let run = files.download("k", FILE, "topic-1", "t1");
  pending[0].settle("cancelled");
  await run;
  expect(files.state("k")).toMatchObject({ busy: false, saved: false, error: "" });
  run = files.download("k", FILE, "topic-1", "t1");
  pending[1].settle(new Error("The download ended early (10 of 1000 bytes)."));
  await run;
  expect(files.state("k")).toMatchObject({ busy: false, saved: false, error: "Download failed: The download ended early (10 of 1000 bytes)." });
  run = files.download("k", FILE, "topic-1", "t1");
  expect(files.state("k")).toMatchObject({ busy: true, error: "" });
  pending[2].settle(Object.assign(new Error("Saving files is not available in this build of the phone app."), { code: SAVE_UNAVAILABLE }));
  await run;
  expect(files.state("k").error).toBe("Saving files is not available in this version of the phone app.");
  // Disposed with the check showing: its timer goes too.
  run = files.download("k", FILE, "topic-1", "t1");
  pending[3].settle("saved");
  await run;
  files.dispose();
  expect(files.state("k").saved).toBe(false);
});

// The browser's host (host.js) as it was: it fetches the URL with the session's headers, uncached,
// and saves the bytes under the file's name through a clicked download link, "saved" only after the
// whole body arrived; an HTTP error fails with its status and downloads nothing.
// host.js is plain JS: its request's fields are all optional.
const browserSave = hostSaveFile as unknown as (request: Record<string, unknown>, env: unknown) => Promise<string>;

function fakePage(responses: Array<{ status: number; body: Uint8Array }>) {
  const fetched: Array<{ url: string; init: any }> = [];
  const clicked: Array<{ href: string; download: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  const later: Array<() => void> = [];
  let next = 0;
  const env = {
    fetch: async (url: string, init: any) => {
      fetched.push({ url, init });
      const answer = responses.shift()!;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, blob: async () => new Blob([answer.body]) };
    },
    URL: {
      createObjectURL: (blob: Blob) => {
        const href = `blob:page/${++next}`;
        blobs.set(href, blob);
        return href;
      },
      revokeObjectURL: (href: string) => revoked.push(href),
    },
    document: {
      body: { append: () => {} },
      createElement: () => {
        const link: any = { style: {}, remove: () => {} };
        link.click = () => clicked.push({ href: link.href, download: link.download, blob: blobs.get(link.href)! });
        return link;
      },
    },
    setTimeout: (callback: () => void) => later.push(callback),
  };
  return { env, fetched, clicked, revoked, later };
}

test("in a browser the host's save fetches with the headers, uncached, and downloads the exact bytes under the file's name", async () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const page = fakePage([
    { status: 200, body: bytes },
    { status: 200, body: new Uint8Array() },
    { status: 404, body: new Uint8Array() },
  ]);
  const headers = { Authorization: "Bearer token-1" };
  expect(await browserSave({ name: "data.bin", url: `${ORIGIN}/api/attachments?id=1`, headers }, page.env)).toBe("saved");
  expect(page.fetched[0]).toEqual({ url: `${ORIGIN}/api/attachments?id=1`, init: { headers, cache: "no-store" } });
  expect(page.clicked[0].download).toBe("data.bin");
  expect([...new Uint8Array(await page.clicked[0].blob.arrayBuffer())]).toEqual([...bytes]);
  // The link's URL lasts a minute for the browser's download, then goes.
  expect(page.revoked).toEqual([]);
  page.later.forEach((run) => run());
  expect(page.revoked).toEqual([page.clicked[0].href]);
  // An empty file is a download too; a name-less one is "download".
  expect(await browserSave({ name: "", url: `${ORIGIN}/api/attachments?id=2`, headers }, page.env)).toBe("saved");
  expect(page.clicked[1].download).toBe("download");
  expect(page.clicked[1].blob.size).toBe(0);
  await expect(browserSave({ name: "gone.txt", url: `${ORIGIN}/api/attachments?id=3`, headers }, page.env)).rejects.toThrow("HTTP 404");
  expect(page.clicked.length).toBe(2);
});
