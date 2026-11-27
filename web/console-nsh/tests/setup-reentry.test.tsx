// Setup opened again from Settings, on an agent that is set up already: the Settings entry, the
// steps with their saved values, what continuing and leaving write (nothing but a changed step),
// which agent it is all for, and the guards that still hold.
import { expect, test } from "nsh/test";
import type { ApiHandler, ApiRequest } from "./harness";
import { LOCAL_REF, localEndpoint, openConsole } from "./harness";

const REMOTE_REF = "ep_remote";

/** The last location the app wrote to the address bar. */
function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}

type Identity = { name: string; creature: string; vibe: string; emoji: string };

interface AgentState {
  llm: Record<string, string>;
  /** Fields the environment sets: the form shows them, and never sends them. */
  envManaged: Record<string, unknown>;
  identity: Identity;
  soul: string;
  llmPuts: any[];
  identityPuts: any[];
  revision: number;
}

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    llm: { inference_provider: "openai_compatible", provider: "openai", endpoint: "https://api.example.com/v1", model: "saved-model", reasoning_effort: "high" },
    envManaged: {},
    identity: { name: "Nova", creature: "fox", vibe: "calm", emoji: "🦊" },
    soul: "# Soul\n\nMy own words.",
    llmPuts: [],
    identityPuts: [],
    revision: 1,
    ...overrides,
  };
}

/** What /settings/agent answers: the saved model, its key only as "configured", never its value. */
function settingsBody(state: AgentState) {
  return {
    config_source: "config",
    config_revision: `rev-${state.revision}`,
    llm: { ...state.llm },
    tools: { bash: { enabled: false } },
    env_managed: { llm: state.envManaged },
    secret_fields: { llm: { api_key: { configured: true, editable: true, source: "os" } } },
  };
}

function settingsRoutes(prefix: string, state: AgentState): Record<string, ApiHandler> {
  return {
    [`GET ${prefix}/settings/agent`]: () => ({ body: settingsBody(state) }),
    [`PUT ${prefix}/settings/agent`]: (request: ApiRequest) => {
      state.llmPuts.push(request.json);
      Object.assign(state.llm, request.json?.llm || {});
      state.revision += 1;
      return { body: settingsBody(state) };
    },
  };
}

/** A console whose local agent (and, with `remote`, a second one) is set up, each with its own values. */
function readyConsole(options: { local?: AgentState; remote?: AgentState; extra?: Record<string, ApiHandler> } = {}) {
  const local = options.local ?? agent();
  const remote = options.remote;
  const of = (request: ApiRequest) => (request.endpoint === REMOTE_REF && remote ? remote : local);
  const identityBody = (state: AgentState) => ({
    exists: true,
    identity: { ...state.identity, name_alts: [], soul: state.soul, extra: {} },
  });
  const api: Record<string, ApiHandler> = {
    "GET /endpoints": {
      body: {
        items: [
          localEndpoint(),
          ...(remote ? [localEndpoint({ endpoint_ref: REMOTE_REF, name: "Remote", agent_name: "Remote", url: "https://remote.example", instance_id: "remote" })] : []),
        ],
      },
    },
    ...settingsRoutes("", local),
    ...(remote ? settingsRoutes("/proxy:", remote) : {}),
    "GET /proxy:/persona/identity": (request: ApiRequest) => ({ body: identityBody(of(request)) }),
    "PUT /proxy:/persona/identity": (request: ApiRequest) => {
      const state = of(request);
      const body = request.json || {};
      state.identityPuts.push(body);
      for (const key of ["name", "creature", "vibe", "emoji"] as const) {
        if (typeof body[key] === "string") state.identity[key] = body[key];
      }
      if (typeof body.soul === "string") state.soul = body.soul.trim();
      return { body: identityBody(state) };
    },
    "GET /proxy/download:/persona/avatar": { status: 404, body: { error: "not found" } },
    ...(options.extra || {}),
  };
  return { local, remote, api };
}

