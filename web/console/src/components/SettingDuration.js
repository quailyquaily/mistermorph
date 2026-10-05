import SettingQuantity from "./SettingQuantity";
import { durationSeconds, formatDuration, splitDuration } from "../core/duration";

const UNITS = [
  { title: "seconds", one: "second", value: 1 },
  { title: "minutes", one: "minute", value: 60 },
  { title: "hours", one: "hour", value: 3600 },
  { title: "days", one: "day", value: 86400 },
];

// A Go duration ("1h30m") as an amount and a unit in one box. With zeroLabel, zero means something
// of its own (such as "Same as run timeout"): the box is left empty and says so.
export default {
  components: { SettingQuantity },
  props: {
    modelValue: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, default: "" },
    zeroLabel: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props) {
    function read(text) {
      const value = String(text ?? "").trim();
      if (value === "") return { amount: "", unit: 60 };
      const seconds = durationSeconds(value);
      if (seconds === null) return null;
      if (seconds === 0) return { amount: props.zeroLabel ? "" : "0", unit: 60 };
      return splitDuration(seconds);
    }

    function write(amount, unit) {
      if (amount === "") return props.zeroLabel ? formatDuration(0) : "";
      const number = Number(amount);
      return Number.isFinite(number) ? formatDuration(number * unit) : amount;
    }

    return { UNITS, read, write };
  },
  template: `
    <SettingQuantity
      :modelValue="modelValue"
      :units="UNITS"
      :read="read"
      :write="write"
      :defaultUnit="60"
      :emptyLabel="zeroLabel"
      :disabled="disabled"
      :label="label"
      @update:modelValue="$emit('update:modelValue', $event)"
    />
  `,
};
