import { computed } from "vue";

// AppDivider: a horizontal rule, optionally labelled, emphasised (focus) or doubled.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const AppDivider = {
  name: "AppDivider",
  props: {
    label: { type: String, default: "" },
    focus: { type: Boolean, default: false },
    double: { type: Boolean, default: false },
  },
  setup(props) {
    const cls = computed(() =>
      ["q-divider", props.label ? "q-divider-labeled" : "", props.focus ? "q-divider-focus" : "", props.double ? "q-divider-double" : ""]
        .filter(Boolean)
        .join(" "),
    );
    return { cls };
  },
  template: `
    <div :class="cls" role="separator" :aria-label="label || undefined">
      <span v-if="label" class="q-divider-label">{{ label }}</span>
    </div>
  `,
};

export default AppDivider;
