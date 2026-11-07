//! What the app keeps between launches: its saved values (`morph.kv.set`, what `localStorage` was
//! to the Vue console) and the location it was last at (`morph.history`).
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// Saved values, kept in a JSON object of strings.
#[derive(Debug, Default)]
pub struct KvStore {
    path: Option<PathBuf>,
    values: BTreeMap<String, String>,
}

impl KvStore {
    /// The values at `path`; a missing or broken file starts empty.
    pub fn load(path: Option<PathBuf>) -> KvStore {
        let values = path.as_deref().map(read_values).unwrap_or_default();
        KvStore { path, values }
    }

    pub fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }

    /// Sets (`Some`) or removes (`None`) `key` and writes the file.
    pub fn set(&mut self, key: &str, value: Option<String>) -> Result<(), String> {
        let changed = match value {
            Some(value) => self.values.insert(key.to_owned(), value.clone()).as_ref() != Some(&value),
            None => self.values.remove(key).is_some(),
        };
        if !changed {
            return Ok(());
        }
        let Some(path) = &self.path else {
            return Ok(());
        };
        let json = serde_json::to_vec_pretty(&self.values).map_err(|e| e.to_string())?;
        crate::paths::write_atomic(path, &json).map_err(|e| format!("save {}: {e}", path.display()))
    }
}

fn read_values(path: &Path) -> BTreeMap<String, String> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    match serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&bytes) {
        Ok(map) => map
            .into_iter()
            .filter_map(|(k, v)| match v {
                serde_json::Value::String(s) => Some((k, s)),
                _ => None,
            })
            .collect(),
        Err(err) => {
            log::warn!("ignoring {}: {err}", path.display());
            BTreeMap::new()
        }
    }
}

/// The app's state between launches.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppState {
    /// Where the app was: path, query and hash below the base path (`/chat?x=1`).
    #[serde(default)]
    pub location: String,
}

impl AppState {
    pub fn load(path: Option<&Path>) -> AppState {
        let state: AppState = path
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        AppState { location: normalize_location(&state.location) }
    }

    pub fn save(&self, path: Option<&Path>) -> Result<(), String> {
        let Some(path) = path else {
            return Ok(());
        };
        let json = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        crate::paths::write_atomic(path, &json).map_err(|e| format!("save {}: {e}", path.display()))
    }
}

/// A location the app can start at: below the base path, starting with `/`; `/` otherwise.
pub fn normalize_location(location: &str) -> String {
    let location = location.trim();
    if location.starts_with('/') && !location.starts_with("//") && !location.contains(['\n', '\r']) {
        location.to_owned()
    } else {
        "/".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("morph-store-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn kv_persists_and_reloads() {
        let dir = temp("kv");
        let file = dir.join("kv.json");
        let mut kv = KvStore::load(Some(file.clone()));
        assert!(kv.values().is_empty());
        kv.set("mistermorph_console_token", Some("abc".into())).unwrap();
        kv.set("quail-language", Some("ja".into())).unwrap();
        kv.set("gone", Some("x".into())).unwrap();
        kv.set("gone", None).unwrap();
        let again = KvStore::load(Some(file.clone()));
        assert_eq!(again.values().get("mistermorph_console_token").map(String::as_str), Some("abc"));
        assert_eq!(again.values().get("quail-language").map(String::as_str), Some("ja"));
        assert!(!again.values().contains_key("gone"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn kv_ignores_broken_files_and_other_values() {
        let dir = temp("broken");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("kv.json");
        std::fs::write(&file, "{not json").unwrap();
        assert!(KvStore::load(Some(file.clone())).values().is_empty());
        std::fs::write(&file, r#"{"a":"1","b":2,"c":null}"#).unwrap();
        let kv = KvStore::load(Some(file));
        assert_eq!(kv.values().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn kv_without_a_file_keeps_values_in_memory() {
        let mut kv = KvStore::load(None);
        kv.set("a", Some("1".into())).unwrap();
        assert_eq!(kv.values().get("a").map(String::as_str), Some("1"));
    }

    #[test]
    fn app_state_round_trips() {
        let dir = temp("state");
        let file = dir.join("app-state.json");
        assert_eq!(AppState::load(Some(&file)).location, "/");
        AppState { location: "/e/default/chat?x=1".into() }.save(Some(&file)).unwrap();
        assert_eq!(AppState::load(Some(&file)).location, "/e/default/chat?x=1");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn normalizes_locations() {
        assert_eq!(normalize_location("/setup"), "/setup");
        assert_eq!(normalize_location(""), "/");
        assert_eq!(normalize_location("http://x/y"), "/");
        assert_eq!(normalize_location("//evil"), "/");
    }
}
