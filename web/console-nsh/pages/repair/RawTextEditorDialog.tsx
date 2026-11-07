// Edits a setup file's source as plain text (the Vue console's RawTextEditorDialog): its path, the
// text, and Save. While it saves, the text and the close button wait.
import { Text, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { Button, Modal, ProgressBar, TextField } from "../../components/ui";

const t = translate as (key: string, vars?: Record<string, unknown>) => string;

export interface RawTextEditorDialogProps {
  open: boolean;
  title?: string;
  path?: string;
  value: string;
  loading?: boolean;
  saving?: boolean;
  onChange?: (value: string) => void;
  onClose?: () => void;
  onSave?: () => void;
}

export function RawTextEditorDialog(props: RawTextEditorDialogProps) {
  const close = () => {
    if (props.saving) return;
    props.onClose?.();
  };
  return (
    <Modal
      open={props.open}
      onClose={close}
      title={props.title || t("repair_editor_title")}
      size="xl"
      closeLabel={t("action_close")}
      testID="raw-text-editor"
      footer={
        <Button
          variant="primary"
          size="sm"
          label={t("action_save")}
          loading={props.saving}
          disabled={props.loading || props.saving}
          onPress={() => props.onSave?.()}
          testID="raw-text-save"
        />
      }
    >
      <If when={props.path}>
        <View selectable>
          <Text class="font-mono text-xs text-muted-foreground">{props.path}</Text>
        </View>
      </If>
      <If
        when={!props.loading}
        else={<ProgressBar indeterminate label={t("repair_editor_title")} />}
      >
        <TextField
          value={props.value}
          onChange={(value) => props.onChange?.(String(value || ""))}
          multiline
          rows={20}
          mono
          disabled={props.saving}
          accessibilityLabel={props.title || t("repair_editor_title")}
          testID="raw-text-body"
        />
      </If>
    </Modal>
  );
}
