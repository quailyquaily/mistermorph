// The MCP servers and connected agents panels (MCPSettingsPanel.tsx, ConsoleEndpointsPanel.tsx),
// and the console password (ConsolePasswordPanel.tsx).
import { expect, test } from "nsh/test";
import { openFixture } from "./fixtures/integrations-harness";

const GITHUB = { _key: "k-1", name: "github", enable: true, type: "http", url: "https://mcp.github.example/mcp", header_rows: [] };
const FILES = { _key: "k-2", name: "files", enable: false, type: "stdio", command: "node", args_text: "server.js", on_demand: true };

test("MCP: an empty list says so; adding a server validates it, then saves the list", async () => {
  const { app, eventsNamed } = await openFixture({ view: "mcp" });
  await app.waitFor("No MCP servers");
  await app.press("id:mcp-add");
  await app.waitFor("id:mcp-pane");
  expect(eventsNamed("mcp.pane").at(-1)?.data).toBe(true);
  // A new server can be saved at once, which shows what is missing.
  await app.press("id:mcp-save");
  await app.waitFor("Every MCP server needs a name.");
  await app.type("id:mcp-name", "tools");
  await app.waitFor("Unsaved changes");
  await app.press("id:mcp-save");
  await app.waitFor('MCP server "tools" needs a command.');
  await app.type("id:mcp-command", "npx");
  await app.press("id:mcp-add-variable");
  await app.press("id:mcp-save");
  await app.waitFor('MCP server "tools" has an entry without a name.');
  await app.type("label:Variable name", "TOKEN");
  await app.type("label:Value or ${ENV_NAME}", "${GH_TOKEN}");
  await app.press("id:mcp-save");
  await app.waitUntil(() => eventsNamed("mcp.save").length === 1);
  const saved = eventsNamed("mcp.save")[0].data;
  expect(saved.length).toBe(1);
  expect(saved[0]).toMatchObject({
    name: "tools",
    enable: true,
    type: "stdio",
    command: "npx",
    env_rows: [{ key: "TOKEN", value: "${GH_TOKEN}" }],
  });
  // The pane stays on the saved server, now with Delete.
  await app.waitFor("Delete Server");
  await app.waitFor("id:mcp-save", { state: "gone" });
});

test("MCP: the switch saves at once; editing switches the transport; delete removes the server", async () => {
  const { app, eventsNamed } = await openFixture({ view: "mcp", params: { servers: [GITHUB, FILES] } });
  await app.waitFor("text:https://mcp.github.example/mcp");
  expect(app.texts()).toContain("Loads on demand: $mcp_files");
  await app.press("id:mcp-enable-1");
  await app.waitUntil(() => eventsNamed("mcp.save").length === 1);
  expect(eventsNamed("mcp.save")[0].data[1].enable).toBe(true);

  await app.press("label:github");
  await app.waitFor("id:mcp-pane");
  expect(app.value("id:mcp-url")).toBe("https://mcp.github.example/mcp");
  await app.press("Local process");
  await app.waitFor("id:mcp-command");
  await app.press("id:mcp-save");
  await app.waitFor('MCP server "github" needs a command.');
  await app.press("HTTP");
  await app.waitFor("id:mcp-url");
  // Back as it was: nothing to save.
  await app.waitFor("id:mcp-save", { state: "gone" });
  await app.press("Delete Server");
  await app.waitUntil(() => eventsNamed("mcp.save").length === 2);
  expect(eventsNamed("mcp.save")[1].data.map((server: { name: string }) => server.name)).toEqual(["files"]);
  await app.waitFor("id:mcp-pane", { state: "gone" });
  expect(eventsNamed("mcp.pane").at(-1)?.data).toBe(false);
});

test("MCP: a duplicate name is refused; pressing the open server again closes its pane", async () => {
  const { app, eventsNamed } = await openFixture({ view: "mcp", params: { servers: [GITHUB, FILES] } });
  await app.press("label:files");
  await app.waitFor("id:mcp-pane");
  await app.clear("id:mcp-name");
  await app.type("id:mcp-name", "GitHub");
  await app.press("id:mcp-save");
  await app.waitFor('MCP server name "GitHub" is duplicated.');
  expect(eventsNamed("mcp.save").length).toBe(0);
  await app.press("label:files");
  await app.waitFor("id:mcp-pane", { state: "gone" });
});

test("MCP: read-only shows why and blocks adding; the page's validation error shows", async () => {
  const readOnly = await openFixture({ view: "mcp", params: { servers: [GITHUB], readOnly: true } });
  await readOnly.app.waitFor("Settings are read-only.");
  expect(readOnly.app.enabled("id:mcp-add")).toBe(false);
  const invalid = await openFixture({ view: "mcp", params: { servers: [GITHUB], validationError: "MCP config is invalid" } });
  await invalid.app.waitFor("MCP config is invalid");
});

test("MCP: blocked by another save of the same settings, nothing changes and nothing saves", async () => {
  // Settings' SKILLs & MCP page blocks the servers while its Load skills saves.
  const { app, eventsNamed } = await openFixture({ view: "mcp", params: { servers: [GITHUB], blocked: true } });
  await app.waitFor("text:https://mcp.github.example/mcp");
  expect(app.enabled("id:mcp-add")).toBe(false);
  expect(app.enabled("id:mcp-enable-0")).toBe(false);
  expect(app.enabled("label:github")).toBe(false);
  expect(eventsNamed("mcp.save").length).toBe(0);
});

