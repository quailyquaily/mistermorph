// The inference provider picker (the Vue console's InferenceProviderPicker): a trigger with the
// chosen provider's logo, opening a dialog of provider cards by group (API, account, local gateway,
// compatible), with a filter that searches every group.
//
// Vue to nsh: `modelValue` is `value`; `change` is `onChange(item)`.
import { batch, Image, signal, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { inferenceProviderLogo } from "../../lib/core/inference-provider-logos.js";
import { Icon, Modal, Tabs, TextField } from "../ui";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

export interface ProviderItem {
  title: string;
  value: string;
  note?: string;
  /** "api" | "account" | "local_gateway" | "compatible". */
  group?: string;
}

export interface InferenceProviderPickerProps {
  value: string;
  items: ProviderItem[];
  placeholder?: string;
  disabledReason?: string;
  disabled?: boolean;
  readOnly?: boolean;
  onChange?: (item: ProviderItem) => void;
  testID?: string;
}

const DEFAULT_PROVIDER_GROUP = "api";
const PROVIDER_GROUPS = [
  { id: "api", labelKey: "settings_inference_provider_group_api" },
  { id: "account", labelKey: "settings_inference_provider_group_account" },
  { id: "local_gateway", labelKey: "settings_inference_provider_group_local_gateway" },
  { id: "compatible", labelKey: "settings_inference_provider_group_compatible" },
];

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function fallbackLogoText(item: ProviderItem | null) {
  const title = normalizeText(item?.title);
  if (!title) return "LLM";
  const compact = title
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
  return compact || title.slice(0, 2).toUpperCase();
}

function providerLogo(item: ProviderItem | null): { src: any; className: string } {
  const value = normalizeText(item?.value);
  if (!item || value === "") return { src: "", className: "is-empty" };
  return inferenceProviderLogo(value);
}

/** A provider's logo in a square tile, or its initials. */
export function ProviderLogo(props: { item: ProviderItem | null; size?: number }) {
  const size = () => props.size ?? 28;
  return (
    <View
      class="items-center justify-center overflow-hidden rounded-(--radius) border border-line-faint bg-card"
      style={{ width: size(), height: size() }}
      accessibilityElementsHidden
    >
      <If
        when={providerLogo(props.item).src}
        else={<Text class="font-mono text-xs font-medium text-subtle">{props.item ? fallbackLogoText(props.item) : "LLM"}</Text>}
      >
        <Image src={providerLogo(props.item).src} style={{ width: size() * 0.72, height: size() * 0.72, objectFit: "contain" }} />
      </If>
    </View>
  );
}

export function InferenceProviderPicker(props: InferenceProviderPickerProps) {
  const open = signal(false);
  const filter = signal("");
  const activeGroup = signal(DEFAULT_PROVIDER_GROUP);

  const items = (): Required<ProviderItem>[] =>
    (Array.isArray(props.items) ? props.items : [])
      .map((item) => {
        const group = normalizeText(item?.group);
        return {
          title: normalizeText(item?.title),
          value: normalizeText(item?.value),
          note: normalizeText(item?.note),
          group: PROVIDER_GROUPS.some((candidate) => candidate.id === group) ? group : DEFAULT_PROVIDER_GROUP,
        };
      })
      .filter((item) => item.title !== "" || item.value !== "");
  const selectedItem = () => items().find((item) => item.value === normalizeText(props.value)) || null;
  const selectedTitle = () =>
    selectedItem()?.title || normalizeText(props.placeholder) || t("settings_inference_provider_picker_placeholder");
  const groupTabs = () => PROVIDER_GROUPS.map((group) => ({ id: group.id, label: t(group.labelKey) }));
  const isFiltering = () => normalizeText(filter()) !== "";
  const filteredItems = () => {
    const query = normalizeText(filter()).toLowerCase();
    if (!query) return items().filter((item) => item.group === activeGroup());
    return items().filter((item) =>
      [item.title, item.value, item.note].some((value) => normalizeText(value).toLowerCase().includes(query)),
    );
  };
  const blocked = () => Boolean(props.disabled || props.readOnly);

  const openDialog = () => {
    if (blocked()) {
      console.warn("[InferenceProviderPicker] dialog open blocked", {
        reason: normalizeText(props.disabledReason) || (props.readOnly ? "readOnly" : "disabled"),
        disabled: props.disabled,
        readOnly: props.readOnly,
        provider: normalizeText(props.value),
        itemCount: items().length,
      });
      return;
    }
    batch(() => {
      filter.set("");
      activeGroup.set(selectedItem()?.group || DEFAULT_PROVIDER_GROUP);
      open.set(true);
    });
  };
  const isSelected = (item: ProviderItem) => normalizeText(item?.value) === normalizeText(props.value);
  const selectItem = (item: ProviderItem) => {
    if (!item || blocked()) return;
    props.onChange?.(item);
    open.set(false);
  };

  return (
    <View testID={props.testID}>
      <BaseButton
        disabled={blocked()}
        onPress={openDialog}
        accessibilityLabel={`${t("settings_agent_provider_label")}: ${selectedTitle()}`}
        testID={props.testID ? `${props.testID}-trigger` : "inference-provider-trigger"}
        class="min-h-11 flex-row items-center gap-3 rounded-(--radius) border border-input bg-field px-2 hover:border-ring disabled:opacity-60"
      >
        <ProviderLogo item={selectedItem()} />
        <Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>
          {selectedTitle()}
        </Text>
        <Icon name="PhCaretDown" size={12} color="muted-foreground" />
      </BaseButton>

      <Modal
        open={open()}
        onClose={() => open.set(false)}
        title={t("settings_inference_provider_dialog_title")}
        size="xl"
        testID="inference-provider-dialog"
      >
        <TextField
          value={filter()}
          onChange={(value) => filter.set(value)}
          placeholder={t("settings_inference_provider_filter_placeholder")}
          leadingIcon="PhMagnifyingGlass"
          testID="inference-provider-filter"
        />
        <If when={!isFiltering()}>
          <Tabs items={groupTabs()} value={activeGroup()} onChange={(id) => activeGroup.set(id)} />
        </If>
        <View class="flex-row flex-wrap gap-2" accessibilityLabel={t("settings_inference_provider_dialog_title")}>
          <Each of={filteredItems()} key={(item) => item.value || "__empty__"}>
            {(item) => (
              <BaseButton
                selected={isSelected(item())}
                onPress={() => selectItem(item())}
                accessibilityLabel={item().title}
                class={`min-h-14 grow basis-48 flex-row items-center gap-3 rounded-(--radius) border px-3 py-2 hover:bg-hover active:bg-selection ${
                  isSelected(item()) ? "border-blue bg-selection" : "border-line-faint bg-card"
                }`}
              >
                <ProviderLogo item={item()} size={32} />
                <Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 2 }}>
                  {item().title}
                </Text>
                <If when={isSelected(item())}>
                  <Text class="font-mono text-xs uppercase text-blue">{t("settings_inference_provider_selected")}</Text>
                </If>
              </BaseButton>
            )}
          </Each>
          <If when={filteredItems().length === 0}>
            <Text class="w-full py-6 text-center text-sm text-muted-foreground">{t("settings_inference_provider_empty")}</Text>
          </If>
        </View>
      </Modal>
    </View>
  );
}
