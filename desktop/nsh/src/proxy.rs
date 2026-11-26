//! The network proxy setting: one setting owned by the desktop shell, read once at launch and
//! turned into the standard proxy variables, one set for this process and one for the backend it
//! starts.
//!
//! Two modes. **System default** follows the proxy variables the app inherited. **Explicit proxy**
//! (HTTP or SOCKS5, host, port, optional user name and password) takes the standard names over.
//! A saved explicit proxy that cannot be loaded **blocks** the start: the app never falls back to
//! a direct connection by itself.
//!
//! The setting is saved in `<config>/mistermorph/desktop/network-proxy.json`, the password in the
//! system's credential store (src/proxy_secret.rs). A changed setting applies when the user quits
//! and reopens the app: the launch route is never changed while the process lives.
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    net::{Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    proxy_secret::SecretStore,
    redact::{Redactor, percent_encode},
};

/// Tells the backend that a proxy is required (`url_fetch` then uses the proxy or refuses). A
/// marker for the process the app starts, not a config key.
pub const MARKER_ENV: &str = "MISTER_MORPH_DESKTOP_PROXY_REQUIRED";
/// The only bypass of an explicit proxy, and what the app adds to an inherited bypass list for
/// its own requests.
pub const LOOPBACK_BYPASS: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];
const PROXY_NAMES: [&str; 6] = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const BYPASS_NAMES: [&str; 2] = ["NO_PROXY", "no_proxy"];
/// Go refuses `HTTP_PROXY` while this is set (a CGI guard).
const CGI_NAME: &str = "REQUEST_METHOD";
const MAX_CREDENTIAL_BYTES: usize = 255;

/// An environment: names and values as the system holds them.
pub type Env = Vec<(OsString, OsString)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    System,
    Explicit,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Http,
    Socks5,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Http => "HTTP",
            Kind::Socks5 => "SOCKS5",
        }
    }
}

/// The settings file. The password is never in it: `has_password` says that one is in the
/// credential store.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub mode: Mode,
    #[serde(rename = "type", default)]
    pub kind: Kind,
    #[serde(default)]
    pub host: String,
    /// 0 when none was saved yet.
    #[serde(default)]
    pub port: u32,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub has_password: bool,
}

/// An explicit proxy that is running. `Debug` never prints the password.
#[derive(Clone, PartialEq, Eq)]
pub struct Explicit {
    pub kind: Kind,
    /// A host name or an address, IPv6 without brackets.
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
}

impl std::fmt::Debug for Explicit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Explicit({}, password: {})", self.describe(), if self.password.is_some() { "set" } else { "none" })
    }
}

/// `host:port`, an IPv6 address in brackets.
pub fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

impl Explicit {
    /// `HTTP proxy.example:8080`: type, host and port, never a credential.
    pub fn describe(&self) -> String {
        format!("{} {}", self.kind.label(), host_port(&self.host, self.port))
    }

    /// The proxy URL for the backend (`socks5://`: Go resolves names at the proxy for it, and
    /// gorilla/websocket rejects `socks5h://`) or for this process (`socks5h://`, so that ureq
    /// resolves names at the proxy too).
    fn url(&self, for_backend: bool) -> String {
        let scheme = match (self.kind, for_backend) {
            (Kind::Http, _) => "http",
            (Kind::Socks5, true) => "socks5",
            (Kind::Socks5, false) => "socks5h",
        };
        let user_info = if self.username.is_empty() {
            String::new()
        } else {
            // An empty password is written too: `user:@` sends the user name with no password.
            format!("{}:{}@", percent_encode(&self.username), percent_encode(self.password.as_deref().unwrap_or("")))
        };
        format!("{scheme}://{user_info}{}", host_port(&self.host, self.port))
    }
}

/// Why a saved explicit proxy could not be loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockReason {
    /// The settings file exists and cannot be read (the system's error).
    Unreadable(String),
    /// The settings file is not what the app writes.
    Unparseable,
    /// Fields that fail validation, by name.
    InvalidFields(Vec<&'static str>),
    /// The file says a password is stored; the credential store has none.
    PasswordMissing,
    /// The credential store could not be read (its error).
    PasswordUnavailable(String),
}

