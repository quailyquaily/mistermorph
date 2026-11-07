// The Web Console password (the Vue console's ConsolePasswordPanel): Set or Change opens a dialog
// asking for the new password twice. The copy is the Vue panel's (it had no translations).
//
// Vue to nsh: `save` is `onSave({ new_password })`.
import { effect, signal, Text, untracked, View } from "nsh";
import { Button, TextField } from "../ui";
import { RestartTag, SettingsCard } from "../settings-page/parts";
import { SettingDialog } from "./SettingDialog";

export interface ConsolePasswordPanelProps {
  /** A password is set. */
  configured?: boolean;
  saving?: boolean;
  /** Saves the console config change `{ new_password }`. */
  onSave?: (values: { new_password: string }) => void;
}

export function ConsolePasswordPanel(props: ConsolePasswordPanelProps) {
  const open = signal(false);
  const password = signal("");
  const confirmation = signal("");
  const error = signal("");

  // Closing drops what was typed.
  effect(() => {
    if (!open()) {
      untracked(() => {
        password.set("");
        confirmation.set("");
        error.set("");
      });
    }
  });

  function submit() {
    const value = untracked(password);
    if (!value) {
      error.set("Password cannot be empty.");
      return;
    }
    if (value !== untracked(confirmation)) {
      error.set("Passwords do not match.");
      return;
    }
    props.onSave?.({ new_password: value });
    open.set(false);
  }

  return (
    <SettingsCard
      title="Web Console sign-in"
      headOnly
      metaLead={<RestartTag />}
      meta="Protects browser access to this Console. It is separate from the incoming Runtime API access token."
      actions={
        <Button
          variant="plain"
          size="xs"
          label={props.configured ? "Change password" : "Set password"}
          disabled={props.saving}
          onPress={() => open.set(true)}
          testID="console-password-open"
        />
      }
    >
      <SettingDialog
        open={open()}
        onOpenChange={(value) => open.set(value)}
        title="Set Web Console password"
        size="sm"
        saving={props.saving}
        onSave={submit}
        testID="console-password-dialog"
      >
        <View class="gap-3">
          <If when={error()}>
            <Text class="text-sm text-danger" role="alert" testID="console-password-error">
              {error()}
            </Text>
          </If>
          <TextField
            label="New password"
            value={password()}
            masked
            disabled={props.saving}
            onChange={(value) => password.set(value)}
            testID="console-password-new"
          />
          <TextField
            label="Confirm password"
            value={confirmation()}
            masked
            disabled={props.saving}
            onChange={(value) => confirmation.set(value)}
            onSubmit={submit}
            testID="console-password-confirm"
          />
        </View>
      </SettingDialog>
    </SettingsCard>
  );
}
