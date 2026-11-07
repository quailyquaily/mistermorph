// Opens tests/fixtures/settings-fields-app.tsx headless, with a morph.* host and a stubbed console
// API keyed "METHOD /path" (below /api), as tests/harness.ts does for the whole console.
import type { App, StubRequest, StubResponse } from "nsh/test";
import { open } from "nsh/test";

export interface FixtureCall {
  method: string;
  path: string;
  json: any;
}

export type FixtureHandler = StubResponse | ((call: FixtureCall) => StubResponse | Promise<StubResponse>);

export async function openFixture(
  location: string,
  api: Record<string, FixtureHandler> = {},
  options: { runtime?: "web" | "desktop"; host?: Record<string, unknown>; width?: number; height?: number; visual?: boolean } = {},
): Promise<{ app: App; calls: FixtureCall[] }> {
  const calls: FixtureCall[] = [];
  const routes: Record<string, FixtureHandler> = {
    "GET /secrets/info": { body: { reveal: true, password_required: false, store: "" } },
    "GET /secrets/keys": { body: { keys: [], fields: {} } },
    ...api,
  };
  const app = await open("./fixtures/settings-fields-app.tsx", {
    width: options.width ?? 1100,
    height: options.height ?? 2400,
    platform: "linux",
    locale: "en-US",
    // `nsh test --target` draws the app for screenshots but plays no host: the fixture then boots
    // with defaults (no API) at "/", which shows every gallery.
    host: options.visual ? undefined : {
      handlers: {
        "morph.boot": {
          runtime: options.runtime ?? "web",
          origin: "http://console.test",
          basePath: "/",
          location,
          kv: { "quail-language": "en" },
          session: {},
          languages: ["en-US"],
          desktopVersion: "",
          features: ["pickFile", "saveFile"],
        },
        "morph.kv.set": null,
        ...(options.host || {}),
      },
    },
    network: options.visual ? undefined : Object.fromEntries(["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => [`${method} *`, answer])),
  });
  return { app, calls };

  async function answer(raw: StubRequest): Promise<StubResponse> {
    const url = new URL(raw.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    let json: any = null;
    try {
      json = raw.body ? JSON.parse(raw.body) : null;
    } catch {
      json = null;
    }
    const call = { method: raw.method.toUpperCase(), path, json };
    calls.push(call);
    const handler = routes[`${call.method} ${path}`];
    if (handler === undefined) return { status: 404, body: { error: `no stub for ${call.method} ${path}` } };
    return typeof handler === "function" ? await handler(call) : handler;
  }
}

/** The text of `id:out-<name>`, without its `<name>=` prefix. */
export function out(app: App, name: string): string {
  const prefix = `${name}=`;
  const text = app.texts().find((item) => item.startsWith(prefix));
  return text === undefined ? "" : text.slice(prefix.length);
}
