// One current location, as vue-router had it, with the same paths and the same guard: a session,
// a setup that is complete, and an endpoint that can be selected, before any workspace page.
// On the web it mirrors the address bar (lib/platform.ts); the desktop app keeps it in memory.
import { batch, computed, context, effect, platform, signal, untracked } from "nsh";
import { authState, authValid, endpointState } from "./stores/index.js";
import {
  apiFetch,
  ensureConsoleSession,
  ensureEndpointsLoaded,
  onAuthExpired,
} from "./core/context.js";
import {
  blockingSetupIntegrityItems,
  fetchConsoleSetupIntegrity,
  isAllowedRepairSetupRoute,
  resolveConsoleSetupStage,
  setupStagePath,
} from "./core/setup.js";
import { CONSOLE_LOCAL_ENDPOINT_REF, isEndpointSelectable, rootEntryEndpoint } from "./core/endpoints.js";
import {
  endpointPagePath,
  endpointRefFromRouteParam,
  endpointRoutePath,
  endpointRouteRef,
} from "./core/endpoint-routes.js";
import { routeExtensions } from "./ext/routes/index.js";
import { NAV_ITEMS_META } from "./navOrder";
import { classifyPageMotion, MotionHistory, type PageMotion } from "./navMotion";
import { initialLocation, isVisible, onHistoryPop, onVisibilityChange, writeHistory } from "./platform";

/** Which page a route shows (pages/routes.tsx maps each to its component). */
export type PageKey =
  | "login"
  | "bootPreview"
  | "componentsPreview"
  | "overview"
  | "setup"
  | "repair"
  | "chat"
  | "context"
  | "stats"
  | "audit"
  | "logs"
  | "todo"
  | "memories"
  | "skills"
  | "skillStore"
  | "contacts"
  | "settings"
  | "root"
  | "notFound";

export interface RouteMeta {
  public?: boolean;
  shellless?: boolean;
  endpointScoped?: boolean;
  setupStage?: string;
  /**
   * Whether the address is a page of the navigation for the phone's bottom navigation, where its
   * own path does not say (lib/shell.ts `isMobileNavRoot`).
   */
  mobileBottomNav?: boolean;
}

export interface Route {
  /** The path without query or hash: `/e/default/chat/abc`. */
  path: string;
  /** Path, query and hash. */
  fullPath: string;
  /** The query, one value per name (the first), as vue-router's `route.query` read for strings. */
  query: Record<string, string>;
  hash: string;
  /** Named path parts: `endpoint_ref`, `topic_id`, `section`. */
  params: Record<string, string>;
  meta: RouteMeta;
  page: PageKey;
}

interface RouteDef {
  pattern: string;
  page?: PageKey;
  meta?: RouteMeta;
  redirect?: string;
}

const ENDPOINT_SCOPE = "/e/:endpoint_ref";

