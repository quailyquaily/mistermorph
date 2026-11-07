//! The update check of the desktop app: internal/updatecheck and desktop/wails/update.go in Rust.
//! It reads a release channel's `update.json`, compares versions and, with auto update on,
//! downloads and verifies the package into the user cache. It does not install it.
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::AutoUpdate;

pub const CHANNEL_COMMUNITY: &str = "community";
pub const CHANNEL_PRO: &str = "pro";
pub const DEFAULT_BASE_URL: &str = "https://downloads.mistermorph.com";

/// The channel this binary was built for (the `pro` cargo feature, the Go `pro` build tag).
pub const BUILD_CHANNEL: &str = if cfg!(feature = "pro") { CHANNEL_PRO } else { CHANNEL_COMMUNITY };

/// The desktop app's version, set at build time (`MISTERMORPH_DESKTOP_VERSION`), `dev` otherwise.
pub const DESKTOP_VERSION: &str = match option_env!("MISTERMORPH_DESKTOP_VERSION") {
    Some(v) => v,
    None => "dev",
};

pub fn channels() -> [&'static str; 2] {
    [CHANNEL_COMMUNITY, CHANNEL_PRO]
}

/// Lowercased and trimmed; empty means the build channel.
pub fn normalize_channel(channel: &str) -> Result<String, String> {
    let channel = channel.trim().to_lowercase();
    if channel.is_empty() {
        return Ok(BUILD_CHANNEL.to_owned());
    }
    if channels().contains(&channel.as_str()) {
        return Ok(channel);
    }
    Err(format!("unknown release channel {channel:?} (want one of {})", channels().join(", ")))
}

pub fn manifest_url(base_url: &str, channel: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { DEFAULT_BASE_URL } else { base };
    format!("{base}/{channel}/latest/update.json")
}

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub auto_download: bool,
    pub cache_dir: Option<PathBuf>,
    pub current_version: String,
    pub channel: String,
    pub manifest_url: String,
    pub goos: String,
    pub goarch: String,
}

impl Options {
    /// The options of a check with the desktop config (newDesktopUpdateCheckOptions).
    pub fn desktop(cfg: &AutoUpdate) -> Options {
        Options {
            auto_download: cfg.enabled,
            cache_dir: if cfg.enabled { crate::paths::update_cache_dir() } else { None },
            current_version: DESKTOP_VERSION.to_owned(),
            channel: cfg.channel.clone(),
            ..Default::default()
        }
    }
}

