// A titled dialog with a close button that can be held open (the Vue console's AppDialogShell):
// while `closeDisabled` is set, Escape, the backdrop and the close button do nothing.
import type { JSX } from "nsh";
import { Scroll, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { Button, type ModalSize } from "../ui";

/** `translate` typed: the JS default `vars = null` makes TS reject variables. */
export const t = translate as unknown as (key: string, vars?: Record<string, unknown> | null) => string;

const WIDTHS: Record<ModalSize, string> = {
  sm: "w-full max-w-sm",
  md: "w-full max-w-lg",
  lg: "w-full max-w-2xl",
  xl: "w-full max-w-4xl",
  full: "w-full h-full",
};

export interface DialogShellProps {
  open: boolean;
  /** The user asked to close it (only when `closeDisabled` is not set). */
  onClose: () => void;
  title?: string;
  /** Holds the dialog open (a request running). */
  closeDisabled?: boolean;
  /** md is the Vue 560px. */
  size?: ModalSize;
  /** Actions at the bottom. */
  footer?: JSX.Element;
  children?: JSX.Element;
  testID?: string;
}

export function DialogShell(props: DialogShellProps) {
  const close = () => {
    if (!props.closeDisabled) props.onClose();
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={({ open }) => {
        if (!open) close();
      }}
      closeOnEscape={!props.closeDisabled}
      closeOnBackdropPress={!props.closeDisabled}
      closeOnSwipe={!props.closeDisabled}
      testID={props.testID}
      animation="fade"
      backdropClass="bg-scrim"
      class={`m-auto max-h-[90%] ${WIDTHS[props.size ?? "md"]} rounded-(--radius) border border-line bg-popover shadow-xl`}
    >
      <View class="flex-row items-center gap-3 border-b border-line-faint px-4 py-3">
        <Text class="flex-1 text-base font-semibold text-foreground" role="header">
          {props.title ?? ""}
        </Text>
        <Button
          variant="plain"
          size="xs"
          iconOnly
          icon="PhX"
          title={t("action_close")}
          disabled={props.closeDisabled}
          onPress={close}
        />
      </View>
      <Scroll class="shrink" contentClass="gap-3 p-4">
        {props.children}
      </Scroll>
      <If when={props.footer}>
        <View class="flex-row flex-wrap items-center justify-end gap-2 border-t border-line-faint px-4 py-3">{props.footer}</View>
      </If>
    </Dialog>
  );
}

/** An inline notice (the Vue console's AppNotice): a bordered box with the text. */
export function InlineNotice(props: { type?: "error" | "warning" | "info" | "success"; text: string; testID?: string }) {
  const box = () =>
    props.type === "error"
      ? "border-danger"
      : props.type === "warning"
        ? "border-warn"
        : props.type === "success"
          ? "border-ok"
          : "border-blue";
  const text = () =>
    props.type === "error"
      ? "text-danger"
      : props.type === "warning"
        ? "text-warn-dark"
        : props.type === "success"
          ? "text-ok"
          : "text-foreground";
  return (
    <View
      role={props.type === "error" ? "alert" : undefined}
      testID={props.testID}
      class={`rounded-(--radius) border bg-card px-3 py-2 ${box()}`}
    >
      <View selectable>
        <Text class={`text-sm ${text()}`}>{props.text}</Text>
      </View>
    </View>
  );
}
