// Settings' Credits section (the Vue console's SettingsCreditsPanel): contributors with their
// GitHub avatars, and the open source projects the product ships with.
import { effect, Image, signal, Text, untracked, View } from "nsh";
import { apiFetch } from "../../lib/core/context.js";
import { openExternal } from "../../lib/platform";
import { Button, Icon, Tip } from "../ui";
import { LoadingLine, SettingsCard } from "../settings-page/parts";
import { InlineNotice, t } from "./DialogShell";

interface CreditItem {
  id?: string;
  name?: string;
  link?: string;
  license?: string;
  summary?: string;
}

function sortCreditsByName(items: CreditItem[]) {
  return [...items].sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base" }));
}

/** A GitHub profile link's avatar, or "" (not GitHub, or the image failed). */
export function contributorAvatarURL(item: CreditItem, broken: Record<string, boolean>) {
  const link = typeof item?.link === "string" ? item.link.trim() : "";
  if (!link || broken[String(item?.id)]) return "";
  try {
    const url = new URL(link);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return "";
    const handle = url.pathname.split("/").filter(Boolean)[0] || "";
    return handle ? `https://github.com/${handle}.png?size=160` : "";
  } catch {
    return "";
  }
}

export function contributorInitials(name: unknown) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
  return parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0] || "")
    .join("")
    .toUpperCase();
}

export function SettingsCreditsPanel() {
  const loading = signal(false);
  const error = signal("");
  const openSource = signal<CreditItem[]>([]);
  const contributors = signal<CreditItem[]>([]);
  const brokenAvatars = signal<Record<string, boolean>>({});

  async function loadCredits() {
    loading.set(true);
    error.set("");
    try {
      const data = await apiFetch("/settings/credits");
      openSource.set(sortCreditsByName(Array.isArray(data?.open_source) ? data.open_source : []));
      contributors.set(Array.isArray(data?.contributors) ? data.contributors : []);
    } catch (err) {
      error.set((err as Error)?.message || t("msg_load_failed"));
    } finally {
      loading.set(false);
    }
  }

  const markBroken = (id: unknown) => {
    const key = String(id || "");
    if (!key || untracked(brokenAvatars)[key]) return;
    brokenAvatars.update((current) => ({ ...current, [key]: true }));
  };

  effect(() => untracked(() => void loadCredits()));

  // The contributor grid (`repeat(auto-fill, minmax(132px, 1fr))`, 10pt apart) from its width.
  const gridWidth = signal(0);
  const gridCols = () => {
    const width = gridWidth();
    const count = width > 0 ? Math.max(1, Math.min(12, Math.floor((width + 10) / 142))) : 4;
    return `grid-cols-${count}`;
  };
  return (
    <View class="gap-4" testID="settings-credits">
      <If when={loading()}>
        <LoadingLine />
      </If>
      <If when={error()}>
        <InlineNotice type="error" text={error()} testID="settings-credits-error" />
      </If>

      <SettingsCard title={t("settings_credits_contributors_title")} meta={t("settings_credits_contributors_meta")}>
        <If
          when={contributors().length}
          else={<Text class="text-xs leading-normal text-muted-foreground">{t("settings_credits_empty_contributors")}</Text>}
        >
          <View
            class={`grid gap-2.5 ${gridCols()}`}
            onLayout={(event) => gridWidth.set(event.bounds.size.width)}
          >
            <Each of={contributors()} key={(item) => String(item.id ?? item.name)}>
              {(item) => (
                <View
                  role="link"
                  accessibilityLabel={`${t("settings_credits_open_profile")}: ${item().name ?? ""}`}
                  onPress={() => item().link && openExternal(String(item().link))}
                  class="min-h-29 min-w-0 items-center justify-center gap-2 rounded-(--radius) border border-line/70 bg-paper/96 px-3 py-3.5 transition-colors duration-160 hover:border-blue/30 hover:bg-hover focus:border-blue/30 focus:bg-hover"
                >
                  <View class="absolute right-2.5 top-2.5">
                    <Icon name="PhArrowSquareOut" size={12} color="muted-foreground" />
                  </View>
                  <View class="size-11 items-center justify-center overflow-hidden rounded-full border border-line/72 bg-muted">
                    <If
                      when={contributorAvatarURL(item(), brokenAvatars())}
                      else={<Text class="font-mono text-xs font-semibold tracking-[0.04em] text-subtle">{contributorInitials(item().name)}</Text>}
                    >
                      <Image
                        src={contributorAvatarURL(item(), brokenAvatars())}
                        accessibilityLabel={item().name}
                        onError={() => markBroken(item().id)}
                        style={{ width: 44, height: 44 }}
                      />
                    </If>
                  </View>
                  <Text class="max-w-full text-center text-sm font-semibold leading-[18.9px] text-foreground">{item().name ?? ""}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
      </SettingsCard>

      <SettingsCard title={t("settings_credits_open_source_title")} meta={t("settings_credits_open_source_meta")} list>
        <If
          when={openSource().length}
          else={<Text class="py-3 text-xs leading-normal text-muted-foreground">{t("settings_credits_empty_open_source")}</Text>}
        >
          <View>
            <Each of={openSource()} key={(item) => String(item.id ?? item.name)}>
              {(item, index) => (
                <View class={`flex-row items-center gap-3.5 py-3 ${index() > 0 ? "border-t border-line-soft" : ""}`}>
                  <View class="min-w-0 flex-1 gap-1">
                    <View class="flex-row flex-wrap items-baseline gap-2">
                      <Text class="text-sm font-semibold leading-[18.9px] text-foreground">{item().name ?? ""}</Text>
                      <If when={item().license}>
                        <View
                          tooltip={
                            <Tip text={t("settings_credits_license_label")} />
                          }
                        >
                          <Text class="rounded-(--radius) border border-line/72 px-1 py-px font-mono text-xs leading-[16.2px] text-muted-foreground">
                            {item().license ?? ""}
                          </Text>
                        </View>
                      </If>
                    </View>
                    <Text class="text-xs leading-normal text-muted-foreground">{item().summary ?? ""}</Text>
                  </View>
                  <If when={item().link}>
                    <Button
                      variant="plain"
                      size="xs"
                      iconOnly
                      icon="PhArrowSquareOut"
                      title={t("settings_credits_open_link")}
                      onPress={() => openExternal(String(item().link))}
                    />
                  </If>
                </View>
              )}
            </Each>
          </View>
        </If>
      </SettingsCard>
    </View>
  );
}
