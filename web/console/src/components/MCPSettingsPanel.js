import { computed, onUnmounted, reactive, ref, watch } from "vue";

import AppTabs from "./AppTabs";
import AppSidePane from "./AppSidePane";
import { translate } from "../core/context";
import "./MCPSettingsPanel.css";
import AppSkeleton from "./AppSkeleton";

let mcpKeySeed = 0;

function nextKey(kind) {
  mcpKeySeed += 1;
  return `mcp-${kind}-${mcpKeySeed}`;
}

function clonePair(row) {
  return {
    _key: String(row?._key || nextKey("pair")),
    key: String(row?.key || ""),
    value: String(row?.value || ""),
  };
}

function cloneServer(server) {
  return {
    _key: String(server?._key || nextKey("server")),
    name: String(server?.name || ""),
    enable: server?.enable !== false,
    on_demand: server?.on_demand === true,
    description: String(server?.description || ""),
    type: server?.type === "http" ? "http" : "stdio",
    command: String(server?.command || ""),
    args_text: String(server?.args_text || ""),
    env_rows: Array.isArray(server?.env_rows) ? server.env_rows.map(clonePair) : [],
    url: String(server?.url || ""),
    header_rows: Array.isArray(server?.header_rows) ? server.header_rows.map(clonePair) : [],
    allowed_tools_text: String(server?.allowed_tools_text || ""),
  };
}

function emptyServer() {
  return cloneServer({ enable: true, type: "stdio" });
}

