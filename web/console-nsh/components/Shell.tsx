// The frame around every page (the Vue console's AppLayout): the insecure-connection banner across
// the top; on wide windows the sidebar (agent switcher, navigation, foldable edge) beside the page;
// on phones the bottom navigation with its More and agent sheets; and the notice stack over
// everything. Shellless pages (login, troubleshooting) and standalone ones (overview, setup) get
// the banner and the notices only.
import type { JSX } from "nsh";
import { View } from "nsh";
import { isMobile, mobileBottomNavVisible } from "../lib/shell";
import { InsecureBanner } from "./frame/InsecureBanner";
import { MobileBottomMenus, MobileBottomNav } from "./frame/MobileBottomNav";
import { Sidebar } from "./frame/Sidebar";
import { ConfirmHost, NoticeHost } from "./ui";

export function Shell(props: { shellless: boolean; standalone: boolean; children?: JSX.Element }) {
  const withSidebar = () => !props.shellless && !props.standalone && !isMobile();
  return (
    <View class="flex-1 bg-background">
      <InsecureBanner />
      <View class="relative flex-1 flex-row">
        <If when={withSidebar()}>
          <Sidebar />
        </If>
        <View class="relative flex-1">
          {props.children}
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
