// Setup's first page: how to address the Console's user. Where a Setup starts and resumes, what
// the page accepts, how it saves (to the Console, once, on Continue), what a failed save leaves,
// and where the saved name shows.
import { expect, test } from "nsh/test";
import type { App } from "nsh/test";
import { CONSOLE_USER_NAME_MAX, normalizeConsoleUserName } from "../lib/core/console-user-name.js";
import type { ApiRequest } from "./harness";
import { localEndpoint, openConsole } from "./harness";

const NAME_KEY = "console.user_name";
const DAY = 24 * 60 * 60 * 1000;

/** The last location the app wrote to the address bar. */
function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}

type Identity = { name: string; creature: string; vibe: string; emoji: string };

interface ConsoleState {
  /** The saved name; null is a server from before names could be saved. */
  userName: string | null;
  configured: boolean;
  identity: Identity | null;
  soul: string;
  /** Every body sent to PUT /settings/console. */
  consolePuts: any[];
  identityPuts: any[];
  agentPuts: any[];
  /** While set, saving the name fails with this message. */
  saveError: string;
}

/**
 * A console with a server that keeps the user's name. By default nothing is set up: no name, no
 * model, no persona. The name is saved as the server saves it (the white space around it dropped).
 */
function nameConsole(initial: Partial<ConsoleState> = {}, extra: Record<string, any> = {}) {
  const state: ConsoleState = {
    userName: "",
    configured: false,
    identity: null,
    soul: "",
    consolePuts: [],
    identityPuts: [],
    agentPuts: [],
    saveError: "",
    ...initial,
  };
  const expires = new Date(Date.now() + DAY).toISOString();
  const api: Record<string, any> = {
    "GET /auth/me": (request: ApiRequest) => {
      if (!(request.headers.authorization || request.headers.Authorization)) {
        return { status: 401, body: { error: "unauthorized" } };
      }
      const name = state.userName === null ? {} : { user_name: state.userName, display_name: state.userName || "Console User" };
      return { body: { account: "console", expires_at: expires, ...name } };
    },
    "PUT /settings/console": (request: ApiRequest) => {
      state.consolePuts.push(request.json);
      if (state.saveError) return { status: 500, body: { error: state.saveError } };
      const checked = normalizeConsoleUserName(request.json?.config_changes?.[NAME_KEY]);
      if (checked.error) return { status: 400, body: { error: `${NAME_KEY}: refused (${checked.error})` } };
      state.userName = checked.name;
      return { body: { ok: true, config_values: { [NAME_KEY]: checked.name }, apply_mode: "immediate" } };
    },
    "GET /endpoints": () => ({ body: { items: [localEndpoint({ can_submit: state.configured })] } }),
    "GET /settings/agent": () => ({
      body: {
        config_source: state.configured ? "config" : "defaults",
        config_revision: "rev-1",
        llm: state.configured ? { provider: "openai", endpoint: "https://api.example.com/v1", model: "gpt-test" } : {},
        secret_fields: state.configured ? { llm: { api_key: { configured: true, editable: true } } } : {},
        tools: {},
      },
    }),
    "PUT /settings/agent": (request: ApiRequest) => {
      state.agentPuts.push(request.json);
      state.configured = true;
      return { body: { config_source: "config", config_revision: "rev-2", llm: request.json?.llm || {}, tools: {} } };
    },
    "GET /proxy:/state/files": () => ({
      body: {
        items: [...(state.identity ? ["identity.yaml"] : []), ...(state.soul ? ["soul.md"] : []), "HEARTBEAT.md", "cron.yaml"].map(
          (name) => ({ name, exists: true, path: `/state/${name}`, group: "persona" }),
        ),
      },
    }),
    "GET /proxy:/persona/identity": () => ({
      body: {
        exists: state.identity !== null,
        identity: { name: "", creature: "", vibe: "", emoji: "", ...(state.identity || {}), name_alts: [], soul: state.soul, extra: {} },
      },
    }),
    "PUT /proxy:/persona/identity": (request: ApiRequest) => {
      const body = request.json || {};
      state.identityPuts.push(body);
      const next: Identity = { name: "", creature: "", vibe: "", emoji: "", ...(state.identity || {}) };
      for (const key of ["name", "creature", "vibe", "emoji"] as const) {
        if (typeof body[key] === "string") next[key] = body[key];
      }
      state.identity = next;
      if (typeof body.soul === "string") state.soul = body.soul.trim();
      return { body: { exists: true, identity: { ...next, name_alts: [], soul: state.soul, extra: {} } } };
    },
    "GET /proxy:/persona/avatar": { status: 404, body: { error: "not found" } },
    "GET /proxy:/topics": { body: { items: [] } },
    ...extra,
  };
  return { state, api };
}

