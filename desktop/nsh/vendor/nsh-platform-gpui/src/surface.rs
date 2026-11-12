//! One surface: an engine thread and the views it mounts on GPUI's main
//! thread.
//!
//! The engine thread hands each commit to [`Sink`], which queues it and
//! sends one wake-up to the main thread ([`crate::rt::invoke`]); the main
//! thread drains the queue and applies every batch in order
//! ([`Surface::drain`]). Drawing is coalesced: changes mark the surface
//! invalid, and [`flush_all`] (which ends every main-thread entry point)
//! notifies the GPUI view showing it, which draws the tree in its next
//! frame ([`crate::render`]). Native animations and JS frame requests tick
//! on the window's frames ([`Surface::tick`], called while drawing) while
//! there is something to do. A window that is not presented (minimized,
//! hidden, a suspended Wayland toplevel) draws no frames, so what changes
//! the app's state when an animation ends (a view detached, a screen's
//! `onDismiss`, an animation's `finished`, a scroll's end) is kept by a
//! timer instead, which ticks at its deadline if no frame did
//! ([`Surface::keep_deadline`]).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{EventKind, EventPayload, MountBatch, MountItem, NodeId, Points, ROOT_ID, Size};
use nsh_engine::{
    AppError, Engine, EngineConfig, EngineControl, Environment, MainThreadTask, MountSink,
};
use rustc_hash::FxHashMap;

use crate::{
    animation::UiAnimation,
    mount::Mounter,
    text::GpuiTextEngine,
    view::{Hosted, NshView},
};

/// What the engine thread sends the main thread.
enum Message {
    Batch(MountBatch),
    Error(AppError),
    Frame,
    HotUpdateFailed,
    Handled(u64),
    /// A function the app runs on the main thread
    /// ([`MountSink::run_on_main_thread`]), after the batches before it.
    Run(MainThreadTask),
}

thread_local! {
    /// The surfaces of this (main) thread, by key.
    static SURFACES: RefCell<FxHashMap<u64, Weak<Surface>>> = RefCell::default();
}

static NEXT_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Forwards batches from the engine thread to the main thread.
struct Sink {
    /// The surface to wake ([`Surface::by_key`]).
    key: u64,
    tx: Sender<Message>,
    /// A wake-up is on its way: no need for another.
    pending: Arc<AtomicBool>,
}

impl Sink {
    fn send(&self, message: Message) {
        let _ = self.tx.send(message);
        if !self.pending.swap(true, Ordering::AcqRel) {
            let key = self.key;
            crate::rt::invoke(move || {
                if let Some(surface) = Surface::by_key(key) {
                    surface.drain();
                }
            });
        }
    }
}

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        self.send(Message::Batch(batch));
    }

    fn report(&self, error: &AppError) {
        self.send(Message::Error(error.clone()));
    }

    fn request_frame(&self) {
        self.send(Message::Frame);
    }

    fn hot_update_failed(&self) {
        self.send(Message::HotUpdateFailed);
    }

    fn handled(&self, events: u64) {
        self.send(Message::Handled(events));
    }

    fn run_on_main_thread(&self, task: MainThreadTask) {
        self.send(Message::Run(task));
    }
}

/// How long after a deadline the timer that keeps it fires
/// ([`Surface::keep_deadline`]): more than a frame, so while the window
/// draws, its frames always come first.
const LATE: f64 = 0.05;

/// Called on every frame with the frame's time (seconds, [`Surface::clock`])
/// until it is done ([`Surface::on_frame`]).
pub(crate) type FrameClient = Box<dyn FnMut(&Rc<Surface>, f64) -> Next>;

/// What a frame client has left after a frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Next {
    /// Nothing: it is not called again.
    Done,
    /// Drawing only (a fade, a shader, a scroll indicator): the next frame,
    /// when there is one.
    Frame,
    /// Something that changes the app's state ends at this time (seconds,
    /// [`Surface::clock`]: a view detached, an event sent): it is called by
    /// then even while no frames are drawn ([`Surface::keep_deadline`]),
    /// and on every frame until then.
    At(f64),
}

impl From<bool> for Next {
    /// Whether it wants the next frame, for drawing only.
    fn from(more: bool) -> Self {
        if more { Next::Frame } else { Next::Done }
    }
}

/// Called with the new size (points) when the surface is resized.
pub(crate) type ResizeHandler = Box<dyn Fn(f32, f32)>;

/// A window shortcut: true if it took the key (down).
pub(crate) type ShortcutHandler = Box<dyn Fn(&crate::input::KeyEvent) -> bool>;

/// Called when the app reports an error (development hosts show it).
pub(crate) type ErrorHandler = Box<dyn Fn(&AppError)>;

/// A handler as kept: shared, so it is called with nothing borrowed (it may
/// restart the app or set another handler).
type Handler<F> = RefCell<Option<Rc<F>>>;

