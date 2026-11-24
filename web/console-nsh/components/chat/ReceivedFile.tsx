// A file the agent sent with its reply (a task attachment): its name, a download icon button, and
// an image preview for raster images. Ported from web/console/src/components/ReceivedFile.js. Its
// preview and download state lives in a ReceivedFiles store, keyed by file, since rows recycle.
//
// A file the chat's file preview dialog can show (an image, a PDF, UTF-8 text:
// lib/core/received-files.js `canOpenReceivedFile`) also has a preview icon button beside the
// download, and pressing its name or its inline image opens the dialog on it (`onPreview`). Any
// other file (an archive, a binary) keeps the download alone.
//
// The download is the host's save (lib/platform.ts `saveFile`): a browser download, the desktop's
// save dialog, the phone app's picker for a new document. While it runs the button is busy (and
// takes no presses); once the file is written the glyph turns to a check for a moment; backing out
// of the picker leaves the row as it was; a failure says why under the row, and the button tries again.
import { effect, Image, platform, Text, untracked, View } from "nsh";
import { Button, TipButton, type ButtonSize } from "../ui";
import { canOpenReceivedFile, canPreviewReceivedFile, receivedFileURL } from "../../lib/core/received-files.js";
import { t } from "./i18n";
import { SAVE_UNAVAILABLE } from "../../lib/platform";
import { keyedState } from "./rowState";
import { fetchConsoleBlob, saveConsoleFile } from "./files";
import { CARD_CORNERS } from "../corners";

/** How long the check shows after a save. */
export const SAVED_MS = 2000;

/**
 * The download button's size: 32pt beside the name on a desktop, the 44pt touch target on a touch
 * screen (a phone, a tablet).
 */
export function receivedFileButtonSize(touch: boolean): ButtonSize {
  return touch ? "md" : "xs";
}

export interface ReceivedFileInfo {
  id: string;
  name: string;
  content_type?: string;
  [key: string]: unknown;
}

interface FileState {
  previewURL: string;
  error: string;
  busy: boolean;
  requested: boolean;
  /** Saved a moment ago: the check shows. */
  saved: boolean;
}

const EMPTY: FileState = { previewURL: "", error: "", busy: false, requested: false, saved: false };

/** The ReceivedFiles key of a file the agent sent: its card's and the preview dialog's. */
export function receivedFileKey(topicID: unknown, taskID: unknown, fileID: unknown) {
  return `${topicID}|${taskID}|${fileID}`;
}

/** What a failed save says: why, or that this app cannot save files at all. */
function saveError(error: unknown) {
  if ((error as { code?: string })?.code === SAVE_UNAVAILABLE) return t("chat_received_file_unavailable");
  return t("chat_received_file_failed", { error: String((error as Error)?.message || error || "").trim() || "?" });
}

/** Saves the console's file at `pathname` as `name` (`saveConsoleFile`; tests give their own). */
export type SaveReceivedFile = (pathname: string, name: string) => Promise<"saved" | "cancelled">;

export function createReceivedFiles(options: { save?: SaveReceivedFile } = {}) {
  const save = options.save ?? saveConsoleFile;
  const states = keyedState<FileState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearTimer = (key: string) => {
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(key);
  };
  const peek = (key: string) => untracked(() => states.get(key) ?? EMPTY);
  const patch = (key: string, next: Partial<FileState>) => states.update(key, (value) => ({ ...(value ?? EMPTY), ...next }));

  return {
    state: (key: string) => states.get(key) ?? EMPTY,
    async preview(key: string, file: ReceivedFileInfo, topicID: string, taskID: string, errorLabel: string) {
      if (peek(key).requested || !canPreviewReceivedFile(file)) return;
      patch(key, { requested: true, error: "" });
      try {
        const blob = await fetchConsoleBlob(receivedFileURL(topicID, taskID, file.id, true));
        if (blob.type !== file.content_type) throw new Error(errorLabel);
        patch(key, { previewURL: URL.createObjectURL(blob) });
      } catch {
        patch(key, { error: errorLabel });
      }
    },
    failPreview(key: string, errorLabel: string) {
      const url = peek(key).previewURL;
      if (url) URL.revokeObjectURL(url);
      patch(key, { previewURL: "", error: errorLabel });
    },
    async download(key: string, file: ReceivedFileInfo, topicID: string, taskID: string) {
      if (peek(key).busy) return;
      clearTimer(key);
      patch(key, { busy: true, error: "", saved: false });
      try {
        const result = await save(receivedFileURL(topicID, taskID, file.id), file.name);
        if (result === "saved") {
          patch(key, { busy: false, saved: true });
          timers.set(
            key,
            setTimeout(() => {
              timers.delete(key);
              patch(key, { saved: false });
            }, SAVED_MS),
          );
        } else {
          // Backed out of the picker or the dialog: nothing to say.
          patch(key, { busy: false });
        }
      } catch (error) {
        patch(key, { busy: false, error: saveError(error) });
      }
    },
    dispose() {
      for (const key of [...timers.keys()]) clearTimer(key);
      for (const key of states.keys()) {
        const url = untracked(() => states.get(key)?.previewURL);
        if (url) URL.revokeObjectURL(url);
      }
      states.clear();
    },
  };
}

