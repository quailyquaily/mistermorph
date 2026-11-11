// The topic rename dialog: the topic's name in a field to edit, a Regenerate button that puts a
// generated name in the field, and Save, which alone renames the topic (pages/chat/topicRename.ts).
// Enter in the field saves; Escape, the close button, the scrim and Cancel leave the name as it was.
// A save under way holds the dialog until it answers.
import { Text, View } from "nsh";
import { Button, Modal, TextField } from "../../components/ui";
import { InlineNotice } from "../../components/settings/DialogShell";
import { t } from "../../components/chat/i18n";
import { TOPIC_TITLE_MAX_LENGTH, type TopicRename } from "./topicRename";

export function TopicRenameDialog(props: { rename: TopicRename; regenerateDisabled: boolean }) {
  const r = props.rename;
  return (
    <Modal
      open={r.open()}
      onClose={() => r.close()}
      title={t("chat_topic_rename_title")}
      closeLabel={t("action_close")}
      size="sm"
      testID="chat-topic-rename-dialog"
      footer={
        <>
          <Button variant="outlined" label={t("action_cancel")} disabled={r.saving()} onPress={() => r.close()} testID="chat-topic-rename-cancel" />
          <Button
            variant="primary"
            label={t("action_save")}
            loading={r.saving()}
            disabled={r.saveDisabled()}
            onPress={() => void r.save()}
            testID="chat-topic-rename-save"
          />
        </>
      }
    >
      <View class="flex-row items-start gap-2">
        <TextField
          class="flex-1"
          value={r.draft()}
          onChange={(value) => r.setDraft(value)}
          onSubmit={() => void r.save()}
          placeholder={t("chat_topic_rename_placeholder")}
          accessibilityLabel={t("chat_topic_rename_label")}
          readonly={r.saving()}
          maxLength={TOPIC_TITLE_MAX_LENGTH}
          autoFocus
          testID="chat-topic-rename-input"
        />
        <Button
          variant="outlined"
          icon="PhMagicWand"
          label={t("chat_topic_rename_regenerate")}
          title={t("chat_topic_rename_regenerate_hint")}
          loading={r.suggesting()}
          disabled={props.regenerateDisabled}
          onPress={() => void r.regenerate()}
          testID="chat-topic-rename-regenerate"
        />
      </View>
      <Text class="text-xs text-muted-foreground">{t("chat_topic_rename_note")}</Text>
      <If when={r.error()}>
        <InlineNotice type="error" text={r.error()} testID="chat-topic-rename-error" />
      </If>
    </Modal>
  );
}
