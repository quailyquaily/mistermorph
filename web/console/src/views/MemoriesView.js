import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import "./MemoriesView.css";
import AppDialogShell from "../components/AppDialogShell";
import AppNotice from "../components/AppNotice";
import AppPage from "../components/AppPage";
import AppSection from "../components/AppSection";
import AppSkeleton from "../components/AppSkeleton";
import { currentLocale, endpointState, formatShortTime, runtimeApiFetch, translate } from "../core/context";
import { endpointRoutePath } from "../core/endpoint-routes";
import {
  isClaim,
  isRule,
  journalDays,
  matchesQuery,
  memorySections,
  subjectID,
  subjectKind,
  subjectsOf,
} from "../core/memories-view";
import { useContactsStore } from "../stores/contactsStore";

const VISIBILITIES = ["private", "conversation", "public"];
const TYPES = ["person", "feedback", "context", "reference"];

// Laid out as Contacts and TODO are: the subjects in the second column, under the page title, and
// what is picked beside them. A subject shows its rules and facts, with who may hear each one up
// front; Journal, last in the list, is the raw record, searched, or the events a memory came from.
// On a phone the list and the picked view take turns, with a back button.
export default {
  components: { AppDialogShell, AppNotice, AppPage, AppSection, AppSkeleton },
  setup() {
    const t = translate;
    const route = useRoute();
    const contactsStore = useContactsStore();
    const { items: contacts } = storeToRefs(contactsStore);
    const err = ref("");
    const loading = ref(false);
    const loaded = ref(false);
    const items = ref([]);
    const query = ref("");
    const subject = ref(String(route.query.subject || ""));
    const expanded = ref("");

    const editTarget = ref(null);
    const draft = ref({ type: "", description: "", body: "", visibility: "" });
    const saving = ref(false);
    const editErr = ref("");
    const deleteTarget = ref(null);
    const deleteDialogOpen = ref(false);
    const publicTarget = ref("");
    const visibilityBusy = ref("");

    const view = ref("memories");
    const onJournal = computed(() => view.value === "journal");

    const isMobile = ref(false);
    const mobileDetailVisible = ref(false);
    const showIndexPane = computed(() => !isMobile.value || !mobileDetailVisible.value);
    const showMainPane = computed(() => !isMobile.value || mobileDetailVisible.value);
    const mobileShowBack = computed(() => isMobile.value && mobileDetailVisible.value);
    const mobileBarTitle = computed(() => {
      if (!mobileShowBack.value) return t("memories_title");
      if (onJournal.value) return t("memories_tab_journal");
      return subject.value ? subjectTitle(subject.value) : t("memories_all_subjects");
    });
    const pageClass = computed(() => (isMobile.value ? "memories-page memories-page-mobile-split" : "memories-page"));

    function refreshMobileMode() {
      isMobile.value = typeof window !== "undefined" && window.innerWidth <= 920;
      if (!isMobile.value) mobileDetailVisible.value = false;
    }

    function showIndexView() {
      mobileDetailVisible.value = false;
    }

    function pickSubject(value) {
      view.value = "memories";
      subject.value = value;
      mobileDetailVisible.value = true;
    }

    function pickJournal() {
      view.value = "journal";
      mobileDetailVisible.value = true;
    }

    const journalQuery = ref("");
    const journalSince = ref("");
    const journalLoading = ref(false);
    const journalEvents = ref([]);
    const journalMore = ref(false);
    const journalSearched = ref(false);
    const sourcesOf = ref(null);

    const contactNames = computed(() => {
      const names = new Map();
      for (const contact of contacts.value || []) {
        const id = String(contact?.contact_id || "").trim();
        const name = String(contact?.nickname || "").trim();
        if (id && name) names.set(id, name);
      }
      return names;
    });

    function contactName(id) {
      return contactNames.value.get(id) || id;
    }

    function subjectTitle(value) {
      switch (subjectKind(value)) {
        case "owner":
          return t("memories_subject_owner");
        case "general":
          return t("memories_subject_general");
        case "contact":
          return contactNames.value.get(subjectID(value)) || subjectID(value);
        case "conversation":
          return subjectID(value);
      }
      return value || t("memories_all_subjects");
    }

    function subjectMeta(value) {
      switch (subjectKind(value)) {
        case "owner":
          return t("memories_meta_owner");
        case "general":
          return t("memories_meta_general");
        case "contact":
          return contactNames.value.has(subjectID(value)) ? subjectID(value) : t("memories_kind_contact");
        case "conversation":
          return t("memories_kind_conversation");
      }
      return t("memories_meta_all");
    }

    function subjectLine(value) {
      switch (subjectKind(value)) {
        case "owner":
          return t("memories_line_owner");
        case "general":
          return t("memories_line_general");
        case "contact":
          return t("memories_line_contact", { value: subjectTitle(value) });
        case "conversation":
          return t("memories_line_conversation");
      }
      return t("memories_owner_note");
    }

    // audienceLabel names where something was heard: you, someone's DM, or a conversation.
    function audienceLabel(value) {
      switch (subjectKind(value)) {
        case "contact":
          return t("memories_audience_contact", { value: contactName(subjectID(value)) });
        case "conversation":
          return subjectID(value);
      }
      return t("memories_learned_owner");
    }

    function learnedText(item) {
      if (item.told_by && !isClaim(item)) return t("memories_in_own_words", { value: contactName(item.told_by) });
      return t("memories_learned_in", { value: audienceLabel(item.learned_in) });
    }

    const filtered = computed(() =>
      items.value.filter((item) => matchesQuery(item, query.value, [subjectTitle(item.subject), contactName(item.told_by || "")]))
    );

    const indexItems = computed(() => {
      const all = filtered.value;
      const rows = [{ subject: "", kind: "all", list: all }];
      // You and General are listed before anything is saved about them.
      for (const entry of subjectsOf(items.value, ["owner", "general"])) {
        rows.push({ subject: entry.subject, kind: entry.kind, list: all.filter((item) => item.subject === entry.subject) });
      }
      if (subject.value && !rows.some((row) => row.subject === subject.value)) {
        rows.push({ subject: subject.value, kind: subjectKind(subject.value), list: [] });
      }
      let lastGroup = "";
      return rows.map((row) => {
        const group = row.kind === "owner" || row.kind === "general" ? "owner" : row.kind === "contact" ? "contacts" : row.kind === "conversation" ? "groups" : "";
        const divider = group && group !== lastGroup ? t(`memories_index_${group}`) : "";
        if (group) lastGroup = group;
        return {
          key: row.subject || "all",
          subject: row.subject,
          kind: row.kind,
          divider,
          title: subjectTitle(row.subject),
          meta: subjectMeta(row.subject),
          count: String(row.list.length),
          active: row.subject === subject.value,
        };
      });
    });

    const sections = computed(() =>
      memorySections(filtered.value, subject.value).map((section) => {
        if (section.subject !== undefined) {
          const rules = section.items.filter(isRule).length;
          const count = [countText("memories_count_memory", section.items.length), rules ? countText("memories_count_rule", rules) : ""]
            .filter(Boolean)
            .join(", ");
          return { ...section, title: subjectTitle(section.subject), meta: `${subjectMeta(section.subject)} · ${count}`, literal: subjectKind(section.subject) !== "owner" && subjectKind(section.subject) !== "general" };
        }
        return { ...section, title: t(`memories_section_${section.key}`), meta: t(`memories_section_${section.key}_meta`), literal: false };
      })
    );
    const filterActive = computed(() => Boolean(query.value.trim() || subject.value));

    const typeOptions = computed(() => TYPES.map((value) => ({ id: value, title: t(`memories_type_${value}`), value })));
    const visibilityOptions = computed(() => VISIBILITIES.map((value) => ({ id: value, title: t(`memories_visibility_${value}`), value })));
    const editValid = computed(() => draft.value.description.trim() !== "" && !/[\r\n]/.test(draft.value.description) && draft.value.body.trim() !== "");

    async function load() {
      if (!endpointState.selectedRef) {
        items.value = [];
        return;
      }
      loading.value = true;
      err.value = "";
      try {
        const data = await runtimeApiFetch("/memories");
        items.value = Array.isArray(data?.items) ? data.items : [];
      } catch (e) {
        err.value = e.message || t("msg_load_failed");
      } finally {
        loading.value = false;
        loaded.value = true;
      }
      // Names for contact subjects; the page works without them.
      contactsStore.load({ endpointRef: endpointState.selectedRef }).catch(() => {});
    }

    function toggle(item) {
      expanded.value = expanded.value === item.id ? "" : item.id;
      publicTarget.value = "";
    }

    function replaceItem(next) {
      if (next) items.value = items.value.map((item) => (item.id === next.id ? next : item));
    }

    async function setVisibility(item, visibility) {
      if (item.visibility === visibility || visibilityBusy.value) return;
      // Public reaches every DM and group: it is confirmed first.
      if (visibility === "public" && publicTarget.value !== item.id) {
        publicTarget.value = item.id;
        return;
      }
      publicTarget.value = "";
      visibilityBusy.value = item.id;
      err.value = "";
      try {
        const data = await runtimeApiFetch("/memories", { method: "PUT", body: { id: item.id, visibility } });
        replaceItem(data?.item);
      } catch (e) {
        err.value = e.message || t("msg_save_failed");
      } finally {
        visibilityBusy.value = "";
      }
    }

    function startEdit(item) {
      editTarget.value = item;
      editErr.value = "";
      draft.value = { type: item.type, description: item.description, body: item.body, visibility: item.visibility };
    }

    function closeEdit() {
      if (!saving.value) editTarget.value = null;
    }

    async function saveEdit() {
      const id = editTarget.value?.id;
      if (!id || saving.value || !editValid.value) return;
      saving.value = true;
      editErr.value = "";
      try {
        const data = await runtimeApiFetch("/memories", {
          method: "PUT",
          body: { id, ...draft.value, description: draft.value.description.trim(), body: draft.value.body.trim() },
        });
        replaceItem(data?.item);
        editTarget.value = null;
      } catch (e) {
        editErr.value = e.message || t("msg_save_failed");
      } finally {
        saving.value = false;
      }
    }

    function confirmDelete(item) {
      deleteTarget.value = item;
      deleteDialogOpen.value = true;
    }

    async function deleteMemory() {
      const target = deleteTarget.value;
      deleteDialogOpen.value = false;
      if (!target) return;
      err.value = "";
      try {
        await runtimeApiFetch(`/memories?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
        items.value = items.value.filter((entry) => entry.id !== target.id);
      } catch (e) {
        err.value = e.message || t("msg_delete_failed");
      } finally {
        deleteTarget.value = null;
      }
    }

    const deleteDialogText = computed(() => t("memories_delete_confirm", { value: deleteTarget.value?.description || "" }));
    const deleteDialogActions = computed(() => [
      { name: "cancel", label: t("action_cancel"), class: "outlined", action: () => { deleteDialogOpen.value = false; } },
      { name: "delete", label: t("memories_forget"), class: "danger", action: deleteMemory },
    ]);

    // countText picks the key's _one or _many form.
    function countText(key, count) {
      return t(count === 1 ? `${key}_one` : `${key}_many`, { count });
    }

    function sourceLabel(item) {
      const count = Array.isArray(item.source_events) ? item.source_events.length : 0;
      return count ? countText("memories_count_source", count) : t("memories_no_source");
    }

    async function fetchJournal(params) {
      journalLoading.value = true;
      err.value = "";
      try {
        params.set("limit", "50");
        const data = await runtimeApiFetch(`/journal/search?${params.toString()}`);
        journalEvents.value = Array.isArray(data?.events) ? data.events : [];
        journalMore.value = Boolean(data?.has_more);
        journalSearched.value = true;
      } catch (e) {
        err.value = e.message || t("msg_load_failed");
      } finally {
        journalLoading.value = false;
      }
    }

    function searchJournal() {
      sourcesOf.value = null;
      const params = new URLSearchParams();
      if (journalQuery.value.trim()) params.set("q", journalQuery.value.trim());
      if (journalSince.value) params.set("since", journalSince.value);
      fetchJournal(params);
    }

    function showSources(item) {
      const ids = Array.isArray(item.source_events) ? item.source_events : [];
      if (!ids.length) return;
      sourcesOf.value = item;
      view.value = "journal";
      fetchJournal(new URLSearchParams({ ids: ids.join(",") }));
    }

    function backToMemory() {
      const item = sourcesOf.value;
      sourcesOf.value = null;
      view.value = "memories";
      if (item) {
        subject.value = item.subject;
        expanded.value = item.id;
      }
    }

    function clearSources() {
      sourcesOf.value = null;
      journalEvents.value = [];
      journalSearched.value = false;
    }

    // Which memory each event led to, so the journal can point back.
    const rememberedBy = computed(() => {
      const byEvent = new Map();
      for (const item of items.value) {
        for (const id of item.source_events || []) if (!byEvent.has(id)) byEvent.set(id, item);
      }
      return byEvent;
    });

    function openMemory(item) {
      view.value = "memories";
      sourcesOf.value = null;
      subject.value = item.subject;
      expanded.value = item.id;
    }

    const dayFormat = computed(() => new Intl.DateTimeFormat(currentLocale(), { weekday: "short", month: "short", day: "numeric" }));
    const clockFormat = computed(() => new Intl.DateTimeFormat(currentLocale(), { hour: "2-digit", minute: "2-digit" }));
    function safeFormat(format, value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value || "") : format.format(date);
    }

    const days = computed(() =>
      journalDays(
        journalEvents.value.map((event) => ({
          ...event,
          clock: safeFormat(clockFormat.value, event.time),
          audienceText: audienceLabel(event.audience || "owner"),
          audienceKind: subjectKind(event.audience || "owner"),
          chatPath: event.trace?.topic_id && event.trace?.runtime === "console"
            ? endpointRoutePath(endpointState.selectedRef, `/chat/${encodeURIComponent(event.trace.topic_id)}`)
            : "",
          memory: sourcesOf.value ? null : rememberedBy.value.get(event.id) || null,
        })),
        (time) => safeFormat(dayFormat.value, time),
      )
    );

    function clearFilters() {
      query.value = "";
      subject.value = "";
    }

    onMounted(() => {
      refreshMobileMode();
      // A link to one subject opens on it, on a phone too.
      if (route.query.subject) mobileDetailVisible.value = true;
      window.addEventListener("resize", refreshMobileMode);
      load();
    });
    onUnmounted(() => window.removeEventListener("resize", refreshMobileMode));
    watch(() => endpointState.selectedRef, load);
    watch(() => route.query.subject, (value) => {
      if (value) pickSubject(String(value));
      else subject.value = "";
    });

    return {
      t, err, loading, loaded, items, query, subject, expanded, onJournal,
      showIndexPane, showMainPane, mobileShowBack, mobileBarTitle, pageClass, showIndexView, pickSubject, pickJournal,
      indexItems, sections, filterActive,
      editTarget, draft, saving, editErr, editValid, typeOptions, visibilityOptions, publicTarget, visibilityBusy,
      deleteDialogOpen, deleteDialogText, deleteDialogActions,
      journalQuery, journalSince, journalLoading, journalMore, journalSearched, sourcesOf, days,
      VISIBILITIES, countText, subjectTitle, subjectLine, learnedText, contactName, isClaim, sourceLabel, formatShortTime,
      toggle, setVisibility, startEdit, closeEdit, saveEdit, confirmDelete,
      searchJournal, showSources, backToMemory, clearSources, openMemory, clearFilters,
    };
  },
  template: `
    <AppPage
      :title="t('memories_title')"
      :class="pageClass"
      :hideDesktopBar="true"
      :hideMobileBar="showIndexPane"
      :overlayBar="true"
    >
      <template #leading>
        <div class="memories-page-bar">
          <AppButton
            v-if="mobileShowBack"
            class="plain xs icon memories-page-bar-back"
            :title="t('memories_title')"
            :aria-label="t('memories_title')"
            @click="showIndexView"
          >
            <PhArrowLeft class="icon" />
          </AppButton>
          <h2 class="page-title page-bar-title workspace-section-title">{{ mobileBarTitle }}</h2>
        </div>
      </template>

      <div class="memories-workbench">
        <aside v-if="showIndexPane" class="memories-index workspace-sidebar-section" :aria-label="t('memories_index_label')">
          <div class="memories-index-head workspace-sidebar-head">
            <h3 class="memories-index-title workspace-section-title">{{ t("memories_title") }}</h3>
          </div>

          <div v-scroll-edges class="memories-index-body">
            <div class="memories-index-filter">
              <AppInput v-model="query" class="xs memories-filter-input" :placeholder="t('memories_search')" :aria-label="t('memories_search')" />
            </div>

            <div v-if="loading && !loaded" class="memories-index-loading" aria-hidden="true">
              <AppSkeleton variant="card" height="52px" :count="4" />
            </div>
            <div v-else v-sliding-selection class="memories-index-list workspace-sidebar-list">
              <template v-for="row in indexItems" :key="row.key">
                <span v-if="row.divider" class="memories-index-divider">{{ row.divider }}</span>
                <button
                  type="button"
                  :class="['memories-index-item', 'workspace-sidebar-item', { 'is-active': !onJournal && row.active }]"
                  :aria-current="!onJournal && row.active ? 'true' : undefined"
                  @click="pickSubject(row.subject)"
                >
                  <span class="memories-index-kind" aria-hidden="true">
                    <PhListBullets v-if="row.kind === 'all'" class="icon" />
                    <PhGlobe v-else-if="row.kind === 'general'" class="icon" />
                    <PhHash v-else-if="row.kind === 'conversation'" class="icon" />
                    <PhUserCircle v-else class="icon" />
                  </span>
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ row.title }}</span>
                    <span class="workspace-sidebar-item-meta">{{ row.meta }}</span>
                  </span>
                  <span class="memories-index-count">{{ row.count }}</span>
                </button>
                <button
                  v-if="row.kind === 'all'"
                  type="button"
                  :class="['memories-index-item', 'workspace-sidebar-item', { 'is-active': onJournal }]"
                  :aria-current="onJournal ? 'true' : undefined"
                  @click="pickJournal"
                >
                  <span class="memories-index-kind" aria-hidden="true"><PhClockCounterClockwise class="icon" /></span>
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ t("memories_tab_journal") }}</span>
                    <span class="workspace-sidebar-item-meta">{{ t("memories_journal_item_meta") }}</span>
                  </span>
                </button>
              </template>
            </div>
          </div>
        </aside>

        <div v-if="showMainPane" v-scroll-edges class="memories-main">
          <AppNotice v-if="err" type="error" :text="err" />
          <template v-if="!onJournal">
            <AppSkeleton v-if="loading && !loaded" variant="card" height="96px" :count="3" />
            <template v-else>
              <header class="memories-subject">
                <h2 class="memories-subject-title">{{ subject ? subjectTitle(subject) : t("memories_all_subjects") }}</h2>
                <p class="memories-subject-line">{{ subjectLine(subject) }}</p>
              </header>

              <div v-if="!items.length" class="memories-empty">
                <PhBrain class="icon memories-empty-icon" aria-hidden="true" />
                <p>{{ t("memories_empty") }}</p>
              </div>
              <div v-else-if="!sections.length" class="memories-empty is-compact">
                <p>{{ t("memories_no_match") }}</p>
                <AppButton v-if="filterActive" class="outlined sm" @click="clearFilters">{{ t("logs_clear_filters") }}</AppButton>
              </div>

              <AppSection
                v-for="section in sections"
                :key="section.key"
                variant="boxed"
                :class="['memories-section', 'is-list', { 'is-literal': section.literal }]"
                :title="section.title"
                :meta="section.meta"
                :level="3"
              >
                <ul class="memory-list">
                  <li
                    v-for="item in section.items"
                    :key="item.id"
                    :class="['memory-row', { 'is-open': expanded === item.id }]"
                  >
                    <button type="button" class="memory-head" :aria-expanded="expanded === item.id" @click="toggle(item)">
                      <span :class="['memory-visibility', 'is-' + item.visibility]">
                        <span class="memory-visibility-mark" aria-hidden="true"></span>
                        <span>{{ t("memories_visibility_" + item.visibility) }}</span>
                      </span>
                      <span class="memory-copy">
                        <span class="memory-title">{{ item.description }}</span>
                        <span :class="['memory-body', { 'is-clamped': expanded !== item.id }]"><span v-if="isClaim(item)" class="memory-claim">{{ t("memories_says", { value: contactName(item.told_by) }) }}</span>{{ item.body }}</span>
                        <span class="memory-meta">
                          <span>{{ t("memories_type_" + item.type) }}</span>
                          <span>{{ learnedText(item) }}</span>
                          <time :datetime="item.updated_at">{{ formatShortTime(item.updated_at) }}</time>
                        </span>
                      </span>
                      <PhCaretDown class="icon memory-caret" aria-hidden="true" />
                    </button>

                    <div v-if="expanded === item.id" class="memory-more">
                      <div class="memory-more-row">
                        <span class="memories-label is-quiet">{{ t("memories_who_may_hear") }}</span>
                        <div class="memory-visibility-switch" role="group" :aria-label="t('memories_field_visibility')">
                          <button
                            v-for="value in VISIBILITIES"
                            :key="value"
                            type="button"
                            :class="['is-' + value, { 'is-active': item.visibility === value }]"
                            :aria-pressed="item.visibility === value"
                            :disabled="visibilityBusy === item.id"
                            @click="setVisibility(item, value)"
                          >
                            <span class="memory-visibility-mark" aria-hidden="true"></span>{{ t("memories_visibility_" + value) }}
                          </button>
                        </div>
                        <span class="memory-more-hint">{{ t("memories_visibility_hint_" + item.visibility) }}</span>
                      </div>

                      <div v-if="publicTarget === item.id" class="memory-confirm" role="alertdialog" :aria-label="t('memories_make_public')">
                        <span class="memory-confirm-mark" aria-hidden="true"></span>
                        <span class="memory-confirm-label"><span class="memories-bracket" aria-hidden="true">[</span>{{ t("memories_visibility_public") }}<span class="memories-bracket" aria-hidden="true">]</span></span>
                        <span class="memory-confirm-text">
                          {{ t("memories_public_confirm") }}
                          <template v-if="item.told_by">{{ t("memories_public_confirm_told", { value: contactName(item.told_by) }) }}</template>
                        </span>
                        <AppButton class="outlined sm" @click="publicTarget = ''">{{ t("action_cancel") }}</AppButton>
                        <AppButton class="primary sm" @click="setVisibility(item, 'public')">{{ t("memories_make_public") }}</AppButton>
                      </div>

                      <div class="memory-actions">
                        <AppButton class="outlined sm" :disabled="!(item.source_events || []).length" @click="showSources(item)">
                          <PhListMagnifyingGlass class="icon" aria-hidden="true" />{{ sourceLabel(item) }}
                        </AppButton>
                        <AppButton class="outlined sm" @click="startEdit(item)">{{ t("action_edit") }}</AppButton>
                        <AppButton class="plain sm memory-forget" @click="confirmDelete(item)">{{ t("memories_forget") }}</AppButton>
                        <code class="memory-name">{{ item.subject }}/{{ item.name }}</code>
                      </div>
                    </div>
                  </li>
                </ul>
              </AppSection>
            </template>
          </template>

          <template v-else>
            <form class="memories-toolbar" @submit.prevent="searchJournal">
              <div class="memories-search is-wide">
                <PhMagnifyingGlass class="icon memories-search-icon" aria-hidden="true" />
                <input v-model="journalQuery" type="search" class="memories-query" :placeholder="t('memories_journal_search')" :aria-label="t('memories_journal_search')" />
              </div>
              <input v-model="journalSince" type="date" class="memories-query memories-since" :aria-label="t('memories_journal_since')" :title="t('memories_journal_since')" />
              <AppButton class="outlined" type="submit" :loading="journalLoading">{{ t("memories_journal_go") }}</AppButton>
            </form>

            <div v-if="sourcesOf" class="memory-confirm is-sources">
              <span class="memory-confirm-mark" aria-hidden="true"></span>
              <span class="memory-confirm-label"><span class="memories-bracket" aria-hidden="true">[</span>{{ t("memories_sources_title") }}<span class="memories-bracket" aria-hidden="true">]</span></span>
              <span class="memory-confirm-text">{{ t("memories_sources_for", { value: sourcesOf.description }) }}</span>
              <AppButton class="outlined sm" @click="backToMemory">{{ t("memories_back_to_memory") }}</AppButton>
              <AppButton class="plain sm" @click="clearSources">{{ t("memories_show_all") }}</AppButton>
            </div>

            <p v-if="!journalSearched" class="memories-note">{{ t("memories_journal_meta") }}</p>
            <div v-else-if="!days.length" class="memories-empty is-compact"><p>{{ t("memories_journal_empty") }}</p></div>
            <AppSection
              v-for="day in days"
              :key="day.label"
              variant="boxed"
              class="memories-section is-list"
              :title="day.label"
              :meta="countText('memories_count_event', day.events.length)"
              :level="2"
            >
              <ol class="memory-list">
                <li v-for="event in day.events" :key="event.seq" :class="['journal-row', { 'is-source': sourcesOf }]">
                  <time class="journal-time" :datetime="event.time">{{ event.clock }}</time>
                  <span :class="['journal-audience', 'is-' + (event.audienceKind || 'owner')]"><span class="journal-audience-mark" aria-hidden="true"></span>{{ event.audienceText }}</span>
                  <div class="journal-copy">
                    <p class="journal-text">{{ event.text || t("memories_journal_no_text") }}</p>
                    <div class="journal-links">
                      <RouterLink v-if="event.chatPath" :to="event.chatPath" class="journal-task">{{ event.trace?.task_id || t("memories_open_chat") }} ↗</RouterLink>
                      <code v-else-if="event.trace?.task_id" class="journal-task">{{ event.trace.task_id }}</code>
                      <button v-if="event.memory" type="button" class="journal-memory" @click="openMemory(event.memory)">
                        {{ t("memories_remembered_as", { value: event.memory.description }) }}
                      </button>
                    </div>
                  </div>
                </li>
              </ol>
            </AppSection>
            <p v-if="journalMore" class="memories-note">{{ t("memories_journal_more") }}</p>
          </template>
        </div>
      </div>

      <AppDialogShell
        :modelValue="Boolean(editTarget)"
        :title="t('memories_edit_title')"
        width="560px"
        :closeDisabled="saving"
        @update:modelValue="(open) => { if (!open) closeEdit() }"
        @close="closeEdit"
      >
        <form v-if="editTarget" class="memory-edit-form" @submit.prevent="saveEdit">
          <p class="memory-meta"><code class="memory-name">{{ editTarget.subject }}/{{ editTarget.name }}</code></p>
          <div class="memory-edit-row">
            <div class="memory-edit-field">
              <span>{{ t("memories_field_type") }}</span>
              <AppDropdownMenu class="sm" :key="'type-' + draft.type" :items="typeOptions" :initialItem="typeOptions.find(item => item.value === draft.type)"
                @change="(item) => { draft.type = item.value }">
                <span class="memories-filter-value">{{ t("memories_type_" + draft.type) }}</span>
              </AppDropdownMenu>
            </div>
            <div class="memory-edit-field">
              <span>{{ t("memories_field_visibility") }}</span>
              <AppDropdownMenu class="sm" :key="'vis-' + draft.visibility" :items="visibilityOptions" :initialItem="visibilityOptions.find(item => item.value === draft.visibility)"
                @change="(item) => { draft.visibility = item.value }">
                <span class="memories-filter-value">{{ t("memories_visibility_" + draft.visibility) }}</span>
              </AppDropdownMenu>
            </div>
          </div>
          <p class="memory-edit-hint">{{ t("memories_visibility_hint_" + draft.visibility) }}</p>
          <label class="memory-edit-field">
            <span>{{ t("memories_field_description") }}</span>
            <AppInput v-model="draft.description" :placeholder="''" :max="200" :disabled="saving" />
          </label>
          <label class="memory-edit-field">
            <span>{{ t("memories_field_body") }}</span>
            <AppTextarea v-model="draft.body" :rows="6" :disabled="saving" />
          </label>
          <AppNotice v-if="editErr" type="error" :text="editErr" />
          <div class="memory-edit-actions">
            <AppButton type="button" class="outlined" :disabled="saving" @click="closeEdit">{{ t("action_cancel") }}</AppButton>
            <AppButton type="submit" class="primary" :loading="saving" :disabled="!editValid">{{ t("action_save") }}</AppButton>
          </div>
        </form>
      </AppDialogShell>
      <AppMessageDialog
        v-model="deleteDialogOpen"
        icon="PhTrash"
        iconColor="red"
        :title="t('memories_forget')"
        :text="deleteDialogText"
        :actions="deleteDialogActions"
      />
    </AppPage>
  `,
};
