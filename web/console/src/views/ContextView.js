import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import AppPage from "../components/AppPage";
import { contextCellGrid, contextRing } from "../core/context-inspector";
import { currentLocale, endpointState, runtimeApiFetch, translate } from "../core/context";
import { endpointRoutePath } from "../core/endpoint-routes";
import "./ContextView.css";

const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatTokens(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString(currentLocale()) : "0";
}

function formatShare(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;
}

// A topic's context window: its last main request as a grid of cells filled by its parts (system
// prompt, skills, tools, history, current message, this run's steps), each part's share of the
// cells matching its share of the tokens. Beside it, the selected part's sections or messages, and
// the selected one's text.
const ContextView = {
  components: { AppPage },
  setup() {
    const t = translate;
    const route = useRoute();
    const router = useRouter();
    const loading = ref(false);
    const error = ref("");
    const snapshot = ref(null);
    const selectedKind = ref("");
    const selectedItem = ref("");
    // Phones show one level at a time: the overview (0), a part's items (1), an item's text (2).
    const phoneQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 720px)") : null;
    const isPhone = ref(Boolean(phoneQuery?.matches));
    const phoneStep = ref(0);
    const viewEl = ref(null);
    function onPhoneChange(event) {
      isPhone.value = event.matches;
      phoneStep.value = 0;
    }
    phoneQuery?.addEventListener("change", onPhoneChange);
    onUnmounted(() => phoneQuery?.removeEventListener("change", onPhoneChange));
    let request = 0;

    const topicID = computed(() => String(route.params.topic_id || "").trim());
    const grid = computed(() => contextCellGrid(snapshot.value));
    const selected = computed(() => (grid.value?.groups || []).find((group) => group.kind === selectedKind.value) || null);
    const ring = computed(() => contextRing(grid.value, RING_CIRCUMFERENCE));
    const item = computed(() => selected.value?.items.find((entry) => entry.key === selectedItem.value) || null);

    // Opens on the largest part and its largest item, so the page is never empty.
    function selectDefault() {
      const groups = grid.value?.groups || [];
      const largest = [...groups].sort((a, b) => b.tokens - a.tokens)[0];
      if (largest) selectPart(largest.kind);
    }

    async function load() {
      const id = topicID.value;
      if (!id) return;
      const current = ++request;
      loading.value = true;
      error.value = "";
      try {
        const data = await runtimeApiFetch(`/topic/${encodeURIComponent(id)}/context`);
        if (current !== request) return;
        snapshot.value = data;
        selectedKind.value = "";
        selectedItem.value = "";
        phoneStep.value = 0;
        if (!isPhone.value) selectDefault();
      } catch (e) {
        if (current === request) {
          error.value = e?.status === 404 ? t("context_inspector_unsupported") : e?.message || t("msg_load_failed");
          snapshot.value = null;
        }
      } finally {
        if (current === request) loading.value = false;
      }
    }

    watch(() => [topicID.value, endpointState.selectedRef], load, { immediate: true });

    function goPhoneStep(step) {
      phoneStep.value = step;
      if (step === 0) {
        selectedKind.value = "";
        selectedItem.value = "";
      }
      nextTick(() => {
        const body = viewEl.value?.closest(".page-body");
        if (body) body.scrollTop = 0;
      });
    }

    function back() {
      if (isPhone.value && phoneStep.value > 0) {
        goPhoneStep(phoneStep.value - 1);
        return;
      }
      const id = topicID.value;
      router.push(endpointRoutePath(endpointState.selectedRef, id ? `/chat/${encodeURIComponent(id)}` : "/chat"));
    }

    function partLabel(kind) {
      return t(`context_inspector_part_${kind}`);
    }

    // An item's label: a prompt section's heading, a tool's name, or what a message is.
    function itemLabel(part) {
      if (!part) return "";
      if (part.kind === "section") return part.label || t("context_inspector_item_preamble");
      if (part.kind === "tool") return part.tool || part.label;
      if (part.kind === "summary") return t("context_inspector_item_summary");
      if (part.kind === "meta") return t("context_inspector_item_meta");
      if (part.role === "tool") return t("context_inspector_item_tool_result", { tool: part.tool || "?" });
      if (part.role === "assistant" && part.tool) return t("context_inspector_item_tool_call", { tool: part.tool });
      if (part.role === "assistant") return t("context_inspector_item_agent");
      if (part.role === "user") return t("context_inspector_item_user");
      return partLabel(part.kind);
    }

    function entryLabel(entry) {
      return selected.value && selected.value.items.length > 1 ? itemLabel(entry.part) : partLabel(selectedKind.value);
    }

    // The first line of an item's text, as a preview in the item list.
    // The first line of an item's text, as a preview in the item list. Headings ("## Persona",
    // "[[ Persona ]]") only repeat the label, so the first line that is not one is used.
    function snippet(part) {
      const lines = String(part?.content || "").split("\n").map((text) => text.trim()).filter(Boolean);
      const heading = /^(#{1,6}\s|\[\[.*\]\]$)/;
      const line = lines.find((text) => !heading.test(text)) || lines[0] || "";
      return line.length > 160 ? `${line.slice(0, 160)}…` : line;
    }

    function cacheLabel(cache) {
      return cache?.ttl ? t("context_inspector_cache_ttl", { ttl: cache.ttl }) : t("context_inspector_cache");
    }

    // Selecting the selected part again clears the selection.
    function togglePart(kind) {
      if (isPhone.value) {
        selectPart(kind);
        goPhoneStep(1);
        return;
      }
      if (selectedKind.value === kind) {
        selectedKind.value = "";
        selectedItem.value = "";
        return;
      }
      selectPart(kind);
    }

    function selectItem(key) {
      selectedItem.value = key;
      if (isPhone.value) goPhoneStep(2);
    }

    function selectPart(kind) {
      selectedKind.value = kind;
      const items = selected.value?.items || [];
      const largest = [...items].sort((a, b) => b.tokens - a.tokens)[0];
      selectedItem.value = largest ? largest.key : "";
    }

    const barTitle = computed(() => {
      if (isPhone.value && phoneStep.value === 2 && item.value) return entryLabel(item.value);
      if (isPhone.value && phoneStep.value >= 1 && selected.value) return partLabel(selected.value.kind);
      return t("context_inspector_title");
    });
    const showOverview = computed(() => !isPhone.value || phoneStep.value === 0);
    const showItems = computed(() => !isPhone.value || phoneStep.value === 1);
    const showText = computed(() => !isPhone.value || phoneStep.value === 2);

    const methodNote = computed(() => {
      const data = snapshot.value || {};
      if (data.method === "provider") return t("context_inspector_method_provider");
      if (data.count_note === "model_changed") return t("context_inspector_method_model_changed");
      if (data.count_note === "count_failed") return t("context_inspector_method_failed");
      if (data.count_unsupported) return t("context_inspector_method_unsupported");
      return t("context_inspector_estimate_note");
    });

    return {
      t, loading, error, snapshot, grid, selected, selectedKind, selectedItem, item, methodNote,
      ring, ringRadius: RING_RADIUS, ringCircumference: RING_CIRCUMFERENCE,
      isPhone, viewEl, barTitle, showOverview, showItems, showText, selectItem,
      back, partLabel, entryLabel, snippet, cacheLabel, togglePart, formatTokens, formatShare,
    };
  },
  template: `
    <AppPage :title="t('context_inspector_title')" class="context-page">
      <template #leading>
        <div class="context-page-bar">
          <QButton class="plain xs icon" :title="t('context_inspector_back')" :aria-label="t('context_inspector_back')" @click="back">
            <PhArrowLeft class="icon" />
          </QButton>
          <h2 class="page-title page-bar-title workspace-section-title">{{ barTitle }}</h2>
        </div>
      </template>

      <section ref="viewEl" :class="['context-view', { 'is-phone': isPhone }]">
        <QProgress v-if="loading && !grid" :infinite="true" />
        <AppNotice v-else-if="error" type="error" :text="error" />
        <p v-else-if="snapshot && !snapshot.available" class="context-view-empty">{{ t("context_inspector_empty") }}</p>

        <template v-else-if="grid">
          <div v-show="showOverview" class="context-view-overview">
            <header :class="['context-view-head', { 'has-ring': ring }]">
              <div v-if="ring" class="context-view-ring">
                <svg viewBox="0 0 100 100" aria-hidden="true">
                  <circle class="context-view-ring-track" cx="50" cy="50" :r="ringRadius" />
                  <circle
                    v-for="arc in ring.arcs"
                    :key="arc.kind"
                    :class="['context-view-ring-arc', 'is-' + arc.kind]"
                    cx="50"
                    cy="50"
                    :r="ringRadius"
                    :stroke-dasharray="arc.length + ' ' + ringCircumference"
                    :stroke-dashoffset="-arc.offset"
                  />
                  <line
                    v-if="ring.triggerAngle !== null"
                    class="context-view-ring-trigger"
                    x1="50"
                    :y1="50 - ringRadius - 8"
                    x2="50"
                    :y2="50 - ringRadius + 8"
                    :transform="'rotate(' + ring.triggerAngle + ' 50 50)'"
                  />
                </svg>
                <strong class="context-view-ring-value">{{ formatShare(grid.ratio) }}</strong>
              </div>
              <div class="context-view-head-text">
                <strong class="context-view-big">{{ formatTokens(grid.used) }}<small>{{ t("context_inspector_tokens") }}</small></strong>
                <span v-if="grid.window" class="context-view-sub">{{ t("context_inspector_of_window", { tokens: formatTokens(grid.window) }) }}</span>
                <span v-if="grid.trigger" class="context-view-trigger-chip">{{ t("context_inspector_trigger", { tokens: formatTokens(grid.trigger) }) }}</span>
              </div>
            </header>

            <div class="context-view-grid" role="group" :aria-label="t('context_inspector_bar_label')">
              <span
                v-for="cell in grid.cells"
                :key="cell.key"
                :class="['context-view-cell', 'is-' + cell.kind, { 'is-dim': selectedKind && selectedKind !== cell.kind, 'is-cache': cell.cache }]"
                :title="cell.cache ? partLabel(cell.kind) + ' · ' + cacheLabel(cell.cache) : partLabel(cell.kind)"
                @click="togglePart(cell.kind)"
              ></span>
            </div>

            <p v-if="grid.caches.length" class="context-view-cache-key">
              <span class="context-view-cache-dot" aria-hidden="true"></span>
              {{ t("context_inspector_cache_key") }}
            </p>

            <ul class="context-view-legend">
              <li v-for="group in grid.groups" :key="group.key">
                <button
                  type="button"
                  :class="['context-view-legend-item', 'is-' + group.kind, { 'is-selected': selectedKind === group.kind }]"
                  :aria-pressed="selectedKind === group.kind ? 'true' : 'false'"
                  @click="togglePart(group.kind)"
                >
                  <span class="context-view-swatch" aria-hidden="true"></span>
                  <span class="context-view-legend-name">{{ partLabel(group.kind) }}</span>
                  <span class="context-view-num">{{ formatTokens(group.tokens) }}</span>
                  <span class="context-view-num">{{ formatShare(group.share) }}</span>
                  <PhCaretRight v-if="isPhone" class="icon context-view-chevron" aria-hidden="true" />
                </button>
              </li>
            </ul>

            <p class="context-view-note">
              {{ t("context_inspector_cell", { tokens: formatTokens(grid.cellTokens) }) }}
            </p>
            <p class="context-view-note">{{ methodNote }}</p>

          </div>

          <nav v-if="selected" v-show="showItems" :class="['context-view-items', 'is-' + selected.kind]" :aria-label="partLabel(selected.kind)">
            <header class="context-view-pane-head">
              <span class="context-view-swatch" aria-hidden="true"></span>
              <span class="context-view-pane-name">{{ partLabel(selected.kind) }}</span>
              <span class="context-view-pane-count">{{ t("context_inspector_items", { count: selected.items.length }) }}</span>
              <span class="context-view-num">{{ formatTokens(selected.tokens) }} {{ t("context_inspector_tokens") }}</span>
            </header>
            <button
              v-for="entry in selected.items"
              :key="entry.key"
              type="button"
              :class="['context-view-item', { 'is-selected': selectedItem === entry.key }]"
              :aria-current="selectedItem === entry.key ? 'true' : null"
              @click="selectItem(entry.key)"
            >
              <span class="context-view-item-name">
                <span class="context-view-item-label">{{ entryLabel(entry) }}</span>
                <span v-if="entry.cache && isPhone" class="context-view-cache-dot" :title="cacheLabel(entry.cache)" :aria-label="cacheLabel(entry.cache)"></span>
                <span v-else-if="entry.cache" class="context-view-cache-badge" :title="t('context_inspector_cache_key')">{{ cacheLabel(entry.cache) }}</span>
              </span>
              <span v-if="isPhone && snippet(entry.part)" class="context-view-item-snippet">{{ snippet(entry.part) }}</span>
              <span class="context-view-item-bar" aria-hidden="true"><span :style="{ width: entry.share * 100 + '%' }"></span></span>
              <span class="context-view-num">{{ formatTokens(entry.tokens) }}</span>
              <PhCaretRight v-if="isPhone" class="icon context-view-chevron" aria-hidden="true" />
            </button>
          </nav>

          <p v-else-if="!isPhone" class="context-view-hint">{{ t("context_inspector_pick") }}</p>

          <article v-if="item" v-show="showText" :class="['context-view-text', 'is-' + selected.kind]">
            <header class="context-view-pane-head">
              <span class="context-view-text-title">{{ entryLabel(item) }}</span>
              <span v-if="item.cache" class="context-view-cache-badge" :title="t('context_inspector_cache_key')">{{ cacheLabel(item.cache) }}</span>
              <span class="context-view-num">{{ formatTokens(item.tokens) }} {{ t("context_inspector_tokens") }}</span>
            </header>
            <pre>{{ item.part.content || t("context_inspector_no_text") }}</pre>
            <p v-if="item.part.truncated" class="context-view-note">{{ t("context_inspector_truncated") }}</p>
          </article>
        </template>
      </section>
    </AppPage>
  `,
};

export default ContextView;
