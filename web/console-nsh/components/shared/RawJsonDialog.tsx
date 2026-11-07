// The raw JSON of a record, in a dialog (the Vue console's RawJsonDialog) or inline in a dialog of
// your own (RawJsonDialogContent): a dark, selectable, monospaced body with a Copy button.
import { Scroll, Text, View, windowSize } from "nsh";
import { translate as t } from "../../lib/core/context.js";
import { copyText } from "../../lib/platform";
import { Button, Modal } from "../ui";
import { SCROLLBAR } from "../motion";

export interface RawJsonDialogContentProps {
  /** The JSON text, already formatted. */
  json?: string;
  class?: string;
  style?: Record<string, unknown>;
  testID?: string;
}

/** The JSON body with its Copy button, to place in a dialog's body. */
export function RawJsonDialogContent(props: RawJsonDialogContentProps) {
  const copy = async () => {
    const text = String(props.json || "");
    if (!text) return;
    try {
      await copyText(text);
    } catch (error) {
      console.warn("raw json: copy failed", error);
    }
  };
  return (
    // `.raw-json-dialog`: the dark ground (`--q-c-dark`), white 16pt mono at 1.55, 8pt above and
    // 14pt around the text, the Copy button pinned at the top right on a white face.
    <View class={`relative min-h-0 shrink bg-foreground ${props.class ?? ""}`} style={props.style} testID={props.testID}>
      <Scroll class="shrink" contentClass="pb-3.5" scrollbar={SCROLLBAR}>
        <Scroll horizontal class="shrink" contentClass="px-3.5 pr-20 pt-12" scrollbar={SCROLLBAR}>
          <View selectable>
            <Text class="font-mono text-base tabular-nums text-primary-foreground" style={{ lineHeight: 24.8 }}>
              {props.json ?? ""}
            </Text>
          </View>
        </Scroll>
      </Scroll>
      <View class="absolute right-3 top-3">
        <Button variant="outlined" size="xs" class="bg-card" label={t("action_copy")} onPress={() => void copy()} testID="raw-json-copy" />
      </View>
    </View>
  );
}

export interface RawJsonDialogProps {
  open: boolean;
  /** The dialog's title; "RAW JSON" when empty. */
  title?: string;
  json?: string;
  onClose?: () => void;
  testID?: string;
}

/** A dialog that shows `json` (the Vue console's RawJsonDialog: `open`, `title`, `json`, `@close`). */
export function RawJsonDialog(props: RawJsonDialogProps) {
  return (
    <Modal
      open={props.open}
      onClose={() => props.onClose?.()}
      title={props.title || "RAW JSON"}
      size="xl"
      scroll={false}
      testID={props.testID}
      closeLabel={t("action_close")}
    >
      {/* Flush with the dialog's edges (the Vue dialog body has no padding): out of the body's 16pt. */}
      <RawJsonDialogContent json={props.json} class="-m-4" style={{ maxHeight: Math.min(windowSize().height * 0.72, 720) }} />
    </Modal>
  );
}
