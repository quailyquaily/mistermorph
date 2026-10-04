import { Container, getContainer } from "@cloudflare/containers";

const INSTANCE_NAME = "default";
const ADMIN_PREFIX = "/_mistermorph/";
const PAUSED_KEY = "mistermorph:paused";
const LIFECYCLE_KEY = "mistermorph:lifecycle";

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasConsolePassword(env) {
  return nonempty(env.MISTER_MORPH_CONSOLE_PASSWORD) || nonempty(env.MISTER_MORPH_CONSOLE_PASSWORD_HASH);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export class MisterMorphContainer extends Container {
  defaultPort = 8787;
  sleepAfter = "15m";
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    // Assign an own field: the SDK's envVars field would shadow a getter.
    this.envVars = {};
    for (const key of [
      "MISTER_MORPH_CONSOLE_PASSWORD",
      "MISTER_MORPH_CONSOLE_PASSWORD_HASH",
      "MISTER_MORPH_SERVER_AUTH_TOKEN",
      "MISTER_MORPH_CONFIG_YAML",
      "MISTER_MORPH_LLM_API_KEY",
      "MISTER_MORPH_LLM_INFERENCE_PROVIDER",
      "MISTER_MORPH_LLM_PROVIDER",
      "MISTER_MORPH_LLM_ENDPOINT",
      "MISTER_MORPH_LLM_MODEL",
      "MISTER_MORPH_LOG_LEVEL",
      "MISTER_MORPH_TOOLS_BASH_ENABLED",
      "MISTER_MORPH_ALLOW_EPHEMERAL_STATE",
      "MISTER_MORPH_R2_ACCOUNT_ID",
      "MISTER_MORPH_R2_BUCKET",
      "MISTER_MORPH_R2_PREFIX",
      "MISTER_MORPH_R2_ACCESS_KEY_ID",
      "MISTER_MORPH_R2_SECRET_ACCESS_KEY",
      "MISTER_MORPH_R2_BACKUP_INTERVAL",
    ]) {
      if (nonempty(env[key])) this.envVars[key] = env[key];
    }
  }

  async lifecycle() {
    return (await this.ctx.storage.get(LIFECYCLE_KEY)) || {};
  }

  async onStart() {
    const previous = await this.lifecycle();
    await this.ctx.storage.put(LIFECYCLE_KEY, { ...previous, lastStartAt: Date.now() });
  }

  async onStop(reason) {
    const previous = await this.lifecycle();
    await this.ctx.storage.put(LIFECYCLE_KEY, { ...previous, lastStopAt: Date.now(), lastStop: reason });
  }

  // Console may run background tasks and channel connections without HTTP traffic.
  async onActivityExpired() {
    this.renewActivityTimeout();
  }

  async keepAlive() {
    if (!(await this.ctx.storage.get(PAUSED_KEY))) await this.start();
  }

  async resume() {
    await this.ctx.storage.put(PAUSED_KEY, false);
    await this.start();
  }

  async pause() {
    await this.ctx.storage.put(PAUSED_KEY, true);
    await this.stop();
  }

  async fetch(request) {
    if (await this.ctx.storage.get(PAUSED_KEY)) {
      return jsonResponse({ error: "console is stopped by the administrator" }, 503);
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const instance = url.searchParams.get("instance");
    if (instance && instance !== INSTANCE_NAME) {
      return jsonResponse({ error: "only the default Console instance is supported" }, 400);
    }

    const admin = url.pathname.startsWith(ADMIN_PREFIX);
    if (admin) {
      const token = env.MISTER_MORPH_SERVER_AUTH_TOKEN;
      const actual = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!nonempty(token) || actual !== token) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const method = { start: "POST", stop: "POST", state: "GET", lifecycle: "GET" }[url.pathname.slice(ADMIN_PREFIX.length)];
      if (!method) return jsonResponse({ error: "not found" }, 404);
      if (request.method !== method) {
        return new Response(null, { status: 405, headers: { Allow: method } });
      }
      // No public hard-destroy endpoint: shutdown must let Console flush its state.
      if (url.searchParams.has("hard")) {
        return jsonResponse({ error: "hard stop is not supported" }, 400);
      }
    }
    if (!hasConsolePassword(env)) {
      return jsonResponse({ error: "Console password is not configured" }, 503);
    }
    if (!env.MISTER_MORPH_CONTAINER) {
      return jsonResponse({ error: "missing container binding" }, 503);
    }
    const container = getContainer(env.MISTER_MORPH_CONTAINER, INSTANCE_NAME);
    if (admin) {
      const action = url.pathname.slice(ADMIN_PREFIX.length);
      if (action === "start") await container.resume();
      if (action === "stop") await container.pause();
      const state = await container.getState();
      const lifecycle = action === "lifecycle" ? await container.lifecycle() : undefined;
      return jsonResponse({ ok: true, mode: "console", instance: INSTANCE_NAME, state, lifecycle });
    }
    // Console authenticates browser sessions and runtime API requests itself.
    // Login and static assets must remain reachable before a browser has a session.
    url.searchParams.delete("instance");
    return container.fetch(new Request(url.toString(), request));
  },

  async scheduled(_event, env) {
    if (!hasConsolePassword(env)) throw new Error("Console password is not configured");
    await getContainer(env.MISTER_MORPH_CONTAINER, INSTANCE_NAME).keepAlive();
  },
};
