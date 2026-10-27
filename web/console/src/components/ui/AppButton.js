import { computed } from "vue";

// AppButton: the console's button. Its look comes from classes: a variant (primary, the default when
// no class is given; outlined, plain, danger, placeholder), a size (sm, xs, xxs), icon for a square
// icon button, block for full width. loading shows a moving stripe and disables it. Attributes and
// listeners land on the <button>; title is rendered (the console's tooltips read it) and is the
// accessible name's fallback after aria-label, then the text of the content, then, for an icon
// button, the icon's name.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).

function slotText(nodes) {
  if (!nodes) return "";
  return nodes.map((node) => (typeof node.children === "string" ? node.children : Array.isArray(node.children) ? slotText(node.children) : "")).join("");
}

function slotIconName(nodes) {
  for (const node of nodes || []) {
    if (node.type?.name) return node.type.name;
    if (Array.isArray(node.children)) {
      const name = slotIconName(node.children);
      if (name) return name;
    }
  }
  return "";
}

const AppButton = {
  name: "AppButton",
  inheritAttrs: false,
  props: {
    class: { type: String, default: "primary" },
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    title: { type: String, default: "" },
    ariaLabel: { type: String, default: "" },
  },
  emits: ["click"],
  setup(props, { emit, slots }) {
    const cls = computed(() => ["q-button touchable", props.class, props.loading ? "loading" : ""].filter(Boolean).join(" "));
    const enabled = computed(() => !props.disabled && !props.loading);
    const label = computed(() => {
      if (props.ariaLabel) return props.ariaLabel;
      if (props.title) return props.title;
      const nodes = slots.default?.();
      const text = slotText(nodes).trim();
      if (text) return text;
      return cls.value.includes("icon") ? slotIconName(nodes) || undefined : undefined;
    });
    function onClick(event) {
      if (!enabled.value) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      emit("click", event);
    }
    return { cls, enabled, label, onClick };
  },
  template: `
    <button
      v-bind="$attrs"
      :class="cls"
      :disabled="!enabled"
      :title="title || undefined"
      :aria-label="label"
      :aria-busy="loading ? 'true' : undefined"
      @click="onClick"
    >
      <span class="button-inner"><slot /></span>
      <div v-if="loading" class="ocean" aria-hidden="true"><div class="wave"></div></div>
    </button>
  `,
};

export default AppButton;