const ROUTES: RouteDef[] = [
  { pattern: "/login", page: "login", meta: { public: true, shellless: true } },
  { pattern: "/__boot-preview", page: "bootPreview", meta: { public: true, shellless: true } },
  { pattern: "/__components", page: "componentsPreview", meta: { public: true, shellless: true } },
  { pattern: "/overview", page: "overview" },
  { pattern: `${ENDPOINT_SCOPE}/setup`, page: "setup", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/setup/llm`, page: "setup", meta: { endpointScoped: true, setupStage: "llm" } },
  { pattern: `${ENDPOINT_SCOPE}/setup/persona`, page: "setup", meta: { endpointScoped: true, setupStage: "persona" } },
  { pattern: `${ENDPOINT_SCOPE}/setup/soul`, page: "setup", meta: { endpointScoped: true, setupStage: "soul" } },
  { pattern: `${ENDPOINT_SCOPE}/setup/done`, page: "setup", meta: { endpointScoped: true, setupStage: "done" } },
  { pattern: `${ENDPOINT_SCOPE}/troubleshooting`, page: "repair", meta: { endpointScoped: true, shellless: true } },
  { pattern: `${ENDPOINT_SCOPE}/chat`, page: "chat", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/chat/:topic_id`, page: "chat", meta: { endpointScoped: true, mobileBottomNav: false } },
  {
    pattern: `${ENDPOINT_SCOPE}/chat/:topic_id/context`,
    page: "context",
    meta: { endpointScoped: true, mobileBottomNav: false },
  },
  { pattern: `${ENDPOINT_SCOPE}/stats`, page: "stats", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/audit`, page: "audit", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/logs`, page: "logs", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/todo`, page: "todo", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/memories`, page: "memories", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/skills`, page: "skills", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/skills/store`, page: "skillStore", meta: { endpointScoped: true } },
  { pattern: `${ENDPOINT_SCOPE}/contacts`, page: "contacts", meta: { endpointScoped: true } },
  // A section's address stays when Back shows the sections list again (SettingsPage), so the page
  // itself says whether a section is open (markMobileDetail).
  { pattern: `${ENDPOINT_SCOPE}/settings/:section`, page: "settings", meta: { endpointScoped: true, mobileBottomNav: true } },
  { pattern: `${ENDPOINT_SCOPE}/settings`, page: "settings", meta: { endpointScoped: true } },
  { pattern: "/setup", redirect: "/setup" },
  { pattern: "/setup/llm", redirect: "/setup/llm" },
  { pattern: "/setup/persona", redirect: "/setup/persona" },
  { pattern: "/setup/soul", redirect: "/setup/soul" },
  { pattern: "/setup/done", redirect: "/setup/done" },
  { pattern: "/troubleshooting", redirect: "/troubleshooting" },
  { pattern: "/chat", redirect: "/chat" },
  // Agent Desk was removed; its old address opens Chat.
  { pattern: "/chat/desk", redirect: "/chat" },
  { pattern: "/chat/:topic_id", redirect: "/chat/:topic_id" },
  { pattern: "/runtime", redirect: "/settings/runtime" },
  { pattern: "/dashboard", redirect: "/settings/runtime" },
  { pattern: "/stats", redirect: "/stats" },
  { pattern: "/audit", redirect: "/audit" },
  { pattern: "/logs", redirect: "/logs" },
  { pattern: "/todo", redirect: "/todo" },
  { pattern: "/memories", redirect: "/memories" },
  { pattern: "/skills", redirect: "/skills" },
  { pattern: "/files", redirect: "/todo" },
  { pattern: "/contacts", redirect: "/contacts" },
  { pattern: "/settings/:section", redirect: "/settings/:section" },
  { pattern: "/settings", redirect: "/settings" },
  { pattern: "/", page: "root", meta: { shellless: true } },
];

const extensionSetupFreePaths: string[] = Array.isArray(routeExtensions.setupFreePaths)
  ? routeExtensions.setupFreePaths
  : [];

const SETUP_FREE_PATHS = new Set([
  "/setup",
  "/setup/llm",
  "/setup/persona",
  "/setup/soul",
  "/setup/done",
  "/troubleshooting",
  "/settings",
  "/settings/agent",
  "/settings/routes",
  "/settings/tools",
  "/settings/skills",
  "/settings/persona",
  "/settings/channels",
  "/settings/runtimes",
  "/settings/security",
  "/settings/automation",
  "/settings/system",
  "/settings/console",
  "/settings/runtime",
  "/settings/credits",
  ...extensionSetupFreePaths,
]);

export { NAV_ITEMS_META };

/* ---------- parsing ---------- */

function splitLocation(value: string) {
  const hashAt = value.indexOf("#");
  const hash = hashAt < 0 ? "" : value.slice(hashAt);
  const rest = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  return {
    path: normalizePath(queryAt < 0 ? rest : rest.slice(0, queryAt)),
    search: queryAt < 0 ? "" : rest.slice(queryAt),
    hash,
  };
}

function normalizePath(path: string) {
  let value = String(path || "/").trim() || "/";
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, "");
  return value || "/";
}

function parseQuery(search: string) {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (!(key in query)) query[key] = value;
  }
  return query;
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(":")) {
      try {
        params[want[i].slice(1)] = decodeURIComponent(have[i]);
      } catch {
        params[want[i].slice(1)] = have[i];
      }
    } else if (want[i] !== have[i]) {
      return null;
    }
  }
  return params;
}

