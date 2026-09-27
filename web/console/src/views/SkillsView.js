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

// The skill's side panel content, used by the desktop column and the phone sheet.
const SkillPanel = {
  props: {
    skill: { type: Object, required: true },
    on: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
    removeBusy: { type: Boolean, default: false },
  },
  emits: ["close", "toggle", "open-doc", "remove"],
  setup(props) {
    const filesExpanded = ref(false);
    watch(
      () => props.skill.id,
      () => {
        filesExpanded.value = false;
      },
    );
    const visibleFiles = computed(() => (filesExpanded.value ? props.skill.files : props.skill.files.slice(0, FILES_PREVIEW)));
    const hiddenFileCount = computed(() => Math.max(0, props.skill.files.length - FILES_PREVIEW));
    return { t: translate, filesExpanded, visibleFiles, hiddenFileCount, formatBytes, sourceText: skillSourceText };
  },
  template: `
    <div class="ui-side-panel-pane skills-panel-pane">
      <header class="ui-side-panel-toolbar">
        <div class="ui-side-panel-copy">
          <h3 class="skills-panel-title">{{ skill.name }}</h3>
        </div>
        <div class="ui-side-panel-toolbar-actions">
          <QButton class="plain xs icon" :title="t('action_close')" :aria-label="t('action_close')" @click="$emit('close')">
            <PhX class="icon" />
          </QButton>
        </div>
      </header>
      <div class="skills-panel-body">
        <p v-if="skill.description" class="skills-panel-desc">{{ skill.description }}</p>
        <div class="ui-toggle-row skills-panel-toggle">
          <span class="ui-toggle-title">{{ t('skills_panel_load') }}</span>
          <QSwitch
            :modelValue="on"
            :disabled="locked"
            :aria-label="t('skills_load_toggle', { name: skill.name })"
            @update:modelValue="$emit('toggle', $event)"
          />
        </div>
        <p v-if="skill.modified.length" class="ui-toggle-note skills-panel-warning">
          <PhWarning class="icon" aria-hidden="true" />
          <span>{{ t('skills_modified_since', { files: skill.modified.join(', ') }) }}</span>
        </p>
        <dl class="ui-property-list">
          <div v-if="sourceText(skill)" class="ui-property-row">
            <dt class="ui-property-label">{{ t('skills_fact_source') }}</dt>
            <dd class="ui-property-value">
              <a v-if="skill.source.url" :href="skill.source.url" target="_blank" rel="noopener noreferrer" class="skills-link">{{ sourceText(skill) }}</a>
              <span v-else>{{ sourceText(skill) }}</span>
            </dd>
          </div>
          <div class="ui-property-row">
            <dt class="ui-property-label">{{ t('skills_fact_location') }}</dt>
            <dd class="ui-property-value is-code"><code :title="skill.dir">{{ skill.dir }}</code></dd>
          </div>
          <div v-if="skill.requirements.length" class="ui-property-row">
            <dt class="ui-property-label">{{ t('skills_fact_requires') }}</dt>
            <dd class="ui-property-value">{{ skill.requirements.join(', ') }}</dd>
          </div>
          <div v-if="skill.authProfiles.length" class="ui-property-row">
            <dt class="ui-property-label">{{ t('skills_fact_auth') }}</dt>
            <dd class="ui-property-value">{{ skill.authProfiles.join(', ') }}</dd>
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
                {{ filesExpanded ? t('skills_files_less') : t('skills_files_more', { count: skill.files.length }) }}
              </button>
            </dd>
          </div>
        </dl>
        <QButton class="plain sm ui-side-panel-danger-action" @click="$emit('open-doc')">
          <PhCode class="icon" />
          <span>{{ t('skills_view_doc') }}</span>
        </QButton>
      </div>
      <footer class="ui-side-panel-danger-zone">
        <QButton class="danger plain sm ui-side-panel-danger-action" :loading="removeBusy" :disabled="readOnly" @click="$emit('remove')">
          <PhTrash class="icon" />
          <span>{{ t('skills_remove') }}</span>
        </QButton>
      </footer>
    </div>
  `,
};

