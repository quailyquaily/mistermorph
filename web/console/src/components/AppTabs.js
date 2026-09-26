import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import "./AppTabs.css";

function tabID(tab, index) {
  return String(tab?.id ?? index);
}

const AppTabs = {
  props: {
    tabs: { type: Array, default: () => [] },
    modelValue: { type: Object, default: null },
    disabled: { type: Boolean, default: false },
    ariaLabel: { type: String, default: "" },
  },
  emits: ["update:modelValue", "change"],
  setup(props, { emit }) {
    function isActive(tab, index) {
      return tabID(tab, index) === tabID(props.modelValue, -1);
    }

    function selectTab(tab, index) {
      if (props.disabled || tab?.disabled) return;
      emit("update:modelValue", tab);
      emit("change", { tab, index });
    }

    function onKeydown(event) {
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!direction && event.key !== "Home" && event.key !== "End") return;

      const buttons = [...event.currentTarget.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]:not(:disabled)') || []];
      if (!buttons.length) return;
      event.preventDefault();

      const current = buttons.indexOf(event.currentTarget);
      const target = event.key === "Home"
        ? buttons[0]
        : event.key === "End"
          ? buttons[buttons.length - 1]
          : buttons[(current + direction + buttons.length) % buttons.length];
      target?.focus();
      const nextIndex = Number(target?.dataset.tabIndex);
      if (Number.isInteger(nextIndex)) selectTab(props.tabs[nextIndex], nextIndex);
    }

    // One highlight that slides to the active option. It is placed without animation first,
    // then moves; a resize observer keeps it aligned when labels or the container change size.
    const root = ref(null);
    const indicator = ref({ visible: false, x: 0, width: 0 });
    const indicatorReady = ref(false);
    let resizeObserver = null;

    function placeIndicator() {
      const el = root.value;
      const active = el?.querySelector(".app-tabs-option.is-active");
      if (!el || !active || active.offsetWidth === 0) {
        indicator.value = { visible: false, x: 0, width: 0 };
        return;
      }
      indicator.value = { visible: true, x: active.offsetLeft, width: active.offsetWidth };
    }

    onMounted(() => {
      placeIndicator();
      requestAnimationFrame(() => {
        indicatorReady.value = true;
      });
      if (typeof ResizeObserver === "function" && root.value) {
        resizeObserver = new ResizeObserver(placeIndicator);
        resizeObserver.observe(root.value);
      }
    });
    onBeforeUnmount(() => resizeObserver?.disconnect());
    watch(
      () => [tabID(props.modelValue, -1), props.tabs.map((tab, index) => `${tabID(tab, index)}:${tab.title}`).join("|")],
      () => nextTick(placeIndicator),
    );

    return { isActive, selectTab, onKeydown, root, indicator, indicatorReady };
  },
  template: `
    <div ref="root" class="app-tabs" :class="{ 'has-indicator': indicator.visible }" role="tablist" :aria-label="ariaLabel || undefined">
      <span
        v-if="indicator.visible"
        class="app-tabs-indicator"
        :class="{ 'is-ready': indicatorReady }"
        :style="{ width: indicator.width + 'px', transform: 'translateX(' + indicator.x + 'px)' }"
        aria-hidden="true"
      ></span>
      <button
        v-for="(tab, index) in tabs"
        :key="tab.id ?? index"
        type="button"
        class="app-tabs-option"
        :class="{ 'is-active': isActive(tab, index) }"
        role="tab"
        :aria-selected="isActive(tab, index)"
        :tabindex="isActive(tab, index) ? 0 : -1"
        :data-tab-index="index"
        :disabled="disabled || tab.disabled"
        @click="selectTab(tab, index)"
        @keydown="onKeydown($event)"
      >
        <component v-if="tab.icon" :is="tab.icon" class="app-tabs-option-icon" aria-hidden="true" />
        <span class="app-tabs-option-label">{{ tab.title }}</span>
      </button>
    </div>
  `,
};

export default AppTabs;
