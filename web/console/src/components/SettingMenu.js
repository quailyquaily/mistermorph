import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import "./SettingFields.css";

let menuSeq = 0;

// The floating list behind every settings field that offers choices. It is teleported to <body>
// and positioned against its anchor, so dialogs and scroll areas never clip it. Focus stays in the
// field: the field forwards key presses through handleKey(), and options take clicks without
// stealing focus.
export default {
  props: {
    open: Boolean,
    anchor: { type: Object, default: null },
    items: { type: Array, default: () => [] },
    selected: { type: [String, Number, Boolean, null], default: null },
    // "start" lines the list up with the anchor's left edge, "end" with its right edge.
    align: { type: String, default: "start" },
    // Make the list at least as wide as the anchor.
    matchWidth: Boolean,
    label: { type: String, default: "" },
  },
  emits: ["select", "close"],
  setup(props, { emit, expose }) {
    const id = `sf-menu-${++menuSeq}`;
    const menu = ref(null);
    const active = ref(-1);
    const style = ref({});

    function place() {
      const anchor = props.anchor;
      const element = menu.value;
      if (!anchor || !element) return;
      const rect = anchor.getBoundingClientRect();
      const width = props.matchWidth ? rect.width : undefined;
      const height = element.offsetHeight;
      const below = window.innerHeight - rect.bottom;
      const top = below < height + 8 && rect.top > below ? rect.top - height - 4 : rect.bottom + 4;
      const menuWidth = Math.max(element.offsetWidth, width || 0);
      let left = props.align === "end" ? rect.right - menuWidth : rect.left;
      left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
      style.value = {
        top: `${Math.round(top)}px`,
        left: `${Math.round(left)}px`,
        ...(width ? { minWidth: `${Math.round(width)}px` } : {}),
      };
    }

    let frame = 0;
    function schedulePlace() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    }

    function onPointerDown(event) {
      const target = event.target;
      if (menu.value?.contains(target) || props.anchor?.contains(target)) return;
      emit("close");
    }

    function listen(on) {
      const method = on ? "addEventListener" : "removeEventListener";
      window[method]("resize", schedulePlace);
      window[method]("scroll", schedulePlace, true);
      document[method]("pointerdown", onPointerDown, true);
    }

    function scrollActiveIntoView() {
      const option = menu.value?.querySelector(`[data-index="${active.value}"]`);
      option?.scrollIntoView({ block: "nearest" });
    }

    watch(
      () => props.open,
      async (open) => {
        listen(open);
        if (!open) return;
        active.value = Math.max(0, props.items.findIndex((item) => item.value === props.selected));
        await nextTick();
        place();
        scrollActiveIntoView();
      },
      { immediate: true },
    );

    watch(() => props.items, () => props.open && nextTick(place));

    onBeforeUnmount(() => {
      listen(false);
      if (frame) window.cancelAnimationFrame(frame);
    });

    function choose(index) {
      const item = props.items[index];
      if (item && !item.disabled) emit("select", item);
    }

    function move(delta) {
      const count = props.items.length;
      if (!count) return;
      active.value = (active.value + delta + count) % count;
      void nextTick(scrollActiveIntoView);
    }

    // Returns true when the key was for the list.
    function handleKey(event) {
      if (!props.open) return false;
      switch (event.key) {
        case "ArrowDown":
          move(1);
          break;
        case "ArrowUp":
          move(-1);
          break;
        case "Home":
          active.value = 0;
          break;
        case "End":
          active.value = props.items.length - 1;
          break;
        case "Enter":
          choose(active.value);
          break;
        case "Escape":
        case "Tab":
          emit("close");
          return event.key === "Escape";
        default:
          return false;
      }
      event.preventDefault();
      return true;
    }

    function optionId(index) {
      return `${id}-${index}`;
    }

    expose({ handleKey, id, optionId, active });

    return { id, menu, active, style, choose, optionId };
  },
  template: `
    <Teleport to="body">
      <div
        v-if="open"
        :id="id"
        ref="menu"
        class="sf-menu"
        role="listbox"
        :aria-label="label || undefined"
        :style="style"
      >
        <div
          v-for="(item, index) in items"
          :key="String(item.value) + ':' + index"
          :id="optionId(index)"
          :data-index="index"
          class="sf-option"
          :class="{ 'is-active': index === active, 'is-selected': item.value === selected }"
          role="option"
          :aria-selected="item.value === selected ? 'true' : 'false'"
          @pointerenter="active = index"
          @pointerdown.prevent
          @click="choose(index)"
        >
          <span>{{ item.title }}</span>
          <span v-if="item.hint" class="sf-option-hint">{{ item.hint }}</span>
        </div>
      </div>
    </Teleport>
  `,
};
