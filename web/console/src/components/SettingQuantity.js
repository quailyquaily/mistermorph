import { computed, ref, watch } from "vue";
import SettingMenu from "./SettingMenu";
import "./SettingFields.css";

// A number with a unit in one box: "30 minutes", "512 MB". The unit is part of the box and opens
// a short list; the number is typed. Durations and byte sizes are thin wrappers that say how their
// stored text maps to an amount and a unit.
//
//   read(text)            -> { amount, unit } | null   (null: text the units cannot show)
//   write(amount, unit)   -> stored text
//
// emptyLabel: an empty box means something of its own (such as "Same as run timeout").
export default {
  components: { SettingMenu },
  props: {
    modelValue: { type: String, default: "" },
    units: { type: Array, required: true },
    read: { type: Function, required: true },
    write: { type: Function, required: true },
    defaultUnit: { type: Number, default: 1 },
    emptyLabel: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const box = ref(null);
    const menu = ref(null);
    const open = ref(false);
    const amount = ref("");
    const unit = ref(props.defaultUnit);
    // Stored text the units cannot show (such as "500ms") is edited as plain text.
    const raw = ref(false);
    // The last value this field sent, so its echo through modelValue is not re-applied.
    let lastSent = null;

    const unitItem = computed(() => props.units.find((item) => item.value === unit.value) || props.units[0]);
    const unitTitle = computed(() => {
      const item = unitItem.value;
      // "1 minute", "2 minutes": units carry a singular title when it differs.
      return Number(amount.value) === 1 && item.one ? item.one : item.title;
    });

    watch(
      () => props.modelValue,
      (value) => {
        if (lastSent !== null && value === lastSent) return;
        const parsed = props.read(value);
        raw.value = parsed === null;
        if (raw.value) return;
        amount.value = parsed.amount;
        unit.value = parsed.unit ?? props.defaultUnit;
      },
      { immediate: true },
    );

    function send() {
      const text = String(amount.value ?? "").trim();
      lastSent = props.write(text, unit.value);
      emit("update:modelValue", lastSent);
    }

    function onInput(event) {
      if (props.disabled) return;
      // Digits and one decimal point only.
      const cleaned = event.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
      if (cleaned !== event.target.value) event.target.value = cleaned;
      amount.value = cleaned;
      send();
    }

    function step(delta) {
      const number = Number(amount.value) || 0;
      amount.value = String(Math.max(0, Math.round((number + delta) * 1000) / 1000));
      send();
    }

    function onKey(event) {
      if (props.disabled) return;
      if (menu.value?.handleKey(event)) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        step(event.key === "ArrowUp" ? 1 : -1);
      }
    }

    function onUnitKey(event) {
      if (props.disabled) return;
      if (menu.value?.handleKey(event)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === " ") {
        event.preventDefault();
        open.value = true;
      }
    }

    function toggle() {
      if (!props.disabled) open.value = !open.value;
    }

    function pickUnit(item) {
      unit.value = item.value;
      open.value = false;
      send();
    }

    function onRaw(event) {
      if (props.disabled) return;
      lastSent = event.target.value;
      emit("update:modelValue", lastSent);
    }

    return {
      box, menu, open, amount, unit, raw, unitItem, unitTitle,
      onInput, onKey, onUnitKey, toggle, pickUnit, onRaw,
    };
  },
  template: `
    <div class="sf">
      <div v-if="raw" class="sf-box" :class="{ 'is-disabled': disabled }">
        <input
          class="sf-input is-mono"
          :value="modelValue"
          :disabled="disabled"
          :aria-label="label || undefined"
          spellcheck="false"
          @input="onRaw"
        />
      </div>
      <div v-else ref="box" class="sf-box" :class="{ 'is-disabled': disabled, 'is-open': open }">
        <input
          class="sf-input is-number"
          :value="amount"
          inputmode="decimal"
          autocomplete="off"
          :placeholder="emptyLabel"
          :disabled="disabled"
          :aria-label="label ? label + ' (' + unitItem.title + ')' : undefined"
          @input="onInput"
          @keydown="onKey"
        />
        <span class="sf-sep" aria-hidden="true"></span>
        <button
          type="button"
          class="sf-part"
          :disabled="disabled"
          aria-haspopup="listbox"
          :aria-expanded="open ? 'true' : 'false'"
          :aria-label="label ? label + ': unit, ' + unitItem.title : 'Unit, ' + unitItem.title"
          @click="toggle"
          @keydown="onUnitKey"
        >
          {{ unitTitle }}
          <PhCaretDown class="sf-chevron" />
        </button>
        <SettingMenu
          ref="menu"
          :open="open"
          :anchor="box"
          :items="units"
          :selected="unit"
          align="end"
          :label="label ? label + ' unit' : 'Unit'"
          @select="pickUnit"
          @close="open = false"
        />
      </div>
    </div>
  `,
};