/// One engine and its views.
pub(crate) struct Surface {
    key: u64,
    /// The root view (node [`ROOT_ID`]): fills the window.
    pub(crate) root: NshView,
    /// Views by node id, and what mounting needs between items.
    pub(crate) mounter: RefCell<Mounter>,
    /// The views by node id (the mounter's, readable while it applies a
    /// batch).
    views: Rc<crate::mount::Views>,
    /// The native animation graph.
    pub(crate) anim: RefCell<UiAnimation>,
    /// Stacks, screens and modals.
    pub(crate) nav: RefCell<crate::navigation::Nav>,
    /// Pointer input state ([`crate::input`]).
    pub(crate) input: crate::input::Input,
    /// The destination of a file dragged in from another application.
    pub(crate) file_drop: crate::file_drop::State,
    engine: RefCell<Option<Engine>>,
    control: RefCell<Option<EngineControl>>,
    rx: RefCell<Option<Receiver<Message>>>,
    pending: RefCell<Arc<AtomicBool>>,
    /// Pixels per point (the window's scale factor).
    scale: Cell<f32>,
    /// The GPUI view drawing the surface ([`crate::app::AppView`]): notified
    /// when the surface changed.
    pub(crate) entity: Cell<Option<gpui::EntityId>>,
    /// The GPUI window that view is in, as it was made or last drawn: what
    /// reaches the window between frames uses it (native components' props
    /// and commands, [`crate::native`]).
    pub(crate) main_window: Cell<Option<gpui::AnyWindowHandle>>,
    /// The GPUI text system (fonts the engine thread shapes with, and the
    /// main thread draws with).
    pub(crate) text_system: RefCell<Option<Arc<gpui::TextSystem>>>,
    /// Where the surface was drawn last, in window coordinates (points):
    /// input arrives in window coordinates.
    pub(crate) origin: Cell<(f32, f32)>,
    /// A draw is requested.
    invalid: Cell<bool>,
    /// Mouse buttons pressed on the surface (bit per button): their moves
    /// and releases are the surface's wherever they happen.
    pub(crate) input_pressed: Cell<u8>,
    /// The mouse is over the surface.
    pub(crate) input_hovered: Cell<bool>,
    /// A field took the surface's focus. The view takes the window's at the
    /// next paint, or the keys for the field go to whatever element of the
    /// embedding app had it ([`crate::events::install`]).
    pub(crate) window_focus_requested: Cell<bool>,
    /// The surface's window is not presented (minimized, on another
    /// workspace, a suspended Wayland toplevel): its caret does not blink
    /// ([`crate::text_input::window_visibility`]). Kept across the app's
    /// reloads, which do not change the window's visibility.
    pub(crate) window_hidden: Cell<bool>,
    /// The environment the engine was last told about.
    pub(crate) environment: Cell<Environment>,
    /// The app's appearance (`nsh.json`, `setColorScheme`): the color
    /// scheme is the system's resolved with it ([`crate::system`]).
    pub(crate) appearance: Cell<nsh_core::platform::Appearance>,
    /// JS asked for a display frame.
    js_frame: Cell<bool>,
    /// Extra frame clients (transitions, glides, spinners), called on every
    /// frame until they are done, each with its deadline ([`Next::At`]; a
    /// new one's is when it was added, [`Surface::on_frame`]).
    frame_clients: RefCell<Vec<(FrameClient, Option<f64>)>>,
    /// When the last tick ran ([`Surface::clock`]).
    last_tick: Cell<f64>,
    /// A tick runs: what it adds is scheduled when it ends.
    ticking: Cell<bool>,
    /// A batch was applied since the last tick: it may have moved what the
    /// frame clients last reported (a transition retargeted), so a tick is
    /// due at once ([`Surface::deadline`]).
    restep: Cell<bool>,
    /// The deadline the scheduled timer waits for
    /// ([`Surface::keep_deadline`]).
    keeper: Cell<Option<f64>>,
    /// The GPU device shader views render with, opened when the first
    /// shader is mounted (`None` inside: there is none).
    shader_renderer: std::cell::OnceCell<Option<Rc<nsh_engine::shader::Renderer>>>,
    /// The model of a test session's app (`nsh test --target gpui`).
    #[cfg(feature = "dev")]
    test_model: RefCell<Option<std::sync::Arc<nsh_testing::agent::Model>>>,
    /// Frame statistics, while they are logged ([`crate::stats`]).
    pub(crate) stats: RefCell<Option<crate::stats::FrameStats>>,
    epoch: std::time::Instant,
    on_error: Handler<dyn Fn(&AppError)>,
    /// A dev session's error overlay: hears the errors besides `on_error`.
    #[cfg(feature = "dev")]
    on_dev_error: Handler<dyn Fn(&AppError)>,
    on_hot_update_failed: Handler<dyn Fn()>,
    /// Counts the apps stopped ([`Surface::stop`]): what an engine sent
    /// before is not applied to the next one.
    generation: Cell<u64>,
    /// Where `asset:/` image URIs resolve ([`crate::image::set_asset_base`]).
    pub(crate) asset_base: RefCell<Option<crate::image::AssetBase>>,
    /// The disk cache of downloaded images ([`crate::image::set_disk_cache`]).
    pub(crate) image_cache: RefCell<Option<nsh_core::image::DiskCache>>,
    /// The roots the app's `<Image>` files are read under
    /// ([`nsh_engine::Engine::media_files`]).
    pub(crate) media_files: RefCell<Arc<nsh_core::access::MediaFiles>>,
    /// What the running app may reach (checked for image redirects).
    pub(crate) access: RefCell<Arc<nsh_core::access::Access>>,
    /// Videos, web views and registered native components.
    pub(crate) native: crate::native::NativeState,
    /// The app's keyboard shortcuts ([`crate::keymap`]).
    pub(crate) keymap: crate::keymap::KeymapState,
    /// Hosted items drawn by the last frame ([`Hosted::placed`]).
    placed: RefCell<Vec<Rc<dyn Hosted>>>,
    /// The window's chrome: title bar, menus ([`crate::chrome`]).
    pub(crate) chrome: crate::chrome::Chrome,
    /// Called after the surface is resized (development overlays).
    pub(crate) on_resized: RefCell<Vec<ResizeHandler>>,
    /// Keys the window takes before anything focused sees them (the
    /// standalone app's full screen, the dev host's reload).
    pub(crate) shortcuts: RefCell<Vec<ShortcutHandler>>,
    /// How many batches were applied.
    pub(crate) batches: Cell<u64>,
    /// Events sent to the engine, and how many of them it has handled
    /// with what they changed applied here.
    events_sent: Cell<u64>,
    events_handled: Cell<u64>,
    /// The embedding app's theme ([`crate::AppView::set_theme`]): sent to
    /// every engine the surface starts, before its first frame.
    pub(crate) host_theme: RefCell<Option<nsh_base::Theme>>,
    /// The window is see-through where the app draws nothing
    /// ([`crate::AppOptions::transparent`]): no window background.
    pub(crate) transparent: Cell<bool>,
    /// The embedding app's appearance (dark or not), standing in for the
    /// window's ([`crate::AppView::set_appearance`]).
    pub(crate) host_dark: Cell<Option<bool>>,
    /// The embedding app's locale and text size, standing in for the
    /// system's ([`crate::AppView::set_locale`], `set_font_scale`).
    pub(crate) host_environment: Cell<nsh_core::platform::HostEnvironment>,
    /// The app's windows of its own besides the main one, oldest first
    /// ([`crate::window`]).
    pub(crate) windows: RefCell<Vec<Rc<crate::window::AppWindow>>>,
    /// While one of those windows handles input, its root: the views input
    /// picks are in it ([`Surface::input_root`], [`crate::window::enter`]).
    pub(crate) input_root: RefCell<Option<NshView>>,
}

