// A titled dialog with a close button that can be held open (the Vue console's AppDialogShell):
// while `closeDisabled` is set, Escape, the backdrop and the close button do nothing.
import type { JSX } from "nsh";
import { Scroll, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { Modal, type ModalSize } from "../ui";

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

/**
 * The Vue AppDialogShell is the console's Modal (title bar with the red close square, body, footer),
 * so this is Modal, which also grows out of the control that opened it. While `closeDisabled`, the
 * close button and Escape do nothing.
 */
export function DialogShell(props: DialogShellProps) {
  const close = () => {
    if (!props.closeDisabled) props.onClose();
  };
  return (
    <Modal open={props.open} onClose={close} title={props.title} size={props.size ?? "md"} footer={props.footer} testID={props.testID} closeLabel={t("action_close")}>
      {props.children}
    </Modal>
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
