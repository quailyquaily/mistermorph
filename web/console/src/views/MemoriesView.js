import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import "./MemoriesView.css";
import AppDialogShell from "../components/AppDialogShell";
import AppNotice from "../components/AppNotice";
import AppPage from "../components/AppPage";
import AppSection from "../components/AppSection";
import AppSkeleton from "../components/AppSkeleton";
import { endpointState, formatShortTime, runtimeApiFetch, translate } from "../core/context";
import { useContactsStore } from "../stores/contactsStore";

const VISIBILITIES = ["private", "conversation", "public"];
const TYPES = ["person", "feedback", "context", "reference"];

// subjectGroup orders the sections: the owner first, then general, then contacts and conversations.
function subjectGroup(subject) {
  if (subject === "owner") return 0;
  if (subject === "general") return 1;
  if (subject.startsWith("contact:")) return 2;
  return 3;
}

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

    const editTarget = ref(null);
    const draft = ref({ type: "", description: "", body: "", visibility: "" });
    const saving = ref(false);
    const editErr = ref("");
    const deleteTarget = ref(null);
    const deleteDialogOpen = ref(false);

    const journalQuery = ref("");
    const journalSince = ref("");
    const journalLoading = ref(false);
    const journalEvents = ref([]);
    const journalMore = ref(false);
    const journalSearched = ref(false);

    const contactNames = computed(() => {
      const names = new Map();
      for (const contact of contacts.value || []) {
        const id = String(contact?.contact_id || "").trim();
        const name = String(contact?.nickname || "").trim();
        if (id && name) names.set(id, name);
      }
      return names;
    });

    function subjectLabel(value) {
      if (value === "owner") return t("memories_subject_owner");
      if (value === "general") return t("memories_subject_general");
      if (value.startsWith("contact:")) {
        const id = value.slice("contact:".length);
        return contactNames.value.get(id) || t("memories_subject_contact", { value: id });
      }
      if (value.startsWith("conversation:")) return t("memories_subject_conversation", { value: value.slice("conversation:".length) });
      return value;
    }

    // Section titles are uppercase labels, where a raw ID reads as noise: a contact without a name
    // and a conversation are titled by kind, with the ID in the section's meta.
    function sectionTitle(value) {
      if (value.startsWith("contact:")) {
        return contactNames.value.get(value.slice("contact:".length)) || t("memories_kind_contact");
      }
      if (value.startsWith("conversation:")) return t("memories_kind_conversation");
      return subjectLabel(value);
    }

    function subjectHandle(value) {
      if (value.startsWith("contact:")) return value.slice("contact:".length);
      if (value.startsWith("conversation:")) return value.slice("conversation:".length);
      return "";
    }

    function sourceLabel(value) {
      if (!value || value === "owner") return t("memories_learned_owner");
      return subjectLabel(value);
    }

    function contactLabel(id) {
      return contactNames.value.get(id) || id;
    }

    const subjects = computed(() => {
      const seen = new Set(items.value.map((item) => item.subject));
      if (subject.value) seen.add(subject.value);
      return Array.from(seen).sort((a, b) => subjectGroup(a) - subjectGroup(b) || a.localeCompare(b));
    });
    const subjectOptions = computed(() => [
      { id: "all", title: t("memories_all_subjects"), value: "" },
      ...subjects.value.map((value) => ({ id: value, title: subjectLabel(value), value })),
    ]);
    const selectedSubjectOption = computed(() => subjectOptions.value.find((item) => item.value === subject.value) || subjectOptions.value[0]);
    const visibleItems = computed(() => {
      const needle = query.value.trim().toLowerCase();
      return items.value.filter((item) => {
        if (subject.value && item.subject !== subject.value) return false;
        if (!needle) return true;
        return [item.name, item.description, item.body, item.told_by, subjectLabel(item.subject)].join("\n").toLowerCase().includes(needle);
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
        .map(([key, list]) => ({
          key,
          title: sectionTitle(key),
          meta: [subjectHandle(key), t("memories_count", { count: list.length })].filter(Boolean).join(" · "),
          items: list,
        }));
    });
    const filterActive = computed(() => Boolean(query.value.trim() || subject.value));

    const typeOptions = computed(() => TYPES.map((value) => ({ id: value, title: t(`memories_type_${value}`), value })));
    const visibilityOptions = computed(() => VISIBILITIES.map((value) => ({ id: value, title: t(`memories_visibility_${value}`), value })));
    const editValid = computed(() => draft.value.description.trim() !== "" && !/[\r\n]/.test(draft.value.description) && draft.value.body.trim() !== "");

    function actionItems(item) {
      return [
        { id: "edit", title: t("action_edit"), action: () => startEdit(item) },
        { id: "delete-divider", divider: true },
        { id: "delete", title: t("action_delete"), danger: true, action: () => confirmDelete(item) },
      ];
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
        loaded.value = true;
      }
      // Names for contact subjects; the page works without them.
      contactsStore.load({ endpointRef: endpointState.selectedRef }).catch(() => {});
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
        items.value = items.value.map((item) => (item.id === id && data?.item ? data.item : item));
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
      { name: "delete", label: t("action_delete"), class: "danger", action: deleteMemory },
    ]);

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

    function clearFilters() {
      query.value = "";
      subject.value = "";
    }

    onMounted(load);
    watch(() => endpointState.selectedRef, load);
    watch(() => route.query.subject, (value) => {
      subject.value = String(value || "");
    });

    return {
      t, err, loading, loaded, items, query, subject, subjectOptions, selectedSubjectOption, groups, filterActive,
      editTarget, draft, saving, editErr, editValid, typeOptions, visibilityOptions,
      deleteDialogOpen, deleteDialogText, deleteDialogActions,
      journalQuery, journalSince, journalLoading, journalEvents, journalMore, journalSearched,
      actionItems, sourceLabel, contactLabel, formatShortTime, closeEdit, saveEdit, searchJournal, clearFilters,
    };
  },
  template: `
    <AppPage :title="t('memories_title')" class="memories-page" :error="err">
      <div class="memories-toolbar">
        <div class="memories-search">
          <PhMagnifyingGlass class="icon memories-search-icon" aria-hidden="true" />
          <input v-model="query" type="search" class="memories-query" :placeholder="t('memories_search')" :aria-label="t('memories_search')" />
        </div>
        <div class="memories-subject-filter">
          <AppDropdownMenu class="sm" :key="subject" :items="subjectOptions" :initialItem="selectedSubjectOption"
            @change="(item) => { subject = item.value }">
            <span class="memories-filter-value">{{ selectedSubjectOption.title }}</span>
          </AppDropdownMenu>
        </div>
      </div>
      <p class="memories-note">{{ t("memories_owner_note") }}</p>

      <AppSkeleton v-if="loading && !loaded" variant="card" height="96px" :count="3" />
      <div v-else-if="!groups.length" class="memories-empty">
        <PhBrain class="icon memories-empty-icon" aria-hidden="true" />
        <p>{{ t(items.length ? "memories_no_match" : "memories_empty") }}</p>
        <AppButton v-if="items.length && filterActive" class="outlined sm" @click="clearFilters">{{ t("logs_clear_filters") }}</AppButton>
      </div>
      <AppSection v-for="group in groups" :key="group.key" variant="boxed" class="memories-group" :title="group.title" :meta="group.meta" :level="2">
        <ul class="memory-list">
          <li v-for="item in group.items" :key="item.id" class="memory-row">
            <div class="memory-copy">
              <p class="memory-title">{{ item.description }}</p>
              <p class="memory-body">{{ item.body }}</p>
              <p class="memory-meta">
                <code class="memory-name">{{ item.name }}</code>
                <span>{{ t("memories_type_" + item.type) }}</span>
                <span :class="{ 'is-public': item.visibility === 'public' }">{{ t("memories_visibility_" + item.visibility) }}</span>
                <span>{{ t("memories_learned_in", { value: sourceLabel(item.learned_in) }) }}</span>
                <span v-if="item.told_by">{{ t("memories_told_by", { value: contactLabel(item.told_by) }) }}</span>
                <time :datetime="item.updated_at">{{ formatShortTime(item.updated_at) }}</time>
              </p>
            </div>
            <AppDropdownMenu class="memory-actions-menu" variant="plain" :items="actionItems(item)" hideSelected hideActionLabel>
              <PhDotsThree class="memory-actions-menu-icon" />
              <span class="memories-sr-only">{{ t("memories_actions", { value: item.name }) }}</span>
            </AppDropdownMenu>
          </li>
        </ul>
      </AppSection>

      <AppSection variant="boxed" class="memories-journal" :title="t('memories_journal_title')" :meta="t('memories_journal_meta')" :level="2">
        <form class="memories-toolbar" @submit.prevent="searchJournal">
          <div class="memories-search">
            <PhMagnifyingGlass class="icon memories-search-icon" aria-hidden="true" />
            <input v-model="journalQuery" type="search" class="memories-query" :placeholder="t('memories_journal_search')" :aria-label="t('memories_journal_search')" />
          </div>
          <input v-model="journalSince" type="date" class="memories-query memories-since" :aria-label="t('memories_journal_since')" :title="t('memories_journal_since')" />
          <AppButton class="outlined" type="submit" :loading="journalLoading">{{ t("memories_journal_go") }}</AppButton>
        </form>
        <p v-if="journalSearched && !journalEvents.length" class="memories-journal-empty">{{ t("memories_journal_empty") }}</p>
        <ol v-else-if="journalEvents.length" class="memory-list">
          <li v-for="event in journalEvents" :key="event.seq" class="memory-row">
            <div class="memory-copy">
              <p class="memory-body is-clamped">{{ event.text }}</p>
              <p class="memory-meta">
                <time :datetime="event.time">{{ formatShortTime(event.time) }}</time>
                <span>{{ sourceLabel(event.audience) }}</span>
                <code v-if="event.trace?.task_id" class="memory-name">{{ event.trace.task_id }}</code>
              </p>
            </div>
          </li>
        </ol>
        <p v-if="journalMore" class="memories-journal-empty">{{ t("memories_journal_more") }}</p>
      </AppSection>

      <AppDialogShell
        :modelValue="Boolean(editTarget)"
        :title="t('memories_edit_title')"
        width="560px"
        :closeDisabled="saving"
        @update:modelValue="(open) => { if (!open) closeEdit() }"
        @close="closeEdit"
      >
        <form v-if="editTarget" class="memory-edit-form" @submit.prevent="saveEdit">
          <p class="memory-meta"><code class="memory-name">{{ editTarget.name }}</code></p>
          <div class="memory-edit-row">
            <label class="memory-edit-field">
              <span>{{ t("memories_field_type") }}</span>
              <AppDropdownMenu class="sm" :key="'type-' + draft.type" :items="typeOptions" :initialItem="typeOptions.find(item => item.value === draft.type)"
                @change="(item) => { draft.type = item.value }">
                <span class="memories-filter-value">{{ t("memories_type_" + draft.type) }}</span>
              </AppDropdownMenu>
            </label>
            <label class="memory-edit-field">
              <span>{{ t("memories_field_visibility") }}</span>
              <AppDropdownMenu class="sm" :key="'vis-' + draft.visibility" :items="visibilityOptions" :initialItem="visibilityOptions.find(item => item.value === draft.visibility)"
                @change="(item) => { draft.visibility = item.value }">
                <span class="memories-filter-value">{{ t("memories_visibility_" + draft.visibility) }}</span>
              </AppDropdownMenu>
            </label>
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
        :title="t('action_delete')"
        :text="deleteDialogText"
        :actions="deleteDialogActions"
      />
    </AppPage>
  `,
};