impl Surface {
    /// A surface with no app and no window yet.
    pub(crate) fn new(environment: Environment) -> Rc<Surface> {
        let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        let root = NshView::new(ROOT_ID, nsh_core::ViewKind::View);
        let mounter = Mounter::new(root.clone());
        let surface = Rc::new(Surface {
            key,
            root: root.clone(),
            views: mounter.views.clone(),
            mounter: RefCell::new(mounter),
            anim: RefCell::new(UiAnimation::default()),
            nav: RefCell::default(),
            input: Default::default(),
            file_drop: Default::default(),
            engine: RefCell::new(None),
            control: RefCell::new(None),
            rx: RefCell::new(None),
            pending: RefCell::new(Arc::new(AtomicBool::new(false))),
            scale: Cell::new(1.0),
            entity: Cell::new(None),
            main_window: Cell::new(None),
            text_system: RefCell::new(None),
            origin: Cell::new((0.0, 0.0)),
            invalid: Cell::new(false),
            input_pressed: Cell::new(0),
            input_hovered: Cell::new(false),
            window_focus_requested: Cell::new(false),
            window_hidden: Cell::new(false),
            environment: Cell::new(environment),
            appearance: Cell::default(),
            js_frame: Cell::new(false),
            frame_clients: RefCell::default(),
            last_tick: Cell::new(f64::NEG_INFINITY),
            ticking: Cell::new(false),
            restep: Cell::new(false),
            keeper: Cell::new(None),
            shader_renderer: std::cell::OnceCell::new(),
            #[cfg(feature = "dev")]
            test_model: RefCell::default(),
            stats: RefCell::new(None),
            epoch: std::time::Instant::now(),
            on_error: RefCell::new(None),
            #[cfg(feature = "dev")]
            on_dev_error: RefCell::new(None),
            on_hot_update_failed: RefCell::new(None),
            generation: Cell::new(0),
            asset_base: RefCell::new(None),
            image_cache: RefCell::new(None),
            media_files: RefCell::default(),
            access: RefCell::new(Arc::default()),
            native: Default::default(),
            keymap: Default::default(),
            placed: RefCell::default(),
            on_resized: RefCell::default(),
            shortcuts: RefCell::default(),
            batches: Cell::new(0),
            events_sent: Cell::new(0),
            events_handled: Cell::new(0),
            chrome: Default::default(),
            host_theme: RefCell::new(None),
            transparent: Cell::new(false),
            host_dark: Cell::new(None),
            host_environment: Cell::default(),
            windows: RefCell::default(),
            input_root: RefCell::default(),
        });
        SURFACES.with(|s| s.borrow_mut().insert(key, Rc::downgrade(&surface)));
        let weak = Rc::downgrade(&surface);
        root.set_invalidate(Rc::new(move || {
            if let Some(surface) = weak.upgrade() {
                surface.invalidate();
            }
        }));
        surface
    }

