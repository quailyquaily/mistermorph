import { computed, onMounted, ref, watch } from "vue";

import { fieldAttrs, hasSlotContent } from "./fieldAttrs";

// AppTextarea: a multi-line text field bound with v-model, with prepend/append slots, an optional hint
// and counter (max). The model follows every input. Its root keeps class, style and data-*; other
// attributes and listeners go to the <textarea>.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const AppTextarea = {
  name: "AppTextarea",
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: "" },
    placeholder: { default: "Type here" },
    defaultText: { default: "" },
    hintIcon: { type: [String, Object], default: null },
    hintText: { default: "" },
    disabled: { default: false },
    rows: { type: Number, default: 5 },
    error: { default: false },
    max: { type: Number, default: -1 },
  },
  emits: ["change", "blur", "focus", "keyup", "update:modelValue"],
  setup(props, { emit, slots, attrs }) {
    const text = ref(props.defaultText);
    watch(
      () => props.modelValue,
      (value) => {
        text.value = value;
      },
    );
    const split = computed(() => fieldAttrs(attrs));
    const exceed = computed(() => props.max !== -1 && String(text.value ?? "").length > props.max);
    const hasHint = computed(() => props.hintIcon || props.hintText || props.max !== -1);
    const cls = computed(() =>
      [props.disabled ? "disabled" : "", props.error ? "error" : "", exceed.value ? "exceed" : ""].filter(Boolean).join(" "),
    );
    function update() {
      emit("update:modelValue", text.value);
    }
    function onInput(event) {
      text.value = event.target.value;
      update();
    }
    function onChange() {
      update();
      emit("change", text.value);
    }
    onMounted(() => {
      if (props.defaultText) {
        text.value = props.defaultText;
      } else if (props.modelValue) {
        text.value = props.modelValue;
      }
    });
    const has = (name) => hasSlotContent(slots[name]);
    return { text, split, hasHint, cls, has, onInput, onChange };
  },
  template: `
    <div class="q-textarea" :class="cls" v-bind="split.root">
      <div class="q-textarea-prepend-out" :class="{ 'is-empty': !has('prepend-out') }"><slot name="prepend-out" /></div>
      <div class="q-textarea-wrapper">
        <div class="q-textarea-inner">
          <div class="q-textarea-prepend" :class="{ 'is-empty': !has('prepend') }"><slot name="prepend" /></div>
          <textarea
            v-bind="split.field"
            class="textarea"
            :value="text"
            :rows="rows"
            :placeholder="placeholder"
            :disabled="disabled"
            @input="onInput"
            @change="onChange"
            @keyup="$emit('keyup', $event)"
            @focus="$emit('focus')"
            @blur="$emit('blur')"
          ></textarea>
          <div class="q-textarea-append" :class="{ 'is-empty': !has('append') }"><slot name="append" /></div>
        </div>
        <div v-if="hasHint" class="q-textarea-hint q-text-caption">
          <div class="q-textarea-hint-left">
            <component :is="hintIcon" v-if="hintIcon" class="q-textarea-hint-icon" />
            <div v-if="hintText" class="q-textarea-hint-text q-text-caption">{{ hintText }}</div>
          </div>
          <div v-if="max !== -1" class="q-textarea-counter">{{ String(text ?? "").length }} / {{ max }}</div>
        </div>
      </div>
      <div class="q-textarea-append-out q-input-append-out" :class="{ 'is-empty': !has('append-out') }"><slot name="append-out" /></div>
    </div>
  `,
};

export default AppTextarea;
