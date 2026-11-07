// Opens tests/fixtures/integrations.tsx headless (as tests/harness.ts opens the app): a morph.*
// host like host.js, and the console API answered by `api` ("METHOD /path", the path below /api
// without its query; a value is a response or a function of the request).
import type { App, StubRequest, StubResponse } from "nsh/test";
import { open } from "nsh/test";

export const ORIGIN = "http://console.test";

export interface ApiRequest extends StubRequest {
  path: string;
  query: URLSearchParams;
  json: any;
}

export type ApiHandler = StubResponse | ((request: ApiRequest) => StubResponse | Promise<StubResponse>);

export interface FixtureOptions {
  view: string;
  params?: Record<string, unknown>;
  api?: Record<string, ApiHandler>;
  host?: Record<string, unknown>;
  runtime?: "web" | "desktop";
  features?: string[];
  origin?: string;
  width?: number;
}

export interface FixtureEvent {
  name: string;
  data: any;
}

export async function openFixture(options: FixtureOptions) {
  const calls: ApiRequest[] = [];
  const app: App = await open("./fixtures/integrations.tsx", {
    width: options.width ?? 1280,
    height: 800,
    platform: "linux",
    locale: "en-US",
    host: {
      params: { view: options.view, ...(options.params || {}) },
      handlers: {
        "morph.boot": {
          runtime: options.runtime ?? "web",
          origin: options.origin ?? ORIGIN,
          basePath: "/",
          location: "/",
          kv: { "quail-language": "en" },
          session: {},
          languages: ["en-US"],
          desktopVersion: options.runtime === "desktop" ? "1.2.3" : "",
          features: options.features ?? ["pickFile", "saveFile"],
        },
        "morph.kv.set": null,
        "morph.notify.state": "default",
        "morph.fixture.event": null,
        ...(options.host || {}),
      },
    },
    network: Object.fromEntries(["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => [`${method} *`, answer])),
  });
  const events = () =>
    app.host
      .posts()
      .filter((post) => post.name === "morph.fixture.event")
      .map((post) => post.data as FixtureEvent);
  const eventsNamed = (name: string) => events().filter((event) => event.name === name);
  return { app, calls, events, eventsNamed };

  async function answer(raw: StubRequest): Promise<StubResponse> {
    const url = new URL(raw.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    let json: any = null;
    if (raw.body) {
      try {
        json = JSON.parse(raw.body);
      } catch {
        json = null;
      }
    }
    const request: ApiRequest = { ...raw, path, query: url.searchParams, json };
    calls.push(request);
    const handler = options.api?.[`${raw.method.toUpperCase()} ${path}`];
    if (handler === undefined) return { status: 404, body: { error: `no stub for ${raw.method} ${path}` } };
    return typeof handler === "function" ? await handler(request) : handler;
  }
}
