import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./SkillsView.css";

import AppDialogShell from "../components/AppDialogShell";
import AppFab from "../components/AppFab";
import AppPage from "../components/AppPage";
import AppSkeleton from "../components/AppSkeleton";
import MarkdownContent from "../components/MarkdownContent";
import { endpointApiFetch, endpointState, formatBytes, runtimeApiFetchForEndpoint, translate } from "../core/context";
import { endpointRoutePath } from "../core/endpoint-routes";
import { filterSkills, normalizeInstallLink, skillInstallTask, skillSourceInfo } from "../core/skills-install.js";
import { skillToggleSettings } from "../core/skills-load.js";

// Search appears once the list is long enough to need it.
const SEARCH_THRESHOLD = 8;
const FILES_PREVIEW = 8;

// The frontmatter is shown as facts above the document, so the rendered SKILL.md starts after it.
function stripFrontmatter(content) {
  const text = String(content || "");
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length).trimStart() : text;
}

function normalizeSkill(item) {
  return {
    id: String(item?.id || "").trim(),
    name: String(item?.name || item?.id || "").trim(),
    description: String(item?.description || "").trim(),
    dir: String(item?.dir || ""),
    loaded: item?.loaded === true,
    requirements: Array.isArray(item?.requirements) ? item.requirements : [],
    authProfiles: Array.isArray(item?.auth_profiles) ? item.auth_profiles : [],
    files: Array.isArray(item?.files) ? item.files : [],
    filesCapped: item?.files_capped === true,
    source: skillSourceInfo(item?.source),
    modified: Array.isArray(item?.modified) ? item.modified : [],
  };
}