    /// The surface with `key`, if it is alive.
    pub(crate) fn by_key(key: u64) -> Option<Rc<Surface>> {
        SURFACES.with(|s| s.borrow().get(&key).and_then(Weak::upgrade))
    }

    /// Its key ([`Surface::by_key`]).
    pub(crate) fn key(&self) -> u64 {
        self.key
    }

    /// Pixels per point (the window's scale factor).
    pub(crate) fn scale(&self) -> f32 {
        self.scale.get()
    }

    /// The GPU device shader views render with ([`crate::shader`]), opened
    /// the first time one asks; without one the app hears that shader views
    /// draw nothing (`shadersAvailable()`).
    pub(crate) fn shader_renderer(&self) -> Option<Rc<nsh_engine::shader::Renderer>> {
        self.shader_renderer
            .get_or_init(|| {
                let renderer =
                    nsh_engine::shader::Renderer::new(nsh_engine::shader::PixelFormat::Bgra);
                if renderer.is_none() {
                    self.control(EngineControl::shaders_unavailable);
                }
                renderer.map(Rc::new)
            })
            .clone()
    }

    /// The root input picks views in: a window's of the app's own while it
    /// handles input ([`crate::window::enter`]), else the main one.
    pub(crate) fn input_root(&self) -> NshView {
        self.input_root
            .borrow()
            .clone()
            .unwrap_or_else(|| self.root.clone())
    }

    /// The surface's size in points.
    pub(crate) fn size(&self) -> (f32, f32) {
        let s = self.root.state();
        (s.frame.size.width.0, s.frame.size.height.0)
    }

    /// Seconds since the surface was made (the animation clock).
    pub(crate) fn clock(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64()
    }

    /// Starts `config`'s app, replacing what ran.
    pub(crate) fn start(self: &Rc<Self>, mut config: EngineConfig) {
        self.stop();
        *self.access.borrow_mut() = Arc::new(match &config.app {
            nsh_engine::App::Js(bundle) => bundle.policy.access(),
            nsh_engine::App::Rust(_) => nsh_engine::Policy::default().access(),
        });
        let env = self.environment.get();
        config.viewport = Size::new(env.window.width, env.window.height);
        config.environment = env;
        // A test session's app: the test's storage, network and trace.
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.borrow() {
            model.set_up_engine(&mut config);
        }
        let (tx, rx) = crossbeam_channel::unbounded();
        let pending = Arc::new(AtomicBool::new(false));
        let sink = Sink {
            key: self.key,
            tx,
            pending: pending.clone(),
        };
        *self.rx.borrow_mut() = Some(rx);
        *self.pending.borrow_mut() = pending;
        let Some(text_system) = self.text_system.borrow().clone() else {
            log::error!("cannot start the engine: the surface is not in a GPUI app yet");
            return;
        };
        let family: Arc<str> = Arc::from(&*crate::text::ui_family_for(&text_system));
        let theme = self.host_theme.borrow().clone();
        match Engine::start_with(
            config,
            move || GpuiTextEngine::new(text_system, family),
            sink,
            |control| {
                if let Some(theme) = theme {
                    control.set_tokens(Some(theme.into_tokens()));
                }
            },
        ) {
            Ok(engine) => {
                // The app's downloaded images go through its disk cache.
                crate::image::set_disk_cache(self, engine.image_cache());
                *self.media_files.borrow_mut() = engine.media_files();
                // The test moves its clock through the engine.
                #[cfg(feature = "dev")]
                if let Some(model) = &*self.test_model.borrow() {
                    model.engine_started(engine.control());
                }
                if self.stats.borrow().is_some() {
                    engine.control().set_perf_monitor(Some(Default::default()));
                }
                *self.control.borrow_mut() = Some(engine.control());
                *self.engine.borrow_mut() = Some(engine);
            }
            Err(err) => log::error!("cannot start the engine: {err}"),
        }
    }

    /// Stops the app and removes its views.
    pub(crate) fn stop(&self) {
        self.generation.set(self.generation.get() + 1);
        // Dropping the engine joins its thread.
        self.control.borrow_mut().take();
        self.engine.borrow_mut().take();
        self.rx.borrow_mut().take();
        crate::window::close_all(self);
        self.mounter.borrow_mut().clear();
        self.native.clear();
        crate::system::clear(self);
        crate::key_focus::forget(self);
        *self.anim.borrow_mut() = UiAnimation::default();
        self.nav.borrow_mut().reset();
        crate::input::reset(self);
        crate::keymap::clear(self);
        crate::text_input::surface_stopped(self.key);
        self.js_frame.set(false);
        self.frame_clients.borrow_mut().clear();
        self.restep.set(false);
        // The timer waiting finds it no longer kept.
        self.keeper.set(None);
        self.events_sent.set(0);
        self.events_handled.set(0);
        self.invalidate();
    }