pub fn resolve_manifest_url(opts: &Options) -> Result<String, String> {
    if !opts.manifest_url.trim().is_empty() {
        return Ok(opts.manifest_url.trim().to_owned());
    }
    Ok(manifest_url(DEFAULT_BASE_URL, &normalize_channel(&opts.channel)?))
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub release_date: String,
    #[serde(default)]
    pub release_notes: String,
    #[serde(default)]
    pub platforms: HashMap<String, Platform>,
    #[serde(default)]
    pub mandatory: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Platform {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub checksum: String,
}

/// The JSON the Go check returned (`updatecheck.Result`), field for field.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct CheckResult {
    pub status: String,
    pub channel: String,
    pub current_channel: String,
    pub channel_switch: bool,
    pub current_version: String,
    pub latest_version: String,
    pub platform: String,
    pub update_available: bool,
    pub mandatory: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub release_date: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub release_notes: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub asset_url: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub asset_size: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub checksum: String,
    pub downloaded: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub download_status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub download_path: String,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

/// Checks for an update.
pub fn check(opts: &Options) -> Result<CheckResult, String> {
    let channel = normalize_channel(&opts.channel)?;
    let url = resolve_manifest_url(&Options { channel: channel.clone(), ..opts.clone() })?;
    let manifest = match fetch_manifest(&url) {
        Ok(m) => m,
        Err(FetchError::NotFound) => return Err(format!("no {channel} release has been published yet")),
        Err(FetchError::Other(e)) => return Err(e),
    };
    evaluate(opts, &channel, manifest)
}

/// The check after the manifest is fetched.
fn evaluate(opts: &Options, channel: &str, manifest: Manifest) -> Result<CheckResult, String> {
    let goos = if opts.goos.trim().is_empty() { go_os() } else { opts.goos.trim().to_owned() };
    let goarch = if opts.goarch.trim().is_empty() { go_arch() } else { opts.goarch.trim().to_owned() };
    let key = platform_key(&goos, &goarch);
    let platform = manifest
        .platforms
        .get(&key)
        .ok_or_else(|| format!("update manifest has no platform {key:?}"))?;
    if platform.url.trim().is_empty() {
        return Err(format!("update manifest platform {key:?} has empty url"));
    }
    if platform.checksum.trim().is_empty() {
        return Err(format!("update manifest platform {key:?} has empty checksum"));
    }
    let current = normalize_version(&opts.current_version);
    let latest = normalize_version(&manifest.version);
    if latest.is_empty() {
        return Err("update manifest has empty version".to_owned());
    }
    let mut result = CheckResult {
        status: "up_to_date".to_owned(),
        channel: channel.to_owned(),
        current_channel: BUILD_CHANNEL.to_owned(),
        channel_switch: channel != BUILD_CHANNEL,
        current_version: current.clone(),
        latest_version: latest.clone(),
        platform: key.clone(),
        mandatory: manifest.mandatory,
        release_date: manifest.release_date.trim().to_owned(),
        release_notes: manifest.release_notes.clone(),
        asset_url: platform.url.trim().to_owned(),
        asset_size: platform.size,
        checksum: platform.checksum.trim().to_owned(),
        ..Default::default()
    };
    if !result.channel_switch {
        match compare_versions(&current, &latest) {
            None => {
                result.status = "current_version_unknown".to_owned();
                return Ok(result);
            }
            Some(order) if order >= 0 => return Ok(result),
            _ => {}
        }
    }
    result.status = "update_available".to_owned();
    result.update_available = true;
    if opts.auto_download {
        let (path, status) = download_asset(opts, channel, &latest, &key, platform)?;
        result.status = "downloaded".to_owned();
        result.downloaded = true;
        result.download_status = status.to_owned();
        result.download_path = path.display().to_string();
    }
    Ok(result)
}

enum FetchError {
    NotFound,
    Other(String),
}

fn fetch_manifest(url: &str) -> Result<Manifest, FetchError> {
    let agent = crate::http::agent(Some(std::time::Duration::from_secs(60)));
    let mut response = agent
        .get(url)
        .header("Accept", "application/json")
        .call()
        .map_err(|e| FetchError::Other(e.to_string()))?;
    let status = response.status().as_u16();
    if status == 404 {
        return Err(FetchError::NotFound);
    }
    if !(200..300).contains(&status) {
        return Err(FetchError::Other(format!("update manifest http status {status}")));
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(4 << 20)
        .read_to_vec()
        .map_err(|e| FetchError::Other(format!("decode update manifest: {e}")))?;
    serde_json::from_slice(&body).map_err(|e| FetchError::Other(format!("decode update manifest: {e}")))
}

fn download_asset(
    opts: &Options,
    channel: &str,
    version: &str,
    key: &str,
    platform: &Platform,
) -> Result<(PathBuf, &'static str), String> {
    let cache = opts
        .cache_dir
        .clone()
        .or_else(|| dirs::cache_dir().map(|d| d.join("mistermorph").join("updates")))
        .ok_or("resolve update cache dir: no cache directory")?;
    // Channels share version numbers and asset names, so keep their caches apart.
    let dir = cache.join(channel).join(sanitize_tag(version));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create update cache dir: {e}"))?;
    let path = dir.join(asset_name(&platform.url, version, key));
    if path.exists() && verify_checksum(&path, &platform.checksum).is_ok() {
        return Ok((path, "cached"));
    }
    download_file(&path, &platform.url, &[]).map_err(|e| format!("download update asset: {e}"))?;
    if let Err(err) = verify_checksum(&path, &platform.checksum) {
        let _ = std::fs::remove_file(&path);
        return Err(err);
    }
    Ok((path, "downloaded"))
}

/// Downloads `url` to `path` through a temporary file.
pub fn download_file(path: &Path, url: &str, headers: &[(String, String)]) -> Result<(), String> {
    let agent = crate::http::agent(None);
    let mut request = agent.get(url.trim());
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let mut response = request.call().map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("http status {status}"));
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let result = (|| {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut response.body_mut().as_reader(), &mut file).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn verify_checksum(path: &Path, checksum: &str) -> Result<(), String> {
    let want = parse_sha256(checksum)?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    if hasher.finalize().as_slice() != want.as_slice() {
        return Err("update asset checksum mismatch".to_owned());
    }
    Ok(())
}

pub fn parse_sha256(checksum: &str) -> Result<Vec<u8>, String> {
    let lower = checksum.trim().to_lowercase();
    let hex_part = lower.strip_prefix("sha256:").unwrap_or(&lower);
    if hex_part.is_empty() {
        return Err("empty update checksum".to_owned());
    }
    let raw = hex::decode(hex_part).map_err(|e| format!("decode update checksum: {e}"))?;
    if raw.len() != 32 {
        return Err(format!("invalid update checksum length {}", raw.len()));
    }
    Ok(raw)
}

pub fn asset_name(raw_url: &str, version: &str, key: &str) -> String {
    if let Ok(parsed) = url::Url::parse(raw_url.trim())
        && let Some(base) = parsed.path().rsplit('/').next()
        && !base.trim().is_empty()
        && base != "."
    {
        return sanitize_filename(base);
    }
    sanitize_filename(&format!("mistermorph-desktop-{key}-{}", sanitize_tag(version)))
}

/// `macos-arm64`, `linux-amd64`, `windows-amd64`.
pub fn platform_key(goos: &str, goarch: &str) -> String {
    let (goos, goarch) = (goos.trim(), goarch.trim());
    if goos == "darwin" { format!("macos-{goarch}") } else { format!("{goos}-{goarch}") }
}

/// Go's `runtime.GOOS` for this build.
pub fn go_os() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".to_owned(),
        os => os.to_owned(),
    }
}

/// Go's `runtime.GOARCH` for this build.
pub fn go_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "amd64".to_owned(),
        "aarch64" => "arm64".to_owned(),
        "x86" => "386".to_owned(),
        arch => arch.to_owned(),
    }
}

