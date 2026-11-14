// A test entry for tests/settings-page-runtime-layout.test.tsx: the real Settings › Runtime panel on
// its own, the page's width, with the frames of its cards, the channels card's lines and the
// unconfigured channels (RuntimePanel's `onPartLayout`, on the page) read out beside it as JSON.
import { mount, signal, Text, View } from "nsh";
import { configureApiBase, endpointState, localeState } from "../../lib/core/context.js";
import { boot } from "../../lib/platform";
import type { PartFrame } from "../../components/shared/partProbe";
import { RuntimePanel } from "../../pages/settings/RuntimePanel";

const frames = signal<Record<string, PartFrame>>({});

function FixtureApp() {
  return (
    <View class="flex-1 bg-background px-3">
      <RuntimePanel onPartLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))} />
      <Text testID="frames">{JSON.stringify(frames())}</Text>
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
