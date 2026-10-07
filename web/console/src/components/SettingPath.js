import { computed, inject, ref } from "vue";
import FolderBrowserDialog from "./FolderBrowserDialog";
import { translate } from "../core/context";
import "./SettingFields.css";

// A folder path in one box, with Browse at its end. Browse opens the folder browser on the
// endpoint whose settings these are, so a picked folder is a path that endpoint can use; it shows
// only where the settings page offers that endpoint.
export default {
  components: { FolderBrowserDialog },
  props: {
    modelValue: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, default: "" },
    placeholder: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const browseEndpointRef = inject("settingsBrowseEndpointRef", ref(""));
    const canBrowse = computed(() => String(browseEndpointRef.value || "").trim() !== "");
    const browsing = ref(false);

    function browse() {
      if (props.disabled || !canBrowse.value) return;
      browsing.value = true;
    }

    function pick(path) {
      emit("update:modelValue", path);
      browsing.value = false;
    }

    return { t: translate, browseEndpointRef, canBrowse, browsing, browse, pick };
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
          <button type="button" class="sf-part" :disabled="disabled" @click="browse">
            <PhFolderOpen class="sf-icon" />
            {{ t("action_browse") }}
          </button>
        </template>
      </div>
      <FolderBrowserDialog
        v-if="browsing"
        :modelValue="browsing"
        :endpointRef="browseEndpointRef"
        :title="label"
        :initialPath="modelValue"
        :confirmLabel="t('action_choose')"
        @close="browsing = false"
        @confirm="pick"
      />
    </div>
  `,
};
