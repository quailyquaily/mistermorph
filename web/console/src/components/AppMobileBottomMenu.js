import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { transitionTimeMs } from "../core/transition-time";
import "./AppMobileBottomMenu.css";

const AppMobileBottomMenu = {
  props: {
    modelValue: {
      type: Boolean,
      required: true,
    },
    label: {
      type: String,
      required: true,
    },
    panelClass: {
      type: String,
      default: "",
    },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const panel = ref(null);
    // The sheet stays mounted while it slides away: rendered keeps it in the page, open is where
    // it is heading. Toggling it again mid-slide turns the same sheet around from where it is,
    // instead of dropping it and starting a new one from the bottom.
    const rendered = ref(props.modelValue);
    const open = ref(props.modelValue);
    let focusBeforeOpen = null;
    let closeTimer = 0;

    function onWindowKeydown(event) {
      if (event.key !== "Escape" || !props.modelValue) {
        return;
      }
      event.preventDefault();
      emit("close");
    }

    function clearCloseTimer() {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = 0;
      }
    }

    function finishClose() {
      clearCloseTimer();
      if (!props.modelValue) {
        rendered.value = false;
      }
    }

    watch(
      () => props.modelValue,
      async (value) => {
        if (value) {
          clearCloseTimer();
          focusBeforeOpen = document.activeElement;
          window.addEventListener("keydown", onWindowKeydown);
          const mounting = !rendered.value;
          rendered.value = true;
          await nextTick();
          if (!props.modelValue) {
            return;
          }
          if (mounting) {
            // Lay the new sheet out at its closed position first, so it rises from there.
            void panel.value?.offsetHeight;
          }
          open.value = true;
          await nextTick();
          const firstAction = panel.value?.querySelector(
            "input, [aria-current='page'], [aria-selected='true'], a, button:not(:disabled)",
          );
          (firstAction || panel.value)?.focus();
          return;
        }
        window.removeEventListener("keydown", onWindowKeydown);
        open.value = false;
        if (focusBeforeOpen instanceof HTMLElement && document.contains(focusBeforeOpen)) {
          focusBeforeOpen.focus();
        }
        focusBeforeOpen = null;
        await nextTick();
        if (props.modelValue) {
          return;
        }
        // Unmount once the closing slide, as styled now, has run.
        const duration = panel.value ? transitionTimeMs(window.getComputedStyle(panel.value)) : 0;
        clearCloseTimer();
        if (duration <= 0) {
          finishClose();
          return;
        }
        closeTimer = setTimeout(finishClose, duration + 50);
      },
    );

    onBeforeUnmount(() => {
      clearCloseTimer();
      window.removeEventListener("keydown", onWindowKeydown);
    });

    return {
      panel,
      rendered,
      open,
    };
  },
  template: `
    <Teleport to="body">
      <div v-if="rendered" class="mobile-bottom-menu-layer" :class="{ 'is-open': open }">
        <div class="mobile-bottom-menu-mask" aria-hidden="true" @click="$emit('close')"></div>
        <section
          ref="panel"
          class="mobile-bottom-menu-panel"
          :class="panelClass"
          role="dialog"
          :aria-label="label"
          :inert="!open"
          tabindex="-1"
        >
          <header class="mobile-bottom-menu-head">
            <span class="mobile-bottom-menu-title">{{ label }}</span>
          </header>
          <slot />
        </section>
      </div>
    </Teleport>
  `,
};

export default AppMobileBottomMenu;
