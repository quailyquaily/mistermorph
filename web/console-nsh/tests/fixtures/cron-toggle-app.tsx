// A test entry for tests/cron-toggle.test.tsx: the topic head's TODO runs toggle (ViewToggle) as
// TopicSidebar draws it, with buttons that turn its running and selected states on and off and
// mount it again, and its frame, its centre, its presses and its alarm clock's hands (`read-hands`:
// their angles in radians and how they move) read out beside it.
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../components/ui";
import type { ClockProbe } from "../../components/motion/AdjustingClock";
import { ViewToggle } from "../../pages/chat/TopicSidebar";

function Out(props: { name: string; value: unknown }) {
  return (
    <Text testID={`out-${props.name}`}>
      {props.name}={String(props.value)}
    </Text>
  );
}

function Gallery() {
  const running = signal(false);
  const active = signal(false);
  const presses = signal(0);
  const frame = signal("none");
  const center = signal(0);
  const mounted = signal(true);
  const hands = signal("none");
  let readHands: ClockProbe | null = null;
  return (
    <View class="gap-3 bg-sidebar p-4">
      <View class="h-[57px] flex-row items-center">
        <View class="flex-1" />
        <If when={mounted()}>
          <View onLayout={({ bounds }) => frame.set(`${bounds.origin.x},${bounds.origin.y},${bounds.size.width}x${bounds.size.height}`)}>
            <ViewToggle
              icon="PhAlarm"
              label={running() ? "TODO runs — 2 running" : "TODO runs"}
              title="TODO runs"
              active={active()}
              running={running()}
              onPress={() => presses.update((n) => n + 1)}
              testID="toggle"
              onCenter={(x) => center.set(x)}
              clockProbe={(read) => {
                readHands = read;
              }}
            />
          </View>
        </If>
      </View>
      <Button testID="flip-running" variant="outlined" size="xs" label="Flip running" onPress={() => running.set(!running())} />
      <Button testID="flip-active" variant="outlined" size="xs" label="Flip active" onPress={() => active.set(!active())} />
      <Button testID="flip-mounted" variant="outlined" size="xs" label="Flip mounted" onPress={() => mounted.set(!mounted())} />
      <Button
        testID="read-hands"
        variant="outlined"
        size="xs"
        label="Read hands"
        onPress={async () => {
          const read = readHands;
          if (!read) return hands.set("none");
          const at = await read();
          hands.set(`${at.minute.toFixed(3)},${at.hour.toFixed(3)},${at.phase}`);
        }}
      />
      <Out name="presses" value={presses()} />
      <Out name="hands" value={hands()} />
      <Out name="frame" value={frame()} />
      <Out name="center" value={center()} />
    </View>
  );
}

mount(() => <Gallery />);
