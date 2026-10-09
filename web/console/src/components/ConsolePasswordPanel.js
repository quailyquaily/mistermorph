import { ref, watch } from "vue";

import SettingDialog from "./SettingDialog";

export default {
  name: "ConsolePasswordPanel",
  components: { SettingDialog },
  props: {
    configured: { type: Boolean, default: false },
    saving: { type: Boolean, default: false },
  },
  emits: ["save"],
  setup(props, { emit }) {
    const open = ref(false);
    const password = ref("");
    const confirmation = ref("");
    const error = ref("");

    watch(open, (value) => {
      if (!value) {
        password.value = "";
        confirmation.value = "";
        error.value = "";
      }
    });

    function submit() {
      if (!password.value) {
        error.value = "Password cannot be empty.";
        return;
      }
      if (password.value !== confirmation.value) {
        error.value = "Passwords do not match.";
        return;
      }
      emit("save", { new_password: password.value });
      open.value = false;
    }

    return { open, password, confirmation, error, submit };
  },
  template: `
    <AppSection variant="boxed" class="config-settings-group" title="Web Console sign-in">
      <template #meta>
        <span class="config-settings-restart">Restart required</span>
        Protects browser access to this Console. It is separate from the incoming Runtime API access token.
      </template>
      <template #actions>
        <QButton class="plain xs" :disabled="saving" @click="open = true">
          {{ configured ? "Change password" : "Set password" }}
        </QButton>
      </template>
      <SettingDialog
        v-model="open"
        title="Set Web Console password"
        width="460px"
        :saving="saving"
        @save="submit"
      >
        <div class="settings-password-dialog">
          <div v-if="error" class="config-settings-error" role="alert">{{ error }}</div>
          <label class="settings-field">
            <span class="settings-field-label">New password</span>
            <QInput v-model="password" inputType="password" :disabled="saving" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">Confirm password</span>
            <QInput v-model="confirmation" inputType="password" :disabled="saving" @keyup.enter="submit" />
          </label>
        </div>
      </SettingDialog>
    </AppSection>
  `,
};
