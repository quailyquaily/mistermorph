import { computed } from "vue";
import "./SettingFields.css";

// Several values from a known list, as toggles laid out like chips. Values already stored that are
// not in the list still show, so they can be turned off.
export default {
  props: {
    modelValue: { type: Array, default: () => [] },
    options: { type: Array, default: () => [] },
    disabled: Boolean,
    // Values whose toggle is locked in its current state.
    disabledOptions: { type: Array, default: () => [] },
    label: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const items = computed(() => [...new Set([...props.options, ...props.modelValue])]);
    function toggle(value) {
      if (props.disabled || props.disabledOptions.includes(value)) return;
      const on = !props.modelValue.includes(value);
      emit("update:modelValue", on
        ? [...new Set([...props.modelValue, value])]
        : props.modelValue.filter((item) => item !== value));
    }
    return { items, toggle };
  },
  template: `
    <div class="sf sf-chips" role="group" :aria-label="label || undefined">
      <button
        v-for="item in items"
        :key="item"
        type="button"
        class="sf-chip"
        role="checkbox"
        :aria-checked="modelValue.includes(item) ? 'true' : 'false'"
        :disabled="disabled || disabledOptions.includes(item)"
        @click="toggle(item)"
      >
        <PhCheck v-if="modelValue.includes(item)" class="sf-icon" />
        {{ item }}
      </button>
    </div>
  `,
};
