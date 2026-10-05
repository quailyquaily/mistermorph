import { computed, nextTick, ref } from "vue";
import SettingMenu from "./SettingMenu";
import "./SettingFields.css";

// A choice from a list, in one box.
//
// With allowCustom the box is also where a value of your own is typed: it shows the preset's name
// ("Every 30 minutes") until focused, then the stored text ("30m") ready to edit, with the presets
// listed underneath. There is no separate "Custom" item and no second field.
export default {
  components: { SettingMenu },
  props: {
    modelValue: { type: String, default: "" },
    options: { type: Array, default: () => [] },
    disabled: Boolean,
    allowCustom: Boolean,
    placeholder: { type: String, default: "Default" },
    label: { type: String, default: "" },
    // Kept for callers; a custom value is typed straight into the box.
    customLabel: { type: String, default: "" },
    customPlaceholder: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const box = ref(null);
    const field = ref(null);
    const menu = ref(null);
    const open = ref(false);
    const editing = ref(false);
    // Enter picks from the list only after the arrow keys moved into it.
    const navigated = ref(false);

    const presets = computed(() => props.options.map((option) => (typeof option === "string"
      ? { title: option || props.placeholder, value: option }
      : option)));

    const items = computed(() => {
      const list = presets.value.map((item) => ({
        ...item,
        hint: props.allowCustom && item.value !== "" && item.value !== item.title ? item.value : "",
      }));
      // A stored value that is not a preset still shows, so it is never silently replaced.
      if (!props.allowCustom && !list.some((item) => item.value === props.modelValue)) {
        list.push({ title: props.modelValue || props.placeholder, value: props.modelValue });
      }
      return list;
    });

    const current = computed(() => presets.value.find((item) => item.value === props.modelValue) || null);
    const shownText = computed(() => {
      if (props.allowCustom && editing.value) return props.modelValue;
      return current.value ? current.value.title : props.modelValue;
    });

    function pick(item) {
      emit("update:modelValue", item.value);
      open.value = false;
      navigated.value = false;
    }

    function toggle() {
      if (props.disabled) return;
      open.value = !open.value;
      if (open.value && props.allowCustom) void nextTick(() => field.value?.focus());
    }

    function onTriggerKey(event) {
      if (props.disabled) return;
      if (menu.value?.handleKey(event)) return;
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        open.value = true;
      }
    }

    function onFocus(event) {
      editing.value = true;
      open.value = true;
      void nextTick(() => event.target.select());
    }

    function onBlur() {
      editing.value = false;
    }

    function onInput(event) {
      if (props.disabled) return;
      navigated.value = false;
      open.value = true;
      emit("update:modelValue", event.target.value);
    }

    function onFieldKey(event) {
      if (props.disabled) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        navigated.value = true;
        if (!open.value) {
          open.value = true;
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Enter" && !navigated.value) {
        event.preventDefault();
        open.value = false;
        return;
      }
      menu.value?.handleKey(event);
    }

    return {
      box, field, menu, open, items, current, shownText,
      pick, toggle, onTriggerKey, onFocus, onBlur, onInput, onFieldKey,
    };
  },
  template: `
    <div class="sf">
      <div ref="box" class="sf-box" :class="{ 'is-disabled': disabled, 'is-open': open }">
        <template v-if="allowCustom">
          <input
            ref="field"
            class="sf-input"
            :value="shownText"
            :placeholder="customPlaceholder || placeholder"
            :disabled="disabled"
            role="combobox"
            aria-autocomplete="none"
            :aria-expanded="open ? 'true' : 'false'"
            :aria-label="label || undefined"
            autocomplete="off"
            spellcheck="false"
            @focus="onFocus"
            @blur="onBlur"
            @input="onInput"
            @keydown="onFieldKey"
          />
          <button
            type="button"
            class="sf-part"
            tabindex="-1"
            :disabled="disabled"
            :aria-label="label ? label + ': show choices' : 'Show choices'"
            @click="toggle"
          >
            <PhCaretDown class="sf-chevron" />
          </button>
        </template>
        <button
          v-else
          type="button"
          class="sf-trigger"
          :disabled="disabled"
          aria-haspopup="listbox"
          :aria-expanded="open ? 'true' : 'false'"
          :aria-label="label ? label + ': ' + shownText : undefined"
          @click="toggle"
          @keydown="onTriggerKey"
        >
          <span class="sf-trigger-text" :class="{ 'is-placeholder': !current && !modelValue }">{{ shownText || placeholder }}</span>
          <PhCaretDown class="sf-chevron" />
        </button>
        <SettingMenu
          ref="menu"
          :open="open"
          :anchor="box"
          :items="items"
          :selected="modelValue"
          matchWidth
          :label="label"
          @select="pick"
          @close="open = false"
        />
      </div>
    </div>
  `,
};