const MCPSettingsPanel = {
  components: { AppSidePane, AppSkeleton, AppTabs },
  props: {
    modelValue: { type: Array, default: () => [] },
    loading: { type: Boolean, default: false },
    saving: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
    readOnlyMessage: { type: String, default: "" },
    validationError: { type: String, default: "" },
    // The server opens in a side pane: as a drawer on phones, and otherwise moved into paneTarget
    // (the page's pane column) when one is given.
    mobile: { type: Boolean, default: false },
    paneTarget: { type: String, default: "" },
  },
  emits: ["save", "pane-change"],
  setup(props, { emit }) {
    const t = translate;
    const paneOpen = ref(false);
    const editingIndex = ref(-1);
    const editor = reactive(emptyServer());
    const dialogError = ref("");
    const servers = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));
    const busy = computed(() => props.loading || props.saving || props.readOnly);
    const paneTitle = computed(() =>
      editingIndex.value < 0 ? t("settings_mcp_add_server") : editor.name.trim() || servers.value[editingIndex.value]?.name || "MCP Server",
    );
    // Set when a server opens, not from the index, so saving a new server keeps its pane.
    const paneKey = ref("");
    // The editor is a draft of one server: Save writes it into the list, closing drops it.
    const snapshot = ref("");
    const dirty = computed(() => paneOpen.value && JSON.stringify(cloneServer(editor)) !== snapshot.value);
    const transportTabs = computed(() => [
      { id: "stdio", title: t("settings_mcp_stdio"), icon: "PhTerminalWindow" },
      { id: "http", title: t("settings_mcp_http"), icon: "PhGlobe" },
    ]);
    const selectedTransportTab = computed(() =>
      transportTabs.value.find((tab) => tab.id === editor.type) || transportTabs.value[0],
    );

    function replaceEditor(server) {
      for (const key of Object.keys(editor)) delete editor[key];
      Object.assign(editor, cloneServer(server));
      snapshot.value = JSON.stringify(cloneServer(editor));
      dialogError.value = "";
    }

    function openAdd() {
      editingIndex.value = -1;
      paneKey.value = nextKey("pane");
      replaceEditor(emptyServer());
      paneOpen.value = true;
    }

    function openEdit(index) {
      const server = servers.value[index];
      if (!server) return;
      if (paneOpen.value && editingIndex.value === index) {
        closePane();
        return;
      }
      editingIndex.value = index;
      paneKey.value = server._key;
      replaceEditor(server);
      paneOpen.value = true;
    }

    function closePane() {
      paneOpen.value = false;
      dialogError.value = "";
    }

    watch(paneOpen, (open) => emit("pane-change", open));
    onUnmounted(() => {
      if (paneOpen.value) emit("pane-change", false);
    });

    function setServerEnabled(index, enabled) {
      const next = servers.value.map(cloneServer);
      if (!next[index]) return;
      next[index].enable = !!enabled;
      emit("save", next);
    }

    function updateEditor(field, value) {
      editor[field] = String(value ?? "");
      dialogError.value = "";
    }

    function updateOnDemand(value) {
      editor.on_demand = !!value;
      dialogError.value = "";
    }

    function addPair(field) {
      editor[field].push({ _key: nextKey("pair"), key: "", value: "" });
    }

    function updatePair(field, index, key, value) {
      const row = editor[field]?.[index];
      if (row) row[key] = String(value ?? "");
      dialogError.value = "";
    }

    function removePair(field, index) {
      editor[field]?.splice(index, 1);
    }

    function validate(next) {
      const name = editor.name.trim();
      if (!name) return t("settings_mcp_error_name_required");
      const duplicate = next.some((server, index) =>
        index !== editingIndex.value && String(server?.name || "").trim().toLowerCase() === name.toLowerCase(),
      );
      if (duplicate) return t("settings_mcp_error_name_duplicate", { name });
      if (editor.enable && editor.type === "http" && !editor.url.trim()) {
        return t("settings_mcp_error_url_required", { name });
      }
      if (editor.enable && editor.type !== "http" && !editor.command.trim()) {
        return t("settings_mcp_error_command_required", { name });
      }
      for (const rows of [editor.env_rows, editor.header_rows]) {
        const keys = new Set();
        for (const row of rows) {
          const key = row.key.trim();
          if (!key) return t("settings_mcp_error_key_required", { name });
          const normalized = key.toLowerCase();
          if (keys.has(normalized)) return t("settings_mcp_error_key_duplicate", { name, key });
          keys.add(normalized);
        }
      }
      return "";
    }

    function saveEditor() {
      const next = servers.value.map(cloneServer);
      const error = validate(next);
      if (error) {
        dialogError.value = error;
        return;
      }
      if (editingIndex.value < 0) {
        next.push(cloneServer(editor));
        editingIndex.value = next.length - 1;
      } else {
        next[editingIndex.value] = cloneServer(editor);
      }
      snapshot.value = JSON.stringify(cloneServer(editor));
      emit("save", next);
    }

    function deleteEditor() {
      if (editingIndex.value < 0) return;
      const next = servers.value.map(cloneServer);
      next.splice(editingIndex.value, 1);
      closePane();
      emit("save", next);
    }

    return {
      t,
      servers,
      busy,
      paneOpen,
      paneTitle,
      paneKey,
      dirty,
      closePane,
      editingIndex,
      editor,
      dialogError,
      transportTabs,
      selectedTransportTab,
      openAdd,
      openEdit,
      setServerEnabled,
      updateEditor,
      addPair,
      updatePair,
      removePair,
      saveEditor,
      updateOnDemand,
      deleteEditor,
    };
  },
  template: `
    <div class="mcp-settings-panel">
      <AppSection variant="boxed" class="is-list" :title="t('settings_mcp_title')" :meta="t('settings_section_mcp_meta')">
        <template #actions>
          <QButton
            class="plain xs icon"
            :title="t('settings_mcp_add_server')"
            :aria-label="t('settings_mcp_add_server')"
            :disabled="busy"
            @click="openAdd"
          >
            <PhPlus class="icon" />
          </QButton>
        </template>
        <p v-if="readOnly" class="mcp-settings-message is-warning">{{ readOnlyMessage }}</p>
        <p v-else-if="validationError" class="mcp-settings-message is-error">{{ validationError }}</p>

        <div class="settings-panel-body mcp-settings-body">
          <div v-if="loading" class="mcp-settings-skeleton" aria-hidden="true">
            <AppSkeleton variant="card" height="72px" :count="2" />
          </div>

          <div v-else-if="!servers.length" class="mcp-settings-empty">
            <PhPlugsConnected class="mcp-settings-empty-icon" />
            <strong>{{ t("settings_mcp_empty") }}</strong>
            <span>{{ t("settings_mcp_empty_note") }}</span>
          </div>

          <div v-else class="settings-toggle-list mcp-server-list">
            <section
              v-for="(server, index) in servers"
              :key="server._key"
              class="settings-toggle-row mcp-server-row"
              :class="{ 'is-active': paneOpen && editingIndex === index }"
            >
              <button
                type="button"
                class="settings-toggle-copy mcp-server-copy"
                :aria-pressed="paneOpen && editingIndex === index ? 'true' : 'false'"
                :disabled="busy"
                @click="openEdit(index)"
              >
                <strong class="settings-toggle-title">{{ server.name }}</strong>
                <span class="settings-toggle-note">{{ server.type === 'http' ? server.url : server.command }}</span>
                <span v-if="server.on_demand" class="settings-toggle-note">{{ t("settings_mcp_on_demand_hint", { name: server.name }) }}</span>
              </button>
              <div class="settings-toggle-actions">
                <QSwitch
                  :modelValue="server.enable !== false"
                  :disabled="busy"
                  :aria-label="server.name"
                  @update:modelValue="setServerEnabled(index, $event)"
                />
              </div>
            </section>
          </div>
        </div>
      </AppSection>

      <Teleport :to="paneTarget || 'body'" :disabled="!paneTarget || mobile" defer>
        <AppSidePane class="mcp-editor-pane" :open="paneOpen" :sheet="mobile" :paneKey="paneKey" :label="paneTitle" @close="closePane">
          <AppSection class="is-literal" :title="paneTitle" :meta="editor.type === 'http' ? t('settings_mcp_http') : t('settings_mcp_stdio')">
            <template #actions>
              <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="closePane">
                <PhX class="icon" />
              </QButton>
            </template>
            <div class="settings-panel-body mcp-editor-body">
              <AppTabs
                class="mcp-transport"
                :tabs="transportTabs"
                :modelValue="selectedTransportTab"
                :disabled="busy"
                :ariaLabel="t('settings_mcp_transport')"
                @change="updateEditor('type', $event.tab.id)"
              />

              <label class="settings-field is-wide">
                <span class="settings-field-label">{{ t("settings_mcp_name") }}</span>
                <QInput :modelValue="editor.name" :placeholder="t('settings_mcp_name_placeholder')" :disabled="busy" @update:modelValue="updateEditor('name', $event)" />
              </label>

              <div class="settings-toggle-row mcp-on-demand-row">
                <div class="settings-toggle-copy">
                  <strong class="settings-toggle-title">{{ t("settings_mcp_on_demand") }}</strong>
                  <span class="settings-toggle-note">{{ t("settings_mcp_on_demand_note", { name: editor.name.trim() || "<name>" }) }}</span>
                </div>
                <QSwitch :modelValue="editor.on_demand" :disabled="busy" :aria-label="t('settings_mcp_on_demand')" @update:modelValue="updateOnDemand" />
              </div>

              <label class="settings-field is-wide">
                <span class="settings-field-label">{{ t("settings_mcp_description") }}</span>
                <QInput :modelValue="editor.description" :placeholder="t('settings_mcp_description_placeholder')" :disabled="busy" @update:modelValue="updateEditor('description', $event)" />
                <span class="settings-panel-meta">{{ t("settings_mcp_description_note") }}</span>
              </label>

              <template v-if="editor.type === 'http'">
                <label class="settings-field is-wide">
                  <span class="settings-field-label">{{ t("settings_mcp_url") }}</span>
                  <QInput :modelValue="editor.url" placeholder="https://mcp.example.com/mcp" :disabled="busy" @update:modelValue="updateEditor('url', $event)" />
                </label>
                <div class="settings-field is-wide mcp-pairs-field">
                  <div class="mcp-field-head">
                    <span class="settings-field-label">{{ t("settings_mcp_headers") }}</span>
                    <QButton class="plain sm" :disabled="busy" @click="addPair('header_rows')"><PhPlus class="icon" />{{ t("settings_mcp_add_header") }}</QButton>
                  </div>
                  <div v-for="(row, index) in editor.header_rows" :key="row._key" class="mcp-pair-row">
                    <QInput :modelValue="row.key" :placeholder="t('settings_mcp_header_name')" :disabled="busy" @update:modelValue="updatePair('header_rows', index, 'key', $event)" />
                    <QInput :modelValue="row.value" :placeholder="t('settings_mcp_header_value')" :disabled="busy" @update:modelValue="updatePair('header_rows', index, 'value', $event)" />
                    <QButton class="plain sm icon" :title="t('action_delete')" :aria-label="t('action_delete')" :disabled="busy" @click="removePair('header_rows', index)"><PhTrash class="icon" /></QButton>
                  </div>
                </div>
              </template>

              <template v-else>
                <label class="settings-field is-wide">
                  <span class="settings-field-label">{{ t("settings_mcp_command") }}</span>
                  <QInput :modelValue="editor.command" placeholder="node" :disabled="busy" @update:modelValue="updateEditor('command', $event)" />
                </label>
                <label class="settings-field is-wide">
                  <span class="settings-field-label">{{ t("settings_mcp_arguments") }}</span>
                  <QTextarea :modelValue="editor.args_text" :rows="3" :placeholder="t('settings_mcp_arguments_placeholder')" :disabled="busy" @update:modelValue="updateEditor('args_text', $event)" />
                  <span class="settings-panel-meta">{{ t("settings_mcp_arguments_note") }}</span>
                </label>
                <div class="settings-field is-wide mcp-pairs-field">
                  <div class="mcp-field-head">
                    <span class="settings-field-label">{{ t("settings_mcp_environment") }}</span>
                    <QButton class="plain sm" :disabled="busy" @click="addPair('env_rows')"><PhPlus class="icon" />{{ t("settings_mcp_add_variable") }}</QButton>
                  </div>
                  <div v-for="(row, index) in editor.env_rows" :key="row._key" class="mcp-pair-row">
                    <QInput :modelValue="row.key" :placeholder="t('settings_mcp_variable_name')" :disabled="busy" @update:modelValue="updatePair('env_rows', index, 'key', $event)" />
                    <QInput :modelValue="row.value" :placeholder="t('settings_mcp_variable_value')" :disabled="busy" @update:modelValue="updatePair('env_rows', index, 'value', $event)" />
                    <QButton class="plain sm icon" :title="t('action_delete')" :aria-label="t('action_delete')" :disabled="busy" @click="removePair('env_rows', index)"><PhTrash class="icon" /></QButton>
                  </div>
                </div>
              </template>

              <label class="settings-field is-wide">
                <span class="settings-field-label">{{ t("settings_mcp_allowed_tools") }}</span>
                <QTextarea :modelValue="editor.allowed_tools_text" :rows="3" :placeholder="t('settings_mcp_allowed_tools_placeholder')" :disabled="busy" @update:modelValue="updateEditor('allowed_tools_text', $event)" />
                <span class="settings-panel-meta">{{ t("settings_mcp_allowed_tools_note") }}</span>
              </label>

              <div v-if="editingIndex >= 0" class="mcp-editor-actions">
                <QButton class="outlined danger" :disabled="busy" @click="deleteEditor">
                  <PhTrash class="icon" />
                  {{ t("settings_mcp_delete_server") }}
                </QButton>
              </div>
            </div>
          </AppSection>
          <template v-if="dirty || editingIndex < 0 || dialogError" #foot>
            <p class="app-side-pane-foot-text" :class="{ 'is-error': dialogError }" role="status">
              {{ dialogError || (dirty ? t("settings_channel_unsaved_note") : "") }}
            </p>
            <QButton class="primary" :loading="saving" :disabled="busy || (!dirty && editingIndex >= 0)" @click="saveEditor">
              {{ t("action_save") }}
            </QButton>
          </template>
        </AppSidePane>
      </Teleport>
    </div>
  `,
};

export default MCPSettingsPanel;
