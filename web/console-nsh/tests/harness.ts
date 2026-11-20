// Opens the console headless as a browser would: a `morph.*` host that answers like host.js, and a
// console API that answers like a fresh, set-up local agent. Tests override what they need:
//
//   const { app, calls } = await openConsole({
//     location: "/e/default/todo",
//     api: { "GET /proxy:/tasks": { body: { items: [] } } },
//   });
//
// API keys are "METHOD /path" for console routes (`GET /auth/me`), and "METHOD /proxy:/uri" for
// what pages ask an agent through /api/proxy (`GET /proxy:/topics`): the uri without its query
// matches, or with it when the key has one. A value is a response, or a function of the request.
import type { App, SafeArea, StubRequest, StubResponse } from "nsh/test";
import { open } from "nsh/test";

export const ORIGIN = "http://console.test";
export const LOCAL_REF = "ep_console_local";

export interface ApiRequest extends StubRequest {
  /** The console route below /api, without its query. */
  path: string;
  query: URLSearchParams;
  /** For /api/proxy: the endpoint and the agent's uri. */
  endpoint?: string;
  uri?: string;
  /** The body parsed as JSON, or null. */
  json: any;
}

export type ApiHandler = StubResponse | ((request: ApiRequest) => StubResponse | Promise<StubResponse>);

export interface ConsoleOptions {
  /** Where the app opens (`/e/default/chat`). */
  location?: string;
  /** Route overrides, merged over the defaults. */
  api?: Record<string, ApiHandler>;
  /** The console asks for a password: no automatic login. */
  password?: boolean;
  /** Saved values (`localStorage` on the web). */
  kv?: Record<string, string>;
  /** The endpoints /api/endpoints lists (default: the local agent, connected and ready). */
  endpoints?: Record<string, unknown>[];
  /** Window size (1280 × 800, the desktop layout). */
  width?: number;
  height?: number;
  /**
   * Extra host handlers (`morph.file.pick`, `morph.desktop.*`). With `platform: "android"`, the
   * native part's handlers the app's own host calls (`morph.voice.*`), as the APK's Java answers them.
   */
  host?: Record<string, unknown>;
  /** The host's runtime (`web`). */
  runtime?: "web" | "desktop";
  features?: string[];
  locale?: string;
  /**
   * `"android"`: the phone app on Android, whose own host (lib/mobileHost.ts) answers `morph.*`
   * from the app's storage, where `location` and the console server's address are saved.
   */
  platform?: "android";
  /**
   * The system bars' insets (`safeArea()`): Android's with `platform`; without it, a phone
   * browser's (`env(safe-area-inset-*)`, under its home indicator or a cutout).
   */
  safeArea?: SafeArea;
  /**
   * With `platform: "android"`: what the native part answers of a hardware keyboard
   * (`morph.keyboard.state`, android/src/.../HardwareKeyboard.java). Without it the app has no such
   * answer, as an APK without the native part: the state is unknown and the keyboard shortcuts are
   * off (lib/shortcutPolicy.ts). Tests that use the app's shortcuts on Android say "connected".
   */
  keyboard?: "connected" | "disconnected" | "unknown";
  /** The desktop's OS (default `linux`): `macos` has Apple's keys (`mod` is Command, ⌘ labels). */
  os?: "linux" | "macos" | "windows";
  /** The user asks for less motion. */
  reducedMotion?: boolean;
  /** A manual clock (`app.clock`): time moves only as the test moves it. */
  clock?: boolean;
  /** Page and pane slides last a minute (tests/slowSlidesConsole.tsx): steps act during one. */
  slowSlides?: boolean;
  /**
   * The console reports where its pages' remembered scrollers are (tests/scrollProbeConsole.tsx):
   * read them with `scrollProbe(app)`.
   */
  scrollProbe?: boolean;
  /**
   * The phone app keeps its cache on disk (tests/cacheFilesConsole.tsx): the store's files are in
   * the app's storage, so `kv: first.app.storage()` opens the app again as after it was closed.
   */
  cacheFiles?: boolean;
  /** The window draws glass (tests/glassConsole.tsx): bars over the lists, a glass composer and navigation. */
  glass?: boolean;
  /**
   * The console reports where the content of each scroller under a bar starts
   * (tests/barRoomConsole.tsx, with `glass` tests/glassBarRoomConsole.tsx): read them with `barRooms(app)`.
   */
  barRooms?: boolean;
}

/** Where the phone app keeps the console server's address and its last location (lib/mobileHost.ts). */
export const MOBILE_SERVER_KEY = "mistermorph_console_server_v1";
export const MOBILE_LOCATION_KEY = "mistermorph_console_mobile_location_v1";

