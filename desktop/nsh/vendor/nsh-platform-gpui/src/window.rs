//! The app's windows: the main one (the surface's, [`crate::chrome`]) and
//! its windows of its own (`<Window>`, `Window.open`), each a dialog root (a
//! `modal` node) of the same engine shown in a GPUI window of its own
//! instead of over the main window. The engine, the JS runtime and the core
//! stay one, so the windows share the app's state.
//!
//! - Opening ([`open`]): the root leaves the main window's modals and tree
//!   ([`crate::navigation::release`]) and becomes the root of a tree of its
//!   own, whose changes ask its window to draw. Its GPUI window opens hidden
//!   on the main thread's next turn with every attribute the core resolved
//!   (the kind's defaults with the app's over them) and shows once its first
//!   frame is drawn, so it never flashes empty.
//! - Drawing ([`WindowView`], [`WindowElement`]): the root fills the window;
//!   its size is the root's (`EngineControl::set_root_size`), which the core
//!   lays the root out at.
//! - Input: the surface's. While one of its listeners runs, the surface's
//!   input picks views in its root ([`enter`], [`Surface::input_root`]).
//! - Attributes and requests: [`apply`] and [`request`], on the GPUI window
//!   and, for what GPUI has no call for, the native window ([`native`]).
//! - The close policies (`closeOnPress`, `closeOnEscape`, `closeOnBlur`)
//!   are read here, on the main thread: a window closing by one hides at
//!   once and the app hears it ([`WindowEvent`]), then removes the root,
//!   which closes the GPUI window ([`removed`]).
//! - Its state (bounds, mode, focus, display) is reported on its root as it
//!   changes, moves and resizes once they settle; the main window's is the
//!   environment's ([`observe_main`]).

mod native;
pub(crate) mod screen;

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use gpui::{
    AnyWindowHandle, App, AppContext, Bounds, Context, Element, ElementId, FocusHandle,
    GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId, InteractiveElement, IntoElement,
    LayoutId, ParentElement, Pixels, Render, Styled, Subscription, Window, px,
};
use nsh_core::{
    EdgeInsets, EventKind, EventPayload, NodeId, Points, ROOT_ID, Size,
    desktop::{
        Backdrop, CloseReason, DesktopCommand, Display, DisplayId, OpenWindow, ResizeEdge,
        TitleBarStyle, WindowAttributes, WindowCloseCause, WindowControl, WindowEvent,
        WindowFrameStyle, WindowKind, WindowMode, WindowPlacement, WindowPointerEvents,
        WindowPosition, WindowRequest, WindowState,
    },
    geometry::Edges,
};

use crate::{
    geom::Mat4,
    input::WindowPart,
    surface::Surface,
    view::{Hosted, NshView},
};

/// How long a window must stay where the user moved or resized it before
/// the app hears of it.
const SETTLE_MS: u64 = 250;

/// A window's size before the app or the user gives it one.
const DEFAULT_SIZE: (f32, f32) = (480.0, 360.0);

/// A window of the app's own.
pub(crate) struct AppWindow {
    /// The dialog root it shows.
    pub(crate) id: NodeId,
    view: NshView,
    kind: WindowKind,
    /// It blocks its parent's input while it shows.
    modal: bool,
    /// The root node of the window it belongs to.
    parent: Option<NodeId>,
    /// Every attribute (resolved when it opened, the diffs merged since).
    attributes: RefCell<WindowAttributes>,
    /// The GPUI window, once open.
    handle: Cell<Option<AnyWindowHandle>>,
    /// Its view, notified when the tree changed.
    entity: Cell<Option<gpui::EntityId>>,
    /// What came before the GPUI window opened.
    queued: RefCell<Vec<WindowRequest>>,
    /// Its tree changed since it was last drawn.
    invalid: Cell<bool>,
    /// Where its root was drawn last, in window coordinates.
    origin: Cell<(f32, f32)>,
    /// The size last reported to the core.
    reported: Cell<Option<Size<Points>>>,
    /// Its first frame is drawn and it was shown.
    shown: Cell<bool>,
    /// Hidden by the app (`hide()`) or by a close policy.
    hidden: Cell<bool>,
    /// The state the app last heard of.
    state: Cell<Option<WindowState>>,
    /// The title bar's area the app last heard of.
    title_bar: Cell<Option<Edges<Points>>>,
    /// Counts bounds changes: a settle timer reports only the last.
    settle: Cell<u64>,
    /// Hosted items its last frame drew.
    placed: RefCell<Vec<Rc<dyn Hosted>>>,
    /// The GPUI window's observers.
    subscriptions: RefCell<Vec<Subscription>>,
}

impl AppWindow {
    fn attribute<T>(&self, f: impl FnOnce(&WindowAttributes) -> Option<T>) -> Option<T> {
        f(&self.attributes.borrow())
    }

    fn flag(&self, f: impl FnOnce(&WindowAttributes) -> Option<bool>, default: bool) -> bool {
        self.attribute(f).unwrap_or(default)
    }

    /// Asks for it to be drawn again.
    fn invalidate(&self) {
        if !self.invalid.replace(true) {
            crate::rt::invoke(|| {});
        }
    }
}

/// The window showing dialog root `id`.
fn get(surface: &Surface, id: NodeId) -> Option<Rc<AppWindow>> {
    surface
        .windows
        .borrow()
        .iter()
        .find(|w| w.id == id)
        .cloned()
}

/// Adds the views of `surface`'s windows that changed since they were
/// drawn to `ids` (to notify).
pub(crate) fn changed_windows(surface: &Surface, ids: &mut Vec<gpui::EntityId>) {
    let Ok(windows) = surface.windows.try_borrow() else {
        return;
    };
    for w in windows.iter() {
        if w.invalid.get()
            && let Some(id) = w.entity.get()
        {
            ids.push(id);
        }
    }
}

/// Node `id` is the root of a window of the app's own.
pub(crate) fn is_root(surface: &Surface, id: NodeId) -> bool {
    surface.windows.borrow().iter().any(|w| w.id == id)
}

/// The root view of window `id` of the app's own.
pub(crate) fn root_view(surface: &Surface, id: NodeId) -> Option<NshView> {
    get(surface, id).map(|w| w.view.clone())
}

/// The root node of the window `view` shows in: a window of the app's own,
/// else the main window ([`ROOT_ID`]).
pub(crate) fn root_of(surface: &Surface, view: &NshView) -> NodeId {
    let mut top = view.clone();
    while let Some(parent) = top.parent_view() {
        top = parent;
    }
    let id = top.id();
    if id != ROOT_ID && get(surface, id).is_some() {
        id
    } else {
        ROOT_ID
    }
}

/// The window with the keyboard focus as the app last heard: a window of
/// the app's own, else the main window ([`ROOT_ID`]).
pub(crate) fn focused_root(surface: &Surface) -> NodeId {
    surface
        .windows
        .borrow()
        .iter()
        .find(|w| w.state.get().is_some_and(|s| s.focused && s.visible))
        .map_or(ROOT_ID, |w| w.id)
}

/// Every window of the app's own draws again (what changed draws nothing:
/// accessibility follows it).
pub(crate) fn invalidate_all(surface: &Surface) {
    let mut any = false;
    for w in surface.windows.borrow().iter() {
        any |= !w.invalid.replace(true);
    }
    if any {
        crate::rt::invoke(|| {});
    }
}

// --- Input ------------------------------------------------------------------------------

/// While dropped later, the surface's input picks views in the root of
/// window `root` (none: the main window's) and its points are that
/// window's.
pub(crate) fn enter(surface: &Surface, root: Option<NodeId>) -> Entered<'_> {
    let Some(window) = root.and_then(|id| get(surface, id)) else {
        return Entered {
            surface,
            outer: None,
        };
    };
    let view = window.view.clone();
    let outer_root = surface.input_root.replace(Some(view));
    let outer_origin = surface.origin.replace(window.origin.get());
    Entered {
        surface,
        outer: Some((outer_root, outer_origin)),
    }
}

/// Restores the surface's input root when dropped ([`enter`]).
pub(crate) struct Entered<'a> {
    surface: &'a Surface,
    outer: Option<(Option<NshView>, (f32, f32))>,
}

impl Drop for Entered<'_> {
    fn drop(&mut self) {
        if let Some((root, origin)) = self.outer.take() {
            *self.surface.input_root.borrow_mut() = root;
            self.surface.origin.set(origin);
        }
    }
}

/// The window of the app's own whose input is handled now, if any.
pub(crate) fn entered(surface: &Surface) -> Option<NodeId> {
    let root = surface.input_root.borrow().as_ref().map(NshView::id)?;
    (root != ROOT_ID).then_some(root)
}

/// The window `root` (none: the main one) is under a modal window of the
/// app's own that shows: its input goes nowhere, and that window comes to
/// the front.
pub(crate) fn blocked(surface: &Surface, root: Option<NodeId>, cx: &mut App) -> bool {
    let owner = root.unwrap_or(ROOT_ID);
    let modal = surface
        .windows
        .borrow()
        .iter()
        .rev()
        .find(|w| {
            w.modal && w.shown.get() && !w.hidden.get() && w.parent.unwrap_or(ROOT_ID) == owner
        })
        .cloned();
    let Some(modal) = modal else {
        return false;
    };
    if let Some(handle) = modal.handle.get() {
        let _ = handle.update(cx, |_, window, cx| activate_window(window, cx));
    }
    true
}

/// The user may move window `root` (none: the main one) by its
/// `windowDrag` views.
pub(crate) fn movable(surface: &Surface, root: Option<NodeId>) -> bool {
    match root.and_then(|id| get(surface, id)) {
        Some(w) => w.flag(|a| a.movable, true),
        None => surface.chrome.attributes.borrow().movable.unwrap_or(true),
    }
}

thread_local! {
    /// A press on a view standing for a window control, until released:
    /// (surface key, window, control).
    static CONTROL_PRESS: Cell<Option<(u64, Option<NodeId>, WindowControl)>> =
        const { Cell::new(None) };
}

/// The primary button went down on a view standing for part of window
/// `root` (none: the main one): an edge resizes it at once, a control acts
/// when released over it ([`part_released`]).
pub(crate) fn part_pressed(
    surface: &Rc<Surface>,
    root: Option<NodeId>,
    part: WindowPart,
    window: &mut Window,
    _cx: &mut App,
) {
    match part {
        WindowPart::Resize(edge) => {
            if resizable(surface, root) {
                window.start_window_resize(gpui_edge(edge));
            }
        }
        WindowPart::Control(control) => {
            CONTROL_PRESS.set(Some((surface.key(), root, control)));
        }
    }
}

