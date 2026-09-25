import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { PhEye, PhEyeSlash, PhPlus } from "@phosphor-icons/vue";
import "./OverviewView.css";
import logoURL from "../assets/images/app_logo_current.svg";

import AppPage from "../components/AppPage";
import { avatarAccentColor } from "../core/avatar-color";
import { endpointDisplayItem, isConsoleLocalEndpoint, visibleEndpoints } from "../core/endpoints";
import { endpointRoutePath } from "../core/endpoint-routes";
import { currentLocale, endpointState, ensureEndpointsLoaded, loadEndpoints, runtimeApiFetchForEndpoint, toBool, translate } from "../core/context";
import { summarizeAgentReadout } from "../core/agent-readout.js";
import { formatCompactCost, formatExactCost } from "../core/cost-format.js";
import telegramLogo from "../assets/images/channels/telegram.svg";
import slackLogo from "../assets/images/channels/slack.svg";
import lineLogo from "../assets/images/channels/line.svg";
import larkLogo from "../assets/images/channels/lark.svg";
import mixinLogo from "../assets/images/channels/mixin.svg";

const SHOW_ADDRESSES_STORAGE_KEY = "mistermorph_console_overview_show_addresses";
const CHANNEL_LOGOS = { telegram: telegramLogo, slack: slackLogo, line: lineLogo, lark: larkLogo, mixin: mixinLogo };

