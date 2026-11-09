// The frame around every page (the Vue console's AppLayout): a new top-level page rises 6pt into
// place as it fades in (Entrance), and the last press is noted for dialogs to grow out of. The
// insecure-connection banner across the top; on wide windows the sidebar (agent switcher,
// navigation, foldable edge) beside the page; on phones the bottom navigation, floating over the
// foot of the page, with its More and agent sheets; and the notice stack over everything.
// Shellless pages (login, troubleshooting) and standalone ones (overview, setup) get the banner and
// the notices only.
import type { JSX } from "nsh";
import { View } from "nsh";
import { currentPageKey, isMobile, mobileBottomNavVisible } from "../lib/shell";
import { Entrance } from "./motion/Entrance";
import { notePress } from "./motion/pressOrigin";
import { InsecureBanner } from "./frame/InsecureBanner";
import { MobileBottomMenus, MobileBottomNav } from "./frame/MobileBottomNav";
import { Sidebar } from "./frame/Sidebar";
import { ConfirmHost, NoticeHost } from "./ui";

export function Shell(props: { shellless: boolean; standalone: boolean; children?: JSX.Element }) {
  const withSidebar = () => !props.shellless && !props.standalone && !isMobile();
  // Every press passes here first (capture), so dialogs know which control opened them.
  return (
    // Plain paper: no grid behind the pages (design/ui-refresh.html, "no background patterns").
    <View
      class="flex-1 bg-background"
      onTouchStartCapture={(event) => notePress(event.pageX, event.pageY)}
    >
      <InsecureBanner />
      <View class="relative flex-1 flex-row">
        <If when={withSidebar()}>
          <Sidebar />
        </If>
        <View class="relative flex-1">
          <Entrance watch={currentPageKey()} class="flex-1">
            {props.children}
          </Entrance>
          <If when={mobileBottomNavVisible()}>
            <MobileBottomMenus />
            <MobileBottomNav />
          </If>
        </View>
      </View>
      <NoticeHost />
      <ConfirmHost />
    </View>
  );
}
