//! Tests of the network proxy setting. The routing tests give a child process (this test binary
//! again) the environment the launch would set, and watch fake HTTP and SOCKS5 proxies on
//! loopback: ureq reads the proxy environment when an agent is built, and nsh's agents are built
//! once per process.
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use base64::Engine;

use super::*;
use crate::proxy_secret::MemoryStore;

const BYPASS: &str = "localhost,127.0.0.1,::1,[::1]";

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs.iter().map(|(k, v)| (k.into(), v.into())).collect()
}

fn get<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == name).and_then(|(_, v)| v.to_str())
}

fn explicit(kind: Kind, username: &str, password: Option<&str>) -> Explicit {
    Explicit { kind, host: "proxy.example".into(), port: 8080, username: username.into(), password: password.map(str::to_owned) }
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    store: Arc<MemoryStore>,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mistermorph/desktop/network-proxy.json");
        Fixture { _dir: dir, path, store: Arc::new(MemoryStore::default()) }
    }

    fn write(&self, json: &str) {
        std::fs::create_dir_all(self.path.parent().unwrap()).unwrap();
        std::fs::write(&self.path, json).unwrap();
    }

    fn file(&self) -> String {
        std::fs::read_to_string(&self.path).unwrap_or_default()
    }

    /// A launch: what the app does when it is opened.
    fn launch(&self, inherited: Env) -> Launch {
        Launch::new(inherited, Some(self.path.clone()), self.store.clone())
    }
}

fn request(mode: &str, kind: &str, host: &str, port: Value, username: &str, password: Option<&str>) -> Value {
    json!({ "mode": mode, "type": kind, "host": host, "port": port, "username": username, "password": password })
}

/* ---------- validation ---------- */

#[test]
fn validates_hosts() {
    for (raw, saved) in [
        ("proxy.example", "proxy.example"),
        ("Proxy.Example", "proxy.example"),
        ("localhost", "localhost"),
        ("10.0.0.2", "10.0.0.2"),
        ("::1", "::1"),
        ("[2001:db8::1]", "2001:db8::1"),
        ("2001:DB8::1", "2001:db8::1"),
        ("a-b.c1", "a-b.c1"),
    ] {
        assert_eq!(normalize_host(raw).as_deref(), Ok(saved), "{raw}");
    }
    assert_eq!(normalize_host(""), Err("host_required"));
    for raw in [
        "http://host", "host:80", "host/path", "user@host", " host", "host ", "ho st", "host\t", "[::1", "::1]", "[host]", "-host", "host-",
        "a..b", "1.2.3", "999.1.1.1", "host.", "h_st", "fe80::1%eth0", "[::1]:80",
    ] {
        assert_eq!(normalize_host(raw), Err("host_invalid"), "{raw}");
    }
}

#[test]
fn validates_ports() {
    for (raw, port) in [(json!(1), 1), (json!(65535), 65535), (json!("8080"), 8080), (json!(" 3128 "), 3128)] {
        assert_eq!(parse_port(&raw), Ok(port), "{raw}");
    }
    for raw in [Value::Null, json!(""), json!("  ")] {
        assert_eq!(parse_port(&raw), Err("port_required"), "{raw}");
    }
    for raw in [json!(0), json!(65536), json!(-1), json!(80.5), json!("0"), json!("65536"), json!("80a"), json!("+80"), json!("8 0"), json!(true)] {
        assert_eq!(parse_port(&raw), Err("port_invalid"), "{raw}");
    }
}

#[test]
fn validates_credentials() {
    assert_eq!(validate_username(""), Ok(()));
    assert_eq!(validate_username("mo rph@corp"), Ok(()));
    assert_eq!(validate_username("a:b"), Err("username_invalid"));
    assert_eq!(validate_username("a\nb"), Err("username_invalid"));
    assert_eq!(validate_username(&"u".repeat(255)), Ok(()));
    assert_eq!(validate_username(&"u".repeat(256)), Err("username_too_long"));
    // Bytes, not characters.
    assert_eq!(validate_username(&"é".repeat(128)), Err("username_too_long"));
    assert_eq!(validate_password("p@ss:w%rd 1"), Ok(()));
    assert_eq!(validate_password("a\u{7}b"), Err("password_invalid"));
    assert_eq!(validate_password(&"p".repeat(256)), Err("password_too_long"));
}

#[test]
fn refuses_invalid_settings_on_their_field_and_saves_nothing() {
    let cases: [(Value, &str, &str); 9] = [
        (request("explicit", "http", "", json!(8080), "", None), "host", "host_required"),
        (request("explicit", "http", "http://host", json!(8080), "", None), "host", "host_invalid"),
        (request("explicit", "http", "host:80", json!(8080), "", None), "host", "host_invalid"),
        (request("explicit", "http", "host", json!(0), "", None), "port", "port_invalid"),
        (request("explicit", "http", "host", json!(65536), "", None), "port", "port_invalid"),
        (request("explicit", "http", "host", Value::Null, "", None), "port", "port_required"),
        (request("explicit", "http", "host", json!(80), "a:b", None), "username", "username_invalid"),
        (request("explicit", "http", "host", json!(80), "", Some("secret")), "password", "password_without_username"),
        (request("explicit", "http", "host", json!(80), &"u".repeat(256), None), "username", "username_too_long"),
    ];
    for (request, field, code) in cases {
        let fixture = Fixture::new();
        let launch = fixture.launch(Vec::new());
        let answer = save_answer(&launch, request.clone());
        assert_eq!(answer["ok"], json!(false), "{request}");
        assert_eq!(answer["error"], "validation");
        assert_eq!(answer["fields"][field], code, "{request}");
        assert!(!fixture.path.exists(), "nothing is saved: {request}");
        assert_eq!(fixture.store.stored(), None, "nothing is stored: {request}");
    }
    // Every failing field is reported at once.
    let fixture = Fixture::new();
    let answer = save_answer(&fixture.launch(Vec::new()), request("explicit", "http", "", json!(0), "a:b", None));
    assert_eq!(answer["fields"], json!({ "host": "host_required", "port": "port_invalid", "username": "username_invalid" }));
}