export type ReceivedFiles = ReturnType<typeof createReceivedFiles>;

export function ReceivedFile(props: {
  file: ReceivedFileInfo;
  taskID: string;
  topicID: string;
  files: ReceivedFiles;
  downloadLabel: string;
  errorLabel: string;
  /** Opens the file preview dialog on this file; without it the card offers no preview. */
  onPreview?: (file: ReceivedFileInfo) => void;
}) {
  const key = () => receivedFileKey(props.topicID, props.taskID, props.file?.id);
  const state = () => props.files.state(key());
  const name = () => String(props.file?.name || "").trim() || "download";
  const size = () => receivedFileButtonSize(!platform.desktop);
  const previewable = () => !!props.onPreview && canOpenReceivedFile(props.file);
  const openPreview = () => {
    if (previewable()) props.onPreview?.(props.file);
  };

  effect(() => {
    const k = key();
    const file = props.file;
    const topicID = props.topicID;
    const taskID = props.taskID;
    const label = props.errorLabel;
    untracked(() => void props.files.preview(k, file, topicID, taskID, label));
  });

  const receivedImage = () => (
    <Image
      src={state().previewURL}
      accessibilityLabel={props.file?.name}
      onError={() => props.files.failPreview(key(), props.errorLabel)}
      class="overflow-hidden max-h-80 w-full rounded-(--radius)"
      style={{ height: 240, objectFit: "contain" }}
    />
  );

  return (
    <View class={`gap-2 ${CARD_CORNERS} border border-line-faint bg-card p-3`} accessibilityLabel={props.file?.name}>
      <View class="flex-row items-center gap-2">
        <If
          when={previewable()}
          else={<Text class="flex-1 text-sm text-foreground line-clamp-1">{props.file?.name}</Text>}
        >
          <Text
            role="button"
            onPress={openPreview}
            testID="chat-received-file-name"
            class="flex-1 min-w-0 text-sm text-foreground line-clamp-1 hover:underline"
          >
            {props.file?.name}
          </Text>
          <Button
            variant="plain"
            size={size()}
            iconOnly
            icon="PhEye"
            title={t("chat_composer_file_preview")}
            accessibilityLabel={t("chat_received_file_preview", { name: name() })}
            testID={`chat-received-file-preview.${size()}`}
            onPress={openPreview}
          />
        </If>
        <Button
          variant="plain"
          size={size()}
          iconOnly
          icon={state().saved ? "PhCheck" : "PhCloudArrowDown"}
          title={props.downloadLabel}
          accessibilityLabel={state().saved ? t("chat_received_file_saved", { name: name() }) : t("chat_received_file_download", { name: name() })}
          // Its size and state, for tests (headless runs have no geometry): `chat-received-file-download.md.busy`.
          testID={`chat-received-file-download.${size()}.${state().busy ? "busy" : state().saved ? "saved" : "idle"}`}
          loading={state().busy}
          onPress={() => void props.files.download(key(), props.file, props.topicID, props.taskID)}
        />
      </View>
      <If when={state().previewURL}>
        <If when={previewable()} else={receivedImage()}>
          <TipButton onPress={openPreview} accessibilityLabel={t("chat_received_file_preview", { name: name() })} testID="chat-received-file-image" class="w-full">
            {receivedImage()}
          </TipButton>
        </If>
      </If>
      <If when={state().error}>
        <Text role="alert" class="text-xs text-danger">
          {state().error}
        </Text>
      </If>
    </View>
  );
}
