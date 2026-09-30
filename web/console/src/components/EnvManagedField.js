import { computed, onBeforeUnmount, ref } from "vue";

import { translate } from "../core/context";
import "./EnvManagedField.css";

// A field whose value comes from an environment variable: shown as a locked, read-only input with
// the variable's name (and value, for a field that is not secret). Clicking it copies the name.
const EnvManagedField = {
  props: {
    // "NAME" or "NAME=value".
    name: { type: String, default: "" },
  },
  setup(props) {
    const t = translate;
    const copied = ref(false);
    let timer = null;
    const variable = computed(() => String(props.name || "").split("=")[0].trim());
    const label = computed(() => String(props.name || "").trim() || t("settings_env_managed_tag"));
    const title = computed(() =>
      copied.value
        ? t("settings_env_managed_copied")
        : t("settings_env_managed_title", { name: variable.value || t("settings_env_managed_tag") })
    );

    async function copy() {
      if (!variable.value || typeof navigator === "undefined" || !navigator.clipboard) {
        return;
      }
      try {
        await navigator.clipboard.writeText(variable.value);
      } catch {
        return;
      }
      copied.value = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        copied.value = false;
      }, 1600);
    }

    onBeforeUnmount(() => clearTimeout(timer));

    return { t, copied, label, title, copy };
  },
  template: `
    <button type="button" class="env-managed-field" :class="{ 'is-copied': copied }" :title="title" :aria-label="title" @click="copy">
      <PhLockSimple class="env-managed-field-icon" aria-hidden="true" />
      <code class="env-managed-field-name">{{ label }}</code>
      <span class="env-managed-field-tag">{{ copied ? t("settings_env_managed_copied") : t("settings_env_managed_tag") }}</span>
    </button>
  `,
};

export default EnvManagedField;