/* ---------- the proxy url ---------- */

#[test]
fn builds_proxy_urls() {
    let plain = explicit(Kind::Http, "", None);
    assert_eq!(plain.url(true), "http://proxy.example:8080");
    assert_eq!(plain.url(false), "http://proxy.example:8080");
    let socks = explicit(Kind::Socks5, "", None);
    assert_eq!(socks.url(true), "socks5://proxy.example:8080", "never socks5h for the backend");
    assert_eq!(socks.url(false), "socks5h://proxy.example:8080", "names resolve at the proxy for ureq");
    let auth = explicit(Kind::Http, "mo rph@x", Some("p@ss:w%rd /+"));
    assert_eq!(auth.url(true), "http://mo%20rph%40x:p%40ss%3Aw%25rd%20%2F%2B@proxy.example:8080");
    // A user name with an empty password is valid.
    assert_eq!(explicit(Kind::Socks5, "user", None).url(true), "socks5://user:@proxy.example:8080");
    let v6 = Explicit { host: "2001:db8::1".into(), ..explicit(Kind::Http, "", None) };
    assert_eq!(v6.url(true), "http://[2001:db8::1]:8080");
    assert_eq!(v6.describe(), "HTTP [2001:db8::1]:8080");
    // Nothing that names the proxy for a person holds a credential.
    assert_eq!(auth.describe(), "HTTP proxy.example:8080");
    assert!(!format!("{auth:?}").contains("p@ss"));
}

/* ---------- the environments ---------- */

#[test]
fn system_default_leaves_the_backend_environment_alone() {
    // Regression rows 14 to 17.
    let inherited = env(&[
        ("PATH", "/bin"),
        ("HTTP_PROXY", "http://corp:3128"),
        ("https_proxy", "http://corp:3129"),
        ("ALL_PROXY", "socks5://corp:1080"),
        ("NO_PROXY", "example.com"),
        ("no_proxy", "other.test"),
        ("REQUEST_METHOD", "GET"),
    ]);
    assert_eq!(backend_env(&State::System, &inherited), Some(inherited.clone()), "exactly the inherited environment");
    assert_eq!(
        process_env(&State::System, &inherited),
        [("NO_PROXY", "example.com,localhost,127.0.0.1,::1,[::1]".to_owned())],
        "only the bypass list the client reads gains the loopback names; no_proxy stays"
    );

    let lower = env(&[("http_proxy", "http://corp:3128"), ("no_proxy", "other.test")]);
    assert_eq!(backend_env(&State::System, &lower), Some(lower.clone()));
    assert_eq!(process_env(&State::System, &lower), [("no_proxy", "other.test,localhost,127.0.0.1,::1,[::1]".to_owned())]);

    let no_list = env(&[("https_proxy", "http://corp:3128")]);
    assert_eq!(process_env(&State::System, &no_list), [("NO_PROXY", BYPASS.to_owned())]);

    // An empty NO_PROXY is still the one ureq reads.
    let empty = env(&[("ALL_PROXY", "socks5://corp:1080"), ("NO_PROXY", ""), ("no_proxy", "other.test")]);
    assert_eq!(process_env(&State::System, &empty), [("NO_PROXY", BYPASS.to_owned())]);

    // Existing entries are kept, `*` and loopback names that are already there included.
    let star = env(&[("HTTP_PROXY", "http://corp:3128"), ("NO_PROXY", "*, LOCALHOST ,127.0.0.1")]);
    assert_eq!(process_env(&State::System, &star), [("NO_PROXY", "*, LOCALHOST ,127.0.0.1,::1,[::1]".to_owned())]);

    let none = env(&[("PATH", "/bin"), ("NO_PROXY", "example.com")]);
    assert_eq!(backend_env(&State::System, &none), Some(none.clone()));
    assert!(process_env(&State::System, &none).is_empty(), "no proxy variable inherited: nothing is set");
}

