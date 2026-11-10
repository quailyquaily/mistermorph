//! System notifications (`morph.notify.*`) through notify-rust: the freedesktop notification
//! service on Linux, the notification center on macOS, toasts on Windows.
use notify_rust::NotificationResponse;

/// The action a press on the notification's body is (Linux shows it as "Open").
const PRESS: &str = "default";

/// Asks whether the system can show this app's notifications, and answers as the browser's
/// `Notification.permission` would (`done`): "granted", or "unsupported" with what failed.
///
/// Linux: whether a freedesktop notification service answers on the session bus (asking may start
/// one); such services ask an app no permission. macOS (NSUserNotificationCenter) and Windows
/// (toasts) ask an app no permission and tell it nothing it could read, so the answer there is
/// always "granted": notifications the user turned off in the system's settings are not seen.
pub fn permission(done: impl FnOnce(&'static str, Option<String>) + Send + 'static) {
    #[cfg(all(unix, not(target_os = "macos")))]
    std::thread::spawn(move || {
        let service = notify_rust::get_server_information().map(|_| ()).map_err(|err| err.to_string());
        let (state, error) = permission_for(service);
        done(state, error);
    });
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    done("granted", None);
}

/// The permission a notification service's answer gives: "granted" when it answered.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn permission_for(service: Result<(), String>) -> (&'static str, Option<String>) {
    match service {
        Ok(()) => ("granted", None),
        Err(err) => ("unsupported", Some(err)),
    }
}

/// Whether what the user did to a notification was pressing it: its body (Windows, macOS), or
/// its default action (Linux, where wait_for_action reports it as the action "default").
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn is_press(response: &NotificationResponse) -> bool {
    match response {
        NotificationResponse::Default => true,
        NotificationResponse::Action(action) => action == PRESS,
        _ => false,
    }
}

/// Shows a notification on a thread of its own; `on_press(id)` runs when the user presses it
/// (Linux: the notification's default action; Windows: the toast's body). `done` gets whether it
/// was shown, once: nothing here tries again.
pub fn show(
    id: String,
    title: String,
    body: String,
    on_press: impl FnOnce(String) + Send + 'static,
    done: impl FnOnce(Result<(), String>) + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut notification = notify_rust::Notification::new();
        notification.summary(&title).body(&body);
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            notification.appname("MisterMorph").action(PRESS, "Open");
            match notification.show() {
                Ok(handle) => {
                    done(Ok(()));
                    handle.wait_for_action(|action| {
                        if is_press(&NotificationResponse::from(action)) {
                            on_press(id);
                        }
                    });
                }
                Err(err) => done(Err(err.to_string())),
            }
        }
        #[cfg(target_os = "windows")]
        {
            // A toast's activation comes back while this process holds it (no buttons: a press on
            // the body is `Default`); dismissing or timing out ends the wait.
            match notification.show() {
                Ok(handle) => {
                    done(Ok(()));
                    let _ = handle.wait_for_response(move |response: &NotificationResponse| {
                        if is_press(response) {
                            on_press(id);
                        }
                    });
                }
                Err(err) => done(Err(err.to_string())),
            }
        }
        #[cfg(target_os = "macos")]
        {
            // NSUserNotificationCenter: the handle sends when dropped, and waiting for the press
            // would send the notification a second time; a press only brings the app forward.
            let _ = (on_press, id);
            match notification.show() {
                Ok(_) => done(Ok(())),
                Err(err) => done(Err(err.to_string())),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_that_answers_grants() {
        assert_eq!(permission_for(Ok(())), ("granted", None));
        let (state, error) = permission_for(Err("org.freedesktop.Notifications was not provided".into()));
        assert_eq!(state, "unsupported");
        assert_eq!(error.as_deref(), Some("org.freedesktop.Notifications was not provided"));
    }

    #[test]
    fn only_a_press_on_the_body_opens_the_topic() {
        assert!(is_press(&NotificationResponse::Default));
        // Linux's wait_for_action hands over the action's key.
        assert!(is_press(&NotificationResponse::from("default")));
        assert!(!is_press(&NotificationResponse::from("__closed")));
        assert!(!is_press(&NotificationResponse::from("other")));
        assert!(!is_press(&NotificationResponse::Closed(notify_rust::CloseReason::Dismissed)));
        assert!(!is_press(&NotificationResponse::Reply("ok".into())));
    }

    // Live checks against the system's notification service, with what it should answer:
    // `MORPH_NOTIFY_EXPECT=granted|unsupported cargo test -- --ignored notify::tests::live`.
    // With "granted", the press check waits a minute for the notification to be pressed.

    #[test]
    #[ignore]
    fn live_permission_is_the_services_answer() {
        let Ok(expected) = std::env::var("MORPH_NOTIFY_EXPECT") else {
            return;
        };
        let (tx, rx) = std::sync::mpsc::channel();
        permission(move |state, error| tx.send((state, error)).unwrap());
        let (state, error) = rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
        eprintln!("permission: {state} ({error:?})");
        assert_eq!(state, expected);
    }

    #[test]
    #[ignore]
    fn live_a_pressed_notification_reports_its_id() {
        let Ok(expected) = std::env::var("MORPH_NOTIFY_EXPECT") else {
            return;
        };
        let (shown_tx, shown_rx) = std::sync::mpsc::channel();
        let (press_tx, press_rx) = std::sync::mpsc::channel();
        show(
            "live-1".into(),
            "MisterMorph".into(),
            "Press this notification".into(),
            move |id| press_tx.send(id).unwrap(),
            move |shown| shown_tx.send(shown).unwrap(),
        );
        let shown = shown_rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
        if expected == "unsupported" {
            assert!(shown.is_err(), "{shown:?}");
            assert!(press_rx.recv_timeout(std::time::Duration::from_millis(500)).is_err());
            return;
        }
        assert_eq!(shown, Ok(()));
        assert_eq!(press_rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap(), "live-1");
    }
}
