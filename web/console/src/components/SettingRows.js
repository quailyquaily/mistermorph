import { computed, nextTick, ref, watch } from "vue";
import SettingMenu from "./SettingMenu";
import { ROW_MODES } from "../core/setting-rows";
import "./SettingFields.css";

// Lists and maps edited as rows. Each row is one box: its values are parts of that box, split by a
// hairline, and removing the row is the last part. Rows read and write the same draft text the panel
// already stores (see core/setting-rows.js).
export default {
  components: { SettingMenu },
  props: {
    modelValue: { type: String, default: "" },
    mode: { type: String, default: "list" },
    disabled: Boolean,
    label: { type: String, default: "" },
    placeholder: { type: String, default: "" },
    addLabel: { type: String, default: "Add" },
    // identities mode: [{ title, value, placeholder }]
    platforms: { type: Array, default: () => [] },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const spec = computed(() => ROW_MODES[props.mode] || ROW_MODES.list);
    const rows = ref([]);
    // JSON the rows cannot show is left to the raw editor in the fallback slot instead of being dropped.
    const unreadable = ref(false);
    const rowBoxes = ref([]);
    const menu = ref(null);
    const menuRow = ref(-1);

    function blankRow() {
      const row = {};
      for (const column of spec.value.columns) {
        row[column.key] = column.select ? props.platforms[0]?.value || "" : "";
      }
      return row;
    }

    watch(
      () => props.modelValue,
      (value) => {
        if (value === spec.value.serialize(rows.value)) return;
        const parsed = spec.value.parse(value, props.platforms);
        unreadable.value = parsed === null || parsed === undefined;
        rows.value = unreadable.value ? [] : parsed;
      },
      { immediate: true },
    );

    function emitRows() {
      emit("update:modelValue", spec.value.serialize(rows.value));
    }

    function updateCell(index, key, value) {
      if (props.disabled) return;
      rows.value[index][key] = String(value ?? "");
      emitRows();
    }

    async function addRow() {
      if (props.disabled) return;
      rows.value.push(blankRow());
      await nextTick();
      rowBoxes.value[rows.value.length - 1]?.querySelector("input")?.focus();
    }

    function removeRow(index) {
      if (props.disabled) return;
      rows.value.splice(index, 1);
      emitRows();
    }

    function platformItem(value) {
      return props.platforms.find((item) => item.value === value) || { title: value || "Other", value };
    }

    function cellPlaceholder(row, column) {
      if (props.mode === "identities") return platformItem(row.platform).placeholder || "";
      return column.placeholder || props.placeholder || "";
    }

    function rowError(row) {
      return spec.value.rowError ? spec.value.rowError(row) : "";
    }

    function openPlatform(index) {
      if (props.disabled) return;
      menuRow.value = menuRow.value === index ? -1 : index;
    }

    function onPlatformKey(event, index) {
      if (props.disabled) return;
      if (menuRow.value === index && menu.value?.handleKey(event)) return;
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        menuRow.value = index;
      }
    }

    function pickPlatform(item) {
      if (menuRow.value < 0) return;
      updateCell(menuRow.value, "platform", item.value);
      menuRow.value = -1;
    }

    function setBox(index, element) {
      if (element) rowBoxes.value[index] = element;
    }

    return {
      spec, rows, unreadable, rowBoxes, menu, menuRow,
      updateCell, addRow, removeRow, platformItem, cellPlaceholder, rowError,
      openPlatform, onPlatformKey, pickPlatform, setBox,
    };
  },
  template: `
    <div class="sf sf-rows" role="group" :aria-label="label || undefined">
      <slot v-if="unreadable" name="fallback" />
      <template v-else>
        <div v-for="(row, index) in rows" :key="index" class="sf-row">
          <div
            :ref="(element) => setBox(index, element)"
            class="sf-box"
            :class="{ 'is-disabled': disabled, 'is-invalid': rowError(row), 'is-open': menuRow === index }"
          >
            <template v-for="(column, columnIndex) in spec.columns" :key="column.key">
              <span v-if="columnIndex > 0" class="sf-sep" aria-hidden="true"></span>
              <button
                v-if="column.select"
                type="button"
                class="sf-part is-lead"
                :disabled="disabled"
                aria-haspopup="listbox"
                :aria-expanded="menuRow === index ? 'true' : 'false'"
                :aria-label="(label ? label + ': ' : '') + 'platform, ' + platformItem(row[column.key]).title"
                @click="openPlatform(index)"
                @keydown="onPlatformKey($event, index)"
              >
                {{ platformItem(row[column.key]).title }}
                <PhCaretDown class="sf-chevron" />
              </button>
              <input
                v-else
                class="sf-input"
                :class="{ 'is-mono': column.mono || mode === 'list' || mode === 'env' }"
                :value="row[column.key]"
                :type="column.secret ? 'password' : 'text'"
                :placeholder="cellPlaceholder(row, column)"
                :disabled="disabled"
                :aria-label="(label ? label + ': ' : '') + (column.placeholder || column.key) + ' ' + (index + 1)"
                spellcheck="false"
                autocomplete="off"
                @input="updateCell(index, column.key, $event.target.value)"
              />
            </template>
            <button
              type="button"
              class="sf-part is-quiet"
              :disabled="disabled"
              :title="'Remove'"
              :aria-label="'Remove row ' + (index + 1)"
              @click="removeRow(index)"
            >
              <PhX class="sf-icon" />
            </button>
          </div>
          <p v-if="rowError(row)" class="sf-error">{{ rowError(row) }}</p>
        </div>
        <button type="button" class="sf-add" :disabled="disabled" @click="addRow">
          <PhPlus class="sf-icon" />
          {{ addLabel }}
        </button>
        <SettingMenu
          ref="menu"
          :open="menuRow >= 0"
          :anchor="rowBoxes[menuRow] || null"
          :items="platforms"
          :selected="menuRow >= 0 ? rows[menuRow]?.platform : null"
          :label="label ? label + ' platform' : 'Platform'"
          @select="pickPlatform"
          @close="menuRow = -1"
        />
      </template>
    </div>
  `,
};
