// The language menu (the Vue console's AppLanguageSelector): English, 中文, 日本語.
import { Text, View } from "nsh";
import { localeState } from "../lib/stores/index.js";
import { DropdownMenu, Icon } from "./ui";

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "ja", label: "日本語" },
];

export function LanguageSelector(props: { class?: string }) {
  const current = () => LANGUAGES.find((item) => item.value === localeState.lang) ?? LANGUAGES[0];
  return (
    <DropdownMenu
      align="center"
      trigger={
        <View role="button" accessibilityLabel={current().label} class={`flex-row items-center gap-1.5 rounded-(--radius) px-2 py-1 hover:bg-hover ${props.class ?? ""}`}>
          <Icon name="PhGlobe" size={14} color="muted-foreground" />
          <Text class="text-xs text-subtle">{current().label}</Text>
        </View>
      }
      items={LANGUAGES.map((item) => ({
        id: item.value,
        label: item.label,
        checked: item.value === localeState.lang,
        onSelect: () => localeState.setLanguage(item.value),
      }))}
    />
  );
}
