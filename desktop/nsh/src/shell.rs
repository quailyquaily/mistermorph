//! The main window: the console (an nsh `AppView`) once the backend is ready, "Starting" before,
//! and the startup error view when the backend does not start.
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_engine::HostReply;
use nsh_platform_gpui::{
    App as NshApp, AppOptions, AppView, AssetBase, Bundle, CloseRequest,
    gpui::{
        self, AnyElement, App, ClipboardItem, Context, Entity, Focusable, FontWeight, IntoElement, PathPromptOptions,
        Render, SharedString, Subscription, Window, WindowHandle, div, prelude::*, px, rgb, rgba,
    },
    titlebar_options,
};
use serde_json::json;

use crate::{
    host::{Desktop, Ui},
    startup_error::StartupError,
    window_state::{self, Area, WindowState},
};

pub const APP_ID: &str = "com.mistermorph";
pub const TITLE: &str = "MisterMorph";

enum State {
    Starting,
    Running,
    Failed { info: StartupError, copied: bool },
}

pub struct Shell {
    desktop: Arc<Desktop>,
    app: Entity<AppView>,
    host: nsh_engine::HostChannel,
    bundle: Bundle,
    state: State,
    save_pending: Option<gpui::Task<()>>,
    _subscriptions: Vec<Subscription>,
}

/// Opens the main window where the Wails app left it.
pub fn open(cx: &mut App, desktop: Arc<Desktop>, bundle: Bundle, assets: Option<PathBuf>) -> anyhow::Result<WindowHandle<Shell>> {
    let saved = window_state::load(crate::paths::window_state_file().as_deref());
    let area = cx.primary_display().map(|display| {
        let b = display.visible_bounds();
        Area {
            x: f32::from(b.origin.x) as i32,
            y: f32::from(b.origin.y) as i32,
            width: f32::from(b.size.width) as i32,
            height: f32::from(b.size.height) as i32,
        }
    });
    let state = saved.map(|s| area.and_then(|a| window_state::constrain(s, a)).unwrap_or(s));
    let (bounds, min) = match state {
        Some(s) => (
            gpui::Bounds::new(gpui::point(px(s.x as f32), px(s.y as f32)), gpui::size(px(s.width as f32), px(s.height as f32))),
            (window_state::MIN_WIDTH.min(s.width), window_state::MIN_HEIGHT.min(s.height)),
        ),
        None => (
            gpui::Bounds::centered(
                None,
                gpui::size(px(window_state::DEFAULT_WIDTH as f32), px(window_state::DEFAULT_HEIGHT as f32)),
                cx,
            ),
            (window_state::MIN_WIDTH, window_state::MIN_HEIGHT),
        ),
    };
    let options = AppOptions {
        app_id: APP_ID.to_owned(),
        title: TITLE.to_owned(),
        size: (f32::from(bounds.size.width) as i32, f32::from(bounds.size.height) as i32),
        asset_base: assets.map(AssetBase::Directory),
        data_dir: crate::paths::nsh_data_dir(),
        ..Default::default()
    };
    let window_options = gpui::WindowOptions {
        window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
        titlebar: Some(titlebar_options(TITLE)),
        app_id: Some(APP_ID.to_owned()),
        window_decorations: Some(gpui::WindowDecorations::Server),
        window_min_size: Some(gpui::size(px(min.0 as f32), px(min.1 as f32))),
        // Animations keep the display's rate while another window has the keyboard.
        inactive_frame_interval: None,
        // X11 shows it; Wayland and the desktop entry go by the app id.
        icon: window_icon(),
        ..Default::default()
    };
    let handle = cx.open_window(window_options, move |window, cx| {
        let app = cx.new(|cx| AppView::new(options, window, cx));
        app.read(cx).own_window(window, cx);
        crate::host::install(&app.read(cx).host(), &desktop);
        let log = desktop.log.clone();
        app.read(cx).on_app_error(move |error| {
            log.line(&format!("desktop_window app_error {}", crate::desktop_log::compact(&error.to_string(), 2000)));
        });
        app.read(cx).on_close_request(move |request, window, cx| {
            save_window_state(window);
            match request {
                // macOS keeps the app running when its window closes; the dock brings it back.
                CloseRequest::Close if cfg!(target_os = "macos") => cx.hide(),
                _ => cx.quit(),
            }
        });
        cx.new(|cx| Shell::new(app, desktop, bundle, window, cx))
    })?;
    Ok(handle)
}

/// The window icon: the 256 Linux icon, the tile filling its canvas (packaging/icons).
fn window_icon() -> Option<Arc<image::RgbaImage>> {
    const ICON: &[u8] = include_bytes!("../packaging/icons/linux/hicolor/256x256/apps/icon.png");
    image::load_from_memory(ICON).ok().map(|i| Arc::new(i.to_rgba8()))
}

