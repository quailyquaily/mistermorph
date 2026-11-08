//! The backend the app talks to: the bundled `morph` binary running `console serve` on a random
//! loopback port, as the Wails app did.
use std::{
    io::Read,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use crate::desktop_log::DesktopLog;

pub const BACKEND_BIN_ENV: &str = "MISTERMORPH_DESKTOP_BACKEND_BIN";
pub const AUTO_DOWNLOAD_ENV: &str = "MISTERMORPH_DESKTOP_BACKEND_AUTO_DOWNLOAD";
pub const BACKEND_VERSION_ENV: &str = "MISTERMORPH_DESKTOP_BACKEND_VERSION";
const APP_DIR_ENV: &str = "APPDIR";

pub const DEFAULT_BASE_PATH: &str = "/";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
const HEALTH_INTERVAL: Duration = Duration::from_millis(350);

#[derive(Debug, Clone)]
pub struct BackendConfig {
    /// Forwarded as `--config` to `console serve`.
    pub config_path: Option<PathBuf>,
    pub base_path: String,
    pub startup_timeout: Duration,
    pub health_interval: Duration,
}

impl BackendConfig {
    pub fn new(config_path: Option<PathBuf>) -> BackendConfig {
        BackendConfig {
            config_path,
            base_path: DEFAULT_BASE_PATH.to_owned(),
            startup_timeout: STARTUP_TIMEOUT,
            health_interval: HEALTH_INTERVAL,
        }
    }
}

/// A running backend.
pub struct Backend {
    child: Child,
    /// `127.0.0.1:<port>`.
    pub addr: String,
}

impl Backend {
    /// Finds the binary, starts `console serve` and waits until `/health` answers.
    pub fn start(cfg: &BackendConfig, log: &Arc<DesktopLog>) -> Result<Backend, String> {
        let addr = reserve_loopback_addr()?;
        let exe = std::env::current_exe().map_err(|e| format!("resolve executable path: {e}"))?;
        let binary = resolve_launcher(&exe, log)?;
        let args = serve_args(cfg, &addr);
        log.line(&format!("desktop host launching backend: {} {}", binary.display(), args.join(" ")));
        let mut command = Command::new(&binary);
        command
            .args(&args)
            .env_clear()
            .envs(child_env(std::env::vars().collect()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Ok(dir) = std::env::current_dir() {
            command.current_dir(dir);
        }
        apply_child_attrs(&mut command);
        let mut child = command.spawn().map_err(|e| format!("start desktop console host: {e}"))?;
        pipe_output(child.stdout.take(), false, log);
        pipe_output(child.stderr.take(), true, log);
        let mut backend = Backend { child, addr };
        if let Err(err) = backend.wait_until_ready(cfg) {
            backend.stop();
            return Err(err);
        }
        Ok(backend)
    }

    fn wait_until_ready(&mut self, cfg: &BackendConfig) -> Result<(), String> {
        let deadline = Instant::now() + cfg.startup_timeout;
        let health = format!("http://{}/health", self.addr);
        let agent = crate::http::agent(Some(Duration::from_secs(2)));
        loop {
            if Instant::now() >= deadline {
                return Err(format!(
                    "desktop console host did not become ready before timeout ({}s)",
                    cfg.startup_timeout.as_secs()
                ));
            }
            std::thread::sleep(cfg.health_interval);
            match self.child.try_wait() {
                Ok(Some(status)) if status.success() => {
                    return Err("desktop console host exited before readiness".to_owned());
                }
                Ok(Some(status)) => {
                    return Err(format!("desktop console host exited before readiness: {}", exit_text(status)));
                }
                _ => {}
            }
            if let Ok(response) = agent.get(&health).call()
                && response.status().as_u16() == 200
            {
                return Ok(());
            }
        }
    }

    /// Interrupts the backend, and kills it when it has not stopped 4 seconds later.
    pub fn stop(mut self) {
        let pid = self.child.id();
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGINT);
        }
        #[cfg(not(unix))]
        let _ = pid;
        if !cfg!(unix) || !wait_for(&mut self.child, Duration::from_secs(4)) {
            let _ = self.child.kill();
            wait_for(&mut self.child, Duration::from_secs(2));
        }
    }
}

fn wait_for(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// `exit status 2` / `signal: 9`, as Go prints an `*exec.ExitError`.
fn exit_text(status: std::process::ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exit status {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return format!("signal: {signal}");
        }
    }
    status.to_string()
}

/// The backend's output goes to the terminal and the desktop log.
fn pipe_output(stream: Option<impl Read + Send + 'static>, stderr: bool, log: &Arc<DesktopLog>) {
    let Some(mut stream) = stream else {
        return;
    };
    let log = log.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => log.output(&buf[..n], stderr),
            }
        }
    });
}

