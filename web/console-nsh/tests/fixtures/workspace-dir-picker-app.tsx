// A test entry for tests/workspace-dir-picker.test.tsx: the real WorkspaceDirPickerDialog on its own
// over a plain page, browsing the console's local agent through the stubbed API (the test's
// network). A button opens it; what it confirms and how often it closed are read out on the page,
// and every tab strip's widths, offset and options (probeTabStrips) as JSON at the end.
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { configureApiBase, endpointState, localeState } from "../../lib/core/context.js";
import { boot } from "../../lib/platform";
import { WorkspaceDirPickerDialog } from "../../components/shared/WorkspaceDirPickerDialog";
import { probeTabStrips, type TabStripFrame } from "../../components/ui";

const open = signal(false);
const confirmed = signal("");
const strips = signal<Record<string, TabStripFrame>>({});

probeTabStrips((frame) => {
  if (frame.testID) strips.update((all) => ({ ...all, [frame.testID]: frame }));
});

function FixtureApp() {
  return (
    <View class="flex-1 gap-2 bg-background p-3">
      <Button testID="open-picker" accessibilityLabel="Open picker" class="h-8 self-start px-3" onPress={() => open.set(true)}>
        <Text>open</Text>
      </Button>
      <Text testID="out-confirmed">confirmed={confirmed()}</Text>
      <WorkspaceDirPickerDialog
        open={open()}
        onOpenChange={(next) => open.set(next)}
        onConfirm={(dir) => {
          confirmed.set(dir);
          open.set(false);
        }}
      />
      <Text class="text-[6px]">{JSON.stringify(strips())}</Text>
    </View>
  );
}

async function start() {
  await boot();
  configureApiBase();
  localeState.hydrateLanguage();
  endpointState.setSelectedEndpointRef("ep_console_local");
  mount(FixtureApp);
}

void start();
