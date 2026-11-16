// The conversation's centred notice: a status mark and a line of mono text, as a context
// compaction leaves in the thread. With `onPress` it is the head of a fold (ChatQuietRuns): the
// same row made pressable, with the caret and the hover of the Agent Link exchange's fold.
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon, StatusMark, type StatusState } from "../ui";

const TEXT_CLASS = "font-mono text-xs text-subtle";

export function ChatNoticeLine(props: {
  state: StatusState;
  text: string;
  /** A quieter second part after the text, such as a time span. */
  detail?: string;
  /** A fold's head: pressing it opens or closes what it stands for. */
  onPress?: () => void;
  /** Whether the fold is open (the caret points up). */
  open?: boolean;
  testID?: string;
}) {
  const mark = () => (
    <>
      <StatusMark state={props.state} />
      <Text class={`${TEXT_CLASS} shrink`}>{props.text}</Text>
    </>
  );
  const detail = () => (
    <If when={props.detail}>
      <Text class="font-mono text-xs text-muted-foreground">{props.detail}</Text>
    </If>
  );
  return (
    <If
      when={props.onPress}
      else={
        <View class="max-w-full flex-row items-center gap-2 self-center" role="text" testID={props.testID}>
          {mark()}
          {detail()}
        </View>
      }
    >
      <BaseButton
        onPress={() => props.onPress?.()}
        selected={props.open === true}
        accessibilityLabel={[props.text, props.detail].filter(Boolean).join(", ")}
        class="max-w-full flex-row flex-wrap items-center justify-center gap-x-2 gap-y-0.5 self-center rounded-(--radius) px-1.5 py-0.5 hover:bg-hover focus:bg-hover"
        testID={props.testID}
      >
        <View class="max-w-full flex-row items-center gap-2">{mark()}</View>
        {/* On a narrow screen the span wraps under the count, with the caret beside it. */}
        <View class="flex-row items-center gap-2">
          {detail()}
          <Icon name={props.open ? "PhCaretUp" : "PhCaretDown"} size={11} color="muted-foreground" />
        </View>
      </BaseButton>
    </If>
  );
}