pub fn normalize_version(version: &str) -> String {
    let v = version.trim();
    v.strip_prefix('v').unwrap_or(v).to_owned()
}

/// -1, 0 or 1 as `current` is older than, the same as or newer than `latest`; `None` when
/// either is not a version (`dev`).
pub fn compare_versions(current: &str, latest: &str) -> Option<i32> {
    let a = parse_version(current)?;
    let b = parse_version(latest)?;
    Some(compare_parsed(&a, &b))
}

struct Parsed {
    parts: Vec<u64>,
    pre: String,
}

fn parse_version(version: &str) -> Option<Parsed> {
    let version = normalize_version(version);
    if version.is_empty() || version.eq_ignore_ascii_case("dev") {
        return None;
    }
    let version = version.split_once('+').map_or(version.as_str(), |(before, _)| before);
    let (core, pre) = version.split_once('-').unwrap_or((version, ""));
    let mut parts = Vec::new();
    for segment in core.split('.') {
        if segment.is_empty() || !segment.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        parts.push(segment.parse().ok()?);
    }
    Some(Parsed { parts, pre: pre.to_owned() })
}

fn compare_parsed(a: &Parsed, b: &Parsed) -> i32 {
    for i in 0..a.parts.len().max(b.parts.len()) {
        let av = a.parts.get(i).copied().unwrap_or(0);
        let bv = b.parts.get(i).copied().unwrap_or(0);
        if av != bv {
            return if av < bv { -1 } else { 1 };
        }
    }
    if a.pre == b.pre {
        0
    } else if a.pre.is_empty() {
        1
    } else if b.pre.is_empty() || a.pre < b.pre {
        -1
    } else {
        1
    }
}