#[test]
fn explicit_proxy_takes_the_standard_names_over() {
    // Regression rows 11, 13 and 18; acceptance criterion 2.
    let inherited = env(&[
        ("PATH", "/bin"),
        ("HOME", "/home/someone"),
        ("http_proxy", "http://elsewhere:1"),
        ("HTTPS_PROXY", "http://elsewhere:2"),
        ("all_proxy", "socks5://elsewhere:3"),
        ("NO_PROXY", "*"),
        ("no_proxy", "example.com,.internal"),
        ("REQUEST_METHOD", "GET"),
        (MARKER_ENV, "0"),
        ("MISTERMORPH_DESKTOP_BACKEND_BIN", "/opt/morph"),
    ]);
    for (kind, backend_url, process_url) in [
        (Kind::Http, "http://mo%20rph:p%40ss@proxy.example:8080", "http://mo%20rph:p%40ss@proxy.example:8080"),
        (Kind::Socks5, "socks5://mo%20rph:p%40ss@proxy.example:8080", "socks5h://mo%20rph:p%40ss@proxy.example:8080"),
    ] {
        let state = State::Explicit(explicit(kind, "mo rph", Some("p@ss")));
        let backend = backend_env(&state, &inherited).unwrap();
        for name in PROXY_NAMES {
            assert_eq!(get(&backend, name), Some(backend_url), "{name}");
            assert_eq!(backend.iter().filter(|(k, _)| k == name).count(), 1, "{name} once");
        }
        for name in BYPASS_NAMES {
            assert_eq!(get(&backend, name), Some(BYPASS), "only loopback bypasses: {name}");
        }
        assert_eq!(get(&backend, MARKER_ENV), Some("1"));
        assert_eq!(get(&backend, "REQUEST_METHOD"), None);
        assert!(!backend.iter().any(|(_, v)| v.to_string_lossy().contains("socks5h://")));
        // Every other inherited variable passes unchanged.
        let others: Env = backend.iter().filter(|(k, _)| ["PATH", "HOME", "MISTERMORPH_DESKTOP_BACKEND_BIN"].iter().any(|n| k == n)).cloned().collect();
        assert_eq!(others, env(&[("PATH", "/bin"), ("HOME", "/home/someone"), ("MISTERMORPH_DESKTOP_BACKEND_BIN", "/opt/morph")]));
        assert_eq!(backend.len(), 3 + 6 + 2 + 1);

        let process: BTreeMap<_, _> = process_env(&state, &inherited).into_iter().collect();
        for name in PROXY_NAMES {
            assert_eq!(process.get(name).map(String::as_str), Some(process_url), "{name}");
        }
        for name in BYPASS_NAMES {
            assert_eq!(process.get(name).map(String::as_str), Some(BYPASS), "{name}");
        }
        assert_eq!(process.len(), 8, "the marker and REQUEST_METHOD are the backend's matter");
    }
}

#[test]
fn a_blocked_start_has_no_environment() {
    let blocked = State::Blocked(Blocked { reason: BlockReason::Unparseable, known: None });
    let inherited = env(&[("HTTP_PROXY", "http://corp:3128")]);
    assert_eq!(backend_env(&blocked, &inherited), None);
    assert!(process_env(&blocked, &inherited).is_empty());
}

/* ---------- loading ---------- */

#[test]
fn first_use_is_system_default() {
    let fixture = Fixture::new();
    let inherited = env(&[("PATH", "/bin"), ("HTTPS_PROXY", "http://corp:3128")]);
    let launch = fixture.launch(inherited.clone());
    assert_eq!(launch.state, State::System);
    assert!(launch.blocked().is_none());
    assert_eq!(launch.backend_env(), Some(inherited));
    assert!(!launch.redactor().is_active());
    let view = launch.view();
    assert_eq!(view["saved"]["mode"], "system");
    assert_eq!(view["running"], json!({ "mode": "system" }));
    assert_eq!(view["pending"], false);
    assert!(!fixture.path.exists(), "reading the setting writes nothing");
    // Without a configuration folder there is no file either.
    assert_eq!(Launch::new(Vec::new(), None, fixture.store.clone()).state, State::System);
}

