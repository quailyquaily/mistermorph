// A test entry for tests/contact-kind-tabs.test.tsx: the Contacts column's head as the page draws
// it, the real IndexColumn with the kind tabs (ContactKindTabs) as its actions and its bottom
// hairline sagging under the current tab, on a desktop or a phone (`isMobile`). The frames of the
// head's parts and of each tab's press target, circle and icon, and the tab the presses chose, are
// read out beside it. A button before the column (the window's only other Tab stop) counts its
// presses.
import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { isMobile } from "../../lib/shell";
import { IndexColumn } from "../../components/knowledge/parts";
import { ContactKindTabs, contactKindSagCenter } from "../../pages/contacts/ContactKindTabs";
import type { ContactKind } from "../../pages/contacts/contact-format";
import type { PartFrame } from "../../components/shared/partProbe";

const frames = signal<Record<string, PartFrame>>({});
const kind = signal<ContactKind>("human");
const presses = signal(0);
const before = signal(0);
const record = (name: string, frame: PartFrame) => frames.update((all) => ({ ...all, [name]: frame }));

function Page() {
  return (
    <View class="flex-1 bg-paper">
      <View class="flex-row items-center gap-2">
        <Button testID="before" accessibilityLabel="Before" class="size-6" onPress={() => before.update((n) => n + 1)} />
        <Text testID="out-kind">kind={kind()}</Text>
        <Text testID="out-presses">presses={String(presses())}</Text>
        <Text testID="out-before">before={String(before())}</Text>
      </View>
      <View class="h-[200px] flex-row" testID="column">
        <IndexColumn
          title="Contacts"
          actions={
            <ContactKindTabs
              value={kind()}
              mobile={isMobile()}
              onChange={(next) => {
                presses.update((n) => n + 1);
                kind.set(next);
              }}
              onPartLayout={record}
            />
          }
          sag={() => contactKindSagCenter(kind(), isMobile())}
          fill
          scroll={false}
          onPartLayout={record}
        >
          <View class="flex-1" />
        </IndexColumn>
      </View>
      <Text class="text-[6px]">{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Page />);
