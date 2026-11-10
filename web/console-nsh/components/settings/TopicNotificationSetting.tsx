// The notifications row of Settings' System section (the Vue console's TopicNotificationSetting):
// the permission's state and the button that asks for it. The host answers both (lib/platform.ts).
import { cleanup, effect, signal, Text, untracked, View } from "nsh";
import { isMobile as isPhoneApp, onVisibilityChange, requestNotificationPermission, type NotificationPermission } from "../../lib/platform";
import { topicNotificationPermission } from "../../lib/core/topic-task-notifications.js";
import { isMobile } from "../../lib/shell";
import { Button } from "../ui";
import { t } from "./DialogShell";

// The phone app's permission lives in the system's settings, not a browser's.
function stateKey(permission: NotificationPermission) {
  if (isPhoneApp() && (permission === "denied" || permission === "unsupported")) return `topic_notifications_${permission}_app`;
  return `topic_notifications_${permission}`;
}

export function TopicNotificationSetting() {
  const permission = signal<NotificationPermission>("default");
  const requesting = signal(false);
  let seq = 0;

  async function refresh() {
    const current = ++seq;
    try {
      const value = (await topicNotificationPermission()) as NotificationPermission;
      if (current === seq) permission.set(value);
    } catch (error) {
      console.warn("could not read the notification permission:", (error as Error)?.message || error);
    }
  }

  async function requestPermission() {
    if (untracked(requesting)) return;
    const current = (await topicNotificationPermission()) as NotificationPermission;
    if (current !== "default") {
      permission.set(current);
      return;
    }
    requesting.set(true);
    seq += 1;
    try {
      permission.set(await requestNotificationPermission());
    } catch (error) {
      console.warn("could not ask for notifications:", (error as Error)?.message || error);
      void refresh();
    } finally {
      requesting.set(false);
    }
  }

  effect(() => untracked(() => void refresh()));
  // The user may change it in the browser or the system while the console is in the background.
  cleanup(onVisibilityChange(() => void refresh()));

  return (
    <View class={`gap-4 py-3 ${isMobile() ? "" : "flex-row items-center"}`} testID="topic-notifications">
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-sm font-medium leading-[18.9px] text-foreground">{t("topic_notifications_title")}</Text>
        <Text class="text-xs leading-[20.3px] text-muted-foreground">{t("topic_notifications_hint")}</Text>
        <Text class="text-xs leading-[20.3px] text-muted-foreground" testID="topic-notifications-state">
          {t(stateKey(permission()))}
        </Text>
      </View>
      <Button
        variant="outlined"
        size="md"
        class={isMobile() ? "self-stretch" : "min-w-[180px]"}
        label={t("topic_notifications_enable")}
        disabled={permission() !== "default"}
        loading={requesting()}
        onPress={() => void requestPermission()}
        testID="topic-notifications-enable"
      />
    </View>
  );
}