#[cfg(target_os = "linux")]
fn apply_child_attrs(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // The backend goes when the app goes, however it goes. The supervisor thread that spawns it
    // lives as long as the app (the signal follows the thread that forked).
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
}

#[cfg(windows)]
fn apply_child_attrs(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(target_os = "linux", windows)))]
fn apply_child_attrs(_command: &mut Command) {}

pub fn serve_args(cfg: &BackendConfig, addr: &str) -> Vec<String> {
    let mut args = vec![
        "console".to_owned(),
        "serve".to_owned(),
        "--console-listen".to_owned(),
        addr.to_owned(),
        "--console-base-path".to_owned(),
        normalize_base_path(&cfg.base_path),
    ];
    if let Some(path) = &cfg.config_path {
        args.push("--config".to_owned());
        args.push(path.display().to_string());
    }
    args
}

pub fn normalize_base_path(raw: &str) -> String {
    let base = raw.trim();
    if base.is_empty() {
        return DEFAULT_BASE_PATH.to_owned();
    }
    let base = if base.starts_with('/') { base.to_owned() } else { format!("/{base}") };
    let base = base.trim_end_matches('/');
    if base.is_empty() { DEFAULT_BASE_PATH.to_owned() } else { base.to_owned() }
}

/// The app's environment; inside an AppImage without the loader state the AppImage runtime set.
pub fn child_env(base: Vec<(String, String)>) -> Vec<(String, String)> {
    let in_appimage = base.iter().any(|(k, _)| k == "APPDIR" || k == "APPIMAGE");
    if !in_appimage {
        return base;
    }
    const BLOCKED: [&str; 7] = ["APPDIR", "APPIMAGE", "APPDIR_EXEC_PATH", "ARGV0", "OWD", "LD_LIBRARY_PATH", "LD_PRELOAD"];
    base.into_iter().filter(|(k, _)| !BLOCKED.contains(&k.as_str())).collect()
}

/// A free loopback address (`127.0.0.1:<port>`): bound, read and released for the backend.
pub fn reserve_loopback_addr() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("reserve loopback listen addr: {e}"))?;
    let addr = listener.local_addr().map_err(|e| format!("reserve loopback listen addr: {e}"))?;
    Ok(addr.to_string())
}

/* ---------- the backend binary ---------- */

fn resolve_launcher(exe: &Path, log: &DesktopLog) -> Result<PathBuf, String> {
    let explicit = std::env::var(BACKEND_BIN_ENV).ok();
    for candidate in backend_candidates(exe, explicit.as_deref()) {
        if same_path(&candidate, exe) || !is_executable(&candidate) {
            continue;
        }
        return Ok(candidate);
    }
    if auto_download_enabled() {
        match download_backend(&backend_version()) {
            Ok(path) if is_executable(&path) => return Ok(path),
            Ok(_) => {}
            Err(err) => log.line(&format!("warning: download mistermorph backend failed: {err}")),
        }
    }
    Err(format!(
        "cannot find runnable mistermorph backend binary; set {BACKEND_BIN_ENV} or place {} next to the desktop app",
        binary_name()
    ))
}

/// Where the backend may be, best first.
pub fn backend_candidates(exe: &Path, explicit: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |raw: PathBuf| {
        if raw.as_os_str().is_empty() {
            return;
        }
        let clean = normalize_path(&raw);
        if !out.contains(&clean) {
            out.push(clean);
        }
    };
    if let Some(explicit) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        add(PathBuf::from(explicit));
    }
    let add_dir = |add: &mut dyn FnMut(PathBuf), dir: &Path| {
        for name in candidate_names() {
            add(dir.join(name));
        }
    };
    if let Ok(app_dir) = std::env::var(APP_DIR_ENV)
        && !app_dir.trim().is_empty()
    {
        let app_dir = PathBuf::from(app_dir.trim());
        add_dir(&mut add, &app_dir.join("usr").join("bin"));
        add_dir(&mut add, &app_dir);
    }
    if let Some(exe_dir) = exe.parent() {
        add_dir(&mut add, exe_dir);
        if search_child_bin(exe_dir) {
            add_dir(&mut add, &exe_dir.join("bin"));
        }
    }
    if let Ok(wd) = std::env::current_dir() {
        add_dir(&mut add, &wd.join("bin"));
    }
    if let Some(path) = look_path(binary_name()) {
        add(path);
    }
    out
}

