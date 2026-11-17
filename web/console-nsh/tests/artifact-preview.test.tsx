// Artifact previews (components/chat/ArtifactPreviewCard.tsx). The console server answers a preview
// ticket with the page's path on the console (`/api/artifacts/preview/<ticket>/<file>`); nsh refuses
// a web view's URL without a host (ERR_ACCESS_DENIED), and the card ignored the refusal, so the
// preview was an empty box (in the phone app, and on every other platform). Now the path is made
// absolute on the console's origin, the card says it loads until the page has loaded, and a page
// that fails (or that the app refuses) says why, with a retry.
//
// The fixture runs the real card on stand-in tickets; headless runs load no pages, so the web
// view's load reports are played by buttons there. The console tests below go through the whole
// chat, where a refusal is nsh's own.
import { expect, open, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";
import { resolveConsoleURL } from "../lib/core/context.js";

const PHONE = { width: 390, height: 844, platform: "android" as const, locale: "en-US" };
const PAGE_URL = "http://console.test/api/artifacts/preview/tk-1/hello-world-20261117-185430.html";

const frames = (app: { texts(): string[] }) =>
  JSON.parse(app.texts().find((text) => text.startsWith("frames="))!.slice("frames=".length)) as Record<string, { x: number; y: number; w: number; h: number }>;

async function openCard() {
  const app = await open("./fixtures/artifact-preview-app.tsx", PHONE);
  // The latest reply's artifact asks for its ticket by itself.
  await app.waitUntil(() => app.texts().includes("tickets=1"));
  return app;
}

test("the server's preview path becomes a URL on the console", () => {
  expect(resolveConsoleURL("http://192.168.1.20:9080", "/api/artifacts/preview/tk/hello.html")).toBe("http://192.168.1.20:9080/api/artifacts/preview/tk/hello.html");
  // A console under a base path: the server's path already has it.
  expect(resolveConsoleURL("https://box.example/", "/console/api/artifacts/preview/tk/site/index.html")).toBe("https://box.example/console/api/artifacts/preview/tk/site/index.html");
  // Escaped names stay escaped once.
  expect(resolveConsoleURL("http://h:1", "/api/artifacts/preview/tk/my%20page.html")).toBe("http://h:1/api/artifacts/preview/tk/my%20page.html");
  // A URL with a scheme stays as it is; without an origin there is nothing to resolve against.
  expect(resolveConsoleURL("http://h:1", "https://cdn.example/x.html")).toBe("https://cdn.example/x.html");
  expect(resolveConsoleURL("", "/api/artifacts/preview/tk/a.html")).toBe("/api/artifacts/preview/tk/a.html");
  expect(resolveConsoleURL("http://h:1", "")).toBe("");
});

test("the first opening says it loads, then shows the page in a sized frame", async () => {
  const app = await openCard();
  // The ticket is on its way: the frame is there, saying so.
  await app.waitFor("id:chat-artifact-loading");
  expect(app.count("id:chat-artifact-web")).toBe(0);
  expect(app.shows("Loading preview…")).toBe(true);

  await app.press("id:ticket-ok");
  // The web view gets the page's URL on the console, not the bare path.
  await app.waitFor("id:chat-artifact-web");
  expect(app.texts()).toContain(`entry=${PAGE_URL}`);
  expect(app.texts()).toContain("page=loading");
  expect(app.shows("id:chat-artifact-loading")).toBe(true);
  await app.waitUntil(() => !!frames(app)["chat-artifact-frame"]);
  const frame = frames(app)["chat-artifact-frame"];
  expect(frame.h).toBe(384);
  expect(frame.w).toBeGreaterThan(300);

  await app.press("id:page-load");
  expect(app.texts()).toContain("page=loaded");
  expect(app.count("id:chat-artifact-loading")).toBe(0);
  expect(app.count("id:chat-artifact-failed")).toBe(0);
  expect(app.count("id:chat-artifact-web")).toBe(1);
});

test("full screen shows the page in a frame of the window's size, loading again there", async () => {
  const app = await openCard();
  await app.press("id:ticket-ok");
  await app.press("id:page-load");
  await app.press("label:Fullscreen preview");
  await app.waitFor("id:chat-artifact-fullscreen-web");
  expect(app.count("id:chat-artifact-web")).toBe(0);
  expect(app.texts()).toContain("page=loading");
  expect(app.shows("id:chat-artifact-fullscreen-loading")).toBe(true);
  await app.waitUntil(() => !!frames(app)["chat-artifact-fullscreen-frame"]);
  const full = frames(app)["chat-artifact-fullscreen-frame"];
  expect(full.h).toBeGreaterThan(600);
  expect(full.w).toBeGreaterThan(300);

  await app.press("id:chat-artifact-fullscreen-dialog-close");
  await app.waitFor("id:chat-artifact-web");
  // The dialog's web view goes with the dialog, once it has gone out.
  await app.waitUntil(() => app.count("id:chat-artifact-fullscreen-web") === 0);
  expect(app.texts()).toContain("page=loading");
  // The same ticket: nothing asked again.
  expect(app.texts()).toContain("tickets=1");
});

test("a page that fails says why instead of a blank box, and retries with a new ticket", async () => {
  const app = await openCard();
  await app.press("id:ticket-ok");
  await app.press("id:page-fail");
  await app.waitFor("id:chat-artifact-failed");
  expect(app.shows("The preview could not be shown. net::ERR_CONNECTION_REFUSED")).toBe(true);
  expect(app.count("id:chat-artifact-web")).toBe(0);
  expect(app.count("id:chat-artifact-loading")).toBe(0);
  // A web view finishes its own error page after the error: that is no page of the artifact.
  await app.press("id:page-load");
  expect(app.texts()).toContain("page=failed");
  expect(app.count("id:chat-artifact-failed")).toBe(1);

  await app.press("id:chat-artifact-retry");
  expect(app.texts()).toContain("tickets=2");
  await app.waitFor("id:chat-artifact-loading");
  await app.press("id:ticket-ok");
  await app.waitFor("id:chat-artifact-web");
  expect(app.texts()).toContain(`entry=${PAGE_URL.replace("tk-1", "tk-2")}`);
  expect(app.count("id:chat-artifact-failed")).toBe(0);
  expect(app.shows("id:chat-artifact-loading")).toBe(true);
});

test("a platform without web views says so", async () => {
  const app = await openCard();
  await app.press("id:ticket-ok");
  await app.press("id:page-unsupported");
  await app.waitFor("Web previews cannot be shown on this device.");
  expect(app.count("id:chat-artifact-web")).toBe(0);
});

test("a ticket that fails says why, and no empty frame stays", async () => {
  const app = await openCard();
  await app.press("id:ticket-fail");
  await app.waitFor("invalid dir_name");
  expect(app.count("id:chat-artifact-frame")).toBe(0);
  expect(app.count("id:chat-artifact-loading")).toBe(0);
});

/* ---------- the whole chat ---------- */

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Project", created_at: NOW, updated_at: NOW }] } };
const ARTIFACT_REPLY = ["Here it is:", "", "```artifact", "dir_name=file_cache_dir", "path=hello-world-20261117-185430.html", "```"].join("\n");
const DONE = { id: "t1", task: "Make a Hello World page", topic_id: "topic-1", status: "done", created_at: NOW, finished_at: NOW, result: { final: { output: ARTIFACT_REPLY } } };

function listOf(...items: unknown[]) {
  return (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items } } : { body: { items: [] } });
}