function fillPattern(pattern: string, params: Record<string, string>) {
  return pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => encodeURIComponent(params[name] || ""));
}

interface Resolved {
  route?: Route;
  redirect?: string;
}

function resolve(location: string): Resolved {
  const { path, search, hash } = splitLocation(location);
  const query = parseQuery(search);
  for (const def of ROUTES) {
    const params = matchPattern(def.pattern, path);
    if (!params) continue;
    if (def.redirect) {
      return { redirect: `${endpointRoutePath(CONSOLE_LOCAL_ENDPOINT_REF, fillPattern(def.redirect, params))}${search}${hash}` };
    }
    return {
      route: { path, fullPath: `${path}${search}${hash}`, query, hash, params, meta: def.meta || {}, page: def.page || "notFound" },
    };
  }
  return { route: { path, fullPath: `${path}${search}${hash}`, query, hash, params: {}, meta: {}, page: "notFound" } };
}

function withQuery(path: string, query: Record<string, string>, hash = "") {
  const search = new URLSearchParams(query).toString();
  return `${path}${search ? `?${search}` : ""}${hash}`;
}

/* ---------- the guard ---------- */

function pagePath(path: string) {
  return endpointPagePath(path) || String(path || "").trim();
}

/** What the Vue router's beforeEach decided: `true` to go on, or a location to go to instead. */
async function guard(to: Route): Promise<true | string> {
  if (to.meta.public === true) {
    return true;
  }
  const loginRedirect = withQuery("/login", { redirect: to.fullPath });
  const toPagePath = pagePath(to.path);
  const requestedEndpointRef = to.meta.endpointScoped ? endpointRefFromRouteParam(to.params.endpoint_ref) : "";
  if (to.meta.endpointScoped) {
    if (!requestedEndpointRef) {
      return "/overview";
    }
    const canonicalRouteRef = endpointRouteRef(requestedEndpointRef);
    if (String(to.params.endpoint_ref || "").trim() !== canonicalRouteRef) {
      return withQuery(endpointRoutePath(requestedEndpointRef, toPagePath), to.query, to.hash);
    }
  }
  if (!authValid.value) {
    try {
      if (!(await ensureConsoleSession())) {
        return loginRedirect;
      }
    } catch {
      return loginRedirect;
    }
  }
  const readMe = async () => {
    const me = await apiFetch("/auth/me");
    authState.account = me.account || "console";
    authState.expiresAt = me.expires_at || authState.expiresAt;
    authState.save();
  };
  try {
    await readMe();
  } catch {
    authState.clear();
    try {
      if (await ensureConsoleSession()) {
        await readMe();
      } else {
        return loginRedirect;
      }
    } catch {
      return loginRedirect;
    }
  }
  try {
    const integrityItems = blockingSetupIntegrityItems(await fetchConsoleSetupIntegrity().catch(() => []));
    if (integrityItems.length > 0) {
      if (toPagePath === "/troubleshooting" || isAllowedRepairSetupRoute(to, integrityItems)) {
        return true;
      }
      return withQuery(setupStagePath("repair"), { redirect: to.fullPath });
    }
    await ensureEndpointsLoaded();
  } catch {
    endpointState.items = [];
  }
  if (requestedEndpointRef) {
    const endpoint = endpointState.items.find((item: { endpoint_ref?: string }) => item?.endpoint_ref === requestedEndpointRef);
    if (!isEndpointSelectable(endpoint)) {
      return "/overview";
    }
    endpointState.setSelectedEndpointRef(requestedEndpointRef);
  }
  const setupState = await resolveConsoleSetupStage(endpointState.items);
  if (setupState.stage !== "ready") {
    if (SETUP_FREE_PATHS.has(toPagePath)) {
      return true;
    }
    return withQuery(setupStagePath(setupState.stage), { redirect: to.fullPath });
  }
  if (to.path === "/") {
    const endpoint = rootEntryEndpoint(endpointState.items);
    if (endpoint?.endpoint_ref) {
      return withQuery(endpointRoutePath(endpoint.endpoint_ref, "/chat"), to.query);
    }
    return withQuery("/overview", to.query);
  }
  return true;
}