fn search_child_bin(exe_dir: &Path) -> bool {
    let base = exe_dir.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    !matches!(base.as_str(), "bin" | "macos")
}

pub fn binary_name() -> &'static str {
    if cfg!(windows) { "morph.exe" } else { "morph" }
}

/// `morph`, then the legacy names.
fn candidate_names() -> Vec<String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let mut names = vec![binary_name().to_owned()];
    if !cfg!(target_os = "linux") {
        names.push(format!("mistermorphc{ext}"));
    }
    names.push(format!("mistermorph{ext}"));
    names.push(format!("mistermorph-backend{ext}"));
    names
}

fn look_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|dir| dir.join(name)).find(|p| is_executable(p))
}

/// Symlinks resolved, also below a part that does not exist yet.
fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return resolved;
    }
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_owned());
                existing = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
    let mut out = existing.canonicalize().unwrap_or(existing);
    for part in rest.iter().rev() {
        out.push(part);
    }
    out
}

fn same_path(a: &Path, b: &Path) -> bool {
    normalize_path(a) == normalize_path(b)
}

pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

fn auto_download_enabled() -> bool {
    std::env::var(AUTO_DOWNLOAD_ENV)
        .ok()
        .and_then(|v| crate::config::parse_go_bool(&v))
        .unwrap_or(true)
}

fn backend_version() -> String {
    match std::env::var(BACKEND_VERSION_ENV) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_owned(),
        _ => "latest".to_owned(),
    }
}

#[derive(serde::Deserialize, Default)]
struct ReleaseIndex {
    #[serde(default)]
    latest: String,
}

#[derive(serde::Deserialize, Default)]
struct Release {
    #[serde(default)]
    tag: String,
    #[serde(default)]
    files: Vec<ReleaseFile>,
}

#[derive(serde::Deserialize, Default, Clone, Debug, PartialEq)]
pub struct ReleaseFile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
}

fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let agent = crate::http::agent(Some(Duration::from_secs(60)));
    let mut response = agent.get(url).header("Accept", "application/json").call().map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("http status {status}"));
    }
    let body = response.body_mut().with_config().limit(4 << 20).read_to_vec().map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

/// A backend from the release server, of the channel the app was built for.
fn download_backend(version: &str) -> Result<PathBuf, String> {
    use crate::update::{BUILD_CHANNEL, DEFAULT_BASE_URL, go_arch, go_os, sanitize_tag};
    let base = format!("{DEFAULT_BASE_URL}/{BUILD_CHANNEL}");
    let mut tag = version.trim().to_owned();
    if tag.is_empty() || tag.eq_ignore_ascii_case("latest") {
        let index: ReleaseIndex = fetch_json(&format!("{base}/releases/index.json"))
            .map_err(|e| format!("fetch {BUILD_CHANNEL} release index: {e}"))?;
        if index.latest.trim().is_empty() {
            return Err(format!("{BUILD_CHANNEL} release index has no stable release"));
        }
        tag = index.latest;
    } else if !tag.starts_with('v') {
        tag = format!("v{tag}");
    }
    let release: Release = fetch_json(&format!("{base}/releases/{}/release.json", url_escape(&tag)))
        .map_err(|e| format!("fetch {BUILD_CHANNEL} release {tag}: {e}"))?;
    let (goos, goarch) = (go_os(), go_arch());
    let asset = pick_release_asset(&release.files, &goos, &goarch)?;
    let cache = crate::paths::backend_cache_dir().ok_or("resolve cache dir: no cache directory")?;
    let tag = if release.tag.trim().is_empty() { "latest".to_owned() } else { release.tag.trim().to_owned() };
    let mut name = format!("morph-{}-{goos}-{goarch}", sanitize_tag(&tag));
    if cfg!(windows) {
        name.push_str(".exe");
    }
    let dst = cache.join(BUILD_CHANNEL).join(name);
    std::fs::create_dir_all(dst.parent().unwrap()).map_err(|e| format!("create cache dir: {e}"))?;
    if is_executable(&dst) {
        return Ok(dst);
    }
    let archive = dst.parent().unwrap().join(&asset.name);
    crate::update::download_file(&archive, &asset.url, &[]).map_err(|e| format!("download asset {}: {e}", asset.name))?;
    extract_binary(&archive, &dst, binary_name())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
    }
    Ok(dst)
}

fn url_escape(segment: &str) -> String {
    url::form_urlencoded::byte_serialize(segment.as_bytes()).collect::<String>().replace('+', "%20")
}

