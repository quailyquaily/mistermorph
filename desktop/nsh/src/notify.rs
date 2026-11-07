//! System notifications (`morph.notify.*`) through notify-rust: the freedesktop notification
//! service on Linux, the notification center on macOS, toasts on Windows.

/// Desktop systems ask no permission of an app that shows notifications through them (the
/// browser's `Notification.permission` is always "granted" here).
pub const PERMISSION: &str = "granted";

/// Shows a notification on a thread of its own; `on_press(id)` runs when the user presses it
/// (Linux: the notification's default action). `done` gets whether it was shown.
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
            notification.appname("MisterMorph").action("default", "Open");
            match notification.show() {
                Ok(handle) => {
                    done(Ok(()));
                    handle.wait_for_action(|action| {
                        if action == "default" {
                            on_press(id);
                        }
                    });
                }
                Err(err) => done(Err(err.to_string())),
            }
        }
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        {
            // No press callback from notify-rust here: a press only brings the app forward.
            let _ = (on_press, id);
            match notification.show() {
                Ok(_) => done(Ok(())),
                Err(err) => done(Err(err.to_string())),
            }
        }
    });
}