#[test]
fn loads_an_explicit_setting() {
    let fixture = Fixture::new();
    fixture.write(r#"{"mode":"explicit","type":"socks5","host":"[2001:db8::1]","port":1080,"username":"morph","hasPassword":true}"#);
    fixture.store.put(Some("s3cret"));
    let launch = fixture.launch(Vec::new());
    assert_eq!(
        launch.state,
        State::Explicit(Explicit { kind: Kind::Socks5, host: "2001:db8::1".into(), port: 1080, username: "morph".into(), password: Some("s3cret".into()) })
    );
    assert_eq!(launch.running_label().as_deref(), Some("SOCKS5 [2001:db8::1]:1080"));
    assert!(launch.redactor().is_active());
    assert_eq!(launch.log_line(), r#"desktop_proxy mode=explicit proxy="SOCKS5 [2001:db8::1]:1080" auth=user"#);

    // A file that says System default is System default, whatever else it holds.
    fixture.write(r#"{"mode":"system","type":"http","host":"not a host","port":0,"username":"","hasPassword":true}"#);
    assert_eq!(fixture.launch(Vec::new()).state, State::System);
}

#[test]
fn anything_else_blocks_the_start() {
    // Regression rows 41 and 42: never System default.
    let blocked = |fixture: &Fixture| match fixture.launch(env(&[("HTTP_PROXY", "http://corp:3128")])).state {
        State::Blocked(blocked) => blocked,
        other => panic!("not blocked: {other:?}"),
    };
    let fixture = Fixture::new();
    for broken in ["", "{not json", "[]", r#"{"mode":"direct"}"#, r#"{"type":"http"}"#, r#"{"mode":"explicit","type":"socks4","host":"h","port":1}"#, r#"{"mode":"explicit","host":"h","port":"x"}"#]
    {
        fixture.write(broken);
        let state = blocked(&fixture);
        assert_eq!(state.reason, BlockReason::Unparseable, "{broken}");
        assert_eq!(state.known, None);
    }

    // A directory where the file should be cannot be read.
    let unreadable = Fixture::new();
    std::fs::create_dir_all(&unreadable.path).unwrap();
    assert!(matches!(blocked(&unreadable).reason, BlockReason::Unreadable(_)));

    fixture.write(r#"{"mode":"explicit","type":"http","host":"proxy.example","port":70000,"username":"","hasPassword":false}"#);
    let state = blocked(&fixture);
    assert_eq!(state.reason, BlockReason::InvalidFields(vec!["port"]));
    assert_eq!(state.message(), "The saved network proxy has an invalid port.");
    assert_eq!(state.known, None, "the port is not known");

    fixture.write(r#"{"mode":"explicit","type":"http","host":"http://x","port":0,"username":"a:b","hasPassword":false}"#);
    assert_eq!(blocked(&fixture).reason, BlockReason::InvalidFields(vec!["host", "port", "user name"]));

    fixture.write(r#"{"mode":"explicit","type":"http","host":"proxy.example","port":8080,"username":"","hasPassword":true}"#);
    assert_eq!(blocked(&fixture).reason, BlockReason::InvalidFields(vec!["password"]), "a password without a user name");

    // The password: removed from the store, then the store unavailable.
    fixture.write(r#"{"mode":"explicit","type":"http","host":"proxy.example","port":8080,"username":"morph","hasPassword":true}"#);
    let state = blocked(&fixture);
    assert_eq!(state.reason, BlockReason::PasswordMissing);
    assert_eq!(state.known.as_deref(), Some("HTTP proxy.example:8080"));
    fixture.store.put(Some("s3cret"));
    fixture.store.set_unavailable(true);
    let state = blocked(&fixture);
    assert!(matches!(state.reason, BlockReason::PasswordUnavailable(_)));
    for text in [state.message(), state.advice().to_owned(), format!("{state:?}"), fixture.launch(Vec::new()).log_line()] {
        assert!(!text.contains("s3cret") && !text.contains("morph:"), "{text}");
    }

    // Blocked: no backend environment, nothing set for the process.
    let launch = fixture.launch(env(&[("HTTP_PROXY", "http://corp:3128")]));
    assert_eq!(launch.backend_env(), None);
    assert!(process_env(&launch.state, &launch.inherited).is_empty());
    assert_eq!(launch.running_label(), None);

    // Repaired outside the app (the store is back), then reopened: the explicit proxy runs.
    fixture.store.set_unavailable(false);
    assert!(matches!(fixture.launch(Vec::new()).state, State::Explicit(_)));
}

#[test]
fn a_blocked_start_starts_no_backend() {
    // Acceptance criterion 4: the start is refused before a binary is looked for or downloaded.
    let fixture = Fixture::new();
    fixture.write("{broken");
    let launch = fixture.launch(Vec::new());
    assert!(launch.blocked().is_some());
    let cfg = crate::backend::BackendConfig::new(None).with_env(launch.backend_env());
    let log = Arc::new(crate::desktop_log::DesktopLog::none());
    let err = crate::backend::Backend::start(&cfg, &log).err().unwrap();
    assert_eq!(err, crate::backend::BLOCKED);
    let supervisor = crate::backend::Supervisor::spawn(cfg, log);
    assert_eq!(supervisor.start().unwrap_err(), crate::backend::BLOCKED);
    assert_eq!(supervisor.start().unwrap_err(), crate::backend::BLOCKED, "the app's restart does not start one either");
    supervisor.stop();
}

#[test]
fn switching_to_system_default_keeps_what_can_be_read() {
    // Regression row 43.
    let fixture = Fixture::new();
    fixture.write(r#"{"mode":"explicit","type":"socks5","host":"proxy.example","port":70000,"username":"morph","hasPassword":true}"#);
    fixture.store.put(Some("s3cret"));
    let launch = fixture.launch(Vec::new());
    assert!(launch.blocked().is_some());
    launch.switch_to_system().unwrap();
    assert!(launch.blocked().is_some(), "this run stays blocked: the switch applies when the app is reopened");

    let reopened = fixture.launch(Vec::new());
    assert_eq!(reopened.state, State::System);
    let saved = &reopened.view()["saved"];
    assert_eq!(saved["mode"], "system");
    assert_eq!(saved["type"], "socks5");
    assert_eq!(saved["host"], "proxy.example");
    assert_eq!(saved["port"], Value::Null, "the port that could not be read is gone");
    assert_eq!(saved["username"], "morph");
    assert_eq!(saved["hasPassword"], true);
    assert_eq!(fixture.store.stored().as_deref(), Some("s3cret"), "the stored password stays");

    // A file that is not JSON at all becomes a plain System default.
    fixture.write("{broken");
    fixture.launch(Vec::new()).switch_to_system().unwrap();
    assert_eq!(fixture.launch(Vec::new()).state, State::System);
    assert_eq!(fixture.launch(Vec::new()).view()["saved"]["host"], "");
}

/* ---------- saving ---------- */

#[test]
fn saves_the_password_in_the_credential_store_only() {
    // Regression row 10.
    let fixture = Fixture::new();
    let launch = fixture.launch(Vec::new());
    let answer = save_answer(&launch, request("explicit", "http", "Proxy.Example", json!("8080"), "morph", Some("S3ntinel p@ss")));
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(fixture.store.stored().as_deref(), Some("S3ntinel p@ss"));
    let file = fixture.file();
    assert!(!file.contains("S3ntinel") && !file.contains("password\""), "{file}");
    assert_eq!(
        serde_json::from_str::<Value>(&file).unwrap(),
        json!({ "mode": "explicit", "type": "http", "host": "proxy.example", "port": 8080, "username": "morph", "hasPassword": true })
    );
    // The Console never receives the password.
    assert!(!answer.to_string().contains("S3ntinel"));
    assert!(!launch.view().to_string().contains("S3ntinel"));
    assert_eq!(answer["saved"]["hasPassword"], true);
    assert_eq!(answer["credentialStore"], true);

    // Without a credential store the save fails and nothing is written.
    let fixture = Fixture::new();
    fixture.store.set_unavailable(true);
    let launch = fixture.launch(Vec::new());
    assert_eq!(launch.view()["credentialStore"], false);
    let answer = save_answer(&launch, request("explicit", "http", "proxy.example", json!(8080), "morph", Some("S3ntinel p@ss")));
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["error"], "credential_store");
    assert!(!answer.to_string().contains("S3ntinel"), "{answer}");
    assert!(!fixture.path.exists());
    assert_eq!(fixture.store.stored(), None);
    // A proxy without a password saves as usual.
    let answer = save_answer(&launch, request("explicit", "http", "proxy.example", json!(8080), "", None));
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["saved"]["hasPassword"], false);
}

#[test]
fn saving_changes_the_file_and_nothing_else() {
    // Acceptance criteria 5 and 6, regression rows 36 to 39.
    let fixture = Fixture::new();
    let inherited = env(&[("PATH", "/bin"), ("HTTP_PROXY", "http://corp:3128"), ("NO_PROXY", "example.com")]);
    let launch = fixture.launch(inherited.clone());
    let before = (launch.state.clone(), launch.backend_env(), process_env(&launch.state, &launch.inherited));

    let answer = save_answer(&launch, request("explicit", "socks5", "10.0.0.2", json!(1080), "morph", Some("s3cret")));
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["pending"], true, "it applies after a quit and reopen");
    assert_eq!(answer["running"], json!({ "mode": "system" }));
    // The running route is what the launch decided: a restart of the backend gets the same.
    assert_eq!((launch.state.clone(), launch.backend_env(), process_env(&launch.state, &launch.inherited)), before);

    // Reopened: the new setting runs and nothing is pending.
    let reopened = fixture.launch(inherited.clone());
    assert_eq!(reopened.running_label().as_deref(), Some("SOCKS5 10.0.0.2:1080"));
    let view = reopened.view();
    assert_eq!(view["pending"], false);
    assert_eq!(view["running"], json!({ "mode": "explicit", "type": "socks5", "host": "10.0.0.2", "port": 1080, "username": "morph" }));
    let backend = reopened.backend_env().unwrap();
    assert_eq!(get(&backend, "HTTP_PROXY"), Some("socks5://morph:s3cret@10.0.0.2:1080"));
    assert_eq!(get(&backend, "NO_PROXY"), Some(BYPASS));

    // A change is pending; saving the running values again clears it.
    let keep = || request("explicit", "socks5", "10.0.0.2", json!(1080), "morph", None);
    assert_eq!(save_answer(&reopened, request("explicit", "socks5", "10.0.0.3", json!(1080), "morph", None))["pending"], true);
    assert_eq!(save_answer(&reopened, keep())["pending"], false);
    assert_eq!(fixture.store.stored().as_deref(), Some("s3cret"), "an untouched password is kept");
    // So is a new password, until the running one is typed again.
    assert_eq!(save_answer(&reopened, request("explicit", "socks5", "10.0.0.2", json!(1080), "morph", Some("other")))["pending"], true);
    assert_eq!(save_answer(&reopened, keep())["pending"], true);
    assert_eq!(save_answer(&reopened, request("explicit", "socks5", "10.0.0.2", json!(1080), "morph", Some("s3cret")))["pending"], false);

    // Back to System default: the fields and the stored password stay.
    let answer = save_answer(&reopened, json!({ "mode": "system" }));
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["pending"], true);
    assert_eq!(answer["saved"], json!({ "mode": "system", "type": "socks5", "host": "10.0.0.2", "port": 1080, "username": "morph", "hasPassword": true }));
    assert_eq!(fixture.store.stored().as_deref(), Some("s3cret"));
    // Reopened: byte for byte what the app inherited.
    let system = fixture.launch(inherited.clone());
    assert_eq!(system.state, State::System);
    assert_eq!(system.backend_env(), Some(inherited.clone()));
    assert_eq!(system.view()["pending"], false);

    // Clearing removes the stored password.
    let mut clear = json!({ "mode": "system" });
    clear["clearPassword"] = json!(true);
    let answer = save_answer(&system, clear);
    assert_eq!(answer["saved"]["hasPassword"], false);
    assert_eq!(fixture.store.stored(), None);
}

#[test]
fn clears_and_checks_the_stored_password() {
    let fixture = Fixture::new();
    let launch = fixture.launch(Vec::new());
    assert_eq!(save_answer(&launch, request("explicit", "http", "proxy.example", json!(8080), "morph", Some("s3cret")))["ok"], true);
    let running = fixture.launch(Vec::new());

    // The user name goes, the stored password would stay: refused on the password.
    let answer = save_answer(&running, request("explicit", "http", "proxy.example", json!(8080), "", None));
    assert_eq!(answer["fields"]["password"], "password_without_username");

    // Cleared in an explicit setting.
    let mut clear = request("explicit", "http", "proxy.example", json!(8080), "morph", None);
    clear["clearPassword"] = json!(true);
    let answer = save_answer(&running, clear);
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["saved"]["hasPassword"], false);
    assert_eq!(answer["pending"], true, "the running proxy still has its password");
    assert_eq!(fixture.store.stored(), None);
    assert!(matches!(fixture.launch(Vec::new()).state, State::Explicit(Explicit { password: None, .. })));

    // A password the file names and the store lost cannot be kept: the next start would block.
    assert_eq!(save_answer(&running, request("explicit", "http", "proxy.example", json!(8080), "morph", Some("again")))["ok"], true);
    fixture.store.put(None);
    let answer = save_answer(&running, request("explicit", "http", "proxy.example", json!(8081), "morph", None));
    assert_eq!(answer["fields"]["password"], "password_missing");
    assert!(fixture.file().contains("8080"), "nothing was saved");

    // A request that is not one.
    assert_eq!(save_answer(&running, json!({ "mode": "direct" }))["error"], "request");
}

/* ---------- routing, in a child process ---------- */

const CHILD_ENV: &str = "MISTERMORPH_TEST_PROXY_CHILD";

/// A server that answers every request `200 ok` and counts the connections it got.
struct Target {
    addr: String,
    hits: Arc<AtomicUsize>,
}

fn target(host: &str) -> Option<Target> {
    let listener = TcpListener::bind((host, 0)).ok()?;
    let addr = listener.local_addr().unwrap();
    let addr = if addr.is_ipv6() { format!("[{}]:{}", addr.ip(), addr.port()) } else { addr.to_string() };
    let hits = Arc::new(AtomicUsize::new(0));
    let count = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            count.fetch_add(1, Ordering::SeqCst);
            std::thread::spawn(move || {
                if read_head(&mut stream).is_some() {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                }
            });
        }
    });
    Some(Target { addr, hits })
}

/// An address of this machine that is not loopback: a target on it answers a direct connection.
fn outside_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // No packet is sent: connecting a UDP socket only picks the local address.
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

fn read_head(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).ok()? == 0 || head.len() > 16 << 10 {
            return None;
        }
        head.push(byte[0]);
    }
    String::from_utf8(head).ok()
}

