// The frame around every page (the Vue console's AppLayout): the pages move inside it (pages/routes.tsx
// PageView: a slide on phones, a new top-level page rising into place on wide windows), and the last
// press is noted for dialogs to grow out of. The
// insecure-connection banner across the top; on wide windows the sidebar (agent switcher,
// navigation, foldable edge) beside the page; on phones the bottom navigation, floating over the
// foot of the page, with its More and agent sheets; the workbench docked under the page (beside the
// sidebar) when a page puts something in it (frame/Workbench.tsx); and the notice stack over
// everything.
// Shellless pages (login, troubleshooting) and standalone ones (overview, setup) get the banner and
// the notices only. On the web the browser tab's icon is the selected agent's avatar
// (frame/AgentFavicon.tsx), except on shellless pages. The keyboard shortcuts are bound here
// (components/frame/shortcutDispatch.ts).
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import { hasFavicon } from "../lib/platform";
import { isMobile, mobileBottomNavVisible } from "../lib/shell";
import { notePress } from "./motion/pressOrigin";
import { AgentFavicon } from "./frame/AgentFavicon";
import { InsecureBanner } from "./frame/InsecureBanner";
import { MobileBottomMenus, MobileBottomNav } from "./frame/MobileBottomNav";
import { Sidebar } from "./frame/Sidebar";
import { startShortcutDispatch } from "./frame/shortcutDispatch";
import { Workbench } from "./frame/Workbench";
import { ConfirmHost, NoticeHost } from "./ui";

export function Shell(props: { shellless: boolean; standalone: boolean; children?: JSX.Element }) {
  const withSidebar = () => !props.shellless && !props.standalone && !isMobile();
  // The keyboard shortcuts (lib/shortcuts.ts), bound for as long as the frame is there.
  startShortcutDispatch();
  // The height of the page's column (beside the sidebar): the page, and the workbench under it.
  const room = signal(0);
  // Every press passes here first (capture), so dialogs know which control opened them.
  return (
    // Plain paper: no grid behind the pages (design/ui-refresh.html, "no background patterns").
    <View
      class="flex-1 bg-background"
      onTouchStartCapture={(event) => notePress(event.pageX, event.pageY)}
    >
      {/* The browser tab's icon: the selected agent's avatar (web only). */}
      <If when={!props.shellless && hasFavicon()}>
        <AgentFavicon />
      </If>
      <InsecureBanner />
      <View class="relative flex-1 flex-row">
        <If when={withSidebar()}>
          <Sidebar />
        </If>
        {/* The page's column: the page, and the workbench docked under it. The sidebar keeps the
            window's whole height: shortened with the page, its drawn edge (the selected row's band)
            was stretched by the layout motion and the band slid. */}
        <View class="flex-1" onLayout={({ bounds }) => room.set(bounds.size.height)}>
          <View class="relative flex-1">
            {/* The pages and their motion; the navigation below stays where it is. */}
            {props.children}
            <If when={mobileBottomNavVisible()}>
              <MobileBottomMenus />
              <MobileBottomNav />
            </If>
          </View>
          {/* Always there (0 tall while shut), so it can slide in and out; on phones too. */}
          <If when={!props.shellless && !props.standalone && room() > 0}>
            <Workbench room={room()} phone={isMobile()} />
          </If>
        </View>
      </View>
      <NoticeHost />
      <ConfirmHost />
    </View>
  );
}
