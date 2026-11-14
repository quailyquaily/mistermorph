// The Tools page's Load skills switch (skills.enabled): under the tools, saved with them through
// /settings/agent as `skills.enabled` alone (the skills to load are the Skills page's), read back
// on a reload, and hidden for a runtime that does not report it.
import { expect, test } from "nsh/test";
import { type ApiHandler, openConsole } from "./harness";

function agentSettings(skills?: { enabled: boolean }) {
  return {
    config_revision: "rev-1",
    config_path: "/state/config.yaml",
    llm: { inference_provider: "openai", model: "gpt-5.2", current_profile: "", profiles: [], fallback_profiles: [] },
    tools: { write_file: { enabled: true }, bash: { enabled: true }, agent_name_set: "scientists" },
    ...(skills ? { skills: { ...skills, load: ["weather"], loaded: [], available: [] } } : {}),
    mcp: { servers: [] },
    config_values: {},
    field_states: {},
  };
}

function open(api: Record<string, ApiHandler>) {
  return openConsole({ location: "/e/default/settings/tools", api });
}

test("Load skills sits under the tools, saves with them as skills.enabled alone, and survives a reload", async () => {
  let enabled = true;
  let body: any = null;
  const api: Record<string, ApiHandler> = {
    "GET /settings/agent": () => ({ body: agentSettings({ enabled }) }),
    "PUT /settings/agent": (request) => {
      body = request.json;
      enabled = body.skills.enabled;
      return { body: agentSettings({ enabled }) };
    },
  };
  const { app } = await open(api);
  await app.waitFor("id:settings-skills-enabled");
  const texts = app.texts();
  expect(texts.indexOf("Load skills")).toBeGreaterThan(texts.indexOf("image_edit"));
  expect(app.shows("text:When off, the agent loads no skills unless a task names one with $name.")).toBe(true);
  expect(app.shows("id:settings-save-bar")).toBe(false);

  await app.press("label:Load skills");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => body !== null);
  expect(body.skills).toEqual({ enabled: false });
  expect(body.tools.bash).toEqual({ enabled: true });
  expect(body.llm).toBeUndefined();
  await app.waitFor("id:settings-save-bar", { state: "gone" });

  const { app: reloaded } = await open(api);
  await reloaded.waitFor("id:settings-skills-enabled");
  expect(enabled).toBe(false);
  expect(reloaded.shows("id:settings-save-bar")).toBe(false);
});

test("a runtime that reports no skills settings shows no Load skills and is sent none", async () => {
  let body: any = null;
  const { app } = await open({
    "GET /settings/agent": { body: agentSettings() },
    "PUT /settings/agent": (request) => {
      body = request.json;
      return { body: agentSettings() };
    },
  });
  await app.waitFor("id:settings-agent-name-set");
  expect(app.shows("id:settings-skills-enabled")).toBe(false);
  await app.press("label:bash");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => body !== null);
  expect(body.skills).toBeUndefined();
});