/** A console that finished Setup: a model, an identity and a soul. */
function readyConsole(initial: Partial<ConsoleState> = {}, extra: Record<string, any> = {}) {
  return nameConsole(
    { configured: true, identity: { name: "Morph", creature: "", vibe: "", emoji: "" }, soul: "# Soul", ...initial },
    extra,
  );
}

/** Requests that change something on the server, without the session's own. */
function writes(calls: ApiRequest[]) {
  return calls.filter(
    (call) => call.method.toUpperCase() !== "GET" && call.path !== "/auth/login" && call.path !== "/stream/ticket",
  );
}

async function fillModel(app: App) {
  await app.type("id:setup-endpoint", "https://api.example.com/v1");
  await app.type("id:setup-api-key-input", "sk-test");
  await app.type("id:setup-model", "gpt-test");
  await app.waitUntil(() => app.enabled("id:setup-submit"));
}

/* ---------- the rule, as the server has it ---------- */

const EIGHTY_CJK = "名".repeat(CONSOLE_USER_NAME_MAX);
const EIGHTY_EMOJI = "🙂".repeat(CONSOLE_USER_NAME_MAX);

// The same cases as internal/consoleuser/consoleuser_test.go: the page and the server agree.
const ACCEPTED: [string, string, string][] = [
  ["plain", "Lyra", "Lyra"],
  ["surrounding ascii space", "  Lyra \t", "Lyra"],
  ["surrounding unicode space", "\u3000\u00a0\u2003Lyra\u2009\u202f\u205f\u1680\u0085\ufeff", "Lyra"],
  ["surrounding line breaks", "\r\nLyra\n\u2028\u2029", "Lyra"],
  ["internal spaces", " Ada  Lovelace ", "Ada  Lovelace"],
  ["internal ideographic space", "山田\u3000太郎", "山田\u3000太郎"],
  ["cjk", "小明", "小明"],
  ["emoji with joiners", "👩‍💻 Zoë 🇯🇵", "👩‍💻 Zoë 🇯🇵"],
  ["markup stays text", "<b>**Bo**</b> `x` [a](b)", "<b>**Bo**</b> `x` [a](b)"],
  ["80 code points", EIGHTY_CJK, EIGHTY_CJK],
  ["80 astral code points", EIGHTY_EMOJI, EIGHTY_EMOJI],
  ["80 code points after trimming", ` ${EIGHTY_CJK} `, EIGHTY_CJK],
];
const REFUSED: [string, string, string][] = [
  ["81 code points", `${EIGHTY_CJK}名`, "too_long"],
  ["81 astral code points", `${EIGHTY_EMOJI}🙂`, "too_long"],
  ["empty", "", "empty"],
  ["ascii spaces only", "   ", "empty"],
  ["unicode spaces only", "\u3000\u00a0\u2003\u2028\ufeff\t\n", "empty"],
  ["line feed inside", "Ada\nLovelace", "invalid"],
  ["carriage return inside", "Ada\rLovelace", "invalid"],
  ["line separator inside", "Ada\u2028Lovelace", "invalid"],
  ["paragraph separator inside", "Ada\u2029Lovelace", "invalid"],
  ["next line inside", "Ada\u0085Lovelace", "invalid"],
  ["tab inside", "Ada\tLovelace", "invalid"],
  ["nul inside", "Ada\u0000Lovelace", "invalid"],
  ["escape inside", "Ada\u001b[31m", "invalid"],
  ["delete inside", "Ada\u007fLovelace", "invalid"],
  ["c1 control inside", "Ada\u009bLovelace", "invalid"],
  ["half a surrogate pair", "Ada\ud83d", "invalid"],
];

test("the page's rule for a name is the server's: trimmed, one line, 1 to 80 code points, nothing cut", () => {
  for (const [label, input, want] of ACCEPTED) {
    const got = normalizeConsoleUserName(input);
    expect(`${label}: ${got.error}|${got.name}`).toBe(`${label}: |${want}`);
    // A saved name is saved again as it is.
    expect(normalizeConsoleUserName(got.name).name).toBe(want);
  }
  for (const [label, input, want] of REFUSED) {
    const got = normalizeConsoleUserName(input);
    expect(`${label}: ${got.error}|${got.name}`).toBe(`${label}: ${want}|`);
  }
  expect(normalizeConsoleUserName(`${EIGHTY_EMOJI}🙂`).length).toBe(81);
  expect(normalizeConsoleUserName(null).error).toBe("empty");
  expect(normalizeConsoleUserName(undefined).error).toBe("empty");
});

