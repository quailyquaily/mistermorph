//! The desktop side of the app's `morph.*` host contract (web/console-nsh/lib/platform.ts; the
//! browser's side is web/console-nsh/host.js). Handlers run on the engine thread: they answer at
//! once, or hand the call to a thread of their own or to the window's main thread (`Ui`).
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use futures::channel::mpsc::UnboundedSender;
use nsh_engine::{HostCall, HostChannel, HostReply};
use serde_json::{Value, json};

use crate::{
    backend::Supervisor,
    config::AutoUpdate,
    desktop_log::DesktopLog,
    files::{Registry, SaveRequest, UploadRequest},
    store::{AppState, KvStore},
};

/// What the host features the app may use (`hasFeature`). `voiceRecord`: the microphone records
/// for the agent to transcribe (src/voice.rs), as the browser's does.
pub const FEATURES: [&str; 9] = ["notifications", "pickDirectory", "checkUpdate", "restart", "quit", "openLog", "saveFile", "pickFile", "voiceRecord"];

/// Work for the main thread, where the window and GPUI's dialogs are.
pub enum Ui {
    Title(String),
    Quit,
    Restart,
    OpenLog,
    Activate,
    PickFiles { multiple: bool, accept: String, reply: HostReply },
    PickDirectory { reply: HostReply },
    Save { name: String, bytes: Vec<u8>, reply: HostReply },
    BackendReady(String),
    BackendFailed(String),
}

