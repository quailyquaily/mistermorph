import { computed } from "vue";
import { translate } from "../core/context";
import AppDialogShell from "./AppDialogShell";
import RawTextEditorDialogContent, { rawTextEditorDialogContentProps } from "./RawTextEditorDialogContent";

const RawTextEditorDialog = {
  components: {
    AppDialogShell,
    RawTextEditorDialogContent,
  },
  emits: ["close", "save", "update:modelValue"],
  props: {
    open: {
      type: Boolean,
      default: false,
    },
    title: {
      type: String,
      default: "",
    },
    ...rawTextEditorDialogContentProps,
  },
  setup(props, { emit }) {
    const t = translate;
    const resolvedTitle = computed(() => props.title || t("repair_editor_title"));

    function close() {
      emit("close");
    }

    function save() {
      emit("save");
    }

    function onInput(value) {
      emit("update:modelValue", String(value || ""));
    }

    return {
      t,
      close,
      save,
      onInput,
      resolvedTitle,
      webDialogOpen: computed(() => props.open),
    };
  },
  template: `
    <AppDialogShell
      :modelValue="webDialogOpen"
      :title="resolvedTitle"
      width="920px"
      :closeDisabled="saving"
      @close="close"
    >
      <RawTextEditorDialogContent
        :path="path"
        :modelValue="modelValue"
        :loading="loading"
        :saving="saving"
        @update:modelValue="onInput"
        @save="save"
      />
    </AppDialogShell>
  `,
};

export default RawTextEditorDialog;