/* ---------- where Setup starts ---------- */

test("a fresh console asks the name first, saves it on Continue, then walks the old steps", async () => {
  const { state, api } = nameConsole();
  const { app, calls } = await openConsole({ location: "/", api });
  await app.waitFor("id:setup-stage-user");
  expect(lastLocation(app).startsWith("/e/default/setup/user")).toBe(true);
  await app.waitFor("text:/setup // step 1/i");
  await app.waitFor("text:What should we call you?");
  await app.waitFor("id:setup-form-user >> text:/^your name$/i");
  // The first step has nothing before it, and nothing to continue with yet.
  expect(app.shows("id:setup-previous")).toBe(false);
  expect(app.value("id:setup-user-name") || "").toBe("");
  expect(app.enabled("id:setup-submit")).toBe(false);
  expect(app.shows("id:setup-user-name-error")).toBe(false);

  await app.type("id:setup-user-name", "  小明 🙂  ");
  await app.waitUntil(() => app.enabled("id:setup-submit"));
  // Typing saves nothing.
  expect(state.consolePuts.length).toBe(0);
  await app.press("id:setup-submit");

  await app.waitFor("id:setup-stage-llm");
  expect(lastLocation(app).startsWith("/e/default/setup/llm")).toBe(true);
  await app.waitFor("text:/setup // step 2/i");
  // One request, to the Console, with the name and nothing else; the name is in no address.
  expect(state.consolePuts).toEqual([{ config_changes: { [NAME_KEY]: "小明 🙂" } }]);
  expect(state.userName).toBe("小明 🙂");
  expect(calls.some((call) => decodeURIComponent(call.url).includes("小明"))).toBe(false);
  expect(app.host.calls().some((call) => JSON.stringify(call.data ?? "").includes("小明"))).toBe(false);

  await fillModel(app);
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-persona");
  await app.waitFor("text:/setup // step 3/i");
  // The agent's name is its own: the user's name is not offered for it.
  expect(app.value("id:setup-persona-name") || "").toBe("");
  await app.type("id:setup-persona-name", "Nova");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-soul");
  await app.waitFor("text:/setup // step 4/i");
  await app.press("id:setup-soul-cat");
  await app.waitFor("id:setup-soul-spotlight");
  await app.press("id:setup-submit");

  await app.waitFor("id:setup-stage-done");
  // The last page lists the name beside the agent's parts, as text.
  await app.waitFor("id:setup-done-value-user >> text:小明 🙂");
  expect(state.identity?.name).toBe("Nova");
  // Nothing of the user's name went to the agent: not its identity, not its soul, not its model.
  const agentWrites = JSON.stringify([state.identityPuts, state.agentPuts, state.soul]);
  expect(agentWrites.includes("小明")).toBe(false);
  expect(state.consolePuts.length).toBe(1);
  await app.press("id:setup-enter-chat");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/chat"));
});

test("Enter in the name field continues like the button", async () => {
  const { state, api } = nameConsole();
  const { app } = await openConsole({ location: "/", api });
  await app.waitFor("id:setup-stage-user");
  await app.type("id:setup-user-name", "Lyra");
  await app.keyboard.press("enter");
  await app.waitFor("id:setup-stage-llm");
  expect(state.consolePuts).toEqual([{ config_changes: { [NAME_KEY]: "Lyra" } }]);
});

for (const path of ["/setup/llm", "/setup/persona", "/setup/soul", "/setup/done", "/setup", "/chat", "/setup/llm?repair=config"]) {
  test(`on a fresh console ${path} opens the name page, not a later step`, async () => {
    const { state, api } = nameConsole();
    const { app } = await openConsole({ location: `/e/default${path}`, api });
    await app.waitFor("id:setup-stage-user");
    expect(lastLocation(app).startsWith("/e/default/setup/user")).toBe(true);
    expect(app.shows("id:setup-stage-llm")).toBe(false);
    expect(lastLocation(app).includes("repair=")).toBe(false);
    expect(state.consolePuts.length).toBe(0);
  });
}

