import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import "./LogsView.css";
import AppPage from "../components/AppPage";
import { currentLocale, endpointState, formatBytes, formatTime, runtimeApiFetchForEndpoint, translate } from "../core/context";
import { filterLogEntries, logClock, logDayKey, logDayLabel, logFieldPreview, logSnapshotKey, parseLogLine } from "../core/logs";

const LIMIT_OPTIONS = [100, 300, 1000];
const LEVEL_OPTIONS = ["", "issues", "error", "warn", "info", "debug"];
const TIME_OPTIONS = [0, 15, 60, 1440];

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
    const event = ref("");
    const timeRange = ref(0);
    const snapshotTime = ref(Date.now());
    const following = ref(true);
    const hasNewer = ref(false);
    const entries = ref([]);
    const currentFile = ref("");
    const modTime = ref("");
    const sizeBytes = ref(0);
    const nextCursor = ref("");
    const logPane = ref(null);
    const rawEntries = ref(new Set());
    const filtersOpen = ref(false);
    let snapshotKey = null;
    let generation = 0;
    let entrySeq = 0;
    let refreshTimer;

    const filteredEntries = computed(() => filterLogEntries(entries.value, query.value, level.value, {
      event: event.value,
      since: timeRange.value ? snapshotTime.value - timeRange.value * 60000 : null,
    }));
    // Rows are grouped by local day so each sticky day header only sticks within its own group.
    const dayGroups = computed(() => {
      const locale = currentLocale();
      const groups = [];
      let prevDay = "";
      let prevFile = currentFile.value;
      for (const entry of filteredEntries.value) {
        const day = logDayKey(entry.time);
        if (!groups.length || (day && day !== prevDay)) {
          groups.push({ key: `${day}:${entry.id}`, label: day ? logDayLabel(entry.time, locale) : "", rows: [] });
        }
        groups[groups.length - 1].rows.push({
          entry,
          clock: logClock(entry.time, locale),
          fileLabel: entry.file && entry.file !== prevFile ? entry.file : "",
        });
        if (day) prevDay = day;
        if (entry.file) prevFile = entry.file;
      }
      return groups;
    });
    const activeFilterCount = computed(() => [level.value, event.value, timeRange.value].filter(Boolean).length);
    const filterActive = computed(() => Boolean(query.value.trim() || level.value || event.value || timeRange.value));
    const eventOptions = computed(() => [
      { id: "", title: t("logs_all_events"), value: "" },
      ...Array.from(new Set([...entries.value.map((entry) => entry.event), event.value].filter(Boolean)))
        .sort().map((value) => ({ id: value, title: value, value })),
    ]);
    const levelOptions = computed(() => LEVEL_OPTIONS.map((value) => ({
      id: value, title: value === "" ? t("logs_all_levels") : value === "issues" ? t("logs_issues") : value.toUpperCase(), value,
    })));
    const timeOptions = computed(() => TIME_OPTIONS.map((value) => ({ id: value, title: t(`logs_time_${value}`), value })));
    const metaText = computed(() => [
      modTime.value ? t("logs_updated", { value: formatTime(modTime.value) }) : "",
      sizeBytes.value > 0 ? formatBytes(sizeBytes.value) : "",
    ].filter(Boolean).join(" · "));
    const emptyText = computed(() => unsupported.value ? t("logs_unsupported")
      : !endpointState.selectedRef ? t("msg_select_endpoint") : t("logs_empty"));

    function toEntries(payload) {
      return (Array.isArray(payload?.items) ? payload.items : []).map((line) => {
        const entry = parseLogLine(line);
        return { ...entry, preview: logFieldPreview(entry.fields), id: ++entrySeq, file: String(payload?.file || "") };
      });
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
          snapshotTime.value = Date.now();
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
      event.value = "";
      timeRange.value = 0;
    }

    function levelLabel(value) {
      return value ? value.toUpperCase() : "RAW";
    }


    watch([query, level, event, timeRange], () => { following.value = false; });
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
      t, err, unsupported, loading, loadingOlder, limit, query, level, event, timeRange, following, hasNewer,
      entries, filteredEntries, dayGroups, filterActive, activeFilterCount, filtersOpen, nextCursor, logPane, rawEntries,
      metaText, emptyText, limits: LIMIT_OPTIONS, eventOptions, levelOptions, timeOptions, formatTime,
      loadOlder, onScroll, resumeFollowing, toggleRaw, clearFilters, levelLabel,
    };
  },
  template: `
    <AppPage :title="t('logs_title')" class="logs-page">
      <section class="logs-shell">
        <div class="logs-toolbar">
          <div class="logs-filter logs-search">
            <PhMagnifyingGlass class="icon logs-search-icon" aria-hidden="true" />
            <input id="logs-query" v-model="query" type="search" class="q-text-field logs-query" :placeholder="t('logs_search')" :aria-label="t('logs_keyword')" />
          </div>
          <QButton class="outlined sm logs-filters-toggle" :class="{ 'is-active': activeFilterCount }" :aria-expanded="filtersOpen"
            aria-controls="logs-filter-group" @click="filtersOpen = !filtersOpen">
            <PhFunnelSimple class="icon" />
            <span class="logs-sr-only">{{ t('logs_filters') }}</span>
            <span v-if="activeFilterCount" class="logs-filters-count">{{ activeFilterCount }}</span>
          </QButton>
          <QButton class="outlined sm logs-follow-button" :class="{ 'is-following': following }" :disabled="loading || loadingOlder || unsupported"
            :aria-pressed="following" :title="t(following ? 'logs_pause_follow' : 'logs_resume_follow')"
            @click="following ? following = false : resumeFollowing()">
            <span class="logs-follow-mark" aria-hidden="true"></span>
            <span class="logs-follow-label">{{ t(following ? 'logs_pause_follow' : 'logs_resume_follow') }}</span>
          </QButton>
          <div id="logs-filter-group" class="logs-filter-group" :class="{ 'is-open': filtersOpen }">
            <div class="logs-filter logs-level-filter">
              <QDropdownMenu class="sm" :key="level" :items="levelOptions" :initialItem="levelOptions.find(item => item.value === level)"
                @change="level = $event.value">
                <span class="logs-sr-only">{{ t('logs_level') }}: </span>
                <span class="logs-filter-value">{{ levelOptions.find(item => item.value === level).title }}</span>
              </QDropdownMenu>
            </div>
            <div class="logs-filter logs-event-filter">
              <QDropdownMenu class="sm" :key="event" :items="eventOptions" :initialItem="eventOptions.find(item => item.value === event)"
                use-filter use-dialog="always" scroll-height="min(400px, 60dvh)" @change="event = $event.value">
                <span class="logs-sr-only">{{ t('logs_event') }}: </span>
                <span class="logs-filter-value">{{ event || t('logs_all_events') }}</span>
              </QDropdownMenu>
            </div>
            <div class="logs-filter logs-time-filter">
              <QDropdownMenu class="sm" :key="timeRange" :items="timeOptions" :initialItem="timeOptions.find(item => item.value === timeRange)"
                @change="timeRange = $event.value">
                <span class="logs-sr-only">{{ t('logs_time_range') }}: </span>
                <span class="logs-filter-value">{{ timeOptions.find(item => item.value === timeRange).title }}</span>
              </QDropdownMenu>
            </div>
          </div>
        </div>

        <QProgress v-if="loading && !entries.length" :infinite="true" />
        <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />
        <div v-if="hasNewer" class="logs-newer-note" role="status">
          <span>{{ t('logs_new_available') }}</span>
          <QButton class="outlined sm" :disabled="loading || loadingOlder" @click="resumeFollowing">{{ t('logs_latest') }}</QButton>
        </div>

        <div class="logs-table">
          <div class="logs-columns" aria-hidden="true">
            <span>{{ t('logs_timestamp') }}</span><span>{{ t('logs_level_short') }}</span><span>{{ t('logs_event_message') }}</span><span></span>
          </div>

          <div ref="logPane" class="logs-stream" role="region" tabindex="0" :aria-label="t('logs_stream')" :aria-busy="loading || loadingOlder" @scroll.passive="onScroll">
            <div v-if="nextCursor" class="logs-older-row">
              <button type="button" class="logs-text-button" :disabled="loading || loadingOlder" @click="loadOlder">
                <PhCaretUp class="icon" />{{ t(loadingOlder ? 'runtime_loading' : 'logs_load_older') }}
              </button>
            </div>
            <div v-if="!filteredEntries.length && !loading" class="logs-empty">
              <PhTerminalWindow class="icon logs-empty-icon" aria-hidden="true" />
              <p>{{ filterActive && entries.length ? t('logs_no_matches') : emptyText }}</p>
              <QButton v-if="filterActive" class="outlined sm" @click="clearFilters">{{ t('logs_clear_filters') }}</QButton>
            </div>
            <section v-for="group in dayGroups" :key="group.key" class="logs-day">
              <div v-if="group.label" class="logs-marker logs-day-marker">{{ group.label }}</div>
              <template v-for="row in group.rows" :key="row.entry.id">
                <div v-if="row.fileLabel" class="logs-marker logs-file-marker">{{ row.fileLabel }}</div>
                <details class="logs-entry" :class="'is-' + (row.entry.level || 'raw')" @toggle="$event.target.open && (following = false)">
                  <summary class="logs-entry-summary">
                    <time :datetime="row.entry.time" :title="row.entry.time">{{ row.clock || '—' }}</time>
                    <span class="logs-level">{{ levelLabel(row.entry.level) }}</span>
                    <span class="logs-entry-message"><span class="logs-entry-event">{{ row.entry.msg }}</span><span
                      v-for="field in row.entry.preview" :key="field[0]" class="logs-preview-field"><span class="logs-preview-key">{{ field[0] }}=</span>{{ field[1] }}</span></span>
                    <PhCaretRight class="icon logs-entry-chevron" />
                  </summary>
                  <div class="logs-entry-detail">
                    <p v-if="!row.entry.event" class="logs-detail-message">{{ row.entry.msg }}</p>
                    <dl v-if="row.entry.fields.length" class="logs-detail-fields">
                      <template v-for="field in row.entry.fields" :key="field[0]"><dt>{{ field[0] }}</dt><dd>{{ field[1] }}</dd></template>
                    </dl>
                    <div class="logs-detail-actions">
                      <button v-if="row.entry.event && event !== row.entry.event" type="button" class="logs-tool-button" @click="event = row.entry.event">
                        <PhFunnelSimple class="icon" />{{ t('logs_only_event') }}
                      </button>
                      <button v-if="row.entry.event" type="button" class="logs-tool-button" :aria-expanded="rawEntries.has(row.entry.id)" @click="toggleRaw(row.entry.id)">
                        <PhCode class="icon" />{{ t(rawEntries.has(row.entry.id) ? 'logs_hide_raw' : 'logs_show_raw') }}
                      </button>
                    </div>
                    <pre v-if="rawEntries.has(row.entry.id)" class="logs-raw"><code>{{ row.entry.line }}</code></pre>
                  </div>
                </details>
              </template>
            </section>
          </div>
        </div>
        <div class="logs-feed-meta">
          <div class="logs-result-info" role="status">
            <span class="logs-result-count">{{ t('logs_visible_count', { count: filteredEntries.length, total: entries.length }) }}</span>
            <span v-if="filterActive" class="logs-filter-scope" :title="t('logs_time_hint')">{{ t('logs_filter_scope') }}</span>
            <QButton v-if="filterActive" class="plain xs logs-clear" @click="clearFilters"><PhX class="icon" />{{ t('logs_clear_filters') }}</QButton>
          </div>
          <p class="logs-meta">{{ metaText || t('logs_meta_empty') }}</p>
          <div class="logs-limit-group" role="group" :aria-label="t('logs_line_count')">
            <span class="logs-limit-label">{{ t('logs_line_count') }}</span>
            <button v-for="item in limits" :key="item" type="button" class="logs-limit-button" :class="{ 'is-active': limit === item }"
              :aria-pressed="limit === item" @click="limit = item">{{ item }}</button>
          </div>
        </div>
      </section>
    </AppPage>
  `,
};