const DAY = 24 * 60 * 60 * 1000;

export function localEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    endpoint_ref: LOCAL_REF,
    name: "Console",
    url: "in-process://console-local",
    connected: true,
    agent_name: "Morph",
    mode: "console",
    can_submit: true,
    health_pending: false,
    submit_endpoint_ref: "",
    avatar_url: "",
    instance_id: "local",
    ...overrides,
  };
}

const READY_FILES = ["identity.yaml", "soul.md", "HEARTBEAT.md", "cron.yaml"].map((name) => ({
  name,
  exists: true,
  path: `/state/${name}`,
  group: "persona",
}));

function defaults(options: ConsoleOptions): Record<string, ApiHandler> {
  const expires = new Date(Date.now() + DAY).toISOString();
  return {
    "GET /auth/config": { body: { password_required: options.password === true } },
    "POST /auth/login": (request) =>
      options.password && request.json?.password !== "secret"
        ? { status: 401, body: { error: "invalid password" } }
        : { body: { access_token: "token-1", expires_at: expires, account: "console" } },
    "GET /auth/me": (request) =>
      request.headers.authorization || request.headers.Authorization
        ? { body: { account: "console", expires_at: expires } }
        : { status: 401, body: { error: "unauthorized" } },
    "POST /auth/logout": { body: {} },
    "GET /setup/integrity": { body: { items: [] } },
    "GET /endpoints": { body: { items: options.endpoints ?? [localEndpoint()] } },
    "POST /stream/ticket": { body: { ticket: "ticket-1" } },
    "GET /proxy:/state/files": { body: { items: READY_FILES } },
    "GET /proxy:/state/files/identity.yaml": { body: { content: "name: Morph\n" } },
    "GET /proxy:/state/files/soul.md": { body: { content: "# Soul\n" } },
    "GET /proxy:/persona/identity": {
      body: { exists: true, identity: { name: "Morph", name_alts: [], creature: "", vibe: "", emoji: "", soul: "# Soul", extra: {} } },
    },
    "GET /proxy:/contacts/list": { body: { items: [] } },
    "GET /proxy:/topics": { body: { items: [] } },
    "GET /proxy:/topics/activity": { body: { topics: [] } },
    // The TODO page loads its tasks and the heartbeat's workflows on every visit.
    "GET /proxy:/todo/tasks": { body: { tasks: [] } },
    "GET /proxy:/heartbeat/workflows": { body: { items: [] } },
  };
}

function toRequest(raw: StubRequest): ApiRequest {
  const url = new URL(raw.url);
  let path = url.pathname.replace(/^\/api/, "") || "/";
  const query = url.searchParams;
  let endpoint: string | undefined;
  let uri: string | undefined;
  if (path === "/proxy" || path === "/proxy/download") {
    endpoint = query.get("endpoint") || "";
    uri = query.get("uri") || "";
  }
  let json: any = null;
  if (raw.body) {
    try {
      json = JSON.parse(raw.body);
    } catch {
      json = null;
    }
  }
  return { ...raw, path, query, endpoint, uri, json };
}

function keysFor(request: ApiRequest) {
  const method = request.method.toUpperCase();
  if (request.uri !== undefined) {
    const download = request.path === "/proxy/download" ? "/proxy/download:" : "/proxy:";
    const bare = request.uri.split("?")[0];
    return [`${method} ${download}${request.uri}`, `${method} ${download}${bare}`];
  }
  return [`${method} ${request.path}`];
}