/// The primary button went up at `(x, y)` (root coordinates): a control
/// pressed and released over the same part acts. True when a control press
/// ended (whatever it did).
pub(crate) fn part_released(
    surface: &Rc<Surface>,
    root: Option<NodeId>,
    x: f32,
    y: f32,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let Some((key, pressed_root, control)) = CONTROL_PRESS.take() else {
        return false;
    };
    if key != surface.key() || pressed_root != root {
        return true;
    }
    if crate::input::window_part(surface, x, y) != Some(WindowPart::Control(control)) {
        return true;
    }
    control_pressed(surface, root, control, window, cx);
    true
}

/// A view standing for a window control was clicked (or a drawn one).
fn control_pressed(
    surface: &Rc<Surface>,
    root: Option<NodeId>,
    control: WindowControl,
    window: &mut Window,
    _cx: &mut App,
) {
    let own = root.and_then(|id| get(surface, id));
    match control {
        WindowControl::Minimize => window.minimize_window(),
        WindowControl::Maximize => {
            if !window.is_fullscreen() {
                window.zoom_window();
            }
        }
        WindowControl::Close => match own {
            Some(w) => close_press(surface, w.id, CloseReason::CloseButton),
            None => {
                if crate::chrome::close_press(surface, CloseReason::CloseButton) {
                    let surface = surface.clone();
                    window.defer(_cx, move |window, cx| close_main(&surface, window, cx));
                }
            }
        },
    }
}

/// Window `root` (none: the main one) may be resized by the user.
fn resizable(surface: &Surface, root: Option<NodeId>) -> bool {
    match root.and_then(|id| get(surface, id)) {
        Some(w) => w.flag(|a| a.resizable, true),
        None => surface.chrome.attributes.borrow().resizable.unwrap_or(true),
    }
}

fn gpui_edge(edge: ResizeEdge) -> gpui::ResizeEdge {
    match edge {
        ResizeEdge::Top => gpui::ResizeEdge::Top,
        ResizeEdge::Bottom => gpui::ResizeEdge::Bottom,
        ResizeEdge::Left => gpui::ResizeEdge::Left,
        ResizeEdge::Right => gpui::ResizeEdge::Right,
        ResizeEdge::TopLeft => gpui::ResizeEdge::TopLeft,
        ResizeEdge::TopRight => gpui::ResizeEdge::TopRight,
        ResizeEdge::BottomLeft => gpui::ResizeEdge::BottomLeft,
        ResizeEdge::BottomRight => gpui::ResizeEdge::BottomRight,
    }
}

/// A reserved key of the standalone app pressed in window `id`: it
/// minimizes, or goes to full screen and back.
pub(crate) fn reserved_key(surface: &Rc<Surface>, id: NodeId, full_screen: bool) {
    let Some(w) = get(surface, id) else { return };
    with_window(&w, move |window, _| {
        if full_screen {
            window.toggle_fullscreen();
        } else {
            window.minimize_window();
        }
    });
}

/// Escape went down in window `root` and nothing took it: a window with
/// `closeOnEscape` closes. True when it did.
pub(crate) fn escape(
    surface: &Rc<Surface>,
    root: Option<NodeId>,
    _window: &mut Window,
    _cx: &mut App,
) -> bool {
    let Some(w) = root.and_then(|id| get(surface, id)) else {
        return false;
    };
    if !w.flag(|a| a.close_on_escape, false) || w.hidden.get() {
        return false;
    }
    close_by_policy(surface, &w, WindowCloseCause::Escape);
    true
}

// --- `nsh test`'s agent -------------------------------------------------------------------

/// Runs `f` in window `id` of the app's own, as its input runs: on its GPUI
/// window, with its root the input root, its view focused first when
/// `focus` (a press focuses it). `None` while it is not open.
#[cfg(feature = "dev")]
pub(crate) fn act_in<R>(
    surface: &Rc<Surface>,
    id: NodeId,
    focus: bool,
    cx: &mut App,
    f: impl FnOnce(&Rc<Surface>, &mut Window, &mut App) -> R,
) -> Option<R> {
    let handle = get(surface, id)?.handle.get()?;
    handle
        .update(cx, |_, window, cx| {
            if focus && let Some(Some(view)) = window.root::<WindowView>() {
                let handle = view.read(cx).focus.clone();
                if !handle.is_focused(window) {
                    window.focus(&handle, cx);
                }
            }
            let _in = enter(surface, Some(id));
            let r = f(surface, window, cx);
            crate::rt::flush(cx);
            r
        })
        .ok()
}

/// The window of the app's own with the keyboard focus, if one has it.
#[cfg(feature = "dev")]
pub(crate) fn focused(surface: &Surface, cx: &App) -> Option<NodeId> {
    let active = cx.active_window().or_else(|| background_key(cx))?;
    surface
        .windows
        .borrow()
        .iter()
        .find(|w| w.handle.get() == Some(active))
        .map(|w| w.id)
}

/// Window `id`'s state as it would be reported now ([`ROOT_ID`]: the main
/// window's); `None` while it is not open.
#[cfg(feature = "dev")]
pub(crate) fn state_now(surface: &Surface, id: NodeId, cx: &mut App) -> Option<WindowState> {
    let visible = match id {
        // The main window's own (`native::visible`).
        ROOT_ID => None,
        id => {
            let w = get(surface, id)?;
            Some(w.shown.get() && !w.hidden.get())
        }
    };
    let handle = handle_of(surface, id)?;
    handle
        .update(cx, |_, window, cx| {
            let visible = visible.unwrap_or_else(|| native::visible(window));
            read_state(window, visible, cx)
        })
        .ok()
}

/// A press of window `id`'s close button ([`ROOT_ID`]: the main window's),
/// through the path the button's press takes.
#[cfg(feature = "dev")]
pub(crate) fn press_close_button(surface: &Rc<Surface>, id: NodeId) -> Result<(), String> {
    match id {
        ROOT_ID => crate::chrome::press_close(surface, CloseReason::CloseButton),
        id => {
            let w = get(surface, id).ok_or("the window is not open")?;
            if w.handle.get().is_none() {
                return Err("the window is not open".into());
            }
            if !w.flag(|a| a.closable, true) {
                return Err("the window has no close button (`closable: false`)".into());
            }
            close_press(surface, id, CloseReason::CloseButton);
        }
    }
    Ok(())
}

/// The GPUI window of window `id` of the app's own, once open.
#[cfg(feature = "dev")]
pub(crate) fn handle(surface: &Surface, id: NodeId) -> Option<AnyWindowHandle> {
    get(surface, id)?.handle.get()
}

/// Window `id` of the app's own is open (the agent may act in it).
#[cfg(feature = "dev")]
pub(crate) fn is_open(surface: &Surface, id: NodeId) -> bool {
    get(surface, id).is_some_and(|w| w.handle.get().is_some())
}

// --- Running in the background ----------------------------------------------------------

/// The standalone app runs in the background ([`crate::AppOptions::background`],
/// `nsh test`'s apps): it never activates, so the keyboard stays with the
/// app the user works in. The system gives none of its windows the
/// keyboard; the one that would have it is kept here, and the app sees it
/// as focused (its state, its focused field's caret), as the test agent's
/// keys go to it.
struct Background {
    key: Cell<Option<AnyWindowHandle>>,
}

impl gpui::Global for Background {}

/// Runs the app in the background from now on (before its first window).
pub(crate) fn run_in_background(cx: &mut App) {
    cx.set_global(Background {
        key: Cell::new(None),
    });
    native::run_in_background();
}

/// Runs the app in the background from now on, or no longer, leaving the
/// platform's app as it is (the tests' is GPUI's test platform's).
#[cfg(all(test, feature = "shot"))]
pub(crate) fn set_in_background(on: bool, cx: &mut App) {
    if on {
        cx.set_global(Background {
            key: Cell::new(None),
        });
    } else if in_background(cx) {
        cx.remove_global::<Background>();
    }
}

/// Whether the app runs in the background ([`run_in_background`]).
pub(crate) fn in_background(cx: &App) -> bool {
    cx.has_global::<Background>()
}

/// The window that would have the keyboard in a background app.
fn background_key(cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<Background>()?.key.get()
}

/// Whether `window` has the keyboard (`WindowState.focused`, a field's
/// caret): it is the active window, or the one that would be in a
/// background app while it shows (the system gives a hidden or minimized
/// window's keyboard to another).
pub(crate) fn is_active(window: &Window, cx: &App) -> bool {
    window.is_window_active()
        || (background_key(cx) == Some(window.window_handle()) && shows(window))
}

/// On screen: neither hidden nor minimized.
fn shows(window: &Window) -> bool {
    native::visible(window) && !native::minimized(window)
}

/// Activates the app and gives `window` the keyboard (a press in it, its
/// `focus()`); in a background app it only becomes the window that would
/// have the keyboard.
pub(crate) fn focus_window(window: &mut Window, cx: &mut App) {
    if in_background(cx) {
        became_key(window.window_handle(), cx);
        return;
    }
    cx.activate(true);
    window.activate_window();
}

/// Gives `window` the keyboard within the app, which stays as active as
/// it was; in a background app it becomes the window that would have it.
fn activate_window(window: &mut Window, cx: &mut App) {
    if in_background(cx) {
        became_key(window.window_handle(), cx);
    } else {
        window.activate_window();
    }
}

/// Shows `window` (hidden or opened unshown), activating the app and giving
/// it the keyboard when `activate`; a background app's shows without
/// activating anything, the window that would have the keyboard.
pub(crate) fn show_window(window: &mut Window, activate: bool, cx: &mut App) {
    let keep = keeps_size(cx);
    // AppKit fits a window to its screen as it orders it in: one that keeps
    // its size is ordered in here first, its frame put back, and activates
    // once it shows.
    let ordered_here = in_background(cx) || (keep && cfg!(target_os = "macos"));
    native::show(window, activate && !ordered_here, keep);
    // `native::show` leaves one that activates to GPUI (on macOS, which
    // draws it again as it shows), which also shows a window hidden since
    // it opened.
    if activate {
        focus_window(window, cx);
    }
}

/// Out of the minimized state ([`native::restore`]), which on Linux
/// activates the window: a background app's stays as it is there.
fn restore(window: &mut Window, cx: &App) {
    if !(cfg!(target_os = "linux") && in_background(cx)) {
        native::restore(window);
    }
}

/// `handle` became the window that would have the keyboard in a background
/// app. GPUI reports no activation for it: both it and the one that was
/// draw again and report their state as on an activation change, and the
/// one that was hears it lost the keyboard.
fn became_key(handle: AnyWindowHandle, cx: &mut App) {
    let Some(old) = cx
        .try_global::<Background>()
        .map(|b| b.key.replace(Some(handle)))
    else {
        return;
    };
    if old == Some(handle) {
        return;
    }
    // On the next turn: `handle` may be the window being updated now.
    crate::rt::on_app(move |cx| {
        for h in old.into_iter().chain([handle]) {
            let _ = h.update(cx, key_changed);
        }
    });
}

