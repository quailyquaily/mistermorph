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

// Only skills added from a link have a source worth showing.
function skillSourceText(skill) {
  const source = skill?.source || {};
  if (source.kind === "local") {
    return "";
  }
  const where = source.repo || source.url;
  const at = source.commit ? ` @ ${source.commit.slice(0, 7)}` : "";
  const when = source.installedAt ? ` · ${source.installedAt.slice(0, 10)}` : "";
  return `${where}${at}${when}`;
}

// The agent's skills: a sidebar list, a card per skill with its switch and "⋯" menu, and Add skill,
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
    const filesExpanded = ref(false);
    const isMobile = ref(false);
    const query = ref("");
    let listSeq = 0;
    let detailSeq = 0;

    const removeTarget = ref(null);
    const removeBusy = ref(false);
    const removeErr = ref("");
    const menuOpen = ref(false);
    const menuRoot = ref(null);

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
    // Phones show the list or one skill; desktop shows both, as on TODO.
    const showIndex = computed(() => !isMobile.value || !selected.value);
    const showDetail = computed(() => Boolean(selected.value));
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
        if (!isMobile.value && catalog.value.skills.length && !selected.value) {
          openSkill(catalog.value.skills[0]);
        }
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

    function cancelRemove() {
      if (!removeBusy.value) {
        removeTarget.value = null;
      }
    }

    const removeDialogOpen = computed({
      get: () => Boolean(removeTarget.value),
      set: (open) => {
        if (!open) {
          cancelRemove();
        }
      },
    });
    // The skill's "⋯" menu, as on TODO's editor.
    const skillActionMenuItems = computed(() => [
      {
        id: "remove",
        title: t("skills_remove"),
        danger: true,
        disabled: catalog.value.readOnly || removeBusy.value,
        action: () => askRemove(selected.value),
      },
    ]);
    const removeDialogActions = computed(() => [
      { name: "cancel", label: t("action_cancel"), class: "outlined", action: cancelRemove },
      { name: "remove", label: t("skills_remove"), class: "danger", action: confirmRemove },
    ]);
    const removeDialogText = computed(() => {
      const skill = removeTarget.value;
      if (!skill) {
        return "";
      }
      const body = skill.source.kind === "local" ? t("skills_remove_body_local") : t("skills_remove_body");
      return removeErr.value ? `${body}\n\n${removeErr.value}` : body;
    });

    function closeMenuOnOutside(event) {
      if (menuOpen.value && menuRoot.value && !menuRoot.value.contains(event.target)) {
        menuOpen.value = false;
      }
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
      if (menuOpen.value) {
        menuOpen.value = false;
      } else if (removeTarget.value) {
        cancelRemove();
      } else if (isMobile.value && selected.value && !addOpen.value) {
        closeSkill();
      }
    }

    watch(
      () => selected.value?.id || "",
      (id) => {
        filesExpanded.value = false;
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
      document.addEventListener("pointerdown", closeMenuOnOutside);
      void load();
      if (selected.value) {
        void loadDetail(selected.value.id);
      }
    });
    onUnmounted(() => {
      window.removeEventListener("resize", refreshMobileMode);
      window.removeEventListener("keydown", onKeydown);
      document.removeEventListener("pointerdown", closeMenuOnOutside);
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
      filesExpanded,
      visibleFiles,
      hiddenFileCount,
      showIndex,
      showDetail,
      formatBytes,
      sourceText: skillSourceText,
      documentSource,
      skillsRoot,
      removeTarget,
      removeBusy,
      removeErr,
      removeDialogOpen,
      removeDialogActions,
      skillActionMenuItems,
      removeDialogText,
      menuOpen,
      menuRoot,
      addOpen,
      addLink,
      addBusy,
      addErr,
      addLinkValid,
      openSkill,
      closeSkill,
      isOn,
      setEnabled,
      setLoaded,
      askRemove,
      confirmRemove,
      openAdd,
      submitAdd,
    };
  },
  template: `
    <AppPage :title="t('skills_title')" class="skills-page" :hideDesktopBar="true" :hideMobileBar="showIndex" :overlayBar="true">
      <template #leading>
        <div class="skills-page-bar">
          <QButton class="plain xs icon skills-page-bar-back" :title="t('action_back')" :aria-label="t('action_back')" @click="closeSkill">
            <PhArrowLeft class="icon" />
          </QButton>
          <h2 class="page-title page-bar-title workspace-section-title">{{ t('skills_title') }}</h2>
        </div>
      </template>

      <div class="skills-workbench">
        <aside v-if="showIndex" class="skills-index workspace-sidebar-section" :aria-label="t('skills_title')">
          <header class="skills-index-head workspace-sidebar-head">
            <h3 class="workspace-section-title">{{ t('skills_title') }}</h3>
            <div class="skills-index-actions">
              <QButton
                v-if="!isMobile"
                class="plain sm icon skills-index-button"
                :title="t('skills_add')"
                :aria-label="t('skills_add')"
                :disabled="unsupported"
                @click="openAdd"
              >
                <PhPlus class="icon" />
              </QButton>
              <div ref="menuRoot" class="skills-menu">
                <QButton
                  class="plain sm icon skills-index-button"
                  :title="t('skills_more')"
                  :aria-label="t('skills_more')"
                  aria-haspopup="true"
                  :aria-expanded="menuOpen ? 'true' : 'false'"
                  @click="menuOpen = !menuOpen"
                >
                  <PhDotsThree class="icon" />
                </QButton>
                <div v-if="menuOpen" class="q-menu skills-menu-popup" role="menu">
                  <label class="q-menu-item" role="menuitemcheckbox" :aria-checked="catalog.enabled ? 'true' : 'false'">
                    <div class="q-menu-item-inner skills-menu-item">
                      <span class="skills-menu-copy">
                        <span class="q-menu-title">{{ t('skills_enabled') }}</span>
                        <span class="skills-menu-note">{{ t('skills_enabled_note') }}</span>
                      </span>
                      <QSwitch :modelValue="catalog.enabled" :disabled="locked || unsupported" :aria-label="t('skills_enabled')" @update:modelValue="setEnabled" />
                    </div>
                  </label>
                </div>
              </div>
            </div>
          </header>

          <div class="skills-index-body">
            <label v-if="showSearch" class="skills-search">
              <PhMagnifyingGlass class="icon" aria-hidden="true" />
              <input v-model="query" type="search" :placeholder="t('skills_search')" :aria-label="t('skills_search')" />
            </label>
            <div v-if="loading && !skills.length && !unsupported" class="skills-index-loading" aria-hidden="true">
              <QSkeleton variant="card" height="52px" :count="3" />
            </div>
            <p v-else-if="unsupported" class="skills-index-note">{{ t('skills_unsupported') }}</p>
            <p v-else-if="!skills.length" class="skills-index-note">{{ t('skills_empty_add_note', { path: skillsRoot }) }}</p>
            <p v-else-if="!visibleSkills.length" class="skills-index-note">{{ t('skills_no_match') }}</p>
            <div v-else class="workspace-sidebar-list" :role="isMobile ? undefined : 'listbox'" :aria-label="t('skills_title')">
              <button
                v-for="skill in visibleSkills"
                :key="skill.id"
                type="button"
                class="skills-index-item workspace-sidebar-item"
                :class="{ 'is-active': !isMobile && selected && selected.id === skill.id }"
                :role="isMobile ? undefined : 'option'"
                :aria-selected="isMobile ? undefined : Boolean(selected && selected.id === skill.id)"
                @click="openSkill(skill)"
              >
                <span class="workspace-sidebar-item-copy">
                  <span class="workspace-sidebar-item-title">{{ skill.name }}</span>
                  <span v-if="skill.description" class="skills-index-item-meta workspace-sidebar-item-meta">{{ skill.description }}</span>
                </span>
                <span class="workspace-sidebar-item-marker" :title="isOn(skill) ? t('skills_on') : t('skills_off')">
                  <QBadge dot :type="isOn(skill) ? 'success' : 'default'" size="sm" />
                </span>
              </button>
            </div>
          </div>
        </aside>

        <QCard v-if="showDetail" class="skills-detail-card" variant="default">
          <div class="skills-detail">
            <QFence v-if="catalog.readOnly && catalog.readOnlyReason" type="warning" :text="catalog.readOnlyReason" />
            <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />

            <div class="skills-detail-toolbar">
              <label class="skills-enabled-control">
                <span class="skills-enabled-label" aria-hidden="true">{{ t('skills_field_enabled') }}</span>
                <QSwitch
                  :modelValue="isOn(selected)"
                  :disabled="locked"
                  :aria-label="t('skills_load_toggle', { name: selected.name })"
                  @update:modelValue="setLoaded(selected, $event)"
                />
              </label>
              <QDropdownMenu
                class="skills-actions-menu"
                :items="skillActionMenuItems"
                hideSelected
                hideActionLabel
                :loading="removeBusy"
              >
                <PhDotsThree class="skills-actions-menu-icon" />
                <span class="skills-actions-menu-accessible">{{ t('skills_more') }}</span>
              </QDropdownMenu>
            </div>

            <header class="skills-detail-copy">
              <h3 class="workspace-document-title skills-detail-title">{{ selected.name }}</h3>
              <p v-if="selected.description" class="skills-detail-meta">{{ selected.description }}</p>
            </header>

            <p v-if="selected.modified.length" class="skills-detail-warning">
              <PhWarning class="icon" aria-hidden="true" />
              <span>{{ t('skills_modified_since', { files: selected.modified.join(', ') }) }}</span>
            </p>

            <dl class="ui-property-list skills-properties">
              <div v-if="sourceText(selected)" class="ui-property-row">
                <dt class="ui-property-label">{{ t('skills_fact_source') }}</dt>
                <dd class="ui-property-value">
                  <a v-if="selected.source.url" :href="selected.source.url" target="_blank" rel="noopener noreferrer" class="skills-link">{{ sourceText(selected) }}</a>
                  <span v-else>{{ sourceText(selected) }}</span>
                </dd>
              </div>
              <div class="ui-property-row">
                <dt class="ui-property-label">{{ t('skills_fact_location') }}</dt>
                <dd class="ui-property-value is-code"><code :title="selected.dir">{{ selected.dir }}</code></dd>
              </div>
              <div v-if="selected.requirements.length" class="ui-property-row">
                <dt class="ui-property-label">{{ t('skills_fact_requires') }}</dt>
                <dd class="ui-property-value">{{ selected.requirements.join(', ') }}</dd>
              </div>
              <div v-if="selected.authProfiles.length" class="ui-property-row">
                <dt class="ui-property-label">{{ t('skills_fact_auth') }}</dt>
                <dd class="ui-property-value">{{ selected.authProfiles.join(', ') }}</dd>
              </div>
              <div class="ui-property-row">
                <dt class="ui-property-label">{{ t('skills_fact_files') }}</dt>
                <dd class="ui-property-value">
                  <ul class="skills-files">
                    <li v-for="file in visibleFiles" :key="file.path">
                      <code>{{ file.path }}</code>
                      <span>{{ formatBytes(file.size) }}</span>
                    </li>
                  </ul>
                  <button v-if="hiddenFileCount > 0" type="button" class="skills-text-button" @click="filesExpanded = !filesExpanded">
                    {{ filesExpanded ? t('skills_files_less') : t('skills_files_more', { count: selected.files.length }) }}
                  </button>
                </dd>
              </div>
            </dl>

            <section class="skills-doc">
              <QFence v-if="detail && detail.truncated" type="warning" :text="t('skills_content_truncated')" />
              <div v-if="detailLoading && !detail" class="skills-index-loading" aria-hidden="true">
                <QSkeleton variant="card" height="120px" :count="1" />
              </div>
              <MarkdownContent v-else-if="documentSource" :source="documentSource" />
            </section>
          </div>
        </QCard>

        <div v-else-if="!isMobile && !loading" class="skills-detail-empty">
          <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />
          <p class="skills-index-note">{{ skills.length ? '' : t('skills_empty_title') }}</p>
        </div>
      </div>

      <AppFab v-if="isMobile && showIndex" icon="PhPlus" :label="t('skills_add')" :disabled="unsupported" @click="openAdd" />

      <Teleport to="body">
        <div class="ui-dialog-host">
          <QMessageDialog
            v-model="removeDialogOpen"
            icon="PhTrash"
            iconColor="red"
            :title="removeTarget ? t('skills_remove_title', { name: removeTarget.name }) : ''"
            :text="removeDialogText"
            :actions="removeDialogActions"
          />
          <AppDialogShell
            :modelValue="addOpen"
            :title="t('skills_add_title')"
            width="520px"
            :closeDisabled="addBusy"
            @update:modelValue="addOpen = $event"
            @close="addOpen = false"
          >
            <form class="skills-add-form" @submit.prevent="submitAdd">
              <QInput v-model="addLink" :placeholder="t('skills_install_link_placeholder')" :aria-label="t('skills_add_title')" :disabled="addBusy" />
              <p class="skills-index-note">{{ t('skills_add_note') }}</p>
              <QFence v-if="addErr" type="danger" icon="PhXCircle" :text="addErr" />
              <div class="skills-add-actions">
                <QButton type="button" class="outlined" :disabled="addBusy" @click="addOpen = false">{{ t('action_cancel') }}</QButton>
                <QButton type="submit" class="primary" :loading="addBusy" :disabled="!addLinkValid">{{ t('skills_add_start') }}</QButton>
              </div>
            </form>
          </AppDialogShell>
        </div>
      </Teleport>
    </AppPage>
  `,
};

export default SkillsView;
