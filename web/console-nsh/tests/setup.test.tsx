// First-run setup: the model, the persona, the soul and done, each a route; where a fresh console
// starts; and what it says when a request fails.
import { expect, test } from "nsh/test";
import type { ApiRequest } from "./harness";
import { localEndpoint, openConsole } from "./harness";

/** The last location the app wrote to the address bar. */
function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}

const STATE_FILES = (names: string[]) => ({
  body: { items: names.map((name) => ({ name, exists: true, path: `/state/${name}`, group: "persona" })) },
});

/** A console that has no model yet: the agent cannot take chats until setup saves one. */
function freshConsole(extra: Record<string, any> = {}) {
  const state = {
    configured: false,
    identity: "",
    soul: "",
    savedLLM: null as any,
  };
  const api: Record<string, any> = {
    "GET /endpoints": () => ({ body: { items: [localEndpoint({ can_submit: state.configured })] } }),
    "GET /settings/agent": { body: { config_source: "defaults", config_revision: "rev-1", llm: {}, tools: {} } },
    "PUT /settings/agent": (request: ApiRequest) => {
      state.savedLLM = request.json;
      state.configured = true;
      return { body: { config_source: "config", config_revision: "rev-2", llm: request.json?.llm || {}, tools: {} } };
    },
    "GET /proxy:/state/files": () =>
      STATE_FILES([...(state.identity ? ["identity.yaml"] : []), ...(state.soul ? ["soul.md"] : []), "HEARTBEAT.md", "cron.yaml"]),
    "GET /proxy:/persona/files/identity.yaml": () =>
      state.identity ? { body: { content: state.identity } } : { status: 404, body: { error: "not found" } },
    "PUT /proxy:/persona/files/identity.yaml": (request: ApiRequest) => {
      state.identity = String(request.json?.content || "");
      return { body: {} };
    },
    "GET /proxy:/persona/files/soul.md": () =>
      state.soul ? { body: { content: state.soul } } : { status: 404, body: { error: "not found" } },
    "PUT /proxy:/persona/files/soul.md": (request: ApiRequest) => {
      state.soul = String(request.json?.content || "");
      return { body: {} };
    },
    "GET /proxy:/persona/avatar": { status: 404, body: { error: "not found" } },
    "GET /proxy:/topics": { body: { items: [] } },
    ...extra,
  };
  return { state, api };
}

test("a fresh console walks through the model, the persona and the soul, then opens chat", async () => {
  const { state, api } = freshConsole();
  const { app, calls } = await openConsole({ location: "/", api });
  // Nothing can chat yet: setup starts at the model.
  await app.waitFor("id:setup-stage-llm");
  expect(lastLocation(app).startsWith("/e/default/setup/llm")).toBe(true);
  await app.waitFor("text:/setup // step 1/i");
  expect(app.enabled("id:setup-submit")).toBe(false);

  await app.type("id:setup-endpoint", "https://api.example.com/v1");
  await app.type("id:setup-api-key-input", "sk-test");
  await app.type("id:setup-model", "gpt-test");
  await app.waitUntil(() => app.enabled("id:setup-submit"));
  await app.press("id:setup-submit");

  await app.waitFor("id:setup-stage-persona");
  expect(state.savedLLM?.config_revision).toBe("rev-1");
  expect(state.savedLLM?.llm?.model).toBe("gpt-test");
  expect(state.savedLLM?.llm?.endpoint).toBe("https://api.example.com/v1");
  expect(state.savedLLM?.llm?.api_key).toBe("sk-test");
  expect(lastLocation(app).startsWith("/e/default/setup/persona")).toBe(true);

  // The name is required; the dice fill in a random persona.
  expect(app.enabled("id:setup-submit")).toBe(false);
  await app.press("id:setup-persona-random");
  await app.waitUntil(() => (app.value("id:setup-persona-name") || "") !== "");
  await app.clear("id:setup-persona-name");
  await app.type("id:setup-persona-name", "Nova");
  await app.press("id:setup-submit");

  await app.waitFor("id:setup-stage-soul");
  expect(state.identity).toContain("Nova");
  // A preset must be chosen before Finish shows.
  expect(app.shows("id:setup-submit")).toBe(false);
  await app.press("id:setup-soul-cat");
  await app.waitFor("id:setup-soul-spotlight");
  await app.press("id:setup-submit");

  await app.waitFor("id:setup-stage-done");
  expect(state.soul.length).toBeGreaterThan(10);
  await app.waitFor("text:/Nova/");
  await app.press("id:setup-enter-chat");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/chat"));
  expect(calls.some((call) => call.method === "PUT" && call.path === "/settings/agent")).toBe(true);
});

