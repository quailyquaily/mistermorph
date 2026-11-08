// The frame around every page (the Vue console's AppLayout): a new top-level page rises 6pt into
// place as it fades in (Entrance), and the last press is noted for dialogs to grow out of. the insecure-connection banner across
// the top; on wide windows the sidebar (agent switcher, navigation, foldable edge) beside the page;
// on phones the bottom navigation with its More and agent sheets; and the notice stack over
// everything. Shellless pages (login, troubleshooting) and standalone ones (overview, setup) get
// the banner and the notices only.
import type { JSX } from "nsh";
import { View } from "nsh";
import { currentPageKey, isMobile, mobileBottomNavVisible } from "../lib/shell";
import { Entrance } from "./motion/Entrance";
import { notePress } from "./motion/pressOrigin";
import { InsecureBanner } from "./frame/InsecureBanner";
import { MobileBottomMenus, MobileBottomNav } from "./frame/MobileBottomNav";
import { Sidebar } from "./frame/Sidebar";
import { ConfirmHost, NoticeHost } from "./ui";

// The page paper's grid (Vue --morph-bg-grid-image with the morph theme's override in base.css):
// a faint 100pt grid, no minor lines, anchored at the window's corner as the body's background is
// (`background-position: -1px -1px`, each line the cell's first half point). Columns with a fill of
// their own (the sidebar) cover it, as in Vue.
const GRID_LINE = "rgba(26, 75, 140, 0.028)";
const PAPER_GRID = [90, 180]
  .map((angle) => `repeating-linear-gradient(${angle}deg, transparent 0 99px, ${GRID_LINE} 99px 99.5px, transparent 99.5px 100px)`)
  .join(", ");

export function Shell(props: { shellless: boolean; standalone: boolean; children?: JSX.Element }) {
  const withSidebar = () => !props.shellless && !props.standalone && !isMobile();
  // Every press passes here first (capture), so dialogs know which control opened them.
  return (
    <View
      class="flex-1 bg-background"
      style={{ backgroundImage: PAPER_GRID }}
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
          </If>
        </View>
      </View>
      <If when={mobileBottomNavVisible()}>
        <MobileBottomNav />
      </If>
      <NoticeHost />
      <ConfirmHost />
    </View>
  );
}
