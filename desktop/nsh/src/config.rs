//! The parts of the Mister Morph config the desktop shell reads itself (as the Wails app did):
//! where it is, and `auto_update`.
use std::path::{Path, PathBuf};

use yaml_rust2::{Yaml, YamlLoader};

pub const CHECK_UPDATE_ARG: &str = "--check-update";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutoUpdate {
    pub enabled: bool,
    /// The release channel to follow; empty means the build channel.
    pub channel: String,
}

/// Reads `auto_update.enabled` and `auto_update.channel` from the YAML config at `path`.
pub fn load_auto_update(path: Option<&Path>) -> Result<AutoUpdate, String> {
    let Some(path) = path else {
        return Ok(AutoUpdate::default());
    };
    let text = std::fs::read_to_string(path).map_err(|e| format!("read desktop config: {e}"))?;
    parse_auto_update(&text).map_err(|e| format!("read desktop config: {e}"))
}

pub fn parse_auto_update(text: &str) -> Result<AutoUpdate, String> {
    let docs = YamlLoader::load_from_str(text).map_err(|e| e.to_string())?;
    let Some(doc) = docs.first() else {
        return Ok(AutoUpdate::default());
    };
    let section = &doc["auto_update"];
    Ok(AutoUpdate {
        enabled: yaml_bool(&section["enabled"]),
        channel: match &section["channel"] {
            Yaml::String(s) => s.trim().to_owned(),
            Yaml::Integer(i) => i.to_string(),
            _ => String::new(),
        },
    })
}

/// What viper's `GetBool` makes of a value (spf13/cast `ToBool`).
fn yaml_bool(value: &Yaml) -> bool {
    match value {
        Yaml::Boolean(b) => *b,
        Yaml::Integer(i) => *i != 0,
        Yaml::String(s) => parse_go_bool(s).unwrap_or(false),
        _ => false,
    }
}

/// Go's `strconv.ParseBool`.
pub fn parse_go_bool(value: &str) -> Option<bool> {
    match value.trim() {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// Reads `auto_update` from the backend's settings API answer (`GET /api/settings/auto-update`),
/// for a config kept in agent.db, which the shell cannot read before the backend runs.
pub fn parse_settings_auto_update(body: &str) -> Result<AutoUpdate, String> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("read auto_update settings: {e}"))?;
    let section = &value["auto_update"];
    if !section.is_object() {
        return Err("read auto_update settings: no auto_update".to_owned());
    }
    let enabled = match &section["enabled"] {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => parse_go_bool(s.trim()).unwrap_or(false),
        _ => false,
    };
    let channel = section["channel"].as_str().unwrap_or("").trim().to_lowercase();
    Ok(AutoUpdate { enabled, channel })
}

/// Where the Console keeps its login in the app's local store (`AUTH_STORAGE_KEY` in
/// web/console-nsh/lib/stores/authStore.js): `{"token": ..., "expiresAt": ..., "account": ...}`.
pub const CONSOLE_AUTH_KEY: &str = "mistermorph_console_auth_v1";

/// The Console's session token from the value it keeps under [`CONSOLE_AUTH_KEY`]; none when
/// there is no login.
pub fn console_token(stored: Option<&str>) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(stored?).ok()?;
    let token = value["token"].as_str()?.trim();
    if token.is_empty() { None } else { Some(token.to_owned()) }
}

/// Why the settings request failed: `unauthorized` when the backend wants a Console login (a
/// Console password is set) that the request did not have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub unauthorized: bool,
    pub message: String,
}

/// Fetches `auto_update` from the backend at `addr` (`127.0.0.1:<port>`) under `base_path`, with
/// the Console's session token when there is one, as the Console's own requests send it.
pub fn fetch_backend_auto_update(addr: &str, base_path: &str, token: Option<&str>) -> Result<AutoUpdate, FetchError> {
    let base = base_path.trim().trim_end_matches('/');
    let url = format!("http://{}{}/api/settings/auto-update", addr.trim(), base);
    let failed = |message: String| FetchError { unauthorized: false, message };
    let agent = crate::http::agent(Some(std::time::Duration::from_secs(10)));
    let mut request = agent.get(&url);
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }
    let mut response = request.call().map_err(|e| failed(format!("get {url}: {e}")))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|e| failed(format!("get {url}: {e}")))?;
    if status == 401 {
        return Err(FetchError { unauthorized: true, message: format!("get {url}: status 401") });
    }
    if status != 200 {
        return Err(failed(format!("get {url}: status {status}")));
    }
    parse_settings_auto_update(&body).map_err(failed)
}

