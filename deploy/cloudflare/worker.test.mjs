import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

function loadWorker(env = {}) {
  const calls = [];
  const storage = new Map();
  class Container {
    // The real SDK initializes this own property, which shadows subclass getters.
    envVars = {};
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    async start() { calls.push("start"); }
    async stop() { calls.push("stop"); }
    async getState() { return { status: "running" }; }
    renewActivityTimeout() { calls.push("renew"); }
    async fetch(request) { calls.push(request); return new Response("console"); }
  }
  const ctx = { storage: {
    async get(key) { return storage.get(key); },
    async put(key, value) { storage.set(key, value); },
  } };
  let instance;
  const context = vm.createContext({
    Container, URL, Request, Response, console, workerEnv: env,
    getContainer(_binding, name) { calls.push({ instance: name }); return instance; },
  });
  const source = fs.readFileSync(new URL("./src/index.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export class MisterMorphContainer", "class MisterMorphContainer")
    .replace("export default", "globalThis.worker =");
  vm.runInContext(source + "\nglobalThis.ContainerClass = MisterMorphContainer;", context);
  instance = new context.ContainerClass(ctx, env);
  return {
    instance, calls,
    fetch(path, init) {
      return context.worker.fetch(new Request(`https://console.example${path}`, init), {
        ...env, MISTER_MORPH_CONTAINER: {},
      });
    },
    scheduled() { return context.worker.scheduled({}, { ...env, MISTER_MORPH_CONTAINER: {} }); },
  };
}

const configured = {
  MISTER_MORPH_CONSOLE_PASSWORD: "test-password",
  MISTER_MORPH_SERVER_AUTH_TOKEN: "test-admin-token",
};

test("container receives secrets and runtime overrides through an own envVars field", () => {
  const { instance } = loadWorker({
    ...configured, MISTER_MORPH_LLM_API_KEY: "test-llm-key",
    MISTER_MORPH_LLM_INFERENCE_PROVIDER: "anthropic",
    MISTER_MORPH_CONFIG_YAML: "llm:\n  model: example\n",
    CLOUDFLARE_API_TOKEN: "deployment-only",
  });
  assert.equal(instance.envVars.MISTER_MORPH_CONSOLE_PASSWORD, configured.MISTER_MORPH_CONSOLE_PASSWORD);
  assert.equal(instance.envVars.MISTER_MORPH_LLM_API_KEY, "test-llm-key");
  assert.equal(instance.envVars.MISTER_MORPH_LLM_INFERENCE_PROVIDER, "anthropic");
  assert.equal(instance.envVars.MISTER_MORPH_CONFIG_YAML, "llm:\n  model: example\n");
  assert.equal(instance.envVars.CLOUDFLARE_API_TOKEN, undefined);
});

test("missing Console authentication fails before allocating a container", async () => {
  for (const password of [undefined, "", "   "]) {
    const app = loadWorker({ MISTER_MORPH_CONSOLE_PASSWORD: password });
    assert.equal((await app.fetch("/")).status, 503);
    assert.equal(app.calls.length, 0);
  }
});

test("Console login and assets reach the singleton with original request data", async () => {
  const app = loadWorker(configured);
  const response = await app.fetch("/api/auth/login?next=chat", {
    method: "POST", body: '{"password":"example"}', headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  assert.equal(app.calls[0].instance, "default");
  const upstream = app.calls.find(value => value instanceof Request);
  assert.equal(upstream.url, "https://console.example/api/auth/login?next=chat");
  assert.equal(await upstream.text(), '{"password":"example"}');
});

test("clients cannot allocate additional instances", async () => {
  const app = loadWorker(configured);
  assert.equal((await app.fetch("/?instance=other")).status, 400);
  assert.equal(app.calls.length, 0);
});

test("admin routes fail closed and require the correct method", async () => {
  for (const env of [configured, { MISTER_MORPH_CONSOLE_PASSWORD: "test-password" }]) {
    const app = loadWorker(env);
    for (const path of ["start", "stop", "state", "lifecycle"]) {
      assert.equal((await app.fetch(`/_mistermorph/${path}`)).status, 401);
    }
    assert.equal(app.calls.length, 0);
  }
  const app = loadWorker(configured);
  const headers = { authorization: "Bearer test-admin-token" };
  assert.equal((await app.fetch("/_mistermorph/stop", { headers })).status, 405);
  assert.equal(app.calls.length, 0);
  assert.equal((await app.fetch("/_mistermorph/start", { method: "POST", headers })).status, 200);
  assert.ok(app.calls.includes("start"));
});

test("idle expiry keeps Console alive; cron recovers a stopped instance", async () => {
  const app = loadWorker(configured);
  await app.instance.onActivityExpired();
  assert.ok(app.calls.includes("renew"));
  assert.ok(!app.calls.includes("stop"));
  await app.scheduled();
  assert.ok(app.calls.includes("start"));
});

test("administrative stop stays stopped across cron and browser requests", async () => {
  const app = loadWorker(configured);
  const init = { method: "POST", headers: { authorization: "Bearer test-admin-token" } };
  assert.equal((await app.fetch("/_mistermorph/stop", init)).status, 200);
  app.calls.length = 0;
  await app.scheduled();
  assert.ok(!app.calls.includes("start"));
  assert.equal((await app.fetch("/")).status, 503);
  await app.fetch("/_mistermorph/start", init);
  assert.equal((await app.fetch("/")).status, 200);
});
