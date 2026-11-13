// A test entry for tests/mobile-bottom-nav.test.tsx: the phone's bottom navigation (the real strip
// and its sheets) over an empty page as wide as the window, with the frames its slots and active
// pill lay out at read out beside it, with the sheets' frames. `host.params.agents` lists that many
// connected agents (the console's own first, selected).
import { host, mount, signal, Text, View } from "nsh";
import { MobileBottomMenus, MobileBottomNav, type MobileNavFrame } from "../../components/frame/MobileBottomNav";
import { endpointState } from "../../lib/core/context.js";

const agents = Number((host.params as { agents?: number }).agents ?? 0);
if (agents > 0) {
  endpointState.items = Array.from({ length: agents }, (_, index) => ({
    endpoint_ref: index === 0 ? "ep_console_local" : `ep_${index}`,
    name: `Agent ${index}`,
    url: index === 0 ? "in-process://console-local" : `https://agent${index}.example.com`,
    connected: true,
    agent_name: `Agent ${index}`,
    mode: "console",
    can_submit: true,
    avatar_url: "",
  }));
  endpointState.selectedRef = "ep_console_local";
}

const frames = signal<Record<string, MobileNavFrame>>({});

function Page() {
  return (
    <View class="relative flex-1 bg-background">
      <Text>{JSON.stringify(frames())}</Text>
      <MobileBottomMenus onSheetLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))} />
      <MobileBottomNav onSlotLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))} />
    </View>
  );
}

mount(() => <Page />);