/** The requests that could change something an agent keeps (the session's own are not such). */
function changing(calls: ApiRequest[]) {
  return calls.filter(
    (call) => call.method.toUpperCase() !== "GET" && !call.path.startsWith("/auth/") && call.path !== "/stream/ticket",
  );
}

function writes(calls: ApiRequest[]) {
  return changing(calls).map((call) => `${call.method.toUpperCase()} ${call.uri ?? call.path}`);
}

test("Settings offers Setup for a set-up agent, and it opens the model step with what is saved", async () => {
  const { api } = readyConsole();
  const { app, calls } = await openConsole({ location: "/e/default/settings/agent", api });
  await app.waitFor("id:settings-setup");
  await app.waitFor("text:Run setup again");
  await app.waitUntil(() => app.enabled("id:settings-setup-open"));
  await app.press("id:settings-setup-open");

  // The first step, editable: not the Done page a set-up agent's bare /setup shows.
  await app.waitFor("id:setup-stage-llm");
  expect(lastLocation(app)).toBe("/e/default/setup/llm?reentry=settings");
  await app.waitUntil(() => app.value("id:setup-model") === "saved-model");
  expect(app.value("id:setup-endpoint")).toBe("https://api.example.com/v1");
  // The stored key is not asked for again: the step can go on as it is.
  await app.waitUntil(() => app.enabled("id:setup-submit"));

  // Back goes to the same agent's settings, and nothing was written on the way in or out.
  await app.press("id:setup-back-to-settings");
  await app.waitFor("id:settings-agent");
  expect(lastLocation(app)).toBe("/e/default/settings/agent");
  expect(writes(calls)).toEqual([]);
});

test("continuing through every step unchanged writes nothing and ends in the console", async () => {
  const { local, api } = readyConsole();
  const { app, calls } = await openConsole({ location: "/e/default/setup/llm?reentry=settings", api });
  await app.waitFor("id:setup-stage-llm");
  await app.waitUntil(() => app.value("id:setup-model") === "saved-model");
  await app.press("id:setup-submit");

  await app.waitFor("id:setup-stage-persona");
  expect(lastLocation(app)).toBe("/e/default/setup/persona?reentry=settings");
  await app.waitUntil(() => app.value("id:setup-persona-name") === "Nova");
  await app.press("id:setup-submit");

  // The saved soul shows as the chosen one, and Finish goes on with it: no preset replaces it.
  await app.waitFor("id:setup-stage-soul");
  await app.waitFor("id:setup-soul-spotlight");
  await app.waitFor("id:setup-submit >> text:Continue");
  await app.press("id:setup-submit");

  await app.waitFor("id:setup-stage-done");
  expect(lastLocation(app)).toBe("/e/default/setup/done?reentry=settings");
  expect(app.shows("id:setup-back-to-settings")).toBe(true);
  await app.press("id:setup-enter-chat");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/chat"));

  expect(writes(calls)).toEqual([]);
  expect(local.llm.model).toBe("saved-model");
  expect(local.identity.name).toBe("Nova");
  expect(local.soul).toBe("# Soul\n\nMy own words.");
});

test("a reload stays in the reopened step; without the mark a set-up agent's setup is Done", async () => {
  const { api } = readyConsole();
  // Reloaded midway: the same step, the saved persona, the way back.
  const midway = await openConsole({ location: "/e/default/setup/persona?reentry=settings", api });
  await midway.app.waitFor("id:setup-stage-persona");
  await midway.app.waitUntil(() => midway.app.value("id:setup-persona-name") === "Nova");
  expect(midway.app.shows("id:setup-back-to-settings")).toBe(true);
  expect(lastLocation(midway.app)).toBe("/e/default/setup/persona?reentry=settings");
  // Previous goes back a step and stays in the reopened setup.
  await midway.app.press("id:setup-previous");
  await midway.app.waitFor("id:setup-stage-llm");
  expect(lastLocation(midway.app)).toBe("/e/default/setup/llm?reentry=settings");
  expect(writes(midway.calls)).toEqual([]);

  // The bare address with the mark starts at the first step.
  const bare = await openConsole({ location: "/e/default/setup?reentry=settings", api });
  await bare.app.waitFor("id:setup-stage-llm");
  expect(lastLocation(bare.app)).toBe("/e/default/setup/llm?reentry=settings");

  // Without it nothing changed: Done, and no way "back" to a Settings it was not opened from.
  const plain = await openConsole({ location: "/e/default/setup", api });
  await plain.app.waitFor("id:setup-stage-done");
  expect(lastLocation(plain.app)).toBe("/e/default/setup/done");
  expect(plain.app.shows("id:setup-back-to-settings")).toBe(false);
});