/// A start that is blocked: no backend, no update check, no Console, no external request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blocked {
    pub reason: BlockReason,
    /// The proxy by type, host and port when they are known; never a credential.
    pub known: Option<String>,
}

impl Blocked {
    pub fn kind(&self) -> &'static str {
        match self.reason {
            BlockReason::Unreadable(_) => "proxy_settings_unreadable",
            BlockReason::Unparseable => "proxy_settings_invalid",
            BlockReason::InvalidFields(_) => "proxy_field_invalid",
            BlockReason::PasswordMissing => "proxy_password_missing",
            BlockReason::PasswordUnavailable(_) => "proxy_password_unavailable",
        }
    }

    /// One sentence saying why.
    pub fn message(&self) -> String {
        match &self.reason {
            BlockReason::Unreadable(err) => format!("The network proxy settings file could not be read: {err}."),
            BlockReason::Unparseable => "The network proxy settings file is not valid.".to_owned(),
            BlockReason::InvalidFields(fields) => {
                format!("The saved network proxy has an invalid {}.", fields.join(", "))
            }
            BlockReason::PasswordMissing => {
                "The saved network proxy has a password, and it is not in the system's credential store.".to_owned()
            }
            BlockReason::PasswordUnavailable(err) => {
                format!("The password of the saved network proxy could not be read from the system's credential store: {err}.")
            }
        }
    }

    /// What the user can do about it.
    pub fn advice(&self) -> &'static str {
        match self.reason {
            BlockReason::PasswordUnavailable(_) => {
                "Unlock or start the credential store and reopen the app, or switch to System default."
            }
            BlockReason::PasswordMissing => {
                "A password that is gone can only be entered again in Settings, after switching to System default."
            }
            _ => "Repair the file and reopen the app, or switch to System default and enter the proxy again in Settings.",
        }
    }
}

/// What the app runs with, decided once at launch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    System,
    Explicit(Explicit),
    Blocked(Blocked),
}

/* ---------- validation ---------- */

/// Field name to error code; the Console has the words for each code.
pub type FieldErrors = BTreeMap<&'static str, &'static str>;

/// A host name, an IPv4 address or an IPv6 address (with or without brackets); nothing else of a
/// URL. Returns it as it is saved: an IPv6 address without brackets.
pub fn normalize_host(raw: &str) -> Result<String, &'static str> {
    if raw.is_empty() {
        return Err("host_required");
    }
    if raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("host_invalid");
    }
    if let Some(inner) = raw.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        return inner.parse::<Ipv6Addr>().map(|addr| addr.to_string()).map_err(|_| "host_invalid");
    }
    if let Ok(addr) = raw.parse::<Ipv6Addr>() {
        return Ok(addr.to_string());
    }
    if let Ok(addr) = raw.parse::<Ipv4Addr>() {
        return Ok(addr.to_string());
    }
    let labels: Vec<&str> = raw.split('.').collect();
    let label_ok = |label: &&str| {
        !label.is_empty()
            && label.len() <= 63
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    // A name that ends in a number would be read as an address, and it is not one.
    let ends_in_number = labels.last().is_some_and(|label| label.bytes().all(|b| b.is_ascii_digit()));
    if raw.len() > 253 || !labels.iter().all(label_ok) || ends_in_number {
        return Err("host_invalid");
    }
    Ok(raw.to_ascii_lowercase())
}

/// An integer from 1 to 65535, as a number or as digits.
pub fn parse_port(raw: &Value) -> Result<u16, &'static str> {
    let number = match raw {
        Value::Null => return Err("port_required"),
        Value::String(text) if text.trim().is_empty() => return Err("port_required"),
        Value::String(text) => {
            let text = text.trim();
            if !text.bytes().all(|b| b.is_ascii_digit()) {
                return Err("port_invalid");
            }
            text.parse::<u64>().map_err(|_| "port_invalid")?
        }
        Value::Number(number) => number.as_u64().ok_or("port_invalid")?,
        _ => return Err("port_invalid"),
    };
    if (1..=65535).contains(&number) { Ok(number as u16) } else { Err("port_invalid") }
}

