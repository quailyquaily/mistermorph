// The topic rename dialog: the topic's name in a field to edit, a Regenerate button (its icon alone,
// as tall as the field) that puts a generated name in the field, and Save, which alone renames the
// topic (pages/chat/topicRename.ts). Enter in the field saves, keeping the focus should it fail;
// Escape, the close button, the scrim and Cancel leave the name as it was. A save under way holds
// the dialog until it answers. Cancel and Save share the footer's width equally. However it
// closes, the field lets go of the focus and the software keyboard goes down with it
// (components/shared/dialogFieldFocus.ts).
import { Text, View, type Bounds } from "nsh";
import { Button, Modal, TextField } from "../../components/ui";
import { InlineNotice } from "../../components/settings/DialogShell";
import { createDialogFieldFocus } from "../../components/shared/dialogFieldFocus";
import { t } from "../../components/chat/i18n";
import { TOPIC_TITLE_MAX_LENGTH, type TopicRename } from "./topicRename";

export type TopicRenamePart = "field" | "regenerate" | "cancel" | "save";

export function TopicRenameDialog(props: {
  rename: TopicRename;
  regenerateDisabled: boolean;
  /** Each part's frame in its row, as `onLayout` reports it (to measure the dialog). */
  onPartLayout?: (part: TopicRenamePart, bounds: Bounds) => void;
}) {
  const r = props.rename;
  const focus = createDialogFieldFocus({ session: () => r.session() });
  const layout = (part: TopicRenamePart) => (event: { bounds: Bounds }) => props.onPartLayout?.(part, event.bounds);
  return (
    <Modal
      open={r.open()}
      onClose={() => r.close()}
      title={t("chat_topic_rename_title")}
      closeLabel={t("action_close")}
      size="sm"
      testID="chat-topic-rename-dialog"
      footer={
        // Equally wide on every window (a phone's sheet makes any two actions so; this dialog keeps
        // it on the desktops too).
        <View class="flex-1 flex-row gap-2">
          <Button
            variant="outlined"
            class="flex-1"
            label={t("action_cancel")}
            disabled={r.saving()}
            onPress={() => r.close()}
            onLayout={layout("cancel")}
            testID="chat-topic-rename-cancel"
          />
          <Button
            variant="primary"
            class="flex-1"
            label={t("action_save")}
            loading={r.saving()}
            disabled={r.saveDisabled()}
            onPress={() => void r.save()}
            onLayout={layout("save")}
            testID="chat-topic-rename-save"
          />
        </View>
      }
    >
      <View class="flex-row items-start gap-2">
        <View class="flex-1" onLayout={layout("field")}>
          <TextField
            value={r.draft()}
            onChange={(value) => r.setDraft(value)}
            onSubmit={() => void r.save()}
            // Enter keeps the focus: a blank or failed save leaves the dialog to type in.
            submitBehavior="submit"
            placeholder={t("chat_topic_rename_placeholder")}
            accessibilityLabel={t("chat_topic_rename_label")}
            readonly={r.saving()}
            maxLength={TOPIC_TITLE_MAX_LENGTH}
            autoFocus
            inputRef={(node) => focus.ref(node)}
            testID="chat-topic-rename-input"
          />
        </View>
        {/* md: the field's 44pt; the label stays its accessible name, the hint its tooltip. */}
        <View onLayout={layout("regenerate")}>
          <Button
            variant="outlined"
            size="md"
            icon="PhMagicWand"
            iconOnly
            label={t("chat_topic_rename_regenerate")}
            title={t("chat_topic_rename_regenerate_hint")}
            loading={r.suggesting()}
            disabled={props.regenerateDisabled}
            onPress={() => void r.regenerate()}
            testID="chat-topic-rename-regenerate"
          />
        </View>
      </View>
      <Text class="text-xs text-muted-foreground">{t("chat_topic_rename_note")}</Text>
      <If when={r.error()}>
        <InlineNotice type="error" text={r.error()} testID="chat-topic-rename-error" />
      </If>
    </Modal>
  );
}
