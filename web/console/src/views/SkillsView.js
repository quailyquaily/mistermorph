import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./SkillsView.css";

import AppPage from "../components/AppPage";
import AppSkeleton from "../components/AppSkeleton";
import MarkdownContent from "../components/MarkdownContent";
import { endpointApiFetch, endpointState, formatBytes, translate } from "../core/context";
import { skillToggleSettings } from "../core/skills-load.js";

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
  };
}

// The agent's skills: an index with a switch per skill, and each skill's SKILL.md.
const SkillsView = {
  components: {
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
    const isMobile = ref(false);
    const filesExpanded = ref(false);
    const FILES_PREVIEW = 8;
    let listSeq = 0;
    let detailSeq = 0;

    const skills = computed(() => catalog.value.skills);
    const selectedID = computed(() => String(route.query.skill || "").trim());
    const selected = computed(() => skills.value.find((skill) => skill.id.toLowerCase() === selectedID.value.toLowerCase()) || null);
    const loadedCount = computed(() => skills.value.filter((skill) => skill.loaded).length);
    const showIndex = computed(() => !isMobile.value || !selected.value);
    const showDetail = computed(() => !isMobile.value || Boolean(selected.value));
    const locked = computed(() => saving.value || catalog.value.readOnly);
    const documentSource = computed(() => stripFrontmatter(detail.value?.content));
    const skillsRoot = computed(() => catalog.value.roots[0] || "~/.morph/skills");
    // Long file lists (assets, screenshots) collapse to the first few.
    const visibleFiles = computed(() => {
      const files = selected.value?.files || [];
      return filesExpanded.value ? files : files.slice(0, FILES_PREVIEW);
    });
    const hiddenFileCount = computed(() => Math.max(0, (selected.value?.files || []).length - FILES_PREVIEW));

    function refreshMobileMode() {
      isMobile.value = typeof window !== "undefined" && window.innerWidth <= 920;
    }

    function select(skill) {
      if (!skill) {
        return;
      }
      void router.replace({ query: { ...route.query, skill: skill.id } });
    }

    function backToIndex() {
      const query = { ...route.query };
      delete query.skill;
      void router.replace({ query });
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
        // Desktop always shows a skill; the first one if none is chosen or it went away.
        if (!isMobile.value && catalog.value.skills.length && !selected.value) {
          select(catalog.value.skills[0]);
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
        backToIndex();
        void load();
      },
    );
    onMounted(() => {
      refreshMobileMode();
      window.addEventListener("resize", refreshMobileMode);
      void load();
      if (selected.value) {
        void loadDetail(selected.value.id);
      }
    });
    onUnmounted(() => window.removeEventListener("resize", refreshMobileMode));

    return {
      t,
      loading,
      saving,
      err,
      unsupported,
      catalog,
      skills,
      selected,
      loadedCount,
      showIndex,
      showDetail,
      locked,
      isMobile,
      detail,
      detailLoading,
      documentSource,
      skillsRoot,
      visibleFiles,
      hiddenFileCount,
      filesExpanded,
      formatBytes,
      select,
      backToIndex,
      setEnabled,
      setLoaded,
    };
  },
  template: `
    <AppPage :title="t('skills_title')" class="skills-page" :hideDesktopBar="true" :hideMobileBar="!isMobile || !selected" :overlayBar="true">
      <template #leading>
        <div class="skills-page-bar">
          <QButton class="plain xs icon" :title="t('skills_title')" :aria-label="t('action_back')" @click="backToIndex">
            <PhArrowLeft class="icon" />
          </QButton>
          <h2 class="page-title page-bar-title workspace-section-title">{{ selected ? selected.name : t('skills_title') }}</h2>
        </div>
      </template>

      <div class="skills-workbench">
        <aside v-if="showIndex" class="skills-index workspace-sidebar-section" :aria-label="t('skills_title')">
          <header class="skills-index-head workspace-sidebar-head">
            <h3 class="workspace-section-title">{{ t('skills_title') }}</h3>
            <span v-if="skills.length" class="skills-index-count">{{ t('skills_loaded_count', { loaded: loadedCount, total: skills.length }) }}</span>
          </header>

          <div class="skills-index-body">
          <div class="skills-master">
            <div class="skills-master-copy">
              <strong class="skills-master-title">{{ t('skills_enabled') }}</strong>
              <span class="skills-master-note">{{ t('skills_enabled_note') }}</span>
            </div>
            <QSwitch :modelValue="catalog.enabled" :disabled="locked || unsupported" :aria-label="t('skills_enabled')" @update:modelValue="setEnabled" />
          </div>

          <p v-if="catalog.readOnly && catalog.readOnlyReason" class="skills-notice">{{ catalog.readOnlyReason }}</p>
          <p v-if="err" class="skills-notice is-error">{{ err }}</p>

          <AppSkeleton v-if="loading && !skills.length && !unsupported" :rows="4" :label="t('runtime_loading')" />
          <div v-else-if="unsupported" class="skills-empty">
            <p class="skills-empty-note">{{ t('skills_unsupported') }}</p>
          </div>
          <div v-else-if="!skills.length" class="skills-empty">
            <strong class="skills-empty-title">{{ t('skills_empty_title') }}</strong>
            <p class="skills-empty-note">{{ t('skills_empty_note', { path: skillsRoot }) }}</p>
          </div>
          <div v-else class="skills-index-list workspace-sidebar-list" role="listbox" :aria-label="t('skills_title')">
            <button
              v-for="skill in skills"
              :key="skill.id"
              type="button"
              role="option"
              class="skills-index-item workspace-sidebar-item"
              :class="{ 'is-active': selected && selected.id === skill.id }"
              :aria-selected="selected && selected.id === skill.id ? 'true' : 'false'"
              @click="select(skill)"
            >
              <span class="skills-mark" :class="skill.loaded && catalog.enabled ? 'is-on' : 'is-off'" :title="skill.loaded && catalog.enabled ? t('skills_loaded') : t('skills_not_loaded')"></span>
              <span class="workspace-sidebar-item-copy">
                <span class="workspace-sidebar-item-title">{{ skill.name }}</span>
                <span class="workspace-sidebar-item-meta">{{ skill.description || t('skills_description_empty') }}</span>
              </span>
            </button>
          </div>
          </div>
        </aside>

        <section v-if="showDetail" class="skills-detail">
          <p v-if="!selected" class="skills-detail-hint">{{ skills.length ? t('skills_select_hint') : '' }}</p>
          <article v-else class="skills-sheet">
            <header class="skills-sheet-head">
              <div class="skills-sheet-copy">
                <h2 class="skills-sheet-title">{{ selected.name }}</h2>
                <p class="skills-sheet-desc">{{ selected.description || t('skills_description_empty') }}</p>
              </div>
              <div class="skills-sheet-toggle">
                <span class="skills-sheet-state" :class="{ 'is-on': selected.loaded && catalog.enabled }">
                  <span class="skills-mark" :class="selected.loaded && catalog.enabled ? 'is-on' : 'is-off'"></span>
                  {{ selected.loaded && catalog.enabled ? t('skills_loaded') : t('skills_not_loaded') }}
                </span>
                <QSwitch
                  :modelValue="selected.loaded && catalog.enabled"
                  :disabled="locked"
                  :aria-label="t('skills_load_toggle', { name: selected.name })"
                  @update:modelValue="setLoaded(selected, $event)"
                />
              </div>
            </header>

            <dl class="skills-facts">
              <div class="skills-fact">
                <dt>{{ t('skills_fact_id') }}</dt>
                <dd><code>{{ selected.id }}</code></dd>
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
                  <button v-if="hiddenFileCount > 0" type="button" class="skills-files-more" @click="filesExpanded = !filesExpanded">
                    {{ filesExpanded ? t('skills_files_less') : t('skills_files_more', { count: selected.files.length }) }}
                  </button>
                  <p v-if="selected.filesCapped" class="skills-fact-note">{{ t('skills_files_capped', { count: selected.files.length }) }}</p>
                </dd>
              </div>
            </dl>

            <p v-if="detail && detail.truncated" class="skills-notice">{{ t('skills_content_truncated') }}</p>
            <AppSkeleton v-if="detailLoading && !detail" :rows="6" :label="t('runtime_loading')" />
            <div v-else-if="documentSource" class="skills-doc">
              <MarkdownContent :source="documentSource" />
            </div>
          </article>
        </section>
      </div>
    </AppPage>
  `,
};

export default SkillsView;