test("MCP: with a pane target the server opens in the page's pane column", async () => {
  const { app } = await openFixture({ view: "mcp", params: { servers: [GITHUB], outlet: true } });
  await app.press("label:github");
  await app.waitFor("id:mcp-pane");
  await app.press("label:Close");
  await app.waitFor("id:mcp-pane", { state: "gone" });
});

const AGENTS = [
  { name: "lab", url: "https://lab.example/runtime", auth_token_configured: true },
  { name: "home", url: "https://home.example/runtime", auth_token_configured: true },
];

test("Agents: the list shows each status; an empty list says so", async () => {
  const empty = await openFixture({ view: "endpoints" });
  await empty.app.waitFor("id:console-endpoints-empty");
  const { app } = await openFixture({
    view: "endpoints",
    params: {
      endpoints: AGENTS,
      runtimeEndpoints: [
        { name: "lab", url: "https://lab.example/runtime", connected: true },
        { name: "home", url: "https://home.example/runtime", connected: false },
      ],
    },
  });
  await app.waitFor("Online");
  expect(app.texts()).toContain("Offline");
  expect(app.texts()).toContain("https://home.example/runtime");
});

test("Agents: adding one needs a name, a URL and a token, then saves the whole list", async () => {
  const { app, eventsNamed } = await openFixture({ view: "endpoints", params: { endpoints: AGENTS } });
  await app.press("id:console-endpoint-add");
  await app.waitFor("id:console-endpoint-pane");
  expect(app.enabled("id:console-endpoint-save")).toBe(false);
  await app.type("id:console-endpoint-name", "office");
  await app.type("id:console-endpoint-url", "https://office.example/runtime");
  expect(app.enabled("id:console-endpoint-save")).toBe(false);
  await app.type("id:console-endpoint-token", "secret-token");
  await app.press("id:console-endpoint-save");
  await app.waitUntil(() => eventsNamed("endpoints.save").length === 1);
  expect(eventsNamed("endpoints.save")[0].data).toEqual([
    { original_name: "lab", name: "lab", url: "https://lab.example/runtime", auth_token: "" },
    { original_name: "home", name: "home", url: "https://home.example/runtime", auth_token: "" },
    { original_name: "", name: "office", url: "https://office.example/runtime", auth_token: "secret-token" },
  ]);
  // Saved: the pane stays on the new agent, with nothing left to save.
  await app.waitFor("Remove agent");
  await app.waitFor("id:console-endpoint-save", { state: "gone" });
});

test("Agents: a failed save shows the error in the pane", async () => {
  const { app } = await openFixture({ view: "endpoints", params: { endpoints: AGENTS, failSave: "connection test failed" } });
  await app.press("label:Edit lab");
  await app.waitFor("id:console-endpoint-pane");
  await app.clear("id:console-endpoint-url");
  await app.type("id:console-endpoint-url", "https://lab2.example/runtime");
  await app.press("id:console-endpoint-save");
  await app.waitFor("connection test failed");
});

test("Agents: removing asks first, and a failed remove keeps the dialog with the error", async () => {
  const ok = await openFixture({ view: "endpoints", params: { endpoints: AGENTS } });
  await ok.app.press("label:Edit home");
  await ok.app.press("id:console-endpoint-remove");
  await ok.app.waitFor("Remove “home” from this Console? The agent will keep running.");
  await ok.app.press("id:console-endpoint-remove-confirm");
  await ok.app.waitUntil(() => ok.eventsNamed("endpoints.save").length === 1);
  expect(ok.eventsNamed("endpoints.save")[0].data.map((item: { name: string }) => item.name)).toEqual(["lab"]);
  await ok.app.waitFor("id:console-endpoint-remove-dialog", { state: "gone" });
  await ok.app.waitFor("id:console-endpoint-pane", { state: "gone" });

  const failing = await openFixture({ view: "endpoints", params: { endpoints: AGENTS, failSave: "agent is busy" } });
  await failing.app.press("label:Edit lab");
  await failing.app.press("id:console-endpoint-remove");
  await failing.app.press("id:console-endpoint-remove-confirm");
  await failing.app.waitFor("id:console-endpoint-remove-error");
  expect(failing.app.texts()).toContain("agent is busy");
});

test("Agents: the page's Add request opens the add pane once", async () => {
  const { app, eventsNamed } = await openFixture({ view: "endpoints", params: { endpoints: AGENTS, addRequested: true } });
  await app.waitFor("id:console-endpoint-pane");
  expect(eventsNamed("endpoints.addOpened").length).toBe(1);
  expect(eventsNamed("endpoints.pane").at(-1)?.data).toBe(true);
});

test("Password: empty and mismatched passwords are refused; a match saves", async () => {
  const { app, eventsNamed } = await openFixture({ view: "password", params: { configured: true } });
  await app.press("Change password");
  await app.waitFor("id:console-password-dialog");
  await app.press("Save");
  await app.waitFor("Password cannot be empty.");
  await app.type("id:console-password-new", "hunter22");
  await app.type("id:console-password-confirm", "hunter23");
  await app.press("Save");
  await app.waitFor("Passwords do not match.");
  await app.clear("id:console-password-confirm");
  await app.type("id:console-password-confirm", "hunter22");
  await app.press("Save");
  await app.waitUntil(() => eventsNamed("password.save").length === 1);
  expect(eventsNamed("password.save")[0].data).toEqual({ new_password: "hunter22" });
  await app.waitFor("id:console-password-dialog", { state: "gone" });
  // Reopened, it starts empty.
  await app.press("Change password");
  expect(app.value("id:console-password-new")).toBe("");
});
