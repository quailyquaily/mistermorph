import { computed, ref, watch } from "vue";
import AppDialogShell from "./AppDialogShell";
import SetupPickerDialogContent, { setupPickerDialogContentProps } from "./SetupPickerDialogContent";

const SetupPickerDialog = {
  components: {
    AppDialogShell,
    SetupPickerDialogContent,
  },
  props: {
    modelValue: Boolean,
    title: {
      type: String,
      default: "",
    },
    ...setupPickerDialogContentProps,
  },
  emits: ["update:modelValue", "select"],
  setup(props, { emit }) {
    const resolvedTitle = computed(() => String(props.title || "").trim());

    function close() {
      emit("update:modelValue", false);
    }

    function selectItem(item) {
      emit("select", item);
      close();
    }

    // Each opening starts the picker afresh (filter cleared, selection scrolled into view).
    const openCount = ref(0);
    watch(
      () => props.modelValue,
      (open) => {
        if (open) openCount.value += 1;
      },
      { immediate: true }
    );

    return {
      resolvedTitle,
      webDialogOpen: computed(() => props.modelValue),
      close,
      selectItem,
      openCount,
    };
  },
  template: `
    <AppDialogShell
      :modelValue="webDialogOpen"
      :title="resolvedTitle"
      width="560px"
      @update:modelValue="$emit('update:modelValue', $event)"
      :closeDisabled="loading"
      @close="close"
    >
      <SetupPickerDialogContent
        :items="items"
        :loading="loading"
        :error="error"
        :filterPlaceholder="filterPlaceholder"
        :emptyText="emptyText"
        :showValue="showValue"
        :selectedValue="selectedValue"
        :groupByPrefix="groupByPrefix"
        :allowCustom="allowCustom"
        :customLabel="customLabel"
        :resetKey="openCount"
        @select="selectItem"
        @close="close"
      />
    </AppDialogShell>
  `,
};

export default SetupPickerDialog;
