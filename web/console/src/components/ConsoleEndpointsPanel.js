import { computed, reactive, ref, watch } from "vue";
import SettingDialog from "./SettingDialog";
import { translate } from "../core/context";

let endpointKey = 0;

function endpointDraft(item = {}) {
  const name = String(item?.name || "");
  endpointKey += 1;
  return {
    _key: `console-endpoint-${endpointKey}`,
    _originalName: String(item?.original_name || name),
    _configured: item?.auth_token_configured === true,
    name,
    url: String(item?.url || ""),
    auth_token: "",
  };
}

export default {
  name: "ConsoleEndpointsPanel",
  components: { SettingDialog },
  props: {
    endpoints: { type: Array, default: () => [] },
    loading: Boolean,
    saving: Boolean,
    addRequested: Boolean,
  },
  emits: ["save", "add-opened"],
  setup(props, { emit }) {
    const t = translate;
    const draft = reactive([]);
    const addOpen = ref(false);
    const addError = ref("");
    const newEndpoint = reactive(endpointDraft());

    function replaceDraft() {
      draft.splice(0, draft.length, ...props.endpoints.map(endpointDraft));
    }

    watch(() => props.endpoints, replaceDraft, { deep: true, immediate: true });
    watch(addOpen, (open) => {
      if (!open) {
        Object.assign(newEndpoint, endpointDraft());
        addError.value = "";
      }
    });
    watch([() => props.addRequested, () => props.loading], ([requested, loading]) => {
      if (!requested || loading) return;
      add();
      emit("add-opened");
    }, { immediate: true });

    const valid = computed(() => draft.every((item) => {
      if (!item.name.trim() || !item.url.trim()) return false;
      return item._configured || item.auth_token.trim() !== "";
    }));
    const newEndpointValid = computed(() =>
      newEndpoint.name.trim() !== "" && newEndpoint.url.trim() !== "" && newEndpoint.auth_token.trim() !== ""
    );

    function add() {
      if (props.loading || props.saving) return;
      addOpen.value = true;
    }

    function remove(index) {
      draft.splice(index, 1);
    }

    function save(adding = false) {
      if (props.loading || props.saving || !valid.value) return;
      if (adding && !newEndpointValid.value) return;
      if (adding) addError.value = "";
      const items = adding ? [...draft, newEndpoint] : draft;
      emit("save", items.map((item) => ({
        original_name: item._originalName,
        name: item.name.trim(),
        url: item.url.trim(),
        auth_token: item.auth_token.trim(),
      })), adding ? (error) => {
        if (error) addError.value = error;
        else addOpen.value = false;
      } : undefined);
    }

    return { t, draft, valid, addOpen, addError, newEndpoint, newEndpointValid, add, remove, save };
  },
  template: `
    <QCard variant="default" class="config-settings-group">
      <div class="settings-panel-shell">
        <header class="settings-panel-head">
          <div class="settings-panel-copy">
            <h3 class="settings-panel-title workspace-document-title">Remote Morphs</h3>
            <p class="settings-panel-meta">Other Morph instances this Console can control. Each access token must match the remote Morph's incoming access token. New and changed connections are tested before saving, then applied immediately.</p>
          </div>
          <div class="settings-panel-actions">
            <QButton class="primary" :loading="saving" :disabled="loading || saving || !valid" @click="save()">{{ t(saving ? 'settings_endpoints_saving' : 'action_save') }}</QButton>
          </div>
        </header>
        <div class="settings-panel-body settings-collection-list">
          <div v-for="(endpoint, index) in draft" :key="endpoint._key" :data-endpoint-key="endpoint._key" class="settings-collection-item">
            <div class="settings-form-grid">
              <div class="settings-field">
                <span class="settings-field-label">Name</span>
                <QInput v-model="endpoint.name" :disabled="loading || saving" />
              </div>
              <div class="settings-field">
                <span class="settings-field-label">Runtime API URL</span>
                <QInput v-model="endpoint.url" placeholder="https://agent.example.com/runtime" :disabled="loading || saving" />
              </div>
              <div class="settings-field is-wide">
                <span class="settings-field-label">Access token</span>
                <QInput
                  v-model="endpoint.auth_token"
                  inputType="password"
                  :placeholder="endpoint._configured ? 'Configured — enter a new value to replace' : 'Required'"
                  :disabled="loading || saving"
                />
              </div>
            </div>
            <QButton class="plain xs danger" :disabled="loading || saving" @click="remove(index)">Remove</QButton>
          </div>
          <QButton class="placeholder" :disabled="loading || saving" @click="add">{{ t('overview_add_console') }}</QButton>
        </div>
      </div>
    </QCard>

    <SettingDialog
      v-model="addOpen"
      :title="t('overview_add_console')"
      width="520px"
      :saving="saving"
      :saveDisabled="loading || !valid || !newEndpointValid"
      @save="save(true)"
    >
      <div class="settings-form-grid console-endpoint-add-form" @keyup.enter="save(true)">
        <label class="settings-field is-wide">
          <span class="settings-field-label">Name</span>
          <QInput v-model="newEndpoint.name" :disabled="saving" />
        </label>
        <label class="settings-field is-wide">
          <span class="settings-field-label">Runtime API URL</span>
          <QInput v-model="newEndpoint.url" placeholder="https://agent.example.com/runtime" :disabled="saving" />
        </label>
        <label class="settings-field is-wide">
          <span class="settings-field-label">Access token</span>
          <QInput v-model="newEndpoint.auth_token" inputType="password" placeholder="Required" :disabled="saving" />
        </label>
        <p v-if="addError" class="settings-field-note console-endpoint-add-error" role="alert">{{ addError }}</p>
      </div>
    </SettingDialog>
  `,
};
