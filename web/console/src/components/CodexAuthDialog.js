import { computed } from "vue";
import { translate } from "../core/context";
import AppDialogShell from "./AppDialogShell";
import DeviceAuthDialogContent, { deviceAuthStateProps } from "./DeviceAuthDialogContent";

export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

const CodexAuthDialog = {
  components: {
    AppDialogShell,
    DeviceAuthDialogContent,
  },
  props: {
    modelValue: Boolean,
    ...deviceAuthStateProps,
  },
  emits: ["update:modelValue", "logout"],
  setup(props, { emit }) {
    const t = translate;
    const accountLabel = computed(() => String(props.status?.account_id || "").trim());

    function close() {
      emit("update:modelValue", false);
    }

    function logout() {
      emit("logout");
    }

    return {
      t,
      CODEX_USAGE_URL,
      accountLabel,
      close,
      logout,
      webDialogOpen: computed(() => props.modelValue),
    };
  },
  template: `
    <AppDialogShell
      :modelValue="webDialogOpen"
      :title="t('settings_codex_auth_title')"
      width="560px"
      @update:modelValue="$emit('update:modelValue', $event)"
      :closeDisabled="busy"
      @close="close"
    >
      <DeviceAuthDialogContent
        :loading="loading"
        :busy="busy"
        :error="error"
        :status="status"
        :summary="summary"
        :loginSession="loginSession"
        :verificationURL="verificationURL"
        :userCode="userCode"
        :loginExpiresLabel="loginExpiresLabel"
        :accountLabel="accountLabel"
        accountIntroKey="settings_codex_auth_account_intro"
        sessionKey="settings_codex_auth_session"
        statusReadyKey="settings_codex_auth_status_ready"
        statusNeedsLoginKey="settings_codex_auth_status_needs_login"
        setDefaultNoteKey="settings_codex_auth_set_default_note"
        loginPendingKey="settings_codex_auth_login_pending"
        loginExpiresKey="settings_codex_auth_login_expires"
        openVerificationKey="settings_codex_auth_open_verification"
        userCodeKey="settings_codex_auth_user_code"
        extraActionKey="settings_codex_auth_usage"
        :extraActionURL="CODEX_USAGE_URL"
        @logout="logout"
      />
    </AppDialogShell>
  `,
};

export default CodexAuthDialog;
