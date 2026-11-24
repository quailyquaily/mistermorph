// A test entry for tests/picker-popups.test.tsx: the composer's two popups as the composer makes
// them (components/chat/ChatComposer.tsx), at the window's foot: its add menu (two actions with
// their icons, no value) and its profile picker (a value, a filter, a label; `host.params.count`
// profiles, each with an icon). With real icons: an image's natural size is what once reached past
// the rows into the scroll view's extent (components/shared/PickerList.tsx).
//
// What the test reads, as JSON:
// - `<name>.scroll`: the popup's scroll view as it last reported: its frame's size (`w`, `h`), its
//   content's (`cw`, `ch`) and how far it is scrolled (`y`). A scroll view reports when asked to
//   scroll: Ctrl+M scrolls the open ones to their top, Ctrl+E to their end (keys, since a press
//   outside a popup closes it);
// - `<name>.panel`: on phones, the paper's frame in the window;
// - `chosen`: the last row picked.
import { host, keymap, mount, signal, Text, View, type ScrollRef } from "nsh";
import { PopoverPicker, type PickerProbe } from "../../components/shared/PopoverPicker";
import { Icon, watchDialogs } from "../../components/ui";

const params = host.params as { count?: number; touch?: boolean };
const COUNT = params.count ?? 3;

const report = signal<Record<string, unknown>>({});
const put = (key: string, value: unknown) => report.update((all) => ({ ...all, [key]: value }));
watchDialogs((name) => ({
  layout: (bounds) => put(`${name}.panel`, { x: bounds.origin.x, y: bounds.origin.y, w: bounds.size.width, h: bounds.size.height }),
}));

const scrollers: Record<string, ScrollRef> = {};
const probe = (name: string): PickerProbe => ({
  scroller: (ref) => {
    scrollers[name] = ref;
  },
  scroll: (event) =>
    put(`${name}.scroll`, { w: event.size.width, h: event.size.height, cw: event.contentSize.width, ch: event.contentSize.height, y: event.offset.y }),
});
const scrollAll = (y: number) => {
  report.update(({ "add.scroll": _a, "profile.scroll": _p, ...rest }) => rest);
  for (const ref of Object.values(scrollers)) ref.scrollTo({ y, animated: false });
};

// For the whole run: the popups' own keys are bound and let go as they open and close.
keymap.bind({ "ctrl+m": () => scrollAll(0), "ctrl+e": () => scrollAll(100000) }, { when: "always" });

const profile = signal("p0");
const profiles = () =>
  Array.from({ length: COUNT }, (_, index) => ({
    value: `p${index}`,
    title: `Profile ${index}`,
    subtitle: `model-${index}`,
    icon: <Icon name="PhCpu" size={14} color="subtle" />,
  }));
const actions = () => [
  { value: "upload", title: "Upload Files", icon: <Icon name="PhPaperclip" size={16} color="subtle" /> },
  { value: "attach", title: "Attach Workspace", icon: <Icon name="PhCube" size={16} color="subtle" /> },
];
const trigger = (label: string) => () => (
  <View class="h-9 items-center justify-center rounded-full bg-hover px-3">
    <Text class="text-sm">{label}</Text>
  </View>
);

function App() {
  return (
    <View class="flex-1 bg-paper p-3">
      <View class="flex-row gap-2">
        <Text testID="ready" class="text-xs">ready</Text>
        <View testID="elsewhere" class="size-6" onMouseEnter={() => {}} />
      </View>
      <View class="flex-1" />
      <View class="flex-row items-center justify-between">
        <PopoverPicker
          items={actions()}
          onChange={(value) => put("chosen", value)}
          trigger={trigger("add")}
          accessibilityLabel="Add"
          sheet={params.touch ? true : undefined}
          placement="top"
          align="start"
          widthClass="w-60"
          probe={probe("add")}
          testID="add"
        />
        <PopoverPicker
          items={profiles()}
          value={profile()}
          onChange={(value) => {
            profile.set(value);
            put("chosen", value);
          }}
          trigger={trigger("profile")}
          accessibilityLabel="LLM profile"
          label="LLM profile"
          filterPlaceholder="Filter"
          emptyText="Nothing matches"
          sheet={params.touch ? true : undefined}
          placement="top"
          align="end"
          probe={probe("profile")}
          testID="profile"
        />
      </View>
      {/* Last and out of the flow: a long report must not push the controls out of the window. */}
      <View class="absolute left-0 top-12 h-5 w-full overflow-hidden">
        <Text testID="report">{JSON.stringify(report())}</Text>
      </View>
    </View>
  );
}

mount(() => <App />);
