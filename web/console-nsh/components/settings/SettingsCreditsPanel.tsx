// Settings' Credits section (the Vue console's SettingsCreditsPanel): contributors with their
// GitHub avatars, and the open source projects the product ships with.
import { effect, Image, signal, Text, untracked, View } from "nsh";
import { Tooltip } from "nsh/base";
import { apiFetch } from "../../lib/core/context.js";
import { openExternal } from "../../lib/platform";
import { Button, Icon, ProgressBar, Section } from "../ui";
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

  return (
    <View class="gap-5" testID="settings-credits">
      <If when={loading()}>
        <ProgressBar indeterminate />
      </If>
      <If when={error()}>
        <InlineNotice type="error" text={error()} testID="settings-credits-error" />
      </If>

      <Section variant="card" title={t("settings_credits_contributors_title")} meta={t("settings_credits_contributors_meta")}>
        <If
          when={contributors().length}
          else={<Text class="text-sm text-muted-foreground">{t("settings_credits_empty_contributors")}</Text>}
        >
          <View class="flex-row flex-wrap gap-2">
            <Each of={contributors()} key={(item) => String(item.id ?? item.name)}>
              {(item) => (
                <View
                  role="link"
                  accessibilityLabel={`${t("settings_credits_open_profile")}: ${item().name ?? ""}`}
                  onPress={() => item().link && openExternal(String(item().link))}
                  class="w-36 items-center gap-2 rounded-(--radius) border border-line-faint px-3 py-3 hover:bg-hover active:bg-selection"
                >
                  <View class="size-14 items-center justify-center overflow-hidden rounded-full bg-muted">
                    <If
                      when={contributorAvatarURL(item(), brokenAvatars())}
                      else={<Text class="font-mono text-sm text-subtle">{contributorInitials(item().name)}</Text>}
                    >
                      <Image
                        src={contributorAvatarURL(item(), brokenAvatars())}
                        accessibilityLabel={item().name}
                        onError={() => markBroken(item().id)}
                        style={{ width: 56, height: 56 }}
                      />
                    </If>
                  </View>
                  <View class="flex-row items-center gap-1">
                    <Text class="text-sm font-medium text-foreground line-clamp-1">{item().name ?? ""}</Text>
                    <Icon name="PhArrowSquareOut" size={12} color="muted-foreground" />
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      </Section>

      <Section variant="card" title={t("settings_credits_open_source_title")} meta={t("settings_credits_open_source_meta")}>
        <If
          when={openSource().length}
          else={<Text class="text-sm text-muted-foreground">{t("settings_credits_empty_open_source")}</Text>}
        >
          <View>
            <Each of={openSource()} key={(item) => String(item.id ?? item.name)}>
              {(item, index) => (
                <View class={`flex-row items-start gap-3 py-2.5 ${index() > 0 ? "border-t border-line-faint" : ""}`}>
                  <View class="flex-1 gap-0.5">
                    <View class="flex-row flex-wrap items-center gap-2">
                      <Text class="text-sm font-medium text-foreground">{item().name ?? ""}</Text>
                      <If when={item().license}>
                        <View
                          tooltip={
                            <Tooltip class="bg-foreground px-2 py-1">
                              <Text class="text-xs text-background">{t("settings_credits_license_label")}</Text>
                            </Tooltip>
                          }
                        >
                          <Text class="font-mono text-xs text-muted-foreground">{item().license ?? ""}</Text>
                        </View>
                      </If>
                    </View>
                    <Text class="text-xs text-muted-foreground">{item().summary ?? ""}</Text>
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
      </Section>
    </View>
  );
}
