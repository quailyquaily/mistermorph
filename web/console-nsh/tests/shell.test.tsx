// The frame: the sidebar's agent switcher, its foldable edge, the phone's bottom navigation with
// its More and agent sheets, and the insecure-connection banner.
import { expect, test } from "nsh/test";
import { LOCAL_REF, localEndpoint, openConsole } from "./harness";

const REMOTE = {
  endpoint_ref: "ep_remote",
  name: "Remote",
  url: "https://agent.example.com",
  connected: true,
  agent_name: "Atlas",
  mode: "console",
  can_submit: true,
  avatar_url: "",
};
const OFFLINE = {
  endpoint_ref: "ep_offline",
  name: "Sleepy",
  url: "https://sleepy.example.com",
  connected: false,
  agent_name: "Sleepy",
  mode: "console",
  can_submit: true,
  avatar_url: "",
};

/** The last location the app wrote to the address bar. */
function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}

test("the agent switcher lists online agents first, switches to one, and opens the overview", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    endpoints: [localEndpoint(), REMOTE, OFFLINE],
    api: { "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:nav-todo");
  // The trigger shows the persona's name from identity.yaml.
  await app.waitFor("id:agent-switcher-trigger >> text:Morph");
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("text:Atlas");
  expect(app.shows("text:Sleepy")).toBe(true);
  expect(app.shows("text:No matching agents")).toBe(false);
  // Offline agents are not selectable.
  await expect(app.press("label:Sleepy")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("label:Atlas");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/ep_remote/todo"));

  await app.press("id:agent-switcher-trigger");
  await app.press("label:Overview");
  await app.waitUntil(() => lastLocation(app) === "/overview");
  // The overview stands alone: no sidebar.
  await app.waitFor("id:sidebar", { state: "gone" });
});

test("more than eight agents open a dialog with a filter", async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    ...REMOTE,
    endpoint_ref: `ep_${index}`,
    agent_name: `Agent ${index}`,
  }));
  const { app } = await openConsole({ location: "/e/default/todo", endpoints: [localEndpoint(), ...many] });
  await app.waitFor("id:nav-todo");
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("id:agent-switcher-filter");
  await app.type("id:agent-switcher-filter", "Agent 7");
  await app.waitFor("id:agent-switcher-dialog >> text:Agent 7");
  expect(app.shows("id:agent-switcher-dialog >> text:Agent 3")).toBe(false);
  await app.clear("id:agent-switcher-filter");
  await app.type("id:agent-switcher-filter", "nobody");
  await app.waitFor("text:No matching agents");
  await app.press("id:agent-switcher-overview");
  await app.waitUntil(() => lastLocation(app) === "/overview");
});

test("dragging the sidebar's edge folds it to its icons, and the choice is remembered", async () => {
  const { app } = await openConsole({ location: "/e/default/todo", api: { "GET /proxy:/tasks": { body: { items: [] } } } });
  await app.waitFor("id:nav-todo >> text:TODO");
  await app.drag("id:sidebar-edge", { x: -120, y: 0 });
  await app.waitFor("id:nav-todo >> text:TODO", { state: "gone" });
  const saved = app.host
    .calls()
    .filter((call) => call.name === "morph.kv.set" && (call.data as any)?.key === "mistermorph.sidebarCollapsed");
  expect((saved.at(-1)?.data as any)?.value).toBe("1");
  // A short drag back that stays nearer the folded width keeps it folded.
  await app.drag("id:sidebar-edge", { x: 30, y: 0 });
  expect(app.shows("id:nav-todo >> text:TODO")).toBe(false);
  await app.drag("id:sidebar-edge", { x: 140, y: 0 });
  await app.waitFor("id:nav-todo >> text:TODO");
});

test("pressing the sidebar's edge toggles it", async () => {
  const { app } = await openConsole({ location: "/e/default/todo", api: { "GET /proxy:/tasks": { body: { items: [] } } } });
  await app.waitFor("id:nav-todo >> text:TODO");
  await app.press("id:sidebar-edge");
  await app.waitFor("id:nav-todo >> text:TODO", { state: "gone" });
  await app.press("id:sidebar-edge");
  await app.waitFor("id:nav-todo >> text:TODO");
});

