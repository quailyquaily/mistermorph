// A file attached to the composer or to a sent message, shown in a dialog: an image, a PDF (in a
// web view, where the Vue console used an iframe), or text; with previous and next when several.
// What it shows and where from is components/chat/filePreview.ts: an attachment not sent yet shows
// from the device (an image), anything else from the agent; a file it cannot show says so.
import { Image, Scroll, Text, View, WebView } from "nsh";
import { Button, Modal } from "../../components/ui";
import { t } from "../../components/chat/i18n";
import type { ChatController } from "./chatController";

export function FilePreviewDialog(props: { c: ChatController }) {
  const c = props.c;
  const state = () => c.filePreview();
  return (
    <Modal
      open={state().open}
      onClose={() => c.closeComposerFilePreview()}
      title={state().name}
      size="xl"
      scroll={false}
      closeLabel={t("action_close")}
      testID="chat-file-preview"
    >
      <View class="gap-3" style={{ minHeight: state().kind === "image" ? 120 : 420 }}>
        <If when={state().loading}>
          <Text class="text-sm text-muted-foreground">{t("chat_composer_file_preview_loading")}</Text>
        </If>
        <If when={!state().loading && state().kind === "image" && state().url}>
          <Scroll style={{ maxHeight: 560 }}>
            <Image src={state().url} accessibilityLabel={state().name} class="w-full" style={{ height: 480, objectFit: "contain" }} testID="chat-file-preview-image" />
          </Scroll>
        </If>
        <If when={!state().loading && state().kind === "pdf" && state().url}>
          <WebView src={state().url} accessibilityLabel={state().name} class="w-full" style={{ height: 560 }} testID="chat-file-preview-pdf" />
        </If>
        <If when={!state().loading && state().kind === "text"}>
          <Scroll class="rounded-(--radius) border border-line-faint bg-paper" style={{ maxHeight: 560 }}>
            <View selectable class="p-3">
              <Text class="font-mono text-xs text-foreground" testID="chat-file-preview-text">
                {state().text}
              </Text>
            </View>
          </Scroll>
        </If>
        <If when={!state().loading && !state().kind && state().error}>
          <Text role="alert" class="text-sm text-danger" testID="chat-file-preview-error">
            {state().error}
          </Text>
        </If>
        <If when={state().items.length > 1}>
          <View class="flex-row justify-between" accessibilityLabel={t("chat_composer_file_preview_navigation")}>
            <Button
              variant="plain"
              size="sm"
              iconOnly
              icon="PhArrowLeft"
              title={t("chat_composer_file_preview_previous")}
              disabled={state().index <= 0}
              onPress={() => c.navigateComposerFilePreview(-1)}
            />
            <Button
              variant="plain"
              size="sm"
              iconOnly
              icon="PhArrowRight"
              title={t("chat_composer_file_preview_next")}
              disabled={state().index < 0 || state().index >= state().items.length - 1}
              onPress={() => c.navigateComposerFilePreview(1)}
            />
          </View>
        </If>
      </View>
    </Modal>
  );
}
