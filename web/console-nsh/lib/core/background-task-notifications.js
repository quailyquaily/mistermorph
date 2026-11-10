// The phone app's task notifications. Its page, and with it the notification socket the web
// console notifies from (system-notifications.js), is suspended while the app is in the
// background, so the app's native part tells of finished tasks instead (lib/mobileHost.ts,
// android/src/.../TaskNotifier.java): it reads the console server's recent completions while the
// app is away. Here the console keeps it configured with the session and the texts in the
// current language, and opens the topic of a pressed notification.
import { effect, untracked } from "nsh";

import { endpointRoutePath } from "./endpoint-routes.js";
import { CONSOLE_LOCAL_ENDPOINT_REF } from "./endpoints.js";

/** What the native part needs: the server's API address, the session's token, the texts. */
export function backgroundNotificationSettings({ api, token, valid, translate }) {
  return {
    api: String(api || ""),
    // Signed out (or the session ran out): an empty token ends the watch.
    token: valid ? String(token || "") : "",
    texts: {
      untitled: translate("chat_topic_untitled"),
      done: translate("topic_notification_done"),
      failed: translate("topic_notification_failed"),
      channel: translate("topic_notifications_title"),
    },
  };
}

/**
 * Opens the topic of a pressed notification. A topic that is gone, or cannot be read now, opens
 * the chat instead; signed out, nothing opens (the login page is where the app is).
 */
export async function openNotifiedTopic(topicID, { signedIn, topicExists, navigate }) {
  const id = String(topicID || "").trim();
  if (!id || !signedIn()) return false;
  let exists = false;
  try {
    exists = Boolean(await topicExists(id));
  } catch {
    exists = false;
  }
  if (!signedIn()) return false;
  navigate(endpointRoutePath(CONSOLE_LOCAL_ENDPOINT_REF, exists ? `/chat/${encodeURIComponent(id)}` : "/chat"));
  return exists;
}

/**
 * Keeps the native part configured and opens pressed notifications. `deps` are the console's:
 * `configure(settings)`, `take()` (the pressed topic, once), `onOpened(listener)`, `api()`,
 * `token()`, `signedIn()` (both read reactively), `language()`, `translate`, `topicExists(id)`
 * and `navigate(path)`.
 */
export function installBackgroundTaskNotifications(deps) {
  let opening = Promise.resolve();
  const openPressed = () => {
    opening = opening.then(async () => {
      if (!deps.signedIn()) return;
      let topicID = "";
      try {
        topicID = await deps.take();
      } catch {
        return;
      }
      await openNotifiedTopic(topicID, deps);
    }).catch((error) => console.warn("could not open the notified topic:", error?.message || error));
    return opening;
  };
  effect(() => {
    const valid = deps.signedIn();
    const token = deps.token();
    deps.language();
    untracked(() => {
      const settings = backgroundNotificationSettings({ api: deps.api(), token, valid, translate: deps.translate });
      // Notifications that cannot be configured must not get in the way of anything else.
      void Promise.resolve()
        .then(() => deps.configure(settings))
        .catch((error) => console.warn("could not configure task notifications:", error?.message || error));
      // A notification pressed while the app was not running (or signed out) waits until now.
      if (valid) void openPressed();
    });
  });
  deps.onOpened(() => void openPressed());
}