pub fn pick_release_asset(assets: &[ReleaseFile], goos: &str, goarch: &str) -> Result<ReleaseFile, String> {
    let suffix = format!("_{goos}_{goarch}");
    assets
        .iter()
        .find(|a| {
            let name = a.name.trim();
            !name.is_empty()
                && !a.url.trim().is_empty()
                && name.contains(&suffix)
                && !name.to_lowercase().contains("checksum")
                && (name.ends_with(".tar.gz") || name.ends_with(".zip"))
        })
        .cloned()
        .ok_or_else(|| format!("no release asset found for {goos}/{goarch}"))
}

fn extract_binary(archive: &Path, dst: &Path, binary: &str) -> Result<(), String> {
    let lower = archive.to_string_lossy().to_lowercase();
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    if lower.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_file() && Path::new(entry.name()).file_name().is_some_and(|n| n == binary) {
                return write_extracted(dst, &mut entry);
            }
        }
        return Err(format!("binary {binary} not found in zip"));
    }
    if lower.ends_with(".tar.gz") {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let is_file = entry.header().entry_type().is_file();
            let matches = entry.path().ok().and_then(|p| p.file_name().map(|n| n == binary)).unwrap_or(false);
            if is_file && matches {
                return write_extracted(dst, &mut entry);
            }
        }
        return Err(format!("binary {binary} not found in tar.gz"));
    }
    Err(format!("unsupported archive format: {}", archive.display()))
}

