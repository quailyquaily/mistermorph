import { computed } from "vue";

// QMenu: a list of actions. Each item has a title (and maybe a subtitle, an icon component or an
// image) or is a divider; disabled and danger items are marked. Choosing one, by click, Enter or
// Space, runs its action and emits "action". focusedIndex counts actionable items only and marks
// that one focused; persistent keeps every item in the tab order.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const QMenu = {
  name: "QMenu",
  props: {
    items: { type: Array, required: true },
    persistent: { type: Boolean, default: false },
    noFrame: { type: Boolean, default: false },
    noShadow: { type: Boolean, default: false },
    focusedIndex: { type: Number, default: -1 },
  },
  emits: ["action"],
  setup(props, { emit }) {
    const menuCls = computed(() =>
      [props.persistent ? "persistent" : "", props.noFrame ? "no-frame" : "", props.noShadow ? "no-shadow" : ""].filter(Boolean).join(" "),
    );
    const focusedItemIndex = computed(() => {
      if (props.focusedIndex < 0) {
        return -1;
      }
      let nav = -1;
      for (let i = 0; i < props.items.length; i++) {
        const item = props.items[i];
        if (!item.divider && !item.disabled && ++nav === props.focusedIndex) {
          return i;
        }
      }
      return -1;
    });
    function itemCls(item, index) {
      return {
        disabled: item.disabled,
        danger: item.danger,
        "with-icon": item.icon,
        "with-image": item.image,
        "with-divider": item.divider,
        focused: index === focusedItemIndex.value,
      };
    }
    function itemTabindex(item, index) {
      if (item.divider || item.disabled) {
        return undefined;
      }
      if (index === focusedItemIndex.value || (props.persistent && focusedItemIndex.value < 0)) {
        return 0;
      }
      return -1;
    }
    function doAction(item) {
      if (item.divider || item.disabled) {
        return;
      }
      item.action?.(item);
      emit("action", item);
    }
    return { menuCls, itemCls, itemTabindex, doAction };
  },
  template: `
    <div class="q-menu" :class="menuCls" role="menu">
      <div
        v-for="(item, index) in items"
        :key="'q-menu-item-' + item.id"
        class="q-menu-item"
        :class="itemCls(item, index)"
        :role="item.divider ? 'separator' : 'menuitem'"
        :aria-disabled="item.disabled ? 'true' : undefined"
        :tabindex="itemTabindex(item, index)"
        @click="doAction(item)"
        @keydown.enter.prevent="doAction(item)"
        @keydown.space.prevent="doAction(item)"
      >
        <div v-if="item.divider" class="q-menu-item-divider"></div>
        <div v-else class="q-menu-item-inner">
          <img v-if="item.image" class="q-menu-image" :src="item.image" :alt="item.title" />
          <component :is="item.icon" v-else-if="item.icon" class="q-menu-icon" />
          <div class="q-menu-item-content">
            <div class="q-menu-title q-text-body-text">{{ item.title }}</div>
            <div v-if="item.subtitle" class="q-menu-subtitle q-text-caption q-c-dark-3">{{ item.subtitle }}</div>
          </div>
        </div>
      </div>
    </div>
  `,
};

export default QMenu;