/// Window `handle` hid or closed: in a background app, when it was the
/// window that would have the keyboard, the main window `main` becomes it
/// if it shows, as the system gives the keyboard to the next window.
fn lost_key(handle: AnyWindowHandle, main: Option<AnyWindowHandle>, cx: &mut App) {
    let Some(background) = cx.try_global::<Background>() else {
        return;
    };
    if background.key.get() != Some(handle) {
        return;
    }
    background.key.set(None);
    let main = main
        .filter(|&m| m != handle)
        .filter(|m| m.update(cx, |_, window, _| shows(window)).unwrap_or(false));
    if let Some(main) = main {
        became_key(main, cx);
    }
}

/// What an activation change does, for a change GPUI does not report (the
/// window that would have the keyboard in a background app).
fn key_changed(root: gpui::AnyView, window: &mut Window, cx: &mut App) {
    match root.downcast::<WindowView>() {
        Ok(view) => view.update(cx, |view, cx| view.activation_changed(window, cx)),
        Err(root) => {
            if let Ok(view) = root.downcast::<crate::AppView>() {
                let surface = view.read(cx).surface().clone();
                if !is_active(window, cx) {
                    crate::keymap::forget_held(&surface);
                }
                // Its state now: it goes to the app as it renders, and a
                // window covered by others draws no frames.
                observe_main(&surface, window, cx);
            }
            window.refresh();
        }
    }
}

// --- Where windows open -----------------------------------------------------------------

/// Where [`crate::run_app`]'s windows open ([`crate::AppOptions::display`],
/// [`crate::AppOptions::keep_size`]).
struct Placement {
    display: Option<gpui::DisplayId>,
    keep_size: bool,
}

impl gpui::Global for Placement {}

/// The standalone app's windows open centered on `display` from now on, at
/// their size when `keep_size` whether or not they fit on it.
pub(crate) fn place_windows(display: Option<crate::WindowDisplay>, keep_size: bool, cx: &mut App) {
    let display = display.and_then(|d| resolve_display(d, cx));
    cx.set_global(Placement { display, keep_size });
}

/// The display windows that name none open on ([`place_windows`]).
pub(crate) fn default_display(cx: &App) -> Option<gpui::DisplayId> {
    cx.try_global::<Placement>()?.display
}

/// Whether windows keep their size on a display they do not fit on.
fn keeps_size(cx: &App) -> bool {
    cx.try_global::<Placement>().is_some_and(|p| p.keep_size)
}

/// The bounds of a window of `size` centered on `display` (the primary one
/// when `None` or gone): fitted on it, unless windows keep their size, when
/// one larger than the display keeps its top left corner on it.
pub(crate) fn centered(
    display: Option<gpui::DisplayId>,
    size: gpui::Size<Pixels>,
    cx: &App,
) -> Bounds<Pixels> {
    let screen = display
        .and_then(|id| cx.find_display(id))
        .or_else(|| cx.primary_display());
    match screen {
        Some(screen) if keeps_size(cx) => centered_keeping_size(screen.visible_bounds(), size),
        _ => Bounds::centered(display, size, cx),
    }
}

/// `size` centered on `area`, its top left corner kept on it when it is
/// larger (the title bar stays on the screen, as AppKit keeps it).
fn centered_keeping_size(area: Bounds<Pixels>, size: gpui::Size<Pixels>) -> Bounds<Pixels> {
    let x = area.origin.x + ((area.size.width - size.width) / 2.0).max(px(0.0));
    let y = area.origin.y + ((area.size.height - size.height) / 2.0).max(px(0.0));
    Bounds::new(gpui::point(x, y), size)
}

/// The display `which` names, if there is one.
fn resolve_display(which: crate::WindowDisplay, cx: &App) -> Option<gpui::DisplayId> {
    let displays = native::displays(cx);
    let index = match which {
        crate::WindowDisplay::Index(index) => index,
        crate::WindowDisplay::Secondary => {
            let frames: Vec<_> = displays.iter().map(|(_, frame)| *frame).collect();
            secondary(&frames)?
        }
    };
    let display = displays.get(index).map(|(id, _)| *id);
    if display.is_none() {
        log::warn!(
            "there is no display {} ({} connected): the windows open on the primary one",
            index + 1,
            displays.len()
        );
    }
    display
}

/// The first of the displays (their frames in the desktop, the primary
/// display's first) besides the primary one that does not mirror it: a
/// mirror shows the same part of the desktop, so its frame is the
/// primary's.
fn secondary<T: PartialEq>(frames: &[T]) -> Option<usize> {
    let primary = frames.first()?;
    frames.iter().position(|f| f != primary)
}

/// GPUI's displays with their frames in the desktop, the primary one
/// first (what [`native::displays`] is where the platform has nothing
/// better).
#[allow(dead_code)]
fn gpui_displays(cx: &App) -> Vec<(gpui::DisplayId, Bounds<Pixels>)> {
    let mut displays: Vec<_> = cx.displays().iter().map(|d| (d.id(), d.bounds())).collect();
    if let Some(primary) = cx.primary_display().map(|d| d.id())
        && let Some(i) = displays.iter().position(|(id, _)| *id == primary)
    {
        let primary = displays.remove(i);
        displays.insert(0, primary);
    }
    displays
}

// --- The close policies -----------------------------------------------------------------

/// What a close press does to a window: whether it closes, decided by the
/// app's `closeOnPress` beforehand.
pub(crate) fn closes_on_press(close_on_press: Option<bool>) -> bool {
    close_on_press.unwrap_or(true)
}

/// Tells the app the user asked to close window `id` (`reason`), and, when
/// the platform closed it already, that it did.
pub(crate) fn report_close_press(surface: &Surface, id: NodeId, reason: CloseReason, closed: bool) {
    surface.event(
        id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::ClosePress { reason })),
    );
    if closed {
        report_closed(surface, id, WindowCloseCause::ClosePress);
    }
}

fn report_closed(surface: &Surface, id: NodeId, cause: WindowCloseCause) {
    surface.event(
        id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::Closed { cause })),
    );
}

/// The user asked to close window `id` (its close button, a key, a menu):
/// it closes at once unless the app set `closeOnPress: false`, and the app
/// hears of it either way.
pub(crate) fn close_press(surface: &Rc<Surface>, id: NodeId, reason: CloseReason) {
    let Some(w) = get(surface, id) else { return };
    if w.hidden.get() {
        return;
    }
    let closes = closes_on_press(w.attribute(|a| a.close_on_press));
    report_close_press(surface, id, reason, false);
    if closes {
        close_by_policy(surface, &w, WindowCloseCause::ClosePress);
    }
}

/// Window `w` closes by itself: it hides now, the windows that belong to
/// it with it, and the app hears it closed, then removes its root.
fn close_by_policy(surface: &Rc<Surface>, w: &Rc<AppWindow>, cause: WindowCloseCause) {
    hide(surface, w);
    report_closed(surface, w.id, cause);
    close_children(surface, w.id);
}

/// The windows that belong to window `id` close with it.
fn close_children(surface: &Rc<Surface>, id: NodeId) {
    let children: Vec<Rc<AppWindow>> = surface
        .windows
        .borrow()
        .iter()
        .filter(|w| w.parent == Some(id) && !w.hidden.get())
        .cloned()
        .collect();
    for child in children {
        close_by_policy(surface, &child, WindowCloseCause::ParentClose);
    }
}

/// Closes the main window (its close press closes it): the embedding app's
/// handler decides when it set one.
fn close_main(surface: &Surface, window: &mut Window, cx: &mut App) {
    if !crate::chrome::ask_to_close(surface, crate::CloseRequest::Close, window, cx) {
        window.remove_window();
    }
}

/// The main window's close button (or the system) asked to close it: what
/// GPUI's should-close callback answers.
pub(crate) fn main_should_close(surface: &Surface, window: &mut Window, cx: &mut App) -> bool {
    if !crate::chrome::close_press(surface, CloseReason::CloseButton) {
        return false;
    }
    !crate::chrome::ask_to_close(surface, crate::CloseRequest::Close, window, cx)
}

// --- Commands ---------------------------------------------------------------------------

/// A desktop command addressed to node `id`: the main window's ([`ROOT_ID`])
/// go to the chrome, the others to the window of the app's own showing
/// dialog root `id`.
pub(crate) fn command(
    surface: &Rc<Surface>,
    id: NodeId,
    view: Option<&NshView>,
    command: &DesktopCommand,
) {
    if id == ROOT_ID {
        return crate::chrome::command(surface, command);
    }
    match command {
        DesktopCommand::OpenWindow(open_window) => {
            let Some(view) = view else {
                return log::warn!("window: no view {id}");
            };
            open(surface, view, open_window);
        }
        DesktopCommand::SetAttributes(attributes) => {
            let Some(w) = get(surface, id) else {
                return log::debug!("window: no window for {id}");
            };
            w.attributes.borrow_mut().merge(attributes);
            let attributes = (**attributes).clone();
            let s = Rc::downgrade(surface);
            let window = w.clone();
            with_window(&w, move |gw, cx| {
                if let Some(surface) = s.upgrade() {
                    apply(&surface, Some(&window), gw, &attributes, cx);
                }
            });
            w.invalidate();
        }
        DesktopCommand::Request(r) => {
            let Some(w) = get(surface, id) else {
                return log::debug!("window: no window for {id}");
            };
            own_request(surface, &w, r.clone());
        }
        // Menus, the tray and quitting are the main window's.
        _ => crate::chrome::command(surface, command),
    }
}

/// Runs `f` on window `w`'s GPUI window, on the main thread's next turn
/// (now may be inside a GPUI update).
fn with_window(w: &Rc<AppWindow>, f: impl FnOnce(&mut Window, &mut App) + 'static) {
    let Some(handle) = w.handle.get() else {
        return;
    };
    crate::rt::on_app(move |cx| {
        let _ = handle.update(cx, |_, window, cx| f(window, cx));
    });
}

/// Runs `f` on the main window, when the surface fills one of its own.
fn with_main(surface: &Surface, f: impl FnOnce(&mut Window, &mut App) + 'static) {
    let Some(handle) = surface.chrome.window() else {
        return;
    };
    crate::rt::on_app(move |cx| {
        let _ = handle.update(cx, |_, window, cx| f(window, cx));
    });
}

