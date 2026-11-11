// A conversation, or the topic list, that could not be loaded (the network, the agent down): an
// icon, what failed and why, and a Refresh that loads it again, all centred, in place of the
// conversation. `compact` is the strip for a reload that failed while the messages already loaded
// stay on screen (above the composer, or at the top of the phone's topic list).
import { Text, View } from "nsh";
import { Button, Icon } from "../ui";

export function ChatLoadError(props: {
  title: string;
  /** Why it failed, as the request said (shown under the title when it says more than it). */
  message: string;
  refreshLabel: string;
  /** A load is under way: the Refresh is busy (and takes no presses). */
  busy: boolean;
  onRefresh: () => void;
  compact?: boolean;
  class?: string;
  testID?: string;
}) {
  const detail = () => {
    const message = String(props.message || "").trim();
    return message && message !== props.title ? message : "";
  };
  return (
    <If
      when={props.compact}
      else={
        <View class={`flex-1 items-center justify-center px-6 py-10 ${props.class ?? ""}`} testID={props.testID}>
          <View class="w-full max-w-sm items-center gap-3" role="alert">
            <Icon name="PhWarningCircle" size={32} color="danger" />
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
            <Button
              variant="outlined"
              size="sm"
              align="center"
              icon="PhArrowClockwise"
              label={props.refreshLabel}
              loading={props.busy}
              onPress={props.onRefresh}
              testID={props.testID ? `${props.testID}-refresh` : undefined}
            />
          </View>
        </View>
      }
    >
      <View
        class={`flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 py-2 ${props.class ?? ""}`}
        role="alert"
        testID={props.testID}
      >
        <Icon name="PhWarningCircle" size={14} color="danger" />
        <Text class="shrink text-center text-sm text-muted-foreground" testID={props.testID ? `${props.testID}-title` : undefined}>
          {detail() ? `${props.title}: ${detail()}` : props.title}
        </Text>
        <Button
          variant="plain"
          size="xs"
          icon="PhArrowClockwise"
          label={props.refreshLabel}
          loading={props.busy}
          onPress={props.onRefresh}
          testID={props.testID ? `${props.testID}-refresh` : undefined}
        />
      </View>
    </If>
  );
}