pub fn sanitize_tag(tag: &str) -> String {
    let t = tag.trim();
    let t = t.strip_prefix('v').unwrap_or(t).trim().replace([' ', '/'], "_");
    if t.is_empty() { "latest".to_owned() } else { t }
}

fn sanitize_filename(name: &str) -> String {
    let n = name.trim().replace(['/', '\\'], "_");
    if n.is_empty() || n == "." { "update-asset".to_owned() } else { n }
}

/// The check the console asks for (`morph.desktop.checkUpdate`): the saved config, read again so
/// a channel changed in the console applies, with `channel` overriding it when given.
pub fn desktop_check(config_path: Option<&Path>, fallback: &AutoUpdate, channel: Option<String>, log: &crate::desktop_log::DesktopLog) -> Result<CheckResult, String> {
    let mut cfg = match config_path {
        Some(path) => crate::config::load_auto_update(Some(path)).unwrap_or_else(|_| fallback.clone()),
        None => fallback.clone(),
    };
    if let Some(channel) = channel {
        cfg.channel = channel.trim().to_owned();
    }
    let opts = Options::desktop(&cfg);
    let resolved = normalize_channel(&opts.channel).unwrap_or_default();
    let url = resolve_manifest_url(&opts).unwrap_or_default();
    log.line(&format!("desktop_update check_update channel={resolved:?} manifest_url={url:?}"));
    check(&opts).inspect_err(|err| {
        log.line(&format!(
            "desktop_update check_update_failed manifest_url={url:?} error={:?}",
            crate::desktop_log::compact(err, 1000)
        ));
    })
}

