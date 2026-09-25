import { computed, getCurrentInstance, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { buildConfigUpdate, createConfigDraft } from "../core/config-fields";
import SettingSelect from "./SettingSelect";
import SettingChoices from "./SettingChoices";

export default {
  name: "ConfigSettingsPanel",
  components: { SettingSelect, SettingChoices },
  props: {
    groups: { type: Array, default: () => [] },
    values: { type: Object, default: () => ({}) },
    fieldStates: { type: Object, default: () => ({}) },
    loading: { type: Boolean, default: false },
    saving: { type: Boolean, default: false },
    embedded: { type: Boolean, default: false },
    hideSingleGroupHeading: { type: Boolean, default: false },
    savePlacement: { type: String, default: "header" },
    // Group id -> note. A listed group is shown dimmed and read-only, with the note explaining why.
    inactiveGroups: { type: Object, default: () => ({}) },
    // When set ("agent", "console" or "system") and a settings save registry is provided, the panel
    // hands its changes to the section save bar instead of showing its own Save button.
    saveScope: { type: String, default: "" },
  },
  emits: ["save", "update:dirty"],
  setup(props, { emit }) {
    const saveRegistry = inject("settingsSaveRegistry", null);
    const registered = computed(() => Boolean(saveRegistry && props.saveScope));
    const draft = reactive({});
    const original = ref({});
    const reset = reactive({});
    const validationError = ref("");
    const fields = computed(() => props.groups.flatMap((group) => Array.isArray(group.fields) ? group.fields : []));

    function replaceDraft() {
      const next = createConfigDraft(props.values, fields.value);
      for (const key of Object.keys(draft)) {
        delete draft[key];
      }
      Object.assign(draft, next);
      original.value = { ...next };
      for (const key of Object.keys(reset)) {
        delete reset[key];
      }
      validationError.value = "";
    }

    watch(() => props.values, replaceDraft, { deep: true, immediate: true });
    watch(fields, replaceDraft);

    const dirty = computed(() => {
      if (Object.keys(reset).some((path) => reset[path])) {
        return true;
      }
      return fields.value.some((field) => !Object.is(draft[field.path], original.value[field.path]));
    });

    watch(dirty, (value) => emit("update:dirty", value));

    function stateFor(field) {
      return props.fieldStates?.[field.path] || {};
    }

    const fieldsByPath = computed(() => new Map(fields.value.map((field) => [field.path, field])));

    // A field with dependsOn is inactive while that switch is off in the current draft, so the
    // state follows the switch immediately, before anything is saved.
    function fieldInactive(field) {
      return Boolean(field.dependsOn) && !draft[field.dependsOn];
    }

    function dependencyNote(field) {
      const parent = fieldsByPath.value.get(field.dependsOn);
      return `Turn on ${parent?.label || field.dependsOn} to change this.`;
    }

    function groupInactiveNote(group) {
      return props.inactiveGroups?.[group.id] || "";
    }

    function fieldDisabled(field, group = null) {
      return (
        props.loading ||
        props.saving ||
        stateFor(field).editable === false ||
        fieldInactive(field) ||
        Boolean(group && groupInactiveNote(group))
      );
    }

    function restartRequired(field) {
      const mode = stateFor(field).apply_mode;
      return mode === "runtime_restart" || mode === "process_restart";
    }

    function updateField(field, value) {
      draft[field.path] = value;
      delete reset[field.path];
      validationError.value = "";
    }

    function resetField(field) {
      reset[field.path] = true;
      validationError.value = "";
    }

    function environmentManaged(field) {
      const source = stateFor(field).source;
      return source === "environment_override" || source === "config_env_ref";
    }

    function environmentManagedName(field) {
      return stateFor(field).env_name || "Environment variable";
    }

    function showClear(field) {
      const state = stateFor(field);
      return field.secret === true && state.explicit === true && state.editable !== false;
    }

    function sourceLabel(field) {
      const state = stateFor(field);
      if (state.source === "runtime_override") return "Managed by a command-line flag";
      if (state.source === "config_aws_ref") return "AWS Secrets Manager reference";
      if (state.source === "config_os_ref") return "System secret store";
      return "";
    }

    function inputType(field) {
      if (field.secret) return "password";
      if (field.type === "int" || field.type === "float") return "number";
      return "text";
    }

    // Validated changes for the section save bar: null when there is nothing to save. Throws (and
    // shows the error in the panel) when a value is invalid.
    function collectUpdate() {
      if (!dirty.value) {
        return null;
      }
      try {
        const update = buildConfigUpdate(
          draft,
          original.value,
          Object.keys(reset).filter((path) => reset[path]),
          fields.value,
        );
        validationError.value = "";
        return update;
      } catch (error) {
        validationError.value = error?.message || "Invalid setting";
        throw error;
      }
    }

    const registryKey = `config-panel-${getCurrentInstance()?.uid ?? Math.random()}`;
    onMounted(() => {
      if (registered.value) {
        saveRegistry.register({
          key: registryKey,
          scope: props.saveScope,
          label: () => props.groups[0]?.title || "Settings",
          dirty: () => dirty.value,
          collectUpdate,
        });
      }
    });
    onBeforeUnmount(() => {
      if (registered.value) {
        saveRegistry.unregister(registryKey);
      }
    });

    function save() {
      try {
        const update = buildConfigUpdate(
          draft,
          original.value,
          Object.keys(reset).filter((path) => reset[path]),
          fields.value,
        );
        validationError.value = "";
        emit("save", update);
      } catch (error) {
        validationError.value = error?.message || "Invalid setting";
      }
    }

    return {
      draft,
      validationError,
      dirty,
      stateFor,
      fieldDisabled,
      fieldInactive,
      dependencyNote,
      groupInactiveNote,
      restartRequired,
      updateField,
      resetField,
      environmentManaged,
      environmentManagedName,
      showClear,
      sourceLabel,
      inputType,
      registered,
      collectUpdate,
      save,
    };
  },
  template: `
    <div class="config-settings-panel">
      <QProgress v-if="loading" :infinite="true" />
      <div v-if="validationError" class="config-settings-error" role="alert">{{ validationError }}</div>

      <component
        :is="embedded ? 'section' : 'QCard'"
        v-for="group in groups"
        :key="group.id"
        :variant="embedded ? undefined : 'default'"
        :class="['config-settings-group', { 'is-embedded': embedded, 'is-inactive': groupInactiveNote(group) }]"
      >
        <div class="settings-panel-shell">
          <header
            v-if="!hideSingleGroupHeading || groups.length > 1 || (!registered && savePlacement === 'header' && group === groups[0])"
            class="settings-panel-head"
          >
            <div v-if="!hideSingleGroupHeading || groups.length > 1" class="settings-panel-copy">
              <slot name="heading" :group="group">
                <h3 class="settings-panel-title workspace-document-title">{{ group.title }}</h3>
                <p v-if="group.note" class="settings-panel-meta">{{ group.note }}</p>
              </slot>
            </div>
            <QButton
              v-if="!registered && savePlacement === 'header' && group === groups[0]"
              class="primary"
              :loading="saving"
              :disabled="loading || saving || !dirty"
              @click="save"
            >
              Save
            </QButton>
          </header>

          <p v-if="groupInactiveNote(group)" class="config-settings-inactive-note">{{ groupInactiveNote(group) }}</p>
          <div class="settings-panel-body config-settings-fields">
            <div
              v-for="field in group.fields"
              :key="field.path"
              :class="['settings-field', {
                'is-wide': field.wide || field.type === 'json' || field.type === 'string_list' || field.type === 'bool',
                'is-toggle': field.type === 'bool' && !environmentManaged(field),
                'is-inactive': fieldInactive(field),
              }]"
            >
              <!-- Switches use the same row as the rest of Settings: text on the left, switch on the right. -->
              <template v-if="field.type === 'bool' && !environmentManaged(field)">
                <div class="settings-toggle-copy">
                  <strong class="settings-toggle-title">{{ field.label }}</strong>
                  <span v-if="field.note" class="settings-toggle-note">{{ field.note }}</span>
                  <span v-if="restartRequired(field)" class="config-settings-restart">Restart required</span>
                </div>
                <QSwitch
                  :modelValue="draft[field.path]"
                  :disabled="fieldDisabled(field, group)"
                  @update:modelValue="updateField(field, $event)"
                />
              </template>
              <template v-else>
              <div class="config-settings-label-row">
                <span class="settings-field-label">{{ field.label }}</span>
                <span v-if="restartRequired(field)" class="config-settings-restart">Restart required</span>
              </div>

              <div v-if="environmentManaged(field)" class="settings-env-managed">
                <code class="settings-env-managed-env">{{ environmentManagedName(field) }}</code>
                <p class="settings-env-managed-body">Managed by the environment variable.</p>
              </div>
              <SettingSelect
                v-else-if="field.type === 'select'"
                :modelValue="draft[field.path]"
                :options="field.options"
                :allowCustom="field.allowCustom"
                :label="field.label"
                :placeholder="field.placeholder || 'Default'"
                :disabled="fieldDisabled(field, group)"
                @update:modelValue="updateField(field, $event)"
              />
              <SettingChoices
                v-else-if="field.type === 'string_list' && field.options"
                :modelValue="draft[field.path].split(/\\r?\\n/).map(item => item.trim()).filter(Boolean)"
                :options="field.options"
                :label="field.label"
                :disabled="fieldDisabled(field, group)"
                @update:modelValue="updateField(field, $event.join('\\n'))"
              />
              <QTextarea
                v-else-if="field.type === 'string_list' || field.type === 'json'"
                :modelValue="draft[field.path]"
                :rows="field.type === 'json' ? 7 : 4"
                :class="{ 'config-settings-json': field.type === 'json' }"
                :placeholder="field.placeholder || ''"
                :disabled="fieldDisabled(field, group)"
                @update:modelValue="updateField(field, $event)"
              />
              <QInput
                v-else
                :modelValue="draft[field.path]"
                :inputType="inputType(field)"
                :placeholder="field.secret && stateFor(field).configured ? 'Configured — enter a new value to replace' : field.placeholder || ''"
                :disabled="fieldDisabled(field, group)"
                @update:modelValue="updateField(field, $event)"
              />

              <p v-if="fieldInactive(field)" class="settings-field-note config-settings-dependency-note">{{ dependencyNote(field) }}</p>
              <p v-else-if="field.note" class="settings-field-note">{{ field.note }}</p>
              <div v-if="sourceLabel(field) || showClear(field)" class="config-settings-field-meta">
                <span v-if="sourceLabel(field)">{{ sourceLabel(field) }}</span>
                <span v-else></span>
                <QButton
                  v-if="showClear(field)"
                  class="plain xs"
                  :disabled="loading || saving"
                  @click="resetField(field)"
                >Clear</QButton>
              </div>
              </template>
            </div>
          </div>
        </div>
      </component>

      <div v-if="!registered && savePlacement === 'footer'" class="config-settings-actions">
        <QButton class="primary" :loading="saving" :disabled="loading || saving || !dirty" @click="save">
          Save
        </QButton>
      </div>
    </div>
  `,
};
