// A dropdown of the TODO editor (the Vue page's AppDropdownMenu with a #prepend label): the field's
// name before the chosen item, items with a logo or an icon and a second line, and an optional
// filter. Built here because SelectField in ui.tsx draws plain titles only.
import { Image, Text, View } from "nsh";
import { Select } from "nsh/base";
import { Icon, type IconName } from "../ui";
import type { TodoMenuItem } from "./todo-state";

function ItemMedia(props: { item: TodoMenuItem | undefined; size?: number }) {
  return (
    <If
      when={props.item?.image}
      else={
        <If when={props.item?.icon}>
          <Icon name={props.item!.icon as IconName} size={props.size ?? 15} color="subtle" />
        </If>
      }
    >
      <Image
        src={props.item!.image!}
        accessibilityElementsHidden
        style={{ width: props.size ?? 15, height: props.size ?? 15 }}
      />
    </If>
  );
}

export function TodoSelect(props: {
  /** The field's name, shown before the value (the Vue #prepend). */
  label: string;
  items: TodoMenuItem[];
  /** The item shown as chosen (it may be one the list does not have: an unavailable chat). */
  current: TodoMenuItem | null | undefined;
  onChange?: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  /** Hide the chosen item's logo in the trigger (the Vue todo-dropdown-hide-selected-media). */
  hideSelectedMedia?: boolean;
  disabled?: boolean;
  testID?: string;
  class?: string;
}) {
  const byValue = () => new Map(props.items.map((item) => [item.value, item]));
  return (
    <Select
      items={props.items.map((item) => ({ value: item.value, title: item.title }))}
      value={props.current?.value ?? null}
      disabled={props.disabled}
      searchable={props.searchable}
      searchPlaceholder={props.placeholder}
      searchAccessibilityLabel={props.label}
      accessibilityLabel={props.label}
      testID={props.testID}
      onChange={({ value }) => value !== null && props.onChange?.(value)}
      class={`flex-row items-center gap-2 rounded-(--radius) border border-input bg-field px-2.5 py-1.5 disabled:opacity-50 ${
        props.class ?? ""
      }`}
      popupClass="max-h-96 min-w-64 rounded-(--radius) border border-border bg-popover py-1 shadow-md"
      itemClass="px-3 py-1.5 hover:bg-hover focus:bg-hover selected:bg-selection"
      searchClass="mx-2 mb-1 rounded-(--radius) border border-input px-2 py-1 text-sm"
      empty={
        <View class="px-3 py-2">
          <Text class="text-xs text-muted-foreground">{props.placeholder ?? ""}</Text>
        </View>
      }
      renderItem={(entry) => (
        <View class="flex-row items-center gap-2">
          <ItemMedia item={byValue().get(entry.value)} />
          <View class="flex-1">
            <Text class="text-sm text-foreground line-clamp-1">{entry.title}</Text>
            <If when={byValue().get(entry.value)?.subtitle}>
              <Text class="text-xs text-muted-foreground line-clamp-1">{byValue().get(entry.value)?.subtitle}</Text>
            </If>
          </View>
        </View>
      )}
      trigger={
        <View class="flex-1 flex-row items-center gap-2">
          <Text class="font-mono text-xs uppercase tracking-wide text-muted-foreground">{props.label}</Text>
          <If when={!props.hideSelectedMedia}>
            <ItemMedia item={props.current ?? undefined} size={14} />
          </If>
          <Text
            class={`flex-1 text-sm line-clamp-1 ${props.current ? "text-foreground" : "text-placeholder"}`}
          >
            {props.current?.title ?? props.placeholder ?? ""}
          </Text>
          <Icon name="PhCaretDown" size={12} color="muted-foreground" />
        </View>
      }
    />
  );
}