fn pipe(a: TcpStream, b: TcpStream) {
    let (mut a2, mut b2) = (a.try_clone().unwrap(), b.try_clone().unwrap());
    let (mut a, mut b) = (a, b);
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut a, &mut b);
        let _ = b.shutdown(std::net::Shutdown::Both);
    });
    let _ = std::io::copy(&mut b2, &mut a2);
    let _ = a2.shutdown(std::net::Shutdown::Both);
}

/// What a fake proxy was asked for: `CONNECT host:port` lines for HTTP, `<atyp> host:port` for
/// SOCKS5, and the credentials each request carried (`user:password`).
#[derive(Default)]
struct Seen {
    requests: Vec<String>,
    credentials: Vec<String>,
}

struct FakeProxy {
    addr: String,
    seen: Arc<Mutex<Seen>>,
}

impl FakeProxy {
    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().requests.clone()
    }
    fn credentials(&self) -> Vec<String> {
        self.seen.lock().unwrap().credentials.clone()
    }
}

/// An HTTP proxy on loopback: tunnels to `forward` when it is set, answers 502 otherwise.
fn http_proxy(forward: Option<String>) -> FakeProxy {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let record = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let (record, forward) = (record.clone(), forward.clone());
            std::thread::spawn(move || {
                let Some(head) = read_head(&mut stream) else { return };
                {
                    let mut seen = record.lock().unwrap();
                    let line = head.lines().next().unwrap_or("");
                    seen.requests.push(line.trim_end_matches(" HTTP/1.1").to_owned());
                    for header in head.lines() {
                        if let Some(value) = header.strip_prefix("proxy-authorization: Basic ").or_else(|| header.strip_prefix("Proxy-Authorization: Basic ")) {
                            let raw = base64::engine::general_purpose::STANDARD.decode(value.trim()).unwrap_or_default();
                            seen.credentials.push(String::from_utf8_lossy(&raw).into_owned());
                        }
                    }
                }
                match forward.and_then(|addr| TcpStream::connect(addr).ok()) {
                    Some(upstream) => {
                        let _ = stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
                        pipe(stream, upstream);
                    }
                    None => {
                        let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            });
        }
    });
    FakeProxy { addr, seen }
}

