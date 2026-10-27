import { computed, onMounted, ref, watch } from "vue";

import { fieldAttrs, hasSlotContent } from "./fieldAttrs";
import AppButton from "./AppButton";
import { AppIconEditorDelete } from "./icons";

// AppInput: a one-line text field bound with v-model, with prepend/append slots inside the field and
// prepend-out/append-out outside it, an optional hint and counter (max), and a clear button. The model
// follows every input. Its root keeps class, style and data-*; other attributes and listeners go to
// the <input>.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const AppInput = {
  name: "AppInput",
  components: { AppButton, AppIconEditorDelete },
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: "" },
    placeholder: { default: "Type here" },
    defaultText: { default: "" },
    disabled: { default: false },
    hintIcon: { type: [String, Object], default: null },
    hintText: { default: "" },
    error: { default: false },
    max: { type: Number, default: -1 },
    inputType: { type: String, default: "text" },
  },
  emits: ["change", "blur", "focus", "keyup", "update:modelValue"],
  setup(props, { emit, slots, attrs }) {
    const text = ref(props.defaultText);
    const textField = ref(null);
    watch(
      () => props.modelValue,
      (value) => {
        text.value = value;
      },
    );
    const split = computed(() => fieldAttrs(attrs));
    const exceed = computed(() => props.max !== -1 && String(text.value ?? "").length > props.max);
    const hasHint = computed(() => props.hintIcon || props.hintText || props.max !== -1 || props.error);
    const cls = computed(() =>
      [props.disabled ? "disabled" : "", props.error ? "error" : "", exceed.value ? "exceed" : "", text.value === "" ? "empty" : ""]
        .filter(Boolean)
        .join(" "),
    );
    function update() {
      emit("update:modelValue", text.value);
    }
    function onInput(event) {
      text.value = event.target.value;
      update();
    }
    function onKeyup(event) {
      emit("keyup", event);
    }
    function onChange() {
      update();
      emit("change", text.value);
    }
    function clear() {
      text.value = "";
      update();
      textField.value?.focus();
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
    return { text, textField, split, hasHint, cls, has, onInput, onKeyup, onChange, clear };
  },
  template: `
    <div class="q-input" :class="cls" v-bind="split.root">
      <div class="q-input-prepend-out" :class="{ 'is-empty': !has('prepend-out') }"><slot name="prepend-out" /></div>
      <div class="q-text-field-wrapper">
        <div class="q-text-field-inner">
          <div class="q-input-prepend" :class="{ 'is-empty': !has('prepend') }"><slot name="prepend" /></div>
          <input
            ref="textField"
            v-bind="split.field"
            class="q-text-field text-field"
            :type="inputType"
            :placeholder="placeholder"
            :disabled="disabled"
            :value="text"
            @input="onInput"
            @change="onChange"
            @keyup="onKeyup"
            @focus="$emit('focus')"
            @blur="$emit('blur')"
          />
          <AppButton v-if="!disabled" type="button" class="clear-btn plain sm icon" @click="clear">
            <AppIconEditorDelete class="icon" />
          </AppButton>
          <div class="q-input-append" :class="{ 'is-empty': !has('append') }"><slot name="append" /></div>
        </div>
        <div v-if="hasHint" class="q-text-field-hint q-text-caption">
          <div class="q-text-field-hint-left">
            <component :is="hintIcon" v-if="hintIcon" class="q-text-field-hint-icon" />
            <div v-if="hintText" class="q-text-field-hint-text">{{ hintText }}</div>
          </div>
          <div v-if="max !== -1" class="q-text-field-counter q-text-caption">{{ String(text ?? "").length }} / {{ max }}</div>
        </div>
      </div>
      <div class="q-input-append-out" :class="{ 'is-empty': !has('append-out') }"><slot name="append-out" /></div>
    </div>
  `,
};

export default AppInput;
