// A test entry for tests/mobile-popup.test.tsx: one of every kind of popup the console draws
// (design/mobile-popups.md), each behind its own trigger in a column of controls, with what the
// test reads of them put beside it as JSON:
//
// - `<name>.panel`: the paper's frame in its layer (the window), by the layer's test id or label;
// - `<name>.motion`: the paper's vertical translation, scale and opacity sampled every frame for a
//   while from its last layout (its entrance, when it has just opened);
// - `chosen`: the last choice made, `flow`: the column of controls' height (a popup declared in
//   it must take no room there, open or shut).
//
// "keyboard" stands a software keyboard in (headless engines draw none); `host.params.long` makes
// the lists long.
import { host, mount, signal, Text, untracked, View, type Motion } from "nsh";
import { AttachSourceSheet } from "../../components/chat/AttachSourceSheet";
import { SettingDialog } from "../../components/settings/SettingDialog";
import { SettingMenu } from "../../components/settings/SettingFields";
import { DateField } from "../../components/shared/DateField";
import { PopoverPicker } from "../../components/shared/PopoverPicker";
import { TodoSelect } from "../../components/todo/TodoSelect";
import {
  Button,
  DropdownMenu,
  MenuIconTrigger,
  MessageDialog,
  Modal,
  SelectField,
  standInKeyboard,
  watchDialogs,
  type MenuEntry,
} from "../../components/ui";

const params = host.params as { long?: boolean };
const COUNT = params.long ? 40 : 4;

const report = signal<Record<string, unknown>>({});
const put = (key: string, value: unknown) => report.update((all) => ({ ...all, [key]: value }));
const round = (n: number) => Math.round(n * 1000) / 1000;

// Every dialog layer made below reports its paper's frame and hands over its motion, which is
// sampled every frame for 700 ms from each layout of the paper (its first one is where an entrance
// starts: a step of the test only ends once the app is quiet, so the samples cannot wait for one).
const motions: Record<string, Motion> = {};
const sampling: Record<string, boolean> = {};
function sample(name: string, key = `${name}.motion`) {
  const motion = motions[name];
  if (!motion || sampling[key]) return;
  sampling[key] = true;
  report.update(({ [key]: _, ...rest }) => rest);
  const series: { t: number; y: number; s: number; o: number }[] = [];
  const started = Date.now();
  const tick = async () => {
    const [y, s, o] = await Promise.all([motion.translateY.getValue(), motion.scale.getValue(), motion.opacity.getValue()]);
    series.push({ t: Date.now() - started, y: round(y), s: round(s), o: round(o) });
    if (Date.now() - started < 700) setTimeout(() => void tick(), 16);
    else {
      sampling[key] = false;
      put(key, series);
    }
  };
  void tick();
}
watchDialogs((name) => ({
  layout: (bounds) => {
    put(`${name}.panel`, { x: round(bounds.origin.x), y: round(bounds.origin.y), w: round(bounds.size.width), h: round(bounds.size.height) });
    sample(name);
  },
  motion: (motion) => {
    motions[name] = motion;
  },
  // Its way out, from the moment it is told to go (`<name>.exit`).
  leave: () => sample(name, `${name}.exit`),
}));

const which = signal<string | null>(null);
const chosen = signal("");
const choose = (value: string) => {
  chosen.set(value);
  put("chosen", value);
};
const selected = signal("v1");
const date = signal("2026-03-04T09:30");
const since = signal("");
const pickerOpen = signal(false);
const settingOpen = signal(false);

const CHOICES = Array.from({ length: COUNT }, (_, i) => ({ value: `v${i}`, label: `Choice ${i}`, description: i === 0 ? "The first one" : undefined }));
const COMMANDS: MenuEntry[] = [
  { id: "rename", label: "Rename", icon: "PhPencilSimple", onSelect: () => choose("rename") },
  { id: "pin", label: "Pin", checked: true, onSelect: () => choose("pin") },
  { id: "locked", label: "Locked", disabled: true, onSelect: () => choose("locked") },
  { id: "sep", separator: true },
  { id: "delete", label: "Delete", danger: true, description: "Cannot be undone", onSelect: () => choose("delete") },
  ...Array.from({ length: params.long ? 30 : 0 }, (_, i) => ({ id: `more${i}`, label: `More ${i}`, onSelect: () => choose(`more${i}`) })),
];

const CALENDAR = {
  headerClass: "flex-row items-center justify-between pb-2",
  rowClass: "flex-row justify-between",
  itemClass: "h-8 min-w-8 items-center justify-center text-sm text-foreground selected:bg-primary selected:text-primary-foreground",
};

