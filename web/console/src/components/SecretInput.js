import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from "vue";

import { translate } from "../core/context";
import { loadSecretInfo, revealSecret } from "../core/secret-reveal";
import { secretStorageKind } from "../core/secret-storage";
import SecretKeyPicker from "./SecretKeyPicker";
import "./SecretInput.css";

const KIND_ICONS = {
  os: "PhShieldCheck",
  file: "PhWarningCircle",
  env: "PhTerminalWindow",
  aws: "PhCloud",
  stored: "PhLockSimple",
};

// A shown secret hides itself again after this long.
const REVEAL_MS = 30000;

// A password field for an API key or token. Once a secret is stored it shows as a filled field: the
// value masked, and a small tag naming where it is kept (the system's secret storage, config.yaml
// in plain text, an environment variable, AWS Secrets Manager), with the full explanation in its
// tooltip. The eye shows the stored value (asking for the console password first when it has one);
// the pencil opens an empty field for a new value, and the undo arrow beside it keeps the current one. While typing,
// the eye shows what is typed.
//
// Where a settings page provides "secretPicker" ({ enabled }), the key button opens the secret
// picker to use a key another field already has instead of pasting it again. The picked key then
// shows as its hint and the field it came from, with the undo arrow to drop it.
//
// status: { configured, source, editable }, as the runtime reports a secret field.
// revealPath: the secret's config path (e.g. "llm.api_key"); empty when it cannot be revealed,
// such as a remote runtime's settings.
const SecretInput = {
  name: "SecretInput",
  components: { SecretKeyPicker },
  props: {
    modelValue: { type: String, default: "" },
    status: { type: Object, default: null },
    placeholder: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
    revealPath: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const t = translate;
    const root = ref(null);
    const replacing = ref(false);
    const typedVisible = ref(false);
    const info = ref(null);
    const revealed = ref(null);
    const asking = ref(false);
    const password = ref("");
    const revealing = ref(false);
    const revealError = ref("");
    let hideTimer = 0;
    const secretPicker = inject("secretPicker", null);
    const pickerOpen = ref(false);
    // The key picked from another field: { value, kind, hint, from }, while it is the field's value.
    const picked = ref(null);

    const configured = computed(() => props.status?.configured === true);
    const kind = computed(() => secretStorageKind(props.status?.source));
    const replaceable = computed(() => props.status?.editable !== false && !props.disabled);
    const showStored = computed(() => configured.value && !replacing.value && !String(props.modelValue || ""));
    const icon = computed(() => KIND_ICONS[kind.value]);
    const canPick = computed(() => Boolean(unref(secretPicker?.enabled)) && replaceable.value);
    const showPicked = computed(() => picked.value !== null && String(props.modelValue || "") === picked.value.value);
    const canReveal = computed(() => Boolean(props.revealPath) && info.value?.reveal === true);
    // The system store by name (macOS Keychain, ...) once the console has said which it uses.
    const storeName = computed(() => (kind.value === "os" && info.value?.store ? t("secret_store_" + info.value.store) : ""));
    const tagLabel = computed(() => storeName.value || t("secret_tag_" + kind.value));
    const tooltip = computed(
      () =>
        t("secret_stored_" + kind.value) +
        (storeName.value ? ` (${storeName.value})` : "") +
        ". " +
        t("secret_stored_" + kind.value + "_detail")
    );

    onMounted(async () => {
      info.value = await loadSecretInfo();
    });

    function hide() {
      window.clearTimeout(hideTimer);
      revealed.value = null;
    }

    function resetReveal() {
      hide();
      asking.value = false;
      password.value = "";
      revealError.value = "";
    }

    // A saved or reloaded secret starts from its stored state again.
    watch(
      () => [props.status?.configured, props.status?.source, props.revealPath],
      () => {
        replacing.value = false;
        resetReveal();
      }
    );
    onBeforeUnmount(hide);
    watch(
      () => props.modelValue,
      (value) => {
        if (picked.value && String(value || "") !== picked.value.value) {
          picked.value = null;
        }
      }
    );

    // Enter can come before the last key's keyup, which is when QInput updates its model; read the
    // field itself then.
    async function doReveal(event) {
      if (typeof event?.target?.value === "string") {
        password.value = event.target.value;
      }
      revealing.value = true;
      revealError.value = "";
      try {
        const data = await revealSecret(props.revealPath, password.value);
        revealed.value = String(data?.value ?? "");
        asking.value = false;
        password.value = "";
        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(hide, REVEAL_MS);
      } catch (e) {
        revealError.value = e?.status === 403 ? t("secret_reveal_wrong_password") : e?.message || t("secret_reveal_failed");
      } finally {
        revealing.value = false;
      }
    }

    function toggleReveal() {
      if (revealed.value !== null) {
        hide();
        return;
      }
      if (info.value?.password_required) {
        asking.value = true;
        revealError.value = "";
        nextTick(() => root.value?.querySelector(".secret-input-ask input")?.focus());
        return;
      }
      doReveal();
    }

    function cancelAsk() {
      asking.value = false;
      password.value = "";
      revealError.value = "";
    }

    function replace() {
      resetReveal();
      replacing.value = true;
      nextTick(() => root.value?.querySelector("input")?.focus());
    }

    function openPicker() {
      resetReveal();
      pickerOpen.value = true;
    }

    function pick(payload) {
      picked.value = payload;
      replacing.value = false;
      typedVisible.value = false;
      emit("update:modelValue", payload.value);
    }

    function keepCurrent() {
      replacing.value = false;
      typedVisible.value = false;
      emit("update:modelValue", "");
    }

    return {
      t, root, configured, kind, replaceable, showStored, icon, replacing, typedVisible, canReveal, tagLabel, tooltip,
      revealed, asking, password, revealing, revealError, toggleReveal, doReveal, cancelAsk, replace, keepCurrent,
      canPick, pickerOpen, picked, showPicked, openPicker, pick,
    };
  },
  template: `
    <div ref="root" class="secret-input">
      <div v-if="showPicked" :class="['secret-input-stored', 'is-picked', 'is-' + picked.kind]">
        <span class="secret-input-hint">{{ picked.hint || "…" }}</span>
        <span class="secret-input-tag" :title="t('secret_picker_from', { field: picked.from })">
          <PhKey class="secret-input-icon" aria-hidden="true" />
          <span>{{ t("secret_picker_from", { field: picked.from }) }}</span>
        </span>
        <QButton
          class="plain sm icon secret-input-action"
          :title="t('secret_picker_undo')"
          :aria-label="t('secret_picker_undo')"
          :disabled="disabled"
          @click="keepCurrent"
        >
          <PhArrowCounterClockwise class="icon" />
        </QButton>
      </div>
      <div v-else-if="showStored && asking" class="secret-input-ask">
        <QInput
          v-model="password"
          inputType="password"
          :placeholder="t('secret_reveal_password')"
          :disabled="revealing"
          @keydown.enter.prevent="doReveal($event)"
          @keydown.esc.prevent="cancelAsk"
        />
        <QButton class="outlined sm" :loading="revealing" @click="doReveal()">{{ t("secret_reveal") }}</QButton>
        <QButton class="plain sm" :disabled="revealing" @click="cancelAsk">{{ t("secret_reveal_cancel") }}</QButton>
      </div>
      <div v-else-if="showStored" :class="['secret-input-stored', 'is-' + kind]" :title="tooltip">
        <span v-if="revealed !== null" class="secret-input-value">{{ revealed }}</span>
        <span v-else class="secret-input-mask" aria-hidden="true">••••••••••••</span>
        <span v-if="revealed === null" class="secret-input-tag">
          <component :is="icon" class="secret-input-icon" aria-hidden="true" />
          <span>{{ tagLabel }}</span>
        </span>
        <span class="secret-input-sr">{{ t("secret_stored_" + kind) }}</span>
        <QButton
          v-if="canReveal"
          class="plain sm icon secret-input-action"
          :title="revealed !== null ? t('secret_hide') : t('secret_reveal')"
          :aria-label="revealed !== null ? t('secret_hide') : t('secret_reveal')"
          :aria-pressed="revealed !== null ? 'true' : 'false'"
          :loading="revealing"
          @click="toggleReveal"
        >
          <PhEyeSlash v-if="revealed !== null" class="icon" />
          <PhEye v-else class="icon" />
        </QButton>
        <QButton
          v-if="canPick"
          class="plain sm icon secret-input-action"
          :title="t('secret_picker_open')"
          :aria-label="t('secret_picker_open')"
          @click="openPicker"
        >
          <PhKey class="icon" />
        </QButton>
        <QButton
          v-if="replaceable"
          class="plain sm icon secret-input-action"
          :title="t('secret_replace')"
          :aria-label="t('secret_replace')"
          @click="replace"
        >
          <PhPencilSimple class="icon" />
        </QButton>
      </div>
      <template v-else>
        <QInput
          :modelValue="modelValue"
          :inputType="typedVisible ? 'text' : 'password'"
          :placeholder="placeholder"
          :disabled="disabled"
          @update:modelValue="$emit('update:modelValue', $event)"
        >
          <template #append>
            <QButton
              class="plain sm icon secret-input-action"
              :title="typedVisible ? t('secret_hide') : t('secret_reveal')"
              :aria-label="typedVisible ? t('secret_hide') : t('secret_reveal')"
              :aria-pressed="typedVisible ? 'true' : 'false'"
              :disabled="disabled"
              @click="typedVisible = !typedVisible"
            >
              <PhEyeSlash v-if="typedVisible" class="icon" />
              <PhEye v-else class="icon" />
            </QButton>
            <QButton
              v-if="canPick"
              class="plain sm icon secret-input-action"
              :title="t('secret_picker_open')"
              :aria-label="t('secret_picker_open')"
              :disabled="disabled"
              @click="openPicker"
            >
              <PhKey class="icon" />
            </QButton>
            <QButton
              v-if="configured && replacing"
              class="plain sm icon secret-input-action"
              :title="t('secret_keep_current')"
              :aria-label="t('secret_keep_current')"
              :disabled="disabled"
              @click="keepCurrent"
            >
              <PhArrowCounterClockwise class="icon" />
            </QButton>
          </template>
        </QInput>
      </template>
      <p v-if="revealError" class="secret-input-error" role="alert">{{ revealError }}</p>
      <SecretKeyPicker v-if="pickerOpen" v-model="pickerOpen" :currentPath="revealPath" @pick="pick" />
    </div>
  `,
};

export default SecretInput;
