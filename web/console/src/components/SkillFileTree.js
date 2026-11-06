import { computed, ref, watch } from "vue";
import "./SkillFileTree.css";

import { endpointApiFetch, formatBytes, translate } from "../core/context";
import {
  createRequestGuard,
  isSelectableSkillEntry,
  normalizeSkillDirListing,
  skillDirURL,
  skillPathErrorKind,
  skillTreeRows,
} from "../core/skill-files.js";

// A skill's folder as a read-only tree. Folders are read one level at a time when opened; files
// are chosen with "select" and previewed by the page. Links and special files are listed but
// cannot be opened. Another skill or agent starts over, and answers for the old one are dropped.
const SkillFileTree = {
  props: {
    endpointRef: { type: String, default: "" },
    skillId: { type: String, default: "" },
    selectedPath: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
    // The catalog's flat list, shown when the agent cannot browse folders.
    fallbackFiles: { type: Array, default: () => [] },
  },
  emits: ["select"],
  setup(props, { emit }) {
    const t = translate;
    const nodes = ref({});
    const expanded = ref(new Set());
    const unsupported = ref(false);
    const guard = createRequestGuard();
    const rows = computed(() => skillTreeRows(nodes.value, expanded.value));

    function setNode(path, node) {
      nodes.value = { ...nodes.value, [path]: node };
    }

    async function loadDir(path) {
      const ticket = guard.peek();
      const endpointRef = props.endpointRef;
      const id = props.skillId;
      if (!id) {
        return;
      }
      setNode(path, { status: "loading" });
      try {
        const data = await endpointApiFetch(endpointRef, skillDirURL(id, path));
        if (!guard.current(ticket)) {
          return;
        }
        const listing = normalizeSkillDirListing(data, path);
        setNode(path, { status: "ready", entries: listing.entries, capped: listing.capped });
      } catch (e) {
        if (!guard.current(ticket)) {
          return;
        }
        const kind = skillPathErrorKind(e);
        if (path === "" && kind === "unsupported") {
          unsupported.value = true;
        }
        setNode(path, { status: "error", error: kind, message: String(e?.message || "") });
      }
    }

    function reset() {
      guard.next();
      nodes.value = {};
      expanded.value = new Set();
      unsupported.value = false;
      void loadDir("");
    }

    function toggle(entry) {
      const next = new Set(expanded.value);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        const node = nodes.value[entry.path];
        if (!node || node.status === "error") {
          void loadDir(entry.path);
        }
      }
      expanded.value = next;
    }

    function choose(entry) {
      if (!props.disabled && isSelectableSkillEntry(entry)) {
        emit("select", entry.path);
      }
    }

    function dirErrorText(row) {
      switch (row.error) {
        case "missing":
          return t("skills_files_dir_missing");
        case "denied":
          return t("skills_files_dir_denied");
        case "symlink":
          return t("skills_files_link");
        default:
          return t("skills_files_dir_failed");
      }
    }

    function rowIndent(row) {
      return { "--skill-file-depth": String(row.depth) };
    }

    watch(() => [props.endpointRef, props.skillId], reset, { immediate: true });

    return { t, rows, unsupported, toggle, choose, retry: loadDir, dirErrorText, rowIndent, formatBytes };
  },
  template: `
    <div class="skill-file-tree">
      <template v-if="unsupported">
        <p class="skill-file-tree-status">{{ t('skills_files_unsupported') }}</p>
        <ul class="skills-files">
          <li v-for="file in fallbackFiles" :key="file.path">
            <code>{{ file.path }}</code>
            <span>{{ formatBytes(file.size) }}</span>
          </li>
        </ul>
      </template>
      <ul v-else class="skill-file-tree-list" :aria-label="t('skills_fact_files')">
        <li v-for="row in rows" :key="row.key" class="skill-file-tree-row" :style="rowIndent(row)">
          <button
            v-if="row.type === 'entry' && row.entry.kind === 'dir'"
            type="button"
            class="skill-file-tree-item is-dir"
            :aria-expanded="row.open ? 'true' : 'false'"
            :title="row.path"
            @click="toggle(row.entry)"
          >
            <PhCaretRight class="icon skill-file-tree-caret" :class="{ 'is-open': row.open }" aria-hidden="true" />
            <PhFolderOpen v-if="row.open" class="icon" aria-hidden="true" />
            <PhFolder v-else class="icon" aria-hidden="true" />
            <span class="skill-file-tree-name">{{ row.entry.name }}</span>
          </button>
          <button
            v-else-if="row.type === 'entry' && row.entry.kind === 'file'"
            type="button"
            class="skill-file-tree-item is-file"
            :class="{ 'is-selected': row.path === selectedPath }"
            :aria-current="row.path === selectedPath ? 'true' : undefined"
            :disabled="disabled"
            :title="row.path"
            @click="choose(row.entry)"
          >
            <span class="skill-file-tree-caret" aria-hidden="true"></span>
            <PhFileText class="icon" aria-hidden="true" />
            <span class="skill-file-tree-name">{{ row.entry.name }}</span>
            <span class="skill-file-tree-size">{{ formatBytes(row.entry.size) }}</span>
          </button>
          <div v-else-if="row.type === 'entry'" class="skill-file-tree-item is-inert" :title="row.path">
            <span class="skill-file-tree-caret" aria-hidden="true"></span>
            <PhLink v-if="row.entry.kind === 'symlink'" class="icon" aria-hidden="true" />
            <PhFile v-else class="icon" aria-hidden="true" />
            <span class="skill-file-tree-name">{{ row.entry.name }}</span>
            <span class="skill-file-tree-size">{{ row.entry.kind === 'symlink' ? t('skills_files_link') : t('skills_files_special') }}</span>
          </div>
          <p v-else-if="row.type === 'loading'" class="skill-file-tree-status" role="status">{{ t('skills_files_loading') }}</p>
          <p v-else-if="row.type === 'empty'" class="skill-file-tree-status">{{ t('skills_files_empty_dir') }}</p>
          <p v-else-if="row.type === 'capped'" class="skill-file-tree-status">{{ t('skills_files_capped', { count: row.count }) }}</p>
          <p v-else class="skill-file-tree-status is-error" role="alert">
            <span>{{ dirErrorText(row) }}</span>
            <button v-if="row.error === 'failed'" type="button" class="skill-file-tree-retry" @click="retry(row.path)">{{ t('skills_files_retry') }}</button>
          </p>
        </li>
      </ul>
    </div>
  `,
};

export default SkillFileTree;