/** Opens the console; `calls` records every API request in order. */
export async function openConsole(options: ConsoleOptions = {}): Promise<{ app: App; calls: ApiRequest[] }> {
  const calls: ApiRequest[] = [];
  const routes = { ...defaults(options), ...(options.api || {}) };
  // A bare "*" is a GET of any URL; each method needs its own catch-all.
  const network = Object.fromEntries(["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => [`${method} *`, answer]));
  const entry = options.cacheFiles
    ? "./cacheFilesConsole.tsx"
    : options.slowSlides
    ? "./slowSlidesConsole.tsx"
    : options.scrollProbe
      ? "./scrollProbeConsole.tsx"
      : options.barRooms
        ? options.glass
          ? "./glassBarRoomConsole.tsx"
          : "./barRoomConsole.tsx"
        : options.glass
          ? "./glassConsole.tsx"
          : "../App.tsx";
  const probe: Record<string, null> = options.scrollProbe ? { "morph.fixture.scroll": null, "morph.fixture.saved": null } : options.barRooms ? { "morph.fixture.room": null } : {};
  if (options.platform === "android") {
    const app = await open(entry, {
      width: options.width ?? 390,
      height: options.height ?? 844,
      platform: "android",
      locale: options.locale ?? "en-US",
      safeArea: options.safeArea ?? null,
      storage: {
        [MOBILE_SERVER_KEY]: ORIGIN,
        [MOBILE_LOCATION_KEY]: options.location ?? "/",
        "quail-language": "en",
        ...(options.kv || {}),
      },
      host:
        options.host || options.scrollProbe || options.barRooms || options.keyboard
          ? { handlers: { ...probe, ...(options.keyboard ? { "morph.keyboard.state": { physical: options.keyboard } } : {}), ...(options.host || {}) } }
          : null,
      clock: options.clock ? {} : null,
      network,
    });
    return { app, calls };
  }
  const app = await open(entry, {
    width: options.width ?? 1280,
    height: options.height ?? 800,
    // A desktop idiom; "web" would load host.js, which needs a browser page.
    platform: options.os ?? "linux",
    locale: options.locale ?? "en-US",
    safeArea: options.safeArea ?? null,
    reducedMotion: options.reducedMotion ?? false,
    clock: options.clock ? {} : null,
    host: {
      handlers: {
        "morph.boot": {
          runtime: options.runtime ?? "web",
          origin: ORIGIN,
          basePath: "/",
          location: options.location ?? "/",
          kv: { "quail-language": "en", ...(options.kv || {}) },
          session: {},
          languages: ["en-US"],
          desktopVersion: options.runtime === "desktop" ? "0.0.0-test" : "",
          features: options.features ?? ["pickFile", "saveFile"],
        },
        "morph.kv.set": null,
        "morph.history": null,
        "morph.title": null,
        "morph.favicon": null,
        "morph.language": null,
        "morph.notify.state": "default",
        "morph.desktop.ready": null,
        ...probe,
        ...(options.host || {}),
      },
    },
    network,
  });
  return { app, calls };

  async function answer(raw: StubRequest): Promise<StubResponse> {
    const request = toRequest(raw);
    calls.push(request);
    for (const key of keysFor(request)) {
      const handler = routes[key];
      if (handler !== undefined) {
        return typeof handler === "function" ? await handler(request) : handler;
      }
    }
    return { status: 404, body: { error: `no stub for ${keysFor(request).at(-1)}` } };
  }
}

/** A scroller's content start under its bar, as a console opened with `barRooms` reports it (components/frame/glassBar.tsx `BarRoomFrame`). */
export type BarRoomReport = { x: number; y: number; w: number; h: number; room: number };

/** What a console opened with `barRooms` reports of the scrollers under its bars. */
export function barRooms(app: App) {
  const posts = () => app.host.posts().filter((post) => post.name === "morph.fixture.room");
  let mark = 0;
  return {
    /** Forgets the reports so far (before going to another page). */
    mark() {
      mark = posts().length;
    },
    /** Every report since `mark()`, in order. */
    all(): BarRoomReport[] {
      return posts()
        .slice(mark)
        .map((post) => post.data as BarRoomReport);
    },
    /** The last report since `mark()` that is at least `minWidth` wide, `null` when there is none. */
    last(minWidth = 1): BarRoomReport | null {
      return this.all().filter((frame) => frame.w >= minWidth).at(-1) ?? null;
    },
  };
}

/** What a console opened with `scrollProbe` reports of its remembered scrollers (lib/scrollMemory.ts). */
export function scrollProbe(app: App) {
  const posts = (name: string) => app.host.posts().filter((post) => post.name === name);
  let mark = 0;
  return {
    /** Forgets the offsets reported so far: what `live` gives after is reported from now on. */
    mark() {
      mark = posts("morph.fixture.scroll").length;
    },
    /** An area's last reported offset since `mark()`, `null` when it reported none. */
    live(key: string): number | null {
      const own = posts("morph.fixture.scroll")
        .slice(mark)
        .map((post) => post.data as { key: string; y: number })
        .filter((data) => data.key === key);
      return own.length ? own[own.length - 1].y : null;
    },
    /** What is remembered now, by area. */
    async saved(): Promise<Record<string, { y: number; selection: string; anchor?: { id: string; offset: number } }>> {
      const before = posts("morph.fixture.saved").length;
      await app.host.send("morph.fixture.saved");
      await app.waitUntil(() => posts("morph.fixture.saved").length > before);
      const all = posts("morph.fixture.saved");
      return all[all.length - 1].data as never;
    },
  };
}
