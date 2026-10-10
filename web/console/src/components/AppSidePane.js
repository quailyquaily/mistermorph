import { onMounted, onUnmounted } from "vue";
import "./AppSidePane.css";

// The panel that opens at the right of a list to edit or inspect one of its items, as Chat's side
// panel does. On desktop it is the last column of a grid marked .side-pane-host; the host widens
// that column (.is-side-pane-open) and the pane slides out with it. On phones (sheet) it is a
// drawer from the right over a mask. A new paneKey swaps the pane: the old one fades out first.
const AppSidePane = {
  name: "AppSidePane",
  inheritAttrs: false,
  props: {
    open: { type: Boolean, default: false },
    sheet: { type: Boolean, default: false },
    paneKey: { type: [String, Number], default: "" },
    label: { type: String, default: "" },
  },
  emits: ["close"],
  setup(props, { emit }) {
    function onKeydown(event) {
      // A field that used Escape itself (closing its list) keeps the pane open.
      if (event.key === "Escape" && !event.defaultPrevented && props.open) {
        emit("close");
      }
    }
    onMounted(() => window.addEventListener("keydown", onKeydown));
    onUnmounted(() => window.removeEventListener("keydown", onKeydown));
    return {};
  },
  template: `
    <Transition name="app-side-pane-mask">
      <div v-if="open && sheet" class="app-side-pane-mask" aria-hidden="true" @click="$emit('close')"></div>
    </Transition>
    <Transition :name="sheet ? 'app-side-pane-sheet' : 'app-side-pane'" mode="out-in">
      <aside
        v-if="open"
        :key="paneKey"
        v-bind="$attrs"
        class="app-side-pane"
        :class="{ 'is-sheet': sheet }"
        :role="sheet ? 'dialog' : null"
        :aria-modal="sheet ? 'true' : null"
        :aria-label="label || null"
      >
        <div class="app-side-pane-shell">
          <div class="app-side-pane-scroll">
            <slot />
          </div>
          <footer v-if="$slots.foot" class="app-side-pane-foot">
            <slot name="foot" />
          </footer>
        </div>
      </aside>
    </Transition>
  `,
};

export default AppSidePane;
