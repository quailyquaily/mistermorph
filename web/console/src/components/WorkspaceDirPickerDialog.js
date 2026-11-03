import { computed, defineAsyncComponent, nextTick, ref, shallowRef, watch } from "vue";
import "../styles/workspace-tree.css";
import "./WorkspaceDirPickerDialog.css";

import { runtimeApiFetch, runtimeApiFetchForEndpoint, translate } from "../core/context";
import { useNotice } from "../core/notices";
import { loadRecentWorkspaceDirs, rememberRecentWorkspaceDir } from "../core/recent-workspace-dirs";
import { workspaceTreeIcon } from "../core/workspace-icons";
import { buildTreeRows, hasOwnTreePath, setTreeExpanded, setTreeItems } from "../core/workspace-tree";

const AppDialogShell = defineAsyncComponent(() => import("./AppDialogShell"));

const SOURCE_RECENT = "recent";
const SOURCE_HOME = "home";
const SOURCE_SYSTEM = "system";
const SOURCE_STATE_DIR = "state_dir";
const SOURCE_CACHE_DIR = "cache_dir";

function browserSource(sourceID, stateDir = "", cacheDir = "") {
  const value = String(sourceID || "").trim();
  if (value === SOURCE_RECENT) {
    return { id: SOURCE_RECENT, kind: "recent", path: "", selection: "" };
  }
  if (value === SOURCE_SYSTEM) {
    return { id: SOURCE_SYSTEM, kind: "system", path: "", selection: "" };
  }
  const statePath = String(stateDir || "").trim();
  if (value === SOURCE_STATE_DIR && statePath) {
    return { id: SOURCE_STATE_DIR, kind: "place", path: statePath, selection: statePath };
  }
  const cachePath = String(cacheDir || "").trim();
  if (value === SOURCE_CACHE_DIR && cachePath) {
    return { id: SOURCE_CACHE_DIR, kind: "place", path: cachePath, selection: cachePath };
  }
  return { id: SOURCE_HOME, kind: "home", path: "~", selection: "" };
}

