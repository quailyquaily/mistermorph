// A test entry for tests/chat-history-older.test.tsx: the row above the oldest loaded message
// (ChatHistoryList's OlderBoundary) in a column with the conversation's 20pt gutters, idle or
// loading, with a short label or one too long for a phone, and the frames its parts lay out at
// and how often it was pressed read out under it.
import type { Bounds } from "nsh";
import { mount, signal, Text, View } from "nsh";
import { OlderBoundary } from "../../components/chat/ChatHistoryList";

type Frame = { x: number; y: number; w: number; h: number };

const frames = signal<Record<string, Frame>>({});
const loading = signal(false);
const long = signal(false);
const presses = signal(0);

function track(part: string, bounds: Bounds) {
  const { origin, size } = bounds;
  frames.update((all) => ({ ...all, [part]: { x: origin.x, y: origin.y, w: size.width, h: size.height } }));
}

const LONG_LABEL = "Load the older messages of this conversation from the history store";

function App() {
  return (
    <View class="flex-1 bg-background">
      <View class="h-8 flex-row gap-1">
        <View testID="do-loading" onPress={() => loading.set(!loading())} class="h-8 w-16 bg-muted">
          <Text class="text-[10px]">loading</Text>
        </View>
        <View testID="do-long" onPress={() => long.set(!long())} class="h-8 w-16 bg-muted">
          <Text class="text-[10px]">long</Text>
        </View>
      </View>
      <View class="px-5 pt-5">
        <OlderBoundary
          label={long() ? LONG_LABEL : "Load older messages"}
          loadingLabel="Loading older messages..."
          loading={loading()}
          onPress={() => presses.set(presses() + 1)}
          onPartLayout={track}
        />
      </View>
      <Text testID="report" class="text-xs">
        {JSON.stringify({ frames: frames(), loading: loading(), presses: presses() })}
      </Text>
    </View>
  );
}

mount(() => <App />);
