// A settings dialog with Cancel and Save (the Vue console's SettingDialog). While saving it cannot
// be closed: Escape and the backdrop do nothing, Cancel is disabled.
//
// Vue to nsh: `modelValue` is `open`, `update:modelValue` is `onOpenChange(open)`; `cancel` and
// `save` are `onCancel()` and `onSave()`.
import type { JSX } from "nsh";
import { Scroll, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { Button, type ModalSize } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

const WIDTHS: Record<ModalSize, string> = {
  sm: "w-full max-w-sm",
  md: "w-full max-w-lg",
  lg: "w-full max-w-2xl",
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
}

export function SettingDialog(props: SettingDialogProps) {
  const cancel = () => {
    if (props.saving) return;
    props.onOpenChange?.(false);
    props.onCancel?.();
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={({ open }) => {
        if (!open) cancel();
      }}
      closeOnEscape={!props.saving}
      closeOnBackdropPress={!props.saving}
      closeOnSwipe={!props.saving}
      testID={props.testID}
      animation="fade"
      backdropClass="bg-scrim"
      class={`m-auto max-h-[90%] ${WIDTHS[props.size ?? "lg"]} rounded-(--radius) border border-line bg-popover shadow-xl`}
    >
      <View class="border-b border-line-faint px-4 py-3">
        <Text class="text-base font-semibold text-foreground" role="header">
          {props.title ?? ""}
        </Text>
      </View>
      <Scroll class="shrink" contentClass="gap-3 p-4">
        {props.children}
      </Scroll>
      <View class="flex-row flex-wrap items-center justify-end gap-2 border-t border-line-faint px-4 py-3">
        <Button variant="outlined" label={t("action_cancel")} disabled={props.saving} onPress={cancel} />
        <Button
          variant="primary"
          label={t("action_save")}
          loading={props.saving}
          disabled={props.saving || props.saveDisabled}
          onPress={() => props.onSave?.()}
          testID={props.testID ? `${props.testID}-save` : undefined}
        />
      </View>
    </Dialog>
  );
}
