// A test entry for tests/mobile-bottom-nav.test.tsx: the phone's bottom navigation (the real strip
// and its sheets) over an empty page as wide as the window, with the frames its slots and active
// pill lay out at read out beside it, with the sheets' frames. `host.params.agents` lists that many
// connected agents (the console's own first, selected). Each time a sheet is told to open or close,
// its progress (0 out of sight, 1 in its place) is sampled every frame for 500 ms and read out
// too (`motion:{"<name>.in<n>": …, "<name>.out<n>": …}`); the `bounce-more` button closes More and opens it again 90 ms later, while it is going out.
// `nav-compact` and `nav-expand` scroll a stand-in page down and back to its top
// (lib/navScroll.ts), and each resize the strip makes is read out (`resize:[["compact",160],…]`).
// Each captioned slot face the capsule builds is counted (`faces:{"mobile-nav-chat":1,…}`).
import { createAnimatedValue, host, mount, signal, Text, View } from "nsh";
import { MobileBottomMenus, MobileBottomNav, type MobileNavFrame } from "../../components/frame/MobileBottomNav";
import { endpointState } from "../../lib/core/context.js";
import { noteNavScroll } from "../../lib/navScroll";
import { closeMobileMore, setMobileMoreOpen } from "../../lib/shell";
import { Button } from "../../components/ui";
import { probeCapsuleFaces } from "../../components/shared/CapsuleBar";

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
const motion = signal<Record<string, { t: number; p: number }[]>>({});
const turns: Record<string, number> = {};
const resizes = signal<[string, number][]>([]);
const faces = signal<Record<string, number>>({});
// Counted as they are built (during a render): written once the render is over.
probeCapsuleFaces((testID) => void Promise.resolve().then(() => faces.update((all) => ({ ...all, [testID]: (all[testID] ?? 0) + 1 }))));
/** A stand-in page 2000pt long in a 600pt scroller, scrolled to `y`. */
const scrollTo = (y: number) => noteNavScroll({ source: "fixture", y, viewport: 600, content: 2000 });

function sample(name: string, progress: ReturnType<typeof createAnimatedValue>, open: boolean) {
  if (open) turns[name] = (turns[name] ?? 0) + 1;
  const label = `${name}.${open ? "in" : "out"}${turns[name] ?? 0}`;
  const series: { t: number; p: number }[] = [];
  const started = Date.now();
  const tick = async () => {
    const p = await progress.getValue();
    series.push({ t: Date.now() - started, p: Math.round(p * 1000) / 1000 });
    if (Date.now() - started < 500) setTimeout(() => void tick(), 16);
    else motion.update((all) => ({ ...all, [label]: series }));
  };
  void tick();
}

function Page() {
  return (
    <View class="relative flex-1 bg-background">
      <Text>{JSON.stringify(frames())}</Text>
      <Button
        size="xs"
        label="bounce"
        onPress={() => {
          closeMobileMore();
          setTimeout(() => setMobileMoreOpen(true), 90);
        }}
        testID="bounce-more"
      />
      <Text class="text-[6px]">{`motion:${JSON.stringify(motion())}`}</Text>
      <View class="flex-row gap-2">
        <Button
          size="xs"
          label="compact"
          onPress={() => {
            scrollTo(0);
            scrollTo(200);
          }}
          testID="nav-compact"
        />
        <Button size="xs" label="expand" onPress={() => scrollTo(0)} testID="nav-expand" />
      </View>
      <Text class="text-[6px]">{`resize:${JSON.stringify(resizes())}`}</Text>
      <Text class="text-[6px]">{`faces:${JSON.stringify(faces())}`}</Text>
      <MobileBottomMenus onSheetLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))} onSheetProgress={sample} />
      <MobileBottomNav
        onSlotLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))}
        onResize={(expanded, ms) => resizes.update((all) => [...all, [expanded ? "expanded" : "compact", ms]])}
      />
    </View>
  );
}

mount(() => <Page />);