test("a Setup that was left after the model starts at the name page while no name is saved", async () => {
  // The model was saved (by an earlier version, or another way) but the name never asked.
  const { api } = nameConsole({ configured: true });
  const { app } = await openConsole({ location: "/", api });
  await app.waitFor("id:setup-stage-user");
  await app.type("id:setup-user-name", "Lyra");
  await app.press("id:setup-submit");
  // Then the steps in their order; the saved model is there to continue with.
  await app.waitFor("id:setup-stage-llm");
  await app.waitUntil(() => app.value("id:setup-model") === "gpt-test");
});

test("a Setup resumed with a saved name goes on where it stopped, and Back reaches the name", async () => {
  const fresh = nameConsole({ userName: "Lyra" });
  const first = await openConsole({ location: "/", api: fresh.api });
  await first.app.waitFor("id:setup-stage-llm");
  expect(lastLocation(first.app).startsWith("/e/default/setup/llm")).toBe(true);
  await first.app.waitFor("text:/setup // step 2/i");
  // Back from the model is the name page, with the saved name to edit.
  await first.app.press("id:setup-previous");
  await first.app.waitFor("id:setup-stage-user");
  await first.app.waitUntil(() => first.app.value("id:setup-user-name") === "Lyra");
  expect(first.app.shows("id:setup-previous")).toBe(false);
  // Continuing with it unchanged is safe: the same name again, and on to the model.
  await first.app.press("id:setup-submit");
  await first.app.waitFor("id:setup-stage-llm");
  expect(fresh.state.consolePuts).toEqual([{ config_changes: { [NAME_KEY]: "Lyra" } }]);
  expect(fresh.state.userName).toBe("Lyra");

  // Reloaded later, with the model saved too: the persona, whose Back is the model.
  const later = nameConsole({ userName: "Lyra", configured: true });
  const second = await openConsole({ location: "/e/default/setup", api: later.api });
  await second.app.waitFor("id:setup-stage-persona");
  await second.app.waitFor("text:/setup // step 3/i");
  await second.app.press("id:setup-previous");
  await second.app.waitFor("id:setup-stage-llm");
  expect(later.state.consolePuts.length).toBe(0);
});