/// A SOCKS5 proxy on loopback: connects to `forward` when it is set, answers a failure otherwise.
fn socks_proxy(forward: Option<String>, need_auth: bool) -> FakeProxy {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let record = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let (record, forward) = (record.clone(), forward.clone());
            std::thread::spawn(move || socks_serve(stream, record, forward, need_auth));
        }
    });
    FakeProxy { addr, seen }
}

fn socks_serve(mut stream: TcpStream, record: Arc<Mutex<Seen>>, forward: Option<String>, need_auth: bool) -> Option<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut take = |n: usize| -> Option<Vec<u8>> {
        let mut buf = vec![0u8; n];
        stream.read_exact(&mut buf).ok()?;
        Some(buf)
    };
    let greeting = take(2)?;
    let methods = take(greeting[1] as usize)?;
    let method = if need_auth { 2u8 } else { 0u8 };
    if greeting[0] != 5 || !methods.contains(&method) {
        let _ = stream.write_all(&[5, 0xff]);
        return None;
    }
    stream.write_all(&[5, method]).ok()?;
    let mut take = |n: usize| -> Option<Vec<u8>> {
        let mut buf = vec![0u8; n];
        stream.read_exact(&mut buf).ok()?;
        Some(buf)
    };
    let mut credentials = None;
    if method == 2 {
        let head = take(2)?;
        let user = take(head[1] as usize)?;
        let size = take(1)?;
        let pass = take(size[0] as usize)?;
        credentials = Some(format!("{}:{}", String::from_utf8_lossy(&user), String::from_utf8_lossy(&pass)));
    }
    if credentials.is_some() {
        stream.write_all(&[1, 0]).ok()?;
    }
    let mut take = |n: usize| -> Option<Vec<u8>> {
        let mut buf = vec![0u8; n];
        stream.read_exact(&mut buf).ok()?;
        Some(buf)
    };
    let command = take(4)?;
    let host = match command[3] {
        1 => {
            let raw = take(4)?;
            std::net::Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]).to_string()
        }
        3 => {
            let size = take(1)?;
            String::from_utf8_lossy(&take(size[0] as usize)?).into_owned()
        }
        4 => {
            let raw: [u8; 16] = take(16)?.try_into().ok()?;
            std::net::Ipv6Addr::from(raw).to_string()
        }
        _ => return None,
    };
    let port = take(2)?;
    let port = u16::from_be_bytes([port[0], port[1]]);
    {
        let mut seen = record.lock().unwrap();
        seen.requests.push(format!("atyp{} {host}:{port}", command[3]));
        seen.credentials.extend(credentials);
    }
    match forward.and_then(|addr| TcpStream::connect(addr).ok()) {
        Some(upstream) => {
            stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).ok()?;
            pipe(stream, upstream);
        }
        None => {
            let _ = stream.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
        }
    }
    Some(())
}

