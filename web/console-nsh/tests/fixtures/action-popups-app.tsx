// A test entry for tests/action-popups.test.tsx: the console's kinds of popup rows, side by side:
// menus of actions (a DropdownMenu, a PopoverPicker without a value), pickers with a chosen row (a
// PopoverPicker, a select, a settings list, the setup picker) and pickers with none chosen (a
// select and a TODO select without a value, the setup picker with no value in use). The last
// choice made is shown as `chosen=<what>`.
import { mount, signal, Text, View } from "nsh";
import { SettingMenu } from "../../components/settings/SettingFields";
import { SetupPickerDialog } from "../../components/settings/SetupPickerDialog";
import { PopoverPicker } from "../../components/shared/PopoverPicker";
import { TodoSelect } from "../../components/todo/TodoSelect";
import { Button, DropdownMenu, MenuIconTrigger, SelectField, type MenuEntry } from "../../components/ui";

const chosen = signal("");
const profile = signal("p1");
const plain = signal("v1");
const setup = signal<"" | "none" | "chosen">("");

const COMMANDS: MenuEntry[] = [
  { id: "locked", label: "Locked", disabled: true, onSelect: () => chosen.set("locked") },
  { id: "rename", label: "Rename", icon: "PhPencilSimple", onSelect: () => chosen.set("rename") },
  { id: "pin", label: "Pin", checked: true, onSelect: () => chosen.set("pin") },
  { id: "sep", separator: true },
  { id: "delete", label: "Delete", danger: true, onSelect: () => chosen.set("delete") },
];
const CHOICES = [0, 1, 2].map((i) => ({ value: `v${i}`, label: `Choice ${i}` }));
const MODELS = [1, 2, 3].map((i) => ({ id: `m${i}`, title: `Model ${i}`, value: `m${i}` }));

const pill = (label: string) => (
  <View class="px-3 py-2">
    <Text class="text-sm">{label}</Text>
  </View>
);

function Page() {
  return (
    <View class="flex-1 gap-2 bg-background p-2">
      <View class="flex-row flex-wrap items-center gap-2">
        <DropdownMenu label="Topic" items={COMMANDS} testID="menu" trigger={<MenuIconTrigger label="Topic menu" testID="menu" />} />
        <DropdownMenu
          label="Nothing"
          items={[{ id: "off", label: "Off", disabled: true }]}
          testID="inert"
          trigger={<MenuIconTrigger label="Inert menu" testID="inert" />}
        />
        <PopoverPicker
          items={[
            { value: "upload", title: "Upload" },
            { value: "attach", title: "Attach" },
          ]}
          onChange={(value) => chosen.set(`add:${value}`)}
          accessibilityLabel="Add"
          placement="bottom"
          trigger={() => pill("add")}
          testID="add"
        />
        <PopoverPicker
          items={[0, 1, 2].map((i) => ({ value: `p${i}`, title: `Profile ${i}` }))}
          value={profile()}
          onChange={(value) => {
            profile.set(value);
            chosen.set(`profile:${value}`);
          }}
          accessibilityLabel="Profile"
          label="Profile"
          placement="bottom"
          trigger={() => pill("profile")}
          testID="profile"
        />
        <SettingMenu
          items={[
            { title: "minutes", value: "60", hint: "min" },
            { title: "hours", value: "3600", hint: "h" },
          ]}
          selected="60"
          label="Unit"
          testID="unit"
          onSelect={(item) => chosen.set(`unit:${item.value}`)}
          trigger={pill("unit")}
        />
        <Button size="xs" label="setup none" onPress={() => setup.set("none")} testID="open-setup-none" />
        <Button size="xs" label="setup chosen" onPress={() => setup.set("chosen")} testID="open-setup-chosen" />
        <View class="p-2" testID="elsewhere">
          <Text class="text-sm">{`chosen=${chosen()}`}</Text>
        </View>
      </View>
      <SelectField
        items={CHOICES}
        value={plain()}
        label="Plain"
        testID="select"
        onChange={(value) => {
          plain.set(value);
          chosen.set(`select:${value}`);
        }}
      />
      <SelectField items={CHOICES} value={null} label="Unset" placeholder="Pick one" testID="unset" onChange={(value) => chosen.set(`unset:${value}`)} />
      <TodoSelect
        label="Chat"
        items={CHOICES.map((item) => ({ id: item.value, value: item.value, title: item.label }))}
        current={null}
        placeholder="Pick a chat"
        testID="todo"
        onChange={(value) => chosen.set(`todo:${value}`)}
      />
      <SetupPickerDialog
        open={setup() !== ""}
        onOpenChange={(open) => {
          if (!open) setup.set("");
        }}
        title="Choose a model"
        items={MODELS}
        filterPlaceholder="Filter models"
        emptyText="No models"
        selectedValue={setup() === "chosen" ? "m2" : ""}
        onSelect={(item) => {
          chosen.set(`setup:${String(item.value)}`);
          setup.set("");
        }}
      />
    </View>
  );
}

mount(() => <Page />);