/// The app changed the main window's attributes; the chrome took the title
/// and the title bar, the rest is the window's.
pub(crate) fn main_attributes(surface: &Rc<Surface>, attributes: &WindowAttributes) {
    if let Some(transparent) = attributes.transparent {
        surface.transparent.set(transparent);
    }
    let attributes = attributes.clone();
    let s = Rc::downgrade(surface);
    with_main(surface, move |window, cx| {
        if let Some(surface) = s.upgrade() {
            apply(&surface, None, window, &attributes, cx);
        }
    });
}

/// A request for the main window.
pub(crate) fn main_request(surface: &Rc<Surface>, r: &WindowRequest) {
    let r = r.clone();
    let s = Rc::downgrade(surface);
    with_main(surface, move |window, cx| {
        let Some(surface) = s.upgrade() else { return };
        match r {
            // As before the request existed: the embedding app's close
            // handler decides; `closeOnPress` does not hold it back.
            WindowRequest::Close => close_main(&surface, window, cx),
            r => {
                request(&surface, None, window, r, cx);
                // A hidden window draws no frame to report it with.
                observe_main(&surface, window, cx);
            }
        }
    });
}

/// A request for window `w` of the app's own.
fn own_request(surface: &Rc<Surface>, w: &Rc<AppWindow>, r: WindowRequest) {
    match r {
        WindowRequest::Show => {
            w.hidden.set(false);
        }
        // Closing it is removing its root, which the app does: until then
        // it hides, and the app hears it closed.
        WindowRequest::Close => {
            if !w.hidden.get() {
                close_by_policy(surface, w, WindowCloseCause::ClosePress);
            }
            return;
        }
        WindowRequest::Hide => {
            hide(surface, w);
            return;
        }
        _ => {}
    }
    if w.handle.get().is_none() {
        w.queued.borrow_mut().push(r);
        return;
    }
    let s = Rc::downgrade(surface);
    let window = w.clone();
    with_window(w, move |gw, cx| {
        if let Some(surface) = s.upgrade() {
            request(&surface, Some(&window), gw, r, cx);
        }
    });
}

/// Hides window `w` (the app's `hide()`, a close policy).
fn hide(surface: &Rc<Surface>, w: &Rc<AppWindow>) {
    if w.hidden.replace(true) {
        return;
    }
    let s = Rc::downgrade(surface);
    let window = w.clone();
    let main = surface.chrome.window();
    with_window(w, move |gw, cx| {
        native::hide(gw);
        lost_key(gw.window_handle(), main, cx);
        if let Some(surface) = s.upgrade() {
            report_state(&surface, &window, gw, cx, true);
        }
    });
}

/// Carries out request `r` on GPUI window `window`: the main window's
/// (`own` `None`) or `own`'s.
fn request(
    surface: &Rc<Surface>,
    own: Option<&Rc<AppWindow>>,
    window: &mut Window,
    r: WindowRequest,
    cx: &mut App,
) {
    // The app's own mode replaces the one a hidden main window was to open
    // in ([`main_opened`]).
    if own.is_none()
        && matches!(
            r,
            WindowRequest::SetMode(_) | WindowRequest::SetPlacement(_)
        )
    {
        surface.chrome.opening_mode.take();
    }
    match r {
        WindowRequest::Show => {
            restore(window, cx);
            let activate = own.is_none_or(|w| w.flag(|a| a.activate, true));
            // As its first frame shows a window.
            show_window(window, activate, cx);
            if own.is_none() {
                main_opened(surface, window);
            }
        }
        // An own window hides through [`hide`].
        WindowRequest::Hide => {
            native::hide(window);
            lost_key(window.window_handle(), surface.chrome.window(), cx);
        }
        WindowRequest::Focus => {
            restore(window, cx);
            focus_window(window, cx);
            if own.is_none() {
                main_opened(surface, window);
            }
        }
        WindowRequest::Close => {}
        // A minimized window keeps the keyboard it would have in a
        // background app, and counts as focused again once restored
        // ([`is_active`]).
        WindowRequest::Minimize => window.minimize_window(),
        WindowRequest::Restore => restore(window, cx),
        WindowRequest::SetMode(mode) => set_mode(window, mode),
        WindowRequest::SetBounds(frame) => {
            if frame.width.is_some() || frame.height.is_some() {
                let (w, h) = content_size(
                    window.bounds().size,
                    window.viewport_size(),
                    frame.width.map(|v| v.0),
                    frame.height.map(|v| v.0),
                );
                match own {
                    None => crate::chrome::resize(surface, window, w, h),
                    Some(_) => resize(window, w, h),
                }
            }
            if frame.x.is_some() || frame.y.is_some() {
                // A coordinate left out is read when the move runs, after
                // the moves asked before it (`center()` then `setBounds`
                // with only `y` keeps the centered `x`).
                native::set_origin(window, frame.x.map(|v| v.0), frame.y.map(|v| v.0));
            }
        }
        WindowRequest::SetContentSize { width, height } => {
            let (w, h) = (width.map(|v| v.0), height.map(|v| v.0));
            match own {
                None => crate::chrome::resize(surface, window, w, h),
                Some(_) => resize(window, w, h),
            }
        }
        WindowRequest::SetPlacement(placement) => {
            set_mode(window, WindowMode::Normal);
            let b = placement.bounds;
            let size = content_size(
                window.bounds().size,
                window.viewport_size(),
                Some(b.size.width.0),
                Some(b.size.height.0),
            );
            let size = (size.0.unwrap_or_default(), size.1.unwrap_or_default());
            match own {
                None => crate::chrome::resize(surface, window, Some(size.0), Some(size.1)),
                Some(_) => resize(window, Some(size.0), Some(size.1)),
            }
            native::set_origin(window, Some(b.origin.x.0), Some(b.origin.y.0));
            // After the move, which waits for this update to end.
            if placement.mode != WindowMode::Normal {
                let handle = window.window_handle();
                crate::rt::on_app(move |cx| {
                    let _ = handle.update(cx, |_, window, _| set_mode(window, placement.mode));
                });
            }
        }
        WindowRequest::Center { display } => {
            let area = display
                .and_then(|id| find_display(cx, id))
                .or_else(|| window.display(cx))
                .map(|d| screen::global(d.visible_bounds(), screen::origin(&*d)));
            if let Some(area) = area {
                let size = window.bounds().size;
                let x = f32::from(area.origin.x) + (f32::from(area.size.width - size.width)) / 2.0;
                let y =
                    f32::from(area.origin.y) + (f32::from(area.size.height - size.height)) / 2.0;
                native::set_origin(window, Some(x), Some(y));
            }
        }
        WindowRequest::RequestAttention { critical } => native::request_attention(window, critical),
    }
}

/// The content size an outer `width` and `height` (a window's frame, as
/// `setBounds` and placements give them) make of a window whose frame is
/// `outer` around content of `content`: GPUI sizes content.
fn content_size(
    outer: gpui::Size<Pixels>,
    content: gpui::Size<Pixels>,
    width: Option<f32>,
    height: Option<f32>,
) -> (Option<f32>, Option<f32>) {
    let frame_w = f32::from(outer.width - content.width).max(0.0);
    let frame_h = f32::from(outer.height - content.height).max(0.0);
    (width.map(|w| w - frame_w), height.map(|h| h - frame_h))
}

/// Sizes a window of the app's own (each side at least 1 point: Wayland
/// rejects less).
fn resize(window: &mut Window, width: Option<f32>, height: Option<f32>) {
    if window.is_maximized() || window.is_fullscreen() {
        return;
    }
    let current = window.viewport_size();
    let side =
        |v: Option<f32>, or: Pixels| v.filter(|v| v.is_finite()).map_or(or, |v| px(v.max(1.0)));
    window.resize(gpui::size(
        side(width, current.width),
        side(height, current.height),
    ));
}

/// The main window shows: one hidden since it opened takes the mode it
/// opens in now ([`crate::open_app_window`]).
fn main_opened(surface: &Surface, window: &mut Window) {
    if let Some(mode) = surface.chrome.opening_mode.take() {
        set_mode(window, mode);
    }
}

/// A development host shows an error: the main window shows with it while
/// it is hidden, so the error is seen (`crate::dev`).
#[cfg(feature = "dev")]
pub(crate) fn show_main_if_hidden(surface: &Rc<Surface>) {
    let s = Rc::downgrade(surface);
    with_main(surface, move |window, cx| {
        let Some(surface) = s.upgrade() else { return };
        if !native::visible(window) {
            request(&surface, None, window, WindowRequest::Show, cx);
            // A hidden window draws no frame to report it with.
            observe_main(&surface, window, cx);
        }
    });
}

/// Puts the window in `mode`; doing it again changes nothing.
fn set_mode(window: &mut Window, mode: WindowMode) {
    let now = mode_of(window);
    if now == mode {
        return;
    }
    // Out of full screen first: maximizing happens in the normal mode.
    if now == WindowMode::FullScreen {
        window.toggle_fullscreen();
    }
    match mode {
        WindowMode::FullScreen => window.toggle_fullscreen(),
        WindowMode::Maximized if !window.is_maximized() => window.zoom_window(),
        WindowMode::Normal if window.is_maximized() => window.zoom_window(),
        _ => {}
    }
}

fn mode_of(window: &Window) -> WindowMode {
    if window.is_fullscreen() {
        WindowMode::FullScreen
    } else if window.is_maximized() {
        WindowMode::Maximized
    } else {
        WindowMode::Normal
    }
}

/// Applies the attributes `attributes` sets to a GPUI window: the main
/// window's (`own` `None`: the chrome took its title and title bar) or
/// `own`'s.
fn apply(
    surface: &Rc<Surface>,
    own: Option<&Rc<AppWindow>>,
    window: &mut Window,
    attributes: &WindowAttributes,
    _cx: &mut App,
) {
    if let Some(own) = own {
        if let Some(title) = &attributes.title {
            window.set_window_title(title);
        }
        if let Some(bar) = &attributes.title_bar {
            native::set_title_bar(window, bar.style, own.flag(frameless, false));
            #[cfg(target_os = "macos")]
            if let Some(offset) = bar.controls_offset {
                window.set_traffic_light_position(gpui::point(px(offset.x.0), px(offset.y.0)));
            }
        }
        if attributes.frame.is_some() {
            let style = own
                .attribute(|a| a.title_bar.as_ref().map(|b| b.style))
                .unwrap_or_default();
            native::set_title_bar(window, style, own.flag(frameless, false));
        }
        if (attributes.title_bar.is_some() || attributes.frame.is_some()) && own.shown.get() {
            report_title_bar(surface, own, window);
        }
    }
    if attributes.transparent.is_some() || attributes.backdrop.is_some() {
        let (transparent, backdrop) = match own {
            Some(w) => (
                w.flag(|a| a.transparent, false),
                w.attribute(|a| a.backdrop).unwrap_or(Backdrop::None),
            ),
            None => {
                let a = surface.chrome.attributes.borrow();
                (
                    a.transparent.unwrap_or(false),
                    a.backdrop.unwrap_or(Backdrop::None),
                )
            }
        };
        window.set_background_appearance(background(transparent, backdrop));
    }
    if let Some(pointer) = attributes.pointer_events {
        let through = pointer == WindowPointerEvents::None;
        // Wayland's and X11's input regions; the others' native flags.
        window.set_input_region(through.then_some(&[][..]));
        native::set_click_through(window, through);
    }
    native::apply(window, attributes);
    if own.is_some() {
        follow_simulated_scheme(window);
    }
}