// The agent's skills: a list with a switch per skill, a side sheet per skill, and Add skill,
// which starts a chat task where the agent reviews the skill and the user approves the install.
const SkillsView = {
  components: {
    SkillPanel,
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
    // SKILL.md opens in a dialog; the side panel is too narrow to read it.
    const docOpen = ref(false);
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
      } else if (selected.value && !addOpen.value && !docOpen.value) {
        closeSkill();
      }
    }

    watch(
      () => selected.value?.id || "",
      (id) => {
        docOpen.value = false;
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
      docOpen,
      documentSource,
      skillsRoot,
      removeTarget,
      removeBusy,
      removeErr,
      removeDialogOpen,
      removeDialogActions,
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
    <AppPage :title="t('skills_title')" class="skills-page">
      <template #actions>
        <QButton
          v-if="!isMobile"
          class="plain sm icon"
          :title="t('skills_add')"
          :aria-label="t('skills_add')"
          :disabled="unsupported"
          @click="openAdd"
        >
          <PhPlus class="icon" />
        </QButton>
        <div ref="menuRoot" class="skills-menu">
          <QButton
            class="plain sm icon"
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
      </template>

      <div class="skills-layout" :class="{ 'has-panel': selected && !isMobile }">
        <section class="skills-main">
          <QFence v-if="catalog.readOnly && catalog.readOnlyReason" type="warning" :text="catalog.readOnlyReason" />
          <QFence v-if="err" type="danger" icon="PhXCircle" :text="err" />

          <label v-if="showSearch" class="skills-search">
            <PhMagnifyingGlass class="icon" aria-hidden="true" />
            <input v-model="query" type="search" :placeholder="t('skills_search')" :aria-label="t('skills_search')" />
          </label>

          <QCard variant="default" class="skills-card">
            <AppSkeleton v-if="loading && !skills.length && !unsupported" :rows="4" :label="t('runtime_loading')" />
            <p v-else-if="unsupported" class="ui-toggle-note">{{ t('skills_unsupported') }}</p>
            <div v-else-if="!skills.length" class="skills-empty">
              <strong class="ui-toggle-title">{{ t('skills_empty_title') }}</strong>
              <p class="ui-toggle-note">{{ t('skills_empty_add_note', { path: skillsRoot }) }}</p>
            </div>
            <p v-else-if="!visibleSkills.length" class="ui-toggle-note">{{ t('skills_no_match') }}</p>
            <div v-else class="ui-toggle-list skills-list" :class="{ 'is-all-off': !catalog.enabled }">
              <div
                v-for="skill in visibleSkills"
                :key="skill.id"
                class="ui-toggle-row skills-row"
                :class="{ 'is-on': isOn(skill), 'is-active': selected && selected.id === skill.id }"
              >
                <button type="button" class="skills-row-open" :aria-label="t('skills_open', { name: skill.name })" @click="openSkill(skill)"></button>
                <div class="ui-toggle-copy">
                  <strong class="ui-toggle-title">{{ skill.name }}</strong>
                  <span v-if="skill.description" class="ui-toggle-note skills-row-note">{{ skill.description }}</span>
                </div>
                <QSwitch
                  class="skills-row-switch"
                  :modelValue="isOn(skill)"
                  :disabled="locked"
                  :aria-label="t('skills_load_toggle', { name: skill.name })"
                  @update:modelValue="setLoaded(skill, $event)"
                />
              </div>
            </div>
          </QCard>
        </section>

        <Transition name="ui-side-panel">
          <aside v-if="selected && !isMobile" class="ui-side-panel workspace-sidebar-section skills-panel" :aria-label="selected.name">
            <div class="ui-side-panel-shell skills-panel-shell">
              <SkillPanel
                :skill="selected"
                :on="isOn(selected)"
                :locked="locked"
                :readOnly="catalog.readOnly"
                :removeBusy="removeBusy"
                @close="closeSkill"
                @toggle="setLoaded(selected, $event)"
                @open-doc="docOpen = true"
                @remove="askRemove(selected)"
              />
            </div>
          </aside>
        </Transition>
      </div>

      <AppFab v-if="isMobile && !selected" icon="PhPlus" :label="t('skills_add')" :disabled="unsupported" @click="openAdd" />

      <Teleport to="body">
        <Transition name="ui-side-panel-mobile">
          <div v-if="selected && isMobile" class="ui-side-panel-mobile-layer">
            <div class="ui-side-panel-mobile-mask" aria-hidden="true" @click="closeSkill"></div>
            <aside class="ui-side-panel-mobile-panel" :aria-label="selected.name" tabindex="-1">
              <div class="ui-side-panel-shell-mobile skills-panel-shell">
                <SkillPanel
                  :skill="selected"
                  :on="isOn(selected)"
                  :locked="locked"
                  :readOnly="catalog.readOnly"
                  :removeBusy="removeBusy"
                  @close="closeSkill"
                  @toggle="setLoaded(selected, $event)"
                  @open-doc="docOpen = true"
                  @remove="askRemove(selected)"
                />
              </div>
            </aside>
          </div>
        </Transition>
      </Teleport>

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
            :modelValue="docOpen && Boolean(selected)"
            :title="selected ? selected.name + ' · SKILL.md' : ''"
            width="760px"
            @update:modelValue="docOpen = $event"
            @close="docOpen = false"
          >
            <div class="skills-doc">
              <QFence v-if="detail && detail.truncated" type="warning" :text="t('skills_content_truncated')" />
              <AppSkeleton v-if="detailLoading && !detail" :rows="6" :label="t('runtime_loading')" />
              <MarkdownContent v-else-if="documentSource" :source="documentSource" />
            </div>
          </AppDialogShell>
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
              <p class="ui-toggle-note">{{ t('skills_add_note') }}</p>
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
