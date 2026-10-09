import { computed, getCurrentInstance, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { buildConfigUpdate, createConfigDraft } from "../core/config-fields";
import SettingSelect from "./SettingSelect";
import SettingChoices from "./SettingChoices";
import SettingBytes from "./SettingBytes";
import SettingDuration from "./SettingDuration";
import SettingLimit from "./SettingLimit";
import SettingPath from "./SettingPath";
import SettingPercent from "./SettingPercent";
import SettingRows from "./SettingRows";
import EnvManagedField from "./EnvManagedField";
import SecretInput from "./SecretInput";

export default {
  name: "ConfigSettingsPanel",
  components: {
    EnvManagedField,
    SecretInput,
    SettingSelect,
    SettingChoices,
    SettingBytes,
    SettingDuration,
    SettingLimit,
    SettingPath,
    SettingPercent,
    SettingRows,
  },
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
    // Field paths not shown right now. Their drafts are kept, so hiding a field loses no edit.
    hiddenPaths: { type: Array, default: () => [] },
  },
  emits: ["save", "update:dirty"],
  setup(props, { emit }) {
    const saveRegistry = inject("settingsSaveRegistry", null);
    const registered = computed(() => Boolean(saveRegistry && props.saveScope));
    const showHeading = computed(() => !props.hideSingleGroupHeading || props.groups.length > 1);
    const draft = reactive({});
    const original = ref({});
    const reset = reactive({});
    const validationError = ref("");
    const fields = computed(() => props.groups.flatMap((group) => Array.isArray(group.fields) ? group.fields : []));

    // A clearable field that is not set in the config reads as empty, not as its zero value
    // (an unset temperature is "provider default", not 0).
    function effectiveValues() {
      const values = { ...(props.values || {}) };
      for (const field of fields.value) {
        if (field.clearable && props.fieldStates?.[field.path]?.explicit !== true) {
          values[field.path] = "";
        }
      }
      return values;
    }

    function replaceDraft() {
      const next = createConfigDraft(effectiveValues(), fields.value);
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
    // Reset only when the set of fields changes. Callers often pass groups inline (:groups="[group]"),
    // which makes a new array on every parent render; watching the array itself wiped edits as soon as
    // the save bar appeared.
    watch(() => fields.value.map((field) => field.path).join("\n"), replaceDraft);

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

    // A field with dependsOn is inactive while that switch, or any switch it depends on in turn, is
    // off in the current draft, so the state follows the switch immediately, before anything is saved.
    // Returns the outermost switch that is off (the one to turn on first), or "" when the field is active.
    function blockingSwitch(field) {
      const seen = new Set();
      let blocking = "";
      for (let path = field.dependsOn; path && !seen.has(path); path = fieldsByPath.value.get(path)?.dependsOn) {
        seen.add(path);
        if (!draft[path]) blocking = path;
      }
      return blocking;
    }

    function fieldInactive(field) {
      return Boolean(blockingSwitch(field));
    }

    function dependencyNote(field) {
      const path = blockingSwitch(field);
      const parent = fieldsByPath.value.get(path);
      return `Turn on ${parent?.label || path} to change this.`;
    }

    function visibleFields(group) {
      const hidden = new Set(props.hiddenPaths);
      return (Array.isArray(group.fields) ? group.fields : []).filter((field) => !hidden.has(field.path));
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
      // A cleared non-secret field shows empty, so its placeholder ("Provider default") explains the result.
      if (field.clearable) {
        draft[field.path] = "";
      }
      validationError.value = "";
    }

    function environmentManaged(field) {
      const source = stateFor(field).source;
      return source === "environment_override" || source === "config_env_ref";
    }

    function environmentManagedName(field) {
      return stateFor(field).env_name || "Environment variable";
    }

    // Secrets, and fields whose empty value means "use the default", can be cleared from the config.
    function showClear(field) {
      const state = stateFor(field);
      return (field.secret === true || field.clearable === true) && state.explicit === true && state.editable !== false;
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
      visibleFields,
      restartRequired,
      updateField,
      resetField,
      environmentManaged,
      environmentManagedName,
      showClear,
      sourceLabel,
      inputType,
      registered,
      showHeading,
      collectUpdate,
      save,
    };
  },
  template: `
    <div class="config-settings-panel">
      <QProgress v-if="loading" :infinite="true" />
      <div v-if="validationError" class="config-settings-error" role="alert">{{ validationError }}</div>

      <AppSection
        v-for="group in groups"
        :key="group.id"
        :variant="embedded ? 'plain' : 'boxed'"
        :title="showHeading ? group.title : ''"
        :meta="showHeading ? group.note || '' : ''"
        :class="['config-settings-group', { 'is-embedded': embedded, 'is-inactive': groupInactiveNote(group) }]"
      >
        <template v-if="!registered && savePlacement === 'header' && group === groups[0]" #actions>
          <QButton
            class="plain xs"
            :loading="saving"
            :disabled="loading || saving || !dirty"
            @click="save"
          >
            Save
          </QButton>
        </template>

        <p v-if="groupInactiveNote(group)" class="config-settings-inactive-note">{{ groupInactiveNote(group) }}</p>
        <div class="settings-panel-body config-settings-fields">
          <div
            v-for="field in visibleFields(group)"
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
                <span v-if="fieldInactive(field)" class="settings-toggle-note config-settings-dependency-note">{{ dependencyNote(field) }}</span>
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

            <EnvManagedField v-if="environmentManaged(field)" :name="environmentManagedName(field)" />
            <SettingBytes
              v-else-if="field.editor === 'bytes'"
              :modelValue="draft[field.path]"
              :label="field.label"
              :disabled="fieldDisabled(field, group)"
              @update:modelValue="updateField(field, $event)"
            />
            <SettingDuration
              v-else-if="field.editor === 'duration'"
              :modelValue="draft[field.path]"
              :label="field.label"
              :zeroLabel="field.zeroLabel || ''"
              :disabled="fieldDisabled(field, group)"
              @update:modelValue="updateField(field, $event)"
            />
            <SettingPercent
              v-else-if="field.editor === 'percent'"
              :modelValue="draft[field.path]"
              :label="field.label"
              :disabled="fieldDisabled(field, group)"
              @update:modelValue="updateField(field, $event)"
            />
            <SettingLimit
              v-else-if="field.editor === 'limit'"
              :modelValue="draft[field.path]"
              :label="field.label"
              :defaultLimit="field.defaultLimit || ''"
              :disabled="fieldDisabled(field, group)"
              @update:modelValue="updateField(field, $event)"
            />
            <SettingPath
              v-else-if="field.editor === 'directory'"
              :modelValue="draft[field.path]"
              :label="field.label"
              :placeholder="field.placeholder || ''"
              :disabled="fieldDisabled(field, group)"
              @update:modelValue="updateField(field, $event)"
            />
            <SettingRows
              v-else-if="field.editor === 'rows'"
              :modelValue="draft[field.path]"
              :mode="field.rows || 'list'"
              :platforms="field.platforms || []"
              :label="field.label"
              :placeholder="field.placeholder || ''"
              :addLabel="field.addLabel || 'Add'"
              :disabled="fieldDisabled(field, group)"
              @update:modelValue="updateField(field, $event)"
            >
              <template #fallback>
                <QTextarea
                  :modelValue="draft[field.path]"
                  :rows="7"
                  class="config-settings-json"
                  :disabled="fieldDisabled(field, group)"
                  @update:modelValue="updateField(field, $event)"
                />
              </template>
            </SettingRows>
            <SettingSelect
              v-else-if="field.type === 'select'"
              :modelValue="draft[field.path]"
              :options="field.options"
              :allowCustom="field.allowCustom"
              :customLabel="field.duration ? 'Custom duration' : 'Custom value'"
              :customPlaceholder="field.duration ? 'e.g. 5m or 1h' : ''"
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
            <SecretInput
              v-else-if="field.secret"
              :modelValue="draft[field.path]"
              :status="stateFor(field)"
              :revealPath="field.path"
              :placeholder="field.placeholder || ''"
              :disabled="fieldDisabled(field, group)"
              @update:modelValue="updateField(field, $event)"
            />
            <QInput
              v-else
              :modelValue="draft[field.path]"
              :inputType="inputType(field)"
              :placeholder="field.placeholder || ''"
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
      </AppSection>

      <div v-if="!registered && savePlacement === 'footer'" class="config-settings-actions">
        <QButton class="primary" :loading="saving" :disabled="loading || saving || !dirty" @click="save">
          Save
        </QButton>
      </div>
    </div>
  `,
};
