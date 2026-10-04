import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "./SkillStoreView.css";

import AppPage from "../components/AppPage";
import MarkdownContent from "../components/MarkdownContent";
import { endpointApiFetch, endpointState, formatBytes, runtimeApiFetchForEndpoint, translate } from "../core/context";
import { endpointRoutePath } from "../core/endpoint-routes";
import {
  filterSkills,
  normalizeStoreSkill,
  skillInstallTask,
  storeSkillLinks,
  storeTags,
  stripFrontmatter,
} from "../core/skills-install.js";
import AppSkeleton from "../components/AppSkeleton";

// How many tags a card shows; the sheet shows them all.
const CARD_TAGS = 3;

// The skill's details: its name and close in a fixed header, then Install, properties and SKILL.md
// in a body that scrolls. Shown in the side panel (desktop) and the slide-in panel (phones).
const StoreSkillDetail = {
  components: { AppSkeleton, MarkdownContent },
  props: {
    skill: { type: Object, required: true },
    links: { type: Object, required: true },
    doc: { type: Object, required: true },
    documentSource: { type: String, default: "" },
    filesSummary: { type: String, default: "" },
    installBusy: { type: Boolean, default: false },
    installErr: { type: String, default: "" },
  },
  emits: ["install", "open-installed", "close"],
  setup() {
    return { t: translate };
  },
  template: `
    <header class="store-panel-head">
      <div class="store-panel-copy">
        <h3 class="workspace-document-title store-panel-title">{{ skill.name }}</h3>
        <p v-if="skill.description" class="store-panel-meta">{{ skill.description }}</p>
      </div>
      <QButton class="plain sm icon" :title="t('action_close')" :aria-label="t('action_close')" @click="$emit('close')">
        <PhX class="icon" />
      </QButton>
    </header>
    <div class="store-panel-body">
      <div class="store-panel-action">
        <QButton v-if="skill.updateAvailable" class="primary" :loading="installBusy" @click="$emit('install', true)">
          {{ t('skills_update_to', { version: skill.version }) }}
        </QButton>
        <QButton v-else-if="skill.installed" class="outlined" @click="$emit('open-installed')">{{ t('skills_store_open') }}</QButton>
        <QButton v-else class="primary" :loading="installBusy" @click="$emit('install', false)">{{ t('skills_store_install') }}</QButton>
        <p v-if="!skill.installed || skill.updateAvailable" class="store-panel-note">{{ t('skills_store_install_note') }}</p>
      </div>
      <QFence v-if="installErr" type="danger" icon="PhXCircle" :text="installErr" />

      <dl class="ui-property-list store-properties">
        <div v-if="skill.version" class="ui-property-row">
          <dt class="ui-property-label">{{ t('skills_fact_version') }}</dt>
          <dd class="ui-property-value">
            {{ skill.version }}
            <span v-if="skill.installedVersion && skill.installedVersion !== skill.version" class="store-dim">
              · {{ t('skills_store_installed_version', { version: skill.installedVersion }) }}
            </span>
          </dd>
        </div>
        <div v-if="skill.author" class="ui-property-row">
          <dt class="ui-property-label">{{ t('skills_fact_author') }}</dt>
          <dd class="ui-property-value">{{ skill.author }}</dd>
        </div>
        <div v-if="skill.license" class="ui-property-row">
          <dt class="ui-property-label">{{ t('skills_fact_license') }}</dt>
          <dd class="ui-property-value">{{ skill.license }}</dd>
        </div>
        <div v-if="skill.homepage" class="ui-property-row">
          <dt class="ui-property-label">{{ t('skills_fact_homepage') }}</dt>
          <dd class="ui-property-value">
            <a :href="skill.homepage" target="_blank" rel="noopener noreferrer" class="store-link">{{ skill.homepage }}</a>
          </dd>
        </div>
        <div v-if="skill.tags.length" class="ui-property-row">
          <dt class="ui-property-label">{{ t('skills_fact_tags') }}</dt>
          <dd class="ui-property-value">{{ skill.tags.join(', ') }}</dd>
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
          <dd class="ui-property-value">{{ filesSummary }}</dd>
        </div>
        <div v-if="links.folder" class="ui-property-row">
          <dt class="ui-property-label">{{ t('skills_fact_source') }}</dt>
          <dd class="ui-property-value">
            <a :href="links.folder" target="_blank" rel="noopener noreferrer" class="store-link">{{ skill.repo }} @ {{ skill.commit.slice(0, 7) }}</a>
          </dd>
        </div>
      </dl>

      <section class="store-doc" :aria-label="'SKILL.md'">
        <span class="store-doc-label">SKILL.md</span>
        <AppSkeleton v-if="doc.loading" variant="card" height="120px" :count="1" />
        <p v-else-if="doc.failed" class="store-note">
          {{ t('skills_store_doc_failed') }}
          <a v-if="links.folder" :href="links.folder" target="_blank" rel="noopener noreferrer" class="store-link">GitHub</a>
        </p>
        <MarkdownContent v-else-if="documentSource" class="store-doc-body" :source="documentSource" />
      </section>
    </div>
  `,
};