function Page() {
  const close = () => which.set(null);
  return (
    <View class="flex-1 gap-1 bg-background p-2">
      <View class="flex-row flex-wrap gap-1">
        <Button size="xs" label="keyboard" onPress={() => standInKeyboard(300)} testID="keyboard-up" />
        <Button size="xs" label="no keyboard" onPress={() => standInKeyboard(null)} testID="keyboard-down" />
        <Each of={["modal", "message", "attach", "setting"]} key={(kind) => kind}>
          {(kind) => <Button size="xs" label={`open ${kind()}`} onPress={() => which.set(kind())} testID={`open-${kind()}`} />}
        </Each>
        {/* Closes whichever dialog is open, as its owner would (headless presses do no hit test). */}
        <Button
          size="xs"
          label="close"
          onPress={() => {
            close();
            pickerOpen.set(false);
          }}
          testID="close-all"
        />
      </View>

      {/* The dropdowns and bubbles, in a column that reports its height. */}
      <View class="gap-2" onLayout={({ bounds }) => put("flow", round(bounds.size.height))}>
        <View class="flex-row items-center gap-2" onLayout={({ bounds }) => put("row", round(bounds.size.width))}>
          <DropdownMenu label="Topic" items={COMMANDS} trigger={<MenuIconTrigger label="Topic menu" testID="menu" />} />
          <SettingMenu
            items={[
              { title: "minutes", value: "60", hint: "min" },
              { title: "hours", value: "3600", hint: "h" },
            ]}
            selected="60"
            label="Unit"
            testID="unit"
            onSelect={(item) => choose(`unit:${item.value}`)}
            trigger={
              <View class="px-3 py-2">
                <Text class="text-sm">unit</Text>
              </View>
            }
          />
          <PopoverPicker
            items={CHOICES.map((item) => ({ value: item.value, title: item.label }))}
            value={selected()}
            onChange={(value) => choose(`picker:${value}`)}
            accessibilityLabel="Model"
            label="Model"
            filterPlaceholder="Filter"
            placement="bottom"
            open={pickerOpen()}
            onOpenChange={(open) => pickerOpen.set(open)}
            trigger={() => (
              <View class="px-3 py-2">
                <Text class="text-sm">picker</Text>
              </View>
            )}
            testID="picker"
          />
        </View>
        <SelectField
          items={CHOICES}
          value={selected()}
          label="Plain"
          testID="select"
          onChange={(value) => {
            selected.set(value);
            choose(`select:${value}`);
          }}
        />
        <SelectField items={CHOICES} value={selected()} label="Searchable" placeholder="Find one" searchable testID="search" onChange={(value) => choose(`search:${value}`)} />
        <TodoSelect
          label="Chat"
          items={CHOICES.map((item) => ({ id: item.value, value: item.value, title: item.label, subtitle: "a chat", icon: "PhChats" }))}
          current={null}
          placeholder="Pick a chat"
          testID="todo"
          onChange={(value) => choose(`todo:${value}`)}
        />
        <DateField
          value={date()}
          timePrecision="minute"
          accessibilityLabel="Run at"
          timeAccessibilityLabel="Time"
          testID="date"
          onChange={({ value }) => {
            if (typeof value !== "string") return;
            date.set(value);
            choose(`date:${value}`);
          }}
          popupClass="border border-line-faint bg-dialog p-3"
          timeClass="mt-2 flex-row items-center justify-between gap-3"
          timeLabel={<Text class="text-sm">Time</Text>}
          {...CALENDAR}
          trigger={
            <View class="h-9.5 flex-row items-center border border-input px-3">
              <Text class="text-sm">{date()}</Text>
            </View>
          }
        />
        <DateField
          value={since() || null}
          cleanable
          accessibilityLabel="Since"
          clearButtonAccessibilityLabel="Clear the date"
          testID="since"
          onChange={({ value }) => {
            since.set(typeof value === "string" ? value.slice(0, 10) : "");
            choose(`since:${untracked(since)}`);
          }}
          popupClass="border border-line-faint bg-dialog p-3"
          {...CALENDAR}
          trigger={
            <View class="h-9.5 flex-row items-center border border-input px-3">
              <Text class="text-sm">{since() || "since"}</Text>
            </View>
          }
        />
      </View>

      <Modal
        open={which() === "modal"}
        onClose={close}
        title="A dialog"
        testID="modal"
        footer={
          <>
            <Button variant="outlined" label="Cancel" onPress={close} testID="modal-cancel" />
            <Button
              variant="primary"
              label="Save"
              onPress={close}
              testID="modal-save"
              onLayout={({ bounds }) => put("modal.save", { w: round(bounds.size.width), h: round(bounds.size.height) })}
            />
          </>
        }
      >
        <Each of={Array.from({ length: COUNT }, (_, i) => i)} key={(i) => i}>
          {(i) => (
            <Text class="h-10 text-sm" testID={`modal-row-${i()}`}>
              {`Row ${i()}`}
            </Text>
          )}
        </Each>
      </Modal>
      <MessageDialog
        open={which() === "message"}
        onClose={close}
        title="Remove it?"
        text="This cannot be undone."
        testID="message"
        actions={[
          { id: "cancel", label: "Cancel", onPress: close },
          { id: "ok", label: "Remove", variant: "danger", onPress: close },
        ]}
      />
      <AttachSourceSheet open={which() === "attach"} onClose={close} onChoose={(source) => choose(`attach:${source}`)} testID="attach" />
      <SettingDialog
        open={which() === "setting" || settingOpen()}
        onOpenChange={(open) => {
          if (!open) {
            close();
            settingOpen.set(false);
          }
        }}
        onSave={close}
        title="A setting"
        testID="setting"
      >
        <Each of={Array.from({ length: COUNT }, (_, i) => i)} key={(i) => i}>
          {(i) => <Text class="h-10 text-sm">{`Setting ${i()}`}</Text>}
        </Each>
      </SettingDialog>
      {/* Last, so that a long report (the motion samples) pushes no control out of the window. */}
      <Text class="text-[6px]">{JSON.stringify(report())}</Text>
    </View>
  );
}

mount(() => <Page />);