// The agent's skills: a list with a switch per skill, a side sheet per skill, and Add skill,
// which starts a chat task where the agent reviews the skill and the user approves the install.
const SkillsView = {
  components: {
    AppDialogShell,
    AppFab,
    AppPage,
    AppSkeleton,
    MarkdownContent,
  },
  setup() {
    const t = translate;
    const route = useRoute();
    const router = useRouter();
    const loading = ref(false);
    const saving = ref(false);
    const err = ref("");
    const unsupported = ref(false);
    const catalog = ref({ enabled: true, load: [], roots: [], readOnly: false, readOnlyReason: "", revision: "", skills: [] });
    const detail = ref(null);
    const detailLoading = ref(false);
    const docOpen = ref(false);
    const isMobile = ref(false);
    const filesExpanded = ref(false);
    const query = ref("");
    let listSeq = 0;
    let detailSeq = 0;

    const removeTarget = ref(null);
    const removeBusy = ref(false);
    const removeErr = ref("");

    const addOpen = ref(false);
    const addLink = ref("");
    const addBusy = ref(false);
    const addErr = ref("");

    const skills = computed(() => catalog.value.skills);
    const showSearch = computed(() => skills.value.length > SEARCH_THRESHOLD);
    const visibleSkills = computed(() => (showSearch.value ? filterSkills(skills.value, query.value) : skills.value));
    const selectedID = computed(() => String(route.query.skill || "").trim());
    const selected = computed(() => skills.value.find((skill) => skill.id.toLowerCase() === selectedID.value.toLowerCase()) || null);
    const locked = computed(() => saving.value || catalog.value.readOnly);
    const documentSource = computed(() => stripFrontmatter(detail.value?.content));
    const skillsRoot = computed(() => catalog.value.roots[0] || "~/.morph/skills");
    const addLinkValid = computed(() => Boolean(normalizeInstallLink(addLink.value)));
    // Long file lists (assets, screenshots) collapse to the first few.
    const visibleFiles = computed(() => {
      const files = selected.value?.files || [];
      return filesExpanded.value ? files : files.slice(0, FILES_PREVIEW);
    });
    const hiddenFileCount = computed(() => Math.max(0, (selected.value?.files || []).length - FILES_PREVIEW));

    function refreshMobileMode() {
      isMobile.value = typeof window !== "undefined" && window.innerWidth <= 920;
    }

    function setSkillQuery(id) {
      const next = { ...route.query };
      if (id) {
        next.skill = id;
      } else {
        delete next.skill;
      }
      void router.replace({ query: next });
    }

    function openSkill(skill) {
      if (skill) {
        setSkillQuery(skill.id);
      }
    }

    function closeSkill() {
      setSkillQuery("");
    }

    function isOn(skill) {
      return Boolean(skill?.loaded && catalog.value.enabled);
    }

    // Only skills added from a link have a source worth showing.
    function sourceText(skill) {
      const source = skill?.source || {};
      if (source.kind === "local") {
        return "";
      }
      const where = source.repo || source.url;
      const at = source.commit ? ` @ ${source.commit.slice(0, 7)}` : "";
      const when = source.installedAt ? ` · ${source.installedAt.slice(0, 10)}` : "";
      return `${where}${at}${when}`;
    }

    async function load() {
      const seq = ++listSeq;
      const endpointRef = endpointState.selectedRef;
      loading.value = true;
      try {
        const data = await endpointApiFetch(endpointRef, "/settings/agent/skills");
        if (seq !== listSeq) {
          return;
        }
        unsupported.value = false;
        err.value = "";
        catalog.value = {
          enabled: data?.enabled !== false,
          load: Array.isArray(data?.load) ? data.load : [],
          roots: Array.isArray(data?.roots) ? data.roots : [],
          readOnly: data?.read_only === true,
          readOnlyReason: String(data?.read_only_reason || ""),
          revision: String(data?.config_revision || ""),
          skills: (Array.isArray(data?.skills) ? data.skills : []).map(normalizeSkill).filter((skill) => skill.id),
        };
      } catch (e) {
        if (seq !== listSeq) {
          return;
        }
        if (e?.status === 404) {
          unsupported.value = true;
          catalog.value = { ...catalog.value, skills: [] };
        } else {
          err.value = e.message || t("msg_load_failed");
        }
      } finally {
        if (seq === listSeq) {
          loading.value = false;
        }
      }
    }

    async function loadDetail(id) {
      const seq = ++detailSeq;
      if (!id) {
        detail.value = null;
        return;
      }
      detailLoading.value = true;
      try {
        const data = await endpointApiFetch(endpointState.selectedRef, `/settings/agent/skills/detail?id=${encodeURIComponent(id)}`);
        if (seq === detailSeq) {
          detail.value = { content: String(data?.content || ""), truncated: data?.content_truncated === true };
        }
      } catch (e) {
        if (seq === detailSeq) {
          detail.value = null;
          err.value = e.message || t("msg_load_failed");
        }
      } finally {
        if (seq === detailSeq) {
          detailLoading.value = false;
        }
      }
    }

    // Switches save straight away through the agent settings update, then re-read the list so
    // the switches show the agent's own view.
    async function saveSkills(next) {
      if (locked.value) {
        return;
      }
      saving.value = true;
      err.value = "";
      try {
        await endpointApiFetch(endpointState.selectedRef, "/settings/agent", {
          method: "PUT",
          body: { config_revision: catalog.value.revision, skills: { enabled: next.enabled, load: next.load } },
        });
        await load();
      } catch (e) {
        err.value = e.message || t("msg_save_failed");
        await load();
      } finally {
        saving.value = false;
      }
    }

    function setEnabled(value) {
      void saveSkills({ enabled: Boolean(value), load: catalog.value.load });
    }

    function setLoaded(skill, value) {
      void saveSkills(skillToggleSettings({ enabled: catalog.value.enabled, load: catalog.value.load }, skills.value, skill, Boolean(value)));
    }

    function askRemove(skill) {
      removeErr.value = "";
      removeTarget.value = skill;
    }

    // Removing deletes the skill's folder on the agent; the load list drops its id.
    async function confirmRemove() {
      const skill = removeTarget.value;
      if (!skill || removeBusy.value) {
        return;
      }
      removeBusy.value = true;
      removeErr.value = "";
      try {
        await endpointApiFetch(endpointState.selectedRef, "/settings/agent/skills/remove", { method: "POST", body: { id: skill.id } });
        removeTarget.value = null;
        closeSkill();
        await load();
      } catch (e) {
        removeErr.value = e?.status === 404 ? t("skills_remove_unsupported") : e.message || t("skills_remove_failed");
      } finally {
        removeBusy.value = false;
      }
    }

    function openAdd() {
      addLink.value = "";
      addErr.value = "";
      addOpen.value = true;
    }

    // Adding is a task in a new topic: the agent previews the skill, explains it there, and
    // skill_install waits for the user's approval in that conversation.
    async function submitAdd() {
      if (!addLinkValid.value) {
        addErr.value = t("skills_install_link_invalid");
        return;
      }
      const task = skillInstallTask(t, { link: addLink.value });
      if (!task || addBusy.value) {
        return;
      }
      const endpointRef = endpointState.selectedRef;
      addBusy.value = true;
      addErr.value = "";
      try {
        const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: { task } });
        const topicID = String(submitted?.topic_id || "").trim();
        addOpen.value = false;
        await router.push(endpointRoutePath(endpointRef, topicID ? `/chat/${encodeURIComponent(topicID)}` : "/chat"));
      } catch (e) {
        addErr.value = e.message || t("skills_install_failed");
      } finally {
        addBusy.value = false;
      }
    }

    function onKeydown(event) {
      if (event.key !== "Escape") {
        return;
      }
      if (removeTarget.value && !removeBusy.value) {
        removeTarget.value = null;
      } else if (selected.value && !addOpen.value) {
        closeSkill();
      }
    }

    watch(
      () => selected.value?.id || "",
      (id) => {
        filesExpanded.value = false;
        docOpen.value = false;
        removeTarget.value = null;
        void loadDetail(id);
      },
    );
    watch(
      () => endpointState.selectedRef,
      () => {
        detail.value = null;
        closeSkill();
        void load();
      },
    );
    onMounted(() => {
      refreshMobileMode();
      window.addEventListener("resize", refreshMobileMode);
      window.addEventListener("keydown", onKeydown);
      void load();
      if (selected.value) {
        void loadDetail(selected.value.id);
      }
    });
    onUnmounted(() => {
      window.removeEventListener("resize", refreshMobileMode);
      window.removeEventListener("keydown", onKeydown);
    });

    return {
      t,
      loading,
      err,
      unsupported,
      catalog,
      skills,
      showSearch,
      visibleSkills,
      query,
      selected,
      locked,
      isMobile,
      detail,
      detailLoading,
      docOpen,
      documentSource,
      skillsRoot,
      visibleFiles,
      hiddenFileCount,
      filesExpanded,
      removeTarget,
      removeBusy,
      removeErr,
      addOpen,
      addLink,
      addBusy,
      addErr,
      addLinkValid,
      formatBytes,
      openSkill,
      closeSkill,
      isOn,
      sourceText,
      setEnabled,
      setLoaded,
      askRemove,
      confirmRemove,
      openAdd,
      submitAdd,
    };
  },
  template: `
    <AppPage :title="t('skills_title')" class="skills-page">
      <template #actions>
        <label class="skills-master" :title="t('skills_enabled_note')">
          <span class="skills-master-label">{{ t('skills_enabled') }}</span>
          <QSwitch class="skills-switch" :modelValue="catalog.enabled" :disabled="locked || unsupported" :aria-label="t('skills_enabled')" @update:modelValue="setEnabled" />
        </label>
        <QButton v-if="!isMobile" class="primary xs skills-add-button" :disabled="unsupported" @click="openAdd">
          <PhPlus class="icon" />
          <span>{{ t('skills_add') }}</span>
        </QButton>
      </template>

      <div class="skills-shell">
        <p v-if="catalog.readOnly && catalog.readOnlyReason" class="skills-notice">{{ catalog.readOnlyReason }}</p>
        <p v-if="err" class="skills-notice is-error">{{ err }}</p>

        <label v-if="showSearch" class="skills-search">
          <PhMagnifyingGlass class="icon" aria-hidden="true" />
          <input v-model="query" type="search" :placeholder="t('skills_search')" :aria-label="t('skills_search')" />
        </label>

        <AppSkeleton v-if="loading && !skills.length && !unsupported" :rows="4" :label="t('runtime_loading')" />
        <p v-else-if="unsupported" class="skills-empty-note">{{ t('skills_unsupported') }}</p>
        <div v-else-if="!skills.length" class="skills-empty">
          <strong class="skills-empty-title">{{ t('skills_empty_title') }}</strong>
          <p class="skills-empty-note">{{ t('skills_empty_add_note', { path: skillsRoot }) }}</p>
        </div>
        <p v-else-if="!visibleSkills.length" class="skills-empty-note">{{ t('skills_no_match') }}</p>
        <ul v-else class="skills-list" :class="{ 'is-all-off': !catalog.enabled }">
          <li
            v-for="skill in visibleSkills"
            :key="skill.id"
            class="skills-row"
            :class="{ 'is-on': isOn(skill), 'is-active': selected && selected.id === skill.id }"
          >
            <button type="button" class="skills-row-open" :aria-label="t('skills_open', { name: skill.name })" @click="openSkill(skill)"></button>
            <div class="skills-row-main">
              <strong class="skills-row-name">{{ skill.name }}</strong>
              <p v-if="skill.description" class="skills-row-desc">{{ skill.description }}</p>
            </div>
            <QSwitch
              class="skills-switch skills-row-switch"
              :modelValue="isOn(skill)"
              :disabled="locked"
              :aria-label="t('skills_load_toggle', { name: skill.name })"
              @update:modelValue="setLoaded(skill, $event)"
            />
          </li>
        </ul>
      </div>

      <AppFab v-if="isMobile && !selected" icon="PhPlus" :label="t('skills_add')" :disabled="unsupported" @click="openAdd" />

      <Teleport to="body">
        <Transition name="skills-sheet">
          <div v-if="selected" class="skills-sheet-layer" @click.self="closeSkill">
            <aside class="skills-sheet" role="dialog" :aria-label="selected.name">
              <header class="skills-sheet-head">
                <div class="skills-sheet-titleline">
                  <h2 class="skills-sheet-title">{{ selected.name }}</h2>
                  <QSwitch
                    class="skills-switch"
                    :modelValue="isOn(selected)"
                    :disabled="locked"
                    :aria-label="t('skills_load_toggle', { name: selected.name })"
                    @update:modelValue="setLoaded(selected, $event)"
                  />
                  <QButton class="plain xs icon skills-sheet-close" :title="t('action_close')" :aria-label="t('action_close')" @click="closeSkill">
                    <PhX class="icon" />
                  </QButton>
                </div>
                <p v-if="selected.description" class="skills-sheet-desc">{{ selected.description }}</p>
              </header>

              <div class="skills-sheet-body">
                <p v-if="selected.modified.length" class="skills-callout">
                  <PhWarning class="icon" aria-hidden="true" />
                  <span>{{ t('skills_modified_since', { files: selected.modified.join(', ') }) }}</span>
                </p>

                <dl class="skills-facts">
                  <div v-if="sourceText(selected)" class="skills-fact">
                    <dt>{{ t('skills_fact_source') }}</dt>
                    <dd>
                      <a v-if="selected.source.url" :href="selected.source.url" target="_blank" rel="noopener noreferrer" class="skills-fact-link">{{ sourceText(selected) }}</a>
                      <span v-else>{{ sourceText(selected) }}</span>
                    </dd>
                  </div>
                  <div class="skills-fact">
                    <dt>{{ t('skills_fact_location') }}</dt>
                    <dd><code>{{ selected.dir }}</code></dd>
                  </div>
                  <div v-if="selected.requirements.length" class="skills-fact">
                    <dt>{{ t('skills_fact_requires') }}</dt>
                    <dd>{{ selected.requirements.join(', ') }}</dd>
                  </div>
                  <div v-if="selected.authProfiles.length" class="skills-fact">
                    <dt>{{ t('skills_fact_auth') }}</dt>
                    <dd>{{ selected.authProfiles.join(', ') }}</dd>
                  </div>
                  <div class="skills-fact">
                    <dt>{{ t('skills_fact_files') }}</dt>
                    <dd>
                      <ul class="skills-files">
                        <li v-for="file in visibleFiles" :key="file.path">
                          <code>{{ file.path }}</code>
                          <span class="skills-file-size">{{ formatBytes(file.size) }}</span>
                        </li>
                      </ul>
                      <button v-if="hiddenFileCount > 0" type="button" class="skills-text-button" @click="filesExpanded = !filesExpanded">
                        {{ filesExpanded ? t('skills_files_less') : t('skills_files_more', { count: selected.files.length }) }}
                      </button>
                      <p v-if="selected.filesCapped" class="skills-fact-note">{{ t('skills_files_capped', { count: selected.files.length }) }}</p>
                    </dd>
                  </div>
                </dl>

                <section class="skills-doc-block">
                  <button type="button" class="skills-doc-toggle" :aria-expanded="docOpen ? 'true' : 'false'" @click="docOpen = !docOpen">
                    <PhCaretRight class="icon skills-doc-caret" :class="{ 'is-open': docOpen }" aria-hidden="true" />
                    <span>SKILL.md</span>
                  </button>
                  <div v-if="docOpen" class="skills-doc">
                    <p v-if="detail && detail.truncated" class="skills-notice">{{ t('skills_content_truncated') }}</p>
                    <AppSkeleton v-if="detailLoading && !detail" :rows="6" :label="t('runtime_loading')" />
                    <MarkdownContent v-else-if="documentSource" :source="documentSource" />
                  </div>
                </section>
              </div>

              <footer class="skills-sheet-foot" :class="{ 'is-confirming': removeTarget }">
                <template v-if="removeTarget">
                  <div class="skills-remove-confirm" role="alertdialog" :aria-label="t('skills_remove_title', { name: removeTarget.name })">
                    <strong class="skills-remove-title">{{ t('skills_remove_title', { name: removeTarget.name }) }}</strong>
                    <p class="skills-remove-text">{{ removeTarget.source.kind === 'local' ? t('skills_remove_body_local') : t('skills_remove_body') }}</p>
                    <p v-if="removeErr" class="skills-notice is-error">{{ removeErr }}</p>
                  </div>
                  <div class="skills-remove-actions">
                    <QButton class="plain xs" :disabled="removeBusy" @click="removeTarget = null">{{ t('action_cancel') }}</QButton>
                    <QButton class="danger xs" :loading="removeBusy" @click="confirmRemove">{{ t('skills_remove') }}</QButton>
                  </div>
                </template>
                <QButton v-else class="danger outlined xs skills-remove-button" :disabled="catalog.readOnly" @click="askRemove(selected)">
                  <PhTrash class="icon" />
                  <span>{{ t('skills_remove') }}</span>
                </QButton>
              </footer>
            </aside>
          </div>
        </Transition>
      </Teleport>

      <Teleport to="body">
        <AppDialogShell
          :modelValue="addOpen"
          :title="t('skills_add_title')"
          width="520px"
          :closeDisabled="addBusy"
          @update:modelValue="addOpen = $event"
          @close="addOpen = false"
        >
          <form class="skills-dialog-body" @submit.prevent="submitAdd">
            <QInput v-model="addLink" :placeholder="t('skills_install_link_placeholder')" :aria-label="t('skills_add_title')" :disabled="addBusy" />
            <p class="skills-dialog-note">{{ t('skills_add_note') }}</p>
            <p v-if="addErr" class="skills-notice is-error">{{ addErr }}</p>
            <div class="skills-dialog-actions">
              <QButton type="button" class="plain" :disabled="addBusy" @click="addOpen = false">{{ t('action_cancel') }}</QButton>
              <QButton type="submit" class="primary" :loading="addBusy" :disabled="!addLinkValid">{{ t('skills_add_start') }}</QButton>
            </div>
          </form>
        </AppDialogShell>
      </Teleport>
    </AppPage>
  `,
};

export default SkillsView;