/// Reads `auto_update` from the backend, waiting for a Console login when the backend asks for
/// one: `fetch` is tried with the current token, and after a 401 again with each new token
/// `next_token` returns (it is given the token that was refused, and returns none to give up).
pub fn read_backend_auto_update(
    mut token: Option<String>,
    mut fetch: impl FnMut(Option<&str>) -> Result<AutoUpdate, FetchError>,
    mut next_token: impl FnMut(Option<&str>) -> Option<String>,
) -> Result<AutoUpdate, String> {
    loop {
        match fetch(token.as_deref()) {
            Ok(cfg) => return Ok(cfg),
            Err(err) if err.unauthorized => match next_token(token.as_deref()) {
                Some(next) => token = Some(next),
                None => return Err(err.message),
            },
            Err(err) => return Err(err.message),
        }
    }
}

/// The config file: `--config <path>` (or `--config=<path>`) when given, else
/// `~/.morph/config.yaml` when it exists. The flag tells whether it was explicit. Without
/// `--config` the backend keeps the config in agent.db (and imports that file once), so only an
/// explicit path is passed on to it.
pub fn resolve_config_path(args: &[String]) -> (Option<PathBuf>, bool) {
    if let Some(explicit) = extract_config_path(args) {
        return (Some(crate::paths::expand_home(&explicit)), true);
    }
    let default = crate::paths::default_config_path();
    if default.exists() { (Some(default), false) } else { (None, false) }
}