    /// Calls `f` with the engine's control, if an app runs.
    /// Logs frame statistics once a second, or stops
    /// ([`crate::AppView::set_fps_monitor`]). The engine measures its
    /// commits meanwhile, which `fpsEnabled()` follows.
    pub(crate) fn set_stats(&self, on: bool) {
        *self.stats.borrow_mut() = on.then(Default::default);
        self.control(|c| c.set_perf_monitor(on.then(Default::default)));
    }

    pub(crate) fn control(&self, f: impl FnOnce(&EngineControl)) {
        if let Some(control) = &*self.control.borrow() {
            f(control);
        }
    }

    /// Sends an event to JS.
    pub(crate) fn event(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        self.control(|c| {
            c.dispatch_event(id, kind, payload);
            self.events_sent.set(self.events_sent.get() + 1);
        });
    }

    /// Events sent to the engine so far.
    pub(crate) fn events_sent(&self) -> u64 {
        self.events_sent.get()
    }

    /// Events the engine has handled, with what they changed applied.
    pub(crate) fn events_handled(&self) -> u64 {
        self.events_handled.get()
    }

    /// The view of node `id`.
    pub(crate) fn view(&self, id: NodeId) -> Option<NshView> {
        self.views.get(id)
    }

    /// Shows fatal app errors with `f` (development hosts, embedding apps).
    pub(crate) fn set_error_handler(&self, f: ErrorHandler) {
        *self.on_error.borrow_mut() = Some(Rc::from(f));
    }

    /// Shows fatal app errors with `f` too, besides the handler of
    /// [`Surface::set_error_handler`] (a dev session's overlay).
    #[cfg(feature = "dev")]
    pub(crate) fn set_dev_error_handler(&self, f: ErrorHandler) {
        *self.on_dev_error.borrow_mut() = Some(Rc::from(f));
    }

    /// Runs `f` when a hot update could not be applied in place.
    #[cfg(feature = "dev")]
    pub(crate) fn set_hot_update_failed(&self, f: impl Fn() + 'static) {
        *self.on_hot_update_failed.borrow_mut() = Some(Rc::new(f));
    }

    /// Updates the environment and tells the engine, with the embedding
    /// app's settings over the system's.
    pub(crate) fn set_environment(&self, mut environment: Environment) {
        self.host_environment.get().apply(&mut environment);
        if self.environment.replace(environment) != environment {
            self.control(|c| c.set_environment(environment));
            crate::system::environment_applied(self);
        }
    }

    /// The surface is drawn `width` × `height` points big at `scale`
    /// pixels per point.
    pub(crate) fn resized(self: &Rc<Self>, width: f32, height: f32, scale: f32) {
        let scale_changed = (self.scale.replace(scale) - scale).abs() > f32::EPSILON;
        {
            let mut s = self.root.state_mut();
            if !scale_changed && s.frame.size.width.0 == width && s.frame.size.height.0 == height {
                return;
            }
            s.frame.size.width.0 = width;
            s.frame.size.height.0 = height;
        }
        let mut env = self.environment.get();
        env.window = nsh_core::Size::new(nsh_core::Points(width), nsh_core::Points(height));
        env.pixel_ratio = scale;
        self.environment.set(env);
        self.control(|c| {
            c.resize(Size::new(Points(width), Points(height)));
            c.set_environment(env);
        });
        crate::navigation::surface_resized(self, width, height);
        crate::system::surface_resized(self, width, height);
        for f in self.on_resized.borrow().iter() {
            f(width, height);
        }
        self.invalidate();
    }

    /// Asks for the surface to be drawn again (once, however often asked
    /// before it is): [`flush_all`] notifies its view.
    pub(crate) fn invalidate(&self) {
        if !self.invalid.replace(true) {
            // Entry points flush when they end; a change made anywhere else
            // (a GPUI callback, an observer) is flushed by the main-thread
            // queue, which flushes after its jobs: GPUI's retained frames
            // never show a stale tree.
            crate::rt::invoke(|| {});
        }
    }

    /// It changed since it was last drawn.
    pub(crate) fn invalidated(&self) -> bool {
        self.invalid.get()
    }

    /// The surface is being drawn: what changed so far is in this frame.
    pub(crate) fn drawing(&self) {
        self.invalid.set(false);
    }

    /// Hosted items drawn by the frame just drawn, with their window
    /// bounds: tells them, and the ones no longer drawn.
    pub(crate) fn items_placed(&self, drawn: Vec<(Rc<dyn Hosted>, gpui::Bounds<gpui::Pixels>)>) {
        place_items(&self.placed, drawn);
    }
}

