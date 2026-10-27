import { computed, ref, watch } from "vue";

import { translate } from "../core/context";
import { pickerKeys, secretFieldLabel } from "../core/secret-keys";
import { loadSecretInfo, loadSecretKeys, revealSecret } from "../core/secret-reveal";
import "./SettingDialog.css";
import "./SecretKeyPicker.css";

const KIND_ICONS = {
  os: "PhShieldCheck",
  file: "PhWarningCircle",
  env: "PhTerminalWindow",
  aws: "PhCloud",
};

// The secret picker: a dialog listing the keys already in config.yaml, so a field can use one of
// them instead of having the key pasted again. Each key shows a masked hint ("sk-proj-…a1b2"),
// where it is kept and the fields that use it. Picking a key emits its
// reference (${secret:...}, ${ENV}, ...) to put in the field; a key kept in config.yaml as plain
// text has no reference, so it is revealed (asking for the console password when there is one)
// and its value is emitted instead.
//
// currentPath: the config path of the field picking (e.g. "llm.profiles.ears.api_key"); its own
// key is left out. Empty for a field not saved yet, such as a new profile.
const SecretKeyPicker = {
  name: "SecretKeyPicker",
  props: {
    modelValue: { type: Boolean, default: false },
    currentPath: { type: String, default: "" },
  },
  emits: ["update:modelValue", "pick"],
  setup(props, { emit }) {
    const t = translate;
    const loading = ref(false);
    const loadError = ref("");
    const keys = ref([]);
    const info = ref(null);
    const asking = ref("");
    const password = ref("");
    const revealing = ref(false);
    const revealError = ref("");

    const offered = computed(() => pickerKeys(keys.value, props.currentPath));

    async function load() {
      loading.value = true;
      loadError.value = "";
      asking.value = "";
      password.value = "";
      revealError.value = "";
      try {
        const [data, secretInfo] = await Promise.all([loadSecretKeys(), loadSecretInfo()]);
        keys.value = Array.isArray(data?.keys) ? data.keys : [];
        info.value = secretInfo;
      } catch (e) {
        keys.value = [];
        loadError.value = e?.message || t("secret_picker_load_failed");
      } finally {
        loading.value = false;
      }
    }

    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          void load();
        }
      },
      { immediate: true }
    );

    function close() {
      emit("update:modelValue", false);
    }

    function kindLabel(key) {
      if (key.kind === "os" && info.value?.store) {
        return t("secret_store_" + info.value.store);
      }
      return t("secret_tag_" + key.kind);
    }

    // What to recognize a key by: its masked hint, or for a plain-text key too short to show any of
    // it, that it is kept as plain text.
    function hintText(key) {
      if (key.unavailable) {
        return t("secret_picker_unavailable");
      }
      if (key.kind === "file" && (!key.hint || key.hint === "…")) {
        return t("secret_picker_plain_hint");
      }
      return key.hint || "…";
    }

    function usedByText(key) {
      const fields = (key.used_by || []).map((path) => secretFieldLabel(path, t));
      return t("secret_picker_used_by", { fields: fields.join(", ") });
    }

    function pickedPayload(key, value) {
      return {
        value,
        kind: key.kind,
        hint: key.hint || "",
        from: secretFieldLabel((key.used_by || [])[0], t),
      };
    }

    async function reveal(key, event) {
      if (typeof event?.target?.value === "string") {
        password.value = event.target.value;
      }
      revealing.value = true;
      revealError.value = "";
      try {
        const data = await revealSecret(key.reveal_path, password.value);
        const value = String(data?.value ?? "");
        if (!value) {
          throw new Error(t("secret_reveal_failed"));
        }
        emit("pick", pickedPayload(key, value));
        close();
      } catch (e) {
        revealError.value = e?.status === 403 ? t("secret_reveal_wrong_password") : e?.message || t("secret_reveal_failed");
      } finally {
        revealing.value = false;
        password.value = "";
      }
    }

    function choose(key) {
      if (!key || key.unavailable || revealing.value) {
        return;
      }
      if (key.ref) {
        emit("pick", pickedPayload(key, key.ref));
        close();
        return;
      }
      if (info.value?.password_required) {
        asking.value = key.id;
        revealError.value = "";
        return;
      }
      void reveal(key);
    }

    function cancelAsk() {
      asking.value = "";
      password.value = "";
      revealError.value = "";
    }

    return {
      t, loading, loadError, offered, asking, password, revealing, revealError,
      KIND_ICONS, kindLabel, hintText, usedByText, choose, reveal, cancelAsk, close, load,
    };
  },
  template: `
    <AppDialog :modelValue="modelValue" width="480px" @update:modelValue="$emit('update:modelValue', $event)">
      <template #header>
        <header class="setting-dialog-header">
          <h3 class="setting-dialog-title">{{ t("secret_picker_title") }}</h3>
        </header>
      </template>
      <section class="secret-key-picker">
        <p v-if="loading" class="secret-key-picker-note">{{ t("secret_picker_loading") }}</p>
        <p v-else-if="loadError" class="secret-key-picker-error" role="alert">{{ loadError }}</p>
        <p v-else-if="offered.length === 0" class="secret-key-picker-note">{{ t("secret_picker_empty") }}</p>
        <ul v-else class="secret-key-picker-list">
          <li v-for="key in offered" :key="key.id">
            <button
              type="button"
              :class="['secret-key-picker-item', 'is-' + key.kind, { 'is-unavailable': key.unavailable }]"
              :disabled="key.unavailable || revealing"
              @click="choose(key)"
            >
              <span class="secret-key-picker-row">
                <span class="secret-key-picker-hint">{{ hintText(key) }}</span>
                <span class="secret-key-picker-kind">
                  <component :is="KIND_ICONS[key.kind] || 'PhLockSimple'" class="secret-key-picker-icon" aria-hidden="true" />
                  <span>{{ kindLabel(key) }}</span>
                </span>
              </span>
              <span class="secret-key-picker-meta">{{ usedByText(key) }}</span>
            </button>
            <div v-if="asking === key.id" class="secret-key-picker-ask">
              <AppInput
                v-model="password"
                inputType="password"
                :placeholder="t('secret_reveal_password')"
                :disabled="revealing"
                @keydown.enter.prevent="reveal(key, $event)"
                @keydown.esc.prevent.stop="cancelAsk"
              />
              <AppButton class="outlined sm" :loading="revealing" @click="reveal(key)">{{ t("secret_picker_use") }}</AppButton>
              <AppButton class="plain sm" :disabled="revealing" @click="cancelAsk">{{ t("secret_reveal_cancel") }}</AppButton>
            </div>
            <p v-if="asking === key.id && revealError" class="secret-key-picker-error" role="alert">{{ revealError }}</p>
          </li>
        </ul>
        <p v-if="revealError && !asking" class="secret-key-picker-error" role="alert">{{ revealError }}</p>
      </section>
    </AppDialog>
  `,
};

export default SecretKeyPicker;