/// A window of the app's own takes the scheme a test made the system's
/// (`nsh test --target`) in its frame.
fn follow_simulated_scheme(window: &Window) {
    if let Some(dark) = crate::system::simulated_scheme() {
        native::set_scheme(window, Some(dark));
    }
}

/// A test changed the system's scheme: every window of the app's own draws
/// again in it (its frame too).
#[cfg(feature = "dev")]
pub(crate) fn scheme_simulated(surface: &Surface) {
    invalidate_all(surface);
    for w in surface.windows.borrow().iter() {
        with_window(w, move |window, _| {
            follow_simulated_scheme(window);
            window.refresh();
        });
    }
}

/// The frame the attributes leave: none (`frame: "none"`).
fn frameless(a: &WindowAttributes) -> Option<bool> {
    a.frame.map(|f| f == WindowFrameStyle::None)
}

/// GPUI's window background for `transparent` and a backdrop (semantic:
/// mapped to the materials each platform has).
pub(crate) fn background(
    transparent: bool,
    backdrop: Backdrop,
) -> gpui::WindowBackgroundAppearance {
    use gpui::WindowBackgroundAppearance as B;
    match backdrop {
        Backdrop::None if transparent => B::Transparent,
        Backdrop::None => B::Opaque,
        Backdrop::Window if cfg!(windows) => B::MicaBackdrop,
        Backdrop::Sidebar if cfg!(windows) => B::MicaAltBackdrop,
        Backdrop::Window | Backdrop::Sidebar | Backdrop::Popover | Backdrop::Hud => B::Blurred,
        #[allow(unreachable_patterns)]
        _ => B::Opaque,
    }
}

// --- Opening and closing ----------------------------------------------------------------

/// Shows dialog root `view` in a new window.
fn open(surface: &Rc<Surface>, view: &NshView, open: &OpenWindow) {
    let id = view.id();
    if get(surface, id).is_some() {
        return;
    }
    // Presented over the main window by its insertion, earlier in the
    // batch: it leaves the main window's modals and tree.
    crate::navigation::release(surface, view);
    let options = &open.options;
    let attributes = options.attributes.clone();
    let parent = open.parent.or_else(|| {
        matches!(options.kind, WindowKind::Dialog | WindowKind::Panel).then_some(ROOT_ID)
    });
    let w = Rc::new(AppWindow {
        id,
        view: view.clone(),
        kind: options.kind,
        modal: options.modal,
        parent,
        attributes: RefCell::new(attributes),
        handle: Cell::new(None),
        entity: Cell::new(None),
        queued: RefCell::default(),
        invalid: Cell::new(true),
        origin: Cell::new((0.0, 0.0)),
        reported: Cell::new(None),
        shown: Cell::new(false),
        hidden: Cell::new(false),
        state: Cell::new(None),
        title_bar: Cell::new(None),
        settle: Cell::new(0),
        placed: RefCell::default(),
        subscriptions: RefCell::default(),
    });
    let weak = Rc::downgrade(&w);
    view.set_invalidate(Rc::new(move || {
        if let Some(w) = weak.upgrade() {
            w.invalidate();
        }
    }));
    // Laid out at its first size at once, so its first frame has content.
    let size = initial_size(open);
    root_resized(surface, &w, size.0, size.1);
    surface.windows.borrow_mut().push(w.clone());
    let s = Rc::downgrade(surface);
    let open = open.clone();
    crate::rt::on_app(move |cx| {
        if let Some(surface) = s.upgrade() {
            open_gpui(&surface, &w, &open, cx);
        }
    });
}

/// The window's first content size: the placement kept, the app's default
/// size, or 480 × 360 points.
fn initial_size(open: &OpenWindow) -> (f32, f32) {
    if let Some(p) = open.placement {
        return (p.bounds.size.width.0, p.bounds.size.height.0);
    }
    open.options
        .default_size
        .map_or(DEFAULT_SIZE, |s| (s.width.0.max(1.0), s.height.0.max(1.0)))
}

/// The root of window `w` is `width` × `height` points: the core lays it
/// out at that size.
fn root_resized(surface: &Surface, w: &AppWindow, width: f32, height: f32) {
    let size = Size::new(Points(width), Points(height));
    let frame = nsh_core::Bounds::new(Default::default(), size);
    if std::mem::replace(&mut w.view.state_mut().frame, frame) != frame {
        w.view.moved();
    }
    if w.reported.replace(Some(size)) != Some(size) {
        // The core places the window's popups in this size; its title bar
        // goes as `WindowEvent::TitleBar`, as the main window's goes in
        // the environment.
        surface.control(|c| c.set_root_size(w.id, size, EdgeInsets::default()));
        crate::navigation::window_resized(surface, w.id);
    }
}

/// GPUI's kind of window for a window kind (the attributes refine it).
pub(crate) fn gpui_kind(kind: WindowKind) -> gpui::WindowKind {
    match kind {
        WindowKind::Panel => gpui::WindowKind::Floating,
        WindowKind::Popup | WindowKind::Overlay => gpui::WindowKind::PopUp,
        _ => gpui::WindowKind::Normal,
    }
}

/// The bounds a window opens with and the display they are on (GPUI's
/// coordinates are the display's: [`screen::place`]): the placement kept,
/// else its default size at its default position (centered on its display,
/// or on its parent), in the default mode.
fn open_bounds(
    surface: &Surface,
    open: &OpenWindow,
    display: Option<gpui::DisplayId>,
    cx: &mut App,
) -> (gpui::WindowBounds, Option<gpui::DisplayId>) {
    if let Some(p) = open.placement {
        return place_window(p, &screen::screens(cx));
    }
    let (w, h) = initial_size(open);
    let size = gpui::size(px(w), px(h));
    let options = &open.options;
    let position = options.default_position.or_else(|| {
        (open.parent.is_some() && options.kind == WindowKind::Dialog)
            .then_some(WindowPosition::ParentCenter)
    });
    // A point of the screen: on the display it is on, in its coordinates.
    let at = match position {
        Some(WindowPosition::At(p)) => Some(Bounds::new(gpui::point(px(p.x.0), px(p.y.0)), size)),
        Some(WindowPosition::ParentCenter) => {
            parent_bounds(surface, open.parent, cx).map(|parent| {
                Bounds::new(
                    gpui::point(
                        parent.origin.x + (parent.size.width - size.width) / 2.0,
                        parent.origin.y + (parent.size.height - size.height) / 2.0,
                    ),
                    size,
                )
            })
        }
        _ => None,
    };
    let (display, bounds) = match at {
        Some(at) => screen::place(&screen::screens(cx), at),
        None => (display, centered(display, size, cx)),
    };
    let bounds = match options.default_mode {
        Some(WindowMode::Maximized) => gpui::WindowBounds::Maximized(bounds),
        Some(WindowMode::FullScreen) => gpui::WindowBounds::Fullscreen(bounds),
        _ => gpui::WindowBounds::Windowed(bounds),
    };
    (bounds, display)
}

/// A placement (screen coordinates) as GPUI opens a window with it: its
/// bounds in the coordinates of the display they are on, and that display.
pub(crate) fn place_window(
    p: WindowPlacement,
    screens: &[screen::Screen],
) -> (gpui::WindowBounds, Option<gpui::DisplayId>) {
    let bounds = gpui_window_bounds(p);
    let (display, local) = screen::place(screens, bounds.get_bounds());
    let bounds = match bounds {
        gpui::WindowBounds::Maximized(_) => gpui::WindowBounds::Maximized(local),
        gpui::WindowBounds::Fullscreen(_) => gpui::WindowBounds::Fullscreen(local),
        gpui::WindowBounds::Windowed(_) => gpui::WindowBounds::Windowed(local),
    };
    (bounds, display)
}

/// A placement as GPUI's window bounds.
pub(crate) fn gpui_window_bounds(p: WindowPlacement) -> gpui::WindowBounds {
    let b = p.bounds;
    let bounds = Bounds::new(
        gpui::point(px(b.origin.x.0), px(b.origin.y.0)),
        gpui::size(px(b.size.width.0.max(1.0)), px(b.size.height.0.max(1.0))),
    );
    match p.mode {
        WindowMode::Maximized => gpui::WindowBounds::Maximized(bounds),
        WindowMode::FullScreen => gpui::WindowBounds::Fullscreen(bounds),
        _ => gpui::WindowBounds::Windowed(bounds),
    }
}

/// The bounds of the window whose root node is `parent`, in screen
/// coordinates.
fn parent_bounds(
    surface: &Surface,
    parent: Option<NodeId>,
    cx: &mut App,
) -> Option<Bounds<Pixels>> {
    let handle = match parent? {
        ROOT_ID => surface.chrome.window()?,
        id => get(surface, id)?.handle.get()?,
    };
    handle.update(cx, |_, window, _| screen_bounds(window)).ok()
}

/// The bounds of GPUI window `window`, in screen coordinates (GPUI's are
/// its display's on macOS).
pub(crate) fn screen_bounds(window: &Window) -> Bounds<Pixels> {
    screen::global(window.bounds(), native::bounds_origin(window))
}

/// The GPUI window of the window whose root node is `id`.
pub(crate) fn handle_of(surface: &Surface, id: NodeId) -> Option<AnyWindowHandle> {
    match id {
        ROOT_ID => surface.chrome.window(),
        id => get(surface, id)?.handle.get(),
    }
}

