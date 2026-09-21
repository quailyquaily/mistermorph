import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import "./LogsView.css";
import AppPage from "../components/AppPage";
import { endpointState, formatBytes, formatTime, runtimeApiFetchForEndpoint, translate } from "../core/context";
import { filterLogEntries, logSnapshotKey, parseLogLine } from "../core/logs";

const LIMIT_OPTIONS = [100, 300, 1000];
const LEVEL_OPTIONS = ["", "error", "warn", "info", "debug"];

export default {
  components: { AppPage },
  setup() {
    const t = translate;
    const err = ref("");
    const unsupported = ref(false);
    const loading = ref(false);
    const loadingOlder = ref(false);
    const limit = ref(300);
    const query = ref("");
    const level = ref("");
    const following = ref(true);
    const hasNewer = ref(false);
    const entries = ref([]);
    const currentFile = ref("");
    const modTime = ref("");
    const sizeBytes = ref(0);
    const nextCursor = ref("");
    const logPane = ref(null);
    const rawEntries = ref(new Set());
    let snapshotKey = null;
    let generation = 0;
    let entrySeq = 0;
    let refreshTimer;

    const filteredEntries = computed(() => filterLogEntries(entries.value, query.value, level.value));
    const filterActive = computed(() => Boolean(query.value.trim() || level.value));
    const metaText = computed(() => [
      modTime.value ? t("logs_updated", { value: formatTime(modTime.value) }) : "",
      sizeBytes.value > 0 ? formatBytes(sizeBytes.value) : "",
    ].filter(Boolean).join(" · "));
    const emptyText = computed(() => unsupported.value ? t("logs_unsupported")
      : !endpointState.selectedRef ? t("msg_select_endpoint") : t("logs_empty"));

    function toEntries(payload) {
      return (Array.isArray(payload?.items) ? payload.items : []).map((line) => ({
        ...parseLogLine(line), id: ++entrySeq, file: String(payload?.file || ""),
      }));
    }

    async function scrollToBottom() {
      await nextTick();
      if (logPane.value) logPane.value.scrollTop = logPane.value.scrollHeight;
    }

    async function loadLatest({ force = false } = {}) {
      if (loading.value || loadingOlder.value || !endpointState.selectedRef) return;
      const requestGeneration = generation;
      const endpointRef = endpointState.selectedRef;
      loading.value = true;
      try {
        const data = await runtimeApiFetchForEndpoint(endpointRef, `/logs/latest?limit=${limit.value}`);
        if (requestGeneration !== generation) return;
        err.value = "";
        unsupported.value = false;
        const key = logSnapshotKey(data);
        const changed = key !== snapshotKey;
        if (snapshotKey === null || force || (following.value && changed)) {
          currentFile.value = String(data?.file || "");
          modTime.value = String(data?.mod_time || "");
          sizeBytes.value = Number(data?.size_bytes || 0);
          nextCursor.value = data?.has_next ? String(data.next_cursor || "") : "";
          entries.value = toEntries(data);
          rawEntries.value.clear();
          snapshotKey = key;
          hasNewer.value = false;
          await scrollToBottom();
        } else {
          hasNewer.value = changed;
        }
      } catch (e) {
        if (requestGeneration !== generation) return;
        if (e?.status === 404) {
          unsupported.value = true;
          entries.value = [];
          rawEntries.value.clear();
          snapshotKey = null;
          currentFile.value = "";
          modTime.value = "";
          sizeBytes.value = 0;
          nextCursor.value = "";
          hasNewer.value = false;
          err.value = "";
        } else {
          err.value = e?.message || t("msg_load_failed");
        }
      } finally {
        if (requestGeneration === generation) loading.value = false;
      }
    }

    async function loadOlder() {
      if (!nextCursor.value || loadingOlder.value || loading.value) return;
      following.value = false;
      const requestGeneration = generation;
      const el = logPane.value;
      const previousHeight = el?.scrollHeight || 0;
      const previousTop = el?.scrollTop || 0;
      loadingOlder.value = true;
      err.value = "";
      try {
        const data = await runtimeApiFetchForEndpoint(endpointState.selectedRef,
          `/logs/latest?limit=${limit.value}&cursor=${encodeURIComponent(nextCursor.value)}`);
        if (requestGeneration !== generation) return;
        entries.value = toEntries(data).concat(entries.value);
        nextCursor.value = data?.has_next ? String(data.next_cursor || "") : "";
        await nextTick();
        if (el) el.scrollTop = el.scrollHeight - previousHeight + previousTop;
      } catch (e) {
        if (requestGeneration === generation) err.value = e?.message || t("msg_load_failed");
      } finally {
        if (requestGeneration === generation) loadingOlder.value = false;
      }
    }

    function onScroll() {
      const el = logPane.value;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 48) following.value = false;
    }

    function resumeFollowing() {
      following.value = true;
      loadLatest({ force: true });
    }

    function reset() {
      generation += 1;
      loading.value = false;
      loadingOlder.value = false;
      entries.value = [];
      rawEntries.value.clear();
      currentFile.value = "";
      modTime.value = "";
      sizeBytes.value = 0;
      nextCursor.value = "";
      err.value = "";
      unsupported.value = false;
      hasNewer.value = false;
      snapshotKey = null;
      following.value = !filterActive.value;
      loadLatest();
    }

    function toggleRaw(id) {
      if (rawEntries.value.has(id)) rawEntries.value.delete(id);
      else rawEntries.value.add(id);
    }

    function clearFilters() {
      query.value = "";
      level.value = "";
    }

    function logLevelType(value) {
      return value === "error" ? "danger" : value === "warn" ? "warning" : "default";
    }

    watch([query, level], () => { following.value = false; });
    watch([() => endpointState.selectedRef, limit], reset);
    onMounted(() => {
      reset();
      refreshTimer = window.setInterval(() => {
        if (!document.hidden && !unsupported.value) loadLatest();
      }, 4000);
    });
    onUnmounted(() => {
      generation += 1;
      window.clearInterval(refreshTimer);
    });

    return {
      t, err, unsupported, loading, loadingOlder, limit, query, level, following, hasNewer,
      entries, filteredEntries, filterActive, currentFile, nextCursor, logPane, rawEntries,
      metaText, emptyText, limits: LIMIT_OPTIONS, levels: LEVEL_OPTIONS, formatTime,
      loadLatest, loadOlder, onScroll, resumeFollowing, toggleRaw, clearFilters, logLevelType,
    };
  },
  template: `
    <AppPage :title="t('logs_title')" class="logs-page">
      <section class="logs-shell">
        <header class="logs-head">
          <div class="logs-title-block">
            <h3 class="logs-current-file workspace-document-title" :title="currentFile">{{ currentFile || t('logs_unknown_file') }}</h3>
            <p class="logs-meta">{{ metaText || t('logs_meta_empty') }}</p>
          </div>
          <div class="logs-head-actions">
            <QButton class="outlined sm logs-follow-button" :disabled="loading || loadingOlder || unsupported" :aria-pressed="following"
              @click="following ? following = false : resumeFollowing()">
              <QBadge dot :type="following ? 'success' : 'default'" size="sm" />
              {{ t(following ? 'logs_pause_follow' : 'logs_resume_follow') }}
            </QButton>
            <QButton class="plain sm icon" :aria-label="t('action_refresh')" :title="t('action_refresh')"
              :loading="loading" :disabled="loadingOlder" @click="loadLatest()"><PhArrowClockwise class="icon" /></QButton>
          </div>
        </header>

        <div class="logs-toolbar">
          <QInput v-model="query" class="sm logs-search" :placeholder="t('logs_search')" :aria-label="t('logs_search')" />
          <div class="logs-levels" role="group" :aria-label="t('logs_level')">
            <QButton v-for="item in levels" :key="item" class="plain sm" :class="{ 'is-active': level === item }"
              :aria-pressed="level === item" @click="level = item">{{ item ? item.toUpperCase() : t('logs_all_levels') }}</QButton>
          </div>
        </div>
        <div class="logs-feed-meta">
          <span>{{ t('logs_visible_count', { count: filteredEntries.length, total: entries.length }) }} · {{ t('logs_filter_scope') }}</span>
          <div class="logs-limit-group" role="group" :aria-label="t('logs_line_count')">
            <span>{{ t('logs_line_count') }}</span>
            <QButton v-for="item in limits" :key="item" class="plain xs logs-limit-button" :class="{ 'is-active': limit === item }"
              :aria-pressed="limit === item" @click="limit = item">{{ item }}</QButton>
          </div>
        </div>

        <QProgress v-if="loading && !entries.length" :infinite="true" />
        <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />
        <div v-if="hasNewer" class="logs-newer-note" role="status">
          <span>{{ t('logs_new_available') }}</span>
          <QButton class="outlined sm" :disabled="loading || loadingOlder" @click="resumeFollowing">{{ t('logs_latest') }}</QButton>
        </div>

        <div ref="logPane" class="logs-stream" role="region" tabindex="0" :aria-label="t('logs_stream')" :aria-busy="loading || loadingOlder" @scroll.passive="onScroll">
          <div v-if="nextCursor" class="logs-older-row">
            <QButton class="outlined sm" :disabled="loading" :loading="loadingOlder" @click="loadOlder">{{ t('logs_load_older') }}</QButton>
          </div>
          <div v-if="!filteredEntries.length && !loading" class="logs-empty">
            <p>{{ filterActive && entries.length ? t('logs_no_matches') : emptyText }}</p>
            <QButton v-if="filterActive" class="outlined sm" @click="clearFilters">{{ t('logs_clear_filters') }}</QButton>
          </div>
          <template v-for="(item, index) in filteredEntries" :key="item.id">
            <div v-if="item.file && (index === 0 ? item.file !== currentFile : item.file !== filteredEntries[index - 1].file)" class="logs-file-marker">{{ item.file }}</div>
            <details class="logs-entry" :class="'is-' + item.level" @toggle="$event.target.open && (following = false)">
              <summary class="logs-entry-summary">
                <time :datetime="item.time" :title="item.time">{{ item.time ? formatTime(item.time) : '—' }}</time>
                <QBadge :type="logLevelType(item.level)" size="sm">{{ item.level ? item.level.toUpperCase() : 'RAW' }}</QBadge>
                <span class="logs-entry-message">{{ item.msg }}</span>
                <PhCaretRight class="icon logs-entry-chevron" />
              </summary>
              <div class="logs-entry-detail">
                <p class="logs-detail-message">{{ item.msg }}</p>
                <dl v-if="item.fields.length" class="logs-detail-fields">
                  <div v-for="field in item.fields" :key="field[0]"><dt>{{ field[0] }}</dt><dd>{{ field[1] }}</dd></div>
                </dl>
                <QButton class="outlined sm" :aria-expanded="rawEntries.has(item.id)" @click="toggleRaw(item.id)">
                  <PhCode class="icon" />{{ t(rawEntries.has(item.id) ? 'logs_hide_raw' : 'logs_show_raw') }}
                </QButton>
                <pre v-if="rawEntries.has(item.id)" class="logs-raw"><code>{{ item.line }}</code></pre>
              </div>
            </details>
          </template>
        </div>
      </section>
    </AppPage>
  `,
};
