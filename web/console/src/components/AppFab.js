import "./AppFab.css";

// The page's main action on mobile, floating in the bottom-right corner above the nav strip.
const AppFab = {
  props: {
    icon: { type: String, default: "PhPlus" },
    label: { type: String, required: true },
    disabled: { type: Boolean, default: false },
  },
  emits: ["click"],
  template: `
    <button type="button" class="app-fab" :title="label" :aria-label="label" :disabled="disabled" @click="$emit('click', $event)">
      <component :is="icon" class="app-fab-icon icon" aria-hidden="true" />
    </button>
  `,
};

export default AppFab;
