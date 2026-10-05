import { computed, nextTick, ref, watch } from "vue";
import "./SettingFields.css";

// An integer limit where 0 means "no limit", in one box. Limited, it is a number with a "No limit"
// action; unlimited, the box says so and offers "Set limit", which brings back the last limit.
// The model stays the integer text an "int" field uses.
export default {
  props: {
    modelValue: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, default: "" },
    defaultLimit: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const field = ref(null);
    const focused = ref(false);
    // Kept apart from the value so clearing the box while typing does not drop the limit.
    const limited = ref(false);
    const lastLimit = ref(props.defaultLimit);

    watch(
      () => props.modelValue,
      (value) => {
        const text = String(value ?? "").trim();
        if (text === "0") limited.value = false;
        else if (text !== "") {
          limited.value = true;
          lastLimit.value = text;
        }
      },
      { immediate: true },
    );

    // 200000 reads as "200,000" until the box is edited.
    const shown = computed(() => {
      const text = String(props.modelValue ?? "").trim();
      if (focused.value || !/^\d+$/.test(text)) return text;
      return Number(text).toLocaleString();
    });

    function setLimited(on) {
      if (props.disabled) return;
      limited.value = on;
      emit("update:modelValue", on ? lastLimit.value || props.defaultLimit || "1" : "0");
      if (on) {
        void nextTick(() => {
          field.value?.focus();
          field.value?.select();
        });
      }
    }

    function onInput(event) {
      if (props.disabled) return;
      const cleaned = event.target.value.replace(/\D/g, "");
      if (cleaned !== event.target.value) event.target.value = cleaned;
      emit("update:modelValue", cleaned);
    }

    return { field, focused, limited, shown, setLimited, onInput };
  },
  template: `
    <div class="sf">
      <div class="sf-box" :class="{ 'is-disabled': disabled }">
        <template v-if="limited">
          <input
            ref="field"
            class="sf-input is-number"
            :value="shown"
            inputmode="numeric"
            autocomplete="off"
            :disabled="disabled"
            :aria-label="label || undefined"
            @focus="focused = true"
            @blur="focused = false"
            @input="onInput"
          />
          <span class="sf-sep" aria-hidden="true"></span>
          <button type="button" class="sf-part is-quiet" :disabled="disabled" @click="setLimited(false)">No limit</button>
        </template>
        <template v-else>
          <button
            type="button"
            class="sf-trigger"
            :disabled="disabled"
            :aria-label="label ? label + ': no limit. Set a limit' : 'No limit. Set a limit'"
            @click="setLimited(true)"
          >
            <span class="sf-trigger-text is-placeholder">No limit</span>
          </button>
          <span class="sf-sep" aria-hidden="true"></span>
          <button type="button" class="sf-part" tabindex="-1" :disabled="disabled" @click="setLimited(true)">Set limit</button>
        </template>
      </div>
    </div>
  `,
};