/// Opens the GPUI window of `w` (hidden: it shows with its first frame).
fn open_gpui(surface: &Rc<Surface>, w: &Rc<AppWindow>, open: &OpenWindow, cx: &mut App) {
    // Removed before the main thread got here.
    if !surface.windows.borrow().iter().any(|x| Rc::ptr_eq(x, w)) {
        return;
    }
    let a = w.attributes.borrow().clone();
    // The app's display, else, for a window centered on its display, the
    // one the windows open on (a test's).
    let display = open
        .options
        .display
        .and_then(|id| find_display(cx, id))
        .map(|d| d.id())
        .or_else(|| {
            let centered = open.placement.is_none()
                && !(open.parent.is_some() && open.options.kind == WindowKind::Dialog)
                && matches!(
                    open.options.default_position,
                    None | Some(WindowPosition::Center)
                );
            centered.then(|| default_display(cx)).flatten()
        });
    let frameless = a.frame == Some(WindowFrameStyle::None);
    let hidden_bar = a
        .title_bar
        .as_ref()
        .is_some_and(|b| b.style == TitleBarStyle::Hidden);
    let title = a.title.clone().unwrap_or_default();
    let titlebar = (!frameless || cfg!(target_os = "macos")).then(|| gpui::TitlebarOptions {
        title: Some(title.clone().into()),
        appears_transparent: hidden_bar || frameless,
        traffic_light_position: a
            .title_bar
            .as_ref()
            .and_then(|b| b.controls_offset)
            .map(|p| gpui::point(px(p.x.0), px(p.y.0))),
    });
    let (window_bounds, display) = open_bounds(surface, open, display, cx);
    let options = gpui::WindowOptions {
        window_bounds: Some(window_bounds),
        titlebar,
        // Shown with its first frame ([`first_frame`]).
        focus: false,
        show: false,
        kind: gpui_kind(w.kind),
        is_movable: a.movable.unwrap_or(true),
        app_owns_titlebar_drag: hidden_bar || frameless,
        is_resizable: a.resizable.unwrap_or(true),
        is_minimizable: a.minimizable.unwrap_or(true),
        display_id: display,
        window_background: background(
            a.transparent.unwrap_or(false),
            a.backdrop.unwrap_or(Backdrop::None),
        ),
        window_min_size: a
            .min_size
            .flatten()
            .map(|s| gpui::size(px(s.width.0), px(s.height.0))),
        window_decorations: Some(if frameless || hidden_bar {
            gpui::WindowDecorations::Client
        } else {
            gpui::WindowDecorations::Server
        }),
        inactive_frame_interval: None,
        app_id: None,
        ..Default::default()
    };
    let s = Rc::downgrade(surface);
    let window = w.clone();
    let opened = cx.open_window(options, move |gw, cx| {
        cx.new(|cx| WindowView::new(s, window, gw, cx))
    });
    let handle: AnyWindowHandle = match opened {
        Ok(handle) => handle.into(),
        Err(err) => return log::error!("window: cannot open a window: {err}"),
    };
    w.handle.set(Some(handle));
    let parent = w.parent.and_then(|p| handle_of(surface, p));
    let s = Rc::downgrade(surface);
    let window = w.clone();
    let _ = handle.update(cx, move |_, gw, cx| {
        let Some(surface) = s.upgrade() else { return };
        // What GPUI's options do not carry, natively.
        let all = window.attributes.borrow().clone();
        apply(&surface, Some(&window), gw, &all, cx);
        if let Some(parent) = parent {
            let _ = parent.update(cx, |_, parent, _| {
                native::set_parent(gw, Some(parent), window.modal, window.kind);
            });
        }
        let queued = std::mem::take(&mut *window.queued.borrow_mut());
        for r in queued {
            request(&surface, Some(&window), gw, r, cx);
        }
    });
}

/// Dialog root `view` was removed: its window goes. Whether it had one.
pub(crate) fn removed(surface: &Surface, view: &NshView) -> bool {
    let w = {
        let mut windows = surface.windows.borrow_mut();
        let Some(i) = windows.iter().position(|w| w.id == view.id()) else {
            return false;
        };
        windows.remove(i)
    };
    destroy(surface, &w);
    true
}

/// Closes every window of the app's own (the app stopped).
pub(crate) fn close_all(surface: &Surface) {
    let windows = std::mem::take(&mut *surface.windows.borrow_mut());
    for w in &windows {
        destroy(surface, w);
    }
}

fn destroy(surface: &Surface, w: &Rc<AppWindow>) {
    w.view.clear_invalidate();
    crate::access::window_closed(surface, w.id);
    crate::navigation::window_closed(surface, w.id);
    crate::surface::place_items(&w.placed, Vec::new());
    w.subscriptions.borrow_mut().clear();
    // A modal window gives its parent its input back.
    let parent = w
        .modal
        .then(|| w.parent.and_then(|p| handle_of(surface, p)))
        .flatten();
    if let Some(handle) = w.handle.take() {
        let main = surface.chrome.window();
        crate::rt::on_app(move |cx| {
            let _ = handle.update(cx, |_, window, _| {
                native::set_parent(window, None, false, WindowKind::Normal);
                native::removing(window);
                window.remove_window();
            });
            lost_key(handle, main, cx);
            if let Some(parent) = parent {
                let _ = parent.update(cx, |_, window, _| native::enable(window, true));
            }
        });
    }
}

// --- State ------------------------------------------------------------------------------

/// The state of GPUI window `window` (`visible` unless the app or a policy
/// hid it).
fn read_state(window: &Window, visible: bool, cx: &App) -> WindowState {
    // GPUI's bounds are its display's on macOS, the app's the screen's.
    let origin = native::bounds_origin(window);
    let bounds = to_bounds(screen::global(window.bounds(), origin));
    let (mode, normal) = match window.window_bounds() {
        gpui::WindowBounds::Windowed(b) => (WindowMode::Normal, b),
        gpui::WindowBounds::Maximized(b) => (WindowMode::Maximized, b),
        gpui::WindowBounds::Fullscreen(b) => (WindowMode::FullScreen, b),
    };
    let normal = screen::global(normal, origin);
    let mode = if window.is_fullscreen() {
        WindowMode::FullScreen
    } else if window.is_maximized() {
        WindowMode::Maximized
    } else {
        mode
    };
    let mut state = WindowState::new(bounds, WindowPlacement::new(mode, to_bounds(normal)));
    let viewport = window.viewport_size();
    let content_size = Size::new(
        Points(f32::from(viewport.width)),
        Points(f32::from(viewport.height)),
    );
    // The content sits at the frame's bottom, centered across it (its
    // title bar above, its borders around).
    let dx = (bounds.size.width.0 - content_size.width.0).max(0.0) / 2.0;
    let dy = (bounds.size.height.0 - content_size.height.0 - dx).max(0.0);
    state.content_bounds = nsh_core::Bounds::new(
        nsh_core::geometry::point(
            Points(bounds.origin.x.0 + dx),
            Points(bounds.origin.y.0 + dy),
        ),
        content_size,
    );
    state.mode = mode;
    state.minimized = native::minimized(window);
    state.visible = visible && !state.minimized;
    state.focused = is_active(window, cx);
    state.display = window.display(cx).map(|d| display_id(&*d));
    state.scale_factor = window.scale_factor();
    state
}

fn to_bounds(b: Bounds<Pixels>) -> nsh_core::Bounds<Points> {
    nsh_core::Bounds::new(
        nsh_core::geometry::point(Points(f32::from(b.origin.x)), Points(f32::from(b.origin.y))),
        Size::new(
            Points(f32::from(b.size.width)),
            Points(f32::from(b.size.height)),
        ),
    )
}

/// Whether the state change from `old` to `new` waits for the window to
/// settle: only its bounds moved (a drag, a resize).
pub(crate) fn settles(old: Option<&WindowState>, new: &WindowState) -> bool {
    let Some(old) = old else { return false };
    old.mode == new.mode
        && old.minimized == new.minimized
        && old.visible == new.visible
        && old.focused == new.focused
        && old.display == new.display
        && old.scale_factor == new.scale_factor
        && (old.bounds != new.bounds
            || old.content_bounds != new.content_bounds
            || old.placement != new.placement)
}

/// Reads window `w`'s state and tells the app when it changed: at once,
/// or (a move, a resize) once it stayed for a moment, unless `now`.
fn report_state(surface: &Rc<Surface>, w: &Rc<AppWindow>, window: &Window, cx: &App, now: bool) {
    report_title_bar(surface, w, window);
    let visible = w.shown.get() && !w.hidden.get();
    let state = read_state(window, visible, cx);
    let last = w.state.get();
    if last == Some(state) {
        return;
    }
    let generation = w.settle.get() + 1;
    w.settle.set(generation);
    if !now && settles(last.as_ref(), &state) {
        let s = Rc::downgrade(surface);
        let window = Rc::downgrade(w);
        crate::rt::after_ms(SETTLE_MS, move || {
            let (Some(surface), Some(w)) = (s.upgrade(), window.upgrade()) else {
                return;
            };
            if w.settle.get() != generation {
                return;
            }
            let Some(handle) = w.handle.get() else { return };
            crate::rt::on_app(move |cx| {
                let _ = handle.update(cx, |_, window, cx| {
                    report_state(&surface, &w, window, cx, true);
                });
            });
        });
        return;
    }
    w.state.set(Some(state));
    surface.event(
        w.id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::State(Box::new(state)))),
    );
}

/// Tells the app window `w`'s title bar area when it changed (before its
/// first state: [`report_state`] asks first).
fn report_title_bar(surface: &Rc<Surface>, w: &Rc<AppWindow>, window: &Window) {
    let area = {
        let a = w.attributes.borrow();
        let bar = a.title_bar.as_ref();
        crate::chrome::own_title_bar_area(
            bar.is_some_and(|b| b.style == TitleBarStyle::Hidden),
            frameless(&a).unwrap_or(false),
            window.is_fullscreen(),
            matches!(
                window.window_decorations(),
                gpui::Decorations::Client { .. }
            ),
            bar.and_then(|b| b.height).map(|h| h.0),
            bar.and_then(|b| b.controls_offset).map(|p| (p.x.0, p.y.0)),
        )
    };
    if w.title_bar.replace(Some(area)) == Some(area) {
        return;
    }
    surface.event(
        w.id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::TitleBar(area))),
    );
}

/// The main window rendered: its state goes into the environment (the
/// engine holds moves back until they settle) and the displays to the app.
pub(crate) fn observe_main(surface: &Rc<Surface>, window: &Window, cx: &App) {
    send_displays(surface, cx);
    if !surface
        .chrome
        .window()
        .is_some_and(|h| h == window.window_handle())
    {
        return;
    }
    let state = read_state(window, native::visible(window), cx);
    let mut env = surface.environment.get();
    if env.window_state != Some(state) {
        env.window_state = Some(state);
        surface.set_environment(env);
    }
}

thread_local! {
    /// The displays last sent, per surface.
    static DISPLAYS: RefCell<Vec<(u64, Vec<Display>)>> = RefCell::default();
}

