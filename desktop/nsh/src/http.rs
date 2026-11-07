//! HTTP clients: one for the local backend, one for the release server.
use std::time::Duration;

use ureq::Agent;

pub const USER_AGENT: &str = "mistermorph-desktop-host";

/// An agent that reports every status as a response (the app reads 4xx and 5xx bodies).
pub fn agent(timeout: Option<Duration>) -> Agent {
    Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(timeout)
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// Resolves `url` against the backend's origin when it is relative (`/api/...`).
pub fn resolve(origin: &str, url: &str) -> String {
    let url = url.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_owned();
    }
    let origin = origin.trim_end_matches('/');
    if url.starts_with('/') { format!("{origin}{url}") } else { format!("{origin}/{url}") }
}

#[cfg(test)]
mod tests {
    #[test]
    fn resolves_relative_urls() {
        let origin = "http://127.0.0.1:9000";
        assert_eq!(super::resolve(origin, "/api/x"), "http://127.0.0.1:9000/api/x");
        assert_eq!(super::resolve(origin, "api/x"), "http://127.0.0.1:9000/api/x");
        assert_eq!(super::resolve(origin, "https://e.com/a"), "https://e.com/a");
    }
}