/// What the shell shares between the window and the host's handlers.
pub struct Desktop {
    pub log: Arc<DesktopLog>,
    pub started_at: Instant,
    pub config_path: Option<PathBuf>,
    pub auto_update: AutoUpdate,
    pub supervisor: Supervisor,
    pub ui: UnboundedSender<Ui>,
    origin: Mutex<String>,
    kv: Mutex<KvStore>,
    /// Notified when a value of `kv` changes (the Console's login, see `wait_console_token`).
    kv_changed: Condvar,
    session: Mutex<BTreeMap<String, String>>,
    app_state: Mutex<AppState>,
    files: Mutex<Registry>,
    pub voice: crate::voice::Recorder,
    ready: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Desktop {
    pub fn new(
        log: Arc<DesktopLog>,
        started_at: Instant,
        config_path: Option<PathBuf>,
        auto_update: AutoUpdate,
        supervisor: Supervisor,
        ui: UnboundedSender<Ui>,
    ) -> Desktop {
        Desktop {
            log,
            started_at,
            config_path,
            auto_update,
            supervisor,
            ui,
            origin: Mutex::new(String::new()),
            kv: Mutex::new(KvStore::load(crate::paths::kv_file())),
            kv_changed: Condvar::new(),
            session: Mutex::new(BTreeMap::new()),
            app_state: Mutex::new(AppState::load(crate::paths::app_state_file().as_deref())),
            files: Mutex::new(Registry::default()),
            voice: crate::voice::Recorder::new(crate::voice::Recorder::default_parent()),
            ready: AtomicBool::new(false),
        }
    }

    pub fn origin(&self) -> String {
        lock(&self.origin).clone()
    }

    pub fn set_origin(&self, origin: String) {
        *lock(&self.origin) = origin;
    }

    pub fn ui(&self, command: Ui) {
        let _ = self.ui.unbounded_send(command);
    }

    pub fn register_file(&self, picked: crate::files::Picked) -> Value {
        let id = lock(&self.files).add(picked.clone());
        picked.to_json(&id)
    }

    /// The app's boot data (`Boot` in platform.ts).
    pub fn boot(&self) -> Value {
        json!({
            "runtime": "desktop",
            "origin": self.origin(),
            "basePath": crate::backend::DEFAULT_BASE_PATH,
            "location": lock(&self.app_state).location.clone(),
            "kv": lock(&self.kv).values().clone(),
            "session": lock(&self.session).clone(),
            "languages": languages(sys_locale::get_locales()),
            "desktopVersion": crate::update::DESKTOP_VERSION,
            "features": FEATURES,
        })
    }

    fn set_value(&self, area: &str, key: &str, value: Option<String>) -> Result<(), String> {
        if area == "session" {
            let mut session = lock(&self.session);
            match value {
                Some(v) => session.insert(key.to_owned(), v),
                None => session.remove(key),
            };
            return Ok(());
        }
        let saved = lock(&self.kv).set(key, value);
        self.kv_changed.notify_all();
        saved
    }

    /// The Console's session token, saved in the local store when the user logs in.
    pub fn console_token(&self) -> Option<String> {
        crate::config::console_token(lock(&self.kv).values().get(crate::config::CONSOLE_AUTH_KEY).map(String::as_str))
    }

    /// Waits until the Console holds a session token other than `refused` (a login after the
    /// backend refused that one) and returns it; none once `limit` passes without one.
    pub fn wait_console_token(&self, refused: Option<&str>, limit: Option<Duration>) -> Option<String> {
        let deadline = limit.map(|limit| Instant::now() + limit);
        let mut kv = lock(&self.kv);
        loop {
            let token = crate::config::console_token(kv.values().get(crate::config::CONSOLE_AUTH_KEY).map(String::as_str));
            if token.is_some() && token.as_deref() != refused {
                return token;
            }
            let wait = match deadline {
                Some(deadline) => match deadline.checked_duration_since(Instant::now()) {
                    Some(left) if !left.is_zero() => left,
                    _ => return None,
                },
                None => Duration::from_secs(60),
            };
            kv = match self.kv_changed.wait_timeout(kv, wait) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }

    fn remember_location(&self, url: &str) {
        let location = crate::store::normalize_location(url);
        let mut state = lock(&self.app_state);
        if state.location == location {
            return;
        }
        state.location = location;
        if let Err(err) = state.save(crate::paths::app_state_file().as_deref()) {
            self.log.line(&format!("desktop_window save location failed: {err}"));
        }
    }

    fn frontend_ready(&self) {
        if self.ready.swap(true, Ordering::SeqCst) {
            return;
        }
        self.log.file_line(&format!(
            "desktop_startup_frontend_ready duration_ms={}",
            self.started_at.elapsed().as_millis()
        ));
    }
}

/// The user's languages, best first, as browsers write them (`en-US`); `en` without any.
pub fn languages(locales: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for locale in locales {
        // POSIX locales: `en_US.UTF-8`, `de_DE@euro`.
        let tag = locale.split(['.', '@']).next().unwrap_or("").replace('_', "-");
        let tag = tag.trim();
        if tag.is_empty() || tag == "C" || tag == "POSIX" || out.iter().any(|t| t == tag) {
            continue;
        }
        out.push(tag.to_owned());
    }
    if out.is_empty() {
        out.push("en".to_owned());
    }
    out
}

fn text(data: &Value, key: &str) -> String {
    data.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

/// Answers on a thread of its own: for work that waits (the network, the disk).
fn on_thread(call: HostCall, work: impl FnOnce(Value) -> Result<Value, String> + Send + 'static) {
    let mut call = call;
    let data = call.take_data();
    let Some(reply) = call.into_reply() else {
        return;
    };
    std::thread::spawn(move || reply.reply(work(data)));
}

/// Registers the `morph.*` handlers on the view's channel.
pub fn install(host: &HostChannel, desktop: &Arc<Desktop>) {
    let d = desktop.clone();
    host.handle("morph.boot", move |call| call.resolve(d.boot()));

    let d = desktop.clone();
    host.handle("morph.kv.set", move |call| {
        let data = call.data();
        let key = text(data, "key");
        if key.is_empty() {
            return call.reject("morph.kv.set: no key");
        }
        let value = data.get("value").and_then(Value::as_str).map(str::to_owned);
        match d.set_value(&text(data, "area"), &key, value) {
            Ok(()) => call.resolve(Value::Null),
            Err(err) => {
                d.log.line(&format!("desktop_window save value failed: {err}"));
                call.reject(err)
            }
        }
    });

    let d = desktop.clone();
    host.handle("morph.history", move |call| {
        d.remember_location(&text(call.data(), "url"));
        call.resolve(Value::Null);
    });

    let d = desktop.clone();
    host.handle("morph.title", move |call| {
        d.ui(Ui::Title(text(call.data(), "title")));
        call.resolve(Value::Null);
    });

    // The page language matters to a browser (screen readers, translation); the window has none.
    host.handle("morph.language", |call| call.resolve(Value::Null));

    host.handle("morph.notify.state", |call| call.resolve(json!(crate::notify::PERMISSION)));
    host.handle("morph.notify.request", |call| call.resolve(json!(crate::notify::PERMISSION)));

    let d = desktop.clone();
    let channel = host.clone();
    host.handle("morph.notify.show", move |mut call| {
        let data = call.take_data();
        let Some(reply) = call.into_reply() else {
            return;
        };
        let id = text(&data, "id");
        let channel = channel.clone();
        let pressed = d.clone();
        let log = d.log.clone();
        crate::notify::show(
            id,
            text(&data, "title"),
            text(&data, "body"),
            move |id| {
                pressed.ui(Ui::Activate);
                let _ = channel.send("morph.notify.press", json!({ "id": id }));
            },
            move |shown| match shown {
                Ok(()) => reply.resolve(json!(true)),
                Err(err) => {
                    log.line(&format!("desktop_window notification failed: {err}"));
                    reply.reject(format!("could not show the notification: {err}"))
                }
            },
        );
    });

    let d = desktop.clone();
    host.handle("morph.file.pick", move |mut call| {
        let data = call.take_data();
        if let Some(reply) = call.into_reply() {
            d.ui(Ui::PickFiles {
                multiple: data.get("multiple").and_then(Value::as_bool).unwrap_or(false),
                accept: text(&data, "accept"),
                reply,
            });
        }
    });

    let d = desktop.clone();
    let channel = host.clone();
    host.handle("morph.file.upload", move |call| {
        let d = d.clone();
        let channel = channel.clone();
        on_thread(call, move |data| {
            let request: UploadRequest = serde_json::from_value(data).map_err(|e| e.to_string())?;
            let picked = lock(&d.files).get(&request.id).ok_or("the file is gone")?;
            let id = request.id.clone();
            crate::files::upload(&picked, &request, &d.origin(), move |loaded, total| {
                let _ = channel.send("morph.file.progress", json!({ "id": id, "loaded": loaded, "total": total }));
            })
            .inspect_err(|err| d.log.line(&format!("desktop_window upload failed: {err}")))
        });
    });

    let d = desktop.clone();
    host.handle("morph.file.release", move |call| {
        let id = text(call.data(), "id");
        let released = {
            let mut files = lock(&d.files);
            let picked = files.get(&id);
            files.release(&id);
            picked
        };
        if let Some(picked) = released {
            d.voice.forget(&picked.path);
        }
        call.resolve(Value::Null);
    });

    // Voice input: the recorder answers from its own thread (src/voice.rs).
    host.handle("morph.voice.support", |call| call.resolve(json!(crate::voice::support())));

    let d = desktop.clone();
    host.handle("morph.voice.start", move |call| {
        let Some(reply) = call.into_reply() else {
            return;
        };
        let log = d.log.clone();
        d.voice.start(move |answer| {
            if answer["ok"] != json!(true) {
                log.line(&format!("desktop_window voice recording failed to start: {answer}"));
            }
            reply.resolve(answer)
        });
    });

    let d = desktop.clone();
    host.handle("morph.voice.stop", move |call| {
        let Some(reply) = call.into_reply() else {
            return;
        };
        let registered = d.clone();
        d.voice.stop(move |result| match result {
            Ok(Some(picked)) => reply.resolve(registered.register_file(picked)),
            Ok(None) => reply.resolve(Value::Null),
            Err(err) => {
                registered.log.line(&format!("desktop_window voice recording failed: {err}"));
                reply.reject(err)
            }
        });
    });

    let d = desktop.clone();
    host.handle("morph.voice.cancel", move |call| {
        d.voice.cancel();
        call.resolve(Value::Null);
    });

    let d = desktop.clone();
    host.handle("morph.file.save", move |mut call| {
        let data = call.take_data();
        let Some(reply) = call.into_reply() else {
            return;
        };
        let d = d.clone();
        std::thread::spawn(move || {
            let request: SaveRequest = match serde_json::from_value(data) {
                Ok(r) => r,
                Err(err) => return reply.reject(err.to_string()),
            };
            match crate::files::save_bytes(&request, &d.origin()) {
                Ok(bytes) => d.ui(Ui::Save { name: crate::files::suggested_name(&request.name), bytes, reply }),
                Err(err) => reply.reject(err),
            }
        });
    });

    let d = desktop.clone();
    host.handle("morph.desktop.pickDirectory", move |call| {
        if let Some(reply) = call.into_reply() {
            d.ui(Ui::PickDirectory { reply });
        }
    });

    let d = desktop.clone();
    host.handle("morph.desktop.checkUpdate", move |call| {
        let d = d.clone();
        on_thread(call, move |data| {
            let channel = data.get("channel").and_then(Value::as_str).map(str::to_owned);
            let result = crate::update::desktop_check(d.config_path.as_deref(), &d.auto_update, channel, &d.log)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        });
    });

    let d = desktop.clone();
    host.handle("morph.desktop.restart", move |call| {
        call.resolve(Value::Null);
        d.ui(Ui::Restart);
    });

    let d = desktop.clone();
    host.handle("morph.desktop.quit", move |call| {
        call.resolve(Value::Null);
        d.ui(Ui::Quit);
    });

    let d = desktop.clone();
    host.handle("morph.desktop.openLog", move |call| {
        if d.log.path().is_none() {
            return call.reject("desktop log path is not available");
        }
        d.ui(Ui::OpenLog);
        call.resolve(Value::Null);
    });

    let d = desktop.clone();
    host.handle("morph.desktop.ready", move |call| {
        d.frontend_ready();
        call.resolve(Value::Null);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_follow_the_system() {
        let list = |l: &[&str]| languages(l.iter().map(|s| s.to_string()));
        assert_eq!(list(&["en-US", "ja-JP"]), ["en-US", "ja-JP"]);
        assert_eq!(list(&["zh_CN.UTF-8", "zh-CN", "C"]), ["zh-CN"]);
        assert_eq!(list(&[]), ["en"]);
    }

    #[test]
    fn waits_for_a_console_login() {
        let (ui, _rx) = futures::channel::mpsc::unbounded();
        let log = Arc::new(DesktopLog::none());
        let supervisor = Supervisor::spawn(crate::backend::BackendConfig::new(None), log.clone());
        let desktop = Arc::new(Desktop::new(log, Instant::now(), None, AutoUpdate::default(), supervisor, ui));
        let key = crate::config::CONSOLE_AUTH_KEY;
        desktop.set_value("local", key, None).unwrap();
        assert_eq!(desktop.console_token(), None);
        assert_eq!(desktop.wait_console_token(None, Some(Duration::from_millis(20))), None);

        desktop.set_value("local", key, Some(r#"{"token":"stale"}"#.into())).unwrap();
        assert_eq!(desktop.console_token(), Some("stale".to_owned()));
        // The refused token is not an answer; the next login is.
        assert_eq!(desktop.wait_console_token(Some("stale"), Some(Duration::from_millis(20))), None);
        let login = desktop.clone();
        let saver = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            login.set_value("local", key, Some(r#"{"token":"fresh","expiresAt":"x"}"#.into())).unwrap();
        });
        assert_eq!(desktop.wait_console_token(Some("stale"), Some(Duration::from_secs(10))), Some("fresh".to_owned()));
        saver.join().unwrap();
        desktop.set_value("local", key, None).unwrap();
    }

    #[test]
    fn features_match_the_contract() {
        for feature in ["notifications", "pickDirectory", "checkUpdate", "restart", "quit", "openLog", "saveFile", "pickFile", "voiceRecord"] {
            assert!(FEATURES.contains(&feature));
        }
    }
}
