import { computed, onMounted, ref, watch } from "vue";

import { hasSlotContent } from "./fieldAttrs";

// QDatetimePicker: the browser's date and time fields side by side (accept: date, time or
// datetime), bound with v-model to a local "yyyy-mm-ddThh:mm:00" string. An empty or unreadable
// value shows now. A prepend slot labels it.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const pad = (n) => String(n).padStart(2, "0");

function splitDatetime(value) {
  let at = value ? new Date(value) : new Date();
  if (Number.isNaN(at.getTime())) {
    at = new Date();
  }
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

const QDatetimePicker = {
  name: "QDatetimePicker",
  props: {
    modelValue: { type: String, required: true },
    accept: { type: String, default: "datetime" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:modelValue", "change"],
  setup(props, { emit, slots }) {
    const date = ref("");
    const time = ref("");
    function show(value) {
      const parts = splitDatetime(value);
      date.value = parts.date;
      time.value = parts.time;
    }
    watch(() => props.modelValue, show);
    onMounted(() => show(props.modelValue));
    const showDate = computed(() => props.accept === "date" || props.accept === "datetime");
    const showTime = computed(() => props.accept === "time" || props.accept === "datetime");
    const hasPrepend = computed(() => hasSlotContent(slots.prepend));
    function changed() {
      const parts = splitDatetime(`${date.value} ${time.value}`);
      const value = `${parts.date}T${parts.time}:00`;
      emit("change", value);
      emit("update:modelValue", value);
    }
    return { date, time, showDate, showTime, hasPrepend, changed };
  },
  template: `
    <div class="q-datetime-picker touchable outlined">
      <div v-if="hasPrepend" class="q-datetime-picker-prepend"><slot name="prepend" /></div>
      <input v-if="showDate" v-model="date" type="date" :disabled="disabled" @change="changed" />
      <input v-if="showTime" v-model="time" type="time" :disabled="disabled" @change="changed" />
    </div>
  `,
};

export default QDatetimePicker;
