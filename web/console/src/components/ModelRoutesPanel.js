import { computed, getCurrentInstance, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import {
  ROUTE_MODE_DEFAULT,
  ROUTE_MODE_PROFILE,
  ROUTE_MODE_SPLIT,
  ROUTE_PURPOSES,
  percentWeights,
  routeFromValue,
  routeIsUnset,
  routeProblems,
  routeTargets,
  routeToValue,
} from "../core/model-routes";
import SettingChoices from "./SettingChoices";
import SettingSelect from "./SettingSelect";
import "./ModelRoutesPanel.css";

const MODES = [
  { value: ROUTE_MODE_DEFAULT, title: "Default" },
  { value: ROUTE_MODE_PROFILE, title: "One profile" },
  { value: ROUTE_MODE_SPLIT, title: "Split" },
];

function cloneRoute(route) {
  return {
    mode: route.mode,
    profile: route.profile,
    candidates: route.candidates.map((item) => ({ ...item })),
    fallbacks: [...route.fallbacks],
  };
}

// Model routes (llm.routes.*): which profile handles each kind of work, as a list of routes with a
// one-line summary each, edited in place. Unset routes use the default profile.
export default {
  name: "ModelRoutesPanel",
  components: { SettingChoices, SettingSelect },
  props: {
    values: { type: Object, default: () => ({}) },
    fieldStates: { type: Object, default: () => ({}) },
    // [{ title, value, note }], "default" first.
    profiles: { type: Array, default: () => [] },
    loading: { type: Boolean, default: false },
    saving: { type: Boolean, default: false },
    saveScope: { type: String, default: "" },
  },
  emits: ["save", "update:dirty"],
  setup(props, { emit }) {
    const saveRegistry = inject("settingsSaveRegistry", null);
    const registered = computed(() => Boolean(saveRegistry && props.saveScope));
    const draft = reactive({});
    const original = ref({});
    const open = ref("");
    const validationError = ref("");

    function replaceDraft() {
      const next = {};
      for (const purpose of ROUTE_PURPOSES) {
        next[purpose.key] = routeFromValue(props.values?.[purpose.path]);
      }
      for (const key of Object.keys(draft)) {
        delete draft[key];
      }
      for (const [key, route] of Object.entries(next)) {
        draft[key] = cloneRoute(route);
      }
      original.value = Object.fromEntries(Object.entries(next).map(([key, route]) => [key, JSON.stringify(routeToValue(route))]));
      validationError.value = "";
    }

    watch(() => props.values, replaceDraft, { deep: true, immediate: true });

    const knownProfiles = computed(() => props.profiles.map((item) => item.value));
    const profileNames = computed(() => knownProfiles.value.filter(Boolean));

    function changed(purpose) {
      return JSON.stringify(routeToValue(draft[purpose.key])) !== original.value[purpose.key];
    }

    const dirty = computed(() => ROUTE_PURPOSES.some(changed));
    watch(dirty, (value) => emit("update:dirty", value));

    // Legacy routes are shown only while set, so an old config stays visible and editable.
    const purposes = computed(() =>
      ROUTE_PURPOSES.filter((purpose) => !purpose.legacy || !routeIsUnset(routeFromValue(props.values?.[purpose.path])))
    );

    function problems(purpose) {
      return routeProblems(draft[purpose.key], knownProfiles.value.length ? knownProfiles.value : null);
    }

    function stateFor(purpose) {
      return props.fieldStates?.[purpose.path] || {};
    }

    function disabled(purpose) {
      return props.loading || props.saving || stateFor(purpose).editable === false;
    }

    function summary(purpose) {
      const route = draft[purpose.key];
      return routeTargets(route);
    }

    function setMode(purpose, mode) {
      const route = draft[purpose.key];
      route.mode = mode;
      if (mode === ROUTE_MODE_PROFILE && !route.profile) {
        route.profile = route.candidates[0]?.profile || "";
      }
      if (mode === ROUTE_MODE_SPLIT && !route.candidates.length) {
        route.candidates = [
          { profile: route.profile || "default", weight: 50 },
          { profile: "", weight: 50 },
        ];
      }
      validationError.value = "";
    }

    // Splits are edited as whole percentages that always add up to 100.
    function percent(purpose, index) {
      return percentWeights(draft[purpose.key].candidates)[index];
    }

    function setPercent(purpose, index, raw) {
      const route = draft[purpose.key];
      const value = Math.max(1, Math.min(99, Math.round(Number(raw) || 0)));
      const others = route.candidates.length - 1;
      if (others <= 0) {
        route.candidates[0].weight = 100;
        return;
      }
      const current = percentWeights(route.candidates);
      const rest = current.reduce((sum, weight, i) => (i === index ? sum : sum + weight), 0);
      const left = 100 - value;
      const scaled = route.candidates.map((_, i) => (i === index ? value : rest > 0 ? (current[i] / rest) * left : left / others));
      route.candidates.forEach((item, i) => {
        item.weight = scaled[i];
      });
      const whole = percentWeights(route.candidates);
      route.candidates.forEach((item, i) => {
        item.weight = Math.max(1, whole[i]);
      });
    }

    // A new profile gets an equal share; the others shrink in proportion.
    function addShare(purpose) {
      const route = draft[purpose.key];
      const share = Math.round(100 / (route.candidates.length + 1));
      const current = percentWeights(route.candidates);
      route.candidates.forEach((item, i) => {
        item.weight = (current[i] * (100 - share)) / 100;
      });
      route.candidates.push({ profile: "", weight: share });
      const whole = percentWeights(route.candidates);
      route.candidates.forEach((item, i) => {
        item.weight = Math.max(1, whole[i]);
      });
    }

    function removeShare(purpose, index) {
      const route = draft[purpose.key];
      route.candidates.splice(index, 1);
      if (!route.candidates.length) {
        route.mode = ROUTE_MODE_DEFAULT;
      }
    }

    function resetRoute(purpose) {
      draft[purpose.key] = routeFromValue(null);
    }

    function toggle(purpose) {
      open.value = open.value === purpose.key ? "" : purpose.key;
    }

    function buildUpdate() {
      const changes = {};
      const errors = [];
      for (const purpose of ROUTE_PURPOSES) {
        if (!changed(purpose)) {
          continue;
        }
        const found = problems(purpose);
        if (found.length) {
          errors.push(`${purpose.label}: ${found.join(" ")}`);
          continue;
        }
        changes[purpose.path] = routeToValue(draft[purpose.key]);
      }
      if (errors.length) {
        throw new Error(errors.join(" "));
      }
      return { config_changes: changes, reset: [] };
    }

    function collectUpdate() {
      if (!dirty.value) {
        return null;
      }
      try {
        const update = buildUpdate();
        validationError.value = "";
        return update;
      } catch (error) {
        validationError.value = error?.message || "Invalid route";
        throw error;
      }
    }

    function save() {
      try {
        const update = buildUpdate();
        validationError.value = "";
        emit("save", update);
      } catch (error) {
        validationError.value = error?.message || "Invalid route";
      }
    }

    const registryKey = `model-routes-${getCurrentInstance()?.uid ?? Math.random()}`;
    onMounted(() => {
      if (registered.value) {
        saveRegistry.register({ key: registryKey, scope: props.saveScope, label: () => "Model routes", dirty: () => dirty.value, collectUpdate });
      }
    });
    onBeforeUnmount(() => {
      if (registered.value) {
        saveRegistry.unregister(registryKey);
      }
    });

    return {
      MODES,
      ROUTE_MODE_PROFILE,
      ROUTE_MODE_SPLIT,
      draft,
      open,
      validationError,
      dirty,
      registered,
      purposes,
      profileNames,
      problems,
      stateFor,
      disabled,
      summary,
      changed,
      setMode,
      percent,
      setPercent,
      addShare,
      removeShare,
      resetRoute,
      toggle,
      save,
    };
  },
  template: `
    <QCard variant="default" class="config-settings-group model-routes-panel">
      <div class="settings-panel-shell">
        <header class="settings-panel-head">
          <div class="settings-panel-copy">
            <h3 class="settings-panel-title workspace-document-title">Model routes</h3>
            <p class="settings-panel-meta">Choose which model profile handles each kind of work. A route left on Default uses the default profile.</p>
          </div>
          <QButton v-if="!registered" class="primary" :loading="saving" :disabled="loading || saving || !dirty" @click="save">Save</QButton>
        </header>
        <div v-if="validationError" class="config-settings-error" role="alert">{{ validationError }}</div>

        <ul class="model-routes-list">
          <li v-for="purpose in purposes" :key="purpose.key" :class="['model-route', { 'is-open': open === purpose.key }]">
            <div class="model-route-row">
              <div class="model-route-copy">
                <strong class="model-route-label">
                  {{ purpose.label }}
                  <span v-if="purpose.legacy" class="model-route-tag">Legacy</span>
                  <span v-if="changed(purpose)" class="model-route-tag is-changed">Unsaved</span>
                </strong>
                <span class="model-route-note">{{ purpose.note }}</span>
              </div>
              <div class="model-route-summary" :aria-label="purpose.label + ' route'">
                <span v-for="(target, index) in summary(purpose)" :key="index" class="model-route-target">
                  <code>{{ target.profile || '?' }}</code>
                  <span v-if="summary(purpose).length > 1" class="model-route-share">{{ target.share }}%</span>
                </span>
                <span v-if="draft[purpose.key].fallbacks.length" class="model-route-fallbacks">
                  then {{ draft[purpose.key].fallbacks.join(' → ') }}
                </span>
              </div>
              <QButton
                class="plain xs"
                :disabled="disabled(purpose)"
                :aria-expanded="open === purpose.key ? 'true' : 'false'"
                @click="toggle(purpose)"
              >{{ open === purpose.key ? 'Done' : 'Edit' }}</QButton>
            </div>

            <p v-if="stateFor(purpose).editable === false" class="settings-field-note">This route is managed outside the settings file.</p>
            <p v-if="problems(purpose).length" class="model-route-problems" role="alert">{{ problems(purpose).join(' ') }}</p>

            <div v-if="open === purpose.key" class="model-route-editor">
              <div class="model-route-modes" role="radiogroup" :aria-label="purpose.label">
                <button
                  v-for="mode in MODES"
                  :key="mode.value"
                  type="button"
                  role="radio"
                  :aria-checked="draft[purpose.key].mode === mode.value ? 'true' : 'false'"
                  :class="['model-route-mode', { 'is-active': draft[purpose.key].mode === mode.value }]"
                  :disabled="disabled(purpose)"
                  @click="setMode(purpose, mode.value)"
                >{{ mode.title }}</button>
              </div>

              <div v-if="draft[purpose.key].mode === ROUTE_MODE_PROFILE" class="model-route-field">
                <span class="settings-field-label">Profile</span>
                <SettingSelect
                  :modelValue="draft[purpose.key].profile"
                  :options="profiles"
                  label="Profile"
                  placeholder="Choose a profile"
                  :disabled="disabled(purpose)"
                  @update:modelValue="draft[purpose.key].profile = $event"
                />
              </div>

              <div v-else-if="draft[purpose.key].mode === ROUTE_MODE_SPLIT" class="model-route-field">
                <span class="settings-field-label">Split requests between</span>
                <div class="model-route-bar" aria-hidden="true">
                  <span
                    v-for="(item, index) in draft[purpose.key].candidates"
                    :key="'bar:' + index"
                    class="model-route-bar-part"
                    :style="{ flexGrow: percent(purpose, index) }"
                  >{{ item.profile || '?' }}</span>
                </div>
                <div v-for="(item, index) in draft[purpose.key].candidates" :key="'share:' + index" class="model-route-share-row">
                  <SettingSelect
                    :modelValue="item.profile"
                    :options="profiles"
                    :label="'Share ' + (index + 1)"
                    placeholder="Choose a profile"
                    :disabled="disabled(purpose)"
                    @update:modelValue="item.profile = $event"
                  />
                  <label class="model-route-percent">
                    <input
                      class="model-route-percent-input"
                      type="number"
                      min="1"
                      max="99"
                      step="1"
                      :value="percent(purpose, index)"
                      :aria-label="'Share ' + (index + 1) + ' percent'"
                      :disabled="disabled(purpose) || draft[purpose.key].candidates.length < 2"
                      @change="setPercent(purpose, index, $event.target.value)"
                    />
                    <span aria-hidden="true">%</span>
                  </label>
                  <QButton class="plain xs icon" :aria-label="'Remove share ' + (index + 1)" :disabled="disabled(purpose)" @click="removeShare(purpose, index)">
                    <PhX class="icon" />
                  </QButton>
                </div>
                <QButton class="plain xs model-route-add" :disabled="disabled(purpose)" @click="addShare(purpose)">
                  <PhPlus class="icon" /> Add a profile
                </QButton>
              </div>

              <div class="model-route-field">
                <span class="settings-field-label">If it fails, try in order</span>
                <SettingChoices
                  :modelValue="draft[purpose.key].fallbacks"
                  :options="profileNames"
                  label="Fallback profiles"
                  :disabled="disabled(purpose)"
                  @update:modelValue="draft[purpose.key].fallbacks = $event"
                />
                <p class="settings-field-note">Tried in the order you tick them. Leave empty for no fallback.</p>
              </div>

              <div class="model-route-editor-foot">
                <QButton class="plain xs" :disabled="disabled(purpose)" @click="resetRoute(purpose)">Reset to default</QButton>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </QCard>
  `,
};
