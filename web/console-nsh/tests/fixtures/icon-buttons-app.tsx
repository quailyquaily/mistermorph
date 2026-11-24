// A test entry for tests/icon-buttons.test.tsx: buttons with text, with a glyph, and given both
// (Button, PlaceholderButton), idle, disabled and loading, with the presses each took read out; and
// the agent switcher unfolded and folded (compact), with and without a selected agent.
import { mount, signal, Text, View } from "nsh";
import { AgentSwitcher } from "../../components/frame/AgentSwitcher";
import { PlaceholderButton } from "../../components/settings-page/parts";
import { Button } from "../../components/ui";

const presses = signal<Record<string, number>>({});
const press = (name: string) => () => presses.update((all) => ({ ...all, [name]: (all[name] ?? 0) + 1 }));
const busy = signal(false);
const compact = signal(false);
const selected = signal(true);

const AGENTS = [
  { id: "ep_one", value: "ep_one", title: "Agent One", image: "", connected: true },
  { id: "ep_two", value: "ep_two", title: "Agent Two", image: "", connected: true },
];

function Gallery() {
  return (
    <View class="flex-1 gap-3 bg-paper p-4">
      <View class="flex-row gap-2">
        <Button testID="text" variant="outlined" label="Rename" onPress={press("text")} />
        <Button testID="both" variant="outlined" icon="PhArrowClockwise" label="Refresh" onPress={press("both")} />
        <Button testID="both-titled" variant="outlined" icon="PhStop" label="Stop" title="Stop this run" onPress={press("both-titled")} />
        <Button testID="both-disabled" variant="outlined" icon="PhTrash" label="Delete" disabled onPress={press("both-disabled")} />
        <Button testID="icon-only" variant="plain" iconOnly icon="PhX" title="Close" onPress={press("icon-only")} />
      </View>
      <View class="flex-row gap-2">
        <Button testID="busy-text" label={busy() ? "Working" : "Start"} loading={busy()} onPress={press("busy-text")} />
        <Button testID="busy-both" variant="outlined" icon="PhPaperPlaneTilt" label="Send" loading={busy()} onPress={press("busy-both")} />
        <Button testID="toggle-busy" variant="plain" label="Toggle busy" onPress={() => busy.set(!busy())} />
      </View>
      <View class="w-80 gap-2">
        <PlaceholderButton testID="placeholder" label="Add a profile" onPress={press("placeholder")} />
        <Button testID="block" variant="outlined" block icon="PhPlus" label="Attach" onPress={press("block")} />
      </View>
      <Text testID="presses">{`presses=${JSON.stringify(presses())}`}</Text>
      <View class="flex-row gap-2">
        <Button testID="toggle-compact" variant="plain" label="Toggle compact" onPress={() => compact.set(!compact())} />
        <Button testID="toggle-selected" variant="plain" label="Toggle selected" onPress={() => selected.set(!selected())} />
      </View>
      <View style={{ width: compact() ? 56 : 240 }}>
        <AgentSwitcher items={AGENTS} selectedItem={selected() ? AGENTS[0] : null} compact={compact()} />
      </View>
    </View>
  );
}

mount(() => <Gallery />);
