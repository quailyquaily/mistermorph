import { computed } from "vue";

// AppBadge: a small label or, with dot, a status mark. type sets its colour (default, primary,
// success, warning, danger, info), size (sm, md, lg) and variant (filled, outlined, light) its
// form; closable adds a close button that emits close.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const AppBadge = {
  name: "AppBadge",
  props: {
    type: { type: String, default: "default" },
    size: { type: String, default: "md" },
    variant: { type: String, default: "filled" },
    rounded: { type: Boolean, default: false },
    dot: { type: Boolean, default: false },
    closable: { type: Boolean, default: false },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const cls = computed(() => {
      const variant = props.variant === "technical" || props.variant === "bracket" ? "filled" : props.variant;
      const out = ["q-badge", `q-badge-${props.type}`, `q-badge-${props.size}`, `q-badge-${variant}`];
      if (props.rounded) out.push("q-badge-rounded");
      if (props.dot) out.push("q-badge-dot");
      if (props.closable && !props.dot) out.push("q-badge-closable");
      return out.join(" ");
    });
    function close(event) {
      event.stopPropagation();
      emit("close");
    }
    return { cls, close };
  },
  template: `
    <span :class="cls">
      <span v-if="dot" class="q-badge-dot-indicator"></span>
      <span v-else class="q-badge-content"><slot /></span>
      <button v-if="closable && !dot" type="button" class="q-badge-close" @click="close">
        <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </span>
  `,
};

export default AppBadge;
