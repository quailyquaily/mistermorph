//! Where the desktop app keeps its files: the same folders the Wails app used
//! (`os.UserConfigDir()` / `os.UserCacheDir()` + `mistermorph/desktop`).
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

/// `<config dir>/mistermorph/desktop`: window state, saved values, the last location.
pub fn config_root() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("mistermorph").join("desktop"))
}

/// `<cache dir>/mistermorph/desktop`: the log, downloaded updates and backends, the app's assets.
pub fn cache_root() -> Option<PathBuf> {
    dirs::cache_dir().map(|dir| dir.join("mistermorph").join("desktop"))
}

pub fn log_file() -> Option<PathBuf> {
    cache_root().map(|dir| dir.join("logs").join("desktop.log"))
}

pub fn window_state_file() -> Option<PathBuf> {
    config_root().map(|dir| dir.join("main-window.json"))
}

pub fn kv_file() -> Option<PathBuf> {
    config_root().map(|dir| dir.join("kv.json"))
}

pub fn app_state_file() -> Option<PathBuf> {
    config_root().map(|dir| dir.join("app-state.json"))
}

pub fn update_cache_dir() -> Option<PathBuf> {
    cache_root().map(|dir| dir.join("updates"))
}

/// `MISTERMORPH_DESKTOP_BACKEND_CACHE_DIR`, or `<cache>/mistermorph/desktop/backend`.
pub fn backend_cache_dir() -> Option<PathBuf> {
    match std::env::var("MISTERMORPH_DESKTOP_BACKEND_CACHE_DIR") {
        Ok(dir) if !dir.trim().is_empty() => Some(PathBuf::from(dir.trim())),
        _ => cache_root().map(|dir| dir.join("backend")),
    }
}

/// Where nsh keeps the app's own data (`nsh/storage`, which the console does not use).
pub fn nsh_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("mistermorph").join("desktop").join("nsh"))
}

/// `~` and `~/x` expanded (pathutil.ExpandHomePath).
pub fn expand_home(path: &str) -> PathBuf {
    let path = path.trim();
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return if path == "~" { home } else { home.join(&path[2..]) };
        }
    }
    PathBuf::from(path)
}

/// `~/.morph/config.yaml` (pathutil.DefaultConfigPath).
pub fn default_config_path() -> PathBuf {
    expand_home("~/.morph").join("config.yaml")
}

/// Writes `bytes` to `path` through a temporary file, so readers never see half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all().ok();
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// `2026-11-07T12:00:00Z`: the time now in RFC 3339, UTC.
pub fn rfc3339_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    rfc3339(secs)
}

pub fn rfc3339(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let rem = unix.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_rfc3339() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_793_966_405), "2026-11-06T12:00:05Z");
    }

    #[test]
    fn expands_home() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/x/y"), home.join("x/y"));
        assert_eq!(expand_home(" /abs "), PathBuf::from("/abs"));
    }

    #[test]
    fn writes_atomically() {
        let dir = std::env::temp_dir().join(format!("morph-desktop-test-{}", std::process::id()));
        let file = dir.join("a/b.json");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"two");
        assert!(!dir.join("a/b.json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
