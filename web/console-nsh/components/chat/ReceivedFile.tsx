// A file the agent sent with its reply (a task attachment): its name, a download button, and an
// image preview for raster images. Ported from web/console/src/components/ReceivedFile.js. Its
// preview and download state lives in a ReceivedFiles store, keyed by file, since rows recycle.
import { effect, Image, Text, untracked, View } from "nsh";
import { Button } from "../ui";
import { canPreviewReceivedFile, receivedFileURL } from "../../lib/core/received-files.js";
import { keyedState } from "./rowState";
import { fetchConsoleBlob, saveConsoleFile } from "./files";

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
}

const EMPTY: FileState = { previewURL: "", error: "", busy: false, requested: false };

export function createReceivedFiles() {
  const states = keyedState<FileState>();
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
      patch(key, { busy: true, error: "" });
      try {
        await saveConsoleFile(receivedFileURL(topicID, taskID, file.id), file.name);
      } catch (error) {
        patch(key, { error: (error as Error)?.message || "Download failed" });
      } finally {
        patch(key, { busy: false });
      }
    },
    dispose() {
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
}) {
  const key = () => `${props.topicID}|${props.taskID}|${props.file?.id}`;
  const state = () => props.files.state(key());

  effect(() => {
    const k = key();
    const file = props.file;
    const topicID = props.topicID;
    const taskID = props.taskID;
    const label = props.errorLabel;
    untracked(() => void props.files.preview(k, file, topicID, taskID, label));
  });

  return (
    <View class="gap-2 rounded-(--radius) border border-line-faint bg-card p-3" accessibilityLabel={props.file?.name}>
      <View class="flex-row items-center gap-2">
        <Text class="flex-1 text-sm text-foreground line-clamp-1">{props.file?.name}</Text>
        <Button
          variant="outlined"
          size="xs"
          label={props.downloadLabel}
          loading={state().busy}
          onPress={() => void props.files.download(key(), props.file, props.topicID, props.taskID)}
        />
      </View>
      <If when={state().previewURL}>
        <Image
          src={state().previewURL}
          accessibilityLabel={props.file?.name}
          onError={() => props.files.failPreview(key(), props.errorLabel)}
          class="max-h-80 w-full rounded-(--radius)"
          style={{ height: 240, objectFit: "contain" }}
        />
      </If>
      <If when={state().error}>
        <Text role="alert" class="text-xs text-danger">
          {state().error}
        </Text>
      </If>
    </View>
  );
}
