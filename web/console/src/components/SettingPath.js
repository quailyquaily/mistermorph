import { inject, ref } from "vue";
import { pickDesktopDirectory } from "../core/desktop-runtime";
import "./SettingFields.css";

// A folder path in one box, with Browse at its end. Browse only shows in the desktop app while
// editing this machine's settings, where a picked folder is a path the backend can use.
export default {
  props: {
    modelValue: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, default: "" },
    placeholder: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const canBrowse = inject("settingsCanBrowsePaths", ref(false));
    const browsing = ref(false);
    const error = ref("");

    async function browse() {
      if (props.disabled || browsing.value) return;
      browsing.value = true;
      error.value = "";
      try {
        const picked = await pickDesktopDirectory({ title: props.label, current: props.modelValue });
        if (picked) emit("update:modelValue", picked);
      } catch (e) {
        error.value = e?.message || "Could not open the folder picker.";
      } finally {
        browsing.value = false;
      }
    }

    return { canBrowse, browsing, error, browse };
  },
  template: `
    <div class="sf">
      <div class="sf-box" :class="{ 'is-disabled': disabled }">
        <input
          class="sf-input is-mono"
          :value="modelValue"
          :placeholder="placeholder"
          :disabled="disabled"
          :aria-label="label || undefined"
          spellcheck="false"
          autocomplete="off"
          @input="$emit('update:modelValue', $event.target.value)"
        />
        <template v-if="canBrowse">
          <span class="sf-sep" aria-hidden="true"></span>
          <button type="button" class="sf-part" :disabled="disabled || browsing" @click="browse">
            <PhFolderOpen class="sf-icon" />
            {{ browsing ? "Opening…" : "Browse" }}
          </button>
        </template>
      </div>
      <p v-if="error" class="sf-error">{{ error }}</p>
    </div>
  `,
};