/** As the console server answers: the page's path on the console, with a new ticket each time. */
function tickets(entry: (n: number) => string) {
  let n = 0;
  return () => {
    n += 1;
    return { body: { ticket: `tk-${n}`, entry_url: entry(n), expires_at: new Date(Date.now() + 300000).toISOString() } };
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

for (const phone of [true, false]) {
  test(`the server's preview path shows the page ${phone ? "in the phone app" : "in the browser"}`, async () => {
    const { app, calls } = await openConsole({
      location: "/e/default/chat/topic-1",
      ...(phone ? { platform: "android" as const, width: 390, height: 844 } : {}),
      api: {
        "GET /proxy:/topics": TOPICS,
        "GET /proxy:/tasks": listOf(DONE),
        "POST /artifacts/preview-ticket": tickets((n) => `/api/artifacts/preview/tk-${n}/hello-world-20261117-185430.html`),
      },
    });
    await app.waitFor("id:chat-artifact");
    await app.waitUntil(() => calls.some((call) => call.path === "/artifacts/preview-ticket"));
    await app.waitFor("id:chat-artifact-web");
    await settle();
    // nsh took the URL: no refusal, and the card waits for the page (headless runs load none).
    expect(app.count("id:chat-artifact-failed")).toBe(0);
    expect(app.shows("id:chat-artifact-loading")).toBe(true);
    expect(app.count("id:chat-artifact-web")).toBe(1);
  });
}

test("a preview URL the app may not show says so, and retries", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/chat/topic-1",
    platform: "android",
    width: 390,
    height: 844,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(DONE),
      // nsh refuses a web view's file: URL (ERR_ACCESS_DENIED): the card hears it from the web view.
      "POST /artifacts/preview-ticket": tickets((n) => (n === 1 ? "file:///etc/hosts" : `/api/artifacts/preview/tk-${n}/hello-world-20261117-185430.html`)),
    },
  });
  await app.waitFor("id:chat-artifact-failed");
  expect(app.shows("id:chat-artifact-failed >> text:/^The preview could not be shown\\. .*not granted/")).toBe(true);
  expect(app.count("id:chat-artifact-web")).toBe(0);
  await app.press("id:chat-artifact-retry");
  await app.waitUntil(() => calls.filter((call) => call.path === "/artifacts/preview-ticket").length === 2);
  await app.waitFor("id:chat-artifact-web");
  await settle();
  expect(app.count("id:chat-artifact-failed")).toBe(0);
});
