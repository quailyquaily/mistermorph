//! The Mister Morph desktop app: the console in web/console-nsh, drawn by GPUI, talking to the
//! bundled backend (`morph console serve`) that this process starts, owns and stops.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod backend;
mod config;
mod desktop_log;
mod files;
mod host;
mod http;
mod notify;
mod paths;
mod shell;
mod startup_error;
mod store;
mod update;
mod window_state;

use std::{
    path::PathBuf,
    process::ExitCode,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use futures::StreamExt;
use nsh_platform_gpui::{Bundle, set_ui_sets};

const BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/app/bundle.js"));
const SOURCE_MAP: &str = include_str!(concat!(env!("OUT_DIR"), "/app/bundle.js.map"));
const CAPABILITIES: &str = include_str!(concat!(env!("OUT_DIR"), "/app/capabilities.json"));
const NSH_APP_ID: &str = "com.mistermorph.console";

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/app/assets.rs"));
}

fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let started_at = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (config_path, explicit) = config::resolve_config_path(&args);
    config::print_config_path(config_path.as_deref(), explicit);
    let auto_update = config::load_auto_update(config_path.as_deref());

    if config::has_check_update_arg(&args) {
        return check_update_command(auto_update);
    }
    let auto_update = auto_update.unwrap_or_else(|err| {
        eprintln!("warning: load desktop config failed: {err}");
        config::AutoUpdate::default()
    });

    let bundle = match Bundle::source(BUNDLE.to_owned())
        .with_source_map(SOURCE_MAP)
        .with_app_id(Some(NSH_APP_ID))
        // Embedding apps grant what they pass here: without it the app would be unrestricted.
        .with_capabilities_json(Some(CAPABILITIES))
    {
        Ok(bundle) => bundle,
        Err(err) => {
            eprintln!("the embedded app's capabilities are invalid: {err}");
            return ExitCode::FAILURE;
        }
    };

    let log = Arc::new(desktop_log::DesktopLog::open());
    let supervisor = backend::Supervisor::spawn(backend::BackendConfig::new(config_path.clone()), log.clone());
    let (ui_tx, mut ui_rx) = futures::channel::mpsc::unbounded();
    let desktop = Arc::new(host::Desktop::new(log.clone(), started_at, config_path, auto_update, supervisor, ui_tx));
    // The backend starts while the window opens.
    shell::start_backend(&desktop);
    let assets = extract_assets(&log);
    set_ui_sets(vec![nsh_base::registry()]);

    let ok = Arc::new(AtomicBool::new(true));
    let result = ok.clone();
    let stopper = desktop.clone();
    gpui_platform::application().run(move |cx| {
        let quitting = desktop.clone();
        cx.on_app_quit(move |_| {
            quitting.supervisor.stop();
            async {}
        })
        .detach();
        let handle = match shell::open(cx, desktop.clone(), bundle, assets) {
            Ok(handle) => handle,
            Err(err) => {
                desktop.log.line(&format!("cannot open a window: {err}"));
                ok.store(false, Ordering::SeqCst);
                cx.quit();
                return;
            }
        };
        let desktop = desktop.clone();
        cx.spawn(async move |cx| {
            let mut checked = false;
            while let Some(command) = ui_rx.next().await {
                if matches!(command, host::Ui::BackendReady(_)) && !checked {
                    checked = true;
                    update::start_auto_check(desktop.auto_update.clone(), desktop.log.clone());
                }
                if handle.update(cx, |shell, window, cx| shell.command(command, window, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.activate(true);
    });
    // Quitting stopped it already; this covers a run that ended another way.
    stopper.supervisor.stop();
    if result.load(Ordering::SeqCst) { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// `--check-update`: checks once, prints the result as JSON and exits.
fn check_update_command(cfg: Result<config::AutoUpdate, String>) -> ExitCode {
    match cfg.and_then(|cfg| update::check(&update::Options::desktop(&cfg))) {
        Ok(result) => {
            println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("check update failed: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Writes the bundle's assets (fonts, icons) to the cache once per build: nsh reads them from disk.
fn extract_assets(log: &desktop_log::DesktopLog) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    if embedded::ASSETS.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    for (path, bytes) in embedded::ASSETS {
        hasher.update(path.as_bytes());
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    let hash = hex::encode(hasher.finalize());
    let root = paths::cache_root().unwrap_or_else(|| std::env::temp_dir().join("mistermorph-desktop"));
    let dir = root.join("nsh-assets").join(&hash[..16]);
    let marker = dir.join(".complete");
    if marker.exists() {
        return Some(dir);
    }
    let written = (|| -> std::io::Result<()> {
        for (path, bytes) in embedded::ASSETS {
            let file = dir.join(path);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(file, bytes)?;
        }
        std::fs::write(&marker, b"")
    })();
    match written {
        Ok(()) => Some(dir),
        Err(err) => {
            log.line(&format!("desktop_window cannot write the app's assets to {}: {err}", dir.display()));
            None
        }
    }
}