/// Tells the app the displays when they changed.
fn send_displays(surface: &Surface, cx: &App) {
    let list = displays(cx);
    let key = surface.key();
    let changed = DISPLAYS.with(|d| {
        let mut d = d.borrow_mut();
        d.retain(|(k, _)| crate::surface::Surface::by_key(*k).is_some());
        match d.iter_mut().find(|(k, _)| *k == key) {
            Some((_, last)) if *last == list => false,
            Some((_, last)) => {
                *last = list.clone();
                true
            }
            None => {
                d.push((key, list.clone()));
                true
            }
        }
    });
    if changed {
        surface.control(|c| c.set_displays(list));
    }
}

/// The app started again: the displays are sent to its engine anew.
pub(crate) fn forget_displays(surface: &Surface) {
    let key = surface.key();
    DISPLAYS.with(|d| d.borrow_mut().retain(|(k, _)| *k != key));
}

/// The displays as the app sees them (in screen coordinates).
pub(crate) fn displays(cx: &App) -> Vec<Display> {
    let primary = cx.primary_display().map(|d| d.id());
    cx.displays()
        .iter()
        .map(|d| {
            let origin = screen::origin(&**d);
            let bounds = to_bounds(screen::global(d.bounds(), origin));
            let mut display = Display::new(
                display_id(&**d),
                bounds,
                to_bounds(screen::global(d.visible_bounds(), origin)),
                Some(d.id()) == primary,
            );
            display.refresh_rate = d
                .refresh_interval()
                .filter(|i| !i.is_zero())
                .map(|i| 1.0 / i.as_secs_f32());
            display.cutouts = native::cutouts(d.id(), bounds);
            display
        })
        .collect()
}

/// A display's id, the same in the app's next launch: its UUID hashed,
/// else GPUI's id (stable while it is connected).
fn display_id(d: &dyn gpui::PlatformDisplay) -> DisplayId {
    match d.uuid() {
        Ok(uuid) => DisplayId::from_name(uuid.as_bytes()),
        Err(_) => DisplayId::from_name(&u64::from(d.id()).to_le_bytes()),
    }
}

fn find_display(cx: &App, id: DisplayId) -> Option<std::rc::Rc<dyn gpui::PlatformDisplay>> {
    cx.displays().into_iter().find(|d| display_id(&**d) == id)
}

// --- The view ---------------------------------------------------------------------------

/// The GPUI view of a window of the app's own.
pub(crate) struct WindowView {
    surface: Weak<Surface>,
    window: Rc<AppWindow>,
    focus: FocusHandle,
}

impl WindowView {
    fn new(
        surface: Weak<Surface>,
        window: Rc<AppWindow>,
        gw: &mut Window,
        cx: &mut Context<Self>,
    ) -> WindowView {
        window.entity.set(Some(cx.entity_id()));
        let focus = cx.focus_handle();
        gw.focus(&focus, cx);
        let mut subscriptions = Vec::new();
        subscriptions.push(
            cx.observe_window_bounds(gw, |view: &mut WindowView, gw, cx| {
                view.state_changed(gw, cx, false);
                cx.notify();
            }),
        );
        subscriptions.push(
            cx.observe_window_activation(gw, |view: &mut WindowView, gw, cx| {
                view.activation_changed(gw, cx);
            }),
        );
        subscriptions.push(
            cx.observe_window_visibility(gw, |view: &mut WindowView, _, gw, cx| {
                view.state_changed(gw, cx, true);
            }),
        );
        // The close button, Alt+F4, the taskbar: the policy answers.
        let s = surface.clone();
        let w = Rc::downgrade(&window);
        gw.on_window_should_close(cx, move |_, cx| {
            let (Some(surface), Some(w)) = (s.upgrade(), w.upgrade()) else {
                return true;
            };
            close_press(&surface, w.id, CloseReason::CloseButton);
            crate::rt::flush(cx);
            // The window stays until the app removes its root.
            false
        });
        *window.subscriptions.borrow_mut() = subscriptions;
        WindowView {
            surface,
            window,
            focus,
        }
    }

    /// The window gained or lost the keyboard ([`is_active`]).
    fn activation_changed(&mut self, gw: &mut Window, cx: &mut Context<Self>) {
        if let Some(surface) = self.surface.upgrade()
            && !is_active(gw, cx)
        {
            crate::keymap::forget_held(&surface);
            // Losing the focus closes a window that says so.
            let w = &self.window;
            if w.flag(|a| a.close_on_blur, false) && w.shown.get() && !w.hidden.get() {
                close_by_policy(&surface, w, WindowCloseCause::Blur);
            }
        }
        self.state_changed(gw, cx, true);
        cx.notify();
    }

    fn state_changed(&self, gw: &mut Window, cx: &mut Context<Self>, now: bool) {
        if let Some(surface) = self.surface.upgrade()
            && self.window.shown.get()
        {
            report_state(&surface, &self.window, gw, cx, now);
            crate::rt::flush(cx);
        }
    }
}

impl Render for WindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let root = gpui::div()
            .key_context("NshWindow")
            .track_focus(&self.focus)
            .size_full()
            .relative();
        let Some(surface) = self.surface.upgrade() else {
            return root;
        };
        let w = &self.window;
        // A hidden title bar's controls, as the main window draws them.
        let parts = {
            let a = w.attributes.borrow();
            let bar = a.title_bar.as_ref();
            let hidden = bar.is_some_and(|b| b.style == TitleBarStyle::Hidden);
            if hidden && !frameless(&a).unwrap_or(false) {
                crate::chrome::own_window_parts(
                    &surface,
                    w.id,
                    bar.and_then(|b| b.height).map(|h| h.0),
                    a.resizable.unwrap_or(true),
                    window,
                    cx,
                )
            } else {
                Vec::new()
            }
        };
        root.child(WindowElement {
            surface: surface.clone(),
            window: w.clone(),
            focus: self.focus.clone(),
            view: cx.entity().downgrade(),
        })
        .child(crate::chrome::drag_area(&surface, Some(w.id)))
        .children(parts)
    }
}

/// The window's input handler while a field of the surface has the focus:
/// text and input methods go to that field ([`crate::text_input::ime`]),
/// placed in this window.
impl gpui::EntityInputHandler for WindowView {
    fn text_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        adjusted: &mut Option<std::ops::Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let surface = self.surface.upgrade()?;
        crate::text_input::ime::text_for_range(&surface, range, adjusted)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<gpui::UTF16Selection> {
        let surface = self.surface.upgrade()?;
        crate::text_input::ime::selected_text_range(&surface)
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<std::ops::Range<usize>> {
        let surface = self.surface.upgrade()?;
        crate::text_input::ime::marked_text_range(&surface)
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(surface) = self.surface.upgrade() {
            let _in = enter(&surface, Some(self.window.id));
            crate::text_input::ime::unmark_text(&surface);
        }
        crate::rt::flush(cx);
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<std::ops::Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(surface) = self.surface.upgrade() {
            let _in = enter(&surface, Some(self.window.id));
            crate::text_input::ime::replace_text_in_range(&surface, range, text);
        }
        crate::rt::flush(cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<std::ops::Range<usize>>,
        text: &str,
        selected: Option<std::ops::Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(surface) = self.surface.upgrade() {
            let _in = enter(&surface, Some(self.window.id));
            crate::text_input::ime::replace_and_mark_text_in_range(&surface, range, text, selected);
        }
        crate::rt::flush(cx);
    }

    fn bounds_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        _element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let surface = self.surface.upgrade()?;
        let _in = enter(&surface, Some(self.window.id));
        crate::text_input::ime::bounds_for_range(&surface, range)
    }

    fn character_index_for_point(
        &mut self,
        point: gpui::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let surface = self.surface.upgrade()?;
        let _in = enter(&surface, Some(self.window.id));
        crate::text_input::ime::character_index_for_point(&surface, point)
    }

    fn set_selected_text_range(
        &mut self,
        range: std::ops::Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(surface) = self.surface.upgrade() {
            crate::text_input::ime::set_selected_text_range(&surface, range);
        }
        crate::rt::flush(cx);
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let surface = self.surface.upgrade()?;
        crate::text_input::ime::text_length_utf16(&surface)
    }

    fn text_input_configuration(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> gpui::TextInputConfiguration {
        match self.surface.upgrade() {
            Some(surface) => crate::text_input::ime::configuration(&surface),
            None => Default::default(),
        }
    }
}

/// The GPUI element of a window of the app's own: fills it and draws its
/// root's tree.
struct WindowElement {
    surface: Rc<Surface>,
    window: Rc<AppWindow>,
    focus: FocusHandle,
    view: gpui::WeakEntity<WindowView>,
}

impl Element for WindowElement {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some("nsh-window".into())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = gpui::Style::default();
        style.size.width = gpui::relative(1.0).into();
        style.size.height = gpui::relative(1.0).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let w = &self.window;
        w.origin
            .set((f32::from(bounds.origin.x), f32::from(bounds.origin.y)));
        // Minimized: the root keeps its size.
        let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        if width > 0.0 && height > 0.0 {
            root_resized(&self.surface, w, width, height);
        }
        if self.surface.wants_frames() {
            self.surface.tick();
        }
        w.invalid.set(false);
        {
            // This window's tree of its own.
            let _in = enter(&self.surface, Some(w.id));
            crate::access::prepaint(&self.surface, &self.focus, window, cx);
        }
        window.set_focus_handle(&self.focus, cx);
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::BlockMouse);
        {
            // Native components and web views in it take the input over
            // their boxes.
            let _in = enter(&self.surface, Some(w.id));
            crate::native::prepaint(&self.surface, window, cx);
        }
        hitbox
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _layout: &mut Self::RequestLayoutState,
        hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let surface = self.surface.clone();
        let w = self.window.clone();
        let dark = crate::system::dark(&surface);
        let see_through = w.flag(|a| a.transparent, false)
            || w.attribute(|a| a.backdrop)
                .is_some_and(|b| b != Backdrop::None);
        if !see_through {
            let background = match &*surface.host_theme.borrow() {
                Some(theme) if dark => theme.background.dark.into(),
                Some(theme) => theme.background.light.into(),
                None => crate::system::window_background(&surface),
            };
            window.paint_quad(gpui::fill(bounds, crate::render::hsla(background)));
        }
        crate::events::install(
            &surface,
            Some(w.id),
            &self.focus,
            &self.view,
            hitbox,
            bounds,
            window,
            cx,
        );
        let drawn = {
            let _in = enter(&surface, Some(w.id));
            crate::canvas::begin_pass(surface.key());
            let mut dcx = crate::render::DrawCx::new(window, cx, bounds, dark);
            let origin = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
            let local = crate::render::root_matrix(&w.view, origin);
            crate::render::draw_view(&mut dcx, &w.view, Mat4::new(), local);
            std::mem::take(&mut dcx.drawn)
        };
        crate::surface::place_items(&w.placed, drawn);
        if surface.wants_frames() || w.invalid.get() {
            window.request_animation_frame();
        }
        {
            let _in = enter(&surface, Some(w.id));
            crate::access::paint(&surface, window, cx);
        }
        if !w.shown.get() {
            first_frame(&surface, &w, window);
        }
    }