test("a folded sidebar starts folded", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    kv: { "mistermorph.sidebarCollapsed": "1" },
    api: { "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:nav-todo");
  expect(app.shows("id:nav-todo >> text:TODO")).toBe(false);
});

test("on a phone the bottom navigation opens More and the agents", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    width: 420,
    height: 860,
    endpoints: [localEndpoint(), REMOTE, OFFLINE],
    api: { "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:mobile-bottom-nav");
  expect(app.shows("id:sidebar")).toBe(false);
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more");
  await app.press("id:mobile-more-memories");
  await app.waitFor("id:mobile-more", { state: "gone" });
  await app.waitUntil(() => lastLocation(app) === `/e/default/memories`);
  // On a page kept under More, the More slot says where you are.
  await app.waitFor("label:Memories · More");

  await app.press("id:mobile-nav-agent");
  await app.waitFor("id:mobile-agents");
  await app.keyboard.press("escape");
  await app.waitFor("id:mobile-agents", { state: "gone" });

  await app.press("id:mobile-nav-agent");
  await expect(app.press("id:mobile-agent-option-ep_offline")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("id:mobile-agent-option-ep_remote");
  await app.waitUntil(() => lastLocation(app) === "/e/ep_remote/memories");

  await app.press("id:mobile-nav-agent");
  await app.press("id:mobile-agents-overview");
  await app.waitUntil(() => lastLocation(app) === "/overview");
  // The overview has no bottom navigation.
  await app.waitFor("id:mobile-bottom-nav", { state: "gone" });
});

test("on a 320pt phone every slot of the bottom navigation takes its press", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    width: 320,
    height: 640,
    endpoints: [localEndpoint(), REMOTE],
    api: {
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/todo/tasks": { body: { items: [] } },
      "GET /proxy:/topics": { body: { items: [] } },
    },
  });
  await app.waitFor("id:mobile-bottom-nav");
  await app.press("id:mobile-nav-contacts");
  await app.waitUntil(() => lastLocation(app) === "/e/default/contacts");
  await app.press("id:mobile-nav-chat");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/chat"));
  await app.press("id:mobile-nav-todo");
  await app.waitUntil(() => lastLocation(app) === "/e/default/todo");
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more");
  await app.press("id:mobile-nav-more");
  await app.waitFor("id:mobile-more", { state: "gone" });
  await app.press("id:mobile-nav-agent");
  await app.waitFor("id:mobile-agents");
  await app.press("id:mobile-agent-option-ep_remote");
  await app.waitUntil(() => lastLocation(app) === "/e/ep_remote/todo");
});

test("the banner says which hop is unencrypted, and closing it lasts", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    endpoints: [localEndpoint({ url: "http://10.0.0.9:8080" })],
    api: { "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:insecure-banner");
  // The test page is on plain HTTP too.
  await app.waitFor("text:This page and the runtime at 10.0.0.9:8080 are on plain HTTP. Others on the network can read what you send.");
  await app.press("id:insecure-banner-close");
  await app.waitFor("id:insecure-banner", { state: "gone" });
  await app.press("id:nav-memories");
  await app.waitUntil(() => lastLocation(app) === "/e/default/memories");
  expect(app.shows("id:insecure-banner")).toBe(false);
});

test("an HTTPS page to a loopback runtime shows no banner", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    host: {
      "morph.boot": {
        runtime: "web",
        origin: "https://console.example.com",
        basePath: "/",
        location: "/e/default/todo",
        kv: { "quail-language": "en" },
        session: {},
        languages: ["en-US"],
        desktopVersion: "",
        features: [],
      },
    },
    api: { "GET /proxy:/tasks": { body: { items: [] } } },
  });
  await app.waitFor("id:nav-todo");
  expect(app.shows("id:insecure-banner")).toBe(false);
  expect(LOCAL_REF).toBe("ep_console_local");
});
