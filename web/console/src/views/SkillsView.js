import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./SkillsView.css";

import AppDialogShell from "../components/AppDialogShell";
import AppFab from "../components/AppFab";
import AppPage from "../components/AppPage";
import AppSkeleton from "../components/AppSkeleton";
import AppTabs from "../components/AppTabs";
import MarkdownContent from "../components/MarkdownContent";
import { endpointApiFetch, endpointState, formatBytes, runtimeApiFetchForEndpoint, translate } from "../core/context";
import { endpointRoutePath } from "../core/endpoint-routes";
import { filterSkills, normalizeInstallLink, normalizeStoreSkill, skillInstallTask, skillSourceInfo } from "../core/skills-install.js";
import { skillToggleSettings } from "../core/skills-load.js";

const STORE_REPO_URL = "https://github.com/quailyquaily/morph-skill-store";

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

function shortCommit(commit) {
  return String(commit || "").slice(0, 7);
}

// The agent's skills: installed skills as cards with a detail sheet, and the Morph Skill Store.
// Installing is a chat task, so the agent's review and the approval live in a topic.
const SkillsView = {
  components: {
    AppDialogShell,
    AppFab,
    AppPage,
    AppSkeleton,
    AppTabs,
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
    const FILES_PREVIEW = 8;
    let listSeq = 0;
    let detailSeq = 0;

    const store = ref({ loaded: false, loading: false, error: "", unsupported: false, repo: "", skills: [] });
    let storeSeq = 0;

    const removeTarget = ref(null);
    const removeBusy = ref(false);
    const removeErr = ref("");

    const installOpen = ref(false);
    const installLink = ref("");
    const installBusy = ref(false);
    const installErr = ref("");

    const tabs = computed(() => [
      { id: "installed", title: t("skills_tab_installed") },
      { id: "store", title: t("skills_tab_store") },
    ]);
    const activeTab = computed(() => (route.query.tab === "store" ? tabs.value[1] : tabs.value[0]));
    const skills = computed(() => catalog.value.skills);
    const visibleSkills = computed(() => filterSkills(skills.value, query.value));
    const storeSkills = computed(() => filterSkills(store.value.skills, query.value));
    const selectedID = computed(() => String(route.query.skill || "").trim());
    const selected = computed(() => skills.value.find((skill) => skill.id.toLowerCase() === selectedID.value.toLowerCase()) || null);
    const loadedCount = computed(() => (catalog.value.enabled ? skills.value.filter((skill) => skill.loaded).length : 0));
    const updateCount = computed(() => store.value.skills.filter((skill) => skill.updateAvailable).length);
    const locked = computed(() => saving.value || catalog.value.readOnly);
    const documentSource = computed(() => stripFrontmatter(detail.value?.content));
    const skillsRoot = computed(() => catalog.value.roots[0] || "~/.morph/skills");
    const installLinkValid = computed(() => Boolean(normalizeInstallLink(installLink.value)));
    // Long file lists (assets, screenshots) collapse to the first few.
    const visibleFiles = computed(() => {
      const files = selected.value?.files || [];
      return filesExpanded.value ? files : files.slice(0, FILES_PREVIEW);
    });
    const hiddenFileCount = computed(() => Math.max(0, (selected.value?.files || []).length - FILES_PREVIEW));

    function refreshMobileMode() {
      isMobile.value = typeof window !== "undefined" && window.innerWidth <= 920;
    }

    function setQuery(patch) {
      const next = { ...route.query, ...patch };
      for (const key of Object.keys(next)) {
        if (next[key] === undefined || next[key] === "") {
          delete next[key];
        }
      }
      void router.replace({ query: next });
    }

    function selectTab(tab) {
      setQuery({ tab: tab?.id === "store" ? "store" : undefined, skill: undefined });
    }

    function openSkill(skill) {
      if (skill) {
        setQuery({ skill: skill.id });
      }
    }

    function closeSkill() {
      setQuery({ skill: undefined });
    }

    function isOn(skill) {
      return Boolean(skill?.loaded && catalog.value.enabled);
    }

    function sourceLabel(skill) {
      const source = skill?.source || {};
      if (source.kind === "store") {
        return source.version ? t("skills_source_store_version", { version: source.version }) : t("skills_source_store");
      }
      if (source.kind === "github") {
        return source.repo || "GitHub";
      }
      if (source.kind === "url") {
        return t("skills_source_link");
      }
      return t("skills_source_local");
    }

    function storeEntryFor(skill) {
      const id = skill?.source?.storeID;
      return id ? store.value.skills.find((item) => item.id === id) || null : null;
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

    async function loadStore() {
      const seq = ++storeSeq;
      store.value = { ...store.value, loading: true, error: "" };
      try {
        const data = await endpointApiFetch(endpointState.selectedRef, "/settings/agent/skills/store");
        if (seq !== storeSeq) {
          return;
        }
        store.value = {
          loaded: true,
          loading: false,
          error: "",
          unsupported: false,
          repo: String(data?.repo || ""),
          skills: (Array.isArray(data?.skills) ? data.skills : []).map(normalizeStoreSkill).filter((skill) => skill.id),
        };
      } catch (e) {
        if (seq !== storeSeq) {
          return;
        }
        store.value = {
          ...store.value,
          loaded: true,
          loading: false,
          unsupported: e?.status === 404,
          error: e?.status === 404 ? "" : e.message || t("skills_store_unavailable"),
        };
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
    // the loaded marks are the agent's own view.
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
        void loadStore();
      } catch (e) {
        removeErr.value = e?.status === 404 ? t("skills_remove_unsupported") : e.message || t("skills_remove_failed");
      } finally {
        removeBusy.value = false;
      }
    }

    function openInstall() {
      installLink.value = "";
      installErr.value = "";
      installOpen.value = true;
    }

    // An install is a task in a new topic: the agent previews the skill, explains it there, and
    // skill_install waits for the user's approval in that conversation.
    async function startInstall(target) {
      const task = skillInstallTask(t, target);
      if (!task || installBusy.value) {
        return;
      }
      const endpointRef = endpointState.selectedRef;
      installBusy.value = true;
      installErr.value = "";
      try {
        const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: { task } });
        const topicID = String(submitted?.topic_id || "").trim();
        installOpen.value = false;
        await router.push(endpointRoutePath(endpointRef, topicID ? `/chat/${encodeURIComponent(topicID)}` : "/chat"));
      } catch (e) {
        installErr.value = e.message || t("skills_install_failed");
        if (!installOpen.value) {
          err.value = installErr.value;
        }
      } finally {
        installBusy.value = false;
      }
    }

    function submitInstallLink() {
      if (!installLinkValid.value) {
        installErr.value = t("skills_install_link_invalid");
        return;
      }
      void startInstall({ link: installLink.value });
    }

    function installFromStore(item) {
      void startInstall({ storeID: item.id, name: item.name });
    }

    function onKeydown(event) {
      if (event.key === "Escape" && removeTarget.value && !removeBusy.value) {
        removeTarget.value = null;
        return;
      }
      if (event.key === "Escape" && selected.value && !installOpen.value) {
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
      () => activeTab.value.id,
      (id) => {
        if (id === "store" && !store.value.loaded) {
          void loadStore();
        }
      },
    );
    watch(
      () => endpointState.selectedRef,
      () => {
        detail.value = null;
        store.value = { loaded: false, loading: false, error: "", unsupported: false, repo: "", skills: [] };
        closeSkill();
        void load();
        void loadStore();
      },
    );
    onMounted(() => {
      refreshMobileMode();
      window.addEventListener("resize", refreshMobileMode);
      window.addEventListener("keydown", onKeydown);
      void load();
      // The store also marks installed skills that have an update, so it loads in the background.
      void loadStore();
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
      STORE_REPO_URL,
      loading,
      saving,
      err,
      unsupported,
      catalog,
      skills,
      visibleSkills,
      storeSkills,
      store,
      tabs,
      activeTab,
      query,
      selected,
      loadedCount,
      updateCount,
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
      askRemove,
      confirmRemove,
      installOpen,
      installLink,
      installBusy,
      installErr,
      installLinkValid,
      formatBytes,
      shortCommit,
      selectTab,
      openSkill,
      closeSkill,
      isOn,
      sourceLabel,
      storeEntryFor,
      loadStore,
      setEnabled,
      setLoaded,
      openInstall,
      submitInstallLink,
      installFromStore,
    };
  },
  template: `
    <AppPage :title="t('skills_title')" class="skills-page">
      <template #leading>
        <div class="skills-bar-leading">
          <h2 class="page-title page-bar-title workspace-section-title skills-bar-title">{{ t('skills_title') }}</h2>
          <AppTabs v-if="!isMobile" class="skills-tabs" :tabs="tabs" :modelValue="activeTab" :ariaLabel="t('skills_title')" @update:modelValue="selectTab" />
        </div>
      </template>
      <template #actions>
        <label v-if="!isMobile" class="skills-search">
          <PhMagnifyingGlass class="icon" aria-hidden="true" />
          <input v-model="query" type="search" :placeholder="t('skills_search')" :aria-label="t('skills_search')" />
        </label>
        <label class="skills-master" :title="t('skills_enabled_note')">
          <span class="skills-master-label">{{ t('skills_enabled') }}</span>
          <QSwitch class="skills-switch" :modelValue="catalog.enabled" :disabled="locked || unsupported" :aria-label="t('skills_enabled')" @update:modelValue="setEnabled" />
        </label>
        <QButton v-if="!isMobile" class="primary xs skills-install-button" :disabled="unsupported" @click="openInstall">
          <PhPlus class="icon" />
          <span>{{ t('skills_install') }}</span>
        </QButton>
      </template>

      <div class="skills-shell">
        <div v-if="isMobile" class="skills-toolbar">
          <AppTabs class="skills-tabs" :tabs="tabs" :modelValue="activeTab" :ariaLabel="t('skills_title')" @update:modelValue="selectTab" />
          <label class="skills-search">
            <PhMagnifyingGlass class="icon" aria-hidden="true" />
            <input v-model="query" type="search" :placeholder="t('skills_search')" :aria-label="t('skills_search')" />
          </label>
        </div>

        <p v-if="catalog.readOnly && catalog.readOnlyReason" class="skills-notice">{{ catalog.readOnlyReason }}</p>
        <p v-if="err" class="skills-notice is-error">{{ err }}</p>

        <section v-if="activeTab.id === 'installed'" class="skills-panel" :aria-label="t('skills_tab_installed')">
          <header class="skills-panel-head">
            <div class="skills-panel-heading">
              <h3 class="skills-panel-title">{{ t('skills_tab_installed') }}</h3>
              <code class="skills-panel-sub">{{ skillsRoot }}</code>
            </div>
            <span v-if="skills.length" class="skills-panel-count" :class="{ 'is-off': !catalog.enabled }">
              {{ catalog.enabled ? t('skills_loaded_count', { loaded: loadedCount, total: skills.length }) : t('skills_all_off') }}
            </span>
          </header>

          <AppSkeleton v-if="loading && !skills.length && !unsupported" :rows="4" :label="t('runtime_loading')" />
          <p v-else-if="unsupported" class="skills-empty-note">{{ t('skills_unsupported') }}</p>
          <div v-else-if="!skills.length" class="skills-empty">
            <strong class="skills-empty-title">{{ t('skills_empty_title') }}</strong>
            <p class="skills-empty-note">{{ t('skills_empty_install_note', { path: skillsRoot }) }}</p>
            <div class="skills-empty-actions">
              <QButton class="outlined xs" @click="openInstall">{{ t('skills_install_from_link') }}</QButton>
              <QButton class="plain xs" @click="selectTab(tabs[1])">{{ t('skills_browse_store') }}</QButton>
            </div>
          </div>
          <p v-else-if="!visibleSkills.length" class="skills-empty-note">{{ t('skills_no_match') }}</p>
          <ul v-else class="skills-rows">
            <li
              v-for="skill in visibleSkills"
              :key="skill.id"
              class="skills-row"
              :class="{ 'is-on': isOn(skill), 'is-active': selected && selected.id === skill.id }"
            >
              <button type="button" class="skills-row-open" :aria-label="t('skills_open', { name: skill.name })" @click="openSkill(skill)"></button>
              <span class="skills-mark" :class="isOn(skill) ? 'is-on' : 'is-off'" :title="isOn(skill) ? t('skills_loaded') : t('skills_not_loaded')"></span>
              <div class="skills-row-main">
                <div class="skills-row-titleline">
                  <strong class="skills-row-name">{{ skill.name }}</strong>
                  <span class="skills-tag" :class="'is-' + skill.source.kind">{{ sourceLabel(skill) }}</span>
                  <span v-if="storeEntryFor(skill) && storeEntryFor(skill).updateAvailable" class="skills-tag is-update">{{ t('skills_update_available') }}</span>
                  <span v-if="skill.modified.length" class="skills-tag is-warn">{{ t('skills_modified') }}</span>
                </div>
                <p class="skills-row-desc">{{ skill.description || t('skills_description_empty') }}</p>
              </div>
              <span class="skills-row-reqs" :title="skill.requirements.join(', ')">{{ skill.requirements.join(' · ') }}</span>
              <QSwitch
                class="skills-switch skills-row-switch"
                :modelValue="isOn(skill)"
                :disabled="locked"
                :aria-label="t('skills_load_toggle', { name: skill.name })"
                @update:modelValue="setLoaded(skill, $event)"
              />
              <PhCaretRight class="icon skills-row-caret" aria-hidden="true" />
            </li>
          </ul>
        </section>

        <section v-else class="skills-panel" :aria-label="t('skills_tab_store')">
          <header class="skills-panel-head">
            <div class="skills-panel-heading">
              <h3 class="skills-panel-title">{{ t('skills_store_title') }}</h3>
              <a class="skills-panel-sub skills-panel-link" :href="STORE_REPO_URL" target="_blank" rel="noopener noreferrer">
                {{ store.repo || 'quailyquaily/morph-skill-store' }}
                <PhArrowUpRight class="icon" aria-hidden="true" />
              </a>
            </div>
            <span v-if="store.skills.length" class="skills-panel-count">
              {{ updateCount ? t('skills_store_count_updates', { total: store.skills.length, updates: updateCount }) : t('skills_store_count', { total: store.skills.length }) }}
            </span>
          </header>

          <AppSkeleton v-if="store.loading && !store.skills.length" :rows="4" :label="t('runtime_loading')" />
          <p v-else-if="store.unsupported" class="skills-empty-note">{{ t('skills_store_unsupported') }}</p>
          <div v-else-if="store.error" class="skills-empty">
            <strong class="skills-empty-title">{{ t('skills_store_unavailable') }}</strong>
            <p class="skills-empty-note">{{ store.error }}</p>
            <div class="skills-empty-actions">
              <QButton class="outlined xs" @click="loadStore">{{ t('skills_retry') }}</QButton>
            </div>
          </div>
          <div v-else-if="!store.skills.length" class="skills-empty">
            <strong class="skills-empty-title">{{ t('skills_store_empty_title') }}</strong>
            <p class="skills-empty-note">{{ t('skills_store_empty_note') }}</p>
          </div>
          <p v-else-if="!storeSkills.length" class="skills-empty-note">{{ t('skills_no_match') }}</p>
          <ul v-else class="skills-rows">
            <li v-for="item in storeSkills" :key="item.id" class="skills-row is-store">
              <span class="skills-glyph" aria-hidden="true">{{ item.name.slice(0, 1).toUpperCase() }}</span>
              <div class="skills-row-main">
                <div class="skills-row-titleline">
                  <strong class="skills-row-name">{{ item.name }}</strong>
                  <span v-if="item.version" class="skills-row-version">v{{ item.version }}</span>
                  <span v-for="tag in item.tags.slice(0, 3)" :key="tag" class="skills-tag is-plain">{{ tag }}</span>
                </div>
                <p class="skills-row-desc">{{ item.description || t('skills_description_empty') }}</p>
                <p class="skills-row-meta">
                  <span v-if="item.author">{{ item.author }}</span>
                  <span v-if="item.license">{{ item.license }}</span>
                  <span v-if="item.fileCount">{{ t('skills_store_files', { count: item.fileCount, size: formatBytes(item.totalBytes) }) }}</span>
                  <span v-if="item.requirements.length">{{ item.requirements.join(' · ') }}</span>
                </p>
              </div>
              <div class="skills-row-action">
                <QButton v-if="item.updateAvailable" class="outlined xs" :loading="installBusy" @click="installFromStore(item)">
                  {{ t('skills_update_to', { version: item.version }) }}
                </QButton>
                <span v-else-if="item.installed" class="skills-installed">
                  <PhCheckCircle class="icon" aria-hidden="true" />
                  {{ t('skills_installed') }}
                </span>
                <QButton v-else class="outlined xs" :loading="installBusy" @click="installFromStore(item)">{{ t('skills_install') }}</QButton>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <AppFab v-if="isMobile && !selected" icon="PhPlus" :label="t('skills_install')" :disabled="unsupported" @click="openInstall" />

      <Teleport to="body">
        <Transition name="skills-sheet">
          <div v-if="selected" class="skills-sheet-layer" @click.self="closeSkill">
            <aside class="skills-sheet" role="dialog" :aria-label="selected.name">
              <header class="skills-sheet-head">
                <div class="skills-sheet-topline">
                  <span class="skills-sheet-kicker">{{ t('skills_sheet_kicker') }}</span>
                  <QButton class="plain xs icon skills-sheet-close" :title="t('action_close')" :aria-label="t('action_close')" @click="closeSkill">
                    <PhX class="icon" />
                  </QButton>
                </div>
                <h2 class="skills-sheet-title">{{ selected.name }}</h2>
                <p class="skills-sheet-desc">{{ selected.description || t('skills_description_empty') }}</p>
                <label class="skills-sheet-toggle">
                  <span class="skills-mark" :class="isOn(selected) ? 'is-on' : 'is-off'"></span>
                  <span class="skills-sheet-state" :class="{ 'is-on': isOn(selected) }">{{ isOn(selected) ? t('skills_loaded') : t('skills_not_loaded') }}</span>
                  <QSwitch
                    class="skills-switch"
                    :modelValue="isOn(selected)"
                    :disabled="locked"
                    :aria-label="t('skills_load_toggle', { name: selected.name })"
                    @update:modelValue="setLoaded(selected, $event)"
                  />
                </label>
              </header>

              <div class="skills-sheet-body">
                <p v-if="selected.modified.length" class="skills-callout is-warn">
                  <PhWarning class="icon" aria-hidden="true" />
                  <span>{{ t('skills_modified_note', { files: selected.modified.join(', ') }) }}</span>
                </p>
                <p v-if="storeEntryFor(selected) && storeEntryFor(selected).updateAvailable" class="skills-callout">
                  <PhArrowClockwise class="icon" aria-hidden="true" />
                  <span>{{ t('skills_update_note', { version: storeEntryFor(selected).version }) }}</span>
                  <QButton class="outlined xs" :loading="installBusy" @click="installFromStore(storeEntryFor(selected))">{{ t('skills_update') }}</QButton>
                </p>

                <dl class="skills-facts">
                  <div class="skills-fact">
                    <dt>{{ t('skills_fact_source') }}</dt>
                    <dd>
                      <a v-if="selected.source.url" :href="selected.source.url" target="_blank" rel="noopener noreferrer" class="skills-fact-link">{{ sourceLabel(selected) }}</a>
                      <span v-else>{{ sourceLabel(selected) }}</span>
                      <span v-if="selected.source.commit" class="skills-fact-sub">@ {{ shortCommit(selected.source.commit) }}</span>
                    </dd>
                  </div>
                  <div v-if="selected.source.installedAt" class="skills-fact">
                    <dt>{{ t('skills_fact_installed') }}</dt>
                    <dd>{{ selected.source.installedAt.slice(0, 10) }}</dd>
                  </div>
                  <div class="skills-fact">
                    <dt>{{ t('skills_fact_location') }}</dt>
                    <dd><code class="skills-path">{{ selected.dir }}</code></dd>
                  </div>
                  <div v-if="selected.requirements.length" class="skills-fact">
                    <dt>{{ t('skills_fact_requires') }}</dt>
                    <dd class="skills-tags"><code v-for="item in selected.requirements" :key="item">{{ item }}</code></dd>
                  </div>
                  <div v-if="selected.authProfiles.length" class="skills-fact">
                    <dt>{{ t('skills_fact_auth') }}</dt>
                    <dd class="skills-tags"><code v-for="item in selected.authProfiles" :key="item">{{ item }}</code></dd>
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
                    <p class="skills-remove-text">{{ t('skills_remove_body') }}</p>
                    <code class="skills-remove-path">{{ removeTarget.dir }}</code>
                    <p v-if="removeTarget.source.kind === 'local'" class="skills-remove-text">{{ t('skills_remove_local_note') }}</p>
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
          :modelValue="installOpen"
          :title="t('skills_install_title')"
          width="520px"
          :closeDisabled="installBusy"
          @update:modelValue="installOpen = $event"
          @close="installOpen = false"
        >
          <form class="skills-dialog-body" @submit.prevent="submitInstallLink">
            <label class="skills-dialog-label" for="skills-install-link">{{ t('skills_install_link_label') }}</label>
            <QInput id="skills-install-link" v-model="installLink" :placeholder="t('skills_install_link_placeholder')" :disabled="installBusy" />
            <p class="skills-dialog-note">{{ t('skills_install_note') }}</p>
            <p v-if="installErr" class="skills-notice is-error">{{ installErr }}</p>
            <div class="skills-dialog-actions">
              <QButton type="button" class="plain" :disabled="installBusy" @click="installOpen = false">{{ t('action_cancel') }}</QButton>
              <QButton type="submit" class="primary" :loading="installBusy" :disabled="!installLinkValid">{{ t('skills_install_start') }}</QButton>
            </div>
          </form>
        </AppDialogShell>
      </Teleport>
    </AppPage>
  `,
};

export default SkillsView;