pub fn extract_config_path(args: &[String]) -> Option<String> {
    let mut iter = args.iter().map(|a| a.trim());
    while let Some(arg) = iter.next() {
        if arg == "--config" {
            if let Some(value) = iter.next() {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_owned());
                }
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--config=") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

pub fn has_check_update_arg(args: &[String]) -> bool {
    args.iter().any(|a| a.trim() == CHECK_UPDATE_ARG)
}

pub fn print_config_path(path: Option<&Path>, explicit: bool) {
    let source = if explicit { "explicit" } else { "auto" };
    let shown = path.map_or_else(|| "(none)".to_owned(), |p| p.display().to_string());
    eprintln!("desktop app config path [{source}]: {shown}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_auto_update() {
        let cfg = parse_auto_update("auto_update:\n  enabled: true\n  channel: \" Pro \"\n").unwrap();
        assert_eq!(cfg, AutoUpdate { enabled: true, channel: "Pro".into() });
        let cfg = parse_auto_update("auto_update:\n  enabled: \"true\"\n").unwrap();
        assert!(cfg.enabled);
        assert_eq!(parse_auto_update("llm:\n  model: x\n").unwrap(), AutoUpdate::default());
        assert_eq!(parse_auto_update("").unwrap(), AutoUpdate::default());
        assert_eq!(parse_auto_update("auto_update: 3\n").unwrap(), AutoUpdate::default());
        assert!(parse_auto_update("a: [\n").is_err());
    }

    #[test]
    fn reads_auto_update_from_the_settings_api() {
        let cfg = parse_settings_auto_update(r#"{"auto_update":{"enabled":true,"channel":" Pro "},"config_path":"x"}"#).unwrap();
        assert_eq!(cfg, AutoUpdate { enabled: true, channel: "pro".to_owned() });
        let cfg = parse_settings_auto_update(r#"{"auto_update":{"enabled":"false"}}"#).unwrap();
        assert_eq!(cfg, AutoUpdate::default());
        assert!(parse_settings_auto_update(r#"{"error":"unauthorized"}"#).is_err());
        assert!(parse_settings_auto_update("not json").is_err());
    }

    #[test]
    fn reads_the_console_token() {
        assert_eq!(console_token(Some(r#"{"token":" t1 ","expiresAt":"x","account":"console"}"#)), Some("t1".to_owned()));
        assert_eq!(console_token(Some(r#"{"token":""}"#)), None);
        assert_eq!(console_token(Some("not json")), None);
        assert_eq!(console_token(None), None);
    }

    /// Answers each request on a loopback port: 200 with auto_update enabled for `Bearer good`,
    /// 401 otherwise, as a backend with a Console password does. Returns the address and the
    /// Authorization headers seen.
    fn serve_settings(requests: usize) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..requests {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut auth = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("authorization:") {
                        auth = value.trim().to_owned();
                    }
                }
                let reply: &[u8] = if auth == "bearer good" {
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 48\r\nConnection: close\r\n\r\n{\"auto_update\":{\"enabled\":true,\"channel\":\"pro\"}}"
                } else {
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 24\r\nConnection: close\r\n\r\n{\"error\":\"unauthorized\"}"
                };
                let mut stream = stream;
                stream.write_all(reply).unwrap();
                seen.push(auth);
            }
            seen
        });
        (addr, handle)
    }

    #[test]
    fn sends_the_console_token() {
        let (addr, server) = serve_settings(2);
        let err = fetch_backend_auto_update(&addr, "/", None).unwrap_err();
        assert!(err.unauthorized, "{err:?}");
        let cfg = fetch_backend_auto_update(&addr, "/", Some("good")).unwrap();
        assert_eq!(cfg, AutoUpdate { enabled: true, channel: "pro".to_owned() });
        assert_eq!(server.join().unwrap(), vec!["".to_owned(), "bearer good".to_owned()]);
    }

    #[test]
    fn retries_after_a_login() {
        let (addr, server) = serve_settings(3);
        // A stale token is refused; the app then logs in twice, the second login being the good one.
        let mut logins = vec!["good".to_owned(), "other".to_owned()];
        let mut refused = Vec::new();
        let cfg = read_backend_auto_update(
            Some("stale".to_owned()),
            |token| fetch_backend_auto_update(&addr, "/", token),
            |previous| {
                refused.push(previous.map(str::to_owned));
                logins.pop()
            },
        )
        .unwrap();
        assert!(cfg.enabled);
        assert_eq!(refused, vec![Some("stale".to_owned()), Some("other".to_owned())]);
        assert_eq!(server.join().unwrap(), vec!["bearer stale", "bearer other", "bearer good"]);

        // No login comes: the 401 is the answer. Another failure is not retried.
        let err = read_backend_auto_update(None, |_| Err(FetchError { unauthorized: true, message: "401".into() }), |_| None);
        assert_eq!(err, Err("401".to_owned()));
        let mut calls = 0;
        let err = read_backend_auto_update(
            None,
            |_| {
                calls += 1;
                Err(FetchError { unauthorized: false, message: "down".into() })
            },
            |_| Some("t".to_owned()),
        );
        assert_eq!((err, calls), (Err("down".to_owned()), 1));
    }

    #[test]
    fn missing_file_is_an_error() {
        let err = load_auto_update(Some(Path::new("/nonexistent/morph.yaml"))).unwrap_err();
        assert!(err.starts_with("read desktop config:"), "{err}");
        assert_eq!(load_auto_update(None).unwrap(), AutoUpdate::default());
    }

    #[test]
    fn finds_the_config_flag() {
        assert_eq!(extract_config_path(&args(&["--config", "/a.yaml"])), Some("/a.yaml".into()));
        assert_eq!(extract_config_path(&args(&["x", "--config=/b.yaml"])), Some("/b.yaml".into()));
        assert_eq!(extract_config_path(&args(&["--config"])), None);
        assert_eq!(extract_config_path(&args(&["--configx=/c"])), None);
        let (path, explicit) = resolve_config_path(&args(&["--config", "~/m.yaml"]));
        assert!(explicit);
        assert_eq!(path.unwrap(), dirs::home_dir().unwrap().join("m.yaml"));
    }

    #[test]
    fn finds_check_update() {
        assert!(has_check_update_arg(&args(&["--check-update"])));
        assert!(!has_check_update_arg(&args(&["--check"])));
    }

    #[test]
    fn parses_go_bools() {
        assert_eq!(parse_go_bool("True"), Some(true));
        assert_eq!(parse_go_bool("0"), Some(false));
        assert_eq!(parse_go_bool("yes"), None);
    }
}
