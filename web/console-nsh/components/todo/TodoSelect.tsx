// A dropdown of the TODO editor (the Vue page's AppDropdownMenu with a #prepend label): the field's
// name before the chosen item, items with a logo or an icon and a second line, and an optional
// filter. Built here because SelectField in ui.tsx draws plain titles only. Metrics are the Vue
// page's `.todo-dropdown` (views/TodoView.css): a 44pt trigger with the name in text-1 at 500, the
// value at 400; in the list, logos and icons sit on 24pt round plates and two-line rows are 52pt.
import { Image, Text, View } from "nsh";
import { Select } from "nsh/base";
import { FadeText } from "../motion";
import { Icon, type IconName, MENU_POPUP, MENU_POPUP_STYLE } from "../ui";
import { FIELD_FRAME, FIELD_PAD, FIELD_TRANSITION, Prepend } from "./TodoFields";
import type { TodoMenuItem } from "./todo-state";

/** An item's logo or icon on its round plate (Vue `.menu-image` / `.menu-icon`: 24pt, line-soft 62 %). */
function ItemMedia(props: { item: TodoMenuItem | undefined; size?: number }) {
  const size = () => props.size ?? 24;
  return (
    <If when={props.item?.image || props.item?.icon}>
      <View
        class="items-center justify-center rounded-full bg-line-soft/60"
        style={{ width: size(), height: size() }}
        accessibilityElementsHidden
      >
        <If
          when={props.item?.image}
          else={<Icon name={props.item!.icon as IconName} size={size() - 10} color="muted-foreground" />}
        >
          <Image src={props.item!.image!} style={{ width: size(), height: size(), borderRadius: size() / 2 }} />
        </If>
      </View>
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
      offset={4}
      onChange={({ value }) => value !== null && props.onChange?.(value)}
      class={`${FIELD_FRAME} ${FIELD_PAD} hover:border-outline-line-hover aria-expanded:border-ring disabled:bg-transparent disabled:opacity-50 ${
        props.class ?? ""
      }`}
      style={FIELD_TRANSITION}
      popupClass={`${MENU_POPUP} max-h-100`}
      popupStyle={MENU_POPUP_STYLE}
      itemClass="min-h-10 justify-center px-4 py-2 hover:bg-hover focus:bg-hover selected:bg-selection"
      searchClass="mx-2 mb-2 h-9.5 rounded-(--radius) border border-input bg-field px-3 text-sm text-foreground"
      empty={
        <View class="px-4 py-2">
          <Text class="text-xs text-muted-foreground">{props.placeholder ?? ""}</Text>
        </View>
      }
      renderItem={(entry) => (
        <View class={`flex-row items-center gap-2.5 ${byValue().get(entry.value)?.subtitle ? "min-h-9" : ""}`}>
          <ItemMedia item={byValue().get(entry.value)} />
          <View class="flex-1 gap-0.5">
            <Text class="text-sm text-foreground line-clamp-1">{entry.title}</Text>
            <If when={byValue().get(entry.value)?.subtitle}>
              <Text class="text-xs leading-[15px] text-muted-foreground line-clamp-1">{byValue().get(entry.value)?.subtitle}</Text>
            </If>
          </View>
        </View>
      )}
      trigger={
        <View class="flex-1 flex-row items-center gap-2">
          <Prepend medium>{props.label}</Prepend>
          <If when={!props.hideSelectedMedia}>
            <ItemMedia item={props.current ?? undefined} />
          </If>
          <FadeText
            text={props.current?.title ?? props.placeholder ?? ""}
            class={`flex-1 text-sm ${props.current ? "text-foreground" : "text-placeholder"}`}
          />
          <Icon name="PhCaretDown" size={14} color="muted-foreground" class="opacity-50" />
        </View>
      }
    />
  );
}
