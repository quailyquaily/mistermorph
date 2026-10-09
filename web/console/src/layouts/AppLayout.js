import { computed, onBeforeUnmount, ref } from "vue";

import { useAppShell } from "../composables/useAppShell";
import AppMobileBottomNav from "../components/AppMobileBottomNav";
import AppNoticeHost from "../components/AppNoticeHost";
import AppSidebar from "../components/AppSidebar";
import "./AppLayout.css";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "mistermorph.sidebarCollapsed";
// The sidebar's two widths (see --sidebar-width and --sidebar-collapsed-width in AppLayout.css).
const SIDEBAR_WIDTH = 200;
const SIDEBAR_COLLAPSED_WIDTH = 52;

function loadSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const AppLayout = {
  components: {
    AppNoticeHost,
    AppSidebar,
    AppMobileBottomNav,
  },
  setup() {
    // The sidebar folds to its icons by dragging its right edge; the choice is remembered per
    // browser. While dragged it follows the pointer, and on release it settles on the nearer width.
    const sidebarCollapsed = ref(loadSidebarCollapsed());
    const sidebarDragWidth = ref(null);
    const sidebarMidpoint = (SIDEBAR_WIDTH + SIDEBAR_COLLAPSED_WIDTH) / 2;
    const sidebarShowsCollapsed = computed(() =>
      sidebarDragWidth.value === null ? sidebarCollapsed.value : sidebarDragWidth.value < sidebarMidpoint
    );
    const workspaceStyle = computed(() =>
      sidebarDragWidth.value === null ? undefined : { gridTemplateColumns: `${sidebarDragWidth.value}px minmax(0, 1fr)` }
    );

    function setSidebarCollapsed(collapsed) {
      sidebarCollapsed.value = Boolean(collapsed);
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed.value ? "1" : "0");
      } catch {
        // The choice just is not remembered.
      }
    }

    let drag = null;
    function onEdgePointerMove(event) {
      if (!drag) return;
      const width = drag.startWidth + event.clientX - drag.startX;
      sidebarDragWidth.value = Math.min(SIDEBAR_WIDTH, Math.max(SIDEBAR_COLLAPSED_WIDTH, width));
    }
    function endEdgeDrag() {
      if (!drag) return;
      window.removeEventListener("pointermove", onEdgePointerMove);
      window.removeEventListener("pointerup", endEdgeDrag);
      window.removeEventListener("pointercancel", endEdgeDrag);
      document.body.classList.remove("is-resizing-sidebar");
      if (sidebarDragWidth.value !== null) setSidebarCollapsed(sidebarDragWidth.value < sidebarMidpoint);
      sidebarDragWidth.value = null;
      drag = null;
    }
    function onEdgePointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { startX: event.clientX, startWidth: sidebarCollapsed.value ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH };
      document.body.classList.add("is-resizing-sidebar");
      window.addEventListener("pointermove", onEdgePointerMove);
      window.addEventListener("pointerup", endEdgeDrag);
      window.addEventListener("pointercancel", endEdgeDrag);
    }
    function onEdgeKeydown(event) {
      if (event.key === "ArrowLeft") setSidebarCollapsed(true);
      else if (event.key === "ArrowRight") setSidebarCollapsed(false);
      else if (event.key === "Enter" || event.key === " ") setSidebarCollapsed(!sidebarCollapsed.value);
      else return;
      event.preventDefault();
    }
    onBeforeUnmount(endEdgeDrag);

    return {
      ...useAppShell(),
      sidebarCollapsed,
      sidebarShowsCollapsed,
      sidebarDragWidth,
      workspaceStyle,
      onEdgePointerDown,
      onEdgeKeydown,
    };
  },
  template: `
    <div>
      <section v-if="inShellless">
        <RouterView :key="endpointViewKey" />
        <AppNoticeHost viewport />
      </section>
      <section
        v-else
        class="app-shell"
        :class="{ 'has-mobile-nav': mobileBottomNavVisible }"
        :style="{ '--app-viewport-height': appViewportHeight }"
      >
        <div
          :class="[
            'workspace',
            {
              'is-mobile': mobileMode || inStandalone,
              'is-sidebar-collapsed': sidebarCollapsed && !mobileMode && !inStandalone,
              'is-resizing': sidebarDragWidth !== null,
            },
          ]"
          :style="workspaceStyle"
        >
          <AppSidebar
            v-if="!mobileMode && !inStandalone"
            :t="t"
            :endpointItems="endpointItems"
            :selectedEndpointItem="selectedEndpointItem"
            :navItems="navItems"
            :currentPath="currentPath"
            :collapsed="sidebarShowsCollapsed"
            @edge-pointerdown="onEdgePointerDown"
            @edge-keydown="onEdgeKeydown"
            @navigate="goTo"
            @preload="preloadNavItem"
            @endpoint-change="onEndpointChange"
            @go-settings="goSettings"
          />
          <main
            :class="[
              'content',
              {
                'content-overview': inStandalone,
                'content-page': inWorkspacePage,
              },
            ]"
          >
            <RouterView :key="endpointViewKey" />
          </main>
          <AppNoticeHost />
        </div>
        <AppMobileBottomNav
          v-if="mobileBottomNavVisible"
          v-model="mobileMoreOpen"
          :t="t"
          :endpointItems="endpointItems"
          :selectedEndpointItem="selectedEndpointItem"
          :navItems="navItems"
          :currentPath="currentPath"
          @navigate="goTo($event, false)"
          @preload="preloadNavItem($event, false)"
          @endpoint-change="onEndpointChange"
          @close="closeMobileMore"
        />
      </section>
    </div>
  `,
};

export default AppLayout;