// The Morph Skill Store, under the Skills entry: a grid of the store's skills with search and tag
// filters. A card opens a side panel, like Chat's, with the skill's details and SKILL.md (read from
// GitHub at the commit the store pins), and Install or Update, which start the same review in chat as Add skill.
const SkillStoreView = {
  components: {
    AppSkeleton,
    AppPage,
    StoreSkillDetail,
  },
  setup() {
    const t = translate;
    const route = useRoute();
    const router = useRouter();
    const loading = ref(false);
    const error = ref("");
    const unsupported = ref(false);
    const loaded = ref(false);
    const skills = ref([]);
    const query = ref("");
    const tag = ref("");
    const doc = ref({ id: "", content: "", loading: false, failed: false });
    const installBusy = ref(false);
    const installErr = ref("");
    const isMobile = ref(false);
    let seq = 0;
    let docSeq = 0;

    const tags = computed(() => storeTags(skills.value));
    const visible = computed(() => {
      const byTag = tag.value ? skills.value.filter((skill) => skill.tags.some((item) => item.toLowerCase() === tag.value)) : skills.value;
      return filterSkills(byTag, query.value);
    });
    const selectedID = computed(() => String(route.query.skill || "").trim().toLowerCase());
    const selected = computed(() => skills.value.find((skill) => skill.id.toLowerCase() === selectedID.value) || null);
    const links = computed(() => storeSkillLinks(selected.value));
    const documentSource = computed(() => (doc.value.id === selected.value?.id ? stripFrontmatter(doc.value.content) : ""));

    function cardTags(skill) {
      return skill.tags.slice(0, CARD_TAGS);
    }

    function filesSummary(skill) {
      return t(skill.fileCount === 1 ? "skills_files_summary_one" : "skills_files_summary", {
        count: skill.fileCount,
        size: formatBytes(skill.totalBytes),
      });
    }

    function open(skill) {
      void router.replace({ query: { ...route.query, skill: skill.id } });
    }

    function close() {
      const next = { ...route.query };
      delete next.skill;
      void router.replace({ query: next });
    }

    function backToSkills() {
      void router.push(endpointRoutePath(endpointState.selectedRef, "/skills"));
    }

    function toggleTag(value) {
      tag.value = tag.value === value ? "" : value;
    }

    async function load() {
      const current = ++seq;
      loading.value = true;
      error.value = "";
      try {
        const data = await endpointApiFetch(endpointState.selectedRef, "/settings/agent/skills/store");
        if (current !== seq) {
          return;
        }
        const repo = String(data?.repo || "");
        skills.value = (Array.isArray(data?.skills) ? data.skills : []).map((item) => normalizeStoreSkill(item, repo)).filter((skill) => skill.id);
        unsupported.value = false;
      } catch (e) {
        if (current !== seq) {
          return;
        }
        skills.value = [];
        unsupported.value = e?.status === 404;
        error.value = unsupported.value ? "" : t("skills_store_unavailable");
      } finally {
        if (current === seq) {
          loading.value = false;
          loaded.value = true;
        }
      }
    }

    async function loadDoc(skill) {
      const current = ++docSeq;
      const url = storeSkillLinks(skill).document;
      if (!skill || !url) {
        doc.value = { id: skill?.id || "", content: "", loading: false, failed: Boolean(skill) };
        return;
      }
      doc.value = { id: skill.id, content: "", loading: true, failed: false };
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const content = await response.text();
        if (current === docSeq) {
          doc.value = { id: skill.id, content, loading: false, failed: false };
        }
      } catch {
        if (current === docSeq) {
          doc.value = { id: skill.id, content: "", loading: false, failed: true };
        }
      }
    }

    // Install and Update are a task in a new topic: the agent previews the store's pinned copy and
    // skill_install waits for the user's approval there.
    async function install(skill, update = false) {
      const task = skillInstallTask(t, { storeID: skill?.id, name: skill?.name, update });
      if (!task || installBusy.value) {
        return;
      }
      const endpointRef = endpointState.selectedRef;
      installBusy.value = true;
      installErr.value = "";
      try {
        const submitted = await runtimeApiFetchForEndpoint(endpointRef, "/tasks", { method: "POST", body: { task } });
        const topicID = String(submitted?.topic_id || "").trim();
        await router.push(endpointRoutePath(endpointRef, topicID ? `/chat/${encodeURIComponent(topicID)}` : "/chat"));
      } catch (e) {
        installErr.value = e.message || t("skills_install_failed");
      } finally {
        installBusy.value = false;
      }
    }

    // Installed skills open on the Skills page; a store install keeps the store id as its name.
    function openInstalled(skill) {
      void router.push({ path: endpointRoutePath(endpointState.selectedRef, "/skills"), query: { skill: skill.id } });
    }

    function refreshMobileMode() {
      isMobile.value = typeof window !== "undefined" && window.innerWidth <= 920;
    }

    function onKeydown(event) {
      if (event.key === "Escape" && selected.value) {
        close();
      }
    }

    watch(
      () => selected.value?.id || "",
      () => {
        installErr.value = "";
        void loadDoc(selected.value);
      },
    );
    watch(
      () => endpointState.selectedRef,
      () => {
        close();
        void load();
      },
    );
    onMounted(() => {
      refreshMobileMode();
      window.addEventListener("resize", refreshMobileMode);
      window.addEventListener("keydown", onKeydown);
      void load();
    });
    onUnmounted(() => {
      window.removeEventListener("resize", refreshMobileMode);
      window.removeEventListener("keydown", onKeydown);
    });

    return {
      t,
      loading,
      loaded,
      error,
      unsupported,
      skills,
      query,
      tag,
      tags,
      visible,
      selected,
      links,
      doc,
      documentSource,
      installBusy,
      installErr,
      isMobile,
      cardTags,
      filesSummary,
      open,
      close,
      backToSkills,
      toggleTag,
      load,
      install,
      openInstalled,
    };
  },
  template: `
    <AppPage :title="t('skills_store_title')" class="store-page">
      <template #leading>
        <div class="store-page-bar">
          <QButton class="plain xs icon" :title="t('skills_title')" :aria-label="t('skills_title')" @click="backToSkills">
            <PhArrowLeft class="icon" />
          </QButton>
          <h2 class="page-title page-bar-title workspace-section-title">{{ t('skills_store_title') }}</h2>
        </div>
      </template>

      <div class="store-shell" :class="{ 'has-panel': selected && !isMobile }">
      <div class="store-body">
        <div v-if="skills.length" class="store-filters">
          <label class="store-search">
            <PhMagnifyingGlass class="icon" aria-hidden="true" />
            <input v-model="query" type="search" :placeholder="t('skills_store_search')" :aria-label="t('skills_store_search')" />
          </label>
          <div v-if="tags.length" class="store-tags" role="group" :aria-label="t('skills_fact_tags')">
            <button type="button" class="store-tag" :class="{ 'is-active': !tag }" :aria-pressed="!tag ? 'true' : 'false'" @click="tag = ''">
              {{ t('skills_store_all') }}
            </button>
            <button
              v-for="item in tags"
              :key="item"
              type="button"
              class="store-tag"
              :class="{ 'is-active': tag === item }"
              :aria-pressed="tag === item ? 'true' : 'false'"
              @click="toggleTag(item)"
            >{{ item }}</button>
          </div>
        </div>

        <div v-if="loading && !skills.length" class="store-grid" aria-hidden="true">
          <AppSkeleton v-for="n in 6" :key="n" variant="card" height="148px" />
        </div>
        <p v-else-if="unsupported" class="store-note">{{ t('skills_store_unsupported') }}</p>
        <div v-else-if="error" class="store-note store-error">
          <span>{{ error }}</span>
          <QButton class="plain xs" @click="load">{{ t('skills_store_retry') }}</QButton>
        </div>
        <p v-else-if="loaded && !skills.length" class="store-note">{{ t('skills_store_empty') }}</p>
        <p v-else-if="loaded && !visible.length" class="store-note">{{ t('skills_no_match') }}</p>
        <div v-else class="store-grid">
          <button
            v-for="skill in visible"
            :key="skill.id"
            type="button"
            class="store-card"
            :class="{ 'is-active': selected && selected.id === skill.id }"
            @click="open(skill)"
          >
            <span class="store-card-head">
              <span class="store-card-name">{{ skill.name }}</span>
              <span v-if="skill.updateAvailable" class="store-card-mark is-update">{{ t('skills_update_available') }}</span>
              <span v-else-if="skill.installed" class="store-card-mark">{{ t('skills_store_installed') }}</span>
            </span>
            <span class="store-card-description">{{ skill.description }}</span>
            <span class="store-card-foot">
              <span class="store-card-tags">
                <span v-for="item in cardTags(skill)" :key="item" class="store-card-tag">{{ item }}</span>
              </span>
              <span class="store-card-meta">{{ skill.version ? 'v' + skill.version : '' }}<template v-if="skill.author"> · {{ skill.author }}</template></span>
            </span>
          </button>
        </div>
      </div>

        <Transition name="store-panel">
          <aside v-if="selected && !isMobile" class="store-panel" :aria-label="selected.name">
            <div class="store-panel-shell">
              <StoreSkillDetail
                :key="selected.id"
                :skill="selected"
                :links="links"
                :doc="doc"
                :documentSource="documentSource"
                :filesSummary="filesSummary(selected)"
                :installBusy="installBusy"
                :installErr="installErr"
                @install="install(selected, $event)"
                @open-installed="openInstalled(selected)"
                @close="close"
              />
            </div>
          </aside>
        </Transition>
      </div>

      <Teleport to="body">
        <Transition name="store-panel-mobile">
          <div v-if="selected && isMobile" class="store-panel-mobile-layer">
            <div class="store-panel-mobile-mask" aria-hidden="true" @click="close"></div>
            <aside class="store-panel-mobile-panel" role="dialog" aria-modal="true" :aria-label="selected.name">
              <div class="store-panel-shell is-mobile">
                <StoreSkillDetail
                  :key="selected.id"
                  :skill="selected"
                  :links="links"
                  :doc="doc"
                  :documentSource="documentSource"
                  :filesSummary="filesSummary(selected)"
                  :installBusy="installBusy"
                  :installErr="installErr"
                  @install="install(selected, $event)"
                  @open-installed="openInstalled(selected)"
                  @close="close"
                />
              </div>
            </aside>
          </div>
        </Transition>
      </Teleport>
    </AppPage>
  `,
};

export default SkillStoreView;
