// Which page each route shows. The router (lib/router.ts) decides the route; pages read it with
// currentRoute() and draw their content only, inside the frame the shell gives them.
import type { JSX } from "nsh";
import { Text, View } from "nsh";
import type { PageKey, Route } from "../lib/router";
import { currentRoute } from "../lib/router";
import { endpointRefFromRouteParam } from "../lib/core/endpoint-routes.js";
import { isMobile } from "../lib/shell";
import { PageStack } from "../components/frame/PageStack";
import { AuditPage } from "./audit/AuditPage";
import { ChatPage } from "./chat/ChatPage";
import { ContactsPage } from "./contacts/ContactsPage";
import { ContextPage } from "./context/ContextPage";
import { LoginPage } from "./login/LoginPage";
import { LogsPage } from "./logs/LogsPage";
import { MemoriesPage } from "./memories/MemoriesPage";
import { OverviewPage } from "./overview/OverviewPage";
import { RepairPage } from "./repair/RepairPage";
import { SettingsPage } from "./settings/SettingsPage";
import { SetupPage } from "./setup/SetupPage";
import { SkillsPage } from "./skills/SkillsPage";
import { SkillStorePage } from "./skills/SkillStorePage";
import { StatsPage } from "./stats/StatsPage";
import { TodoPage } from "./todo/TodoPage";

function NotFound() {
  return (
    <View class="flex-1 items-center justify-center">
      <Text class="text-sm text-muted-foreground">{currentRoute().path}</Text>
    </View>
  );
}

const PAGES: Record<PageKey, () => JSX.Element> = {
  login: () => <LoginPage />,
  bootPreview: () => <NotFound />,
  componentsPreview: () => <NotFound />,
  overview: () => <OverviewPage />,
  setup: () => <SetupPage />,
  repair: () => <RepairPage />,
  chat: () => <ChatPage />,
  context: () => <ContextPage />,
  stats: () => <StatsPage />,
  audit: () => <AuditPage />,
  logs: () => <LogsPage />,
  todo: () => <TodoPage />,
  memories: () => <MemoriesPage />,
  skills: () => <SkillsPage />,
  skillStore: () => <SkillStorePage />,
  contacts: () => <ContactsPage />,
  settings: () => <SettingsPage />,
  root: () => <View class="flex-1" />,
  notFound: () => <NotFound />,
};

/**
 * The current page. A page is rebuilt when its kind or its endpoint changes (as the Vue
 * console keyed its RouterView by endpoint); within one page, params and query change in place,
 * so a page follows currentRoute() in bindings and effects. The page host moves one page out and
 * the next in as navigation goes (components/frame/PageStack.tsx).
 */
export function PageView() {
  return <PageStack keyOf={pageInstanceKey} render={(route) => PAGES[route.page]()} stacked={() => isMobile()} />;
}

/** A page instance's identity: its kind and, for an agent's pages, the agent. */
export function pageInstanceKey(route: Route) {
  return `${route.page}\u0000${route.meta.endpointScoped ? endpointRefFromRouteParam(route.params.endpoint_ref) : ""}`;
}