/// The window's bounds when it is not maximized, for the next launch.
fn save_window_state(window: &Window) {
    let b = match window.window_bounds() {
        gpui::WindowBounds::Windowed(b) | gpui::WindowBounds::Maximized(b) | gpui::WindowBounds::Fullscreen(b) => b,
    };
    let state = WindowState {
        x: f32::from(b.origin.x).round() as i32,
        y: f32::from(b.origin.y).round() as i32,
        width: f32::from(b.size.width).round() as i32,
        height: f32::from(b.size.height).round() as i32,
    };
    if let Err(err) = window_state::save(crate::paths::window_state_file().as_deref(), state) {
        eprintln!("save desktop window state failed: {err}");
    }
}

/// Starts the backend off the main thread and tells the window how it went.
pub fn start_backend(desktop: &Arc<Desktop>) {
    let desktop = desktop.clone();
    std::thread::spawn(move || {
        let began = Instant::now();
        match desktop.supervisor.start() {
            Ok(addr) => {
                desktop.log.file_line(&format!(
                    "desktop_startup_backend_ready duration_ms={} host_start_ms={}",
                    desktop.started_at.elapsed().as_millis(),
                    began.elapsed().as_millis()
                ));
                desktop.ui(Ui::BackendReady(addr));
            }
            Err(err) => {
                desktop.log.line(&format!("failed to start desktop host: {err}"));
                desktop.ui(Ui::BackendFailed(err));
            }
        }
    });
}

impl Shell {
    fn new(app: Entity<AppView>, desktop: Arc<Desktop>, bundle: Bundle, window: &mut Window, cx: &mut Context<Self>) -> Shell {
        let subscriptions = vec![
            cx.observe_window_activation(window, |this, window, _| this.send_visibility(window)),
            cx.observe_window_visibility(window, |this, _, window, _| this.send_visibility(window)),
            cx.observe_window_bounds(window, |this, window, cx| {
                // Every move and resize step reaches here: save once things settle.
                if this.save_pending.is_none() {
                    this.save_pending = Some(cx.spawn_in(window, async move |this, cx| {
                        cx.background_executor().timer(Duration::from_millis(400)).await;
                        let _ = this.update_in(cx, |this, window, _| {
                            this.save_pending = None;
                            save_window_state(window);
                        });
                    }));
                }
            }),
        ];
        let host = app.read(cx).host();
        Shell { desktop, app, host, bundle, state: State::Starting, save_pending: None, _subscriptions: subscriptions }
    }

    fn send_visibility(&self, window: &Window) {
        if matches!(self.state, State::Running) {
            let data = json!({ "visible": window.is_visible(), "focused": window.is_window_active() });
            let _ = self.host.send("morph.visibility", data);
        }
    }

    /// Restarts the backend, then the app: from the console after setup, or the error view.
    fn restart(&mut self, cx: &mut Context<Self>) {
        if matches!(self.state, State::Starting) {
            return;
        }
        self.desktop.log.line("desktop_window restart");
        self.state = State::Starting;
        self.app.read(cx).stop();
        cx.notify();
        let desktop = self.desktop.clone();
        std::thread::spawn(move || {
            desktop.supervisor.stop();
            start_backend(&desktop);
        });
    }

