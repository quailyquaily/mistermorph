// The Poke dialog of the Runtime panel (the Vue console's PokeDialogContent in AppDialogShell): a
// message for the agent's awareness loop, its size limit, and Send.
import { View } from "nsh";
import { Button, TextField } from "../ui";
import { DialogShell } from "../settings/DialogShell";
import { t } from "../../pages/settings/i18n";

export function PokeDialog(props: {
  open: boolean;
  onClose: () => void;
  body: string;
  onBodyChange: (value: string) => void;
  bodyTooLarge: boolean;
  disabled: boolean;
  error: string;
  submitDisabled: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const message = () => props.error || (props.bodyTooLarge ? t("runtime_poke_too_large") : "");
  return (
    <DialogShell open={props.open} onClose={props.onClose} title={t("runtime_poke_dialog_title")} size="lg" closeDisabled={props.submitting} testID="runtime-poke-dialog">
      <View class="gap-2">
        <TextField
          label={t("runtime_poke_body_label")}
          value={props.body}
          onChange={(value) => props.onBodyChange(value)}
          multiline
          rows={8}
          placeholder={t("runtime_poke_body_placeholder")}
          accessibilityLabel={t("runtime_poke_body_label")}
          disabled={props.disabled}
          error={message() || undefined}
          testID="runtime-poke-body"
        />
        <View class="flex-row justify-end">
          <Button
            variant="primary"
            label={t("runtime_poke_submit")}
            loading={props.submitting}
            disabled={props.submitDisabled}
            onPress={props.onSubmit}
            testID="runtime-poke-submit"
          />
        </View>
      </View>
    </DialogShell>
  );
}
