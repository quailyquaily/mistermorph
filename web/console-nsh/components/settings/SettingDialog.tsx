// A settings dialog with Cancel and Save (the Vue console's SettingDialog, an AppDialog). While
// saving it cannot be closed: Escape and the backdrop do nothing, Cancel is disabled.
//
// It is built on the ui's DialogLayer, as AppDialog is in Vue: the scrim and panel fade in, the
// panel growing out of the control that opened it, and go back into it on close (Escape too); on
// phones it is a sheet sliding up from the bottom edge, Cancel and Save equally wide.
//
// Vue to nsh: `modelValue` is `open`, `update:modelValue` is `onOpenChange(open)`; `cancel` and
// `save` are `onCancel()` and `onSave()`.
import type { JSX } from "nsh";
import { Scroll, Text, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { Button, DialogActions, DialogLayer, dialogSheetClearance, type DialogProbe, type ModalSize } from "../ui";
import { SCROLLBAR } from "../motion";
import { isMobile } from "../../lib/shell";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

const WIDTHS: Record<ModalSize, string> = {
  sm: "w-full max-w-sm",
  md: "w-full max-w-lg",
  lg: "w-full max-w-[720px]",
  xl: "w-full max-w-4xl",
  full: "w-full h-full",
};

export interface SettingDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onCancel?: () => void;
  onSave?: () => void;
  title?: string;
  /** The dialog's width (the Vue `width`, 720px by default: "lg"). */
  size?: ModalSize;
  saving?: boolean;
  saveDisabled?: boolean;
  children?: JSX.Element;
  testID?: string;
  /** For tests: the panel's frame and motion. */
  probe?: DialogProbe;
}

export function SettingDialog(props: SettingDialogProps) {
  const cancel = () => {
    if (props.saving) return;
    props.onOpenChange?.(false);
    props.onCancel?.();
  };
  return (
    <DialogLayer
      open={props.open}
      onClose={cancel}
      testID={props.testID}
      label={props.title}
      panelClass={WIDTHS[props.size ?? "lg"]}
      // The actions' strip is paper, not the dialog's white: on a sheet it reaches down over the
      // room under it (the navigation bar, gesture handle or keyboard) itself.
      bottomInset="content"
      probe={props.probe}
    >
      {/* SettingDialog.css: a 44pt title bar, a 20pt body (16 on phones), and the actions in a 60pt
          strip on the paper, Cancel at the left and Save at the right. */}
      <View class={`h-11 justify-center border-b border-dialog-line ${isMobile() ? "px-4" : "px-5"}`}>
        <Text class="text-base font-semibold leading-[19.2px] tracking-[-0.02em] text-foreground" role="header" style={{ numberOfLines: 1 }}>
          {props.title ?? ""}
        </Text>
      </View>
      <Scroll class="shrink" contentClass={`gap-3 ${isMobile() ? "p-4" : "p-5"}`} scrollbar={SCROLLBAR}>
        {props.children}
      </Scroll>
      <DialogActions
        class={`min-h-15 flex-row items-center justify-between gap-3 border-t border-line bg-paper py-2 ${isMobile() ? "px-4" : "px-5"}`}
        // py-2's 8pt under the buttons, above the sheet's room under its last row.
        style={dialogSheetClearance() > 0 ? { paddingBottom: 8 + dialogSheetClearance() } : undefined}
        testID={props.testID ? `${props.testID}-footer` : undefined}
      >
        <Button variant="outlined" size="md" label={t("action_cancel")} disabled={props.saving} onPress={cancel} />
        <Button
          variant="primary"
          size="md"
          label={t("action_save")}
          loading={props.saving}
          disabled={props.saving || props.saveDisabled}
          onPress={() => props.onSave?.()}
          testID={props.testID ? `${props.testID}-save` : undefined}
        />
      </DialogActions>
    </DialogLayer>
  );
}
