import { computed, nextTick, onMounted, ref, watch } from "vue";
import { translate } from "../core/context";
import { buildPickerRows, highlightParts } from "../core/setup-picker";
import "./SetupPickerDialog.css";

export const setupPickerDialogContentProps = {
  items: {
    type: Array,
    default: () => [],
  },
  loading: Boolean,
  error: {
    type: String,
    default: "",
  },
  filterPlaceholder: {
    type: String,
    default: "",
  },
  emptyText: {
    type: String,
    default: "",
  },
  showValue: {
    type: Boolean,
    default: true,
  },
  resetKey: {
    type: String,
    default: "",
  },
  // The value in use: marked, and scrolled to when the list opens.
  selectedValue: {
    type: String,
    default: "",
  },
  // Group "vendor/name" values under their vendor, showing only the name in each row.
  groupByPrefix: Boolean,
  // Offer the filter text itself when it matches no value exactly.
  allowCustom: Boolean,
  customLabel: {
    type: String,
    default: "",
  },
};

const SetupPickerDialogContent = {
  props: setupPickerDialogContentProps,
  emits: ["select", "close"],
  setup(props, { emit }) {
    const query = ref("");
    const active = ref(0);
    const root = ref(null);

    const rows = computed(() =>
      buildPickerRows(props.items, {
        query: query.value,
        groupByPrefix: props.groupByPrefix,
        allowCustom: props.allowCustom,
        labels: {
          avoid: translate("setup_picker_group_avoid"),
          other: translate("setup_picker_group_other"),
        },
      })
    );

    function rowAt(index) {
      for (const group of rows.value.groups) {
        const row = group.items.find((item) => item.index === index);
        if (row) {
          return row.item;
        }
      }
      const custom = rows.value.custom;
      if (custom && custom.index === index) {
        return { id: `custom:${custom.value}`, title: custom.value, value: custom.value, note: "" };
      }
      return null;
    }

    function isSelected(item) {
      const selected = String(props.selectedValue || "").trim();
      return selected !== "" && String(item?.value || "") === selected;
    }

    function selectedIndex() {
      for (const group of rows.value.groups) {
        const row = group.items.find((item) => isSelected(item.item));
        if (row) {
          return row.index;
        }
      }
      return 0;
    }

    function scrollActiveIntoView() {
      nextTick(() => {
        const el = root.value?.querySelector(`[data-picker-index="${active.value}"]`);
        el?.scrollIntoView?.({ block: "nearest" });
      });
    }

    function focusFilter() {
      nextTick(() => {
        root.value?.querySelector(".setup-picker-filter input")?.focus?.();
      });
    }

    function selectItem(item) {
      if (item) {
        emit("select", item);
      }
    }

    function onKeydown(event) {
      const count = rows.value.count;
      if (event.key === "ArrowDown" && count > 0) {
        event.preventDefault();
        active.value = (active.value + 1) % count;
        scrollActiveIntoView();
      } else if (event.key === "ArrowUp" && count > 0) {
        event.preventDefault();
        active.value = (active.value - 1 + count) % count;
        scrollActiveIntoView();
      } else if (event.key === "Enter") {
        event.preventDefault();
        selectItem(rowAt(active.value));
      } else if (event.key === "Escape") {
        event.preventDefault();
        emit("close");
      }
    }

    // A new filter starts at the first match; opening the list starts at the value in use.
    watch(query, () => {
      active.value = 0;
    });

    function resetToSelected() {
      active.value = selectedIndex();
      scrollActiveIntoView();
    }

    watch(
      () => props.resetKey,
      () => {
        query.value = "";
        focusFilter();
        nextTick(resetToSelected);
      }
    );
    watch(
      () => [props.loading, props.items],
      () => {
        if (!props.loading && !query.value) {
          focusFilter();
          resetToSelected();
        }
      }
    );

    onMounted(() => {
      focusFilter();
      resetToSelected();
    });

    return {
      root,
      query,
      active,
      rows,
      isSelected,
      highlightParts,
      selectItem,
      rowAt,
      onKeydown,
    };
  },
  template: `
    <section ref="root" class="setup-picker-dialog" @keydown="onKeydown">
      <QInput
        v-model="query"
        class="setup-picker-filter"
        :placeholder="filterPlaceholder"
        :disabled="loading"
      />

      <QProgress v-if="loading" :infinite="true" />
      <QFence v-if="error" type="danger" icon="PhXCircle" :text="error" />

      <div v-if="!loading" class="setup-picker-list" role="listbox">
        <template v-for="group in rows.groups" :key="group.id">
          <div v-if="group.title" class="setup-picker-group">
            <span class="setup-picker-group-title">{{ group.title }}</span>
            <span class="setup-picker-group-count">{{ group.items.length }}</span>
          </div>
          <button
            v-for="row in group.items"
            :key="row.index + ':' + (row.item.id || row.item.value || row.item.title)"
            type="button"
            role="option"
            class="setup-picker-item"
            :class="{ 'is-active': active === row.index, 'is-selected': isSelected(row.item), 'is-grouped': !!group.title, 'is-avoid': group.verdict === 'avoid' }"
            :aria-selected="isSelected(row.item) ? 'true' : 'false'"
            :data-picker-index="row.index"
            tabindex="-1"
            @mousemove="active = row.index"
            @click="selectItem(row.item)"
          >
            <span class="setup-picker-item-copy">
              <span class="setup-picker-item-title"><template v-for="(part, i) in highlightParts(row.label, query)" :key="i"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
              <span v-if="row.item.note" class="setup-picker-item-note">{{ row.item.note }}</span>
              <code v-if="showValue && row.item.value" class="setup-picker-item-value">{{ row.item.value }}</code>
            </span>
            <span v-if="row.item.meta" class="setup-picker-item-meta">{{ row.item.meta }}</span>
            <PhCheck v-if="isSelected(row.item)" class="setup-picker-item-check" aria-hidden="true" />
          </button>
        </template>

        <p v-if="rows.groups.length === 0 && !rows.custom && !error" class="setup-picker-empty">{{ emptyText }}</p>

        <button
          v-if="rows.custom"
          type="button"
          role="option"
          class="setup-picker-item setup-picker-custom"
          :class="{ 'is-active': active === rows.custom.index }"
          :data-picker-index="rows.custom.index"
          tabindex="-1"
          @mousemove="active = rows.custom.index"
          @click="selectItem(rowAt(rows.custom.index))"
        >
          <span class="setup-picker-item-title">{{ customLabel ? customLabel.replace('{value}', rows.custom.value) : rows.custom.value }}</span>
          <span class="setup-picker-item-key" aria-hidden="true">↵</span>
        </button>
      </div>
    </section>
  `,
};

export default SetupPickerDialogContent;
