import { computed, reactive, ref, watch } from "vue";
import SettingDialog from "./SettingDialog";
import { translate } from "../core/context";
import "./ConsoleEndpointsPanel.css";

export default {
  name: "ConsoleEndpointsPanel",
  components: { SettingDialog },
  props: {
    endpoints: { type: Array, default: () => [] },
    runtimeEndpoints: { type: Array, default: () => [] },
    loading: Boolean,
    saving: Boolean,
    addRequested: Boolean,
  },
  emits: ["save", "add-opened"],
  setup(props, { emit }) {
    const t = translate;
    const editorOpen = ref(false);
    const editorError = ref("");
    const editingName = ref(null);
    const draft = reactive({ name: "", url: "", auth_token: "", configured: false });
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
      editingName.value = endpoint?.name ?? null;
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
        if (error) editorError.value = error;
        else editorOpen.value = false;
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
        if (error) removeError.value = error;
        else removeTarget.value = null;
      });
    }

    watch(editorOpen, (open) => {
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

    return { t, rows, editorOpen, editorError, editingName, draft, valid, removeTarget, removeError, edit, save, confirmRemove, remove };
  },
  template: `
    <div class="console-endpoints-section">
      <QCard variant="default" class="config-settings-group console-endpoints-panel">
        <div class="settings-panel-shell">
          <header class="settings-panel-head">
            <div class="settings-panel-copy">
              <h3 class="settings-panel-title workspace-document-title">{{ t('remote_agents_title') }} <span class="console-endpoint-count">{{ endpoints.length }}</span></h3>
              <p class="settings-panel-meta">{{ t('remote_agents_note') }}</p>
            </div>
            <div class="settings-panel-actions">
              <QButton class="primary" :disabled="loading || saving" @click="edit()"><PhPlus class="icon" />{{ t('overview_add_console') }}</QButton>
            </div>
          </header>
          <div class="console-endpoint-list" :aria-busy="loading || saving">
            <QProgress v-if="loading" :infinite="true" />
            <p v-else-if="!rows.length" class="console-endpoint-empty">{{ t('remote_agents_empty') }}</p>
            <div v-for="endpoint in rows" :key="endpoint.name" class="console-endpoint-row">
              <div class="console-endpoint-copy">
                <div class="console-endpoint-heading"><strong>{{ endpoint.name }}</strong>
                  <span class="console-endpoint-status"><QBadge dot :type="endpoint.status === 'online' ? 'success' : endpoint.status === 'offline' ? 'danger' : 'default'" size="sm" />{{ t('remote_status_' + endpoint.status) }}</span>
                </div>
                <code class="console-endpoint-url">{{ endpoint.url }}</code>
              </div>
              <div class="console-endpoint-actions">
                <QButton class="outlined sm" :disabled="loading || saving" :aria-label="t('remote_edit_named', { name: endpoint.name })" @click="edit(endpoint)"><PhPencilSimple class="icon" />{{ t('action_edit') }}</QButton>
                <QButton class="plain sm icon" :disabled="loading || saving" :title="t('remote_remove_named', { name: endpoint.name })" :aria-label="t('remote_remove_named', { name: endpoint.name })" @click="confirmRemove(endpoint)"><PhTrash class="icon" /></QButton>
              </div>
            </div>
          </div>
        </div>
      </QCard>

      <SettingDialog v-model="editorOpen" :title="t(editingName === null ? 'overview_add_console' : 'remote_edit_agent')"
        width="520px" :saving="saving" :saveDisabled="loading || !valid" @save="save">
        <div class="settings-form-grid console-endpoint-form" @keyup.enter="save">
          <label class="settings-field is-wide"><span class="settings-field-label">{{ t('remote_agent_name') }}</span><QInput v-model="draft.name" :disabled="saving" /></label>
          <label class="settings-field is-wide"><span class="settings-field-label">Runtime API URL</span><QInput v-model="draft.url" placeholder="https://agent.example.com/runtime" :disabled="saving" /></label>
          <label class="settings-field is-wide">
            <span class="settings-field-label">{{ t('remote_access_token') }}</span>
            <QInput v-model="draft.auth_token" inputType="password" :placeholder="t(draft.configured ? 'remote_token_keep' : 'remote_token_required')" :disabled="saving" />
            <span class="settings-field-note">{{ t('remote_token_note') }}</span>
          </label>
          <p v-if="editorError" class="settings-field-note console-endpoint-error" role="alert">{{ editorError }}</p>
        </div>
      </SettingDialog>

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