    fn a11y_role(&self) -> Option<gpui::accesskit::Role> {
        Some(crate::access::ROLE)
    }

    fn a11y_synthetic_children(
        &mut self,
        _hitbox: &mut Self::PrepaintState,
        builder: &mut gpui::A11ySubtreeBuilder,
    ) {
        let _in = enter(&self.surface, Some(self.window.id));
        crate::access::synthetic(&self.surface, builder);
    }
}

/// The window's first frame is drawn: it shows (activating unless the app
/// said not to), and the app hears its state.
fn first_frame(surface: &Rc<Surface>, w: &Rc<AppWindow>, window: &mut Window) {
    w.shown.set(true);
    if w.hidden.get() {
        return;
    }
    let activate = w.flag(|a| a.activate, true) && w.flag(|a| a.focusable, true);
    let s = Rc::downgrade(surface);
    let window_rc = w.clone();
    let parent = w
        .modal
        .then(|| w.parent.and_then(|p| handle_of(surface, p)))
        .flatten();
    // After the frame: showing a window from its own paint would draw it
    // again inside this one.
    let handle = window.window_handle();
    crate::rt::on_app(move |cx| {
        let _ = handle.update(cx, |_, gw, cx| {
            show_window(gw, activate, cx);
            if let Some(surface) = s.upgrade() {
                report_state(&surface, &window_rc, gw, cx, true);
            }
        });
        // A modal window disables its parent until it goes.
        if let Some(parent) = parent {
            let _ = parent.update(cx, |_, gw, _| native::enable(gw, false));
        }
    });
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{point, size};

    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> nsh_core::Bounds<Points> {
        nsh_core::Bounds::new(point(Points(x), Points(y)), size(Points(w), Points(h)))
    }

    fn gpui_rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        Bounds::new(gpui::point(px(x), px(y)), gpui::size(px(w), px(h)))
    }

    /// A notch is computed from the display's bounds in screen coordinates
    /// (as [`displays`] passes them to `native::cutouts`), not GPUI's own,
    /// which start at each display's corner on macOS.
    #[test]
    fn a_notch_is_placed_in_screen_coordinates() {
        // A built-in screen right of a 2560 × 1440 primary display, its top
        // 658 points below the primary's: GPUI measures it from its corner.
        let local = gpui_rect(0.0, 0.0, 1512.0, 982.0);
        let origin = gpui::point(px(2560.0), px(658.0));
        let bounds = to_bounds(screen::global(local, origin));
        let area = size(Points(664.0), Points(32.0));
        assert_eq!(
            nsh_core::desktop::notch(bounds, area, area, Points(32.0)),
            Some(rect(3224.0, 658.0, 184.0, 32.0)),
        );
    }

    /// A secondary display is the first that is not the primary one or a
    /// mirror of it (whose frame in the desktop is the primary's); one
    /// display alone has none.
    #[test]
    fn the_secondary_display_skips_the_primary_and_its_mirrors() {
        let primary = gpui_rect(0.0, 0.0, 3008.0, 1692.0);
        let built_in = gpui_rect(3008.0, 0.0, 1800.0, 1169.0);
        // The same size elsewhere in the desktop is another display.
        let twin = gpui_rect(-3008.0, 0.0, 3008.0, 1692.0);
        assert_eq!(secondary::<Bounds<Pixels>>(&[]), None);
        assert_eq!(secondary(&[primary]), None);
        assert_eq!(secondary(&[primary, primary]), None);
        assert_eq!(secondary(&[primary, built_in]), Some(1));
        assert_eq!(secondary(&[primary, primary, built_in]), Some(2));
        assert_eq!(secondary(&[primary, twin]), Some(1));
    }

    /// A window that keeps its size is centered on the display's area when
    /// it fits, and keeps its top left corner on it when it is larger.
    #[test]
    fn a_window_keeping_its_size_stays_on_its_display() {
        let area = gpui_rect(100.0, 25.0, 1000.0, 700.0);
        assert_eq!(
            centered_keeping_size(area, gpui::size(px(400.0), px(300.0))),
            gpui_rect(400.0, 225.0, 400.0, 300.0)
        );
        assert_eq!(
            centered_keeping_size(area, gpui::size(px(1200.0), px(900.0))),
            gpui_rect(100.0, 25.0, 1200.0, 900.0)
        );
        assert_eq!(
            centered_keeping_size(area, gpui::size(px(400.0), px(900.0))),
            gpui_rect(400.0, 25.0, 400.0, 900.0)
        );
    }

    fn state(bounds: nsh_core::Bounds<Points>) -> WindowState {
        WindowState::new(bounds, WindowPlacement::new(WindowMode::Normal, bounds))
    }

    #[test]
    fn close_presses_close_unless_the_app_holds_them() {
        assert!(closes_on_press(None));
        assert!(closes_on_press(Some(true)));
        assert!(!closes_on_press(Some(false)));
    }

    #[test]
    fn moves_and_resizes_settle_and_the_rest_reports_at_once() {
        let a = state(rect(0.0, 0.0, 400.0, 300.0));
        // The first state reports at once.
        assert!(!settles(None, &a));
        let moved = state(rect(10.0, 0.0, 400.0, 300.0));
        assert!(settles(Some(&a), &moved));
        let resized = state(rect(0.0, 0.0, 500.0, 300.0));
        assert!(settles(Some(&a), &resized));
        let mut focused = a;
        focused.focused = !a.focused;
        assert!(!settles(Some(&a), &focused));
        let mut maximized = moved;
        maximized.mode = WindowMode::Maximized;
        assert!(!settles(Some(&a), &maximized));
        let mut minimized = a;
        minimized.minimized = true;
        assert!(!settles(Some(&a), &minimized));
    }

    #[test]
    fn kinds_open_as_gpui_kinds() {
        assert_eq!(gpui_kind(WindowKind::Normal), gpui::WindowKind::Normal);
        assert_eq!(gpui_kind(WindowKind::Dialog), gpui::WindowKind::Normal);
        assert_eq!(gpui_kind(WindowKind::Panel), gpui::WindowKind::Floating);
        assert_eq!(gpui_kind(WindowKind::Popup), gpui::WindowKind::PopUp);
        assert_eq!(gpui_kind(WindowKind::Overlay), gpui::WindowKind::PopUp);
    }

    #[test]
    fn backdrops_map_to_window_backgrounds() {
        use gpui::WindowBackgroundAppearance as B;
        assert_eq!(background(false, Backdrop::None), B::Opaque);
        assert_eq!(background(true, Backdrop::None), B::Transparent);
        let window = background(false, Backdrop::Window);
        let popover = background(false, Backdrop::Popover);
        if cfg!(windows) {
            assert_eq!(window, B::MicaBackdrop);
            assert_eq!(background(false, Backdrop::Sidebar), B::MicaAltBackdrop);
        } else {
            assert_eq!(window, B::Blurred);
        }
        assert_eq!(popover, B::Blurred);
    }

    #[test]
    fn placements_open_as_gpui_window_bounds() {
        let b = rect(10.0, 20.0, 300.0, 200.0);
        let expected = Bounds::new(
            gpui::point(px(10.0), px(20.0)),
            gpui::size(px(300.0), px(200.0)),
        );
        assert_eq!(
            gpui_window_bounds(WindowPlacement::new(WindowMode::Normal, b)),
            gpui::WindowBounds::Windowed(expected)
        );
        assert_eq!(
            gpui_window_bounds(WindowPlacement::new(WindowMode::Maximized, b)),
            gpui::WindowBounds::Maximized(expected)
        );
        assert_eq!(
            gpui_window_bounds(WindowPlacement::new(WindowMode::FullScreen, b)),
            gpui::WindowBounds::Fullscreen(expected)
        );
        // A size under a point opens a point big.
        let tiny = gpui_window_bounds(WindowPlacement::new(
            WindowMode::Normal,
            rect(0.0, 0.0, 0.0, 0.0),
        ));
        assert_eq!(tiny.get_bounds().size, gpui::size(px(1.0), px(1.0)));
    }

    #[test]
    fn open_sizes_take_the_placement_then_the_default_size() {
        let mut open = OpenWindow::default();
        assert_eq!(initial_size(&open), DEFAULT_SIZE);
        open.options.default_size = Some(Size::new(Points(640.0), Points(0.0)));
        assert_eq!(initial_size(&open), (640.0, 1.0));
        open.placement = Some(WindowPlacement::new(
            WindowMode::Normal,
            rect(0.0, 0.0, 800.0, 600.0),
        ));
        assert_eq!(initial_size(&open), (800.0, 600.0));
    }

    #[test]
    fn set_bounds_sizes_the_frame_and_content_size_the_content() {
        // A 28-point title bar over 400 × 300 of content.
        let outer = gpui::size(px(400.0), px(328.0));
        let content = gpui::size(px(400.0), px(300.0));
        assert_eq!(
            content_size(outer, content, Some(500.0), Some(428.0)),
            (Some(500.0), Some(400.0))
        );
        // A side left out stays left out: the window keeps it.
        assert_eq!(
            content_size(outer, content, None, Some(228.0)),
            (None, Some(200.0))
        );
        // No frame: the frame is the content.
        assert_eq!(
            content_size(content, content, Some(10.0), None),
            (Some(10.0), None)
        );
    }

    #[test]
    fn own_title_bars_report_their_hidden_area() {
        use crate::chrome::own_title_bar_area as area;
        let none = Edges::<Points>::default();
        // Shown, frameless, or in full screen: nothing to keep clear.
        assert_eq!(area(false, false, false, true, None, None), none);
        assert_eq!(area(true, true, false, true, None, None), none);
        assert_eq!(area(true, false, true, true, None, None), none);
        let hidden = area(true, false, false, true, Some(40.0), Some((20.0, 12.0)));
        assert_eq!(hidden.top.0, 40.0);
        assert_eq!(hidden.bottom.0, 0.0);
        if cfg!(target_os = "macos") {
            // The traffic lights where the app put them, and their width.
            assert_eq!((hidden.left.0, hidden.right.0), (20.0 + 54.0 + 8.0, 0.0));
        } else {
            // The drawn controls, as the main window's.
            assert_eq!(hidden.left.0, 0.0);
            assert!(hidden.right.0 > 0.0);
        }
        if cfg!(target_os = "linux") {
            // The window manager's title bar.
            assert_eq!(area(true, false, false, false, None, None), none);
        }
    }
}
