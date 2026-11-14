// A test entry for tests/contact-kind-tabs.test.tsx: the Contacts head's kind tabs (ContactKindTabs)
// in a 57pt head row as IndexColumn lays them out, on a desktop or a phone (`isMobile`), with the
// frames of each tab's press target, circle and icon, and the tab the presses chose, read out beside it.
import { mount, signal, Text, View } from "nsh";
import { isMobile } from "../../lib/shell";
import { ContactKindTabs } from "../../pages/contacts/ContactKindTabs";
import type { ContactKind } from "../../pages/contacts/contact-format";
import type { PartFrame } from "../../components/shared/partProbe";

const frames = signal<Record<string, PartFrame>>({});
const kind = signal<ContactKind>("human");
const presses = signal(0);

function Page() {
  return (
    <View class="flex-1 bg-background">
      <View class="h-[57px] flex-row items-center justify-between gap-3 px-4">
        <Text class="flex-1 text-xl">Contacts</Text>
        <View class="flex-row items-center gap-0.5">
          <ContactKindTabs
            value={kind()}
            mobile={isMobile()}
            onChange={(next) => {
              presses.update((n) => n + 1);
              kind.set(next);
            }}
            onPartLayout={(name, frame) => frames.update((all) => ({ ...all, [name]: frame }))}
          />
        </View>
      </View>
      <Text testID="out-kind">kind={kind()}</Text>
      <Text testID="out-presses">presses={String(presses())}</Text>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Page />);
