import { computed } from "vue";

// AppProgress: a progress bar for value out of max, or, with infinite, an indefinite one (the console
// draws that as a scanning hairline, styles/base.css). color picks the fill (blue, green, red,
// orange).
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const AppProgress = {
  name: "AppProgress",
  props: {
    infinite: { type: Boolean, default: false },
    color: { type: String, default: "blue" },
    max: { type: Number, default: 100 },
    value: { type: Number, default: 0 },
  },
  setup(props) {
    const barWidth = computed(() => (props.infinite ? "100%" : `${(props.value / props.max) * 100}%`));
    const completed = computed(() => props.value >= props.max);
    return { barWidth, completed };
  },
  template: `
    <div class="q-progress" :class="color">
      <div class="q-progress-slot">
        <div class="q-progress-bar" :style="{ width: barWidth }" :class="completed ? '' : 'animated'">
          <div class="q-progress-bar-inner"></div>
        </div>
      </div>
    </div>
  `,
};

export default AppProgress;
