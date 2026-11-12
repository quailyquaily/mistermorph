// A test entry for tests/pinned-scroll.test.tsx: a 200pt PinnedScroll whose lines grow on a button
// (as a running task's progress does), its last scroll event read out below it as JSON.
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../components/ui";
import { PinnedScroll } from "../../components/chat/PinnedScroll";

const lines = signal(20);
const state = signal({ offset: 0, view: 0, content: 0, pinned: true });

function Page() {
  return (
    <View class="flex-1 bg-background">
      <View class="flex-row gap-2 p-1">
        <Button testID="grow" size="xs" label="grow" onPress={() => lines.update((n) => n + 10)} />
      </View>
      <PinnedScroll resetKey="log" class="h-[200px]" testID="pinned" onScrollState={(next) => state.set(next)}>
        {Array.from({ length: lines() }, (_, i) => (
          <Text class="h-5 text-sm text-foreground">line {i + 1}</Text>
        ))}
      </PinnedScroll>
      <Text class="text-[6px]">{JSON.stringify(state())}</Text>
    </View>
  );
}

mount(() => <Page />);
