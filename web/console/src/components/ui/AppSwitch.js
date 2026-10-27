import { computed, ref, watch } from "vue";

// AppSwitch: an on/off switch bound with v-model. A checkbox inside a label, so the label (and its
// aria-label) is the control's name; it emits update:modelValue and change with the new value.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const AppSwitch = {
  name: "AppSwitch",
  props: {
    modelValue: { type: Boolean, required: true },
    disabled: { type: Boolean, default: false },
    theme: { type: String, default: "default" },
  },
  emits: ["update:modelValue", "change"],
  setup(props, { emit }) {
    const val = ref(props.modelValue);
    watch(
      () => props.modelValue,
      (value) => {
        val.value = value;
      },
    );
    const cls = computed(() => [props.theme ? `theme-${props.theme}` : "", props.disabled ? "disabled" : ""].filter(Boolean).join(" "));
    function change() {
      emit("update:modelValue", val.value);
      emit("change", val.value);
    }
    return { val, cls, change };
  },
  template: `
    <label class="q-switch" :class="cls">
      <input v-model="val" class="q-switch-checkbox" type="checkbox" :disabled="disabled" @change="change" />
      <div class="q-switch-inner"><div class="q-switch-handle"></div></div>
    </label>
  `,
};

export default AppSwitch;