test("a console set up before the name existed is not sent to Setup, and can add the name there", async () => {
  const { state, api } = readyConsole();
  const { app, calls } = await openConsole({ location: "/", api });
  // No name saved, and chat opens as before.
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/chat"));
  expect(app.shows("id:setup-page")).toBe(false);
  expect(writes(calls).length).toBe(0);

  // Setup, opened on purpose, lists the name as not set; its pencil opens the name page.
  const opened = await openConsole({ location: "/e/default/setup", api });
  await opened.app.waitFor("id:setup-stage-done");
  await opened.app.waitFor("id:setup-done-value-user >> text:Not set");
  await opened.app.press("id:setup-done-edit-user");
  await opened.app.waitFor("id:setup-stage-user");
  expect(opened.app.value("id:setup-user-name") || "").toBe("");
  await opened.app.type("id:setup-user-name", "Lyra");
  await opened.app.press("id:setup-submit");
  // The steps follow in order, each with what is saved.
  await opened.app.waitFor("id:setup-stage-llm");
  expect(state.userName).toBe("Lyra");
  // Nothing but the name was written.
  expect(writes(opened.calls).map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /settings/console"]);
});

test("the name page opened again shows the saved name, and leaving without Continue saves nothing", async () => {
  const { state, api } = readyConsole({ userName: "Lyra" });
  const { app } = await openConsole({ location: "/e/default/setup/user", api });
  await app.waitFor("id:setup-stage-user");
  await app.waitUntil(() => app.value("id:setup-user-name") === "Lyra");
  await app.clear("id:setup-user-name");
  await app.type("id:setup-user-name", "Somebody Else");
  // Left without Continue (the last page's link is the way around in a finished Setup).
  const away = await openConsole({ location: "/e/default/setup/done", api });
  await away.app.waitFor("id:setup-done-value-user >> text:Lyra");
  expect(state.consolePuts.length).toBe(0);
  expect(state.userName).toBe("Lyra");
  // And the page, opened again, has the saved name, not what was typed.
  await away.app.press("id:setup-done-edit-user");
  await away.app.waitFor("id:setup-stage-user");
  await away.app.waitUntil(() => away.app.value("id:setup-user-name") === "Lyra");
});

test("a server from before the name has the three steps it always had", async () => {
  const { state, api } = nameConsole({ userName: null });
  const { app } = await openConsole({ location: "/", api });
  await app.waitFor("id:setup-stage-llm");
  expect(lastLocation(app).startsWith("/e/default/setup/llm")).toBe(true);
  await app.waitFor("text:/setup // step 1/i");
  expect(app.shows("id:setup-previous")).toBe(false);
  await fillModel(app);
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-persona");
  await app.waitFor("text:/setup // step 2/i");
  await app.press("id:setup-previous");
  await app.waitFor("id:setup-stage-llm");
  expect(app.shows("id:setup-previous")).toBe(false);
  expect(state.consolePuts.length).toBe(0);
  // And its last page lists no name.
  const done = readyConsole({ userName: null });
  const opened = await openConsole({ location: "/e/default/setup", api: done.api });
  await opened.app.waitFor("id:setup-stage-done");
  expect(opened.app.shows("id:setup-done-edit-user")).toBe(false);
  expect(opened.app.shows("id:setup-done-edit-llm")).toBe(true);
});

/* ---------- repairs ---------- */

test("a repair of one step is not held up by a missing name", async () => {
  const integrity = { items: [{ key: "identity", stage: "persona", status: "malformed", path: "/state/identity.yaml" }] };
  const { state, api } = nameConsole(
    { configured: true, identity: { name: "Old", creature: "", vibe: "", emoji: "" }, soul: "# Soul" },
    { "GET /setup/integrity": { body: integrity } },
  );
  const { app } = await openConsole({ location: "/e/default/setup/persona?repair=identity", api });
  await app.waitFor("id:setup-stage-persona");
  await app.waitUntil(() => app.value("id:setup-persona-name") === "Old");
  expect(app.shows("id:setup-previous")).toBe(false);
  expect(state.consolePuts.length).toBe(0);
  // Anything else goes to troubleshooting, as before, and not to the name page.
  const other = await openConsole({ location: "/e/default/setup/user", api });
  await other.app.waitUntil(() => lastLocation(other.app).startsWith("/e/default/troubleshooting"));
  expect(other.app.shows("id:setup-stage-user")).toBe(false);
});

/* ---------- what the page accepts ---------- */

const PAGE_REFUSED: [string, string, RegExp][] = [
  ["spaces only", "   ", /not only spaces/],
  ["ideographic spaces only", "\u3000\u3000", /not only spaces/],
  ["81 characters", "x".repeat(81), /80 characters or fewer \(now 81\)/],
  ["81 emoji", "🙂".repeat(81), /80 characters or fewer \(now 81\)/],
  ["a tab inside", "Ada\tLovelace", /one line/],
  ["a control character inside", "Ada\u0007Lovelace", /one line/],
];

test("a name the server would refuse is refused on the page, with what to change, and is not sent", async () => {
  const { state, api } = nameConsole({ userName: "Prior" });
  const { app } = await openConsole({ location: "/e/default/setup/user", api });
  await app.waitFor("id:setup-stage-user");
  await app.waitUntil(() => app.value("id:setup-user-name") === "Prior");
  for (const [label, input, message] of PAGE_REFUSED) {
    await app.clear("id:setup-user-name");
    // An emptied field says nothing yet; it only cannot continue.
    await app.waitUntil(() => !app.shows("id:setup-user-name-error"));
    expect(`${label}: ${app.enabled("id:setup-submit")}`).toBe(`${label}: false`);
    await app.type("id:setup-user-name", input);
    await app.waitFor("id:setup-user-name-error");
    const said = app.texts().find((text) => message.test(text)) || "";
    expect(`${label}: ${message.test(said)}`).toBe(`${label}: true`);
    expect(`${label}: ${app.enabled("id:setup-submit")}`).toBe(`${label}: false`);
    // Enter does not get around the check, and what was typed stays, uncut.
    await app.keyboard.press("enter");
    expect(app.value("id:setup-user-name")).toBe(input);
  }
  expect(app.shows("id:setup-stage-user")).toBe(true);
  expect(state.consolePuts.length).toBe(0);
  expect(state.userName).toBe("Prior");

  // Exactly 80 is a name; the error goes as soon as the text is one.
  await app.clear("id:setup-user-name");
  await app.type("id:setup-user-name", EIGHTY_EMOJI);
  await app.waitUntil(() => !app.shows("id:setup-user-name-error") && app.enabled("id:setup-submit"));
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-llm");
  expect(state.userName).toBe(EIGHTY_EMOJI);
});

test("a name that looks like markup is saved and shown as the text it is", async () => {
  const markup = "<b>Bo</b> **x** `y` [z](http://a.test) <img src=x onerror=alert(1)>";
  const { state, api } = readyConsole();
  const { app } = await openConsole({ location: "/e/default/setup/user", api });
  await app.waitFor("id:setup-stage-user");
  await app.type("id:setup-user-name", markup);
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-llm");
  expect(state.consolePuts).toEqual([{ config_changes: { [NAME_KEY]: markup } }]);
  const done = await openConsole({ location: "/e/default/setup/done", api });
  await done.app.waitFor("id:setup-stage-done");
  // One text with every character, not formatted pieces of it.
  await done.app.waitUntil(() => done.app.texts().includes(markup));
  expect(done.app.count("id:setup-done-value-user")).toBe(1);
  await done.app.press("id:setup-done-edit-user");
  await done.app.waitUntil(() => done.app.value("id:setup-user-name") === markup);
});

/* ---------- when saving fails ---------- */

test("a failed save stays on the page with what was typed, says why, and can be tried again", async () => {
  const { state, api } = nameConsole({ userName: "Prior", saveError: "disk full" });
  const { app } = await openConsole({ location: "/e/default/setup/user", api });
  await app.waitFor("id:setup-stage-user");
  await app.waitUntil(() => app.value("id:setup-user-name") === "Prior");
  await app.clear("id:setup-user-name");
  await app.type("id:setup-user-name", "  Lyra the 2nd ");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-error >> text:disk full");
  expect(app.shows("id:setup-stage-user")).toBe(true);
  expect(lastLocation(app).startsWith("/e/default/setup/user")).toBe(true);
  expect(app.value("id:setup-user-name")).toBe("  Lyra the 2nd ");
  expect(state.userName).toBe("Prior");
  // Still failing: still here.
  await app.waitUntil(() => app.enabled("id:setup-submit"));
  await app.press("id:setup-submit");
  await app.waitUntil(() => state.consolePuts.length === 2);
  await app.waitFor("id:setup-error >> text:disk full");
  expect(app.shows("id:setup-stage-user")).toBe(true);
  // The server is back: the same Continue saves and goes on, and the error is gone.
  state.saveError = "";
  await app.waitUntil(() => app.enabled("id:setup-submit"));
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-llm");
  expect(state.userName).toBe("Lyra the 2nd");
  expect(app.shows("id:setup-error")).toBe(false);
  expect(state.consolePuts.length).toBe(3);
});

test("the server's own refusal of a name is shown, and nothing goes on", async () => {
  const { state, api } = nameConsole(
    { userName: "Prior" },
    { "PUT /settings/console": { status: 400, body: { error: "console.user_name: must be at most 80 characters" } } },
  );
  const { app } = await openConsole({ location: "/e/default/setup/user", api });
  await app.waitUntil(() => app.value("id:setup-user-name") === "Prior");
  await app.clear("id:setup-user-name");
  await app.type("id:setup-user-name", "Lyra");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-error >> text:/must be at most 80 characters/");
  expect(app.shows("id:setup-stage-user")).toBe(true);
  expect(app.value("id:setup-user-name")).toBe("Lyra");
  expect(state.userName).toBe("Prior");
});

test("an answer that does not confirm the saved name does not count as saved", async () => {
  const { api } = nameConsole({}, { "PUT /settings/console": { body: { ok: true } } });
  const { app } = await openConsole({ location: "/", api });
  await app.waitFor("id:setup-stage-user");
  await app.type("id:setup-user-name", "Lyra");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-error");
  expect(app.shows("id:setup-stage-user")).toBe(true);
  expect(app.value("id:setup-user-name")).toBe("Lyra");
});

test("a name that cannot be read shows the error on the form", async () => {
  let reads = 0;
  const { api } = readyConsole({ userName: "Lyra" });
  const me = api["GET /auth/me"];
  // The session's own reads work; the page's read of the name fails.
  api["GET /auth/me"] = (request: ApiRequest) => {
    reads += 1;
    return reads > 1 ? { status: 500, body: { error: "config unreadable" } } : me(request);
  };
  const { app } = await openConsole({ location: "/e/default/setup/user", api });
  await app.waitFor("id:setup-error >> text:config unreadable");
  expect(app.shows("id:setup-stage-user")).toBe(true);
});

test("the name is behind the session: signed out, the page is the login page", async () => {
  const { state, api } = nameConsole({ userName: "Lyra" });
  const { app, calls } = await openConsole({ location: "/e/default/setup/user", password: true, api });
  await app.waitFor("id:login-password");
  expect(app.shows("id:setup-stage-user")).toBe(false);
  expect(app.texts().includes("Lyra")).toBe(false);
  expect(calls.some((call) => call.path === "/settings/console")).toBe(false);
  // Signed in again, another client's change is there: the name is the Console's.
  state.userName = "Ming";
  await app.type("id:login-password", "secret");
  await app.press("role:button[Log in]");
  // With a name saved the unfinished Setup goes on at the model; the name is one step back.
  await app.waitFor("id:setup-stage-llm");
  await app.press("id:setup-previous");
  await app.waitFor("id:setup-stage-user");
  await app.waitUntil(() => app.value("id:setup-user-name") === "Ming");
});

/* ---------- other agents ---------- */

test("Setup of another agent saves the name to the Console, never to that agent", async () => {
  const REMOTE = "ep_remote_1";
  const { state, api } = readyConsole(
    {},
    {
      "GET /endpoints": {
        body: {
          items: [
            localEndpoint(),
            localEndpoint({ endpoint_ref: REMOTE, name: "Remote", agent_name: "Remy", url: "http://remote.test", mode: "serve", can_submit: false }),
          ],
        },
      },
    },
  );
  const { app, calls } = await openConsole({ location: `/e/${REMOTE}/setup`, api });
  // An agent that is not set up yet: its Setup starts with the Console's own question.
  await app.waitFor("id:setup-stage-user");
  expect(lastLocation(app).startsWith(`/e/${REMOTE}/setup/user`)).toBe(true);
  await app.type("id:setup-user-name", "Lyra");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-llm");
  expect(lastLocation(app).startsWith(`/e/${REMOTE}/setup/llm`)).toBe(true);
  expect(state.userName).toBe("Lyra");
  // The save went to the Console's own settings; nothing was proxied to an agent with the name.
  const saves = writes(calls);
  expect(saves.map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /settings/console"]);
  expect(calls.some((call) => call.uri !== undefined && `${call.url} ${call.body || ""}`.includes("Lyra"))).toBe(false);
  expect(state.identity?.name).toBe("Morph");
  expect(state.identityPuts.length).toBe(0);
  // Opening the other agent shows the same name.
  const local = await openConsole({ location: "/e/default/setup/done", api });
  await local.app.waitFor("id:setup-done-value-user >> text:Lyra");
});

/* ---------- languages and sizes ---------- */

const LANGUAGES: [string, string, string, string, string][] = [
  ["en", "What should we call you?", "Your name", "Continue", "Enter a name that is not only spaces."],
  ["zh", "应该如何称呼你？", "你的称呼", "继续", "请输入称呼，不能只有空格。"],
  ["ja", "何とお呼びすればよいですか？", "お名前", "続ける", "空白だけでなく、名前を入力してください。"],
];

for (const [lang, title, label, action, emptyError] of LANGUAGES) {
  test(`the name page in ${lang}: its question, label, action and error`, async () => {
    const { api } = nameConsole();
    const { app } = await openConsole({ location: "/", kv: { "quail-language": lang }, api });
    await app.waitFor("id:setup-stage-user");
    await app.waitFor(`text:${title}`);
    const texts = app.texts().map((text) => text.toLowerCase());
    expect(texts.includes(label.toLowerCase())).toBe(true);
    await app.waitFor(`id:setup-submit >> text:${action}`);
    await app.type("id:setup-user-name", "  ");
    await app.waitFor(`id:setup-user-name-error >> text:${emptyError}`);
  });
}

const SIZES = [
  { name: "a desktop window", width: 1280, height: 800, platform: undefined, colorScheme: "light" as const },
  { name: "a desktop window in dark mode", width: 1280, height: 800, platform: undefined, colorScheme: "dark" as const },
  { name: "a 390pt Android phone", width: 390, height: 844, platform: "android" as const, colorScheme: "light" as const },
  { name: "a 390pt Android phone in dark mode", width: 390, height: 844, platform: "android" as const, colorScheme: "dark" as const },
  { name: "a 360pt Android phone", width: 360, height: 740, platform: "android" as const, colorScheme: "light" as const },
  { name: "a 360pt iPhone-sized window", width: 360, height: 740, platform: "ios" as const, colorScheme: "dark" as const },
  { name: "a 390pt web window", width: 390, height: 844, platform: undefined, colorScheme: "light" as const },
];

for (const size of SIZES) {
  test(`on ${size.name} the name page takes a name from the keyboard and continues`, async () => {
    const { state, api } = nameConsole();
    const { app } = await openConsole({
      location: "/",
      width: size.width,
      height: size.height,
      platform: size.platform,
      colorScheme: size.colorScheme,
      api,
    });
    await app.waitFor("id:setup-stage-user");
    await app.waitFor("text:What should we call you?");
    expect(app.shows("id:setup-user-name")).toBe(true);
    expect(app.shows("id:setup-submit")).toBe(true);
    await app.type("id:setup-user-name", "山田 太郎 🎌");
    await app.keyboard.press("enter");
    await app.waitFor("id:setup-stage-llm");
    expect(state.userName).toBe("山田 太郎 🎌");
  });
}

/* ---------- where the name shows ---------- */

const TODO_API = (chatOptions: unknown[]) => ({
  "GET /proxy:/todo/tasks": {
    body: {
      tasks: [{ id: "task-1", title: "Review", content: "Original content", cron: "15 9 * * 1,3", tz: "UTC+9" }],
      system_tasks: [{ id: "__heartbeat__", cron: "*/30 * * * *" }],
      chat_options: chatOptions,
      llm_profiles: [],
      heartbeat_enabled: true,
      runs: [],
    },
  },
  "GET /proxy:/todo/runs": { body: { runs: [] } },
  "GET /proxy:/heartbeat/workflows": { body: { items: [] } },
});

const CHAT_OPTIONS = [
  { chat_id: "console:user", name: "Console User", platform: "console", type: "user" },
  { chat_id: "tg:42", name: "Family", platform: "telegram", type: "group" },
];

test("a TODO's Console destination is named for the user once a name is saved", async () => {
  const named = readyConsole({ userName: "小明 <b>🙂</b>" }, TODO_API(CHAT_OPTIONS));
  const { app } = await openConsole({ location: "/e/default/todo", api: named.api });
  await app.press("id:todo-item-task-1");
  await app.press("label:Notify Chat");
  await app.waitFor("text:小明 <b>🙂</b>");
  // The agent's and other chats' names are their own.
  await app.waitFor("text:Family");
  expect(app.texts().includes("Console User")).toBe(false);
});

for (const [label, userName] of [["no name is saved", ""], ["the server keeps no name", null]] as [string, string | null][]) {
  test(`a TODO's Console destination keeps its general label while ${label}`, async () => {
    const legacy = readyConsole({ userName }, TODO_API(CHAT_OPTIONS));
    const { app } = await openConsole({ location: "/e/default/todo", api: legacy.api });
    await app.press("id:todo-item-task-1");
    await app.press("label:Notify Chat");
    await app.waitFor("text:Console User");
    await app.waitFor("text:Family");
  });
}

test("a name saved in Setup shows at once, with no new login: the TODO destination follows it", async () => {
  const { state, api } = readyConsole({}, TODO_API(CHAT_OPTIONS));
  const { app, calls } = await openConsole({ location: "/e/default/setup/user", api });
  await app.waitFor("id:setup-stage-user");
  await app.type("id:setup-user-name", "Lyra");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-llm");
  expect(state.userName).toBe("Lyra");
  // On through the steps into the console, in the same session, and to the TODO page.
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-persona");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-soul");
  await app.press("id:setup-soul-cat");
  await app.waitFor("id:setup-soul-spotlight");
  await app.press("id:setup-submit");
  await app.waitFor("id:setup-stage-done");
  await app.waitFor("id:setup-done-value-user >> text:Lyra");
  await app.press("id:setup-enter-chat");
  await app.waitFor("id:nav-todo");
  await app.press("id:nav-todo");
  await app.press("id:todo-item-task-1");
  await app.press("label:Notify Chat");
  await app.waitFor("text:Lyra");
  expect(app.texts().includes("Console User")).toBe(false);
  expect(calls.filter((call) => call.path === "/auth/login").length).toBe(1);
  expect(calls.some((call) => call.path === "/auth/logout")).toBe(false);
  // The agent kept its own name through all of it.
  expect(state.identity?.name).toBe("Morph");
  expect(state.consolePuts).toEqual([{ config_changes: { [NAME_KEY]: "Lyra" } }]);
});