test("one changed field saves that step only: the key stays out, and leaving later keeps the save", async () => {
  const { local, api } = readyConsole({
    local: agent({ envManaged: { endpoint: { env_name: "MISTER_MORPH_LLM_ENDPOINT", value: "https://env.example/v1", raw_value: "https://env.example/v1" } } }),
  });
  const { app, calls } = await openConsole({ location: "/e/default/setup/llm?reentry=settings", api });
  await app.waitFor("id:setup-stage-llm");
  await app.waitUntil(() => app.value("id:setup-model") === "saved-model");
  await app.clear("id:setup-model");
  await app.type("id:setup-model", "new-model");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-persona");

  expect(local.llmPuts).toHaveLength(1);
  const sent = local.llmPuts[0];
  expect(sent.config_revision).toBe("rev-1");
  expect(sent.llm.model).toBe("new-model");
  // The stored key was not typed again: it is left out, not sent blank or as a mask.
  expect("api_key" in sent.llm).toBe(false);
  // What the environment sets is not written to the config.
  expect("endpoint" in sent.llm).toBe(false);
  // Settings the step does not show go back as they were loaded.
  expect("reasoning_effort" in sent.llm).toBe(false);
  expect(sent.tools.bash).toEqual({ enabled: false });
  // No plaintext key came with the settings, and none went to the address.
  expect(JSON.stringify(calls.map((call) => call.url))).not.toContain("sk-");

  // An edit that is not continued from is not saved; the model saved above stays.
  await app.waitUntil(() => app.value("id:setup-persona-name") === "Nova");
  await app.clear("id:setup-persona-name");
  await app.type("id:setup-persona-name", "Dropped");
  await app.press("id:setup-back-to-settings");
  await app.waitFor("id:settings-agent");
  expect(writes(calls)).toEqual(["PUT /settings/agent"]);
  expect(local.identity.name).toBe("Nova");
  expect(local.llm.model).toBe("new-model");
});

test("with two agents, the reopened setup reads and saves the one Settings was open for", async () => {
  const { local, remote, api } = readyConsole({
    remote: agent({
      llm: { inference_provider: "openai_compatible", provider: "openai", endpoint: "https://remote.example/v1", model: "remote-model" },
      identity: { name: "Rhea", creature: "owl", vibe: "dry", emoji: "🦉" },
      soul: "# Remote soul",
    }),
  });
  const { app, calls } = await openConsole({ location: `/e/${REMOTE_REF}/settings/agent`, api });
  await app.waitFor("id:settings-setup");
  await app.waitUntil(() => app.enabled("id:settings-setup-open"));
  await app.press("id:settings-setup-open");
  await app.waitFor("id:setup-stage-llm");
  expect(lastLocation(app)).toBe(`/e/${REMOTE_REF}/setup/llm?reentry=settings`);
  await app.waitUntil(() => app.value("id:setup-model") === "remote-model");

  await app.clear("id:setup-model");
  await app.type("id:setup-model", "remote-next");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-persona");
  expect(lastLocation(app)).toBe(`/e/${REMOTE_REF}/setup/persona?reentry=settings`);
  await app.waitUntil(() => app.value("id:setup-persona-name") === "Rhea");
  await app.clear("id:setup-persona-name");
  await app.type("id:setup-persona-name", "Rhea II");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-soul");

  expect(remote!.llm.model).toBe("remote-next");
  expect(remote!.identity.name).toBe("Rhea II");
  // The local agent was neither read for the form nor written.
  expect(local.llmPuts).toEqual([]);
  expect(local.identityPuts).toEqual([]);
  expect(local.llm.model).toBe("saved-model");
  expect(local.identity.name).toBe("Nova");
  expect(changing(calls).map((call) => call.endpoint)).toEqual([REMOTE_REF, REMOTE_REF]);

  // Back goes to the same agent's settings.
  await app.press("id:setup-back-to-settings");
  await app.waitFor("id:settings-agent");
  expect(lastLocation(app)).toBe(`/e/${REMOTE_REF}/settings/agent`);
});

