// The Tools page's agent name set: below every tool's own settings, saved with them through
// /settings/agent, kept across a reload, the scientists for an unknown stored value, the draft
// kept when a save fails, and hidden for a runtime that does not report one.
import { expect, test } from "nsh/test";
import { type ApiHandler, openConsole } from "./harness";

function agentSettings(tools: Record<string, unknown> = {}) {
  return {
    config_revision: "rev-1",
    config_path: "/state/config.yaml",
    llm: { inference_provider: "openai", model: "gpt-5.2", current_profile: "", profiles: [], fallback_profiles: [] },
    tools: { write_file: { enabled: true }, bash: { enabled: true }, web_search: { enabled: false }, ...tools },
    mcp: { servers: [] },
    config_values: {},
    field_states: {},
  };
}

function open(api: Record<string, ApiHandler>) {
  return openConsole({ location: "/e/default/settings/tools", api });
}

// The examples line, read from the screen's texts.
function examples(app: { texts(): string[] }) {
  return app.texts().find((text) => /^(For example|例如)/.test(text)) ?? "";
}

test("the name set sits below the tools, saves with them and survives a reload", async () => {
  // The runtime's stored value, as the PUT handler writes it.
  let stored = "scientists";
  let body: any = null;
  const api: Record<string, ApiHandler> = {
    "GET /settings/agent": () => ({ body: agentSettings({ agent_name_set: stored }) }),
    "PUT /settings/agent": (request) => {
      body = request.json;
      stored = body.tools.agent_name_set;
      return { body: agentSettings({ agent_name_set: stored }) };
    },
  };
  const { app } = await open(api);
  await app.waitFor("id:settings-agent-name-set");
  // Below the last tool group, above the channel tools.
  const texts = app.texts();
  const at = (text: string) => texts.indexOf(text);
  expect(at("Agent name set")).toBeGreaterThan(at("image_edit"));
  expect(at("Agent name set")).toBeGreaterThan(at("coder"));
  expect(at("Agent name set")).toBeLessThan(texts.findIndex((text) => /channel tools/i.test(text)));
  expect(app.shows("text:Great scientists")).toBe(true);
  expect(examples(app)).toBe("For example: Einstein, Curie, Newton, Darwin");
  expect(app.shows("text:/applies to new subagent and coder sessions/i")).toBe(true);
  expect(app.shows("id:settings-save-bar")).toBe(false);

  // All three sets are offered.
  await app.press("label:Agent name set");
  for (const title of ["Great scientists", "Great musicians", "Great artists"]) {
    expect(app.shows(`text:${title}`)).toBe(true);
  }
  await app.press("text:Great musicians");
  await app.waitUntil(() => examples(app) === "For example: Bach, Mozart, Beethoven, Chopin");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => body !== null);
  expect(body.config_revision).toBe("rev-1");
  expect(body.tools.agent_name_set).toBe("musicians");
  // The tool switches go with it, unchanged.
  expect(body.tools.bash).toEqual({ enabled: true });
  expect(body.tools.web_search).toEqual({ enabled: false });
  expect(body.llm).toBeUndefined();
  await app.waitFor("id:settings-save-bar", { state: "gone" });

  // A reload reads the saved set back.
  const { app: reloaded } = await open(api);
  await reloaded.waitFor("id:settings-agent-name-set");
  await reloaded.waitUntil(() => examples(reloaded) === "For example: Bach, Mozart, Beethoven, Chopin");
  expect(reloaded.shows("text:Great musicians")).toBe(true);
  expect(reloaded.shows("id:settings-save-bar")).toBe(false);
});

test("picking the saved set again leaves nothing to save", async () => {
  const { app } = await open({ "GET /settings/agent": { body: agentSettings({ agent_name_set: "artists" }) } });
  await app.waitFor("id:settings-agent-name-set");
  expect(examples(app)).toBe("For example: Leonardo, Michelangelo, Raphael, Rembrandt");
  await app.press("label:Agent name set");
  await app.press("text:Great scientists");
  await app.waitFor("id:settings-save-bar");
  await app.press("label:Agent name set");
  await app.press("text:Great artists");
  await app.waitFor("id:settings-save-bar", { state: "gone" });
});

test("an unknown stored set shows as the scientists", async () => {
  const { app } = await open({ "GET /settings/agent": { body: agentSettings({ agent_name_set: "poets" }) } });
  await app.waitFor("id:settings-agent-name-set");
  expect(app.shows("text:Great scientists")).toBe(true);
  expect(examples(app)).toBe("For example: Einstein, Curie, Newton, Darwin");
  expect(app.shows("id:settings-save-bar")).toBe(false);
});

test("a failed save shows the error and keeps the picked set", async () => {
  const { app } = await open({
    "GET /settings/agent": { body: agentSettings({ agent_name_set: "scientists" }) },
    "PUT /settings/agent": { status: 500, body: { error: "disk full" } },
  });
  await app.waitFor("id:settings-agent-name-set");
  await app.press("label:Agent name set");
  await app.press("text:Great artists");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-save-bar-save");
  await app.waitFor("id:settings-save-bar-failed");
  expect(app.shows("text:/disk full/")).toBe(true);
  expect(app.shows("text:Great artists")).toBe(true);
  expect(examples(app)).toBe("For example: Leonardo, Michelangelo, Raphael, Rembrandt");
});

test("the examples follow the Console language", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/tools",
    kv: { "quail-language": "zh" },
    api: { "GET /settings/agent": { body: agentSettings({ agent_name_set: "musicians" }) } },
  });
  await app.waitFor("id:settings-agent-name-set");
  await app.waitUntil(() => examples(app) === "例如：巴赫、莫扎特、贝多芬、肖邦");
  expect(app.shows("text:伟大的音乐家")).toBe(true);
});

test("a runtime that reports no name set shows no control and is sent none", async () => {
  let body: any = null;
  const { app } = await open({
    "GET /settings/agent": { body: agentSettings() },
    "PUT /settings/agent": (request) => {
      body = request.json;
      return { body: agentSettings() };
    },
  });
  await app.waitFor("id:settings-tool-web_search");
  expect(app.shows("id:settings-agent-name-set")).toBe(false);
  await app.press("id:settings-tool-web_search-switch");
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => body !== null);
  expect(body.tools.web_search).toEqual({ enabled: true });
  expect("agent_name_set" in body.tools).toBe(false);
});
