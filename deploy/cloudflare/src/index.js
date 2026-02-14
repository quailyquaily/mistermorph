import { Container, getContainer } from "@cloudflare/containers";
import { env as workerEnv } from "cloudflare:workers";

const DEFAULT_INSTANCE_NAME = "default";
const INSTANCE_PARAM = "instance";
const ADMIN_PREFIX = "/_mistermorph";
const LIFECYCLE_STATE_KEY = "mistermorph:lifecycle";

function sanitizeInstanceName(value) {
  if (!value) {
    return DEFAULT_INSTANCE_NAME;
  }
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const compact = normalized.replace(/-+/g, "-").slice(0, 63).replace(/^-|-$/g, "");
  return compact || DEFAULT_INSTANCE_NAME;
}

function optionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function readBearerToken(request) {
  const auth = request.headers.get("authorization");
  if (!auth) {
    return null;
  }
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const token = match[1].trim();
  return token || null;
}

function isAdminAuthorized(request) {
  const expected = optionalString(workerEnv.MISTER_MORPH_SERVER_AUTH_TOKEN);
  if (!expected) {
    return true;
  }
  const actual = readBearerToken(request);
  return actual === expected;
}

function requireAdminAuth(request) {
  if (isAdminAuthorized(request)) {
    return null;
  }
  return jsonResponse({ ok: false, error: "unauthorized" }, 401);
}

function stringifyUnknown(value) {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(value, maxLen = 240) {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length <= maxLen) {
    return value;
  }
  return value.slice(0, maxLen) + "...";
}

async function telegramGetMe(token) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const raw = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: truncateText(raw),
    };
  }
  try {
    const payload = JSON.parse(raw);
    if (!payload?.ok) {
      return {
        ok: false,
        status: resp.status,
        error: truncateText(payload?.description || raw),
      };
    }
    return {
      ok: true,
      status: resp.status,
      bot: {
        id: payload?.result?.id ?? null,
        username: payload?.result?.username ?? null,
      },
    };
  } catch {
    return {
      ok: false,
      status: resp.status,
      error: "invalid telegram getMe response",
      raw: truncateText(raw),
    };
  }
}

export class MisterMorphContainer extends Container {
  defaultPort = 8787;
  sleepAfter = "15m";
  enableInternet = true;

  async readLifecycle() {
    const data = await this.ctx.storage.get(LIFECYCLE_STATE_KEY);
    if (data && typeof data === "object") {
      return data;
    }
    return {};
  }

