// A test entry for tests/fab-marks.test.tsx: the page Fab (components/ui.tsx) in three frames as
// the UI components page shows it (enabled, disabled, another icon), each reporting where its
// button and its two registration marks lie (`onPartLayout`), so the test can hold the marks' size
// and their gap round the button. Also the web target's visual probe: each mark's single stroke.
import { mount, signal, Text, View } from "nsh";
import { Fab } from "../../components/ui";
import type { PartFrame } from "../../components/shared/partProbe";

const parts = signal<Record<string, [number, number, number, number]>>({});
const presses = signal(0);

/** Records the parts of the Fab `name`, as `<name>/<part>`: x, y, width, height on the page. */
const track = (name: string) => (part: string, frame: PartFrame) => {
  const key = `${name}/${part}`;
  const next: [number, number, number, number] = [frame.x, frame.y, frame.w, frame.h].map((n) => Math.round(n * 2) / 2) as [number, number, number, number];
  const old = parts()[key];
  if (!old || old.some((n, i) => n !== next[i])) parts.set({ ...parts(), [key]: next });
};

function Gallery() {
  return (
    <View class="flex-1 bg-background p-6">
      <View class="flex-row flex-wrap gap-6">
        <View class="relative h-24 w-40 border border-line-faint">
          <Fab label="Add" onPress={() => presses.set(presses() + 1)} testID="fab" onPartLayout={track("plain")} />
        </View>
        <View class="relative h-24 w-40 border border-line-faint">
          <Fab label="Add disabled" disabled testID="fab-disabled" onPartLayout={track("disabled")} />
        </View>
        <View class="relative h-24 w-40 border border-line-faint">
          <Fab label="New note" icon="PhAlarm" testID="fab-icon" onPartLayout={track("icon")} />
        </View>
      </View>
      <Text testID="presses">{`presses=${presses()}`}</Text>
      <Text testID="parts" class="text-[9px] text-muted-foreground">{`parts=${JSON.stringify(parts())}`}</Text>
    </View>
  );
}

mount(() => <Gallery />);