test("a step whose saved values did not load cannot be saved until a retry reads them", async () => {
  let failing = true;
  const state = agent();
  const { api } = readyConsole({
    local: state,
    extra: {
      "GET /settings/agent": () => (failing ? { status: 500, body: { error: "config unreadable" } } : { body: settingsBody(state) }),
    },
  });
  const { app, calls } = await openConsole({ location: "/e/default/setup/llm?reentry=settings", api });
  await app.waitFor("id:setup-error >> text:config unreadable");
  // A filled-in form still cannot be saved: it would replace settings nobody has seen.
  await app.type("id:setup-endpoint", "https://api.example.com/v1");
  await app.type("id:setup-api-key-input", "sk-typed");
  await app.type("id:setup-model", "typed-model");
  expect(app.enabled("id:setup-submit")).toBe(false);
  expect(writes(calls)).toEqual([]);

  failing = false;
  await app.press("id:setup-load-retry");
  await app.waitUntil(() => app.value("id:setup-model") === "saved-model");
  expect(app.shows("id:setup-load-retry")).toBe(false);
  expect(app.shows("id:setup-error")).toBe(false);
  await app.waitUntil(() => app.enabled("id:setup-submit"));
  expect(state.llmPuts).toEqual([]);
});

test("a persona that did not load cannot be saved over, nor a soul", async () => {
  const { local, api } = readyConsole({
    extra: { "GET /proxy:/persona/identity": { status: 500, body: { error: "agent.db is locked" } } },
  });
  const persona = await openConsole({ location: "/e/default/setup/persona?reentry=settings", api });
  await persona.app.waitFor("id:setup-error >> text:agent.db is locked");
  await persona.app.type("id:setup-persona-name", "Typed");
  expect(persona.app.enabled("id:setup-submit")).toBe(false);

  const soul = await openConsole({ location: "/e/default/setup/soul?reentry=settings", api });
  await soul.app.waitFor("id:setup-error >> text:agent.db is locked");
  await soul.app.press("id:setup-soul-cat");
  await soul.app.waitFor("id:setup-submit");
  expect(soul.app.enabled("id:setup-submit")).toBe(false);
  expect(local.identityPuts).toEqual([]);
});

test("a failed save says why, stays on the step, and can be tried again", async () => {
  let failing = true;
  const state = agent();
  const { api } = readyConsole({
    local: state,
    extra: {
      "PUT /settings/agent": (request: ApiRequest) => {
        if (failing) return { status: 500, body: { error: "disk full" } };
        state.llmPuts.push(request.json);
        Object.assign(state.llm, request.json?.llm || {});
        return { body: settingsBody(state) };
      },
    },
  });
  const { app } = await openConsole({ location: "/e/default/setup/llm?reentry=settings", api });
  await app.waitFor("id:setup-stage-llm");
  await app.waitUntil(() => app.value("id:setup-model") === "saved-model");
  await app.clear("id:setup-model");
  await app.type("id:setup-model", "new-model");
  await app.press("id:setup-submit");
  await app.waitFor("text:disk full");
  expect(app.shows("id:setup-stage-llm")).toBe(true);
  expect(app.value("id:setup-model")).toBe("new-model");
  expect(state.llm.model).toBe("saved-model");

  failing = false;
  await app.waitUntil(() => app.enabled("id:setup-submit"));
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-persona");
  expect(state.llm.model).toBe("new-model");
});

