// SKILLs & MCP (the `mcp` section, still /settings/mcp): the section list and the page's head say
// "SKILLs & MCP", as written, in every language. The Load skills switch (skills.enabled) is there,
// once, and no longer on the Tools page. It is a draft the page's save bar saves through
// /settings/agent as `skills.enabled` alone; the MCP servers keep saving from their own pane, as
// `mcp` alone, and neither save drops the other's draft.
import { expect, test } from "nsh/test";
import { type ApiHandler, openConsole } from "./harness";

const TITLE = "SKILLs & MCP";
const GITHUB = { name: "github", enable: true, type: "http", url: "https://mcp.github.example/mcp", headers: {} };

function agentSettings(options: { skills?: { enabled: boolean }; servers?: unknown[]; readOnly?: boolean } = {}) {
  return {
    config_revision: "rev-1",
    config_path: "/state/config.yaml",
    ...(options.readOnly ? { read_only: true, read_only_reason: "Managed by the host." } : {}),
    llm: { inference_provider: "openai", model: "gpt-5.2", current_profile: "", profiles: [], fallback_profiles: [] },
    tools: { write_file: { enabled: true }, bash: { enabled: true }, agent_name_set: "scientists" },
    ...(options.skills ? { skills: { ...options.skills, load: ["weather"], loaded: [], available: [] } } : {}),
    mcp: { servers: options.servers ?? [] },
    config_values: {},
    field_states: {},
  };
}

/** A runtime that keeps what is saved to it: skills.enabled and the MCP servers; every PUT body. */
function runtime(initial: { enabled?: boolean; servers?: unknown[]; readOnly?: boolean; failSkills?: boolean } = {}) {
  const saved = { enabled: initial.enabled ?? true, servers: initial.servers ?? [] };
  const puts: any[] = [];
  const current = () => agentSettings({ skills: { enabled: saved.enabled }, servers: saved.servers, readOnly: initial.readOnly });
  const api: Record<string, ApiHandler> = {
    "GET /settings/agent": () => ({ body: current() }),
    "PUT /settings/agent": (request) => {
      const body = request.json;
      puts.push(body);
      if (body.skills && initial.failSkills) return { status: 500, body: { error: "config unwritable" } };
      if (body.skills) saved.enabled = body.skills.enabled;
      if (body.mcp) saved.servers = body.mcp.servers;
      return { body: current() };
    },
  };
  return { api, puts, saved };
}

/** The save bar's list of unsaved parts: the texts after its count. */
function unsaved(app: { texts(): string[] }) {
  const texts = app.texts();
  const at = texts.findIndex((text) => text.startsWith("Unsaved changes ("));
  return at < 0 ? [] : texts.slice(at + 1, texts.lastIndexOf("Save"));
}

const open = (api: Record<string, ApiHandler>, location = "/e/default/settings/mcp", kv?: Record<string, string>) =>
  openConsole({ location, api, kv });

for (const lang of ["en", "zh", "ja"]) {
  test(`${lang}: the section list and the page's head say ${TITLE}, as written`, async () => {
    const { app } = await open(runtime().api, "/e/default/settings/mcp", { "quail-language": lang });
    await app.waitFor("id:settings-skills-enabled");
    expect(app.shows(`id:settings-section-mcp >> text:${TITLE}`)).toBe(true);
    expect(app.shows(`label:${TITLE}`)).toBe(true);
    // The card's head, in its own case rather than the heads' caps.
    expect(app.shows(`id:settings-mcp >> text:${TITLE}`)).toBe(true);
    expect(app.shows("text:SKILLS & MCP")).toBe(false);
    expect(app.shows("text:MCP")).toBe(false);
  });
}

test("the page's own parts keep their names: Skills with Load skills, then MCP servers", async () => {
  const { app } = await open(runtime().api);
  await app.waitFor("id:settings-skills-enabled");
  expect(app.count("id:settings-skills-enabled")).toBe(1);
  expect(app.count("label:Load skills")).toBe(1);
  expect(app.shows("text:Whether skills load, and external tools from local or remote MCP servers.")).toBe(true);
  expect(app.shows("text:When off, the agent loads no skills unless a task names one with $name.")).toBe(true);
  const texts = app.texts();
  const at = (text: string) => texts.indexOf(text);
  expect(at(TITLE)).toBeGreaterThan(-1);
  expect(at("SKILLS")).toBeGreaterThan(at(TITLE));
  expect(at("Load skills")).toBeGreaterThan(at("SKILLS"));
  expect(at("MCP SERVERS")).toBeGreaterThan(at("Load skills"));
  expect(at("No MCP servers")).toBeGreaterThan(at("MCP SERVERS"));
  // The add button sits in the servers' head now.
  expect(app.shows("id:mcp-servers-head >> id:mcp-add")).toBe(true);
  expect(app.shows("id:settings-save-bar")).toBe(false);
});