fn closed_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().to_string()
}

/// Runs the child with the inherited environment plus what the launch sets for the process, and
/// returns its results. `urls` are `key=url`; a key starting with `nsh:` uses an agent built as
/// nsh builds its own (the proxy of the environment), the others the shell's `agent_for`.
fn run_child(state: &State, inherited: &Env, urls: &[(&str, String)]) -> BTreeMap<String, String> {
    let mut vars: BTreeMap<OsString, OsString> = inherited.iter().cloned().collect();
    for (name, value) in process_env(state, inherited) {
        vars.insert(name.into(), value.into());
    }
    let list: Vec<String> = urls.iter().map(|(key, url)| format!("{key}={url}")).collect();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "proxy::tests::routing_child", "--nocapture", "--test-threads=1"])
        .env_clear()
        .envs(vars)
        .env(CHILD_ENV, list.join(";"))
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(output.status.success(), "child failed: {text}\n{}", String::from_utf8_lossy(&output.stderr));
    text.lines()
        // libtest writes "test <name> ... " in front of the first line.
        .filter_map(|line| line.split_once("RESULT ").map(|(_, rest)| rest.trim()))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

/// The child: requests each URL and prints the status or the error. It does nothing by itself.
#[test]
fn routing_child() {
    let Ok(list) = std::env::var(CHILD_ENV) else {
        return;
    };
    for item in list.split(';').filter(|item| !item.is_empty()) {
        let (key, url) = item.split_once('=').unwrap();
        let timeout = Some(Duration::from_secs(5));
        let agent: ureq::Agent = if key.starts_with("nsh:") {
            // nsh-engine's fetch agent and nsh-core's image loader: the default proxy, from the
            // environment (net.rs, image/loader.rs).
            ureq::Agent::config_builder().http_status_as_error(false).timeout_global(timeout).build().into()
        } else {
            crate::http::agent_for(url, timeout)
        };
        let result = match agent.get(url).call() {
            Ok(response) => response.status().as_u16().to_string(),
            Err(err) => format!("error: {err}"),
        };
        println!("RESULT {key}={result}");
    }
}

fn base_env() -> Env {
    env(&[("PATH", &std::env::var("PATH").unwrap_or_default())])
}

fn explicit_at(kind: Kind, addr: &str, username: &str, password: Option<&str>) -> State {
    let (host, port) = addr.rsplit_once(':').unwrap();
    State::Explicit(Explicit { kind, host: host.into(), port: port.parse().unwrap(), username: username.into(), password: password.map(str::to_owned) })
}

const USER: &str = "mo rph@x";
const PASS: &str = "p@ss:w%rd 1";

#[test]
fn explicit_http_proxy_routes_names_and_never_loopback() {
    // Regression rows 5, 11 to 13, 19 and 20.
    let web = target("127.0.0.1").unwrap();
    let local = target("127.0.0.1").unwrap();
    let local6 = target("::1");
    let proxy = http_proxy(Some(web.addr.clone()));
    let state = explicit_at(Kind::Http, &proxy.addr, USER, Some(PASS));
    // Inherited proxy variables pointing elsewhere, and a bypass list that would bypass everything.
    let mut inherited = base_env();
    inherited.extend(env(&[
        ("http_proxy", "http://127.0.0.1:9"),
        ("HTTPS_PROXY", "http://127.0.0.1:9"),
        ("all_proxy", "socks5://127.0.0.1:9"),
        ("NO_PROXY", "*"),
        ("no_proxy", "plain.invalid"),
    ]));
    let port = local.addr.rsplit_once(':').unwrap().1;
    let mut urls = vec![
        ("name", "http://plain.invalid/page".to_owned()),
        ("nsh:name", "http://image.invalid/a.png".to_owned()),
        ("loop4", format!("http://{}/health", local.addr)),
        ("loopname", format!("http://localhost:{port}/health")),
        ("nsh:loop4", format!("http://{}/api", local.addr)),
        ("nsh:loopname", format!("http://localhost:{port}/api")),
    ];
    if let Some(local6) = &local6 {
        urls.push(("loop6", format!("http://{}/health", local6.addr)));
        urls.push(("nsh:loop6", format!("http://{}/api", local6.addr)));
    }
    let got = run_child(&state, &inherited, &urls);
    for (key, _) in &urls {
        assert_eq!(got.get(*key).map(String::as_str), Some("200"), "{key}: {got:?}");
    }
    // ureq tunnels plain http too: the proxy is asked for the name, which is not resolved here.
    assert_eq!(proxy.requests(), ["CONNECT plain.invalid:80", "CONNECT image.invalid:80"]);
    assert_eq!(proxy.credentials(), [format!("{USER}:{PASS}"), format!("{USER}:{PASS}")]);
    assert_eq!(web.hits.load(Ordering::SeqCst), 2);
    assert_eq!(local.hits.load(Ordering::SeqCst), 4, "the loopback requests went direct");
    if let Some(local6) = &local6 {
        assert_eq!(local6.hits.load(Ordering::SeqCst), 2);
    }
}