    pub fn command(&mut self, command: Ui, window: &mut Window, cx: &mut Context<Self>) {
        match command {
            Ui::Title(title) => window.set_window_title(if title.trim().is_empty() { TITLE } else { &title }),
            Ui::Quit => {
                save_window_state(window);
                cx.quit();
            }
            Ui::Restart => self.restart(cx),
            Ui::OpenLog => {
                if let Some(path) = self.desktop.log.path() {
                    cx.open_with_system(path);
                }
            }
            Ui::Activate => {
                window.activate_window();
                cx.activate(true);
            }
            Ui::PickFiles { multiple, accept, reply } => self.pick_files(multiple, accept, reply, cx),
            Ui::PickDirectory { reply } => {
                let picked = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: None });
                std::thread::spawn(move || match futures::executor::block_on(picked) {
                    Ok(Ok(Some(paths))) => {
                        reply.resolve(json!(paths.first().map(|p| p.display().to_string()).unwrap_or_default()))
                    }
                    Ok(Err(err)) => reply.reject(err.to_string()),
                    _ => reply.resolve(json!("")),
                });
            }
            Ui::Save { name, bytes, reply } => self.save(name, bytes, reply, cx),
            Ui::BackendReady(addr) => {
                self.desktop.set_origin(format!("http://{addr}"));
                self.app.read(cx).load(NshApp::Js(self.bundle.clone()));
                self.state = State::Running;
                let focus = self.app.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
                self.send_visibility(window);
                cx.notify();
            }
            Ui::BackendFailed(detail) => {
                let info = StartupError::classify(&detail, self.desktop.log.path().map(|p| p.as_path()));
                self.state = State::Failed { info, copied: false };
                cx.notify();
            }
        }
    }

    fn pick_files(&self, multiple: bool, accept: String, reply: HostReply, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple, prompt: None });
        let desktop = self.desktop.clone();
        std::thread::spawn(move || match futures::executor::block_on(picked) {
            Ok(Ok(paths)) => reply.resolve(crate::files::pick_answer(
                paths,
                &accept,
                |file| desktop.register_file(file),
                |skipped| desktop.log.line(&format!("desktop_window pick skipped {skipped}")),
            )),
            Ok(Err(err)) => reply.reject(err.to_string()),
            Err(_) => reply.resolve(json!([])),
        });
    }

    fn save(&self, name: String, bytes: Vec<u8>, reply: HostReply, cx: &mut Context<Self>) {
        let dir = dirs::download_dir().or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("."));
        let chosen = cx.prompt_for_new_path(&dir, Some(&name));
        std::thread::spawn(move || match futures::executor::block_on(chosen) {
            Ok(Ok(Some(path))) => match std::fs::write(&path, &bytes) {
                Ok(()) => reply.resolve(json!("saved")),
                Err(err) => reply.reject(format!("save {}: {err}", path.display())),
            },
            Ok(Err(err)) => reply.reject(err.to_string()),
            _ => reply.resolve(json!("cancelled")),
        });
    }

    fn render_error(&self, info: &StartupError, copied: bool, cx: &mut Context<Self>) -> AnyElement {
        let has_log = !info.log_path.is_empty();
        let diagnostics = info.diagnostics();
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgb(0xf8f9f7))
            .text_color(rgb(0x1f251f))
            .child(
                div()
                    .w(px(620.))
                    .flex()
                    .flex_col()
                    .gap(px(18.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(SharedString::from(info.title.clone())))
                            .child(div().text_size(px(14.)).text_color(rgb(0x566052)).child(SharedString::from(info.message.clone()))),
                    )
                    .child(
                        div()
                            .id("detail")
                            .max_h(px(190.))
                            .overflow_y_scroll()
                            .p(px(12.))
                            .border_1()
                            .border_color(rgba(0x1f251f24))
                            .bg(rgb(0xffffff))
                            .text_color(rgb(0x2c332b))
                            .text_size(px(12.))
                            .font_family(MONO)
                            .child(SharedString::from(info.detail.clone())),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.))
                            .child(button("restart", "Restart", true, false).on_click(cx.listener(|this, _, _, cx| this.restart(cx))))
                            .child(
                                button("open-log", if has_log { "Open Log" } else { "Log Unavailable" }, false, !has_log)
                                    .when(has_log, |b| {
                                        b.on_click(cx.listener(|this, _, _, cx| {
                                            if let Some(path) = this.desktop.log.path() {
                                                cx.open_with_system(path);
                                            }
                                        }))
                                    }),
                            )
                            .child(button("copy", if copied { "Copied" } else { "Copy Diagnostics" }, false, false).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(diagnostics.clone()));
                                    if let State::Failed { copied, .. } = &mut this.state {
                                        *copied = true;
                                    }
                                    cx.notify();
                                }),
                            ))
                            .child(button("quit", "Quit", false, false).on_click(cx.listener(|_, _, window, cx| {
                                save_window_state(window);
                                cx.quit();
                            }))),
                    ),
            )
            .into_any_element()
    }
}

const MONO: &str = if cfg!(target_os = "macos") {
    "Menlo"
} else if cfg!(windows) {
    "Consolas"
} else {
    "DejaVu Sans Mono"
};

fn button(id: &'static str, label: &'static str, primary: bool, disabled: bool) -> gpui::Stateful<gpui::Div> {
    let base = div()
        .id(id)
        .h(px(34.))
        .px(px(12.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .border_1()
        .text_size(px(13.))
        .child(label);
    let base = if primary {
        base.border_color(rgb(0x2f6b45)).bg(rgb(0x2f6b45)).text_color(rgb(0xffffff))
    } else {
        base.border_color(rgba(0x1f251f29)).bg(rgb(0xffffff)).text_color(rgb(0x1f251f))
    };
    if disabled { base.opacity(0.52) } else { base.cursor_pointer() }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match &self.state {
            State::Running => div().size_full().child(self.app.clone()).into_any_element(),
            State::Starting => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(rgb(0xedf3f8))
                .text_color(rgb(0x566052))
                .text_size(px(14.))
                .child("Starting MisterMorph…")
                .into_any_element(),
            State::Failed { info, copied } => {
                let (info, copied) = (info.clone(), *copied);
                self.render_error(&info, copied, cx)
            }
        }
    }
}