const OverviewView = {
  components: {
    AppPage,
    RouterLink,
    PhEye,
    PhEyeSlash,
    PhPlus,
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
    const readouts = ref(new Map());

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
    const controllerSettingsRoute = computed(() => {
      const controller = endpointRows.value.find((item) => item.local);
      return controller ? {
        path: endpointRoutePath(controller.endpoint_ref, "/settings/console"),
        query: { add: "agent" },
      } : "";
    });
    const activeConnection = computed(() => connections.value.find((connection) =>
      (connection.connected || connection.add) && connection.endpoint_ref === (hoveredEndpoint.value || focusedEndpoint.value)
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
      const targets = [...endpointRows.value, { endpoint_ref: "add-console", add: true }].flatMap((item, index) => {
        if (item.local) return [];
        const portrait = nodes[index].querySelector(".endpoint-overview-portrait").getBoundingClientRect();
        return [{
          endpoint_ref: item.endpoint_ref,
          avatar_url: item.avatar_url,
          connected: item.connected,
          pending: item.pending,
          add: item.add,
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

    // Live readings for each online agent: health and uptime, model and running channels, usage.
    async function loadReadouts() {
      const targets = endpointRows.value.filter((item) => item.connected && !item.local);
      const results = await Promise.all(targets.map(async (item) => {
        const [overview, usage] = await Promise.allSettled([
          runtimeApiFetchForEndpoint(item.endpoint_ref, "/overview"),
          runtimeApiFetchForEndpoint(item.endpoint_ref, "/stats/llm/usage"),
        ]);
        return [
          item.endpoint_ref,
          summarizeAgentReadout(
            overview.status === "fulfilled" ? overview.value : null,
            usage.status === "fulfilled" ? usage.value : null,
          ),
        ];
      }));
      readouts.value = new Map(results);
    }

    const METER_SEGMENTS = 16;

    function readoutFor(item) {
      const readout = item.connected && !item.local ? readouts.value.get(item.endpoint_ref) : null;
      if (!readout) return null;
      const rate = readout.cacheRate;
      return {
        model: readout.model,
        cost: readout.cost === null ? "—" : formatCompactCost(readout.cost, readout.currency),
        costExact: readout.cost === null ? "" : formatExactCost(readout.cost, readout.currency),
        requests: readout.requests === null ? "—" : readout.requests.toLocaleString(),
        tokens: readout.tokens === null ? "—" : new Intl.NumberFormat(currentLocale(), { notation: "compact", maximumFractionDigits: 2 }).format(readout.tokens),
        tokensExact: readout.tokens === null ? "" : readout.tokens.toLocaleString(),
        uptime: readout.uptime || "—",
        cache: rate === null ? null : {
          percent: `${Math.round(rate * 100)}%`,
          lit: Math.round(rate * METER_SEGMENTS),
        },
        channels: readout.channels.map((key) => ({ key, logo: CHANNEL_LOGOS[key], title: t(`endpoint_channel_${key}`) })),
      };
    }

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
      void loadReadouts().catch(() => {});
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
      controllerSettingsRoute,
      readoutFor, meterSegments: METER_SEGMENTS,
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
            <defs>
              <!-- Draws each line in like a pen plotter; a mask keeps dashed lines' own dash pattern. -->
              <mask
                v-for="(connection, index) in connections"
                :id="'overview-plot-' + connection.endpoint_ref"
                :key="'mask:' + connection.endpoint_ref"
                maskUnits="userSpaceOnUse"
                x="-2000" y="-2000" width="6000" height="6000"
              >
                <path
                  class="overview-plot-mask"
                  :d="connection.path"
                  :style="{ '--connection-length': connection.length + 'px', '--plot-index': index }"
                />
              </mask>
            </defs>
            <path
              v-for="connection in connections"
              :key="connection.endpoint_ref"
              :d="connection.path"
              :mask="'url(#overview-plot-' + connection.endpoint_ref + ')'"
              :class="['overview-connection', { 'is-offline': !connection.add && !connection.connected && !connection.pending, 'is-pending': connection.pending, 'is-add': connection.add }]"
            />
            <path v-if="activeConnection" :d="activeConnection.path" class="overview-connection is-active" :class="{ 'is-add': activeConnection.add }" />
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
            <li v-for="(item, index) in endpointRows" :key="item.endpoint_ref" :class="{ 'is-controller': item.local }" :style="{ '--node-index': index }">
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
              <!-- Outside the link: the readout is information only, clicking it does not navigate. -->
              <template v-for="readout in [readoutFor(item)]" :key="'readout'">
                <span v-if="readout" class="endpoint-overview-readout">
                  <span class="readout-leader-line" aria-hidden="true"></span>
                  <span class="readout-head">
                    <span v-if="readout.model" class="readout-model" :title="readout.model"><span>{{ readout.model }}</span></span>
                    <span class="readout-channels">
                      <img v-for="channel in readout.channels" :key="channel.key" :src="channel.logo" :alt="channel.title" :title="channel.title" />
                    </span>
                  </span>
                  <span class="readout-spec">
                    <span class="readout-row">
                      <span class="readout-key">{{ t('overview_readout_cost') }}</span>
                      <span class="readout-dots" aria-hidden="true"></span>
                      <span class="readout-value" :title="readout.costExact">{{ readout.cost }}</span>
                    </span>
                    <span class="readout-row">
                      <span class="readout-key">{{ t('overview_readout_requests') }}</span>
                      <span class="readout-dots" aria-hidden="true"></span>
                      <span class="readout-value">{{ readout.requests }}</span>
                    </span>
                    <span class="readout-row">
                      <span class="readout-key">{{ t('overview_readout_tokens') }}</span>
                      <span class="readout-dots" aria-hidden="true"></span>
                      <span class="readout-value" :title="readout.tokensExact">{{ readout.tokens }}</span>
                    </span>
                    <span class="readout-row">
                      <span class="readout-key">{{ t('overview_readout_uptime_label') }}</span>
                      <span class="readout-dots" aria-hidden="true"></span>
                      <span class="readout-value">{{ readout.uptime }}</span>
                    </span>
                  </span>
                  <span
                    v-if="readout.cache"
                    class="readout-meter"
                    role="meter"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="parseInt(readout.cache.percent)"
                    :aria-label="t('overview_readout_cache')"
                    :title="t('overview_readout_cache_hint')"
                    :style="{ '--readout-color': avatarColors.get(item.avatar_url) || undefined }"
                  >
                    <span class="readout-key">{{ t('overview_readout_cache') }}</span>
                    <span class="readout-segments" aria-hidden="true">
                      <i v-for="segment in meterSegments" :key="segment" :class="{ 'is-lit': segment <= readout.cache.lit }"></i>
                    </span>
                    <span class="readout-value">{{ readout.cache.percent }}</span>
                  </span>
                </span>
              </template>
            </li>
            <li v-if="controllerSettingsRoute" class="endpoint-overview-add" :style="{ '--node-index': endpointRows.length }">
              <RouterLink
                :to="controllerSettingsRoute"
                class="endpoint-overview-item"
                @pointerenter="$event.pointerType === 'mouse' && (hoveredEndpoint = 'add-console')"
                @pointerleave="hoveredEndpoint = ''"
                @focus="focusedEndpoint = $event.target.matches(':focus-visible') ? 'add-console' : ''"
                @blur="focusedEndpoint = ''"
              >
                <span class="endpoint-overview-portrait"><PhPlus :size="28" aria-hidden="true" /></span>
                <span class="endpoint-overview-identity">
                  <span class="endpoint-overview-name">{{ t('overview_add_console') }}</span>
                  <span class="endpoint-overview-detail">{{ t('overview_add_console_hint') }}</span>
                </span>
              </RouterLink>
            </li>
          </ul>
        </div>
        <p v-else-if="!loading && !err" class="muted overview-empty">{{ t('no_endpoints') }}</p>
      </section>
    </AppPage>
  `,
};

export default OverviewView;
