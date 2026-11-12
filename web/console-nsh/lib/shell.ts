// The app frame's state, as the Vue console's useAppShell had it: which endpoint is selected,
// the navigation, and the shared data every workspace page preloads.
import { batch, cleanup, computed, effect, keyboardFrame, LayoutAnimation, platform, reduceMotion, safeArea, signal, untracked, windowSize } from "nsh";
import defaultEndpointAvatar from "../assets/images/app_logo_current.svg";
import { lastTopicID } from "./core/chat-topic-memory.js";
import { endpointDisplayItem, visibleEndpoints } from "./core/endpoints.js";
import { endpointPagePath, endpointRoutePath, endpointSwitchPath } from "./core/endpoint-routes.js";
import { authValid, endpointState, ensureEndpointsLoaded, runtimeEndpointByRef, translate } from "./core/context.js";
import { NAV_ITEMS_META, navigate, route, currentPath, type Route } from "./router";
import { NAV_TAB_PATHS } from "./navOrder";
import { useContactsStore } from "./stores/contactsStore.js";
import { usePersonaStore } from "./stores/personaStore.js";
import { localStore } from "./platform";
import { frameInsets, rightSheetInsets } from "./systemInsets";
import { SystemBackScope } from "./systemBack";

export { currentPath };

/** Below this width the sidebar gives way to the bottom navigation. */
export const MOBILE_BREAKPOINT = 980;
export const isMobile = computed(() => windowSize().width <= MOBILE_BREAKPOINT);

const SIDEBAR_COLLAPSED_STORAGE_KEY = "mistermorph.sidebarCollapsed";
/** The sidebar's two widths: unfolded, and folded to its icons. */
export const SIDEBAR_WIDTH = 200;
export const SIDEBAR_COLLAPSED_WIDTH = 52;
const SIDEBAR_MIDPOINT = (SIDEBAR_WIDTH + SIDEBAR_COLLAPSED_WIDTH) / 2;