/* ---------- state ---------- */

const current = signal<Route | null>(null);
const pending = signal("");
let navigationSeq = 0;

/** A committed navigation: where from, where to, how it came and which way it moves (lib/navMotion.ts). */
export interface Navigation {
  /** Counts the commits of this run. */
  seq: number;
  from: Route | null;
  to: Route;
  /** A page or the app opened it, replaced the place, or a history step (back/forward buttons, Android's Back) came to it. */
  kind: "push" | "replace" | "pop";
  motion: PageMotion;
}

const lastNavigation = signal<Navigation | null>(null);
let commitSeq = 0;
/** The last committed navigation (set with the route, in the same batch). */
export const navigation = () => lastNavigation();

// The history this run wrote, with each step's motion, for history steps to replay. The phone app's
// own history drops a place replaced by the one before it (lib/mobileHost.ts); browsers keep it.
const motionHistory = new MotionHistory(platform.os === "android" || platform.os === "ios");

/**
 * The route a page instance follows (pages/routes.tsx provides it): the current route while the
 * page is the one shown; a page on its way out keeps the last route that was its own, so it never
 * reacts to the next page's route as it leaves.
 */
export const PageRouteContext = context<(() => Route) | null>(null);

/** The current route, `null` until the first navigation settles (tracked where it is read). */
export const route = () => current();
/**
 * The route as a never-null value for pages, which only mount once there is one: the page's own
 * (PageRouteContext) inside a page, else the current one.
 */
export const currentRoute = () => {
  const own = PageRouteContext();
  return (own ? own() : current()) as Route;
};
/** The path being opened while its guard runs, else the current path: the nav selects it at once. */
export const currentPath = computed(() => pending() || current()?.path || "");

/** Asked before leaving a page with unsaved work; false (or a promise of false) stays. */
type LeaveGuard = (to: string) => boolean | Promise<boolean>;
let leaveGuard: LeaveGuard | null = null;
/** Sets the page's leave guard; it goes when the page goes. Pass null to remove it. */
export function setLeaveGuard(next: LeaveGuard | null) {
  leaveGuard = next;
}

/** How a navigation came: its kind, whether the navigation itself asked, and a history step's known motion. */
interface Step {
  kind: Navigation["kind"];
  tab?: boolean;
  /** For a history step: the motion it replays, or null when not known. */
  motion?: PageMotion | null;
}

function commit(next: Route, mode: "push" | "replace" | "none", step: Step) {
  const from = untracked(current);
  let motion: PageMotion;
  if (step.kind === "pop" && step.motion) motion = step.motion;
  else motion = classifyPageMotion(from?.path ?? null, next.path, { tab: step.tab, pop: step.kind === "pop" });
  if (mode === "push") motionHistory.push(next.fullPath, motion);
  else if (mode === "replace") motionHistory.replace(next.fullPath, motion);
  batch(() => {
    pending.set("");
    lastNavigation.set({ seq: ++commitSeq, from, to: next, kind: step.kind, motion });
    current.set(next);
  });
  if (mode !== "none") writeHistory(mode, next.fullPath);
}

async function run(location: string, mode: "push" | "replace" | "none", hops = 0, step: Step = { kind: "push" }): Promise<void> {
  const seq = ++navigationSeq;
  const resolved = resolve(location);
  if (resolved.redirect) {
    return run(resolved.redirect, mode === "push" ? "push" : "replace", hops + 1, step);
  }
  const to = resolved.route!;
  pending.set(to.path);
  let decision: true | string;
  try {
    decision = await guard(to);
  } catch (error) {
    console.warn("navigation failed", to.fullPath, (error as Error)?.message || error);
    decision = true;
  }
  if (seq !== navigationSeq) return; // A newer navigation took over.
  if (decision !== true) {
    if (hops > 8) {
      console.warn("too many redirects from", to.fullPath);
      pending.set("");
      return;
    }
    return run(decision, mode === "none" ? "replace" : mode, hops + 1, step);
  }
  commit(to, mode, step);
}

