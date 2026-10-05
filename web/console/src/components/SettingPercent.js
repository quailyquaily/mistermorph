import { computed } from "vue";
import "./SettingFields.css";

// A 0–1 ratio as a slider with its value read out beside it. A ratio is a position on a scale, so
// there is nothing to type: drag, click the track, or use the arrow keys (Shift for steps of 10).
// The model stays the ratio text a "float" field uses.
export default {
  props: {
    modelValue: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const percent = computed(() => {
      const text = String(props.modelValue ?? "").trim();
      const ratio = Number(text);
      if (text === "" || !Number.isFinite(ratio)) return null;
      return Math.min(100, Math.max(0, Math.round(ratio * 100)));
    });

    function update(value) {
      if (props.disabled) return;
      const number = Math.min(100, Math.max(0, Math.round(Number(value))));
      emit("update:modelValue", String(number / 100));
    }

    function onKey(event) {
      if (!event.shiftKey || props.disabled) return;
      const delta = { ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10 }[event.key];
      if (delta === undefined) return;
      event.preventDefault();
      update((percent.value ?? 0) + delta);
    }

    return { percent, update, onKey };
  },
  template: `
    <div class="sf sf-ratio">
      <div class="sf-ratio-track">
        <input
          class="sf-ratio-range"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="percent ?? 0"
          :style="{ '--pct': (percent ?? 0) + '%' }"
          :disabled="disabled"
          :aria-label="label || undefined"
          :aria-valuetext="percent === null ? 'Not set' : percent + '%'"
          @input="update($event.target.value)"
          @keydown="onKey"
        />
        <div class="sf-ratio-ticks" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
      <output class="sf-ratio-value" :class="{ 'sf-muted': percent === null }">
        <template v-if="percent === null">—</template>
        <template v-else>{{ percent }}<small>%</small></template>
      </output>
    </div>
  `,
};
