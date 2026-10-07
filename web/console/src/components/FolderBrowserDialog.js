import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useToast } from "quail-ui";
import "./FolderBrowserDialog.css";

import AppDialogShell from "./AppDialogShell";
import { runtimeApiFetchForEndpoint, translate } from "../core/context";
import { buildTreeRows, hasOwnTreePath, setTreeExpanded, setTreeItems } from "../core/folder-tree";
import { loadRecentFolders, rememberRecentFolder } from "../core/recent-folders";
import { workspaceTreeIcon } from "../core/workspace-icons";

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

function folderName(path) {
  const value = String(path || "").trim();
  const normalized = value.replace(/[\\/]+$/u, "");
  if (!normalized) {
    return value;
  }
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

const RecentFolderItem = {
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

// A folder browser over an endpoint's file system (its /workspace/browse API): recent folders,
// home, the system root and the state and cache dirs, with a way to make a new folder. It emits
// confirm with the chosen folder; the caller closes it.
export default {
  components: { AppDialogShell, RecentFolderItem },
  props: {
    modelValue: Boolean,
    endpointRef: { type: String, default: "" },
    title: { type: String, default: "" },
    confirmLabel: { type: String, default: "" },
    // The folder selected when the dialog opens.
    initialPath: { type: String, default: "" },
    // The caller is saving the choice: the dialog stays open and its actions wait.
    busy: Boolean,
    confirmDisabled: Boolean,
  },
  emits: ["update:modelValue", "close", "confirm"],
  setup(props, { emit }) {
    const t = translate;
    const toast = useToast();
    const items = shallowRef({});
    const expanded = ref({ "": true });
    const loading = ref(false);
    const loadingPath = ref("");
    const error = ref("");
    const sourceID = ref(SOURCE_HOME);
    const recentDirs = ref(loadRecentFolders());
    const stateDir = ref("");
    const cacheDir = ref("");
    const selection = ref("");
    const showHidden = ref(false);
    const createOpen = ref(false);
    const createName = ref("");
    const creating = ref(false);
    const createField = ref(null);

    const endpoint = computed(() => String(props.endpointRef || "").trim());
    const currentSource = computed(() => browserSource(sourceID.value, stateDir.value, cacheDir.value));
    const placeSourceItems = computed(() =>
      [
        { id: SOURCE_STATE_DIR, title: t("chat_workspace_dialog_state_dir"), path: stateDir.value },
        { id: SOURCE_CACHE_DIR, title: t("chat_workspace_dialog_cache_dir"), path: cacheDir.value },
      ].filter((item) => String(item.path || "").trim() !== "")
    );
    const rows = computed(() => {
      if (currentSource.value.kind === "recent") {
        return recentDirs.value.map((path) => ({
          key: `recent:${path}`,
          depth: 0,
          source: "recent",
          entry: { name: folderName(path), path, is_dir: true, has_children: false },
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
      () => loading.value || props.busy || creating.value || !endpoint.value || !createParent.value
    );
    const createSubmitDisabled = computed(() => createDisabled.value || !String(createName.value || "").trim());
    const confirmBlocked = computed(
      () => props.busy || props.confirmDisabled || creating.value || !String(selection.value || "").trim()
    );
    const emptyText = computed(() =>
      currentSource.value.kind === "recent" ? t("chat_workspace_dialog_recent_empty") : t("chat_workspace_dialog_empty")
    );

    function resetTree() {
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
      if (!endpoint.value) {
        resetTree();
        stateDir.value = "";
        cacheDir.value = "";
        return false;
      }
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
        const data = await runtimeApiFetchForEndpoint(
          endpoint.value,
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

    async function activateSource(id) {
      const source = browserSource(id, stateDir.value, cacheDir.value);
      sourceID.value = source.id;
      resetTree();
      if (source.kind === "recent") {
        return true;
      }
      const ok = await load(source.path);
      if (ok) {
        selection.value = source.selection;
      }
      return ok;
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
      resetTree();
      if (await load(source.path)) {
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
      if (!hasOwnTreePath(items.value, path) && !(await load(path))) {
        return;
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
      if (!endpoint.value || !parentPath || !name || creating.value) {
        return;
      }
      const sourceKind = currentSource.value.kind;
      creating.value = true;
      error.value = "";
      try {
        const data = await runtimeApiFetchForEndpoint(endpoint.value, "/workspace/directory", {
          method: "POST",
          body: { parent_path: parentPath, name },
        });
        const createdPath = String(data?.path || "").trim();
        if (!createdPath) {
          throw new Error(t("msg_save_failed"));
        }
        if (sourceKind === "recent") {
          recentDirs.value = rememberRecentFolder(createdPath);
        } else if (!(await load(parentPath))) {
          return;
        }
        selection.value = createdPath;
        createOpen.value = false;
        createName.value = "";
      } catch (e) {
        toast.error(e?.message || t("msg_save_failed"));
      } finally {
        creating.value = false;
      }
    }

    function close() {
      if (creating.value || props.busy) {
        return;
      }
      createOpen.value = false;
      createName.value = "";
      emit("update:modelValue", false);
      emit("close");
    }

    function confirm() {
      const path = String(selection.value || "").trim();
      if (confirmBlocked.value || !path) {
        return;
      }
      recentDirs.value = rememberRecentFolder(path);
      emit("confirm", path);
    }

    function sourceItemClass(id) {
      const classes = ["workspace-sidebar-item", "chat-workspace-dialog-sidebar-item"];
      if (String(id || "").trim() === sourceID.value) {
        classes.push("is-active");
      }
      return classes.join(" ");
    }

    function entryClass(row) {
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

    watch(
      () => props.modelValue,
      async (open) => {
        if (!open) {
          return;
        }
        recentDirs.value = loadRecentFolders();
        showHidden.value = false;
        error.value = "";
        await activateSource(SOURCE_HOME);
        const initial = String(props.initialPath || "").trim();
        if (initial) {
          selection.value = initial;
        }
      },
      { immediate: true }
    );

    return {
      t,
      rows,
      loading,
      error,
      selection,
      showHidden,
      createOpen,
      createName,
      creating,
      createField,
      createParent,
      createDisabled,
      createSubmitDisabled,
      confirmBlocked,
      emptyText,
      placeSourceItems,
      activateSource,
      setShowHidden,
      selectNode,
      openCreate,
      cancelCreate,
      createDir,
      close,
      confirm,
      sourceItemClass,
      entryClass,
      workspaceTreeIcon,
    };
  },
  template: `
    <AppDialogShell
      :modelValue="modelValue"
      :title="title || t('chat_workspace_dialog_title')"
      width="720px"
      :closeDisabled="busy || creating"
      @close="close"
    >
      <section class="chat-workspace-dialog">
        <QFence v-if="error" class="folder-browser-fence" type="danger" icon="PhXCircle" :text="error" />

        <div class="chat-workspace-dialog-shell">
          <aside class="chat-workspace-dialog-sidebar workspace-sidebar-section">
            <section class="chat-workspace-dialog-sidebar-group">
              <p class="chat-workspace-dialog-sidebar-title ui-kicker">{{ t("chat_workspace_dialog_places") }}</p>
              <div class="chat-workspace-dialog-sidebar-list workspace-sidebar-list">
                <button type="button" :class="sourceItemClass('recent')" :disabled="creating" @click="activateSource('recent')">
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ t("chat_workspace_dialog_recent") }}</span>
                  </span>
                </button>
                <button type="button" :class="sourceItemClass('home')" :disabled="creating" @click="activateSource('home')">
                  <span class="workspace-sidebar-item-copy">
                    <span class="workspace-sidebar-item-title">{{ t("chat_workspace_dialog_home") }}</span>
                  </span>
                </button>
                <button type="button" :class="sourceItemClass('system')" :disabled="creating" @click="activateSource('system')">
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

          <div class="chat-workspace-dialog-main">
            <div class="chat-workspace-browser-toolbar">
              <span class="chat-workspace-browser-parent">
                <span class="chat-workspace-browser-parent-label ui-kicker">{{ t("chat_workspace_dialog_create_in") }}</span>
                <code class="chat-workspace-browser-parent-path" :title="createParent">{{
                  createParent || t("chat_workspace_dialog_selection_empty")
                }}</code>
              </span>
              <QButton class="plain xs chat-workspace-browser-create-button" :disabled="createDisabled || createOpen" @click="openCreate">
                <PhPlus class="icon" />
                <span>{{ t("chat_workspace_dialog_new_directory") }}</span>
              </QButton>
            </div>

            <div v-if="createOpen" class="chat-workspace-browser-create">
              <div ref="createField" class="chat-workspace-browser-create-field">
                <QInput
                  v-model="createName"
                  :placeholder="t('chat_workspace_dialog_directory_name')"
                  :aria-label="t('chat_workspace_dialog_directory_name')"
                  :disabled="creating"
                  @keydown.enter.prevent="createDir"
                />
              </div>
              <div class="chat-workspace-browser-create-actions">
                <QButton class="plain sm" :disabled="creating" @click="cancelCreate">{{ t("action_cancel") }}</QButton>
                <QButton class="primary sm" :loading="creating" :disabled="createSubmitDisabled" @click="createDir">
                  {{ t("chat_workspace_dialog_create_directory") }}
                </QButton>
              </div>
            </div>

            <div class="chat-workspace-browser-shell">
              <p v-if="loading && rows.length === 0" class="chat-workspace-tree-status">{{ t("chat_workspace_dialog_loading") }}</p>
              <div v-else-if="rows.length > 0" class="chat-workspace-tree-list is-browser">
                <div
                  v-for="row in rows"
                  :key="'browser:' + row.key"
                  class="chat-workspace-tree-row"
                  :style="{ '--tree-depth': row.depth }"
                >
                  <button
                    type="button"
                    :class="entryClass(row)"
                    :disabled="!row.entry.is_dir || creating"
                    :title="row.entry.path"
                    @click="selectNode(row)"
                  >
                    <span class="chat-workspace-tree-kind" aria-hidden="true">
                      <img class="chat-workspace-tree-icon" :src="workspaceTreeIcon(row.entry, row.expanded)" alt="" />
                    </span>
                    <RecentFolderItem v-if="row.source === 'recent'" :name="row.entry.name" :path="row.entry.path" />
                    <span v-else class="chat-workspace-tree-name">{{ row.entry.name }}</span>
                  </button>
                </div>
              </div>
              <p v-else class="chat-workspace-tree-status">{{ emptyText }}</p>
            </div>
          </div>

          <div class="chat-workspace-dialog-actions">
            <div class="chat-workspace-dialog-options">
              <QSwitch
                :modelValue="showHidden"
                :disabled="loading || creating"
                :aria-label="t('chat_workspace_dialog_show_hidden')"
                @update:modelValue="setShowHidden"
              />
              <span class="chat-workspace-dialog-option-label">{{ t("chat_workspace_dialog_show_hidden") }}</span>
            </div>
            <div class="chat-workspace-dialog-action-buttons">
              <QButton class="plain sm" :disabled="busy || creating" @click="close">{{ t("action_cancel") }}</QButton>
              <QButton class="primary sm" :loading="busy" :disabled="confirmBlocked" @click="confirm">
                {{ confirmLabel || t("chat_workspace_action_attach") }}
              </QButton>
            </div>
          </div>
        </div>
      </section>
    </AppDialogShell>
  `,
};
