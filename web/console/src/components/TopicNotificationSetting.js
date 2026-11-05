import { onMounted, onUnmounted, ref } from "vue";
import { translate } from "../i18n";
import { requestBrowserNotificationPermission } from "../core/system-notification-utils";
import { topicNotificationPermission } from "../core/topic-task-notifications";

export default {
  name: "TopicNotificationSetting",
  setup() {
    const permission = ref(topicNotificationPermission());
    const requesting = ref(false);
    function refresh() {
      permission.value = topicNotificationPermission();
    }
    async function requestPermission() {
      if (requesting.value || topicNotificationPermission() !== "default") {
        refresh();
        return;
      }
      requesting.value = true;
      try {
        permission.value = await requestBrowserNotificationPermission();
      } finally {
        requesting.value = false;
      }
    }
    onMounted(() => {
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", refresh);
    });
    onUnmounted(() => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    });
    return { t: translate, permission, requesting, requestPermission };
  },
  template: `
    <div class="settings-console-row">
      <div class="settings-card-copy">
        <h4 class="settings-card-title">{{ t("topic_notifications_title") }}</h4>
        <p class="settings-card-note">{{ t("topic_notifications_hint") }}</p>
        <p class="settings-card-note" role="status">{{ t("topic_notifications_" + permission) }}</p>
      </div>
      <AppButton class="outlined settings-console-control" :disabled="permission !== 'default'" :loading="requesting" @click="requestPermission">
        {{ t("topic_notifications_enable") }}
      </AppButton>
    </div>
  `,
};
