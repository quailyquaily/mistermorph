// A test entry for tests/corners.test.tsx: the shared controls with the continuous corners
// (components/corners.ts), each reporting its frame, so the test can tell the corners changed
// nothing else: the buttons, fields, clear buttons, switches and cards keep their sizes, and a menu
// item's text stays where it was although its highlight is now inset (MENU_ITEM_BOX). Also the web
// target's visual probe (`app.screenshot`): the controls, an open menu, a dialog.
import type { Bounds } from "nsh";
import { mount, signal, Text, View } from "nsh";
import {
  Button,
  Card,
  CircleButton,
  DropdownMenu,
  MENU_ITEM_BOX,
  MENU_POPUP,
  MenuIconTrigger,
  Modal,
  SelectField,
  TextField,
  Toggle,
  type ButtonSize,
} from "../../components/ui";

const frames = signal<Record<string, [number, number, number, number]>>({});
const dialog = signal(false);

/** Records the frame of what it is put on, under `name` (x, y, width, height in its parent). */
const track = (name: string) => (event: { bounds: Bounds }) => {
  const { origin, size } = event.bounds;
  const next: [number, number, number, number] = [origin.x, origin.y, size.width, size.height].map((n) => Math.round(n * 2) / 2) as [number, number, number, number];
  const old = frames()[name];
  if (!old || old.some((n, i) => n !== next[i])) frames.set({ ...frames(), [name]: next });
};

const SIZES: ButtonSize[] = ["md", "sm", "xs", "xxs"];
const LONG = "A deliberately long value that runs well past the end of the field, an_unbroken_identifier_0123456789";

function Gallery() {
  const on = signal(true);
  const text = signal(LONG);
  const choice = signal("pear");
  return (
    <View class="flex-1 gap-3 bg-background p-4">
      <View class="flex-row items-start gap-2">
        {SIZES.map((size) => (
          <Button testID={`button-${size}`} size={size} label={size} onLayout={track(`button-${size}`)} />
        ))}
        {SIZES.map((size) => (
          <Button testID={`icon-${size}`} size={size} variant="outlined" icon="PhPlus" label={`Add ${size}`} onLayout={track(`icon-${size}`)} />
        ))}
        <View onLayout={track("circle")}>
          <CircleButton title="Close" icon="PhX" testID="circle" />
        </View>
      </View>
      <View class="flex-row items-start gap-2">
        {(["md", "sm", "xs"] as const).map((size) => (
          <View class="w-56" onLayout={track(`field-${size}`)}>
            <TextField size={size} value={text()} onChange={(value) => text.set(value)} clearable testID={`field-${size}`} />
          </View>
        ))}
      </View>
      <View class="flex-row items-start gap-3">
        <View onLayout={track("switch")}>
          <Toggle checked={on()} onChange={(next) => on.set(next)} label="Switch" hideLabel testID="switch" />
        </View>
        <View class="w-48" onLayout={track("select")}>
          <SelectField items={[{ value: "pear", label: "Pear" }, { value: "plum", label: "Plum" }]} value={choice()} onChange={(value) => choice.set(value)} testID="select" />
        </View>
        <DropdownMenu
          label="Actions"
          trigger={<MenuIconTrigger label="Actions" testID="menu-trigger" />}
          items={[
            { id: "one", label: "First action", icon: "PhPencilSimple" },
            { id: "two", label: "Second action", checked: true },
            { id: "sep", separator: true },
            { id: "three", label: "Delete", icon: "PhTrash", danger: true },
          ]}
        />
        <Button testID="open-dialog" size="xs" variant="outlined" label="Dialog" onPress={() => dialog.set(true)} />
      </View>
      <View class="w-64" onLayout={track("card")}>
        <Card class="p-3">
          <View onLayout={track("card-content")}>
            <Text class="text-sm text-foreground">Card</Text>
          </View>
        </Card>
      </View>
      {/* A menu's paper as MENU_POPUP draws it, its item as MENU_ITEM_BOX does (the highlight inset
          8pt, the text 8pt further in), beside the item as it was (px-4 across the whole width). */}
      <View class="flex-row gap-3">
        <View class={`${MENU_POPUP} w-56`}>
          <View class={`${MENU_ITEM_BOX} py-2`} onLayout={track("menu-item")}>
            <View onLayout={track("menu-item-text")}>
              <Text class="text-sm text-foreground">Inset item</Text>
            </View>
          </View>
        </View>
        <View class={`${MENU_POPUP} w-56`}>
          <View class="px-4 py-2" onLayout={track("menu-item-before")}>
            <View onLayout={track("menu-item-text-before")}>
              <Text class="text-sm text-foreground">Item before</Text>
            </View>
          </View>
        </View>
      </View>
      <Text testID="frames" class="text-[9px] text-muted-foreground">{`frames=${JSON.stringify(frames())}`}</Text>
      <Modal open={dialog()} onClose={() => dialog.set(false)} title="Dialog" testID="dialog" footer={<Button label="Done" onPress={() => dialog.set(false)} />}>
        <TextField value="Dialog field" />
      </Modal>
    </View>
  );
}

mount(() => <Gallery />);
