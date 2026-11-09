// A test entry for tests/mobile-bottom-nav.test.tsx: the phone's bottom navigation (the real strip
// and its sheets) over an empty page as wide as the window, with the frames its slots and active
// pill lay out at read out beside it.
import { mount, signal, Text, View } from "nsh";
import { MobileBottomMenus, MobileBottomNav, type MobileNavFrame } from "../../components/frame/MobileBottomNav";

const frames = signal<Record<string, MobileNavFrame>>({});

function Page() {
  return (
    <View class="relative flex-1 bg-background">
      <Text>{JSON.stringify(frames())}</Text>
      <MobileBottomMenus />
      <MobileBottomNav onSlotLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))} />
    </View>
  );
}

mount(() => <Page />);
