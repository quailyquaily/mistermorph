// A system line in the conversation (a retry of the model call). Ported from
// web/console/src/components/ChatSystemMessage.js.
import { Text, View } from "nsh";

export function ChatSystemMessage(props: { text: string; at?: string }) {
  const timeText = () => {
    if (!props.at) return "";
    const date = new Date(props.at);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-GB", { hour12: false });
  };
  return (
    <View class="flex-row items-start gap-2 rounded-(--radius) border border-line-faint bg-paper px-3 py-2" accessibilityLabel="System message">
      <Text class="text-sm text-muted-foreground">↻</Text>
      <View class="flex-1 gap-0.5">
        <View class="flex-row items-center gap-2">
          <Text class="font-mono text-xs uppercase text-muted-foreground">System</Text>
          <If when={timeText()}>
            <Text class="font-mono text-xs text-muted-foreground">{timeText()}</Text>
          </If>
        </View>
        <Text class="text-sm text-subtle">{props.text}</Text>
      </View>
    </View>
  );
}
