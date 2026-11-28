// The console's theme, in Settings › General: a row with the current theme only (its picture, name,
// whether it is light or dark, a line about it, and "Change theme"), and the Themes dialog it opens,
// with every theme's picture, grouped by light and dark, the current one outlined and ticked.
// Choosing a theme shows it at once and keeps it on this device (lib/stores/themeStore.js).
import { signal, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { translate } from "../../lib/core/context.js";
import { THEMES, themeOf, themePreview } from "../../lib/core/themes.js";
import { themeState } from "../../lib/stores/index.js";
import { isMobile } from "../../lib/shell";
import { Badge, Button, Icon, Modal } from "../ui";
import { CARD_CORNERS } from "../corners";
import { useRevealRow } from "../settings-page/reveal";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

type Theme = (typeof THEMES)[number];

/**
 * A small picture of a theme, drawn only from its own colours whatever theme the console shows:
 * its main navigation with the current row, the ground, a sent bubble, a reply and the composer
 * with its button.
 */
export function ThemePreview(props: { theme: Theme; width: number; height: number; testID?: string }) {
  const c = () => themePreview(props.theme);
  const w = (share: number) => Math.round(props.width * share);
  const h = (share: number) => Math.round(props.height * share);
  const bar = (left: number, top: number, width: number, color: string, height = 3) => (
    <View class="absolute rounded-[1px]" style={{ left: w(left), top: h(top), width: w(width), height, backgroundColor: color }} />
  );
  return (
    <View
      class="relative overflow-hidden rounded-[4px] border"
      style={{ width: props.width, height: props.height, backgroundColor: c().ground, borderColor: c().line }}
      accessibilityElementsHidden
      testID={props.testID}
    >
      <View class="absolute bottom-0 left-0 top-0" style={{ width: w(0.3), backgroundColor: c().nav }} />
      {bar(0.07, 0.1, 0.14, c().mark, 4)}
      <View
        class="absolute rounded-[2px]"
        style={{ left: w(0.04), top: h(0.3), width: w(0.22), height: h(0.12), backgroundColor: c().navSelection }}
      />
      {bar(0.07, 0.345, 0.12, c().navText)}
      {bar(0.07, 0.52, 0.15, c().navMuted)}
      {bar(0.07, 0.63, 0.11, c().navMuted)}
      {bar(0.07, 0.74, 0.13, c().navMuted)}
      <View
        class="absolute rounded-[2px]"
        style={{ left: w(0.63), top: h(0.1), width: w(0.3), height: h(0.15), backgroundColor: c().bubble }}
      />
      {bar(0.36, 0.36, 0.13, c().accent)}
      {bar(0.36, 0.46, 0.52, c().ink, 4)}
      {bar(0.36, 0.56, 0.44, c().muted, 4)}
      <View
        class="absolute rounded-[2px] border"
        style={{ left: w(0.36), top: h(0.76), width: w(0.57), height: h(0.16), backgroundColor: c().panel, borderColor: c().line }}
      />
      <View
        class="absolute rounded-[2px]"
        style={{ left: w(0.83), top: h(0.795), width: w(0.08), height: h(0.09), backgroundColor: c().primary }}
      />
    </View>
  );
}

const schemeLabel = (theme: Theme) => t(theme.scheme === "dark" ? "settings_theme_dark" : "settings_theme_light");

/** The Themes dialog: every theme, light ones first, then dark ones. */
function ThemesDialog(props: { open: boolean; onClose: () => void }) {
  const groups = () =>
    (["light", "dark"] as const)
      .map((scheme) => ({ scheme, themes: THEMES.filter((theme) => theme.scheme === scheme) }))
      .filter((group) => group.themes.length > 0);
  const current = (theme: Theme) => themeState.theme === theme.id;
  return (
    <Modal open={props.open} onClose={props.onClose} title={t("settings_themes_title")} size="lg" testID="settings-themes">
      <View class="gap-4">
        <Each of={groups()} key={(group) => group.scheme}>
          {(group) => (
            <View class="gap-2">
              <Text class="font-mono text-xs uppercase text-muted-foreground">
                {`${t(group().scheme === "dark" ? "settings_theme_dark" : "settings_theme_light")} · ${group().themes.length}`}
              </Text>
              <View class="flex-row flex-wrap gap-3">
                <Each of={group().themes} key={(theme) => theme.id}>
                  {(theme) => (
                    <BaseButton
                      selected={current(theme())}
                      onPress={() => themeState.setTheme(theme().id)}
                      accessibilityLabel={`${theme().name}, ${schemeLabel(theme())}`}
                      testID={`settings-theme-${theme().id}`}
                      class={`gap-2.5 ${CARD_CORNERS} border p-2.5 pb-3 hover:bg-hover active:bg-selection ${
                        current(theme()) ? "border-blue bg-selection" : "border-line-faint bg-card"
                      }`}
                    >
                      <ThemePreview theme={theme()} width={220} height={124} />
                      <View class="flex-row items-start gap-2 px-0.5" style={{ width: 220 }}>
                        <View class="min-w-0 flex-1 gap-0.5">
                          <Text class="text-sm font-semibold text-foreground">{theme().name}</Text>
                          <Text class="text-xs leading-[16px] text-muted-foreground">{t(theme().summaryKey)}</Text>
                        </View>
                        <If when={current(theme())}>
                          <View class="size-5 items-center justify-center rounded-full bg-primary" testID="settings-theme-current">
                            <Icon name="PhCheck" size={12} color="primary-foreground" />
                          </View>
                        </If>
                      </View>
                    </BaseButton>
                  )}
                </Each>
              </View>
            </View>
          )}
        </Each>
      </View>
    </Modal>
  );
}

/** Settings › General's Theme row: the current theme, and the way to the Themes dialog. */
export function ThemeSetting() {
  const open = signal(false);
  const theme = () => themeOf(themeState.theme);
  // Found by the settings search under "Theme", and ringed when it leads here.
  const reveal = useRevealRow(() => t("settings_theme_title"));
  return (
    <View
      ref={reveal.ref}
      style={reveal.style()}
      class={`rounded-(--radius) border-t border-line-soft py-3 ${isMobile() ? "gap-3" : "flex-row items-center gap-4"} ${
        reveal.ringed() ? "ring-2 ring-blue" : ""
      }`}
      accessibilityLabel={t("settings_theme_title")}
      testID="settings-theme"
    >
      <View class="min-w-0 flex-1 flex-row items-center gap-4">
        <ThemePreview theme={theme()} width={isMobile() ? 132 : 150} height={isMobile() ? 74 : 84} testID="settings-theme-preview" />
        <View class="min-w-0 flex-1 gap-1.5">
          <Text class="text-sm font-medium leading-[18.9px] text-foreground" testID="settings-theme-name">
            {theme().name}
          </Text>
          <View class="flex-row flex-wrap items-center gap-2">
            <Badge label={schemeLabel(theme())} />
            <Text class="text-xs leading-[20.3px] text-muted-foreground">{t(theme().summaryKey)}</Text>
          </View>
        </View>
      </View>
      <View class={isMobile() ? "self-stretch" : "self-center"}>
        <Button
          variant="outlined"
          label={t("settings_theme_change")}
          block={isMobile()}
          onPress={() => open.set(true)}
          testID="settings-theme-change"
        />
      </View>
      <ThemesDialog open={open()} onClose={() => open.set(false)} />
    </View>
  );
}