/// Hosted items drawn by a window's frame just drawn, with their window
/// bounds: tells them, and those of `placed` (the window's last frame's)
/// no longer drawn.
pub(crate) fn place_items(
    placed: &RefCell<Vec<Rc<dyn Hosted>>>,
    drawn: Vec<(Rc<dyn Hosted>, gpui::Bounds<gpui::Pixels>)>,
) {
    let mut placed = placed.borrow_mut();
    for old in placed.iter() {
        if !drawn.iter().any(|(item, _)| Rc::ptr_eq(item, old)) {
            old.placed(None);
        }
    }
    placed.clear();
    for (item, rect) in drawn {
        item.placed(Some(rect));
        placed.push(item);
    }
}

impl Surface {
    /// Applies what the engine sent.
    pub(crate) fn drain(self: &Rc<Self>) {
        self.pending.borrow().store(false, Ordering::Release);
        let messages: Vec<Message> = match &*self.rx.borrow() {
            Some(rx) => rx.try_iter().collect(),
            None => return,
        };
        let generation = self.generation.get();
        let mut applied = false;
        for message in messages {
            // A handler restarted or stopped the app: the rest was the old
            // engine's.
            if self.generation.get() != generation {
                return;
            }
            match message {
                Message::Batch(batch) => {
                    self.apply(&batch);
                    applied = true;
                    self.batches.set(self.batches.get() + 1);
                }
                Message::Error(error) => {
                    log::error!("{error}");
                    #[cfg(feature = "dev")]
                    if let Some(model) = &*self.test_model.borrow() {
                        model.error(error.to_string());
                    }
                    #[cfg(feature = "dev")]
                    {
                        let handler = self.on_dev_error.borrow().clone();
                        if let Some(f) = handler {
                            f(&error);
                        }
                    }
                    let handler = self.on_error.borrow().clone();
                    if let Some(f) = handler {
                        f(&error);
                    }
                }
                Message::Frame => self.js_frame.set(true),
                Message::HotUpdateFailed => {
                    let handler = self.on_hot_update_failed.borrow().clone();
                    if let Some(f) = handler {
                        f();
                    }
                }
                Message::Handled(events) => {
                    self.events_handled.set(events);
                    crate::text_input::engine_caught_up(self);
                }
                Message::Run(task) => task.run(),
            }
        }
        if applied {
            self.write_animations();
            // Views may have come under (or gone from under) a still mouse.
            crate::input::rehover(self);
            if !self.frame_clients.borrow().is_empty() {
                self.restep.set(true);
            }
        }
        self.ensure_ticking();
    }

    fn apply(self: &Rc<Self>, batch: &MountBatch) {
        crate::access::prepare(batch);
        for item in &batch.items {
            self.anim.borrow_mut().apply(item);
            if !matches!(
                item,
                MountItem::Animation(_) | MountItem::AnimationBindings { .. }
            ) {
                self.mounter.borrow_mut().apply(self, item);
            }
        }
        self.mounter.borrow_mut().end_batch(self);
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.borrow() {
            model.apply(batch);
        }
        crate::access::batch_applied(self);
        crate::selectable_view::batch_applied(self);
    }

    /// Writes the animated values to the views and reports finished
    /// animations.
    pub(crate) fn write_animations(&self) {
        let (finished, moved) = {
            let mut anim = self.anim.borrow_mut();
            anim.write(&self.mounter.borrow());
            let mut moved = Vec::new();
            anim.write_components(
                |id| crate::native::has_component(self, id),
                |id, name, value| moved.push((id, std::sync::Arc::<str>::from(name), value)),
            );
            (std::mem::take(&mut anim.finished), moved)
        };
        // No surface state borrowed while the app's components run.
        crate::native::component_animated(self, moved);
        crate::scroll::pin_animated_sticky(self);
        if !finished.is_empty() {
            self.control(|c| c.animations_finished(finished));
        }
    }

    /// Calls `f` on every frame (with the frame's time) until it is done
    /// ([`Next`]): transitions, scroll glides, navigation; the first time
    /// by now even while no frames are drawn.
    pub(crate) fn on_frame(self: &Rc<Self>, f: impl FnMut(&Rc<Surface>, f64) -> Next + 'static) {
        let now = self.clock();
        self.frame_clients
            .borrow_mut()
            .push((Box::new(f), Some(now)));
        self.ensure_ticking();
    }

    /// Calls `f` on every frame while it returns true, for what only draws
    /// (a fade, a field waiting to be shown): nothing it does comes due
    /// without frames ([`Next::Frame`]).
    pub(crate) fn on_draw(self: &Rc<Self>, mut f: impl FnMut(&Rc<Surface>, f64) -> bool + 'static) {
        self.frame_clients
            .borrow_mut()
            .push((Box::new(move |surface, now| f(surface, now).into()), None));
        self.ensure_ticking();
    }

    /// [`Surface::on_draw`] while the animation graph is borrowed (its
    /// writes into the views): asks for a frame without looking at it.
    pub(crate) fn add_frame_client(&self, mut f: impl FnMut(&Rc<Surface>, f64) -> bool + 'static) {
        self.frame_clients
            .borrow_mut()
            .push((Box::new(move |surface, now| f(surface, now).into()), None));
        self.invalidate();
    }

