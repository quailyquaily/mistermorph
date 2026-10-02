import { computed } from "vue";

import { uiSlots } from "../ext/slots";
import "./AppNavList.css";

const AppNavList = {
  props: {
    navItems: {
      type: Array,
      required: true,
    },
    currentPath: {
      type: String,
      required: true,
    },
    mobile: {
      type: Boolean,
      default: false,
    },
    keyPrefix: {
      type: String,
      default: "",
    },
    selectedEndpointItem: {
      type: Object,
      default: null,
    },
    t: {
      type: Function,
      default: null,
    },
    // Icons only: the folded sidebar. Each link names itself in a tooltip.
    collapsed: {
      type: Boolean,
      default: false,
    },
  },
  emits: ["navigate", "preload"],
  setup() {
    const sidebarBeforeRuntimeSlot = computed(() => uiSlots["sidebar.before_runtime"] || null);
    return { sidebarBeforeRuntimeSlot };
  },
  methods: {
    normalizePath(path) {
      if (typeof path !== "string" || !path) {
        return "/";
      }
      const normalized = path.replace(/\/+$/, "");
      return normalized || "/";
    },
    isActive(item) {
      if (!item || typeof item.id !== "string") {
        return false;
      }
      const current = this.normalizePath(this.currentPath);
      const target = this.normalizePath(item.id);
      return current === target || current.startsWith(`${target}/`);
    },
    navClass(item) {
      return this.isActive(item) ? "nav-link is-active" : "nav-link";
    },
    navCurrent(item) {
      return this.isActive(item) ? "page" : undefined;
    },
    navHref(item) {
      const value = typeof item?.id === "string" ? item.id.trim() : "";
      return value || "/";
    },
    // The slot's content has no icon-only form, so the folded sidebar leaves it out.
    shouldRenderBeforeRuntimeSlot(item) {
      return !!this.sidebarBeforeRuntimeSlot && !this.collapsed && item?.pagePath === "/settings";
    },
    onNavigate(item) {
      this.$emit("navigate", item);
    },
    onPreload(item) {
      this.$emit("preload", item);
    },
  },
  template: `
    <div :class="['sidebar-nav', { 'mobile-nav-list': mobile, 'is-collapsed': collapsed }]">
      <template v-for="item in navItems" :key="keyPrefix + item.id">
        <QDivider v-if="item.separator" class="nav-divider" aria-hidden="true" />
        <template v-else>
          <div v-if="shouldRenderBeforeRuntimeSlot(item)" class="sidebar-slot sidebar-slot-before-runtime">
            <component
              :is="sidebarBeforeRuntimeSlot"
              :selectedEndpointItem="selectedEndpointItem"
              :currentPath="currentPath"
              :mobile="mobile"
              :t="t"
            />
          </div>
          <a
            :href="navHref(item)"
            :class="navClass(item)"
            :aria-current="navCurrent(item)"
            :title="collapsed ? item.title : undefined"
            :aria-label="collapsed ? item.title : undefined"
            @focus="onPreload(item)"
            @pointerenter="onPreload(item)"
            @click.prevent="onNavigate(item)"
          >
            <component :is="item.icon" v-if="item.icon" class="nav-icon icon" />
            <span class="nav-label">{{ item.title }}</span>
          </a>
        </template>
      </template>
    </div>
  `,
};

export default AppNavList;
