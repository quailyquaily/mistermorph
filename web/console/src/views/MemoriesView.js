import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import "./MemoriesView.css";
import AppPage from "../components/AppPage";
import AppSection from "../components/AppSection";
import AppSkeleton from "../components/AppSkeleton";
import { endpointState, formatShortTime, runtimeApiFetch, translate } from "../core/context";

const VISIBILITIES = ["private", "conversation", "public"];
const TYPES = ["person", "feedback", "context", "reference"];

// subjectGroup orders the list: the owner first, then general, then contacts and conversations.
function subjectGroup(subject) {
  if (subject === "owner") return 0;
  if (subject === "general") return 1;
  if (subject.startsWith("contact:")) return 2;
  return 3;
}

export default {
  components: { AppPage, AppSection, AppSkeleton },
  setup() {
    const t = translate;
    const route = useRoute();
    const err = ref("");
    const loading = ref(false);
    const items = ref([]);
    const query = ref("");
    const subject = ref(String(route.query.subject || ""));
    const editingID = ref("");
    const draft = ref({ type: "", description: "", body: "", visibility: "" });
    const saving = ref(false);
    const confirmDeleteID = ref("");

    const journalQuery = ref("");
    const journalSince = ref("");
    const journalLoading = ref(false);
    const journalEvents = ref([]);
    const journalMore = ref(false);
    const journalSearched = ref(false);

    const subjects = computed(() => {
      const seen = new Set(items.value.map((item) => item.subject));
      if (subject.value) seen.add(subject.value);
      return Array.from(seen).sort((a, b) => subjectGroup(a) - subjectGroup(b) || a.localeCompare(b));
    });
    const subjectOptions = computed(() => [
      { id: "", title: t("memories_all_subjects"), value: "" },
      ...subjects.value.map((value) => ({ id: value, title: subjectLabel(value), value })),
    ]);
    const visibleItems = computed(() => {
      const needle = query.value.trim().toLowerCase();
      return items.value.filter((item) => {
        if (subject.value && item.subject !== subject.value) return false;
        if (!needle) return true;
        return [item.name, item.description, item.body, item.subject, item.told_by].join("\n").toLowerCase().includes(needle);
      });
    });
    const groups = computed(() => {
      const bySubject = new Map();
      for (const item of visibleItems.value) {
        if (!bySubject.has(item.subject)) bySubject.set(item.subject, []);
        bySubject.get(item.subject).push(item);
      }
      return Array.from(bySubject.entries())
        .sort(([a], [b]) => subjectGroup(a) - subjectGroup(b) || a.localeCompare(b))
        .map(([key, list]) => ({ key, title: subjectLabel(key), items: list }));
    });

    function subjectLabel(value) {
      if (value === "owner") return t("memories_subject_owner");
      if (value === "general") return t("memories_subject_general");
      if (value.startsWith("contact:")) return t("memories_subject_contact", { value: value.slice("contact:".length) });
      if (value.startsWith("conversation:")) return t("memories_subject_conversation", { value: value.slice("conversation:".length) });
      return value;
    }

    function learnedLabel(value) {
      if (!value || value === "owner") return t("memories_learned_owner");
      return subjectLabel(value);
    }

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
      }
    }

    function startEdit(item) {
      editingID.value = item.id;
      confirmDeleteID.value = "";
      draft.value = { type: item.type, description: item.description, body: item.body, visibility: item.visibility };
    }

    function stopEdit() {
      editingID.value = "";
    }

    async function saveEdit() {
      const id = editingID.value;
      if (!id || saving.value) return;
      saving.value = true;
      err.value = "";
      try {
        const data = await runtimeApiFetch("/memories", {
          method: "PUT",
          body: { id, ...draft.value },
        });
        items.value = items.value.map((item) => (item.id === id && data?.item ? data.item : item));
        editingID.value = "";
      } catch (e) {
        err.value = e.message || t("msg_save_failed");
      } finally {
        saving.value = false;
      }
    }

    async function remove(item) {
      if (confirmDeleteID.value !== item.id) {
        confirmDeleteID.value = item.id;
        return;
      }
      err.value = "";
      try {
        await runtimeApiFetch(`/memories?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
        items.value = items.value.filter((entry) => entry.id !== item.id);
      } catch (e) {
        err.value = e.message || t("msg_delete_failed");
      } finally {
        confirmDeleteID.value = "";
      }
    }

    async function searchJournal() {
      journalLoading.value = true;
      err.value = "";
      try {
        const params = new URLSearchParams();
        if (journalQuery.value.trim()) params.set("q", journalQuery.value.trim());
        if (journalSince.value) params.set("since", journalSince.value);
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

    onMounted(load);
    watch(() => endpointState.selectedRef, load);
    watch(() => route.query.subject, (value) => {
      subject.value = String(value || "");
    });

    return {
      t, err, loading, items, query, subject, subjectOptions, groups, editingID, draft, saving, confirmDeleteID,
      journalQuery, journalSince, journalLoading, journalEvents, journalMore, journalSearched,
      VISIBILITIES, TYPES, learnedLabel, formatShortTime, startEdit, stopEdit, saveEdit, remove, searchJournal,
    };
  },
  template: `
    <AppPage :title="t('memories_title')" class="memories-page" :error="err">
      <p class="memories-note">{{ t("memories_owner_note") }}</p>
      <div class="memories-toolbar">
        <div class="memories-search">
          <PhMagnifyingGlass class="icon memories-search-icon" aria-hidden="true" />
          <input v-model="query" type="search" class="q-text-field" :placeholder="t('memories_search')" :aria-label="t('memories_search')" />
        </div>
        <QDropdownMenu class="sm" :key="subject" :items="subjectOptions" :initialItem="subjectOptions.find(item => item.value === subject)"
          @change="(item) => { subject = item.value }">
          <span class="memories-filter-value">{{ subjectOptions.find(item => item.value === subject)?.title }}</span>
        </QDropdownMenu>
      </div>

      <AppSkeleton v-if="loading && !items.length" variant="card" height="120px" :count="3" />
      <p v-else-if="!groups.length" class="memories-empty">{{ t(items.length ? "memories_no_match" : "memories_empty") }}</p>
      <AppSection v-for="group in groups" :key="group.key" variant="boxed" class="memories-group" :title="group.title" :level="2">
        <article v-for="item in group.items" :key="item.id" class="memory-card">
          <template v-if="editingID === item.id">
            <div class="memory-edit-row">
              <label>{{ t("memories_field_type") }}
                <select v-model="draft.type" class="q-text-field">
                  <option v-for="value in TYPES" :key="value" :value="value">{{ t("memories_type_" + value) }}</option>
                </select>
              </label>
              <label>{{ t("memories_field_visibility") }}
                <select v-model="draft.visibility" class="q-text-field">
                  <option v-for="value in VISIBILITIES" :key="value" :value="value">{{ t("memories_visibility_" + value) }}</option>
                </select>
              </label>
            </div>
            <input v-model="draft.description" class="q-text-field memory-edit-description" :aria-label="t('memories_field_description')" />
            <QTextarea v-model="draft.body" :rows="5" :aria-label="t('memories_field_body')" />
            <div class="memory-actions">
              <QButton class="outlined sm" :disabled="saving" @click="stopEdit">{{ t("action_cancel") }}</QButton>
              <QButton class="primary sm" :loading="saving" @click="saveEdit">{{ t("action_save") }}</QButton>
            </div>
          </template>
          <template v-else>
            <header class="memory-head">
              <strong class="memory-name">{{ item.name }}</strong>
              <span class="memory-tag">{{ t("memories_type_" + item.type) }}</span>
              <span class="memory-tag" :class="'is-' + item.visibility">{{ t("memories_visibility_" + item.visibility) }}</span>
            </header>
            <p class="memory-description">{{ item.description }}</p>
            <p class="memory-body">{{ item.body }}</p>
            <p class="memory-meta">
              {{ t("memories_learned_in", { value: learnedLabel(item.learned_in) }) }}
              <template v-if="item.told_by"> · {{ t("memories_told_by", { value: item.told_by }) }}</template>
              · {{ formatShortTime(item.updated_at) }}
            </p>
            <div class="memory-actions">
              <QButton class="plain sm" @click="startEdit(item)">{{ t("action_edit") }}</QButton>
              <QButton class="plain sm" :class="{ danger: confirmDeleteID === item.id }" @click="remove(item)">
                {{ confirmDeleteID === item.id ? t("memories_confirm_delete") : t("action_delete") }}
              </QButton>
            </div>
          </template>
        </article>
      </AppSection>

      <AppSection variant="boxed" class="memories-journal" :title="t('memories_journal_title')" :meta="t('memories_journal_meta')" :level="2">
        <form class="memories-toolbar" @submit.prevent="searchJournal">
          <div class="memories-search">
            <PhMagnifyingGlass class="icon memories-search-icon" aria-hidden="true" />
            <input v-model="journalQuery" type="search" class="q-text-field" :placeholder="t('memories_journal_search')" :aria-label="t('memories_journal_search')" />
          </div>
          <input v-model="journalSince" type="date" class="q-text-field memories-since" :aria-label="t('memories_journal_since')" />
          <QButton class="outlined sm" type="submit" :loading="journalLoading">{{ t("memories_journal_go") }}</QButton>
        </form>
        <p v-if="journalSearched && !journalEvents.length" class="memories-empty">{{ t("memories_journal_empty") }}</p>
        <ol v-else class="journal-hits">
          <li v-for="event in journalEvents" :key="event.seq" class="journal-hit">
            <p class="memory-meta">
              {{ formatShortTime(event.time) }} · {{ event.domain }}/{{ event.type }}
              · {{ learnedLabel(event.audience) }}<template v-if="event.trace?.task_id"> · {{ event.trace.task_id }}</template>
            </p>
            <p class="memory-body">{{ event.text }}</p>
          </li>
        </ol>
        <p v-if="journalMore" class="memory-meta">{{ t("memories_journal_more") }}</p>
      </AppSection>
    </AppPage>
  `,
};
