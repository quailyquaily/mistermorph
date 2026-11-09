// A message's time, or for a reply the time it took ("💬 1s"): mono 11 on a 16pt line in a 20pt
// box, muted, the same face, size and line as the status columns beside it (design/ui-refresh.html
// §3). Shown above a sent message, alone above a reply, or first on a reply's summary line
// (ChatStatusCard).
//
// `placement` says where it is. Alone it keeps to its side of the column: a reply's at the left, a
// sent message's at the right, in line with the bubble. On a reply's summary line it takes no
// alignment of its own, so the line's `items-center` centres it with the plan, activity and
// reasoning columns (a `self-start` there would lift it to the top of the taller columns).
import { Text, View } from "nsh";
import { Icon } from "../ui";

export type StatusMarkPlacement = "summary" | "reply" | "sent";

const PLACEMENT: Record<StatusMarkPlacement, string> = {
  summary: "",
  reply: "self-start",
  // Ends on the bubble's text edge: the bubble's 8pt inset, its 1pt border and 14pt padding.
  sent: "mr-[23px] self-end",
};

export function ChatStatusMark(props: {
  text: string;
  /** What a screen reader says, and the tooltip of a duration. */
  label: string;
  /** The text is how long the reply took, not when it came. */
  duration?: boolean;
  onPress?: () => void;
  placement: StatusMarkPlacement;
  onLayout?: (event: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) => void;
}) {
  return (
    <View
      role={props.onPress ? "button" : "text"}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      tooltip={props.duration ? <Text class="text-xs">{props.label}</Text> : undefined}
      testID="chat-history-status"
      onLayout={props.onLayout}
      class={`h-5 flex-row items-center ${PLACEMENT[props.placement]}`}
    >
      <If when={props.duration}>
        <Icon name="PhChatCircleDots" size={13} color="muted-foreground" class="mr-[3px]" />
      </If>
      <Text class="font-mono text-[11px] leading-4 tracking-[0.04em] text-muted-foreground">{props.text}</Text>
    </View>
  );
}
