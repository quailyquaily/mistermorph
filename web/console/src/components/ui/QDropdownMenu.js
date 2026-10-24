import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { hasSlotContent } from "./fieldAttrs";
import { QIconChevronDown } from "./icons";
import QDialog from "./QDialog";
import QInput from "./QInput";
import QMenu from "./QMenu";
import { closePopupMenu, onPopupClose, opensKeyboard } from "./popup";

// QDropdownMenu: a button showing the chosen item that opens a QMenu of items below it. On a
// narrow window (under 768px when it is set up, or with useDialog "always") the menu opens in a
// frameless dialog instead, optionally with a filter field. Arrow keys move through the items,
// Enter chooses, Escape closes; opening one menu closes the others, and so does a click elsewhere.
// Choosing an item emits "change". The default slot replaces the chosen item's label.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const QDropdownMenu = {
  name: "QDropdownMenu",
  components: { QDialog, QIconChevronDown, QInput, QMenu },
  props: {
    items: { type: Array, required: true },
    initialItem: { type: Object, default: null },
    hideSelected: { type: Boolean, default: false },
    variant: { type: String, default: "outlined" },
    hideActionLabel: { type: Boolean, default: false },
    placeholder: { type: String, default: "" },
    useDialog: { type: String, default: "auto" },
    useFilter: { type: Boolean, default: false },
    scrollHeight: { type: String, default: "auto" },
    emptyHit: { type: String, default: "No item" },
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
  },
  emits: ["change"],
  setup(props, { emit, slots }) {
    const expanded = ref(false);
    const focusedIndex = ref(-1);
    const selectedItem = ref(null);
    const menuWrapper = ref(null);
    const filterInput = ref(null);
    const filterText = ref("");
    let keysOn = false;
    let stopPopupClose = null;

    const actionCls = computed(() => {
      const item = selectedItem.value;
      return [
        expanded.value ? "expanded" : "",
        props.variant === "outlined" || props.variant === "plain" ? props.variant : "",
        props.hideSelected ? "hide-selected" : "",
        item && (item.icon || item.image) ? "prepend" : "no-prepend",
        props.loading ? "loading" : "",
      ]
        .filter(Boolean)
        .join(" ");
    });
    const hasSlot = computed(() => slots.default !== undefined);
    const hasPrepend = computed(() => hasSlotContent(slots.prepend));
    const filteredItems = computed(() => {
      const text = filterText.value.trim().toLowerCase();
      if (!props.items?.length) {
        return [];
      }
      return text ? props.items.filter((item) => item?.title?.toLowerCase().includes(text)) : props.items;
    });
    // Decided once, from the window's width when the menu is set up.
    const useDialogFlag = computed(() => {
      if (props.useDialog === "always") {
        return true;
      }
      if (props.useDialog === "never") {
        return false;
      }
      return typeof window !== "undefined" && window.innerWidth < 768;
    });

    function select(item) {
      if (item.divider) {
        return;
      }
      expanded.value = false;
      selectedItem.value = item;
      emit("change", item);
    }
    function onKeydown(event) {
      if (!expanded.value) {
        return;
      }
      const items = filteredItems.value.filter((item) => !item.divider && !item.disabled);
      if (!items.length) {
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusedIndex.value = Math.min(focusedIndex.value + 1, items.length - 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusedIndex.value = Math.max(focusedIndex.value - 1, 0);
          break;
        case "Enter":
          event.preventDefault();
          if (focusedIndex.value >= 0 && focusedIndex.value < items.length) {
            select(items[focusedIndex.value]);
          }
          break;
        case "Escape":
          event.preventDefault();
          expanded.value = false;
          break;
      }
    }
    function listenKeys(on) {
      if (on === keysOn) {
        return;
      }
      window[on ? "addEventListener" : "removeEventListener"]("keydown", onKeydown);
      keysOn = on;
    }
    function openMenu(initialFocus = -1) {
      if (props.disabled || props.loading) {
        return;
      }
      closePopupMenu();
      expanded.value = true;
      focusedIndex.value = initialFocus;
      if (!useDialogFlag.value) {
        // Kept inside the window on the left.
        requestAnimationFrame(() => {
          const menu = menuWrapper.value?.querySelector(".q-menu");
          if (menu && menu.getBoundingClientRect().left < 0) {
            menu.style.left = "0";
          }
        });
      }
    }
    function toggle() {
      if (expanded.value) {
        expanded.value = false;
        return;
      }
      openMenu();
    }
    function openFromKeyboard() {
      if (expanded.value) {
        focusedIndex.value = Math.max(focusedIndex.value, 0);
        return;
      }
      openMenu(0);
    }
    function focusFilter() {
      if (!expanded.value || !props.useFilter || !useDialogFlag.value) {
        return;
      }
      nextTick(() =>
        requestAnimationFrame(() => {
          const input = filterInput.value?.$el?.querySelector("input");
          if (input && !opensKeyboard(input)) {
            input.focus();
          }
        }),
      );
    }

    watch(
      () => props.initialItem,
      (item) => {
        if (item) {
          selectedItem.value = item;
        }
      },
    );
    watch(expanded, (open) => {
      listenKeys(open);
      if (open) {
        focusFilter();
      } else {
        focusedIndex.value = -1;
      }
    });
    onMounted(() => {
      if (props.initialItem) {
        selectedItem.value = props.initialItem;
      }
      stopPopupClose = onPopupClose(() => {
        expanded.value = false;
      });
    });
    onUnmounted(() => {
      stopPopupClose?.();
      listenKeys(false);
    });

    return {
      expanded,
      focusedIndex,
      selectedItem,
      menuWrapper,
      filterInput,
      filterText,
      actionCls,
      hasSlot,
      hasPrepend,
      filteredItems,
      useDialogFlag,
      select,
      toggle,
      openFromKeyboard,
    };
  },
  template: `
    <div class="q-dropdown-menu">
      <div class="q-dropdown-menu-inner">
        <button
          type="button"
          class="q-dropdown-menu-action touchable"
          :class="actionCls"
          :disabled="disabled || loading"
          :aria-expanded="expanded ? 'true' : 'false'"
          :aria-busy="loading ? 'true' : undefined"
          aria-haspopup="menu"
          @click.stop="toggle"
          @keydown.down.prevent.stop="openFromKeyboard"
        >
          <div v-if="loading" class="ocean" aria-hidden="true"><div class="wave"></div></div>
          <div v-if="hasPrepend" class="q-dropdown-prepend"><slot name="prepend" /></div>
          <div v-if="!hideSelected && selectedItem && !hasSlot" class="q-dropdown-selected">
            <img v-if="selectedItem.image" class="menu-image" :src="selectedItem.image" :alt="selectedItem.title" />
            <component :is="selectedItem.icon" v-else-if="selectedItem.icon" class="icon menu-icon" />
            <div v-if="!hideActionLabel" class="menu-title q-text-body-text">{{ selectedItem ? selectedItem.title : placeholder || "Select ..." }}</div>
          </div>
          <slot />
          <div v-if="hideSelected || hasSlot" class="empty-block"></div>
          <QIconChevronDown class="icon chevron-icon" />
        </button>
        <div v-if="!useDialogFlag" ref="menuWrapper">
          <Transition>
            <QMenu v-if="expanded" :items="items" :focused-index="focusedIndex" @action="select" />
          </Transition>
        </div>
        <QDialog v-if="useDialogFlag" v-model="expanded" no-frame>
          <div class="q-menu-popup-body">
            <div v-if="useFilter" class="filter-area">
              <QInput ref="filterInput" v-model="filterText" class="filter-input" placeholder="Filter" />
            </div>
            <div class="scroll-area" :style="{ height: scrollHeight, maxHeight: scrollHeight }">
              <QMenu v-if="filteredItems.length > 0" :items="filteredItems" :focused-index="focusedIndex" persistent no-frame no-shadow @action="select" />
              <div v-else class="empty-hint flow place-center" v-text="emptyHit"></div>
            </div>
          </div>
        </QDialog>
      </div>
    </div>
  `,
};

export default QDropdownMenu;