    /// Whether a native animation runs: the graph's (not one looping
    /// forever, which no test step waits for), or the platform's own
    /// (scroll glides).
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.anim.borrow().finishing() || !self.frame_clients.borrow().is_empty()
    }

    /// Keeps the model `nsh test --target` steps see of the app
    /// ([`nsh_testing::agent::Model`]): every batch applied and every error
    /// go to it from now on.
    #[cfg(feature = "dev")]
    pub(crate) fn set_test_model(&self, model: Option<std::sync::Arc<nsh_testing::agent::Model>>) {
        *self.test_model.borrow_mut() = model;
    }

    /// Something animates or JS wants a frame: the view keeps drawing
    /// frames ([`crate::render`]).
    pub(crate) fn wants_frames(&self) -> bool {
        self.js_frame.get()
            || self.anim.borrow().animating()
            || !self.frame_clients.borrow().is_empty()
    }

    /// Draws frames while animations run or JS wants a frame, and keeps
    /// their deadlines while no frames come.
    pub(crate) fn ensure_ticking(self: &Rc<Self>) {
        if self.wants_frames() {
            self.invalidate();
            self.keep_deadline();
        }
    }

    /// One animation frame (called while the surface is drawn, before its
    /// views are, or by [`Surface::keep_deadline`] when no frame came).
    pub(crate) fn tick(self: &Rc<Self>) {
        let now = self.clock();
        self.last_tick.set(now);
        self.restep.set(false);
        self.ticking.set(true);
        if self.anim.borrow().animating() {
            self.anim.borrow_mut().tick(now);
            self.write_animations();
        }
        if self.js_frame.replace(false) {
            self.control(|c| c.frame());
        }
        let clients = std::mem::take(&mut *self.frame_clients.borrow_mut());
        let mut kept: Vec<(FrameClient, Option<f64>)> = clients
            .into_iter()
            .filter_map(|(mut f, _)| match f(self, now) {
                Next::Done => None,
                Next::Frame => Some((f, None)),
                Next::At(at) => Some((f, Some(at))),
            })
            .collect();
        // Clients added while running stay after the ones kept.
        let mut added = std::mem::take(&mut *self.frame_clients.borrow_mut());
        kept.append(&mut added);
        *self.frame_clients.borrow_mut() = kept;
        self.ticking.set(false);
        self.keep_deadline();
    }

    /// When the next thing that changes the app's state comes due without
    /// a frame (seconds, [`Surface::clock`]): an animation of the graph or
    /// a frame client ending, or `now` after a batch moved what the frame
    /// clients reported. `None` when only drawing is left: an animation
    /// looping forever, a fade, a JS frame request. Batches are applied as
    /// they arrive ([`Surface::drain`]), never held for a frame.
    fn deadline(&self, now: f64) -> Option<f64> {
        let restep = self.restep.get().then_some(now);
        let clients = self
            .frame_clients
            .borrow()
            .iter()
            .filter_map(|(_, at)| *at)
            .reduce(f64::min);
        [self.anim.borrow().deadline(now), clients, restep]
            .into_iter()
            .flatten()
            .reduce(f64::min)
    }

    /// Makes what comes due happen on time while no frames are drawn: a
    /// window that is not presented (minimized, hidden, a suspended Wayland
    /// toplevel) or a view no longer rendered gets no frames, and
    /// animations must still end (a transition detaches its views when it
    /// does, a modal reports its dismissal, an animation its end to JS). A
    /// timer on the main thread ([`crate::rt::after_ms`]) waits for the
    /// next deadline ([`Surface::deadline`]) and a little more ([`LATE`]);
    /// if no tick ran since it came due, it ticks outside the paint, which
    /// steps everything to the time, ends what ended and gives the next
    /// deadline. Nothing in a tick needs GPUI's window: what it changes
    /// only marks the surface invalid, and the window draws it when it
    /// shows again. While frames come they always tick first and the timer
    /// only schedules the next; nothing is scheduled for what only draws
    /// (a spinner, a JS frame request), so a hidden window with an endless
    /// animation does no work.
    fn keep_deadline(self: &Rc<Self>) {
        // The tick schedules when it ends, with every client's deadline.
        if self.ticking.get() {
            return;
        }
        let now = self.clock();
        let Some(at) = self.deadline(now) else {
            return;
        };
        // One timer at a time: the one waiting for an earlier deadline
        // schedules the next when it fires.
        if self.keeper.get().is_some_and(|pending| pending <= at) {
            return;
        }
        self.keeper.set(Some(at));
        let key = self.key;
        let ms = ((at + LATE - now).max(0.0) * 1000.0).ceil() as u64;
        crate::rt::after_ms(ms, move || {
            let Some(surface) = Surface::by_key(key) else {
                return;
            };
            // An earlier deadline (or a restart) took its place.
            if surface.keeper.get() != Some(at) {
                return;
            }
            surface.keeper.set(None);
            if surface.last_tick.get() < at && surface.wants_frames() {
                surface.tick();
            } else {
                surface.keep_deadline();
            }
        });
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        let key = self.key;
        let _ = SURFACES.try_with(|s| s.borrow_mut().remove(&key));
    }
}