/// The check at startup when `auto_update.enabled` (startDesktopAutoUpdateCheck), in the background.
pub fn start_auto_check(cfg: AutoUpdate, log: std::sync::Arc<crate::desktop_log::DesktopLog>) {
    if !cfg.enabled {
        return;
    }
    std::thread::spawn(move || {
        let opts = Options::desktop(&cfg);
        let channel = normalize_channel(&opts.channel).unwrap_or_default();
        let url = resolve_manifest_url(&opts).unwrap_or_default();
        log.line(&format!("desktop_update auto_update_check channel={channel:?} manifest_url={url:?}"));
        match check(&opts) {
            Ok(r) => log.line(&format!(
                "desktop_update auto_update_checked status={:?} channel={:?} current={:?} latest={:?} platform={:?} downloaded={}",
                r.status, r.channel, r.current_version, r.latest_version, r.platform, r.downloaded
            )),
            Err(err) => log.line(&format!(
                "desktop_update auto_update_failed manifest_url={url:?} error={:?}",
                crate::desktop_log::compact(&err, 1000)
            )),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert_eq!(compare_versions("0.2.41", "0.2.42"), Some(-1));
        assert_eq!(compare_versions("v0.2.42", "0.2.42"), Some(0));
        assert_eq!(compare_versions("0.3", "0.2.99"), Some(1));
        assert_eq!(compare_versions("1.0", "1.0.0"), Some(0));
        assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0"), Some(-1));
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Some(1));
        assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0-rc.2"), Some(-1));
        assert_eq!(compare_versions("1.0.0+build.5", "1.0.0"), Some(0));
        assert_eq!(compare_versions("dev", "1.0.0"), None);
        assert_eq!(compare_versions("0.2.42-3-gabc-dirty", "0.2.42"), Some(-1));
        assert_eq!(compare_versions("1..2", "1.2"), None);
        assert_eq!(compare_versions("1.x", "1.2"), None);
        assert_eq!(compare_versions("", "1.2"), None);
    }

    #[test]
    fn normalizes_channels() {
        assert_eq!(normalize_channel("").unwrap(), BUILD_CHANNEL);
        assert_eq!(normalize_channel(" PRO ").unwrap(), "pro");
        assert!(normalize_channel("beta").unwrap_err().contains("unknown release channel"));
        assert_eq!(manifest_url("", "pro"), "https://downloads.mistermorph.com/pro/latest/update.json");
        assert_eq!(manifest_url("https://x.test/", "community"), "https://x.test/community/latest/update.json");
    }

    #[test]
    fn names_platforms() {
        assert_eq!(platform_key("darwin", "arm64"), "macos-arm64");
        assert_eq!(platform_key("linux", "amd64"), "linux-amd64");
        assert!(!go_os().is_empty() && !go_arch().is_empty());
    }

    #[test]
    fn parses_checksums() {
        let hex = "a".repeat(64);
        assert_eq!(parse_sha256(&format!("sha256:{hex}")).unwrap().len(), 32);
        assert_eq!(parse_sha256(&hex.to_uppercase()).unwrap().len(), 32);
        assert!(parse_sha256("").unwrap_err().contains("empty"));
        assert!(parse_sha256("abcd").unwrap_err().contains("length 2"));
        assert!(parse_sha256("zz").unwrap_err().contains("decode"));
    }

    #[test]
    fn names_assets() {
        assert_eq!(asset_name("https://d.test/c/v1/MrMorph-linux-amd64.tar.gz", "1.0", "linux-amd64"), "MrMorph-linux-amd64.tar.gz");
        assert_eq!(asset_name("::", "v1.0", "linux-amd64"), "mistermorph-desktop-linux-amd64-1.0");
        assert_eq!(sanitize_tag("v1 2/3"), "1_2_3");
        assert_eq!(sanitize_tag(""), "latest");
    }

    fn manifest(version: &str) -> Manifest {
        let mut platforms = HashMap::new();
        platforms.insert(
            platform_key("linux", "amd64"),
            Platform { url: "https://d.test/a.tar.gz".into(), size: 7, checksum: "a".repeat(64) },
        );
        Manifest { version: version.into(), platforms, ..Default::default() }
    }

    fn opts(current: &str, channel: &str) -> Options {
        Options { current_version: current.into(), channel: channel.into(), goos: "linux".into(), goarch: "amd64".into(), ..Default::default() }
    }

    #[test]
    fn evaluates_manifests() {
        let r = evaluate(&opts("0.2.41", ""), BUILD_CHANNEL, manifest("v0.2.42")).unwrap();
        assert_eq!((r.status.as_str(), r.update_available, r.latest_version.as_str()), ("update_available", true, "0.2.42"));
        let r = evaluate(&opts("0.2.42", ""), BUILD_CHANNEL, manifest("0.2.42")).unwrap();
        assert_eq!((r.status.as_str(), r.update_available), ("up_to_date", false));
        let r = evaluate(&opts("dev", ""), BUILD_CHANNEL, manifest("0.2.42")).unwrap();
        assert_eq!(r.status, "current_version_unknown");
        // Another channel offers its latest release whatever the version.
        let other = if BUILD_CHANNEL == CHANNEL_PRO { CHANNEL_COMMUNITY } else { CHANNEL_PRO };
        let r = evaluate(&opts("9.9.9", other), other, manifest("0.2.42")).unwrap();
        assert!(r.channel_switch && r.update_available);
        let mut m = manifest("1.0");
        m.platforms.clear();
        assert!(evaluate(&opts("0.1", ""), BUILD_CHANNEL, m).unwrap_err().contains("no platform \"linux-amd64\""));
        assert!(evaluate(&opts("0.1", ""), BUILD_CHANNEL, manifest(" ")).unwrap_err().contains("empty version"));
    }

    #[test]
    fn result_json_matches_go() {
        let r = evaluate(&opts("0.2.42", ""), BUILD_CHANNEL, manifest("0.2.42")).unwrap();
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["status"], "up_to_date");
        assert_eq!(json["asset_size"], 7);
        assert!(json.get("download_path").is_none());
        assert!(json.get("release_notes").is_none());
        assert_eq!(json["downloaded"], false);
    }

    #[test]
    fn verifies_checksums() {
        let dir = std::env::temp_dir().join(format!("morph-update-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.bin");
        std::fs::write(&file, b"hello").unwrap();
        let sum = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        verify_checksum(&file, &format!("sha256:{sum}")).unwrap();
        assert!(verify_checksum(&file, &"0".repeat(64)).unwrap_err().contains("mismatch"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