function pathLabel(path) {
  const value = String(path || "").trim();
  if (!value) {
    return "";
  }
  const normalized = value.replace(/[\\/]+$/u, "");
  if (!normalized) {
    return value;
  }
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

const WorkspaceBrowserRecentItem = {
  props: {
    name: { type: String, required: true },
    path: { type: String, required: true },
  },
  template: `
    <span class="chat-workspace-recent-item">
      <span class="chat-workspace-recent-item-name">{{ name }}</span>
      <span class="chat-workspace-recent-item-path">{{ path }}</span>
    </span>
  `,
};

// WorkspaceDirPickerDialog browses the runtime's file system for a directory, and can create
// one. It emits `confirm` with the chosen path; the caller decides what picking it means.
const WorkspaceDirPickerDialog = {
  components: {
    AppDialogShell,
    WorkspaceBrowserRecentItem,
  },
  props: {
    modelValue: Boolean,
    // The runtime endpoint to browse. Empty means the currently selected endpoint.
    endpointRef: {
      type: String,
      default: "",
    },
    // The directory selected when the dialog opens.
    initialDir: {
      type: String,
      default: "",
    },
    title: {
      type: String,
      default: "",
    },
    confirmLabel: {
      type: String,
      default: "",
    },
    // True while the caller is acting on a confirmed directory.
    confirming: {
      type: Boolean,
      default: false,
    },
    confirmDisabled: {
      type: Boolean,
      default: false,
    },
  },
  emits: ["update:modelValue", "close", "confirm"],
  setup(props, { emit }) {
    const t = translate;
    const notice = useNotice();

    const items = shallowRef({});
    const expanded = ref({ "": true });
    const loading = ref(false);
    const loadingPath = ref("");
    const error = ref("");
    const sourceID = ref(SOURCE_HOME);
    const recentDirs = ref(loadRecentWorkspaceDirs());
    const stateDir = ref("");
    const cacheDir = ref("");
    const selection = ref("");
    const showHidden = ref(false);
    const createOpen = ref(false);
    const createName = ref("");
    const creating = ref(false);
    const createField = ref(null);

    const dialogTitle = computed(() => props.title || t("chat_workspace_dialog_title"));
    const dialogConfirmLabel = computed(() => props.confirmLabel || t("chat_workspace_action_attach"));
    const recentItems = computed(() =>
      recentDirs.value.map((path) => ({ path, title: pathLabel(path) }))
    );
    const placeSourceItems = computed(() =>
      [
        { id: SOURCE_STATE_DIR, title: t("chat_workspace_dialog_state_dir"), path: stateDir.value },
        { id: SOURCE_CACHE_DIR, title: t("chat_workspace_dialog_cache_dir"), path: cacheDir.value },
      ].filter((item) => String(item.path || "").trim() !== "")
    );
    const currentSource = computed(() => browserSource(sourceID.value, stateDir.value, cacheDir.value));
    const rows = computed(() => {
      if (currentSource.value.kind === "recent") {
        return recentItems.value.map((item) => ({
          key: `recent:${item.path}`,
          depth: 0,
          source: "recent",
          entry: {
            name: item.title,
            path: item.path,
            is_dir: true,
            has_children: false,
          },
          expandable: false,
          expanded: false,
        }));
      }
      return buildTreeRows(items.value, expanded.value, currentSource.value.path);
    });
    const createParent = computed(() => {
      const selectedPath = String(selection.value || "").trim();
      if (selectedPath) {
        return selectedPath;
      }
      const source = currentSource.value;
      if (source.kind === "home" || source.kind === "place") {
        return String(source.path || "").trim();
      }
      return "";
    });
    const createDisabled = computed(
      () => loading.value || props.confirming || creating.value || !createParent.value
    );
    const createSubmitDisabled = computed(
      () => createDisabled.value || !String(createName.value || "").trim()
    );
    const confirmButtonDisabled = computed(
      () =>
        props.confirmDisabled ||
        props.confirming ||
        creating.value ||
        String(selection.value || "").trim() === ""
    );
    const emptyText = computed(() =>
      currentSource.value.kind === "recent"
        ? t("chat_workspace_dialog_recent_empty")
        : t("chat_workspace_dialog_empty")
    );

    function fetchRuntime(pathname, options = {}) {
      const endpointRef = String(props.endpointRef || "").trim();
      if (endpointRef) {
        return runtimeApiFetchForEndpoint(endpointRef, pathname, options);
      }
      return runtimeApiFetch(pathname, options);
    }

    function resetState() {
      items.value = {};
      expanded.value = { "": true };
      loading.value = false;
      loadingPath.value = "";
      error.value = "";
      selection.value = "";
      createOpen.value = false;
      createName.value = "";
      creating.value = false;
    }

    async function load(treePath = "") {
      const path = String(treePath || "").trim();
      loading.value = true;
      loadingPath.value = path;
      try {
        const query = new URLSearchParams();
        if (path) {
          query.set("path", path);
        }
        if (showHidden.value) {
          query.set("show_hidden", "true");
        }
        const data = await fetchRuntime(
          query.toString() ? `/workspace/browse?${query.toString()}` : "/workspace/browse"
        );
        stateDir.value = String(data?.state_dir || "").trim();
        cacheDir.value = String(data?.cache_dir || "").trim();
        setTreeItems(items, path, data?.items);
        if (path) {
          setTreeExpanded(expanded, path, true);
        }
        error.value = "";
        return true;
      } catch (e) {
        error.value = e?.message || t("msg_load_failed");
        return false;
      } finally {
        if (loadingPath.value === path) {
          loading.value = false;
          loadingPath.value = "";
        }
      }
    }

    async function activateSource(nextSourceID) {
      const source = browserSource(nextSourceID, stateDir.value, cacheDir.value);
      sourceID.value = source.id;
      resetState();
      if (source.kind === "recent") {
        error.value = "";
        return true;
      }
      const ok = await load(source.path);
      if (ok) {
        selection.value = source.selection;
      }
      return ok;
    }

    async function openBrowser() {
      recentDirs.value = loadRecentWorkspaceDirs();
      showHidden.value = false;
      await activateSource(SOURCE_HOME);
      const selectedDir = String(props.initialDir || "").trim();
      if (selectedDir) {
        selection.value = selectedDir;
      }
    }

    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          void openBrowser();
        }
      },
      { immediate: true }
    );

    function close() {
      if (creating.value) {
        return;
      }
      createOpen.value = false;
      createName.value = "";
      error.value = "";
      emit("update:modelValue", false);
      emit("close");
    }

    function sourceItemClass(id) {
      const classes = ["workspace-sidebar-item", "workspace-picker-sidebar-item"];
      if (String(id || "").trim() === sourceID.value) {
        classes.push("is-active");
      }
      return classes.join(" ");
    }

    function treeEntryClass(row) {
      const classes = ["chat-workspace-tree-entry", "is-actionable", "is-selectable"];
      if (row?.entry?.is_dir) {
        classes.push("is-dir");
      }
      if (row?.source === "recent") {
        classes.push("is-recent");
      }
      if (String(selection.value || "").trim() === String(row?.entry?.path || "").trim()) {
        classes.push("is-selected");
      }
      return classes.join(" ");
    }

    async function setShowHidden(value) {
      const nextValue = Boolean(value);
      if (showHidden.value === nextValue) {
        return;
      }
      showHidden.value = nextValue;
      if (!props.modelValue || currentSource.value.kind === "recent") {
        return;
      }
      const source = currentSource.value;
      resetState();
      const ok = await load(source.path);
      if (ok) {
        selection.value = source.selection;
      }
    }

    async function toggleNode(entry) {
      const path = String(entry?.path || "").trim();
      if (!entry?.is_dir || !path) {
        return;
      }
      if (expanded.value[path]) {
        setTreeExpanded(expanded, path, false);
        return;
      }
      if (!hasOwnTreePath(items.value, path)) {
        const ok = await load(path);
        if (!ok) {
          return;
        }
      }
      setTreeExpanded(expanded, path, true);
    }

    async function selectNode(row) {
      const entry = row?.entry || row;
      if (!entry?.is_dir) {
        return;
      }
      selection.value = String(entry.path || "").trim();
      if (!row?.expandable || currentSource.value.kind === "recent") {
        return;
      }
      await toggleNode(entry);
    }

    function openCreate() {
      if (createDisabled.value) {
        return;
      }
      createOpen.value = true;
      createName.value = "";
      void nextTick(() => {
        createField.value?.querySelector("input")?.focus();
      });
    }

    function cancelCreate() {
      if (creating.value) {
        return;
      }
      createOpen.value = false;
      createName.value = "";
    }

    async function createDir() {
      const parentPath = String(createParent.value || "").trim();
      const name = String(createName.value || "").trim();
      if (!parentPath || !name || creating.value) {
        return;
      }
      const sourceKind = currentSource.value.kind;
      creating.value = true;
      error.value = "";
      try {
        const data = await fetchRuntime("/workspace/directory", {
          method: "POST",
          body: {
            parent_path: parentPath,
            name,
          },
        });
        const createdPath = String(data?.path || "").trim();
        if (!createdPath) {
          throw new Error(t("msg_save_failed"));
        }
        if (sourceKind === "recent") {
          recentDirs.value = rememberRecentWorkspaceDir(createdPath);
        } else {
          const refreshed = await load(parentPath);
          if (!refreshed) {
            return;
          }
        }
        selection.value = createdPath;
        createOpen.value = false;
        createName.value = "";
      } catch (e) {
        notice.error(e?.message || t("msg_save_failed"));
      } finally {
        creating.value = false;
      }
    }

    function confirm() {
      const dir = String(selection.value || "").trim();
      if (!dir || confirmButtonDisabled.value) {
        return;
      }
      emit("confirm", dir);
    }

    return {
      t,
      dialogTitle,
      dialogConfirmLabel,
      error,
      loading,
      rows,
      placeSourceItems,
      showHidden,
      createOpen,
      createName,
      creating,
      createField,
      createParent,
      createDisabled,
      createSubmitDisabled,
      confirmButtonDisabled,
      emptyText,
      workspaceTreeIcon,
      close,
      activateSource,
      sourceItemClass,
      treeEntryClass,
      setShowHidden,
      selectNode,
      openCreate,
      cancelCreate,
      createDir,
      confirm,
    };
  },
  template: `
    <AppDialogShell
      v-if="modelValue"
      :modelValue="modelValue"
      :title="dialogTitle"
      width="720px"
      :closeDisabled="confirming || creating"
      @close="close"
    >
      <section class="workspace-picker">
        <AppNotice
          v-if="error"
          class="workspace-picker-notice"
          type="error"
          :text="error"
        />

        <div class="workspace-picker-shell">
          <aside class="workspace-picker-sidebar workspace-sidebar-section">
            <section class="workspace-picker-sidebar-group">
              <p class="workspace-picker-sidebar-title ui-kicker">{{ t("chat_workspace_dialog_places") }}</p>
              <div class="workspace-picker-sidebar-list workspace-sidebar-list">
                <button
                  type="button"
                  :class="sourceItemClass('recent')"
                  :disabled="creating"
                  @click="activateSource('recent')"
                >
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ t("chat_workspace_dialog_recent") }}</span>
                  </span>
                </button>
                <button
                  type="button"
                  :class="sourceItemClass('home')"
                  :disabled="creating"
                  @click="activateSource('home')"
                >
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ t("chat_workspace_dialog_home") }}</span>
                  </span>
                </button>
                <button
                  type="button"
                  :class="sourceItemClass('system')"
                  :disabled="creating"
                  @click="activateSource('system')"
                >
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ t("chat_workspace_dialog_system") }}</span>
                  </span>
                </button>
                <button
                  v-for="item in placeSourceItems"
                  :key="item.id"
                  type="button"
                  :class="sourceItemClass(item.id)"
                  :title="item.path"
                  :disabled="creating"
                  @click="activateSource(item.id)"
                >
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ item.title }}</span>
                  </span>
                </button>
              </div>
            </section>
          </aside>

          <div class="workspace-picker-main">
            <div class="workspace-picker-toolbar">
              <span class="workspace-picker-parent">
                <span class="workspace-picker-parent-label ui-kicker">
                  {{ t("chat_workspace_dialog_create_in") }}
                </span>
                <code
                  class="workspace-picker-parent-path"
                  :title="createParent"
                >{{ createParent || t("chat_workspace_dialog_selection_empty") }}</code>
              </span>
              <AppButton
                class="plain xs workspace-picker-create-button"
                :disabled="createDisabled || createOpen"
                @click="openCreate"
              >
                <PhPlus class="icon" />
                <span>{{ t("chat_workspace_dialog_new_directory") }}</span>
              </AppButton>
            </div>

            <div v-if="createOpen" class="workspace-picker-create">
              <div ref="createField" class="workspace-picker-create-field">
                <AppInput
                  v-model="createName"
                  :placeholder="t('chat_workspace_dialog_directory_name')"
                  :aria-label="t('chat_workspace_dialog_directory_name')"
                  :disabled="creating"
                  @keydown.enter.prevent="createDir"
                />
              </div>
              <div class="workspace-picker-create-actions">
                <AppButton
                  class="plain sm"
                  :disabled="creating"
                  @click="cancelCreate"
                >
                  {{ t("action_cancel") }}
                </AppButton>
                <AppButton
                  class="primary sm"
                  :loading="creating"
                  :disabled="createSubmitDisabled"
                  @click="createDir"
                >
                  {{ t("chat_workspace_dialog_create_directory") }}
                </AppButton>
              </div>
            </div>

            <div class="workspace-picker-browser">
              <p
                v-if="loading && rows.length === 0"
                class="chat-workspace-tree-status"
              >
                {{ t("chat_workspace_dialog_loading") }}
              </p>
              <div v-else-if="rows.length > 0" class="chat-workspace-tree-list is-browser">
                <div
                  v-for="row in rows"
                  :key="'browser:' + row.key"
                  class="chat-workspace-tree-row"
                  :style="{ '--tree-depth': row.depth }"
                >
                  <button
                    type="button"
                    :class="treeEntryClass(row)"
                    :disabled="!row.entry.is_dir || creating"
                    :title="row.entry.path"
                    @click="selectNode(row)"
                  >
                    <span class="chat-workspace-tree-kind" aria-hidden="true">
                      <img class="chat-workspace-tree-icon" :src="workspaceTreeIcon(row.entry, row.expanded)" alt="" />
                    </span>
                    <WorkspaceBrowserRecentItem
                      v-if="row.source === 'recent'"
                      :name="row.entry.name"
                      :path="row.entry.path"
                    />
                    <span v-else class="chat-workspace-tree-name">{{ row.entry.name }}</span>
                  </button>
                </div>
              </div>
              <p v-else class="chat-workspace-tree-status">{{ emptyText }}</p>
            </div>
          </div>

          <div class="workspace-picker-actions">
            <div class="workspace-picker-options">
              <AppSwitch
                :modelValue="showHidden"
                :disabled="loading || creating"
                :aria-label="t('chat_workspace_dialog_show_hidden')"
                @update:modelValue="setShowHidden"
              />
              <span class="workspace-picker-option-label">{{ t("chat_workspace_dialog_show_hidden") }}</span>
            </div>
            <div class="workspace-picker-action-buttons">
              <AppButton
                class="plain sm"
                :disabled="confirming || creating"
                @click="close"
              >
                {{ t("action_cancel") }}
              </AppButton>
              <AppButton
                class="primary sm"
                :loading="confirming"
                :disabled="confirmButtonDisabled"
                @click="confirm"
              >
                {{ dialogConfirmLabel }}
              </AppButton>
            </div>
          </div>
        </div>
      </section>
    </AppDialogShell>
  `,
};

export default WorkspaceDirPickerDialog;