/// Notifies the views of this thread's surfaces that changed, and those
/// of their windows of their own.
pub(crate) fn flush_all(cx: &mut gpui::App) {
    let ids: Vec<gpui::EntityId> = SURFACES.with(|s| {
        let mut ids = Vec::new();
        for surface in s.borrow().values().filter_map(Weak::upgrade) {
            crate::window::changed_windows(&surface, &mut ids);
            if !surface.invalid.get() {
                continue;
            }
            if let Some(stats) = surface.stats.borrow_mut().as_mut() {
                stats.notified();
            }
            ids.extend(surface.entity.get());
        }
        ids
    });
    for id in ids {
        cx.notify(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(text: &str) -> AppError {
        AppError::new(nsh_engine::AppErrorKind::Uncaught, text)
    }

    /// A surface draining `messages` as if an engine had sent them.
    fn sent(surface: &Surface, messages: Vec<Message>) {
        let (tx, rx) = crossbeam_channel::unbounded();
        for m in messages {
            tx.send(m).unwrap();
        }
        *surface.rx.borrow_mut() = Some(rx);
    }

    #[test]
    fn the_hosts_locale_and_text_size_stand_in_for_the_systems() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let zh = nsh_engine::Locale::parse("zh-Hans-CN");
        surface
            .host_environment
            .set(nsh_core::platform::HostEnvironment {
                locale: zh,
                font_scale: Some(1.5),
            });
        // What the system reports goes under the host's settings.
        surface.set_environment(nsh_engine::Environment {
            font_scale: 1.25,
            ..Default::default()
        });
        let env = surface.environment.get();
        assert_eq!((Some(env.locale), env.font_scale), (zh, 1.5));
        surface.host_environment.set(Default::default());
        surface.set_environment(nsh_engine::Environment {
            font_scale: 1.25,
            ..Default::default()
        });
        let env = surface.environment.get();
        assert_eq!(
            (env.locale, env.font_scale),
            (nsh_engine::Locale::EN_US, 1.25)
        );
    }

    #[test]
    fn an_error_handler_restarting_the_app_drops_the_old_engines_messages() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let weak = Rc::downgrade(&surface);
        surface.set_error_handler(Box::new(move |_| {
            let surface = weak.upgrade().unwrap();
            // What a restart does first; setting a handler again must not
            // find it borrowed.
            surface.stop();
            surface.set_error_handler(Box::new(|_| {}));
        }));
        sent(
            &surface,
            vec![
                Message::Error(error("boom")),
                Message::Batch(MountBatch::default()),
            ],
        );
        surface.drain();
        assert_eq!(surface.batches.get(), 0);
    }

    #[test]
    fn messages_apply_in_order_without_a_restart() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let errors = Rc::new(Cell::new(0));
        let seen = errors.clone();
        surface.set_error_handler(Box::new(move |_| seen.set(seen.get() + 1)));
        sent(
            &surface,
            vec![
                Message::Error(error("first")),
                Message::Batch(MountBatch::default()),
                Message::Error(error("second")),
            ],
        );
        surface.drain();
        assert_eq!((errors.get(), surface.batches.get()), (2, 1));
    }

    #[cfg(feature = "dev")]
    #[test]
    fn a_dev_session_hears_errors_besides_the_embedding_apps_handler() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let heard = Rc::new(RefCell::new(Vec::new()));
        let host = heard.clone();
        surface.set_error_handler(Box::new(move |m| {
            host.borrow_mut().push(format!("host {m}"))
        }));
        let dev = heard.clone();
        surface.set_dev_error_handler(Box::new(move |m| dev.borrow_mut().push(format!("dev {m}"))));
        sent(&surface, vec![Message::Error(error("boom"))]);
        surface.drain();
        assert_eq!(*heard.borrow(), ["dev boom", "host boom"]);
    }

    #[test]
    fn the_error_handler_hears_what_went_wrong_and_the_package() {
        let surface = Surface::new(nsh_engine::Environment::default());
        let heard = Rc::new(RefCell::new(Vec::new()));
        let seen = heard.clone();
        surface.set_error_handler(Box::new(move |e| seen.borrow_mut().push(e.clone())));
        let package = std::sync::Arc::new(nsh_engine::PackageInfo {
            id: "com.example.app".into(),
            name: "App".into(),
            version: "1.0.0".into(),
            build: 7,
            sha256: "0".repeat(64),
        });
        let stopped = AppError::new(nsh_engine::AppErrorKind::Stopped, "out of memory")
            .with_package(Some(package));
        sent(&surface, vec![Message::Error(stopped.clone())]);
        surface.drain();
        let heard = heard.borrow();
        assert_eq!(*heard, [stopped]);
        assert!(heard[0].is_fatal());
        assert_eq!(heard[0].package.as_ref().map(|p| p.build), Some(7));
    }
}