#[test]
fn explicit_socks5_proxy_resolves_names_at_the_proxy() {
    // Regression rows 4, 6 and 12.
    let web = target("127.0.0.1").unwrap();
    let local = target("127.0.0.1").unwrap();
    let proxy = socks_proxy(Some(web.addr.clone()), true);
    let state = explicit_at(Kind::Socks5, &proxy.addr, USER, Some(PASS));
    let urls = [
        ("name", "http://does-not-resolve.invalid/page".to_owned()),
        ("nsh:name", "http://image.invalid/a.png".to_owned()),
        ("loop4", format!("http://{}/health", local.addr)),
        ("nsh:loop4", format!("http://{}/api", local.addr)),
    ];
    let got = run_child(&state, &base_env(), &urls);
    for (key, _) in &urls {
        assert_eq!(got.get(*key).map(String::as_str), Some("200"), "{key}: {got:?}");
    }
    // ATYP 3: the domain name, not an address; no local lookup error.
    assert_eq!(proxy.requests(), ["atyp3 does-not-resolve.invalid:80", "atyp3 image.invalid:80"]);
    assert_eq!(proxy.credentials(), [format!("{USER}:{PASS}"), format!("{USER}:{PASS}")]);
    assert_eq!(local.hits.load(Ordering::SeqCst), 2);
}

#[test]
fn a_proxy_that_cannot_be_used_is_never_bypassed() {
    // Regression rows 21, 22 and 34: an error, and the target records no connection.
    let Some(outside) = outside_address() else {
        eprintln!("skipped: this machine has no address that is not loopback");
        return;
    };
    let cases: Vec<(&str, State)> = vec![
        ("dead http", explicit_at(Kind::Http, &closed_port(), "", None)),
        ("dead socks5", explicit_at(Kind::Socks5, &closed_port(), "", None)),
        ("refusing http", explicit_at(Kind::Http, &http_proxy(None).addr, "", None)),
        ("refusing socks5", explicit_at(Kind::Socks5, &socks_proxy(None, false).addr, "", None)),
    ];
    for (name, state) in cases {
        let web = target(&outside).unwrap();
        let urls = [("shell", format!("http://{}/update", web.addr)), ("nsh:fetch", format!("http://{}/SKILL.md", web.addr))];
        let got = run_child(&state, &base_env(), &urls);
        for (key, _) in &urls {
            let result = got.get(*key).map(String::as_str).unwrap_or("");
            assert!(result.starts_with("error: ") || result == "502", "{name} {key}: {result}");
            for secret in [PASS, "p%40ss"] {
                assert!(!result.contains(secret));
            }
        }
        assert_eq!(web.hits.load(Ordering::SeqCst), 0, "{name}: the target was reached without the proxy");
    }
}

#[test]
fn system_default_honors_an_inherited_socks_proxy() {
    // Regression rows 19 and 23: used, or an error; never a direct connection. Loopback requests
    // stay direct although the inherited bypass list does not name them.
    let Some(outside) = outside_address() else {
        eprintln!("skipped: this machine has no address that is not loopback");
        return;
    };
    let web = target(&outside).unwrap();
    let local = target("127.0.0.1").unwrap();
    let proxy = socks_proxy(Some(web.addr.clone()), false);
    let mut inherited = base_env();
    inherited.extend(env(&[("ALL_PROXY", &format!("socks5://{}", proxy.addr)), ("NO_PROXY", "example.com")]));
    let urls = [
        ("shell", format!("http://{}/update", web.addr)),
        ("nsh:fetch", format!("http://{}/SKILL.md", web.addr)),
        ("loop4", format!("http://{}/health", local.addr)),
        ("nsh:loop4", format!("http://{}/api", local.addr)),
    ];
    let got = run_child(&State::System, &inherited, &urls);
    for (key, _) in &urls {
        assert_eq!(got.get(*key).map(String::as_str), Some("200"), "{key}: {got:?}");
    }
    assert_eq!(proxy.requests().len(), 2, "{:?}", proxy.requests());
    assert!(proxy.requests().iter().all(|request| request.starts_with("atyp1 ")), "socks5:// resolves here");
    assert_eq!(local.hits.load(Ordering::SeqCst), 2);

    // The same variables with the proxy gone.
    let web = target(&outside).unwrap();
    let mut inherited = base_env();
    inherited.extend(env(&[("ALL_PROXY", &format!("socks5://{}", closed_port()))]));
    let urls = [("shell", format!("http://{}/update", web.addr)), ("nsh:fetch", format!("http://{}/SKILL.md", web.addr))];
    let got = run_child(&State::System, &inherited, &urls);
    for (key, _) in &urls {
        assert!(got.get(*key).is_some_and(|result| result.starts_with("error: ")), "{key}: {got:?}");
    }
    assert_eq!(web.hits.load(Ordering::SeqCst), 0);
}
