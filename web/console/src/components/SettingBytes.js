import SettingQuantity from "./SettingQuantity";

const UNITS = [
  { title: "bytes", one: "byte", value: 1 },
  { title: "KB", value: 1024 },
  { title: "MB", value: 1024 * 1024 },
  { title: "GB", value: 1024 * 1024 * 1024 },
];

// A byte count as an amount and a unit in one box, saved as whole bytes (the text an "int" field uses).
export default {
  components: { SettingQuantity },
  props: {
    modelValue: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup() {
    function read(text) {
      const value = String(text ?? "").trim();
      const bytes = Number(value);
      if (value === "") return { amount: "", unit: UNITS[2].value };
      if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
      if (bytes === 0) return { amount: "0", unit: UNITS[2].value };
      // The largest unit that shows the count as a whole number.
      const unit = [...UNITS].reverse().find((item) => bytes % item.value === 0) || UNITS[0];
      return { amount: String(bytes / unit.value), unit: unit.value };
    }

    function write(amount, unit) {
      if (amount === "") return "";
      const number = Number(amount);
      return Number.isFinite(number) ? String(Math.round(number * unit)) : amount;
    }

    return { UNITS, read, write };
  },
  template: `
    <SettingQuantity
      :modelValue="modelValue"
      :units="UNITS"
      :read="read"
      :write="write"
      :defaultUnit="1048576"
      :disabled="disabled"
      :label="label"
      @update:modelValue="$emit('update:modelValue', $event)"
    />
  `,
};