// The sidebar folds to its icons by dragging its right edge (or with the keyboard on the edge);
// the choice is remembered. While dragged it follows the pointer, and on release it settles on
// the nearer width.
const collapsed = signal(false);
const dragWidth = signal<number | null>(null);
export const sidebarCollapsed = () => collapsed();
/** The width the sidebar follows while its edge is dragged, else null. */
export const sidebarDragWidth = () => dragWidth();
/** Whether the sidebar draws folded now: while dragged, by the nearer width. */
export const sidebarShowsCollapsed = computed(() => {
  const width = dragWidth();
  return width === null ? collapsed() : width < SIDEBAR_MIDPOINT;
});
/** The sidebar's width now. */
export const sidebarWidth = computed(() => {
  const width = dragWidth();
  if (width !== null) return width;
  return collapsed() ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH;
});
export function setSidebarCollapsed(next: boolean) {
  // The column eases to its new width (200 ms, as the Vue grid's transition), unless it follows a
  // drag, which is already where the pointer put it.
  if (untracked(() => dragWidth()) === null && untracked(() => collapsed()) !== Boolean(next) && !reduceMotion()) {
    LayoutAnimation.configureNext({ duration: 200, update: { type: "easeInEaseOut" } });
  }
  collapsed.set(Boolean(next));
  localStore.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
}
export function loadSidebarCollapsed() {
  collapsed.set(localStore.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1");
}
let dragStartWidth = SIDEBAR_WIDTH;
/** The edge drag began. */
export function startSidebarDrag() {
  dragStartWidth = untracked(() => (collapsed() ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH));
}
/** The edge moved by `dx` points since the drag began. */
export function moveSidebarDrag(dx: number) {
  dragWidth.set(Math.min(SIDEBAR_WIDTH, Math.max(SIDEBAR_COLLAPSED_WIDTH, dragStartWidth + dx)));
}
/** The edge was released: the sidebar settles on the nearer width. */
export function endSidebarDrag() {
  const width = untracked(() => dragWidth());
  batch(() => {
    if (width !== null) setSidebarCollapsed(width < SIDEBAR_MIDPOINT);
    dragWidth.set(null);
  });
}

/** Whether the phone's More menu is open; it closes on any navigation. */
const mobileMore = signal(false);
export const mobileMoreOpen = () => mobileMore();
export function setMobileMoreOpen(open: boolean) {
  mobileMore.set(Boolean(open));
}
export function closeMobileMore() {
  mobileMore.set(false);
}

export const inShellless = () => route()?.meta.shellless === true;

export const inOverview = () => route()?.path === "/overview";
export const inSetup = () => {
  const path = route()?.path || "";
  const page = endpointPagePath(path) || path;
  return page === "/setup" || page.startsWith("/setup/");
};
export const inStandalone = () => inOverview() || inSetup();

/**
 * Whether `route` is one of the navigation's own pages (lib/navOrder.ts), the pages the phone's
 * bottom navigation belongs to: `/e/<ref>/contacts` is, an open topic, the skill store or a page
 * reached from Settings (logs) are not, and neither is an address that matches no page. A route's
 * `mobileBottomNav` meta overrides the address: `true` for an address below a navigation page that
 * still shows that page (Settings' section address, whose sections list shows after Back), `false`
 * for one that never does. Where the page's own list gives way to one of its items, the page says
 * so as well (`markMobileDetail`).
 */
export function isMobileNavRoot(route: Pick<Route, "path" | "meta" | "page"> | null | undefined) {
  if (!route || route.page === "notFound") return false;
  if (route.meta.mobileBottomNav !== undefined) return route.meta.mobileBottomNav;
  const page = normalizeNavPath(endpointPagePath(route.path) || route.path);
  return NAV_TAB_PATHS.includes(page);
}

// The pages' own detail levels on phones: a navigation page whose list gave way to one of its
// items (an open contact, a subject, a task, a skill, a log, a settings section, a new topic over
// the topic list) is no longer the navigation's page, whatever its address says.
const mobileDetails = signal<(() => boolean)[]>([]);

/**
 * While the calling component lives, `when` says whether its page shows one of its items in place
 * of its list on a phone (the level its bar's back arrow leaves), which hides the bottom
 * navigation. Call it in a page's body; it is removed with the page, and a page on its way out
 * (SystemBackScope) no longer counts, so it never hides the navigation of the page coming in.
 */
export function markMobileDetail(when: () => boolean) {
  const shown = SystemBackScope();
  const entry = shown ? () => shown() && when() : when;
  mobileDetails.update((list) => [...list, entry]);
  cleanup(() => mobileDetails.update((list) => list.filter((item) => item !== entry)));
}

/** Whether a page shown now has one of its items open in place of its list (`markMobileDetail`). */
export const mobileDetailOpen = computed(() => mobileDetails().some((when) => when()));

/**
 * Whether the phone's bottom navigation shows: on a phone, on a navigation page's own list. Its
 * room at the foot of the pages (components/frame/mobileBar.tsx) and Android's bottom inset
 * (`systemInsets`) follow the same answer.
 */
export const mobileBottomNavVisible = computed(
  () => isMobile() && !inStandalone() && !inShellless() && isMobileNavRoot(route()) && !mobileDetailOpen(),
);

/** Android draws the app under its status and navigation bars (lib/systemInsets.ts). */
export const EDGE_TO_EDGE = platform.os === "android";
/** The frame's and the navigation strip's room for the system bars on Android; null elsewhere. */
export const systemInsets = computed(() =>
  EDGE_TO_EDGE ? frameInsets(safeArea(), keyboardFrame().height, mobileBottomNavVisible()) : null,
);
/** A right-docked sheet's room for the system bars on Android (it covers the frame); null elsewhere. */
export const rightSheetSystemInsets = computed(() => (EDGE_TO_EDGE ? rightSheetInsets(safeArea(), keyboardFrame().height) : null));

function normalizeNavPath(path: string) {
  const normalized = String(path || "").trim().replace(/\/+$/, "");
  return normalized || "/";
}

/** Whether `path` is the nav item's page or a page below it. */
export function isNavPathActive(item: { id?: string } | null | undefined, path: string) {
  if (!item || typeof item.id !== "string" || !item.id) return false;
  const current = normalizeNavPath(path);
  const target = normalizeNavPath(item.id);
  return current === target || current.startsWith(`${target}/`);
}

export interface NavItem {
  id: string;
  pagePath: string;
  title: string;
  icon: string;
  separator?: boolean;
}

export const navItems = computed<NavItem[]>(() =>
  NAV_ITEMS_META.map((item) =>
    "separator" in item
      ? { id: item.id, pagePath: "", title: "", icon: "", separator: true }
      : {
          id: endpointRoutePath(endpointState.selectedRef, item.id),
          pagePath: item.id,
          title: translate(item.titleKey),
          icon: item.icon,
        },
  ),
);

export interface EndpointItem {
  id: string;
  title: string;
  value: string;
  /** The avatar: a URL, or the app's logo. */
  image: string | typeof defaultEndpointAvatar;
  connected: boolean;
}

export const endpointItems = computed<EndpointItem[]>(() =>
  visibleEndpoints(endpointState.items).map((item: { agent_name?: string; avatar_url?: string; connected?: boolean }) => {
    const display = endpointDisplayItem(item, translate);
    return {
      id: display.value,
      title: String(item?.agent_name || "").trim() || display.title,
      value: display.value,
      image: String(item?.avatar_url || "").trim() || defaultEndpointAvatar,
      connected: item?.connected === true,
    };
  }),
);

export const selectedEndpointItem = computed(
  () => endpointItems().find((item) => item.value === endpointState.selectedRef) || null,
);

function chatPagePath(topicID = "") {
  const id = String(topicID || "").trim();
  return id ? `/chat/${encodeURIComponent(id)}` : "/chat";
}

/** The endpoint chat submits to: its mapped submit endpoint, or itself when it can submit. */
export function chatSubmitEndpointRef(endpointRef: string) {
  const selected = runtimeEndpointByRef(endpointRef);
  if (!selected) {
    return "";
  }
  const mapped = String(selected.submit_endpoint_ref || "").trim();
  if (mapped) {
    return mapped;
  }
  return selected.can_submit ? String(selected.endpoint_ref || "").trim() : "";
}

function navTargetPath(item: NavItem, restoreChatTopic = true) {
  if (!item?.id) return "";
  if (restoreChatTopic && item.pagePath === "/chat") {
    return endpointRoutePath(
      endpointState.selectedRef,
      chatPagePath(lastTopicID(chatSubmitEndpointRef(endpointState.selectedRef))),
    );
  }
  return item.id;
}

/** Opens a nav item; chat reopens its last topic. */
export function goTo(item: NavItem, restoreChatTopic = true) {
  const next = navTargetPath(item, restoreChatTopic);
  if (!next) return;
  closeMobileMore();
  if (untracked(() => route()?.path) !== next) {
    // The navigation's pages move in its order (lib/navMotion.ts).
    void navigate(next, { tab: true });
  }
}

/**
 * Switches to another endpoint, staying on the same page where it can. Chat reopens that agent's
 * last topic on wide windows; on a phone it opens the topic list.
 */
export function switchEndpoint(value: string) {
  closeMobileMore();
  const targetRef = String(value || "").trim();
  const canSelect = visibleEndpoints(endpointState.items, { connectedOnly: true }).some(
    (endpoint: { endpoint_ref: string }) => endpoint.endpoint_ref === targetRef,
  );
  if (!canSelect) return;
  const path = untracked(() => route()?.path) || "";
  const topicID = untracked(isMobile) ? "" : lastTopicID(chatSubmitEndpointRef(targetRef));
  const next = endpointSwitchPath(targetRef, path, topicID);
  if (next && next !== path) void navigate(next);
}

/** Opens the overview of every agent. */
export function goOverview() {
  closeMobileMore();
  if (untracked(() => route()?.path) !== "/overview") void navigate("/overview");
}

export function goSettings() {
  closeMobileMore();
  const next = endpointRoutePath(endpointState.selectedRef, "/settings");
  if (next && untracked(() => route()?.path) !== next) void navigate(next, { tab: true });
}

function preloadSharedResources() {
  if (inShellless() || inSetup() || !authValid.value) return;
  const endpointRef = String(endpointState.selectedRef || "").trim();
  if (!endpointRef) return;
  const contacts = useContactsStore();
  const persona = usePersonaStore();
  if (!(contacts.loaded && contacts.endpointRef === endpointRef)) {
    void contacts.load({ endpointRef, perfSource: "shared-preload" }).catch(() => {});
  }
  if (!(persona.endpointRef === endpointRef && persona.identityLoaded && persona.avatarLoaded)) {
    void persona.loadSummary({ endpointRef, perfSource: "shared-preload" }).catch(() => {});
  }
}

async function refreshEndpointsAndPreload() {
  if (!inShellless() && authValid.value) {
    if (endpointState.items.length > 0) {
      endpointState.ensureEndpointSelection();
    } else {
      try {
        await ensureEndpointsLoaded();
      } catch {
        endpointState.items = [];
      }
    }
  }
  preloadSharedResources();
}

/** Keeps the shared data fresh as the route and the endpoint change. Call once in the shell. */
export function startShell() {
  loadSidebarCollapsed();
  effect(() => {
    void route()?.fullPath;
    untracked(() => {
      closeMobileMore();
      void refreshEndpointsAndPreload();
    });
  });
  // The More menu belongs to the phone layout.
  effect(() => {
    if (!isMobile()) untracked(closeMobileMore);
  });
  effect(() => {
    void endpointState.selectedRef;
    untracked(preloadSharedResources);
  });
}
