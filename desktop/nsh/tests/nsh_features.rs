//! The nsh runtime's features the app builds with.
//!
//! `Cargo.toml` turns `nsh-platform-gpui`'s default features off, so a part nsh moves behind a new
//! default feature is silently left out of the app. nsh 0.6.0 did that with `net`: every fetch of
//! the Console failed ("this host has no network stack") and the app never logged in, while every
//! headless and browser test passed. Each default feature must be named in `Cargo.toml` or be in
//! `LEFT_OUT`, with the reason.

use std::collections::BTreeSet;
use std::path::Path;

/// Default features of `nsh-platform-gpui` the app does without, and why.
const LEFT_OUT: &[(&str, &str)] = &[
    ("webview", "the app shows no web views"),
    ("updater", "src/update.rs is the app's own updater"),
];

fn manifest(path: &Path) -> toml::Table {
    let text = std::fs::read_to_string(path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    text.parse().unwrap_or_else(|err| panic!("parse {}: {err}", path.display()))
}

fn strings(value: Option<&toml::Value>) -> BTreeSet<String> {
    value
        .and_then(toml::Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

#[test]
fn builds_every_default_runtime_feature_it_does_not_leave_out() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let app = manifest(&root.join("Cargo.toml"));
    // The copy `[patch.crates-io]` builds in place of the published crate.
    let runtime = manifest(&root.join("vendor/nsh-platform-gpui/Cargo.toml"));

    let dependency = &app["dependencies"]["nsh-platform-gpui"];
    assert_eq!(
        dependency.get("default-features").and_then(toml::Value::as_bool),
        Some(false),
        "Cargo.toml no longer turns nsh-platform-gpui's defaults off: drop this test or turn them off again"
    );
    let enabled = strings(dependency.get("features"));
    let defaults = strings(runtime["features"].get("default"));
    assert!(!defaults.is_empty(), "nsh-platform-gpui has no default features: read its manifest again");

    let left_out: BTreeSet<String> = LEFT_OUT.iter().map(|(name, _)| (*name).to_owned()).collect();
    let missing: Vec<&String> = defaults.iter().filter(|name| !enabled.contains(*name) && !left_out.contains(*name)).collect();
    assert!(
        missing.is_empty(),
        "nsh-platform-gpui's default features {missing:?} are not built: add them to its features in Cargo.toml, \
         or to LEFT_OUT in tests/nsh_features.rs with the reason"
    );

    let both: Vec<&String> = enabled.intersection(&left_out).collect();
    assert!(both.is_empty(), "{both:?} are both built and in LEFT_OUT: take them out of one");
    let stale: Vec<&String> = left_out.difference(&defaults).collect();
    assert!(stale.is_empty(), "{stale:?} in LEFT_OUT are no longer default features: take them out of LEFT_OUT");
}
