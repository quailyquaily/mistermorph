import { computed, ref, watch } from "vue";

import AppButton from "./AppButton";
import AppDialog from "./AppDialog";

// AppMessageDialog: a short notice in a dialog: an icon (a component, or an emoji), a title, a line
// of text and up to two buttons, each { name, label, class, action }.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const AppMessageDialog = {
  name: "AppMessageDialog",
  components: { AppButton, AppDialog },
  props: {
    modelValue: Boolean,
    title: { type: String, default: "" },
    text: { type: String, default: "" },
    actions: { type: Array, default: () => [] },
    icon: { type: [String, Object], default: "" },
    iconEmoji: { type: String, default: "" },
    iconColor: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const show = ref(props.modelValue);
    const acts = computed(() => props.actions.slice(0, 2));
    watch(
      () => props.modelValue,
      (value) => {
        show.value = value;
      },
    );
    function closeDialog() {
      show.value = false;
      emit("update:modelValue", false);
    }
    return { show, acts, closeDialog };
  },
  template: `
    <AppDialog v-model="show" class="message-dialog-wrapper" width="500px" @close="closeDialog">
      <div class="message-dialog-content">
        <div class="mt-6 mb-4 text-center">
          <div class="icon-wrapper" :class="iconColor">
            <span v-if="iconEmoji" class="icon-emoji">{{ iconEmoji }}</span>
            <component :is="icon" v-else class="icon" />
          </div>
        </div>
        <div class="q-text-body mb-2 text-center font-bold">{{ title }}</div>
        <div class="q-text-body-text mb-6 text-center message-dialog-text q-c-dark-2">{{ text }}</div>
        <div class="buttons grid gap-4" :class="'grid-cols-' + acts.length">
          <AppButton v-for="act in acts" :key="act.name" :class="act.class" @click="act.action">{{ act.label }}</AppButton>
        </div>
      </div>
    </AppDialog>
  `,
};

export default AppMessageDialog;
