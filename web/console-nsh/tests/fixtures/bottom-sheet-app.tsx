// A test entry for tests/bottom-sheet.test.tsx: nsh/base's Menu and Select styled as the console's
// dropdowns are (components/ui.tsx: DropdownMenu, SelectField; the composer's model picker), each
// with its rows measured, so the test reads where a sheet's last row ends above the bottom of the
// screen. Buttons open one at a time; "keyboard" stands in for a software keyboard the sheet rises
// above (headless engines draw none). `pagePosition` is where a view is on the surface. Real
// SelectField and DropdownMenu controls are there too, for opening, choosing and dismissing.
import type { Bounds } from "nsh";
import { mount, signal, Text, View } from "nsh";
import { Menu, MenuItem, Select } from "nsh/base";
import { PROFILE_SHEET_MAX_HEIGHT, PROFILE_SHEET_PADDING } from "../../components/chat/composerSheets";
import { bottomSheetStyle, DropdownMenu, MENU_POPUP, MENU_POPUP_STYLE, SelectField } from "../../components/ui";

type Frame = { x: number; y: number; w: number; h: number; px?: number; py?: number };

const frames = signal<Record<string, Frame>>({});
const opened = signal<string | null>(null);
const keyboard = signal(0);
const chosen = signal("");
const fieldValue = signal("a");

function put(name: string, frame: Partial<Frame>) {
  frames.update((all) => ({ ...all, [name]: { ...all[name], ...frame } as Frame }));
}

/** A view whose frame and place on the surface are read out as `name`. */
function Measured(props: { name: string; class?: string; children?: any }) {
  let node: any = null;
  return (
    <View
      class={props.class ?? ""}
      ref={(ref: any) => (node = ref)}
      onLayout={(event: { bounds: Bounds }) => {
        const { origin, size } = event.bounds;
        put(props.name, { x: origin.x, y: origin.y, w: size.width, h: size.height });
        void node?.measure().then((m: any) => {
          if (m) put(props.name, { px: m.pagePosition.x, py: m.pagePosition.y });
        });
      }}
    >
      {props.children}
    </View>
  );
}

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ value: `v${i}`, title: `Row ${i}` }));
const SHORT = rows(3);
const LONG = rows(30);

const button = (id: string, label: string, onPress: () => void) => (
  <Text testID={id} class="p-2" onPress={onPress}>
    {label}
  </Text>
);

/** A Menu as DropdownMenu draws it (MENU_POPUP, `py-2`), or as SelectField's plain menu (`max-h-80`). */
function MeasuredMenu(props: { name: string; count: number; contentMax?: number }) {
  return (
    <Menu
      open={opened() === props.name}
      onOpenChange={({ open }) => opened.set(open ? props.name : null)}
      placement="bottom"
      align="end"
      popupClass={`${MENU_POPUP} ${props.contentMax ? "max-h-80" : ""}`}
      popupStyle={bottomSheetStyle(8, { style: MENU_POPUP_STYLE, contentMax: props.contentMax })}
      trigger={<Text testID={`${props.name}-trigger`}>{props.name}</Text>}
    >
      <Measured name={`${props.name}-items`}>
        {rows(props.count).map((row) => (
          <MenuItem onSelect={() => chosen.set(row.title)} class="h-10 justify-center px-4">
            <Text class="text-sm">{row.title}</Text>
          </MenuItem>
        ))}
      </Measured>
    </Menu>
  );
}

/** A Select as the composer's model picker (`py-1`, `max-h-80`, searchable, rising with the keyboard). */
function MeasuredSelect(props: { name: string; items: { value: string; title: string }[] }) {
  return (
    <Select
      items={props.items}
      value={null}
      searchable
      open={opened() === props.name}
      onOpenChange={({ open }) => opened.set(open ? props.name : null)}
      onChange={({ value }) => chosen.set(String(value))}
      placement="top"
      align="end"
      testID={`${props.name}-trigger`}
      popupClass="min-w-60 max-h-80 rounded-(--radius) border border-border bg-popover py-1 shadow-md"
      popupStyle={bottomSheetStyle(PROFILE_SHEET_PADDING, { contentMax: PROFILE_SHEET_MAX_HEIGHT, keyboard: keyboard() })}
      itemClass="px-3 py-1.5"
      searchClass="mx-2 mb-1 rounded-(--radius) border border-input px-2 py-1 text-sm"
      searchPlaceholder="Filter"
      renderItem={(entry) => (
        <Measured name={`${props.name}-row-${entry.index}`} class="h-8 justify-center">
          <Text class="text-sm">{entry.title}</Text>
        </Measured>
      )}
      trigger={<Text>{props.name}</Text>}
    />
  );
}

function Gallery() {
  return (
    <View class="flex-1 bg-background">
      <View class="flex-row flex-wrap gap-2 p-2">
        <MeasuredMenu name="menu" count={3} />
        <MeasuredMenu name="long-menu" count={12} contentMax={320} />
        <MeasuredSelect name="select" items={SHORT} />
        <MeasuredSelect name="long-select" items={LONG} />
        {button("keyboard-up", "Keyboard up", () => keyboard.set(300))}
        {button("keyboard-down", "Keyboard down", () => keyboard.set(0))}
      </View>
      <View class="flex-row gap-2 p-2">
        <DropdownMenu
          trigger={<Text testID="dropdown-trigger">Actions</Text>}
          items={[
            { id: "one", label: "First action", onSelect: () => chosen.set("first") },
            { id: "two", label: "Second action", onSelect: () => chosen.set("second") },
          ]}
        />
        <SelectField
          testID="field"
          placeholder="Pick"
          value={fieldValue()}
          onChange={(value) => fieldValue.set(value)}
          items={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Bravo" },
          ]}
        />
      </View>
      <Text testID="state">{`opened=${opened() ?? ""} chosen=${chosen()} field=${fieldValue()}`}</Text>
      <Text>{JSON.stringify(frames())}</Text>
    </View>
  );
}

mount(() => <Gallery />);