  async writeLifecycle(patch) {
    const cur = await this.readLifecycle();
    const next = {
      ...cur,
      ...patch,
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(LIFECYCLE_STATE_KEY, next);
    return next;
  }

  async lifecycle() {
    return this.readLifecycle();
  }

  async onStart() {
    console.log("mistermorph_container_start");
    const cur = await this.readLifecycle();
    const starts = Number(cur?.starts) || 0;
    return this.writeLifecycle({
      starts: starts + 1,
      lastStartAt: Date.now(),
    });
  }

  onStop(reason) {
    console.warn("mistermorph_container_stop", stringifyUnknown(reason));
    return this.writeLifecycle({
      lastStopAt: Date.now(),
      lastStop: reason,
    });
  }

  onError(error) {
    console.error("mistermorph_container_error", stringifyUnknown(error));
    return this.writeLifecycle({
      lastErrorAt: Date.now(),
      lastError: stringifyUnknown(error),
    });
  }

  get envVars() {
    const stateDir = optionalString(workerEnv.MISTER_MORPH_FILE_STATE_DIR) || "/tmp/mistermorph/state";
    const cacheDir = optionalString(workerEnv.MISTER_MORPH_FILE_CACHE_DIR) || "/tmp/mistermorph/cache";
    const vars = {
      MISTER_MORPH_LOG_FORMAT: "json",
      MISTER_MORPH_FILE_STATE_DIR: stateDir,
      MISTER_MORPH_FILE_CACHE_DIR: cacheDir,
      MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL: "1",
    };

    const optionalKeys = [
      "MISTER_MORPH_LLM_PROVIDER",
      "MISTER_MORPH_LLM_ENDPOINT",
      "MISTER_MORPH_LLM_MODEL",
      "MISTER_MORPH_LOG_LEVEL",
      "MISTER_MORPH_TOOLS_BASH_ENABLED",
      "MISTER_MORPH_RUN_MODE",
      "MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL",
      "MISTER_MORPH_LLM_API_KEY",
      "MISTER_MORPH_SERVER_AUTH_TOKEN",
      "MISTER_MORPH_TELEGRAM_BOT_TOKEN",
    ];
    for (const key of optionalKeys) {
      const value = optionalString(workerEnv[key]);
      if (value) {
        vars[key] = value;
      }
    }

    return vars;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const instanceName = sanitizeInstanceName(url.searchParams.get(INSTANCE_PARAM));
    const runMode = optionalString(workerEnv.MISTER_MORPH_RUN_MODE) || "serve";
    if (!env.MISTER_MORPH_CONTAINER) {
      return jsonResponse(
        {
          ok: false,
          error: "missing durable object binding: MISTER_MORPH_CONTAINER",
          hint: "Check wrangler env.* durable_objects + containers config.",
        },
        500
      );
    }
    const container = getContainer(env.MISTER_MORPH_CONTAINER, instanceName);

    if (url.pathname === `${ADMIN_PREFIX}/start`) {
      const unauthorized = requireAdminAuth(request);
      if (unauthorized) return unauthorized;
      await container.start();
      const state = await container.getState();
      return jsonResponse({ ok: true, mode: runMode, instance: instanceName, state });
    }

    if (url.pathname === `${ADMIN_PREFIX}/stop`) {
      const unauthorized = requireAdminAuth(request);
      if (unauthorized) return unauthorized;
      const hard = ["1", "true", "yes"].includes((url.searchParams.get("hard") || "").toLowerCase());
      if (hard) {
        await container.destroy();
      } else {
        await container.stop();
      }
      const [state, lifecycle] = await Promise.all([
        container.getState(),
        container.lifecycle(),
      ]);
      return jsonResponse({
        ok: true,
        mode: runMode,
        instance: instanceName,
        action: hard ? "destroy" : "stop",
        state,
        lifecycle,
      });
    }

    if (url.pathname === `${ADMIN_PREFIX}/state`) {
      const unauthorized = requireAdminAuth(request);
      if (unauthorized) return unauthorized;
      const state = await container.getState();
      return jsonResponse({ ok: true, mode: runMode, instance: instanceName, state });
    }

    if (url.pathname === `${ADMIN_PREFIX}/lifecycle`) {
      const unauthorized = requireAdminAuth(request);
      if (unauthorized) return unauthorized;
      const [state, lifecycle] = await Promise.all([
        container.getState(),
        container.lifecycle(),
      ]);
      return jsonResponse({
        ok: true,
        mode: runMode,
        instance: instanceName,
        state,
        lifecycle,
      });
    }

    if (url.pathname === `${ADMIN_PREFIX}/preflight`) {
      const unauthorized = requireAdminAuth(request);
      if (unauthorized) return unauthorized;
      const checks = [];
      const issues = [];

      const llmKey = optionalString(workerEnv.MISTER_MORPH_LLM_API_KEY);
      checks.push({
        key: "MISTER_MORPH_LLM_API_KEY",
        present: Boolean(llmKey),
      });
      if (!llmKey) {
        issues.push("missing MISTER_MORPH_LLM_API_KEY");
      }

      if (runMode === "telegram") {
        const tgToken = optionalString(workerEnv.MISTER_MORPH_TELEGRAM_BOT_TOKEN);
        checks.push({
          key: "MISTER_MORPH_TELEGRAM_BOT_TOKEN",
          present: Boolean(tgToken),
        });
        if (!tgToken) {
          issues.push("missing MISTER_MORPH_TELEGRAM_BOT_TOKEN");
        } else {
          const tg = await telegramGetMe(tgToken);
          checks.push({
            key: "telegram.getMe",
            ...tg,
          });
          if (!tg.ok) {
            issues.push(`telegram getMe failed: ${tg.error || "unknown error"}`);
          }
        }
      }

      return jsonResponse({
        ok: issues.length === 0,
        mode: runMode,
        instance: instanceName,
        checks,
        issues,
      });
    }

    if (runMode === "telegram") {
      await container.start();
      const state = await container.getState();
      return jsonResponse(
        {
          ok: true,
          mode: runMode,
          instance: instanceName,
          state,
          message: "Container is running in telegram mode. Use Telegram bot to interact.",
        },
        202
      );
    }

    url.searchParams.delete(INSTANCE_PARAM);
    const upstreamRequest = new Request(url.toString(), request);

    return container.fetch(upstreamRequest);
  },
};