test("the Tools page keeps its tools and the name set, and has no Load skills", async () => {
  const { app } = await open(runtime().api, "/e/default/settings/tools");
  await app.waitFor("id:settings-agent-name-set");
  expect(app.shows("label:bash")).toBe(true);
  expect(app.shows("id:settings-tool-matrix")).toBe(true);
  expect(app.shows("id:settings-skills-enabled")).toBe(false);
  expect(app.shows("label:Load skills")).toBe(false);

  // A tool switch still saves the tools, and only them.
  const rt = runtime();
  const { app: tools } = await open(rt.api, "/e/default/settings/tools");
  await tools.waitFor("id:settings-agent-name-set");
  await tools.press("label:bash");
  await tools.waitFor("id:settings-save-bar");
  await tools.press("id:settings-save-bar-save");
  await tools.waitUntil(() => rt.puts.length === 1);
  expect(rt.puts[0].tools.bash).toEqual({ enabled: false });
  expect(rt.puts[0].skills).toBeUndefined();
  expect(rt.puts[0].mcp).toBeUndefined();
});

test("Load skills off: the save bar sends skills.enabled alone, and a reload shows it off", async () => {
  const rt = runtime({ enabled: true, servers: [GITHUB] });
  const { app } = await open(rt.api);
  await app.waitFor("id:settings-skills-enabled");
  await app.press("label:Load skills");
  await app.waitFor("id:settings-save-bar");
  expect(unsaved(app)).toEqual(["Load skills"]);
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => rt.puts.length === 1);
  expect(rt.puts[0]).toEqual({ config_revision: "rev-1", skills: { enabled: false } });
  await app.waitFor("id:settings-save-bar", { state: "gone" });
  expect(rt.saved.enabled).toBe(false);
  expect(rt.saved.servers).toEqual([GITHUB]);

  // Loaded off, one press turns it on: what was saved is what shows.
  const { app: reloaded } = await open(rt.api);
  await reloaded.waitFor("id:settings-skills-enabled");
  expect(reloaded.shows("id:settings-save-bar")).toBe(false);
  await reloaded.press("label:Load skills");
  await reloaded.waitFor("id:settings-save-bar");
  await reloaded.press("id:settings-save-bar-save");
  await reloaded.waitUntil(() => rt.puts.length === 2);
  expect(rt.puts[1].skills).toEqual({ enabled: true });
  expect(rt.saved.enabled).toBe(true);
});

test("turning Load skills back before saving leaves nothing to save", async () => {
  const rt = runtime({ enabled: false });
  const { app } = await open(rt.api);
  await app.waitFor("id:settings-skills-enabled");
  await app.press("label:Load skills");
  await app.waitFor("id:settings-save-bar");
  await app.press("label:Load skills");
  await app.waitFor("id:settings-save-bar", { state: "gone" });
  expect(rt.puts).toHaveLength(0);
});

test("an MCP save sends the servers alone and keeps a Load skills draft; its own save keeps the servers", async () => {
  const rt = runtime({ enabled: true, servers: [] });
  const { app } = await open(rt.api);
  await app.waitFor("id:settings-skills-enabled");
  await app.press("label:Load skills");
  await app.waitFor("id:settings-save-bar");

  // First run: no servers; one is added from the pane and saved at once.
  await app.waitFor("No MCP servers");
  await app.press("id:mcp-add");
  await app.waitFor("id:mcp-pane");
  await app.type("id:mcp-name", "files");
  await app.type("id:mcp-command", "npx");
  await app.press("id:mcp-save");
  await app.waitUntil(() => rt.puts.length === 1);
  expect(rt.puts[0].skills).toBeUndefined();
  expect(rt.puts[0].tools).toBeUndefined();
  expect(rt.puts[0].mcp.servers.map((server: { name: string }) => server.name)).toEqual(["files"]);
  await app.waitFor("text:npx");
  // The Load skills draft is still there to save.
  expect(unsaved(app)).toEqual(["Load skills"]);

  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => rt.puts.length === 2);
  expect(rt.puts[1]).toEqual({ config_revision: "rev-1", skills: { enabled: false } });
  await app.waitFor("id:settings-save-bar", { state: "gone" });
  expect(app.shows("text:npx")).toBe(true);
  expect(rt.saved.servers.map((server: any) => server.name)).toEqual(["files"]);

  // The new server's pane stayed open through that save; an edit there saves, still without skills.
  expect(app.shows("id:mcp-pane")).toBe(true);
  expect(app.value("id:mcp-command")).toBe("npx");
  await app.clear("id:mcp-command");
  await app.type("id:mcp-command", "uvx");
  await app.press("id:mcp-save");
  await app.waitUntil(() => rt.puts.length === 3);
  expect(rt.puts[2].skills).toBeUndefined();
  expect(rt.puts[2].mcp.servers[0].command).toBe("uvx");
  expect(app.shows("id:settings-save-bar")).toBe(false);
});

