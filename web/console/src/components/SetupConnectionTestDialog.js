import { computed } from "vue";
import AppDialogShell from "./AppDialogShell";
import SetupConnectionTestDialogContent, {
  setupConnectionTestDialogContentProps,
} from "./SetupConnectionTestDialogContent";
import { translate } from "../core/context";

const SetupConnectionTestDialog = {
  components: {
    AppDialogShell,
    SetupConnectionTestDialogContent,
  },
  props: {
    modelValue: Boolean,
    ...setupConnectionTestDialogContentProps,
  },
  emits: ["update:modelValue", "retry"],
  setup(props, { emit }) {
    const t = translate;

    function close() {
      emit("update:modelValue", false);
    }

    function retry() {
      emit("retry");
    }

    return {
      t,
      close,
      retry,
      webDialogOpen: computed(() => props.modelValue),
    };
  },
  template: `
    <AppDialogShell
      :modelValue="webDialogOpen"
      :title="t('setup_llm_test_title')"
      width="560px"
      @update:modelValue="$emit('update:modelValue', $event)"
      @close="close"
    >
      <SetupConnectionTestDialogContent
        :loading="loading"
        :error="error"
        :benchmarks="benchmarks"
        :provider="provider"
        :apiBase="apiBase"
        :model="model"
        :showIntro="showIntro"
        @retry="retry"
        @close="close"
      />
    </AppDialogShell>
  `,
};

export default SetupConnectionTestDialog;
