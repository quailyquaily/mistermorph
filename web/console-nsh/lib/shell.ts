// The app frame's state, as the Vue console's useAppShell had it: which endpoint is selected,
// the navigation, and the shared data every workspace page preloads.
import { computed, effect, signal, untracked, windowSize } from "nsh";
import defaultEndpointAvatar from "../assets/images/app_logo_current.svg";
import { lastTopicID } from "./core/chat-topic-memory.js";
import { endpointDisplayItem, visibleEndpoints } from "./core/endpoints.js";
import { endpointPagePath, endpointRoutePath, endpointSwitchPath } from "./core/endpoint-routes.js";
import { authValid, endpointState, ensureEndpointsLoaded, runtimeEndpointByRef, translate } from "./core/context.js";
import { NAV_ITEMS_META, navigate, route, currentPath } from "./router";
import { useContactsStore } from "./stores/contactsStore.js";
import { usePersonaStore } from "./stores/personaStore.js";
import { localStore } from "./platform";

export { currentPath };

/** Below this width the sidebar gives way to the bottom navigation. */
export const MOBILE_BREAKPOINT = 980;
export const isMobile = computed(() => windowSize().width <= MOBILE_BREAKPOINT);

const SIDEBAR_COLLAPSED_STORAGE_KEY = "mistermorph.sidebarCollapsed";
const collapsed = signal(false);
export const sidebarCollapsed = () => collapsed();
export function setSidebarCollapsed(next: boolean) {
  collapsed.set(Boolean(next));
  localStore.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
}
export function loadSidebarCollapsed() {
  collapsed.set(localStore.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1");
}

export const inShellless = () => route()?.meta.shellless === true;
export const inOverview = () => route()?.path === "/overview";
export const inSetup = () => {
  const path = route()?.path || "";
  const page = endpointPagePath(path) || path;
  return page === "/setup" || page.startsWith("/setup/");
};
export const inStandalone = () => inOverview() || inSetup();
export const mobileBottomNavVisible = () =>
  isMobile() && !inStandalone() && !inShellless() && route()?.meta.mobileBottomNav !== false;

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
  if (next && untracked(() => route()?.path) !== next) {
    void navigate(next);
  }
}

/** Switches to another endpoint, staying on the same page where it can. */
export function switchEndpoint(value: string) {
  const targetRef = String(value || "").trim();
  const canSelect = visibleEndpoints(endpointState.items, { connectedOnly: true }).some(
    (endpoint: { endpoint_ref: string }) => endpoint.endpoint_ref === targetRef,
  );
  if (!canSelect) return;
  endpointState.setSelectedEndpointRef(targetRef);
  const path = untracked(() => route()?.path) || "";
  const next = endpointSwitchPath(targetRef, path, lastTopicID(chatSubmitEndpointRef(targetRef)));
  if (next) void navigate(next);
}

export function goSettings() {
  void navigate(endpointRoutePath(endpointState.selectedRef, "/settings"));
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
    untracked(() => void refreshEndpointsAndPreload());
  });
  effect(() => {
    void endpointState.selectedRef;
    untracked(preloadSharedResources);
  });
}