pub fn validate_username(username: &str) -> Result<(), &'static str> {
    if username.contains(':') || username.chars().any(char::is_control) {
        return Err("username_invalid");
    }
    if username.len() > MAX_CREDENTIAL_BYTES {
        return Err("username_too_long");
    }
    Ok(())
}

pub fn validate_password(password: &str) -> Result<(), &'static str> {
    if password.chars().any(char::is_control) {
        return Err("password_invalid");
    }
    if password.len() > MAX_CREDENTIAL_BYTES {
        return Err("password_too_long");
    }
    Ok(())
}

/* ---------- the settings file ---------- */

enum FileRead {
    Missing,
    Unreadable(String),
    Unparseable,
    Saved(Saved),
}

fn read_file(path: Option<&Path>) -> FileRead {
    let Some(path) = path else {
        return FileRead::Missing;
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return FileRead::Missing,
        Err(err) => return FileRead::Unreadable(err.to_string()),
    };
    match serde_json::from_slice::<Saved>(&bytes) {
        Ok(saved) => FileRead::Saved(saved),
        Err(_) => FileRead::Unparseable,
    }
}

/// The fields of the file that can be read, one by one: what is kept when the mode is switched,
/// also from a file the app could not load.
fn read_lenient(path: Option<&Path>) -> Saved {
    let Some(value) = path.and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return Saved::default();
    };
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 1024 && !s.chars().any(char::is_control))
            .unwrap_or("")
            .to_owned()
    };
    Saved {
        mode: if value.get("mode").and_then(Value::as_str) == Some("explicit") { Mode::Explicit } else { Mode::System },
        kind: if value.get("type").and_then(Value::as_str) == Some("socks5") { Kind::Socks5 } else { Kind::Http },
        host: text("host"),
        port: value.get("port").map(parse_port).and_then(Result::ok).map_or(0, u32::from),
        username: text("username"),
        has_password: value.get("hasPassword").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn write_file(path: Option<&Path>, saved: &Saved) -> Result<(), String> {
    let Some(path) = path else {
        return Err("this system has no configuration folder for the app".to_owned());
    };
    let json = serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?;
    crate::paths::write_atomic(path, &json).map_err(|e| format!("save {}: {e}", path.display()))
}

/// Loads the saved setting: System default, explicit, or blocked. Anything but a missing file, a
/// file that says System default, and an explicit setting that validates and whose password can
/// be read is blocked, never System default.
pub fn load(path: Option<&Path>, store: &dyn SecretStore) -> State {
    let saved = match read_file(path) {
        FileRead::Missing => return State::System,
        FileRead::Unreadable(err) => return State::Blocked(Blocked { reason: BlockReason::Unreadable(err), known: None }),
        FileRead::Unparseable => return State::Blocked(Blocked { reason: BlockReason::Unparseable, known: None }),
        FileRead::Saved(saved) => saved,
    };
    if saved.mode == Mode::System {
        return State::System;
    }
    let mut invalid: Vec<&'static str> = Vec::new();
    let host = normalize_host(&saved.host).inspect_err(|_| invalid.push("host")).ok();
    let port = parse_port(&json!(saved.port)).inspect_err(|_| invalid.push("port")).ok();
    if validate_username(&saved.username).is_err() {
        invalid.push("user name");
    }
    if saved.has_password && saved.username.is_empty() {
        invalid.push("password");
    }
    let known = match (&host, port) {
        (Some(host), Some(port)) => Some(format!("{} {}", saved.kind.label(), host_port(host, port))),
        _ => None,
    };
    let (Some(host), Some(port), true) = (host, port, invalid.is_empty()) else {
        return State::Blocked(Blocked { reason: BlockReason::InvalidFields(invalid), known });
    };
    let password = if saved.has_password {
        match store.get() {
            Ok(Some(password)) if validate_password(&password).is_ok() => Some(password),
            Ok(Some(_)) => {
                return State::Blocked(Blocked { reason: BlockReason::InvalidFields(vec!["password"]), known });
            }
            Ok(None) => return State::Blocked(Blocked { reason: BlockReason::PasswordMissing, known }),
            Err(err) => return State::Blocked(Blocked { reason: BlockReason::PasswordUnavailable(err), known }),
        }
    } else {
        None
    };
    State::Explicit(Explicit { kind: saved.kind, host, port, username: saved.username, password })
}

/* ---------- the environments ---------- */

/// Whether an environment name is `name`. Windows has one variable for both cases.
fn is_name(key: &OsStr, name: &str) -> bool {
    if cfg!(windows) { key.to_str().is_some_and(|key| key.eq_ignore_ascii_case(name)) } else { key == OsStr::new(name) }
}

fn find<'a>(env: &'a Env, name: &str) -> Option<&'a OsString> {
    env.iter().find(|(key, _)| is_name(key, name)).map(|(_, value)| value)
}