/**
 * Opens `to` (path, query and hash), as router.push or router.replace did. `tab`: the navigation
 * (sidebar, bottom bar, More) asked, so pages of the navigation move in its order.
 */
export async function navigate(to: string, options: { replace?: boolean; force?: boolean; tab?: boolean } = {}) {
  const target = String(to || "").trim() || "/";
  if (!options.force && leaveGuard && !(await leaveGuard(target))) return;
  if (!options.force) leaveGuard = null;
  await run(target, options.replace ? "replace" : "push", 0, { kind: options.replace ? "replace" : "push", tab: options.tab });
}

/** The vue-router calls the copied logic makes. */
export const router = {
  push: (to: string | { path: string; query?: Record<string, string>; hash?: string }) =>
    navigate(typeof to === "string" ? to : withQuery(to.path, to.query || {}, to.hash || "")),
  replace: (to: string | { path: string; query?: Record<string, string>; hash?: string }) =>
    navigate(typeof to === "string" ? to : withQuery(to.path, to.query || {}, to.hash || ""), { replace: true }),
  back: () => {
    // The desktop app has no history of its own; go to the workspace's start instead.
    void navigate("/", { replace: true });
  },
  currentRoute: {
    get value() {
      return currentRoute();
    },
  },
};

/** Builds a location from a path and a query, leaving out empty values. */
export function locationOf(path: string, query: Record<string, string | undefined | null> = {}, hash = "") {
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "");
  return withQuery(path, Object.fromEntries(entries) as Record<string, string>, hash);
}

/** A location as the router writes it to the history (`fullPath`): normalized path, query and hash. */
function historyLocation(location: string) {
  const { path, search, hash } = splitLocation(location);
  return `${path}${search}${hash}`;
}

/* ---------- the session's end ---------- */

// When the session ends, by its expiry time or by the console rejecting the token, go to the login
// page and come back here after logging in. Without a password the login page logs in by itself.
function redirectToLogin() {
  const now = untracked(() => current());
  if (!now || now.meta.public === true || now.path === "/login") {
    return;
  }
  void navigate(withQuery("/login", { redirect: now.fullPath }), { replace: true, force: true });
}

// setTimeout waits at most about 24.8 days; a later expiry is checked again then.
const MAX_TIMER_MS = 2 ** 31 - 1;
let sessionExpiryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSessionExpiry() {
  clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = undefined;
  const token = authState.token;
  const expiresAt = authState.expiresAt;
  if (!token || !expiresAt) return;
  const at = new Date(expiresAt).getTime();
  if (!Number.isFinite(at)) return;
  const ms = at - Date.now();
  if (ms <= 0) {
    authState.clear();
    redirectToLogin();
    return;
  }
  sessionExpiryTimer = setTimeout(scheduleSessionExpiry, Math.min(ms, MAX_TIMER_MS));
}

/** Starts at the location the host opened, and follows back and forward. Call once, after boot. */
export function startRouter() {
  onAuthExpired(redirectToLogin);
  effect(() => {
    // Follow the session's token and expiry; the timer itself is not tracked.
    void authState.token;
    void authState.expiresAt;
    untracked(scheduleSessionExpiry);
  });
  // Timers do not run while a computer sleeps, so check again when the page comes back.
  onVisibilityChange(() => {
    if (isVisible()) scheduleSessionExpiry();
  });
  onHistoryPop((location) => {
    // The history moved already: note which way, whatever the leave guard says.
    const motion = motionHistory.pop(historyLocation(location));
    const step: Step = { kind: "pop", motion };
    if (leaveGuard) {
      const guardFn = leaveGuard;
      void Promise.resolve(guardFn(location)).then((leave) => {
        if (leave) {
          leaveGuard = null;
          void run(location, "none", 0, step);
        } else {
          const now = untracked(() => current());
          if (now) {
            motionHistory.push(now.fullPath, "none");
            writeHistory("push", now.fullPath);
          }
        }
      });
      return;
    }
    void run(location, "none", 0, step);
  });
  void run(initialLocation(), "replace", 0, { kind: "replace" });
}