test("an agent whose settings are read-only has the Setup row, disabled, with the reason", async () => {
  const state = agent();
  const { api } = readyConsole({
    local: state,
    extra: {
      "GET /settings/agent": () => ({ body: { ...settingsBody(state), read_only: true, read_only_reason: "Managed by the host." } }),
    },
  });
  const { app } = await openConsole({ location: "/e/default/settings/agent", api });
  await app.waitFor("id:settings-setup");
  await app.waitFor("id:settings-setup-blocked >> text:Managed by the host.");
  expect(app.enabled("id:settings-setup-open")).toBe(false);
});

test("the reopened setup keeps the guards: a session, an agent that is there, and repairs first", async () => {
  // No session: the login page, which comes back to the same step afterwards.
  const { api } = readyConsole();
  const locked = await openConsole({ location: "/e/default/setup/llm?reentry=settings", api, password: true });
  await locked.app.waitUntil(() => lastLocation(locked.app).startsWith("/login"));
  expect(lastLocation(locked.app)).toBe(`/login?redirect=${encodeURIComponent("/e/default/setup/llm?reentry=settings")}`);

  // An agent that is not there: the overview, not another agent's setup.
  const gone = await openConsole({ location: "/e/ep_gone/setup/llm?reentry=settings", api });
  await gone.app.waitUntil(() => lastLocation(gone.app).startsWith("/overview"));
  expect(gone.app.shows("id:setup-page")).toBe(false);

  // A broken file blocks it as it blocks every page: troubleshooting comes first.
  const broken = readyConsole({
    extra: {
      "GET /setup/integrity": {
        body: { items: [{ key: "identity", code: "identity_invalid", name: "identity.yaml", path: "/state/identity.yaml", error: "bad yaml", stage: "persona", status: "malformed" }] },
      },
    },
  });
  const repair = await openConsole({ location: "/e/default/setup/llm?reentry=settings", api: broken.api });
  await repair.app.waitFor("id:repair-page");
  expect(lastLocation(repair.app).startsWith("/e/default/troubleshooting")).toBe(true);
});

test("an agent that is not set up yet takes the first-run steps, mark or no mark", async () => {
  const state = agent();
  const { api } = readyConsole({
    local: state,
    extra: {
      "GET /proxy:/persona/identity": { body: { exists: false, identity: { name: "", creature: "", vibe: "", emoji: "", name_alts: [], soul: "", extra: {} } } },
    },
  });
  const { app } = await openConsole({ location: "/e/default/setup?reentry=settings", api });
  // The step it still needs, not the first one.
  await app.waitFor("id:setup-stage-persona");
  expect(app.enabled("id:setup-submit")).toBe(false);
});

for (const width of [360, 390]) {
  test(`on a ${width}pt phone the reopened setup shows the way back, and it returns to the agent's settings`, async () => {
    const { api } = readyConsole();
    const { app, calls } = await openConsole({ location: "/e/default/setup/llm?reentry=settings", api, platform: "android", width });
    await app.waitFor("id:setup-stage-llm");
    await app.waitUntil(() => app.value("id:setup-model") === "saved-model");
    await app.waitFor("text:Back to Settings");
    await app.press("id:setup-back-to-settings");
    await app.waitFor("id:settings-agent");
    expect(writes(calls)).toEqual([]);
  });
}

for (const [locale, label, row] of [
  ["zh", "返回设置", "重新运行 Setup"],
  ["ja", "設定に戻る", "Setup をもう一度実行"],
] as const) {
  test(`the Settings row and the way back are translated (${locale})`, async () => {
    const { api } = readyConsole();
    const { app } = await openConsole({ location: "/e/default/settings/agent", api, kv: { "quail-language": locale } });
    await app.waitFor(`text:${row}`);
    await app.waitUntil(() => app.enabled("id:settings-setup-open"));
    await app.press("id:settings-setup-open");
    await app.waitFor("id:setup-stage-llm");
    await app.waitFor(`text:${label}`);
  });
}
