//! Bundles the console in ../../web/console-nsh with `nsh build`, which `main.rs` embeds, and lists
//! the bundle's assets (fonts, icons, images) so they are embedded too.
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest.join("../..");
    let app = repo.join("web/console-nsh");
    watch_app(&app);
    println!("cargo:rerun-if-changed={}", repo.join("assets/config").display());
    println!("cargo:rerun-if-env-changed=NSH");
    println!("cargo:rerun-if-env-changed=NODE");
    println!("cargo:rerun-if-env-changed=MISTERMORPH_DESKTOP_VERSION");
    println!("cargo:rerun-if-env-changed=MISTERMORPH_DESKTOP_APP_DIR");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("app");
    let _ = fs::remove_dir_all(&out);
    match env::var("MISTERMORPH_DESKTOP_APP_DIR") {
        // A bundle `nsh build` made already (CI, or a tree mid-edit that does not build).
        Ok(dir) if !dir.trim().is_empty() => {
            let dir = PathBuf::from(dir.trim());
            println!("cargo:rerun-if-changed={}", dir.display());
            copy_dir(&dir, &out);
        }
        _ => build_app(&app, &out),
    }

    // `asset:/assets/fonts/x.woff2` resolves to <assets dir>/assets/fonts/x.woff2.
    let assets = out.join("assets");
    let mut files = Vec::new();
    if assets.is_dir() {
        collect(&assets, &assets, &mut files);
    }
    files.sort();
    let mut code = String::from("pub static ASSETS: &[(&str, &[u8])] = &[\n");
    for (relative, path) in &files {
        code.push_str(&format!("    ({relative:?}, include_bytes!({:?})),\n", path.display().to_string()));
    }
    code.push_str("];\n");
    fs::write(out.join("assets.rs"), code).unwrap();

    windows_icon(&manifest);
}

/// Gives MrMorph.exe the app icon (`packaging/icons/windows/appicon.ico`, made by
/// design/brand/generator/platforms.py). The window sets its own icon at run time (shell.rs);
/// this one is what Explorer, shortcuts and the taskbar show for the file. The desktop app builds
/// on the machine it is for, so the host decides.
#[cfg(windows)]
fn windows_icon(manifest: &Path) {
    let icon = manifest.join("packaging/icons/windows/appicon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    let mut res = winresource::WindowsResource::new();
    res.set_icon(icon.to_str().expect("icon path is UTF-8"));
    res.compile().expect("embedding the Windows icon resource");
}

#[cfg(not(windows))]
fn windows_icon(_manifest: &Path) {}

fn build_app(app: &Path, out: &Path) {
    // lib/generated/* (config templates, icon maps) comes from scripts/generate.mjs, which
    // `nsh build` does not run.
    let node = env::var("NODE").unwrap_or_else(|_| "node".to_owned());
    let status = Command::new(&node)
        .arg(app.join("scripts/generate.mjs"))
        .status()
        .unwrap_or_else(|e| panic!("cannot run `{node}` for scripts/generate.mjs: {e}"));
    assert!(status.success(), "scripts/generate.mjs failed");

    let nsh = env::var("NSH").unwrap_or_else(|_| "nsh".to_owned());
    let status = Command::new(&nsh)
        .args(["build", "--release", "-o"])
        .arg(out)
        .arg(app)
        .status()
        .unwrap_or_else(|e| panic!("cannot run `{nsh}` (https://nsh.dev/docs/installation): {e}"));
    assert!(status.success(), "`nsh build` failed");
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap_or_else(|e| panic!("read {}: {e}", from.display())).flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Reruns when the app's sources change, but not for what the build itself writes there
/// (`lib/generated`, `.nsh`), which would rebuild every time.
fn watch_app(app: &Path) {
    for entry in fs::read_dir(app).unwrap().flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), ".nsh" | "node_modules" | "dist") {
            continue;
        }
        if name == "lib" {
            for child in fs::read_dir(entry.path()).unwrap().flatten() {
                if child.file_name() != "generated" {
                    println!("cargo:rerun-if-changed={}", child.path().display());
                }
            }
            continue;
        }
        println!("cargo:rerun-if-changed={}", entry.path().display());
    }
}

fn collect(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, files);
        } else {
            let relative = path.strip_prefix(root).unwrap();
            let relative = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            files.push((relative, path.canonicalize().unwrap()));
        }
    }
}