test("a server's switch saves at once while Load skills waits for the save bar", async () => {
  const rt = runtime({ enabled: true, servers: [GITHUB] });
  const { app } = await open(rt.api);
  await app.waitFor("text:https://mcp.github.example/mcp");
  await app.press("label:Load skills");
  await app.press("id:mcp-enable-0");
  await app.waitUntil(() => rt.puts.length === 1);
  expect(rt.puts[0].mcp.servers[0].enable).toBe(false);
  expect(rt.puts[0].skills).toBeUndefined();
  expect(unsaved(app)).toEqual(["Load skills"]);
});

test("a failed Load skills save keeps the draft and says so", async () => {
  const rt = runtime({ enabled: true, failSkills: true });
  const { app } = await open(rt.api);
  await app.waitFor("id:settings-skills-enabled");
  await app.press("label:Load skills");
  await app.press("id:settings-save-bar-save");
  await app.waitFor("id:settings-save-bar-failed");
  expect(app.texts()).toContain("Not saved: Load skills. Check the highlighted fields and try again.");
  expect(rt.saved.enabled).toBe(true);
  // Still a draft: Save again sends it again.
  await app.press("id:settings-save-bar-save");
  await app.waitUntil(() => rt.puts.length === 2);
  expect(rt.puts[1].skills).toEqual({ enabled: false });
});

test("read-only settings: Load skills and the servers are shown but cannot change", async () => {
  const rt = runtime({ enabled: true, servers: [GITHUB], readOnly: true });
  const { app } = await open(rt.api);
  await app.waitFor("id:settings-skills-enabled");
  expect(app.shows("text:Managed by the host.")).toBe(true);
  expect(app.enabled("label:Load skills")).toBe(false);
  expect(app.enabled("id:mcp-add")).toBe(false);
  expect(app.enabled("id:mcp-enable-0")).toBe(false);
  expect(app.shows("id:settings-save-bar")).toBe(false);
});

test("a runtime that reports no skills settings shows the servers alone and is sent no skills", async () => {
  let body: any = null;
  const { app } = await open({
    "GET /settings/agent": { body: agentSettings({ servers: [GITHUB] }) },
    "PUT /settings/agent": (request) => {
      body = request.json;
      return { body: agentSettings({ servers: request.json.mcp.servers }) };
    },
  });
  await app.waitFor("text:https://mcp.github.example/mcp");
  expect(app.shows("id:settings-skills-enabled")).toBe(false);
  expect(app.shows(`id:settings-mcp >> text:${TITLE}`)).toBe(true);
  await app.press("id:mcp-enable-0");
  await app.waitUntil(() => body !== null);
  expect(body.skills).toBeUndefined();
  expect(body.mcp.servers[0].enable).toBe(false);
});

test("an agent without the settings routes says so under the SKILLs & MCP title", async () => {
  const { app } = await openConsole({
    location: "/e/ep_remote/settings/mcp",
    endpoints: [
      { endpoint_ref: "ep_remote", name: "Remote", url: "http://remote.test", connected: true, agent_name: "Remote", mode: "serve", can_submit: true },
    ],
    api: { "GET /proxy:/settings/agent": { status: 404, body: { error: "not found" } } },
  });
  await app.waitFor("id:settings-unsupported");
  expect(app.shows(`id:settings-unsupported >> text:${TITLE}`)).toBe(true);
  expect(app.shows("id:settings-skills-enabled")).toBe(false);
});

test("leaving with a Load skills draft asks first", async () => {
  const rt = runtime();
  const { app } = await open(rt.api);
  await app.waitFor("id:settings-skills-enabled");
  await app.press("label:Load skills");
  await app.waitFor("id:settings-save-bar");
  await app.press("id:settings-section-tools");
  await app.waitFor("Unsaved changes");
  await app.press("id:dialog-action-cancel");
  await app.waitFor("id:dialog-action-cancel", { state: "gone" });
  expect(app.shows("id:settings-skills-enabled")).toBe(true);
  expect(rt.puts).toHaveLength(0);
});

test("search finds Load skills and opens SKILLs & MCP", async () => {
  const { app } = await open(runtime().api, "/e/default/settings/tools");
  await app.waitFor("id:settings-agent-name-set");
  await app.type("id:settings-search", "load skills");
  await app.waitFor("id:settings-search-results");
  await app.press("role:option[Load skills]");
  await app.waitFor("id:settings-mcp");
  await app.waitFor("id:settings-skills-enabled");
});

test("on a phone the section's bar says SKILLs & MCP and the switch is there", async () => {
  const { app } = await openConsole({ location: "/e/default/settings", width: 420, height: 800, api: runtime().api });
  await app.waitFor("id:settings-index");
  expect(app.shows(`id:settings-section-mcp >> text:${TITLE}`)).toBe(true);
  await app.press("id:settings-section-mcp");
  await app.waitFor("id:settings-skills-enabled");
  await app.waitFor("id:settings-index", { state: "gone" });
  // The bar's title and the card's head.
  expect(app.count(`text:${TITLE}`)).toBe(2);
  expect(app.count("label:Load skills")).toBe(1);
});