fn write_extracted(dst: &Path, reader: &mut dyn Read) -> Result<(), String> {
    let mut tmp = dst.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let result = (|| {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(reader, &mut file).map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp, dst).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/* ---------- the supervisor ---------- */

enum Request {
    Start(mpsc::Sender<Result<String, String>>),
    Stop(mpsc::Sender<()>),
}

/// Owns the backend on a thread of its own that lives as long as the app: starts, stops and
/// restarts it on request.
#[derive(Clone)]
pub struct Supervisor {
    tx: mpsc::Sender<Request>,
}

impl Supervisor {
    pub fn spawn(cfg: BackendConfig, log: Arc<DesktopLog>) -> Supervisor {
        let (tx, rx) = mpsc::channel::<Request>();
        std::thread::Builder::new()
            .name("backend".into())
            .spawn(move || {
                let mut running: Option<Backend> = None;
                while let Ok(request) = rx.recv() {
                    match request {
                        Request::Start(reply) => {
                            let result = match &running {
                                Some(backend) => Ok(backend.addr.clone()),
                                None => Backend::start(&cfg, &log).map(|backend| {
                                    let addr = backend.addr.clone();
                                    running = Some(backend);
                                    addr
                                }),
                            };
                            let _ = reply.send(result);
                        }
                        Request::Stop(reply) => {
                            if let Some(backend) = running.take() {
                                backend.stop();
                            }
                            let _ = reply.send(());
                        }
                    }
                }
                if let Some(backend) = running.take() {
                    backend.stop();
                }
            })
            .expect("spawn the backend thread");
        Supervisor { tx }
    }

    /// Starts the backend (or keeps the running one) and waits until it is ready: its address.
    pub fn start(&self) -> Result<String, String> {
        let (tx, rx) = mpsc::channel();
        self.tx.send(Request::Start(tx)).map_err(|_| "the backend thread stopped".to_owned())?;
        rx.recv().map_err(|_| "the backend thread stopped".to_owned())?
    }

    /// Stops the backend and waits until it has stopped.
    pub fn stop(&self) {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Request::Stop(tx)).is_ok() {
            let _ = rx.recv();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_free_loopback_ports() {
        let a = reserve_loopback_addr().unwrap();
        assert!(a.starts_with("127.0.0.1:"), "{a}");
        let port: u16 = a.rsplit(':').next().unwrap().parse().unwrap();
        assert!(port > 0);
        // Released: the backend can bind it.
        TcpListener::bind(&a).unwrap();
    }

    #[test]
    fn builds_serve_args() {
        let mut cfg = BackendConfig::new(None);
        assert_eq!(
            serve_args(&cfg, "127.0.0.1:1"),
            ["console", "serve", "--console-listen", "127.0.0.1:1", "--console-base-path", "/"]
        );
        cfg.config_path = Some(PathBuf::from("/c/config.yaml"));
        cfg.base_path = "console/".into();
        let args = serve_args(&cfg, "127.0.0.1:1");
        assert_eq!(&args[4..], ["--console-base-path", "/console", "--config", "/c/config.yaml"]);
    }

    #[test]
    fn normalizes_base_paths() {
        assert_eq!(normalize_base_path(""), "/");
        assert_eq!(normalize_base_path("///"), "/");
        assert_eq!(normalize_base_path("console"), "/console");
    }

    #[test]
    fn cleans_the_environment_inside_an_appimage() {
        let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let plain = env(&[("PATH", "/bin"), ("LD_LIBRARY_PATH", "/x")]);
        assert_eq!(child_env(plain.clone()), plain);
        let appimage = env(&[("PATH", "/bin"), ("APPIMAGE", "/a"), ("APPDIR", "/d"), ("LD_PRELOAD", "x"), ("HOME", "/h")]);
        assert_eq!(child_env(appimage), env(&[("PATH", "/bin"), ("HOME", "/h")]));
    }

    #[test]
    fn lists_candidates() {
        let exe = Path::new("/opt/mistermorph/MrMorph");
        let list = backend_candidates(exe, Some("/explicit/morph"));
        assert_eq!(list[0], PathBuf::from("/explicit/morph"));
        assert!(list.contains(&PathBuf::from("/opt/mistermorph/morph")));
        assert!(list.contains(&PathBuf::from("/opt/mistermorph/bin/morph")));
        let in_bin = backend_candidates(Path::new("/usr/x/bin/MrMorph"), None);
        assert!(!in_bin.contains(&PathBuf::from("/usr/x/bin/bin/morph")));
    }

    #[test]
    fn picks_release_assets() {
        let files = vec![
            ReleaseFile { name: "mistermorph_checksums.txt".into(), url: "u".into() },
            ReleaseFile { name: "mistermorph_linux_amd64_checksum.tar.gz".into(), url: "u".into() },
            ReleaseFile { name: "mistermorph_0.2.0_linux_amd64.tar.gz".into(), url: "u1".into() },
            ReleaseFile { name: "mistermorph_0.2.0_windows_amd64.zip".into(), url: "u2".into() },
        ];
        assert_eq!(pick_release_asset(&files, "linux", "amd64").unwrap().url, "u1");
        assert_eq!(pick_release_asset(&files, "windows", "amd64").unwrap().url, "u2");
        assert!(pick_release_asset(&files, "darwin", "arm64").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn extracts_from_tar_gz() {
        let dir = std::env::temp_dir().join(format!("morph-extract-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("a.tar.gz");
        {
            let gz = flate2::write::GzEncoder::new(std::fs::File::create(&archive).unwrap(), flate2::Compression::fast());
            let mut builder = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            header.set_size(4);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, "pkg/morph", &b"bin!"[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let dst = dir.join("morph-out");
        extract_binary(&archive, &dst, "morph").unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"bin!");
        assert!(extract_binary(&archive, &dst, "other").unwrap_err().contains("not found"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_backend_that_exits() {
        // A "backend" that exits at once: the start fails with the exit status.
        let dir = std::env::temp_dir().join(format!("morph-fake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("morph");
        std::fs::write(&script, "#!/bin/sh\necho fake backend \"$@\" >&2\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        // SAFETY: tests touching this variable run in this test only.
        unsafe { std::env::set_var(BACKEND_BIN_ENV, &script) };
        let mut cfg = BackendConfig::new(None);
        cfg.health_interval = Duration::from_millis(50);
        let err = Backend::start(&cfg, &Arc::new(DesktopLog::none())).err().unwrap();
        assert_eq!(err, "desktop console host exited before readiness: exit status 3");
        unsafe { std::env::remove_var(BACKEND_BIN_ENV) };
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Restarts a real backend: `MORPH_TEST_BACKEND=/path/to/morph cargo test -- --ignored`.
    /// Run it with an isolated HOME: the backend creates `~/.morph`.
    #[test]
    #[ignore]
    fn restarts_a_real_backend() {
        let Ok(bin) = std::env::var("MORPH_TEST_BACKEND") else {
            return;
        };
        unsafe { std::env::set_var(BACKEND_BIN_ENV, &bin) };
        let supervisor = Supervisor::spawn(BackendConfig::new(None), Arc::new(DesktopLog::none()));
        let health = |addr: &str| {
            crate::http::agent(Some(Duration::from_secs(2)))
                .get(&format!("http://{addr}/health"))
                .call()
                .map(|r| r.status().as_u16())
                .unwrap_or(0)
        };
        let first = supervisor.start().unwrap();
        assert_eq!(health(&first), 200);
        assert_eq!(supervisor.start().unwrap(), first, "a running backend is kept");
        supervisor.stop();
        assert_eq!(health(&first), 0, "stopped");
        let second = supervisor.start().unwrap();
        assert_eq!(health(&second), 200);
        supervisor.stop();
        assert_eq!(health(&second), 0);
    }
}
