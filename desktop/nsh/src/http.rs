//! HTTP clients: one for the local backend, one for everything else (the release server).
//!
//! Requests to a loopback address never use a proxy: the agent is chosen by the target, not by
//! `NO_PROXY`. Every other request follows the proxy variables of the process, which the launch
//! sets once (src/proxy.rs); with ureq's `socks-proxy` feature a SOCKS proxy is used or the
//! request fails.
use std::time::Duration;

use ureq::Agent;

pub const USER_AGENT: &str = "mistermorph-desktop-host";

fn builder(timeout: Option<Duration>) -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    Agent::config_builder().http_status_as_error(false).timeout_global(timeout).user_agent(USER_AGENT)
}

/// An agent for requests that leave the machine: it takes the proxy of the environment. It
/// reports every status as a response (the app reads 4xx and 5xx bodies).
pub fn agent(timeout: Option<Duration>) -> Agent {
    builder(timeout).build().into()
}

/// An agent for the app's own backend: no proxy, whatever the environment says.
pub fn local_agent(timeout: Option<Duration>) -> Agent {
    builder(timeout).proxy(None).build().into()
}

/// The agent for `url`: the local one for a loopback target, the proxied one otherwise.
pub fn agent_for(url: &str, timeout: Option<Duration>) -> Agent {
    if is_loopback(url) { local_agent(timeout) } else { agent(timeout) }
}

/// Whether `url` names this machine: `localhost`, `127.0.0.0/8` or `::1`.
pub fn is_loopback(url: &str) -> bool {
    match url::Url::parse(url.trim()).ok().as_ref().and_then(url::Url::host) {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(addr)) => addr.is_loopback(),
        Some(url::Host::Ipv6(addr)) => addr.is_loopback(),
        None => false,
    }
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

    #[test]
    fn knows_loopback_targets() {
        for url in ["http://127.0.0.1:9000/health", "http://127.8.9.1/", "http://localhost:1/x", "http://LOCALHOST/", "http://[::1]:9/"] {
            assert!(super::is_loopback(url), "{url}");
        }
        for url in ["https://mistermorph.com/", "http://192.168.0.2/", "http://localhost.example/", "http://[fe80::1]/", "/api/x", ""] {
            assert!(!super::is_loopback(url), "{url}");
        }
    }
}
