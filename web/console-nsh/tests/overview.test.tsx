// The overview: every agent, its state and readout, masked addresses, and where each node goes.
import { expect, test } from "nsh/test";
import { localEndpoint, openConsole } from "./harness";

function lastLocation(app: { host: { calls(): { name: string; data: any }[] } }) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return String(writes.at(-1)?.data?.url || "");
}

const REMOTE = {
  endpoint_ref: "ep_remote",
  name: "",
  url: "https://agent.example.com:8443",
  connected: true,
  agent_name: "",
  mode: "console",
  can_submit: true,
  avatar_url: "",
};
const OFFLINE = { ...REMOTE, endpoint_ref: "ep_offline", url: "https://sleepy.example.com", connected: false, agent_name: "Sleepy" };
const CHECKING = {
  ...REMOTE,
  endpoint_ref: "ep_checking",
  url: "https://slow.example.com",
  connected: false,
  health_pending: true,
  agent_name: "Slowpoke",
};

test("the overview lists the console and its agents, with readouts for the online ones", async () => {
  const { app } = await openConsole({
    location: "/overview",
    endpoints: [localEndpoint(), REMOTE, OFFLINE, CHECKING],
    api: {
      "GET /proxy:/overview": {
        body: { health: "ok", uptime_sec: 3700, llm: { model: "gpt-test" }, channel: { telegram_running: true } },
      },
      "GET /proxy:/stats/llm/usage": {
        body: { summary: { requests: 42, total_tokens: 12345, total_cost: 1.5, input_tokens: 1000, cached_input_tokens: 500 } },
      },
    },
  });
  await app.waitFor("id:overview-page");
  await app.waitFor("id:overview-node-ep_console_local");
  await app.waitFor("text:Current console");
  await app.waitFor("text:Sleepy");
  await app.waitFor("text:Slowpoke");
  await app.waitFor("label:Checking connection");
  // An agent without a name shows its address, masked until asked.
  await app.waitFor("label:Address hidden");
  // Readouts for the console and the online agent.
  await app.waitUntil(() => app.count("id:overview-readout") === 2);
  await app.waitFor("text:gpt-test >> nth=0");
  await app.waitFor("label:42 >> nth=0");
  await app.waitFor("label:50% >> nth=0");
  await app.waitFor("label:1h 01m >> nth=0");
  // The address toggle unmasks, and is remembered.
  await app.press("id:overview-address-toggle");
  await app.waitUntil(() =>
    app.host
      .calls()
      .some((call) => call.name === "morph.kv.set" && (call.data as any)?.key === "mistermorph_console_overview_show_addresses" && (call.data as any)?.value === "true"),
  );
  await app.waitFor("id:overview-node-ep_remote", { timeout: 2000 });
  expect(app.shows("label:Address hidden")).toBe(false);
});

test("an online agent opens its chat; offline ones do not open", async () => {
  const { app } = await openConsole({ location: "/overview", endpoints: [localEndpoint(), { ...REMOTE, agent_name: "Atlas" }, OFFLINE] });
  await app.waitFor("id:overview-node-ep_offline");
  await expect(app.press("id:overview-node-ep_offline")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(lastLocation(app)).toBe("/overview");
  await app.press("id:overview-node-ep_remote");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/ep_remote/chat"));
});

test("Add Agent opens the console's endpoint settings", async () => {
  const { app } = await openConsole({ location: "/overview" });
  await app.waitFor("id:overview-add");
  await app.press("id:overview-add");
  await app.waitUntil(() => lastLocation(app).startsWith("/e/default/settings/console"));
  expect(lastLocation(app)).toContain("add=agent");
});

test("with no endpoints the overview says so", async () => {
  const { app } = await openConsole({ location: "/overview", endpoints: [] });
  await app.waitFor("id:overview-empty");
  await app.waitFor("text:No endpoints");
  expect(app.shows("id:overview-address-toggle")).toBe(false);
});

test("a failed endpoint list shows its error", async () => {
  const { app } = await openConsole({
    location: "/overview",
    api: { "GET /endpoints": { status: 500, body: { error: "endpoints unavailable" } } },
  });
  await app.waitFor("text:endpoints unavailable");
  expect(app.shows("id:overview-empty")).toBe(false);
});

test("a remembered choice shows addresses from the start", async () => {
  const { app } = await openConsole({
    location: "/overview",
    endpoints: [localEndpoint(), REMOTE],
    kv: { mistermorph_console_overview_show_addresses: "true" },
  });
  await app.waitFor("id:overview-node-ep_remote");
  expect(app.shows("label:Address hidden")).toBe(false);
});