test("a console with a model but no identity starts at the persona, and Previous goes back", async () => {
  const { state, api } = freshConsole();
  state.configured = true;
  const { app } = await openConsole({ location: "/e/default/setup", api });
  await app.waitFor("id:setup-stage-persona");
  expect(lastLocation(app).startsWith("/e/default/setup/persona")).toBe(true);
  await app.press("id:setup-previous");
  await app.waitFor("id:setup-stage-llm");
});

test("a failed save says why and stays on the step", async () => {
  const { api } = freshConsole({
    "PUT /settings/agent": { status: 500, body: { error: "disk full" } },
  });
  const { app } = await openConsole({ location: "/e/default/setup/llm", api });
  await app.waitFor("id:setup-stage-llm");
  await app.type("id:setup-endpoint", "https://api.example.com/v1");
  await app.type("id:setup-api-key-input", "sk-test");
  await app.type("id:setup-model", "gpt-test");
  await app.waitUntil(() => app.enabled("id:setup-submit"));
  await app.press("id:setup-submit");
  await app.waitFor("text:disk full");
  expect(app.shows("id:setup-stage-llm")).toBe(true);
});

test("a settings load that fails shows the error on the form", async () => {
  const { api } = freshConsole({
    "GET /settings/agent": { status: 500, body: { error: "config unreadable" } },
  });
  const { app } = await openConsole({ location: "/e/default/setup/llm", api });
  await app.waitFor("id:setup-error >> text:config unreadable");
});

test("the model picker lists the provider's models and fills the field", async () => {
  const { api } = freshConsole({
    "POST /settings/agent/models": { body: { models: [{ id: "alpha-1" }, { id: "beta-2" }] } },
  });
  const { app, calls } = await openConsole({ location: "/e/default/setup/llm", api });
  await app.waitFor("id:setup-stage-llm");
  expect(app.enabled("id:setup-model-picker")).toBe(false);
  await app.type("id:setup-endpoint", "https://api.example.com/v1");
  await app.type("id:setup-api-key-input", "sk-test");
  await app.waitUntil(() => app.enabled("id:setup-model-picker"));
  await app.press("id:setup-model-picker");
  await app.waitUntil(() => calls.some((call) => call.path === "/settings/agent/models"));
  const request = calls.find((call) => call.path === "/settings/agent/models");
  expect(request?.json?.api_key).toBe("sk-test");
  expect(request?.json?.endpoint).toBe("https://api.example.com/v1");
  await app.press("text:beta-2");
  await app.waitUntil(() => app.value("id:setup-model") === "beta-2");
});

test("the connection test sends the form and shows a failure", async () => {
  const { api } = freshConsole({
    "POST /settings/agent/test": { status: 502, body: { error: "upstream refused" } },
  });
  const { app, calls } = await openConsole({ location: "/e/default/setup/llm", api });
  await app.waitFor("id:setup-stage-llm");
  await app.type("id:setup-endpoint", "https://api.example.com/v1");
  await app.type("id:setup-api-key-input", "sk-test");
  await app.type("id:setup-model", "gpt-test");
  await app.waitUntil(() => app.enabled("id:setup-test-connection"));
  await app.press("id:setup-test-connection");
  await app.waitUntil(() => calls.some((call) => call.path === "/settings/agent/test"));
  const request = calls.find((call) => call.path === "/settings/agent/test");
  expect(request?.json?.llm?.model).toBe("gpt-test");
  await app.waitFor("text:upstream refused");
});

test("a repair from troubleshooting saves one step and goes back to setup", async () => {
  const { state, api } = freshConsole();
  state.configured = true;
  state.identity = "name: Old\n";
  state.soul = "# Soul\n";
  const { app } = await openConsole({ location: "/e/default/setup/persona?repair=identity", api });
  await app.waitFor("id:setup-stage-persona");
  await app.waitUntil(() => app.value("id:setup-persona-name") === "Old");
  // A repair has no Previous.
  expect(app.shows("id:setup-previous")).toBe(false);
  await app.clear("id:setup-persona-name");
  await app.type("id:setup-persona-name", "Fixed");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-done");
  expect(state.identity).toContain("Fixed");
});