/// The backend's environment, built from the inherited snapshot. System default: the snapshot
/// exactly. Explicit: the eight standard names taken over, `REQUEST_METHOD` removed, the marker
/// added, everything else as inherited. Blocked: none, the backend is not started.
pub fn backend_env(state: &State, inherited: &Env) -> Option<Env> {
    match state {
        State::Blocked(_) => None,
        State::System => Some(inherited.clone()),
        State::Explicit(explicit) => {
            let taken =
                |key: &OsStr| PROXY_NAMES.iter().chain(&BYPASS_NAMES).chain([&CGI_NAME, &MARKER_ENV]).any(|name| is_name(key, name));
            let mut env: Env = inherited.iter().filter(|(key, _)| !taken(key)).cloned().collect();
            let url = explicit.url(true);
            for name in PROXY_NAMES {
                env.push((name.into(), url.clone().into()));
            }
            for name in BYPASS_NAMES {
                env.push((name.into(), LOOPBACK_BYPASS.join(",").into()));
            }
            env.push((MARKER_ENV.into(), "1".into()));
            Some(env)
        }
    }
}

/// The variables this process sets for itself at launch. System default: only when a proxy
/// variable was inherited, the bypass list its client reads (`NO_PROXY` when set, else
/// `no_proxy`) gains the loopback names, under that same name. Explicit: the eight names, with
/// `socks5h://` for SOCKS5. Blocked: none, nothing is requested.
pub fn process_env(state: &State, inherited: &Env) -> Vec<(&'static str, String)> {
    match state {
        State::Blocked(_) => Vec::new(),
        State::System => {
            let proxied = PROXY_NAMES.iter().any(|name| find(inherited, name).is_some_and(|value| !value.is_empty()));
            if !proxied {
                return Vec::new();
            }
            let name = if find(inherited, "NO_PROXY").is_some() || find(inherited, "no_proxy").is_none() {
                "NO_PROXY"
            } else {
                "no_proxy"
            };
            let current = find(inherited, name).map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
            let mut entries: Vec<String> = if current.trim().is_empty() { Vec::new() } else { vec![current.clone()] };
            for loopback in LOOPBACK_BYPASS {
                if !current.split(',').any(|entry| entry.trim().eq_ignore_ascii_case(loopback)) {
                    entries.push(loopback.to_owned());
                }
            }
            vec![(name, entries.join(","))]
        }
        State::Explicit(explicit) => {
            let url = explicit.url(false);
            let mut vars: Vec<(&'static str, String)> = PROXY_NAMES.iter().map(|name| (*name, url.clone())).collect();
            vars.extend(BYPASS_NAMES.iter().map(|name| (*name, LOOPBACK_BYPASS.join(","))));
            vars
        }
    }
}

/* ---------- the launch ---------- */

/// The launch route: the inherited environment as an untouched snapshot, the state the saved
/// setting loaded into, and what this run saved since.
pub struct Launch {
    pub state: State,
    inherited: Env,
    path: Option<PathBuf>,
    store: Arc<dyn SecretStore>,
    /// The password as this run last saved it (`Some(None)`: removed); none while untouched.
    session_password: Mutex<Option<Option<String>>>,
}

/// A save that was refused; nothing was written.
#[derive(Debug, PartialEq, Eq)]
pub enum SaveError {
    Request(String),
    Fields(FieldErrors),
    CredentialStore(String),
    Write(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequest {
    mode: Mode,
    #[serde(rename = "type", default)]
    kind: Option<Kind>,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Value,
    #[serde(default)]
    username: String,
    /// A new password; none (or empty) keeps the stored one.
    #[serde(default)]
    password: Option<String>,
    /// Removes the stored password.
    #[serde(default)]
    clear_password: bool,
}

impl Launch {
    /// Loads the saved setting. Call it before any thread starts, with the environment as it was
    /// inherited.
    pub fn new(inherited: Env, path: Option<PathBuf>, store: Arc<dyn SecretStore>) -> Launch {
        let state = load(path.as_deref(), store.as_ref());
        Launch { state, inherited, path, store, session_password: Mutex::new(None) }
    }

    /// The launch of the app: the process's environment, the settings file, the system's store.
    pub fn from_system() -> Launch {
        Launch::new(std::env::vars_os().collect(), crate::paths::network_proxy_file(), Arc::new(crate::proxy_secret::SystemStore))
    }

    /// Sets this process's proxy variables for the launch state. They are not changed again.
    ///
    /// # Safety
    /// Changes the process environment: call it once, before any other thread exists.
    pub unsafe fn apply_process_env(&self) {
        for (name, value) in process_env(&self.state, &self.inherited) {
            unsafe { std::env::set_var(name, value) };
        }
    }

    /// The environment of every backend this run starts; none while blocked.
    pub fn backend_env(&self) -> Option<Env> {
        backend_env(&self.state, &self.inherited)
    }

    pub fn blocked(&self) -> Option<&Blocked> {
        match &self.state {
            State::Blocked(blocked) => Some(blocked),
            _ => None,
        }
    }

    /// The running explicit proxy by type, host and port.
    pub fn running_label(&self) -> Option<String> {
        match &self.state {
            State::Explicit(explicit) => Some(explicit.describe()),
            _ => None,
        }
    }

    /// The filter for the log and the diagnostics of this run.
    pub fn redactor(&self) -> Redactor {
        match &self.state {
            State::Explicit(Explicit { username, password: Some(password), .. }) => {
                Redactor::for_credentials(username, password)
            }
            _ => Redactor::none(),
        }
    }

    /// One line for the log: the state, by type, host and port at most.
    pub fn log_line(&self) -> String {
        match &self.state {
            State::System => "desktop_proxy mode=system".to_owned(),
            State::Explicit(explicit) => format!(
                "desktop_proxy mode=explicit proxy=\"{}\" auth={}",
                explicit.describe(),
                if explicit.username.is_empty() { "none" } else { "user" }
            ),
            State::Blocked(blocked) => format!(
                "desktop_proxy blocked reason={} proxy=\"{}\"",
                blocked.kind(),
                blocked.known.as_deref().unwrap_or("unknown")
            ),
        }
    }

    fn saved(&self) -> Saved {
        match read_file(self.path.as_deref()) {
            FileRead::Saved(saved) => saved,
            FileRead::Missing => Saved::default(),
            _ => read_lenient(self.path.as_deref()),
        }
    }

    /// Whether the saved setting differs from the running one: it applies after a quit and reopen.
    fn pending(&self, saved: &Saved) -> bool {
        match &self.state {
            State::System => saved.mode == Mode::Explicit,
            State::Blocked(_) => false,
            State::Explicit(running) => {
                let session = self.session_password.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let password_changed = match session {
                    Some(password) => password != running.password,
                    None => saved.has_password != running.password.is_some(),
                };
                saved.mode == Mode::System
                    || saved.kind != running.kind
                    || normalize_host(&saved.host).ok().as_deref() != Some(running.host.as_str())
                    || saved.port != u32::from(running.port)
                    || saved.username != running.username
                    || password_changed
            }
        }
    }

    /// What the Console may know: the saved setting without the password, the running state,
    /// whether a quit and reopen is pending, and whether a credential store is available.
    pub fn view(&self) -> Value {
        let saved = self.saved();
        let running = match &self.state {
            State::Explicit(running) => json!({
                "mode": "explicit",
                "type": running.kind,
                "host": running.host,
                "port": running.port,
                "username": running.username,
            }),
            _ => json!({ "mode": "system" }),
        };
        json!({
            "saved": {
                "mode": saved.mode,
                "type": saved.kind,
                "host": saved.host,
                "port": if saved.port == 0 { Value::Null } else { json!(saved.port) },
                "username": saved.username,
                "hasPassword": saved.has_password,
            },
            "running": running,
            "pending": self.pending(&saved),
            "credentialStore": self.store.available(),
        })
    }

    /// Saves the setting and nothing else: no process starts or stops, and the running route
    /// stays. A request that fails validation, or a password the credential store does not take,
    /// changes nothing.
    pub fn save(&self, request: Value) -> Result<(), SaveError> {
        let request: SaveRequest = serde_json::from_value(request).map_err(|e| SaveError::Request(e.to_string()))?;
        let previous = self.saved();
        if request.mode == Mode::System {
            // The saved fields and the stored password stay, to switch the proxy back on.
            let mut next = Saved { mode: Mode::System, ..previous };
            if request.clear_password {
                next.has_password = false;
            }
            write_file(self.path.as_deref(), &next).map_err(SaveError::Write)?;
            if request.clear_password {
                self.forget_password();
            }
            return Ok(());
        }

        let mut errors = FieldErrors::new();
        let host = normalize_host(request.host.trim()).inspect_err(|code| _ = errors.insert("host", code)).ok();
        let port = parse_port(&request.port).inspect_err(|code| _ = errors.insert("port", code)).ok();
        if let Err(code) = validate_username(&request.username) {
            errors.insert("username", code);
        }
        let new_password = request.password.filter(|password| !password.is_empty());
        let has_password = new_password.is_some() || (previous.has_password && !request.clear_password);
        if let Some(code) = new_password.as_deref().and_then(|password| validate_password(password).err()) {
            errors.insert("password", code);
        } else if has_password && request.username.is_empty() {
            errors.insert("password", "password_without_username");
        }
        let (Some(host), Some(port), true) = (host, port, errors.is_empty()) else {
            return Err(SaveError::Fields(errors));
        };

        match &new_password {
            Some(password) => self.store.set(password).map_err(SaveError::CredentialStore)?,
            // A kept password has to be there, or the next start would be blocked.
            None if has_password => match self.store.get() {
                Ok(Some(_)) => {}
                Ok(None) => return Err(SaveError::Fields(FieldErrors::from([("password", "password_missing")]))),
                Err(err) => return Err(SaveError::CredentialStore(err)),
            },
            None => {}
        }
        let next = Saved {
            mode: Mode::Explicit,
            kind: request.kind.unwrap_or(previous.kind),
            host,
            port: u32::from(port),
            username: request.username,
            has_password,
        };
        write_file(self.path.as_deref(), &next).map_err(SaveError::Write)?;
        match new_password {
            Some(password) => *self.session_password.lock().unwrap_or_else(|e| e.into_inner()) = Some(Some(password)),
            None if request.clear_password => self.forget_password(),
            None => {}
        }
        Ok(())
    }

    /// Removes the stored password after the file stopped naming it. A store that cannot be
    /// reached leaves an entry nothing reads.
    fn forget_password(&self) {
        if let Err(err) = self.store.delete() {
            log::warn!("remove the network proxy password from the credential store: {err}");
        }
        *self.session_password.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
    }

    /// "Switch to System default": writes System default to the settings file, keeping the fields
    /// that can be read and the stored password. It applies at the next launch.
    pub fn switch_to_system(&self) -> Result<(), String> {
        let next = Saved { mode: Mode::System, ..read_lenient(self.path.as_deref()) };
        write_file(self.path.as_deref(), &next)
    }
}

/// The answer of `morph.desktop.networkProxy.set`: the new view, or why nothing was saved. No
/// answer holds a credential.
pub fn save_answer(launch: &Launch, request: Value) -> Value {
    match launch.save(request) {
        Ok(()) => {
            let mut view = launch.view();
            view["ok"] = json!(true);
            view
        }
        Err(SaveError::Fields(fields)) => json!({ "ok": false, "error": "validation", "fields": fields }),
        Err(SaveError::CredentialStore(message)) => json!({ "ok": false, "error": "credential_store", "message": message }),
        Err(SaveError::Write(message)) => json!({ "ok": false, "error": "write", "message": message }),
        Err(SaveError::Request(message)) => json!({ "ok": false, "error": "request", "message": message }),
    }
}

#[cfg(test)]
mod tests;
