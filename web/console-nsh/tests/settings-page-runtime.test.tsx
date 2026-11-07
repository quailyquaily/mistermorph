// Settings › Runtime: the agent's overview, its channels, and Poke.
import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const OVERVIEW = {
  version: "1.2.3",
  started_at: "2026-11-07T10:00:00Z",
  uptime_sec: 3725,
  health: "ok",
  mode: "console",
  agent_name: "Morph",
  poke_enabled: true,
  awareness_running: false,
  instance_id: "inst-1",
  llm: { provider: "openai", model: "gpt-5.2" },
  channel: { telegram_configured: true, telegram_running: true, x_configured: true, x_running: true, x_status: "reauth_needed" },
  runtime: { go_version: "go1.25", goroutines: 42, heap_alloc_bytes: 2048, heap_sys_bytes: 4096, heap_objects: 7, gc_cycles: 3 },
};

test("the runtime panel shows health, model, channels and metrics", async () => {
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: OVERVIEW } } });
  await app.waitFor("id:runtime-panel");
  await app.waitFor("Healthy");
  expect(app.shows("1h 2m")).toBe(true);
  expect(app.shows("gpt-5.2")).toBe(true);
  expect(app.shows("42")).toBe(true);
  expect(app.shows("id:runtime-channels >> text:Telegram")).toBe(true);
  // X's session needs a new login.
  expect(app.shows("Needs a new login")).toBe(true);
  // The technical details are folded.
  expect(app.shows("inst-1")).toBe(false);
  await app.press("id:runtime-technical-toggle");
  await app.waitFor("inst-1");
});

test("a failed overview says so", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    api: { "GET /proxy:/overview": { status: 502, body: { error: "agent unreachable" } } },
  });
  await app.waitFor("id:runtime-error");
  await app.waitFor("agent unreachable");
  expect(app.shows("id:runtime-poke")).toBe(false);
});

test("Poke sends the message; a 400 shows in the dialog", async () => {
  const bodies: string[] = [];
  let reject = true;
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    api: {
      "GET /proxy:/overview": { body: OVERVIEW },
      "POST /proxy:/poke": (request) => {
        bodies.push(String(request.body || ""));
        if (reject) {
          reject = false;
          return { status: 400, body: { error: "awareness is busy" } };
        }
        return { body: { poked_at: "2026-11-07T11:00:00Z" } };
      },
    },
  });
  await app.waitFor("id:runtime-poke");
  await app.press("id:runtime-poke");
  await app.waitFor("id:runtime-poke-dialog");
  expect(app.enabled("id:runtime-poke-submit")).toBe(false);
  await app.type("id:runtime-poke-body", "check the inbox");
  await app.press("id:runtime-poke-submit");
  await app.waitFor("awareness is busy");
  await app.press("id:runtime-poke-submit");
  await app.waitFor("id:runtime-poke-dialog", { state: "gone" });
  expect(bodies).toEqual(["check the inbox", "check the inbox"]);
});
