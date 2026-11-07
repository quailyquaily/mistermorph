//! The desktop log (`<cache>/mistermorph/desktop/logs/desktop.log`): the backend's output and the
//! shell's own events, as the Wails app kept it. Lines also go to the terminal.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
};

pub struct DesktopLog {
    file: Mutex<Option<File>>,
    path: Option<PathBuf>,
}

impl DesktopLog {
    /// Opens (appends to) the log; without a cache folder it only writes to the terminal.
    pub fn open() -> DesktopLog {
        let Some(path) = crate::paths::log_file() else {
            eprintln!("open desktop log file failed: no cache directory");
            return DesktopLog { file: Mutex::new(None), path: None };
        };
        let opened = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| OpenOptions::new().create(true).append(true).open(&path));
        match opened {
            Ok(mut file) => {
                let _ = writeln!(file, "\n--- MisterMorph desktop start {} ---", crate::paths::rfc3339_now());
                DesktopLog { file: Mutex::new(Some(file)), path: Some(path) }
            }
            Err(err) => {
                eprintln!("open desktop log file failed: {err}");
                DesktopLog { file: Mutex::new(None), path: None }
            }
        }
    }

    /// A log that only writes to the terminal (tests).
    #[cfg(test)]
    pub fn none() -> DesktopLog {
        DesktopLog { file: Mutex::new(None), path: None }
    }

    pub fn path(&self) -> Option<&PathBuf> {
        self.path.as_ref()
    }

    /// A line to the terminal's stderr and the log.
    pub fn line(&self, line: &str) {
        eprintln!("{line}");
        self.file_line(line);
    }

    /// A line to the log only.
    pub fn file_line(&self, line: &str) {
        if let Some(file) = self.file.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }

    /// Raw output of the backend: to the log and to the terminal's stdout or stderr.
    pub fn output(&self, bytes: &[u8], stderr: bool) {
        if stderr {
            let _ = std::io::stderr().write_all(bytes);
        } else {
            let _ = std::io::stdout().write_all(bytes);
        }
        if let Some(file) = self.file.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = file.write_all(bytes);
        }
    }
}

/// One line for the log: whitespace folded, at most `limit` bytes (compactDesktopLogValue).
pub fn compact(value: &str, limit: usize) -> String {
    let value = value.trim().replace(['\n', '\r'], " ");
    if limit == 0 || value.len() <= limit {
        return value;
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...(truncated)", &value[..end])
}

#[cfg(test)]
mod tests {
    #[test]
    fn compacts() {
        assert_eq!(super::compact(" a\nb\r ", 0), "a b");
        assert_eq!(super::compact("abcdef", 3), "abc...(truncated)");
        assert_eq!(super::compact("ééé", 3), "é...(truncated)");
    }
}
