// The raw JSON of a record, in a dialog (the Vue console's RawJsonDialog) or inline in a dialog of
// your own (RawJsonDialogContent): a dark, selectable, monospaced body with a Copy button.
import { Scroll, Text, View } from "nsh";
import { translate as t } from "../../lib/core/context.js";
import { copyText } from "../../lib/platform";
import { Button, Modal } from "../ui";

export interface RawJsonDialogContentProps {
  /** The JSON text, already formatted. */
  json?: string;
  class?: string;
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
    <View class={`relative min-h-0 shrink rounded-(--radius) bg-ink ${props.class ?? ""}`} testID={props.testID}>
      <Scroll class="shrink" contentClass="pb-3">
        <Scroll horizontal class="shrink" contentClass="px-3.5 pt-3 pr-20">
          <View selectable>
            <Text class="font-mono text-sm tabular-nums text-paper" style={{ lineHeight: 21 }}>
              {props.json ?? ""}
            </Text>
          </View>
        </Scroll>
      </Scroll>
      <View class="absolute right-3 top-3">
        <Button variant="outlined" size="xs" label={t("action_copy")} onPress={() => void copy()} testID="raw-json-copy" />
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
      <RawJsonDialogContent json={props.json} class="max-h-[72%]" />
    </Modal>
  );
}
