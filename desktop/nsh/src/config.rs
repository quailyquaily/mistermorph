//! The parts of the Mister Morph config the desktop shell reads itself (as the Wails app did):
//! where it is, and `auto_update`.
use std::path::{Path, PathBuf};

use yaml_rust2::{Yaml, YamlLoader};

pub const CHECK_UPDATE_ARG: &str = "--check-update";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutoUpdate {
    pub enabled: bool,
    /// The release channel to follow; empty means the build channel.
    pub channel: String,
}

/// Reads `auto_update.enabled` and `auto_update.channel` from the YAML config at `path`.
pub fn load_auto_update(path: Option<&Path>) -> Result<AutoUpdate, String> {
    let Some(path) = path else {
        return Ok(AutoUpdate::default());
    };
    let text = std::fs::read_to_string(path).map_err(|e| format!("read desktop config: {e}"))?;
    parse_auto_update(&text).map_err(|e| format!("read desktop config: {e}"))
}

pub fn parse_auto_update(text: &str) -> Result<AutoUpdate, String> {
    let docs = YamlLoader::load_from_str(text).map_err(|e| e.to_string())?;
    let Some(doc) = docs.first() else {
        return Ok(AutoUpdate::default());
    };
    let section = &doc["auto_update"];
    Ok(AutoUpdate {
        enabled: yaml_bool(&section["enabled"]),
        channel: match &section["channel"] {
            Yaml::String(s) => s.trim().to_owned(),
            Yaml::Integer(i) => i.to_string(),
            _ => String::new(),
        },
    })
}

/// What viper's `GetBool` makes of a value (spf13/cast `ToBool`).
fn yaml_bool(value: &Yaml) -> bool {
    match value {
        Yaml::Boolean(b) => *b,
        Yaml::Integer(i) => *i != 0,
        Yaml::String(s) => parse_go_bool(s).unwrap_or(false),
        _ => false,
    }
}

/// Go's `strconv.ParseBool`.
pub fn parse_go_bool(value: &str) -> Option<bool> {
    match value.trim() {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// The config file: `--config <path>` (or `--config=<path>`) when given, else
/// `~/.morph/config.yaml` when it exists. The flag tells whether it was explicit.
pub fn resolve_config_path(args: &[String]) -> (Option<PathBuf>, bool) {
    if let Some(explicit) = extract_config_path(args) {
        return (Some(crate::paths::expand_home(&explicit)), true);
    }
    let default = crate::paths::default_config_path();
    if default.exists() { (Some(default), false) } else { (None, false) }
}

pub fn extract_config_path(args: &[String]) -> Option<String> {
    let mut iter = args.iter().map(|a| a.trim());
    while let Some(arg) = iter.next() {
        if arg == "--config" {
            if let Some(value) = iter.next() {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_owned());
                }
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--config=") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

pub fn has_check_update_arg(args: &[String]) -> bool {
    args.iter().any(|a| a.trim() == CHECK_UPDATE_ARG)
}

pub fn print_config_path(path: Option<&Path>, explicit: bool) {
    let source = if explicit { "explicit" } else { "auto" };
    let shown = path.map_or_else(|| "(none)".to_owned(), |p| p.display().to_string());
    eprintln!("desktop app config path [{source}]: {shown}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_auto_update() {
        let cfg = parse_auto_update("auto_update:\n  enabled: true\n  channel: \" Pro \"\n").unwrap();
        assert_eq!(cfg, AutoUpdate { enabled: true, channel: "Pro".into() });
        let cfg = parse_auto_update("auto_update:\n  enabled: \"true\"\n").unwrap();
        assert!(cfg.enabled);
        assert_eq!(parse_auto_update("llm:\n  model: x\n").unwrap(), AutoUpdate::default());
        assert_eq!(parse_auto_update("").unwrap(), AutoUpdate::default());
        assert_eq!(parse_auto_update("auto_update: 3\n").unwrap(), AutoUpdate::default());
        assert!(parse_auto_update("a: [\n").is_err());
    }

    #[test]
    fn missing_file_is_an_error() {
        let err = load_auto_update(Some(Path::new("/nonexistent/morph.yaml"))).unwrap_err();
        assert!(err.starts_with("read desktop config:"), "{err}");
        assert_eq!(load_auto_update(None).unwrap(), AutoUpdate::default());
    }

    #[test]
    fn finds_the_config_flag() {
        assert_eq!(extract_config_path(&args(&["--config", "/a.yaml"])), Some("/a.yaml".into()));
        assert_eq!(extract_config_path(&args(&["x", "--config=/b.yaml"])), Some("/b.yaml".into()));
        assert_eq!(extract_config_path(&args(&["--config"])), None);
        assert_eq!(extract_config_path(&args(&["--configx=/c"])), None);
        let (path, explicit) = resolve_config_path(&args(&["--config", "~/m.yaml"]));
        assert!(explicit);
        assert_eq!(path.unwrap(), dirs::home_dir().unwrap().join("m.yaml"));
    }

    #[test]
    fn finds_check_update() {
        assert!(has_check_update_arg(&args(&["--check-update"])));
        assert!(!has_check_update_arg(&args(&["--check"])));
    }

    #[test]
    fn parses_go_bools() {
        assert_eq!(parse_go_bool("True"), Some(true));
        assert_eq!(parse_go_bool("0"), Some(false));
        assert_eq!(parse_go_bool("yes"), None);
    }
}
