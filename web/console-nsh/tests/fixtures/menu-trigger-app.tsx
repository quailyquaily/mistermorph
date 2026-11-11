// A test entry for tests/menu-trigger.test.tsx: a DropdownMenu opened from a MenuIconTrigger (the
// Settings "···" menus), with a switch that disables it as a page does while it loads or saves.
import { mount, signal, Text, View } from "nsh";
import { DropdownMenu, MenuIconTrigger } from "../../components/ui";

const disabled = signal(false);
const chosen = signal("");
const opened = signal(false);

function Gallery() {
  return (
    <View class="flex-1 gap-2 bg-background p-2">
      <View class="flex-row items-center justify-end">
        <DropdownMenu
          disabled={disabled()}
          onOpenChange={(open) => opened.set(open)}
          trigger={<MenuIconTrigger label="Actions" testID="menu-trigger" />}
          items={[
            { id: "one", label: "First action", onSelect: () => chosen.set("first") },
            { id: "two", label: "Second action", onSelect: () => chosen.set("second") },
          ]}
        />
      </View>
      <Text testID="toggle-disabled" class="p-2" onPress={() => disabled.set(!disabled())}>
        Toggle disabled
      </Text>
      <Text testID="state">{`opened=${opened()} chosen=${chosen()} disabled=${disabled()}`}</Text>
    </View>
  );
}

mount(() => <Gallery />);
