import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { PhEye, PhEyeSlash } from "@phosphor-icons/vue";
import "./OverviewView.css";
import logoURL from "../assets/images/app_logo_current.svg";

import AppPage from "../components/AppPage";
import { avatarAccentColor } from "../core/avatar-color";
import { endpointDisplayItem, isConsoleLocalEndpoint, visibleEndpoints } from "../core/endpoints";
import { endpointRoutePath } from "../core/endpoint-routes";
import { endpointState, ensureEndpointsLoaded, loadEndpoints, toBool, translate } from "../core/context";

const SHOW_ADDRESSES_STORAGE_KEY = "mistermorph_console_overview_show_addresses";

const OverviewView = {
  components: {
    AppPage,
    RouterLink,
    PhEye,
    PhEyeSlash,
  },
  setup() {
    const t = translate;
    const err = ref("");
    const loading = ref(false);
    const connectionMap = ref(null);
    const connections = ref([]);
    const avatarColors = ref(new Map());
    const hoveredEndpoint = ref("");
    const focusedEndpoint = ref("");
    let resizeObserver = null;
    let layoutFrame = 0;
    const showAddresses = ref(false);
    try {
      showAddresses.value = localStorage.getItem(SHOW_ADDRESSES_STORAGE_KEY) === "true";
    } catch {
      // Keep addresses masked when browser storage is unavailable.
    }
    let refreshTimer = null;

    const endpointRows = computed(() => {
      const items = visibleEndpoints(endpointState.items);
      return items.map((item) => {
        const display = endpointDisplayItem(item, t);
        const connected = toBool(item.connected, false);
        const pending = !connected && toBool(item.health_pending, false);
        const local = isConsoleLocalEndpoint(item);
        const name = String(item.agent_name || "").trim() || String(item.name || "").trim();
        const hasAddress = !local && Boolean(String(item.url || "").trim());
        return {
          endpoint_ref: item.endpoint_ref,
          local,
          title: name || display.title,
          maskTitle: hasAddress && !name,
          maskDetail: hasAddress,
          detail: local ? t("overview_current_console") : display.meta,
          avatar_url: String(item.avatar_url || "").trim(),
          connected,
          pending,
          statusLabel: t(pending ? "overview_status_checking"
            : connected ? "endpoint_switcher_online" : "endpoint_switcher_offline"),
          route: connected ? endpointRoutePath(item.endpoint_ref, "/chat") : undefined,
        };
      }).sort((left, right) =>
        Number(right.local) - Number(left.local) ||
        Number(right.connected) - Number(left.connected) ||
        Number(right.pending) - Number(left.pending) ||
        left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" })
      );
    });
    const activeConnection = computed(() => connections.value.find((connection) =>
      connection.connected && connection.endpoint_ref === (hoveredEndpoint.value || focusedEndpoint.value)
    ));

    function readAvatarColor(image, item) {
      const source = image.getAttribute("src");
      if (item.local || !item.avatar_url || source !== item.avatar_url || source === logoURL || avatarColors.value.has(source)) return;
      const background = getComputedStyle(image).getPropertyValue("--bg-0").trim();
      avatarColors.value.set(source, avatarAccentColor(image, background));
    }

    function updateConnections() {
      const map = connectionMap.value;
      const nodes = map?.querySelectorAll(".endpoint-overview-list > li");
      const controllerIndex = endpointRows.value.findIndex((item) => item.local);
      if (!nodes?.length || controllerIndex < 0 || nodes.length < 2) {
        connections.value = [];
        return;
      }
      const bounds = map.getBoundingClientRect();
      const controller = nodes[controllerIndex].querySelector(".endpoint-overview-portrait").getBoundingClientRect();
      const sourceX = controller.x + controller.width / 2 - bounds.x;
      const sourceY = controller.bottom - bounds.y + 10;
      const targets = endpointRows.value.flatMap((item, index) => {
        if (item.local) return [];
        const portrait = nodes[index].querySelector(".endpoint-overview-portrait").getBoundingClientRect();
        return [{
          endpoint_ref: item.endpoint_ref,
          avatar_url: item.avatar_url,
          connected: item.connected,
          pending: item.pending,
          x: portrait.x + portrait.width / 2 - bounds.x,
          y: portrait.top - bounds.y - 8,
          portraitY: portrait.y + portrait.height / 2 - bounds.y,
          radius: portrait.width / 2 + 5,
        }];
      });
      const firstRowY = Math.min(...targets.map((target) => target.y));
      const branchY = (sourceY + firstRowY) / 2;
      const railX = 8;
      const measurePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      connections.value = targets.map((target) => {
        let path;
        if (Math.abs(target.y - firstRowY) < 1) {
          const direction = Math.sign(target.x - sourceX);
          const radius = Math.min(12, Math.abs(target.x - sourceX) / 2);
          path = direction === 0
            ? `M ${sourceX} ${sourceY} V ${target.y}`
            : `M ${sourceX} ${sourceY} V ${branchY - radius} Q ${sourceX} ${branchY} ${sourceX + direction * radius} ${branchY} H ${target.x - direction * radius} Q ${target.x} ${branchY} ${target.x} ${branchY + radius} V ${target.y}`;
        } else {
          // Later rows branch from an outer rail, clear of earlier avatars and labels.
          const rowY = target.y - 24;
          path = `M ${sourceX} ${sourceY} V ${branchY - 12} Q ${sourceX} ${branchY} ${sourceX - 12} ${branchY} H ${railX + 12} Q ${railX} ${branchY} ${railX} ${branchY + 12} V ${rowY - 12} Q ${railX} ${rowY} ${railX + 12} ${rowY} H ${target.x - 12} Q ${target.x} ${rowY} ${target.x} ${rowY + 12} V ${target.y}`;
        }
        measurePath.setAttribute("d", path);
        return { ...target, path, length: measurePath.getTotalLength() };
      }).sort((left, right) => Number(left.connected) - Number(right.connected));
    }

    function queueConnections() {
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = window.requestAnimationFrame(updateConnections);
    }

    watch([connectionMap, endpointRows], () => {
      resizeObserver?.disconnect();
      if (connectionMap.value) {
        resizeObserver ??= new ResizeObserver(queueConnections);
        resizeObserver.observe(connectionMap.value);
      }
      queueConnections();
    }, { flush: "post" });

    function toggleAddresses() {
      showAddresses.value = !showAddresses.value;
      try {
        localStorage.setItem(SHOW_ADDRESSES_STORAGE_KEY, String(showAddresses.value));
      } catch {
        // The toggle still works for this view without persistent storage.
      }
    }

    async function load(options = {}) {
      if (loading.value) return;
      loading.value = true;
      err.value = "";
      try {
        if (options.force === true) {
          await loadEndpoints();
        } else {
          await ensureEndpointsLoaded();
        }
      } catch (e) {
        err.value = e.message || t("msg_load_failed");
      } finally {
        loading.value = false;
      }
    }

    onMounted(() => {
      void load();
      refreshTimer = window.setInterval(() => {
        void load({ force: true });
      }, 60000);
    });
    onUnmounted(() => {
      window.clearInterval(refreshTimer);
      window.cancelAnimationFrame(layoutFrame);
      resizeObserver?.disconnect();
    });

    return {
      t, err, loading, endpointRows, logoURL, showAddresses, toggleAddresses,
      connectionMap, connections, activeConnection, hoveredEndpoint, focusedEndpoint,
      avatarColors, readAvatarColor,
    };
  },
  template: `
    <AppPage class="overview-view" :hideDesktopBar="true" :hideMobileBar="true">
      <h1 class="overview-title">{{ t('nav_overview') }}</h1>
      <QButton
        v-if="endpointRows.length"
        class="plain icon overview-address-toggle"
        :title="t(showAddresses ? 'overview_hide_addresses' : 'overview_show_addresses')"
        :aria-label="t('overview_show_addresses')"
        :aria-pressed="showAddresses"
        aria-controls="overview-endpoints"
        @click="toggleAddresses"
      >
        <PhEye v-if="showAddresses" :size="20" aria-hidden="true" />
        <PhEyeSlash v-else :size="20" aria-hidden="true" />
      </QButton>
      <QProgress v-if="loading && endpointRows.length === 0" :infinite="true" />
      <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />

      <section class="overview-page">
        <div v-if="endpointRows.length" ref="connectionMap" class="overview-connection-map">
          <svg v-if="connections.length" class="overview-connections" aria-hidden="true" focusable="false">
            <path
              v-for="connection in connections"
              :key="connection.endpoint_ref"
              :d="connection.path"
              :class="['overview-connection', { 'is-offline': !connection.connected && !connection.pending, 'is-pending': connection.pending }]"
            />
            <path v-if="activeConnection" :d="activeConnection.path" class="overview-connection is-active" />
            <template v-for="(connection, index) in connections" :key="connection.endpoint_ref">
              <g
                v-if="connection.connected"
                class="overview-connection-traffic"
                :style="{ '--connection-length': connection.length + 'px', '--connection-delay': (-index * 0.45) + 's', '--connection-color': avatarColors.get(connection.avatar_url) || undefined }"
              >
                <g class="overview-connection-pulse">
                  <path
                    v-for="part in 6"
                    :key="part"
                    class="overview-connection-glow"
                    :d="connection.path"
                    :style="{ '--pulse-length': (19 - part * 3) + 'px', strokeWidth: 0.4 + part * 0.6, strokeOpacity: part / 6 }"
                  />
                </g>
                <circle
                  class="overview-connection-arrival"
                  :cx="connection.x"
                  :cy="connection.portraitY"
                  :r="connection.radius"
                />
              </g>
            </template>
          </svg>
          <ul id="overview-endpoints" class="endpoint-overview-list">
            <li v-for="item in endpointRows" :key="item.endpoint_ref" :class="{ 'is-controller': item.local }">
              <component
                :is="item.connected ? 'RouterLink' : 'div'"
                :to="item.route"
                :class="['endpoint-overview-item', { 'is-offline': !item.connected && !item.pending }]"
                :aria-disabled="item.connected ? undefined : 'true'"
                :aria-label="!showAddresses && item.maskTitle ? t('overview_address_hidden') : undefined"
                @pointerenter="$event.pointerType === 'mouse' && (hoveredEndpoint = item.endpoint_ref)"
                @pointerleave="hoveredEndpoint = ''"
                @focus="focusedEndpoint = $event.target.matches(':focus-visible') ? item.endpoint_ref : ''"
                @blur="focusedEndpoint = ''"
              >
                <span class="endpoint-overview-portrait">
                  <img
                    class="endpoint-overview-avatar"
                    :src="item.avatar_url || logoURL"
                    alt=""
                    @load="readAvatarColor($event.target, item)"
                    @error="avatarColors.delete(item.avatar_url); $event.target.getAttribute('src') !== logoURL && ($event.target.src = logoURL)"
                  />
                  <span
                    :class="['endpoint-overview-status', { 'is-online': item.connected, 'is-pending': item.pending }]"
                    role="img"
                    :aria-label="item.statusLabel"
                    :title="item.statusLabel"
                  ></span>
                </span>
                <span class="endpoint-overview-identity">
                  <span
                    :class="['endpoint-overview-name', { 'is-private': item.maskTitle, 'is-masked': !showAddresses && item.maskTitle }]"
                    :aria-hidden="!showAddresses && item.maskTitle ? 'true' : undefined"
                  >{{ item.title }}</span>
                  <span
                    v-if="item.detail"
                    :class="['endpoint-overview-detail', { 'is-private': item.maskDetail, 'is-masked': !showAddresses && item.maskDetail }]"
                    :aria-hidden="!showAddresses && item.maskDetail ? 'true' : undefined"
                  >{{ item.detail }}</span>
                </span>
              </component>
            </li>
          </ul>
        </div>
        <p v-else-if="!loading && !err" class="muted overview-empty">{{ t('no_endpoints') }}</p>
      </section>
    </AppPage>
  `,
};

export default OverviewView;
