// A conversation, or the topic list, that could not be loaded (the network, the agent down): an
// icon, what failed and why, all centred, in place of the conversation. `compact` is the strip for
// a reload that failed while the messages already loaded stay on screen (above the composer, or at
// the top of the phone's topic list).
//
// There is no button to load it again: the chat tries again by itself (chatController's retry, a
// little later each time, and at once when the window is shown again), and this says so only by
// its mark, which turns while a try is under way.
import { Text, View } from "nsh";
import { Icon, StatusMark } from "../ui";

export function ChatLoadError(props: {
  title: string;
  /** Why it failed, as the request said (shown under the title when it says more than it). */
  message: string;
  /** A load is under way (the chat is trying again): the mark turns. */
  busy: boolean;
  compact?: boolean;
  class?: string;
  testID?: string;
}) {
  const detail = () => {
    const message = String(props.message || "").trim();
    return message && message !== props.title ? message : "";
  };
  /** The mark: the warning, or the turning ring while a try is under way (in the same box, so nothing moves). */
  const mark = (size: number) => (
    <View class="items-center justify-center" style={{ width: size, height: size }} testID={props.testID ? `${props.testID}-${props.busy ? "busy" : "idle"}` : undefined}>
      <If when={props.busy} else={<Icon name="PhWarningCircle" size={size} color="danger" />}>
        <StatusMark state="running" size={Math.round(size * 0.6)} />
      </If>
    </View>
  );
  return (
    <If
      when={props.compact}
      else={
        <View class={`flex-1 items-center justify-center px-6 py-10 ${props.class ?? ""}`} testID={props.testID}>
          <View class="w-full max-w-sm items-center gap-3" role="alert">
            {mark(32)}
            <View class="items-center gap-1">
              <Text class="text-center text-base font-medium text-foreground" testID={props.testID ? `${props.testID}-title` : undefined}>
                {props.title}
              </Text>
              <If when={detail()}>
                <Text class="text-center text-sm text-muted-foreground" testID={props.testID ? `${props.testID}-message` : undefined}>
                  {detail()}
                </Text>
              </If>
            </View>
          </View>
        </View>
      }
    >
      <View
        class={`flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 py-2 ${props.class ?? ""}`}
        role="alert"
        testID={props.testID}
      >
        {mark(14)}
        <Text class="shrink text-center text-sm text-muted-foreground" testID={props.testID ? `${props.testID}-title` : undefined}>
          {detail() ? `${props.title}: ${detail()}` : props.title}
        </Text>
      </View>
    </If>
  );
}
