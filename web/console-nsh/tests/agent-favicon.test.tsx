// The browser tab's icon (components/frame/AgentFavicon.tsx → morph.favicon): the selected agent's
// avatar, the persona's first and the endpoint's after, "" (the app icon) when it has none; it
// follows agent switches and avatar changes without a reload. The page's drawing of it is
// tests/favicon-host.test.tsx.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { agentFaviconURL } from "../components/frame/AgentFavicon";
import { LOCAL_REF, localEndpoint, openConsole, type ApiRequest } from "./harness";

const AVATAR = { headers: { "content-type": "image/png" }, body: "avatar-bytes" };
const NO_AVATAR = { status: 404, body: { error: "not found" } };
const ENDPOINT_AVATAR = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAwAQCdASoBAAEAAAA=";

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

/** The URLs the app gave morph.favicon, in order ("" = the app icon). */
function favicons(app: App) {
  return app.host
    .calls()
    .filter((call) => call.name === "morph.favicon")
    .map((call) => String((call.data as { url?: string })?.url ?? ""));
}
const lastFavicon = (app: App) => favicons(app).at(-1);

function avatarLoads(calls: ApiRequest[], endpoint: string) {
  return calls.filter((call) => call.path === "/proxy/download" && call.uri === "/persona/avatar" && call.endpoint === endpoint)
    .length;
}

async function switchAgent(app: App, ref: string) {
  await app.press("id:agent-switcher-trigger");
  await app.waitFor("id:agent-switcher-list");
  await app.press(`id:agent-switcher-option-${ref}`);
  await app.waitFor("id:agent-switcher-list", { state: "gone" });
}

test("the persona's avatar counts only while the store holds the selected agent's", () => {
  const pick = (personaEndpointRef: string, endpointAvatarURL = "") =>
    agentFaviconURL({ personaURL: "blob:x/1", personaEndpointRef, selectedRef: "ep_b", endpointAvatarURL });
  expect(pick("ep_b")).toBe("blob:x/1");
  // Just switched, the store still on the previous agent: never its avatar.
  expect(pick("ep_a")).toBe("");
  expect(pick("ep_a", ENDPOINT_AVATAR)).toBe(ENDPOINT_AVATAR);
  expect(agentFaviconURL({ personaURL: " ", personaEndpointRef: "ep_b", selectedRef: "ep_b", endpointAvatarURL: ` ${ENDPOINT_AVATAR} ` })).toBe(
    ENDPOINT_AVATAR,
  );
});

test("the tab shows the selected agent's avatar, the app icon for one without, as the agents switch", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/todo",
    endpoints: [localEndpoint(), REMOTE],
    api: {
      "GET /proxy/download:/persona/avatar": (request) => (request.endpoint === LOCAL_REF ? AVATAR : NO_AVATAR),
    },
  });
  await app.waitFor("id:agent-switcher-trigger >> text:Morph");
  await app.waitUntil(() => Boolean(lastFavicon(app)));
  const local = String(lastFavicon(app));
  // The persona's avatar as the store holds it (an object URL of the downloaded bytes).
  expect(local.startsWith("data:")).toBe(false);
  // Nothing before it but the app icon, and the sidebar and the tab share one download.
  expect(favicons(app).filter((url) => url && url !== local)).toEqual([]);
  expect(avatarLoads(calls, LOCAL_REF)).toBe(1);

  // An agent with no avatar: the app icon, without the previous agent's in between.
  const before = favicons(app).length;
  await switchAgent(app, "ep_remote");
  await app.waitUntil(() => avatarLoads(calls, "ep_remote") === 1);
  await app.waitUntil(() => lastFavicon(app) === "");
  expect(favicons(app).slice(before).filter(Boolean)).toEqual([]);

  // Back: the local agent's avatar again (loaded anew; the old URL was let go).
  await switchAgent(app, LOCAL_REF);
  await app.waitUntil(() => avatarLoads(calls, LOCAL_REF) === 2);
  await app.waitUntil(() => Boolean(lastFavicon(app)));
  expect(lastFavicon(app)).not.toBe(local);
  expect(String(lastFavicon(app)).startsWith("data:")).toBe(false);
});

test("an agent without a persona avatar shows its endpoint's avatar, as the switcher does", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    endpoints: [localEndpoint(), { ...REMOTE, avatar_url: ENDPOINT_AVATAR }],
    api: { "GET /proxy/download:/persona/avatar": NO_AVATAR },
  });
  await app.waitFor("id:agent-switcher-trigger >> text:Morph");
  await switchAgent(app, "ep_remote");
  await app.waitUntil(() => lastFavicon(app) === ENDPOINT_AVATAR);
  await switchAgent(app, LOCAL_REF);
  await app.waitUntil(() => lastFavicon(app) === "");
});

test("deleting the avatar in the persona settings puts the app icon back without a reload", async () => {
  // (Replacing one needs the adjust dialog to load the picked image, which headless runs cannot:
  // the same event reloads the avatar, checked in the browser.)
  let hasAvatar = true;
  const { app, calls } = await openConsole({
    location: "/e/default/settings/persona",
    api: {
      "GET /proxy/download:/persona/avatar": () => (hasAvatar ? AVATAR : NO_AVATAR),
      "DELETE /proxy:/persona/avatar": () => {
        hasAvatar = false;
        return { body: { ok: true } };
      },
    },
  });
  await app.waitFor("id:settings-persona");
  await app.waitUntil(() => Boolean(lastFavicon(app)));
  const loads = avatarLoads(calls, LOCAL_REF);

  await app.press("id:settings-persona-avatar >> id:image-upload-preview");
  await app.waitFor("id:image-upload-dialog");
  await app.press("id:image-upload-delete");
  await app.waitUntil(() => calls.some((call) => call.method === "DELETE" && call.uri === "/persona/avatar"));
  await app.waitUntil(() => lastFavicon(app) === "");
  // The avatar event reloads it once for the whole frame (the sidebar's switcher and the tab).
  expect(avatarLoads(calls, LOCAL_REF)).toBe(loads + 1);
});

test("the desktop app and the phone app keep their own icons: no morph.favicon", async () => {
  const desktop = await openConsole({
    location: "/e/default/todo",
    runtime: "desktop",
    api: { "GET /proxy/download:/persona/avatar": AVATAR },
  });
  await desktop.app.waitFor("id:agent-switcher-trigger >> text:Morph");
  await desktop.app.waitUntil(() => avatarLoads(desktop.calls, LOCAL_REF) === 1);
  expect(favicons(desktop.app)).toEqual([]);

  const phone = await openConsole({
    platform: "android",
    location: "/e/default/todo",
    api: { "GET /proxy/download:/persona/avatar": AVATAR },
    host: { "morph.favicon": null },
  });
  await phone.app.waitFor("id:mobile-nav-todo");
  await phone.app.waitUntil(() => avatarLoads(phone.calls, LOCAL_REF) === 1);
  expect(favicons(phone.app)).toEqual([]);
});

test("the login page shows the app icon; the agent's avatar comes once the frame does", async () => {
  const { app } = await openConsole({
    location: "/e/default/todo",
    password: true,
    api: { "GET /proxy/download:/persona/avatar": AVATAR },
  });
  await app.waitFor("id:login-password");
  expect(favicons(app).filter(Boolean)).toEqual([]);
  await app.type("id:login-password", "secret");
  await app.press("role:button[Login]");
  await app.waitFor("id:nav-todo");
  await app.waitUntil(() => Boolean(lastFavicon(app)));
});
