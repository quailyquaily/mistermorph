import { computed, onUnmounted, reactive, ref, watch } from "vue";
import AppSidePane from "./AppSidePane";
import SecretInput from "./SecretInput";
import { translate } from "../core/context";
import "./ConsoleEndpointsPanel.css";

export default {
  name: "ConsoleEndpointsPanel",
  components: { AppSidePane, SecretInput },
  props: {
    endpoints: { type: Array, default: () => [] },
    runtimeEndpoints: { type: Array, default: () => [] },
    loading: Boolean,
    saving: Boolean,
    addRequested: Boolean,
    // The agent opens in a side pane: as a drawer on phones, and otherwise moved into paneTarget
    // (the page's pane column) when one is given.
    mobile: Boolean,
    paneTarget: { type: String, default: "" },
  },
  emits: ["save", "add-opened", "pane-change"],
  setup(props, { emit }) {
    const t = translate;
    const editorOpen = ref(false);
    const editorError = ref("");
    const editingName = ref(null);
    const draft = reactive({ name: "", url: "", auth_token: "", configured: false });
    // Set when an agent opens, so saving a new agent (which gives it a name) keeps its pane.
    const paneKey = ref("");
    let paneSeed = 0;
    const original = reactive({ name: "", url: "" });
    const dirty = computed(() => editorOpen.value && (draft.name !== original.name || draft.url !== original.url || draft.auth_token.trim() !== ""));
    const removeTarget = ref(null);
    const removeError = ref("");
    const valid = computed(() => Boolean(draft.name.trim() && draft.url.trim() && (draft.configured || draft.auth_token.trim())));
    const rows = computed(() => props.endpoints.map((endpoint) => {
      const live = props.runtimeEndpoints.find((item) => item.name === endpoint.name && item.url === endpoint.url);
      const status = live?.health_pending ? "checking" : live?.connected === true ? "online" : live?.connected === false ? "offline" : "unknown";
      return { ...endpoint, status };
    }));

    function edit(endpoint = null) {
      if (props.loading || props.saving) return;
      if (endpoint && editorOpen.value && editingName.value === endpoint.name) {
        editorOpen.value = false;
        return;
      }
      editingName.value = endpoint?.name ?? null;
      paneSeed += 1;
      paneKey.value = `agent-${paneSeed}`;
      Object.assign(original, { name: endpoint?.name || "", url: endpoint?.url || "" });
      Object.assign(draft, { name: endpoint?.name || "", url: endpoint?.url || "", auth_token: "", configured: endpoint?.auth_token_configured === true });
      editorError.value = "";
      editorOpen.value = true;
    }

    function save() {
      if (props.loading || props.saving || !valid.value) return;
      editorError.value = "";
      const item = { original_name: editingName.value || "", name: draft.name.trim(), url: draft.url.trim(), auth_token: draft.auth_token.trim() };
      const values = props.endpoints.map((endpoint) => ({ original_name: endpoint.name, name: endpoint.name, url: endpoint.url, auth_token: "" }));
      if (editingName.value === null) values.push(item);
      else {
        const index = values.findIndex((endpoint) => endpoint.name === editingName.value);
        if (index < 0) {
          editorError.value = t("remote_agent_missing");
          return;
        }
        values.splice(index, 1, item);
      }
      emit("save", values, (error) => {
        if (error) {
          editorError.value = error;
          return;
        }
        // Saved: the pane stays on the agent, now as it is stored.
        editingName.value = item.name;
        Object.assign(original, { name: item.name, url: item.url });
        Object.assign(draft, { name: item.name, url: item.url, auth_token: "", configured: draft.configured || item.auth_token !== "" });
      });
    }

    function confirmRemove(endpoint) {
      removeError.value = "";
      removeTarget.value = endpoint;
    }

    function remove() {
      if (props.loading || props.saving || !removeTarget.value) return;
      removeError.value = "";
      const values = props.endpoints.filter((item) => item.name !== removeTarget.value.name)
        .map((item) => ({ original_name: item.name, name: item.name, url: item.url, auth_token: "" }));
      emit("save", values, (error) => {
        if (error) {
          removeError.value = error;
          return;
        }
        if (editingName.value === removeTarget.value?.name) editorOpen.value = false;
        removeTarget.value = null;
      });
    }

    watch(editorOpen, (open) => {
      emit("pane-change", open);
      if (!open) {
        draft.auth_token = "";
        editorError.value = "";
      }
    });
    watch([() => props.addRequested, () => props.loading, () => props.saving], ([requested, loading, saving]) => {
      if (!requested || loading || saving) return;
      edit();
      emit("add-opened");
    }, { immediate: true });
    onUnmounted(() => {
      if (editorOpen.value) emit("pane-change", false);
    });

    return { t, rows, editorOpen, editorError, editingName, draft, valid, dirty, paneKey, removeTarget, removeError, edit, save, confirmRemove, remove };
  },
  template: `
    <div class="console-endpoints-section">
      <AppSection variant="boxed" class="config-settings-group console-endpoints-panel is-list" :title="t('remote_agents_title')">
        <template #meta>
          <span class="console-endpoint-count">{{ endpoints.length }}</span>{{ t('remote_agents_note') }}
        </template>
        <template #actions>
          <QButton class="plain xs" :disabled="loading || saving" @click="edit()"><PhPlus class="icon" />{{ t('overview_add_console') }}</QButton>
        </template>
        <div class="console-endpoint-list" :aria-busy="loading || saving">
          <QProgress v-if="loading" :infinite="true" />
          <p v-else-if="!rows.length" class="console-endpoint-empty">{{ t('remote_agents_empty') }}</p>
          <div
            v-for="endpoint in rows"
            :key="endpoint.name"
            class="console-endpoint-row"
            :class="{ 'is-active': editorOpen && editingName === endpoint.name }"
          >
            <button
              type="button"
              class="console-endpoint-copy"
              :aria-pressed="editorOpen && editingName === endpoint.name ? 'true' : 'false'"
              :aria-label="t('remote_edit_named', { name: endpoint.name })"
              :disabled="loading || saving"
              @click="edit(endpoint)"
            >
              <span class="console-endpoint-heading"><strong>{{ endpoint.name }}</strong>
                <span class="console-endpoint-status"><QBadge dot :type="endpoint.status === 'online' ? 'success' : endpoint.status === 'offline' ? 'danger' : 'default'" size="sm" />{{ t('remote_status_' + endpoint.status) }}</span>
              </span>
              <code class="console-endpoint-url">{{ endpoint.url }}</code>
            </button>
          </div>
        </div>
      </AppSection>

      <Teleport :to="paneTarget || 'body'" :disabled="!paneTarget || mobile" defer>
        <AppSidePane
          :open="editorOpen"
          :sheet="mobile"
          :paneKey="paneKey"
          :label="t(editingName === null ? 'overview_add_console' : 'remote_edit_agent')"
          @close="editorOpen = false"
        >
          <AppSection class="is-literal" :title="editingName === null ? t('overview_add_console') : editingName">
            <template #actions>
              <QButton class="plain xs icon" :title="t('settings_channel_close')" :aria-label="t('settings_channel_close')" @click="editorOpen = false">
                <PhX class="icon" />
              </QButton>
            </template>
            <div class="settings-panel-body">
              <div class="settings-form-grid console-endpoint-form" @keyup.enter="save">
                <label class="settings-field is-wide"><span class="settings-field-label">{{ t('remote_agent_name') }}</span><QInput v-model="draft.name" :disabled="saving" /></label>
                <label class="settings-field is-wide"><span class="settings-field-label">Runtime API URL</span><QInput v-model="draft.url" placeholder="https://agent.example.com/runtime" :disabled="saving" /></label>
                <label class="settings-field is-wide">
                  <span class="settings-field-label">{{ t('remote_access_token') }}</span>
                  <SecretInput v-model="draft.auth_token" :status="{ configured: draft.configured }" :placeholder="t('remote_token_required')" :disabled="saving" />
                  <span class="settings-field-note">{{ t('remote_token_note') }}</span>
                </label>
              </div>
              <div v-if="editingName !== null" class="console-endpoint-pane-actions">
                <QButton class="outlined danger" :disabled="loading || saving" @click="confirmRemove(endpoints.find((item) => item.name === editingName))">
                  <PhTrash class="icon" />
                  {{ t('remote_remove_agent') }}
                </QButton>
              </div>
            </div>
          </AppSection>
          <template v-if="dirty || editingName === null || editorError" #foot>
            <p class="app-side-pane-foot-text" :class="{ 'is-error': editorError }" role="status">
              {{ editorError || (dirty ? t('settings_channel_unsaved_note') : '') }}
            </p>
            <QButton class="primary" :loading="saving" :disabled="loading || saving || !valid || (!dirty && editingName !== null)" @click="save">
              {{ t('action_save') }}
            </QButton>
          </template>
        </AppSidePane>
      </Teleport>

      <QDialog :modelValue="!!removeTarget" :persistent="saving" width="460px" @update:modelValue="!$event && !saving && (removeTarget = null)">
        <template #header><header class="setting-dialog-header"><h3 class="setting-dialog-title">{{ t('remote_remove_agent') }}</h3></header></template>
        <section class="setting-dialog">
          <div class="setting-dialog-scroll console-endpoint-remove-copy">
            <p>{{ t('remote_remove_confirm', { name: removeTarget?.name || '' }) }}</p>
            <p v-if="removeError" class="console-endpoint-error" role="alert">{{ removeError }}</p>
          </div>
          <footer class="setting-dialog-actions">
            <QButton class="outlined" :disabled="saving" @click="removeTarget = null">{{ t('action_cancel') }}</QButton>
            <QButton class="danger" :loading="saving" :disabled="saving" @click="remove">{{ t('remote_remove_agent') }}</QButton>
          </footer>
        </section>
      </QDialog>
    </div>
  `,
};
