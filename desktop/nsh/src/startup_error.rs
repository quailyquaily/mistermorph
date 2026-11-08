//! What the window shows when the backend does not start (as the Wails app did).
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StartupError {
    pub kind: &'static str,
    pub title: String,
    pub message: String,
    pub detail: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub log_path: String,
}

impl StartupError {
    pub fn classify(detail: &str, log_path: Option<&std::path::Path>) -> StartupError {
        let detail = detail.trim().to_owned();
        let (kind, message) = if detail.contains("cannot find runnable mistermorph backend binary") {
            ("backend_missing", "The bundled backend binary was not found or is not executable.")
        } else if detail.contains("exited before readiness") {
            ("backend_exited", "The backend process exited before it became ready.")
        } else if detail.contains("did not become ready before timeout") {
            ("backend_timeout", "The backend process started but did not become ready in time.")
        } else if detail.contains("start desktop console host") {
            ("backend_start_failed", "The desktop app could not launch the backend process.")
        } else if detail.contains("build console url") {
            ("backend_url_failed", "The desktop app could not build the local backend URL.")
        } else if detail.contains("listen") || detail.contains("loopback") {
            ("loopback_failed", "The desktop app could not reserve a local loopback port.")
        } else {
            ("unknown", "The desktop app could not start its local backend.")
        };
        StartupError {
            kind,
            title: "MisterMorph could not start".to_owned(),
            message: message.to_owned(),
            detail,
            log_path: log_path.map(|p| p.display().to_string()).unwrap_or_default(),
        }
    }

    /// What "Copy Diagnostics" copies.
    pub fn diagnostics(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "failed to encode startup diagnostics".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies() {
        let cases = [
            ("cannot find runnable mistermorph backend binary; set X", "backend_missing"),
            ("desktop console host exited before readiness: exit status 1", "backend_exited"),
            ("desktop console host did not become ready before timeout (25s)", "backend_timeout"),
            ("start desktop console host: permission denied", "backend_start_failed"),
            ("reserve loopback listen addr: denied", "loopback_failed"),
            ("something else", "unknown"),
        ];
        for (detail, kind) in cases {
            assert_eq!(StartupError::classify(detail, None).kind, kind, "{detail}");
        }
    }

    #[test]
    fn diagnostics_name_the_log() {
        let info = StartupError::classify("x", Some(std::path::Path::new("/l/desktop.log")));
        let json: serde_json::Value = serde_json::from_str(&info.diagnostics()).unwrap();
        assert_eq!(json["log_path"], "/l/desktop.log");
        assert_eq!(json["kind"], "unknown");
        let none = StartupError::classify("x", None).diagnostics();
        assert!(!none.contains("log_path"));
    }
}
