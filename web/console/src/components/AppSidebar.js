import { computed } from "vue";

import AppSidebarControls from "./AppSidebarControls";
import AppNavList from "./AppNavList";
import { uiSlots } from "../ext/slots";
import "./AppSidebar.css";

const AppSidebar = {
  components: {
    AppSidebarControls,
    AppNavList,
  },
  props: {
    endpointItems: {
      type: Array,
      required: true,
    },
    selectedEndpointItem: {
      type: Object,
      default: null,
    },
    navItems: {
      type: Array,
      required: true,
    },
    currentPath: {
      type: String,
      required: true,
    },
    t: {
      type: Function,
      required: true,
    },
    collapsed: {
      type: Boolean,
      default: false,
    },
  },
  emits: ["navigate", "preload", "endpoint-change", "go-settings", "edge-pointerdown", "edge-keydown"],
  setup() {
    const sidebarBottomLeftSlot = computed(() => uiSlots["sidebar.bottom_left"] || null);
    return { sidebarBottomLeftSlot };
  },
  template: `
    <aside :class="['sidebar', { 'is-collapsed': collapsed }]">
      <AppSidebarControls
        :t="t"
        :compact="collapsed"
        :endpointItems="endpointItems"
        :selectedEndpointItem="selectedEndpointItem"
        @endpoint-change="$emit('endpoint-change', $event)"
        @go-overview="$emit('navigate', { id: '/overview' })"
        @go-settings="$emit('go-settings')"
      />
      <AppNavList
        :navItems="navItems"
        :currentPath="currentPath"
        :selectedEndpointItem="selectedEndpointItem"
        :collapsed="collapsed"
        :t="t"
        @navigate="$emit('navigate', $event)"
        @preload="$emit('preload', $event)"
      />
      <div v-if="sidebarBottomLeftSlot && !collapsed" class="sidebar-slot sidebar-slot-bottom-left">
        <component
          :is="sidebarBottomLeftSlot"
          :selectedEndpointItem="selectedEndpointItem"
          :currentPath="currentPath"
          :t="t"
        />
      </div>
      <div
        class="sidebar-edge"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        :title="collapsed ? t('sidebar_expand') : t('sidebar_collapse')"
        :aria-label="collapsed ? t('sidebar_expand') : t('sidebar_collapse')"
        @pointerdown="$emit('edge-pointerdown', $event)"
        @keydown="$emit('edge-keydown', $event)"
      ></div>
    </aside>
  `,
};

export default AppSidebar;
