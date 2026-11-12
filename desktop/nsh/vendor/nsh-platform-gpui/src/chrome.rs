//! The window's chrome (`nsh/desktop`): its title, the title bar (shown
//! or hidden), full screen, the application menu and context menus, and
//! the standalone app's window shortcuts.
//!
//! GPUI only lets a window choose its title bar when it opens, so the
//! standalone window ([`crate::app::open_app_window`]) is opened in a way
//! that lets both styles be drawn later:
//!
//! - **macOS**: a transparent title bar (`TitlebarOptions::
//!   appears_transparent`, the traffic lights stay). The default style is
//!   a title row drawn above the app (28 points, the title centered), the
//!   hidden one leaves the app the whole window, with the traffic lights
//!   centered in the app's bar (`set_traffic_light_position`) and their
//!   area reported as the environment's `title_bar`. The application menu
//!   is GPUI's native menu bar (`cx.set_menus`; its items dispatch
//!   [`MenuCommand`], their shortcuts are key bindings no context
//!   matches, so AppKit shows them while nsh matches them itself).
//! - **Windows**: a transparent title bar as well: the default style is a
//!   title row with the caption buttons (32 points), the hidden one draws
//!   only the caption buttons over the app (46 points wide, as tall as the
//!   app's bar). Both mark their areas with GPUI's `WindowControlArea`, so
//!   Windows hit-tests them (`HTCAPTION`, `HTMAXBUTTON` with its snap
//!   layouts, ...) and handles their clicks itself.
//! - **Linux**: the window manager's decorations for the default style;
//!   the hidden one asks for client-side decorations
//!   (`Window::request_decorations`) and, when the window gets them (X11
//!   needs a compositor, Wayland a compositor that allows them), draws the
//!   window buttons over the app and resize edges along the window's
//!   border. Without them the system's title bar stays and nothing is
//!   reported.
//!
//! Elsewhere than on macOS the application menu is a menu bar drawn above
//! the app (not while the title bar is hidden or in full screen; with
//! `Menu.setMenuBar("autoHide")` only after Alt alone, or while one of
//! its menus is open), and every
//! menu (the bar's, context menus) is a popup drawn over the window
//! ([`menus`]), with keyboard access (F10, Alt + a menu's initial, arrows,
//! Return, Escape). Window operations need the GPUI window, which batches
//! and keys do not have: they are queued ([`Op`]) and carried out when the
//! view renders next ([`render`]). Activation instead runs in a main-thread
//! window update, so a minimized window can be restored without a frame.
//!
//! Keys: the standalone app's reserved keys (Ctrl+Q / F11; on macOS Cmd+Q,
//! Cmd+H, Opt+Cmd+H, Cmd+M, Ctrl+Cmd+F) and the open menu's come first
//! ([`window_key`], one of the surface's window shortcuts); the menu's
//! shortcuts after `nsh/keymap`'s bindings ([`shortcut`]), so a binding
//! wins over a menu item of the same keystroke, then Ctrl+W / Cmd+W, which
//! closes the window unless the app takes it. Quitting and closing (keys,
//! roles, `Application.quit()`, the main window's `WindowRef.close()`, the close button) go to the embedding app's
//! handler instead when it set one ([`crate::AppView::on_close_request`]).

mod menus;

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use gpui::{
    AnyElement, AnyWindowHandle, App, Bounds, CursorStyle, DispatchPhase, Hitbox, HitboxBehavior,
    IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
    ResizeEdge, Size, Styled, Window, WindowControlArea, canvas, div, prelude::*, px,
};
// Text fields' and selectable text's context menus (`text_input.rs`,
// `text.rs`) show their items with these.
#[cfg(feature = "dev")]
pub(crate) use menus::choose_path as choose_menu_path;
pub(crate) use menus::{LocalItem, popup_actions};

/// Closes the open menu with nothing chosen (`nsh test --target gpui`).
#[cfg(feature = "dev")]
pub(crate) fn close_menu(surface: &Surface) -> Result<(), String> {
    if surface.chrome.open.borrow().is_none() {
        return Err("no context menu is open".into());
    }
    menus::close(surface);
    Ok(())
}
use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    desktop::{
        CloseReason, DesktopCommand, Key, MenuBarMode, MenuItem, MenuRole, Shortcut, TitleBarStyle,
        WindowAttributes, WindowMode,
    },
    geometry::{Edges as Insets, Points},
};

use crate::{
    CloseRequest,
    input::{KeyEvent, Modifiers},
    surface::Surface,
};

/// What an item of a menu of the platform's own does (a text field's).
pub(crate) type Action = Rc<dyn Fn(&Rc<Surface>)>;

/// The desktop whose chrome is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Platform {
    Mac,
    Windows,
    Linux,
}

const PLATFORM: Platform = if cfg!(target_os = "macos") {
    Platform::Mac
} else if cfg!(windows) {
    Platform::Windows
} else {
    Platform::Linux
};

/// macOS: the title row's height, and where the traffic lights start.
const MAC_TITLE_HEIGHT: f32 = 28.0;
const TRAFFIC_LIGHTS_X: f32 = 9.0;
/// The traffic lights' height and how far right they reach (three 14
/// point buttons 6 points apart).
const TRAFFIC_LIGHTS_SIZE: (f32, f32) = (14.0, 54.0);

/// Windows: the caption's height and a caption button's width.
const WINDOWS_CAPTION_HEIGHT: f32 = 32.0;
const CAPTION_BUTTON_WIDTH: f32 = 46.0;

/// Linux: the hidden title bar's height when the app gives none (GTK's
/// header bars), the window buttons' size, the gap between them and their
/// margin from the window's right edge.
const LINUX_HEADER_HEIGHT: f32 = 46.0;
const LINUX_BUTTON: f32 = 24.0;
const LINUX_BUTTON_GAP: f32 = 8.0;
const LINUX_BUTTON_MARGIN: f32 = 10.0;
/// How far in from the border a client-decorated window resizes.
const RESIZE_EDGE: f32 = 6.0;

/// How far the mouse moves on a `windowDrag` view before the window moves
/// (a press alone, or a double click, must not start a move: the window
/// manager takes the pointer).
const DRAG_SLOP: f32 = 3.0;

/// A window operation, carried out when the view renders next.
#[derive(Debug, Clone, PartialEq)]
enum Op {
    Title(String),
    /// The title bar's style changed (Linux decorations, macOS traffic
    /// lights).
    TitleBar,
    Minimize,
    ToggleMaximize,
    ToggleFullScreen,
    /// The user asked to close the window (how), or the app did (`None`,
    /// `WindowRef.close()`, which `closeOnPress` does not hold back).
    Close(Option<CloseReason>),
    Quit,
    Hide,
    HideOthers,
    ShowAll,
}

/// What the embedding app does instead of quitting or closing the window
/// ([`crate::AppView::on_close_request`]).
type CloseHandler = Rc<dyn Fn(CloseRequest, &mut Window, &mut App)>;

/// A size asked of the platform, which may apply it some time later.
#[derive(Clone, Copy)]
struct AskedSize {
    size: Size<Pixels>,
    /// The window's size when it was asked: while the window still has it,
    /// the platform has not answered, and `size` is what the window will be.
    from: Size<Pixels>,
}

/// The size `setBounds`' `width` and `height` make of a window now `current`:
/// one left out keeps the window's, or the size asked last while the platform
/// has not applied it. Once the window has changed (to that size, a size the
/// platform allowed, or one the user dragged it to) its own size counts.
/// Each side is at least 1 point: Wayland's viewport rejects a size under 1
/// as a fatal protocol error.
fn frame_size(
    current: Size<Pixels>,
    asked: Option<AskedSize>,
    width: Option<f32>,
    height: Option<f32>,
) -> Size<Pixels> {
    let kept = asked
        .filter(|asked| asked.from == current)
        .map_or(current, |asked| asked.size);
    let side = |side: f32| gpui::px(side.max(1.0));
    // A size the platform can take: finite.
    let (width, height) = (
        width.filter(|w| w.is_finite()),
        height.filter(|h| h.is_finite()),
    );
    gpui::size(
        width.map_or(kept.width, side),
        height.map_or(kept.height, side),
    )
}

/// A surface's chrome.
#[derive(Default)]
pub(crate) struct Chrome {
    /// The surface fills a window of its own ([`set_standalone`]); an
    /// embedded surface's host owns the window: only context menus work.
    standalone: Cell<bool>,
    /// Activation must work even while the window is not rendering.
    window: Cell<Option<AnyWindowHandle>>,
    /// The mode the window opens in, while it waits hidden since it opened
    /// (nsh.json `window.defaultVisible: false`): it takes it as it first
    /// shows, as GPUI would show it to apply it ([`crate::open_app_window`]).
    pub(crate) opening_mode: Cell<Option<WindowMode>>,
    style: Cell<TitleBarStyle>,
    /// The app's title bar's height (`titleBar.height`).
    height: Cell<Option<f32>>,
    /// Where the app puts the traffic lights (`titleBar.controlsOffset`).
    controls_offset: Cell<Option<(f32, f32)>>,
    /// The main window's attributes the app set (`currentWindow().set()`).
    pub(crate) attributes: RefCell<WindowAttributes>,
    /// The window's title (drawn in the title rows).
    title: RefCell<String>,
    /// The application menu.
    menu: RefCell<Option<Arc<[MenuItem]>>>,
    /// The native menus (macOS) must be set again.
    menu_changed: Cell<bool>,
    /// What the native menus' items do, by [`MenuCommand::index`].
    entries: RefCell<Vec<(u32, Option<MenuRole>)>>,
    /// Window operations to carry out.
    ops: RefCell<Vec<Op>>,
    /// The last size `setBounds` asked for.
    asked_size: Cell<Option<AskedSize>>,
    /// The menu open (drawn), if any.
    open: RefCell<Option<menus::Open>>,
    /// The icons of its rows.
    icons: RefCell<menus::Icons>,
    /// The menu bar's items, in window coordinates (from the last frame).
    bar_items: RefCell<Vec<Bounds<Pixels>>>,
    /// When the menu bar shows (`Menu.setMenuBar`).
    menu_bar: Cell<MenuBarMode>,
    /// Whether Alt is held across modifier changes.
    alt_down: Cell<bool>,
    /// Alt alone went down: its release toggles an auto-hidden bar.
    alt_armed: Cell<bool>,
    /// Alt alone showed the auto-hidden bar.
    revealed: Cell<bool>,
    /// The window as last rendered.
    full_screen: Cell<bool>,
    maximized: Cell<bool>,
    active: Cell<bool>,
    /// The window has client-side decorations now (Linux).
    client_decorated: Cell<bool>,
    /// Where a press on a `windowDrag` view began (window coordinates),
    /// until the window moves or the button is released.
    drag: Cell<Option<(f32, f32)>>,
    /// Asked instead of quitting or closing, when set.
    pub(crate) on_close: RefCell<Option<CloseHandler>>,
}

/// The surface fills a window of its own titled `title`: the window's
/// chrome is the app's.
pub(crate) fn set_standalone(surface: &Surface, title: &str, window: AnyWindowHandle) {
    let c = &surface.chrome;
    c.standalone.set(true);
    c.window.set(Some(window));
    c.active.set(true);
    *c.title.borrow_mut() = title.to_owned();
    c.menu_changed.set(true);
}

/// What a GPUI window gets for its title bar when an [`crate::AppView`]
/// owns it ([`crate::AppView::own_window`]): opened this way, the window
/// can draw both title bar styles (`titleBar.style`) later (see the module
/// docs).
pub fn titlebar_options(title: &str) -> gpui::TitlebarOptions {
    gpui::TitlebarOptions {
        title: Some(title.to_owned().into()),
        appears_transparent: PLATFORM != Platform::Linux,
        traffic_light_position: (PLATFORM == Platform::Mac)
            .then(|| traffic_lights(MAC_TITLE_HEIGHT)),
    }
}

/// Where the traffic lights go in a bar `height` points tall.
pub(crate) fn traffic_lights(height: f32) -> gpui::Point<Pixels> {
    gpui::point(
        px(TRAFFIC_LIGHTS_X),
        px(((height - TRAFFIC_LIGHTS_SIZE.0) / 2.0).max(0.0)),
    )
}

/// Where the traffic lights go: where the app put them
/// (`titleBar.controlsOffset`), else centered in a bar `height` points
/// tall.
#[cfg(target_os = "macos")]
fn traffic_lights_at(offset: Option<(f32, f32)>, height: f32) -> gpui::Point<Pixels> {
    match offset {
        Some((x, y)) => gpui::point(px(x), px(y)),
        None => traffic_lights(height),
    }
}

fn hidden(surface: &Surface) -> bool {
    surface.chrome.style.get() == TitleBarStyle::Hidden
}

/// The application menu can show as a menu bar above the app (not on
/// macOS, whose menu bar is the system's): F10 and Alt + an initial open
/// its menus.
fn bar_available(surface: &Surface) -> bool {
    let c = &surface.chrome;
    PLATFORM != Platform::Mac
        && c.standalone.get()
        && !c.full_screen.get()
        && !hidden(surface)
        && c.menu.borrow().is_some()
}

/// The menu bar shows: always, or while Alt alone revealed it or one of
/// its menus is open when it hides itself.
fn bar_shown(surface: &Surface) -> bool {
    let c = &surface.chrome;
    bar_available(surface)
        && (c.menu_bar.get() == MenuBarMode::Shown || c.revealed.get() || menus::bar_open(surface))
}

/// The keyboard's modifiers changed: Alt pressed and released alone shows
/// or hides a bar that hides itself (an open menu of the bar closes), as
/// in Windows and GNOME apps. Alt with another modifier is a shortcut.
pub(crate) fn modifiers_changed(surface: &Surface, m: &Modifiers) {
    let c = &surface.chrome;
    let others = m.ctrl || m.shift || m.meta;
    let was_alt = c.alt_down.replace(m.alt);
    if m.alt {
        if !was_alt {
            c.alt_armed.set(!others);
        } else if others {
            c.alt_armed.set(false);
        }
        // Releasing another modifier must not re-arm an Alt press that
        // was already used as part of a shortcut.
        return;
    }
    let released_alone = c.alt_armed.replace(false) && was_alt && !others;
    if !released_alone || c.menu_bar.get() != MenuBarMode::AutoHide || !bar_available(surface) {
        return;
    }
    if menus::bar_open(surface) {
        c.revealed.set(false);
        menus::close(surface);
    } else {
        c.revealed.set(!c.revealed.get());
    }
    surface.invalidate();
}

/// A key went down: Alt released after it is a shortcut's.
pub(crate) fn key_pressed(surface: &Surface) {
    surface.chrome.alt_armed.set(false);
}

fn push(surface: &Surface, op: Op) {
    surface.chrome.ops.borrow_mut().push(op);
    surface.invalidate();
}

// --- Commands ---------------------------------------------------------------------------

/// A desktop command for the main window (on the root).
pub(crate) fn command(surface: &Rc<Surface>, command: &DesktopCommand) {
    let c = &surface.chrome;
    // The embedding app owns its window: only context menus work there.
    if !c.standalone.get() && !matches!(command, DesktopCommand::PopupMenu { .. }) {
        return;
    }
    match command {
        DesktopCommand::SetAttributes(attributes) => set_attributes(surface, attributes),
        DesktopCommand::Request(request) => crate::window::main_request(surface, request),
        // The main window is open already.
        DesktopCommand::OpenWindow(_) => {}
        DesktopCommand::Quit => push(surface, Op::Quit),
        // The backend for embedding: when the app restarts is the embedding
        // app's to decide.
        DesktopCommand::Restart => {}
        DesktopCommand::SetMenu(menu) => {
            *c.menu.borrow_mut() = menu.clone();
            c.menu_changed.set(true);
            menus::menu_changed(surface);
            surface.invalidate();
        }
        DesktopCommand::SetMenuBar(mode) => {
            c.menu_bar.set(*mode);
            c.revealed.set(false);
            surface.invalidate();
        }
        DesktopCommand::PopupMenu { items, at } => {
            let anchor = match at {
                Some(at) => {
                    let (ox, oy) = surface.origin.get();
                    menus::Anchor::Point(at.x.0 + ox, at.y.0 + oy)
                }
                None => menus::Anchor::Pointer,
            };
            menus::open(surface, menus::Kind::App, items.clone(), anchor, false);
        }
        // The host app owns the tray and global shortcuts.
        DesktopCommand::SetTray(_)
        | DesktopCommand::RegisterGlobalShortcut { .. }
        | DesktopCommand::UnregisterGlobalShortcut(_) => {}
        // Commands added later.
        #[allow(unreachable_patterns)]
        _ => {}
    }
}

/// The app changed the main window's attributes (`currentWindow().set()`):
/// the title and the title bar are the chrome's, the rest the window's.
fn set_attributes(surface: &Rc<Surface>, attributes: &WindowAttributes) {
    let c = &surface.chrome;
    c.attributes.borrow_mut().merge(attributes);
    if let Some(title) = &attributes.title {
        *c.title.borrow_mut() = title.clone();
        push(surface, Op::Title(title.clone()));
    }
    if let Some(bar) = &attributes.title_bar {
        let height = bar.height.map(|h| h.0);
        let offset = bar.controls_offset.map(|p| (p.x.0, p.y.0));
        let changed =
            c.height.replace(height) != height || c.controls_offset.replace(offset) != offset;
        if c.style.replace(bar.style) != bar.style || changed {
            menus::close(surface);
            push(surface, Op::TitleBar);
        }
    }
    crate::window::main_attributes(surface, attributes);
    surface.invalidate();
}

/// The user asked to close the main window (`reason`): the app hears it,
/// and the window closes unless the app set `closeOnPress: false`.
/// Answered here, without waiting for JS. True when it closes.
pub(crate) fn close_press(surface: &Surface, reason: CloseReason) -> bool {
    let closes = surface.chrome.closes_on_press();
    crate::window::report_close_press(surface, ROOT_ID, reason, false);
    closes
}

impl Chrome {
    /// A close press closes the main window (`closeOnPress`, true unless
    /// the app says otherwise).
    pub(crate) fn closes_on_press(&self) -> bool {
        self.attributes.borrow().close_on_press.unwrap_or(true)
    }

    /// The GPUI window, when the surface fills one of its own.
    pub(crate) fn window(&self) -> Option<AnyWindowHandle> {
        self.standalone.get().then(|| self.window.get()).flatten()
    }
}

/// Asks to close the main window as the user did (`reason`).
pub(crate) fn press_close(surface: &Rc<Surface>, reason: CloseReason) {
    if close_press(surface, reason) {
        push(surface, Op::Close(Some(reason)));
    }
}

/// An item was chosen: the platform carries out its role, the app hears
/// about the rest.
fn choose(surface: &Rc<Surface>, id: u32, role: Option<MenuRole>) {
    match role {
        Some(MenuRole::Quit) => push(surface, Op::Quit),
        Some(MenuRole::Close) => match crate::window::entered(surface) {
            Some(id) => crate::window::close_press(surface, id, CloseReason::Menu),
            None => press_close(surface, CloseReason::Menu),
        },
        Some(MenuRole::Minimize) => push(surface, Op::Minimize),
        Some(MenuRole::Zoom) => push(surface, Op::ToggleMaximize),
        Some(MenuRole::ToggleFullScreen) => push(surface, Op::ToggleFullScreen),
        Some(MenuRole::Hide) => push(surface, Op::Hide),
        Some(MenuRole::HideOthers) => push(surface, Op::HideOthers),
        Some(MenuRole::ShowAll) => push(surface, Op::ShowAll),
        Some(role) if role.edits_text() => edit(surface, role),
        // GPUI has no about panel.
        Some(_) | None => {}
    }
    if id != 0 {
        surface.event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", PayloadValue::Number(id as f64))]),
        );
    }
}

/// An editing role: the focused field gets its own key for it.
fn edit(surface: &Rc<Surface>, role: MenuRole) {
    let mac = PLATFORM == Platform::Mac;
    let (vk, shift) = match role {
        MenuRole::Undo => (0x5A, false),
        MenuRole::Redo if mac => (0x5A, true),
        MenuRole::Redo => (0x59, false),
        MenuRole::Cut => (0x58, false),
        MenuRole::Copy => (0x43, false),
        MenuRole::Paste => (0x56, false),
        _ => (0x41, false),
    };
    crate::input::key(
        surface,
        KeyEvent {
            vk,
            down: true,
            repeat: false,
            modifiers: Modifiers {
                ctrl: !mac,
                meta: mac,
                shift,
                ..Default::default()
            },
        },
    );
}

/// The roles only macOS has a use for (their items are left out of the
/// drawn menus).
fn mac_only(role: Option<MenuRole>) -> bool {
    matches!(
        role,
        Some(MenuRole::About | MenuRole::Hide | MenuRole::HideOthers | MenuRole::ShowAll)
    )
}

// --- Keys -------------------------------------------------------------------------------

/// The shortcut key of virtual key `vk`, if it can be one.
fn shortcut_key(vk: u16) -> Option<Key> {
    Some(match vk {
        0x30..=0x39 | 0x41..=0x5A => Key::Char((vk as u8 as char).to_ascii_lowercase()),
        0x60..=0x69 => Key::Char(char::from(b'0' + (vk - 0x60) as u8)),
        0x70..=0x87 => Key::F((vk - 0x6F) as u8),
        0x0D => Key::Enter,
        0x1B => Key::Escape,
        0x09 => Key::Tab,
        0x08 => Key::Backspace,
        0x2E => Key::Delete,
        0x2D => Key::Insert,
        0x20 => Key::Space,
        0x26 => Key::Up,
        0x28 => Key::Down,
        0x25 => Key::Left,
        0x27 => Key::Right,
        0x24 => Key::Home,
        0x23 => Key::End,
        0x21 => Key::PageUp,
        0x22 => Key::PageDown,
        0xBB => Key::Char('='),
        0xBD => Key::Char('-'),
        0xBC => Key::Char(','),
        0xBE => Key::Char('.'),
        0xBA => Key::Char(';'),
        0xBF => Key::Char('/'),
        0xC0 => Key::Char('`'),
        0xDB => Key::Char('['),
        0xDC => Key::Char('\\'),
        0xDD => Key::Char(']'),
        0xDE => Key::Char('\''),
        _ => return None,
    })
}

/// The shortcut a key down presses.
fn pressed(event: &KeyEvent) -> Option<Shortcut> {
    let m = event.modifiers;
    Some(Shortcut {
        key: shortcut_key(event.vk)?,
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        meta: m.meta,
    })
}

/// The primary modifier (Command on macOS, else Control) with `key`.
fn primary(key: char) -> Shortcut {
    let mac = PLATFORM == Platform::Mac;
    Shortcut {
        ctrl: !mac,
        meta: mac,
        ..Shortcut::key(Key::Char(key))
    }
}

/// What the standalone window does with the keys it keeps for itself.
fn reserved(platform: Platform, pressed: &Shortcut) -> Option<Op> {
    let cmd = |key: char| Shortcut {
        meta: true,
        ..Shortcut::key(Key::Char(key))
    };
    match platform {
        Platform::Mac => {
            if *pressed == cmd('q') {
                Some(Op::Quit)
            } else if *pressed == cmd('h') {
                Some(Op::Hide)
            } else if *pressed
                == (Shortcut {
                    alt: true,
                    ..cmd('h')
                })
            {
                Some(Op::HideOthers)
            } else if *pressed == cmd('m') {
                Some(Op::Minimize)
            } else if *pressed
                == (Shortcut {
                    ctrl: true,
                    ..cmd('f')
                })
            {
                Some(Op::ToggleFullScreen)
            } else {
                None
            }
        }
        Platform::Windows | Platform::Linux => {
            if *pressed
                == (Shortcut {
                    ctrl: true,
                    ..Shortcut::key(Key::Char('q'))
                })
            {
                Some(Op::Quit)
            } else if *pressed == Shortcut::key(Key::F(11)) {
                Some(Op::ToggleFullScreen)
            } else {
                None
            }
        }
    }
}

/// A key down before anything focused sees it (one of the surface's
/// window shortcuts): the open menu's keys, F10 opening the menu bar, and
/// the standalone window's reserved keys.
pub(crate) fn window_key(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    if menus::key(surface, event) {
        return true;
    }
    if !surface.chrome.standalone.get() {
        return false;
    }
    match pressed(event).and_then(|p| reserved(PLATFORM, &p)) {
        Some(op) => {
            if !event.repeat {
                // A window of the app's own minimizes and goes to full
                // screen itself; the rest is the app's.
                let own = crate::window::entered(surface)
                    .filter(|_| matches!(op, Op::Minimize | Op::ToggleFullScreen));
                match own {
                    Some(id) => {
                        crate::window::reserved_key(surface, id, op == Op::ToggleFullScreen)
                    }
                    None => push(surface, op),
                }
            }
            true
        }
        None => false,
    }
}

/// A key down after the app's bindings (`nsh/keymap`): the application
/// menu's shortcuts, the standalone window's Ctrl+W / Cmd+W and Alt + a
/// menu's initial. True when it took the key. An item whose `when` leaves
/// the key to the focused field does not take it
/// ([`MenuAction::fires_while_editing`](nsh_core::desktop::MenuAction::fires_while_editing)).
pub(crate) fn shortcut(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    let c = &surface.chrome;
    if !c.standalone.get() {
        return false;
    }
    let Some(pressed) = pressed(event) else {
        return false;
    };
    let editing = crate::text_input::focused(surface).is_some();
    let found = {
        let menu = c.menu.borrow();
        menu.as_deref().and_then(|items| {
            MenuItem::find_shortcut(items, &pressed)
                .filter(|a| PLATFORM == Platform::Mac || !mac_only(a.role))
                .map(|a| (a.id, a.role, !editing || a.fires_while_editing()))
        })
    };
    if let Some((id, role, fires)) = found {
        if !fires {
            return false;
        }
        if !event.repeat {
            choose(surface, id, role);
        }
        return true;
    }
    if pressed == primary('w') {
        if !event.repeat {
            match crate::window::entered(surface) {
                Some(id) => crate::window::close_press(surface, id, CloseReason::Shortcut),
                None => press_close(surface, CloseReason::Shortcut),
            }
        }
        return true;
    }
    menus::mnemonic(surface, &pressed)
}

// --- The window -------------------------------------------------------------------------

/// Hands `request` to the embedding app's handler, after the event that
/// asked (the view may be rendering). False when it set none.
pub(crate) fn ask_to_close(
    surface: &Surface,
    request: CloseRequest,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let Some(handler) = surface.chrome.on_close.borrow().clone() else {
        return false;
    };
    window.defer(cx, move |window, cx| handler(request, window, cx));
    true
}

/// Carries out the queued window operations.
fn apply_ops(surface: &Surface, window: &mut Window, cx: &mut App) {
    let ops = std::mem::take(&mut *surface.chrome.ops.borrow_mut());
    if !surface.chrome.standalone.get() {
        return;
    }
    for op in ops {
        match op {
            Op::Title(title) => window.set_window_title(&title),
            Op::TitleBar => {
                let hide = hidden(surface);
                if PLATFORM == Platform::Linux {
                    window.request_decorations(if hide {
                        gpui::WindowDecorations::Client
                    } else {
                        gpui::WindowDecorations::Server
                    });
                }
                #[cfg(target_os = "macos")]
                window.set_traffic_light_position(traffic_lights_at(
                    surface.chrome.controls_offset.get(),
                    if hide {
                        surface.chrome.height.get().unwrap_or(MAC_TITLE_HEIGHT)
                    } else {
                        MAC_TITLE_HEIGHT
                    },
                ));
            }
            Op::Minimize => window.minimize_window(),
            Op::ToggleMaximize => {
                if !window.is_fullscreen() {
                    // GPUI's zoom toggles on X11, Wayland and macOS; on Windows
                    // it only maximizes (the caption button restores).
                    window.zoom_window();
                }
            }
            Op::ToggleFullScreen => window.toggle_fullscreen(),
            // A maximized or full-screen window keeps the size the platform
            // gave it. (A tiling compositor's tiles cannot be told apart with
            // server-side decorations: there the compositor decides.)
            Op::Close(_) => {
                if !ask_to_close(surface, CloseRequest::Close, window, cx) {
                    window.remove_window();
                }
            }
            Op::Quit => {
                if !ask_to_close(surface, CloseRequest::Quit, window, cx) {
                    cx.quit();
                }
            }
            Op::Hide => cx.hide(),
            Op::HideOthers => cx.hide_other_apps(),
            Op::ShowAll => cx.unhide_other_apps(),
        }
    }
}

/// Sizes the main window's content (`setContentSize`'s width and height,
/// or `setBounds`' made content sizes by `crate::window::content_size`, a
/// missing one keeping the window's). A maximized or full-screen window
/// keeps the size the platform gave it. (A tiling compositor's tiles cannot
/// be told apart with server-side decorations: there the compositor
/// decides.)
pub(crate) fn resize(
    surface: &Surface,
    window: &mut Window,
    width: Option<f32>,
    height: Option<f32>,
) {
    if window.is_maximized() || window.is_fullscreen() || (width.is_none() && height.is_none()) {
        return;
    }
    let chrome = &surface.chrome;
    let from = window.viewport_size();
    let size = frame_size(from, chrome.asked_size.get(), width, height);
    window.resize(size);
    chrome.asked_size.set(Some(AskedSize { size, from }));
}

/// A double click on the title bar (a drawn title row, a `windowDrag`
/// view).
fn title_double_click(window: &Window) {
    if window.is_fullscreen() {
        return;
    }
    if PLATFORM == Platform::Mac {
        // What System Settings says (zoom by default).
        window.titlebar_double_click();
    } else {
        window.zoom_window();
    }
}

/// The title bar's area as the environment reports it.
fn title_bar_area(
    platform: Platform,
    shown: bool,
    client_decorated: bool,
    height: Option<f32>,
) -> Insets<Points> {
    if !shown {
        return Insets::default();
    }
    match platform {
        Platform::Mac => Insets {
            top: Points(height.unwrap_or(MAC_TITLE_HEIGHT)),
            left: Points(TRAFFIC_LIGHTS_X + TRAFFIC_LIGHTS_SIZE.1 + 8.0),
            ..Insets::default()
        },
        Platform::Windows => Insets {
            top: Points(height.unwrap_or(WINDOWS_CAPTION_HEIGHT)),
            right: Points(3.0 * CAPTION_BUTTON_WIDTH),
            ..Insets::default()
        },
        Platform::Linux if client_decorated => Insets {
            top: Points(height.unwrap_or(LINUX_HEADER_HEIGHT)),
            right: Points(3.0 * LINUX_BUTTON + 2.0 * LINUX_BUTTON_GAP + LINUX_BUTTON_MARGIN),
            ..Insets::default()
        },
        Platform::Linux => Insets::default(),
    }
}

/// The title bar's area a window of the app's own reports, as the main
/// window's: its hidden bar's height and the width its window controls
/// take (the traffic lights where the app put them on macOS; the drawn
/// controls on Windows and, with client-side decorations, Linux). All 0
/// while the system shows its title bar, without a frame, and in full
/// screen.
pub(crate) fn own_title_bar_area(
    hidden: bool,
    frameless: bool,
    full_screen: bool,
    client_decorated: bool,
    height: Option<f32>,
    controls_offset: Option<(f32, f32)>,
) -> Insets<Points> {
    let mut area = title_bar_area(
        PLATFORM,
        hidden && !frameless && !full_screen,
        client_decorated,
        height,
    );
    if PLATFORM == Platform::Mac
        && let Some((x, _)) = controls_offset
        && area.top.0 > 0.0
    {
        area.left = Points(x + TRAFFIC_LIGHTS_SIZE.1 + 8.0);
    }
    area
}

/// What a window of the app's own with a hidden title bar draws over its
/// content, as the main window does: the window controls (Windows; Linux
/// with client-side decorations) and, on Linux, the edges that resize it.
pub(crate) fn own_window_parts(
    surface: &Rc<Surface>,
    root: nsh_core::NodeId,
    height: Option<f32>,
    resizable: bool,
    window: &Window,
) -> Vec<AnyElement> {
    let client = PLATFORM == Platform::Linux
        && matches!(
            window.window_decorations(),
            gpui::Decorations::Client { .. }
        );
    if window.is_fullscreen() || !(PLATFORM == Platform::Windows || client) {
        return Vec::new();
    }
    let theme = Theme::new(crate::system::dark(surface));
    let height = title_bar_area(PLATFORM, true, client, height).top.0;
    let mut parts = vec![
        div()
            .absolute()
            .top_0()
            .right_0()
            .child(controls(
                surface,
                Some(root),
                window.is_maximized(),
                window.is_window_active(),
                height,
                &theme,
            ))
            .into_any_element(),
    ];
    if client && resizable && !window.is_maximized() {
        parts.extend(resize_edges());
    }
    parts
}

/// Reads the window's state and tells the app the title bar's area.
fn observe(surface: &Rc<Surface>, window: &Window, cx: &App) {
    let c = &surface.chrome;
    let full_screen = window.is_fullscreen();
    if c.full_screen.replace(full_screen) != full_screen {
        menus::close(surface);
    }
    c.maximized.set(window.is_maximized());
    c.active.set(window.is_window_active());
    c.client_decorated.set(matches!(
        window.window_decorations(),
        gpui::Decorations::Client { .. }
    ));
    let area = title_bar_area(
        PLATFORM,
        c.standalone.get() && hidden(surface) && !full_screen,
        c.client_decorated.get(),
        c.height.get(),
    );
    let mut env = surface.environment.get();
    if env.title_bar != area {
        env.title_bar = area;
        surface.set_environment(env);
    }
    crate::window::observe_main(surface, window, cx);
}

/// The view renders: carries out the queued operations and wraps the
/// surface's element `content` in the chrome (title row, menu bar, window
/// controls, the open menu).
pub(crate) fn render(
    surface: &Rc<Surface>,
    content: impl IntoElement,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    apply_ops(surface, window, cx);
    observe(surface, window, cx);
    let c = &surface.chrome;
    let standalone = c.standalone.get();
    if standalone && PLATFORM == Platform::Mac && c.menu_changed.replace(false) {
        set_native_menus(surface, cx);
    }
    let theme = Theme::new(crate::system::dark(surface));
    let shows_bars = standalone && !c.full_screen.get();
    let hide = hidden(surface);
    let mut root = div()
        .size_full()
        .flex()
        .flex_col()
        .relative()
        .font_family(crate::text::ui_family().to_string());
    if shows_bars && !hide && PLATFORM != Platform::Linux {
        root = root.child(title_row(surface, &theme));
    }
    if bar_shown(surface) {
        root = root.child(menus::bar(surface, window, &theme));
    } else {
        // A menu the keyboard opens from the hidden bar waits for the
        // bar's items to be placed.
        c.bar_items.borrow_mut().clear();
    }
    let mut body = div()
        .flex_1()
        .min_h(px(0.0))
        .w_full()
        .relative()
        .child(content)
        .child(drag_area(surface, None));
    let client = PLATFORM == Platform::Linux && c.client_decorated.get();
    if shows_bars && hide && (PLATFORM == Platform::Windows || client) {
        let height = title_bar_area(PLATFORM, true, client, c.height.get()).top;
        body = body.child(div().absolute().top_0().right_0().child(controls(
            surface,
            None,
            c.maximized.get(),
            c.active.get(),
            height.0,
            &theme,
        )));
    }
    root = root.child(body);
    if shows_bars && client && !c.maximized.get() {
        root = root.children(resize_edges());
    }
    if let Some(layer) = menus::layer(surface, window, &theme) {
        root = root.child(layer);
    }
    root.into_any_element()
}

/// Listens for presses on `windowDrag` views (over the surface, above its
/// own listeners): a drag moves the window, a double click maximizes it,
/// a secondary press opens the window menu (Linux). `root`: the window of
/// the app's own it is over (none: the main window).
pub(crate) fn drag_area(surface: &Rc<Surface>, root: Option<nsh_core::NodeId>) -> impl IntoElement {
    let s = surface.clone();
    let drag = surface.clone();
    canvas(
        move |bounds, window, _| {
            let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
            // Windows moves the window itself, from its hit test: the
            // drag areas are marked as `HTCAPTION` (which also maximizes
            // and restores on a double click and opens the window menu on
            // a right click); `start_window_move` does nothing there. The
            // views standing for the window's buttons are its buttons
            // (`HTMAXBUTTON` shows the snap layouts).
            let mut areas: Vec<(WindowControlArea, Hitbox)> = Vec::new();
            if PLATFORM == Platform::Windows {
                let _in = crate::window::enter(&drag, root);
                let (ox, oy) = drag.origin.get();
                let mut hitbox = |r: nsh_core::Bounds<Points>| {
                    let b = crate::render::bounds(
                        ox + r.origin.x.0,
                        oy + r.origin.y.0,
                        r.size.width.0,
                        r.size.height.0,
                    );
                    window.insert_hitbox(b.intersect(&bounds), HitboxBehavior::Normal)
                };
                if crate::window::movable(&drag, root) {
                    for r in crate::input::window_drag_rects(&drag) {
                        areas.push((WindowControlArea::Drag, hitbox(r)));
                    }
                }
                for (part, r) in crate::input::window_part_rects(&drag) {
                    use nsh_core::desktop::WindowControl as C;
                    let area = match part {
                        crate::input::WindowPart::Control(C::Minimize) => WindowControlArea::Min,
                        crate::input::WindowPart::Control(C::Maximize) => WindowControlArea::Max,
                        crate::input::WindowPart::Control(C::Close) => WindowControlArea::Close,
                        _ => continue,
                    };
                    areas.push((area, hitbox(r)));
                }
            }
            (hitbox, areas)
        },
        move |_, (hitbox, areas): (Hitbox, Vec<(WindowControlArea, Hitbox)>), window, _| {
            for (control, area) in areas {
                window.insert_window_control_hitbox(control, area);
            }
            let surface = s.clone();
            let h = hitbox.clone();
            window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || !h.is_hovered(window) {
                    return;
                }
                // Windows moves the window itself from the press it hit
                // tests as `HTCAPTION`: the platform hands the press to the
                // app before `DefWindowProc` sees it, so consuming it keeps
                // the window from moving at all (`start_window_move` does
                // nothing on Windows).
                if PLATFORM == Platform::Windows {
                    return;
                }
                let _in = crate::window::enter(&surface, root);
                let (ox, oy) = surface.origin.get();
                let (x, y) = (f32::from(e.position.x), f32::from(e.position.y));
                if !crate::input::window_drag(&surface, x - ox, y - oy) {
                    return;
                }
                match e.button {
                    MouseButton::Left if e.click_count >= 2 => {
                        surface.chrome.drag.set(None);
                        title_double_click(window);
                    }
                    MouseButton::Left => surface.chrome.drag.set(Some((x, y))),
                    // (a view of the app's own with a context menu there
                    // hears the click instead)
                    MouseButton::Right
                        if PLATFORM == Platform::Linux
                            && !crate::input::hears_context_menu(
                                &surface.input_root(),
                                x - ox,
                                y - oy,
                            ) =>
                    {
                        window.show_window_menu(e.position);
                    }
                    _ => return,
                }
                cx.stop_propagation();
            });
            let surface = s.clone();
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let Some((x0, y0)) = surface.chrome.drag.get() else {
                    return;
                };
                if e.pressed_button != Some(MouseButton::Left) {
                    surface.chrome.drag.set(None);
                    return;
                }
                let (x, y) = (f32::from(e.position.x), f32::from(e.position.y));
                if (x - x0).abs() > DRAG_SLOP || (y - y0).abs() > DRAG_SLOP {
                    surface.chrome.drag.set(None);
                    if crate::window::movable(&surface, root) {
                        window.start_window_move();
                    }
                }
                cx.stop_propagation();
            });
            let surface = s;
            window.on_mouse_event(move |_: &MouseUpEvent, phase, _, _| {
                if phase == DispatchPhase::Bubble {
                    surface.chrome.drag.set(None);
                }
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// Presses on the drawn title row: a double click maximizes (zooms), a
/// drag moves the window.
fn title_press(surface: &Rc<Surface>, e: &MouseDownEvent, window: &mut Window) {
    if e.click_count >= 2 {
        surface.chrome.drag.set(None);
        title_double_click(window);
    } else {
        let p = (f32::from(e.position.x), f32::from(e.position.y));
        surface.chrome.drag.set(Some(p));
    }
}

/// The title row of the default style on macOS and Windows (whose windows
/// are opened with a transparent title bar).
fn title_row(surface: &Rc<Surface>, theme: &Theme) -> AnyElement {
    let title = surface.chrome.title.borrow().clone();
    let active = surface.chrome.active.get();
    let color = if active {
        theme.title_text
    } else {
        theme.disabled
    };
    let s = surface.clone();
    let row = div()
        .id("nsh-title-row")
        .w_full()
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .bg(theme.bar)
        .border_b_1()
        .border_color(theme.bar_border)
        .on_mouse_down(MouseButton::Left, move |e, window, cx| {
            // Windows moves the window itself for a press on the caption
            // (its hit test answers `HTCAPTION`, which also maximizes on a
            // double click and opens the window menu): a press the app
            // consumes never reaches `DefWindowProc`, so the window would
            // not move, and `Window::start_window_move` does nothing there.
            if PLATFORM == Platform::Windows {
                return;
            }
            title_press(&s, e, window);
            cx.stop_propagation();
        });
    match PLATFORM {
        Platform::Windows => row
            .h(px(WINDOWS_CAPTION_HEIGHT))
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .flex_1()
                    .pl(px(12.0))
                    .text_size(px(12.0))
                    .text_color(color)
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(title),
            )
            .child(controls(
                surface,
                None,
                surface.chrome.maximized.get(),
                surface.chrome.active.get(),
                WINDOWS_CAPTION_HEIGHT,
                theme,
            ))
            .into_any_element(),
        _ => row
            .h(px(MAC_TITLE_HEIGHT))
            .justify_center()
            .text_size(px(13.0))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(color)
            .child(title)
            .into_any_element(),
    }
}

/// A window control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Control {
    Minimize,
    Maximize,
    Close,
}

/// The window controls (Windows' caption buttons, GTK-style window
/// buttons on Linux), `height` points tall.
/// The window controls drawn over a hidden title bar (Windows; Linux with
/// client-side decorations): the main window's (`root` `None`, its state
/// the chrome's) or those of a window of the app's own.
fn controls(
    surface: &Rc<Surface>,
    root: Option<nsh_core::NodeId>,
    maximized: bool,
    active: bool,
    height: f32,
    theme: &Theme,
) -> impl IntoElement {
    let mut row = div()
        .flex()
        .flex_row()
        .items_center()
        .h(px(height))
        .occlude();
    if PLATFORM == Platform::Linux {
        row = row.gap(px(LINUX_BUTTON_GAP)).pr(px(LINUX_BUTTON_MARGIN));
    }
    for (i, control) in [Control::Minimize, Control::Maximize, Control::Close]
        .into_iter()
        .enumerate()
    {
        row = row.child(control_button(
            surface, root, control, i, height, maximized, active, theme,
        ));
    }
    row
}

#[allow(clippy::too_many_arguments)]
fn control_button(
    surface: &Rc<Surface>,
    root: Option<nsh_core::NodeId>,
    control: Control,
    index: usize,
    height: f32,
    maximized: bool,
    active: bool,
    theme: &Theme,
) -> AnyElement {
    let windows = PLATFORM == Platform::Windows;
    let color = if active { theme.text } else { theme.disabled };
    let icon = control_icon(control, maximized, color, if windows { 10.0 } else { 8.0 });
    let button = div()
        .id(("nsh-window-control", index))
        .flex()
        .items_center()
        .justify_center()
        .child(icon);
    if windows {
        let (hover, press) = if control == Control::Close {
            (theme.close_hover, theme.close_press)
        } else {
            (theme.caption_hover, theme.caption_press)
        };
        let area = match control {
            Control::Minimize => WindowControlArea::Min,
            Control::Maximize => WindowControlArea::Max,
            Control::Close => WindowControlArea::Close,
        };
        // Windows hit-tests the area and clicks the button itself.
        return button
            .w(px(CAPTION_BUTTON_WIDTH))
            .h(px(height))
            .window_control_area(area)
            .hover(move |s| s.bg(hover))
            .active(move |s| s.bg(press))
            .into_any_element();
    }
    let s = surface.clone();
    let (hover, press) = (theme.button_hover, theme.button_press);
    button
        .size(px(LINUX_BUTTON))
        .rounded_full()
        .bg(theme.button)
        .hover(move |s| s.bg(hover))
        .active(move |s| s.bg(press))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            match control {
                Control::Minimize => window.minimize_window(),
                Control::Maximize => window.zoom_window(),
                Control::Close => match root {
                    Some(id) => crate::window::close_press(&s, id, CloseReason::CloseButton),
                    None => press_close(&s, CloseReason::CloseButton),
                },
            }
            s.invalidate();
            crate::rt::flush(cx);
        })
        .into_any_element()
}

/// A control's glyph: lines one pixel wide in a `size` point square.
fn control_icon(
    control: Control,
    maximized: bool,
    color: gpui::Rgba,
    size: f32,
) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let o = bounds.origin;
            let (x0, y0) = (f32::from(o.x), f32::from(o.y));
            let line = 1.0 / window.scale_factor();
            let p = |x: f32, y: f32| gpui::point(px(x0 + x), px(y0 + y));
            let mut b = gpui::PathBuilder::stroke(px(line.max(1.0)));
            match control {
                Control::Minimize => {
                    b.move_to(p(0.0, size / 2.0));
                    b.line_to(p(size, size / 2.0));
                }
                Control::Maximize if maximized => {
                    // Restore: a square with another behind it.
                    let o = size * 0.2;
                    b.move_to(p(0.0, o));
                    b.line_to(p(size - o, o));
                    b.line_to(p(size - o, size));
                    b.line_to(p(0.0, size));
                    b.close();
                    b.move_to(p(o, o));
                    b.line_to(p(o, 0.0));
                    b.line_to(p(size, 0.0));
                    b.line_to(p(size, size - o));
                    b.line_to(p(size - o, size - o));
                }
                Control::Maximize => {
                    b.move_to(p(0.0, 0.0));
                    b.line_to(p(size, 0.0));
                    b.line_to(p(size, size));
                    b.line_to(p(0.0, size));
                    b.close();
                }
                Control::Close => {
                    b.move_to(p(0.0, 0.0));
                    b.line_to(p(size, size));
                    b.move_to(p(size, 0.0));
                    b.line_to(p(0.0, size));
                }
            }
            if let Ok(path) = b.build() {
                window.paint_path(path, color);
            }
        },
    )
    .size(px(size))
}

/// The edges that resize a client-decorated window (Linux).
fn resize_edges() -> Vec<AnyElement> {
    let e = px(RESIZE_EDGE);
    let corner = px(RESIZE_EDGE * 2.0);
    let edge = |i: usize, edge: ResizeEdge, cursor: CursorStyle| {
        div()
            .id(("nsh-resize-edge", i))
            .absolute()
            .occlude()
            .cursor(cursor)
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                window.start_window_resize(edge);
                cx.stop_propagation();
            })
    };
    vec![
        edge(0, ResizeEdge::Top, CursorStyle::ResizeUpDown)
            .top_0()
            .left(corner)
            .right(corner)
            .h(e),
        edge(1, ResizeEdge::Bottom, CursorStyle::ResizeUpDown)
            .bottom_0()
            .left(corner)
            .right(corner)
            .h(e),
        edge(2, ResizeEdge::Left, CursorStyle::ResizeLeftRight)
            .left_0()
            .top(corner)
            .bottom(corner)
            .w(e),
        edge(3, ResizeEdge::Right, CursorStyle::ResizeLeftRight)
            .right_0()
            .top(corner)
            .bottom(corner)
            .w(e),
        edge(4, ResizeEdge::TopLeft, CursorStyle::ResizeUpLeftDownRight)
            .top_0()
            .left_0()
            .size(corner),
        edge(5, ResizeEdge::TopRight, CursorStyle::ResizeUpRightDownLeft)
            .top_0()
            .right_0()
            .size(corner),
        edge(
            6,
            ResizeEdge::BottomLeft,
            CursorStyle::ResizeUpRightDownLeft,
        )
        .bottom_0()
        .left_0()
        .size(corner),
        edge(
            7,
            ResizeEdge::BottomRight,
            CursorStyle::ResizeUpLeftDownRight,
        )
        .bottom_0()
        .right_0()
        .size(corner),
    ]
    .into_iter()
    .map(IntoElement::into_any_element)
    .collect()
}

// --- macOS's menu bar -------------------------------------------------------------------

/// An item of the native menus (macOS) was chosen.
#[derive(Clone, PartialEq, Debug, gpui::Action)]
#[action(namespace = nsh, no_json, no_register)]
struct MenuCommand {
    /// The surface ([`Surface::by_key`]).
    surface: u64,
    /// The item, in [`Chrome::entries`].
    index: usize,
}

/// The context no element has: the native menus' key bindings only show
/// their shortcuts (nsh matches them in [`shortcut`]).
const MENU_SHORTCUT_CONTEXT: &str = "nsh_menu_shortcut";

/// The standalone app's menu on macOS until the app sets one.
fn default_mac_menu(title: &str) -> Arc<[MenuItem]> {
    let role = |role: MenuRole| {
        MenuItem::Action(nsh_core::desktop::MenuAction {
            id: 0,
            label: String::new(),
            shortcut: role.shortcut(true),
            enabled: true,
            checked: None,
            role: Some(role),
            when: nsh_core::keymap::When::Always,
            icon: None,
        })
    };
    let submenu = |label: &str, items: Vec<MenuItem>| MenuItem::Submenu {
        label: label.to_owned(),
        enabled: true,
        items,
        icon: None,
    };
    vec![
        submenu(
            title,
            vec![
                role(MenuRole::Hide),
                role(MenuRole::HideOthers),
                role(MenuRole::ShowAll),
                MenuItem::Separator,
                role(MenuRole::Quit),
            ],
        ),
        submenu(
            "Edit",
            vec![
                role(MenuRole::Undo),
                role(MenuRole::Redo),
                MenuItem::Separator,
                role(MenuRole::Cut),
                role(MenuRole::Copy),
                role(MenuRole::Paste),
                role(MenuRole::SelectAll),
            ],
        ),
        submenu(
            "Window",
            vec![
                role(MenuRole::Minimize),
                role(MenuRole::Zoom),
                role(MenuRole::ToggleFullScreen),
                MenuItem::Separator,
                role(MenuRole::Close),
            ],
        ),
    ]
    .into()
}

/// GPUI's name of a shortcut (`shift-cmd-n`).
fn gpui_keystroke(s: &Shortcut) -> String {
    let mut out = String::new();
    for (on, name) in [
        (s.ctrl, "ctrl-"),
        (s.alt, "alt-"),
        (s.shift, "shift-"),
        (s.meta, "cmd-"),
    ] {
        if on {
            out.push_str(name);
        }
    }
    match s.key {
        Key::Char(c) => out.push(c),
        Key::Enter => out.push_str("enter"),
        Key::Escape => out.push_str("escape"),
        Key::Tab => out.push_str("tab"),
        Key::Backspace => out.push_str("backspace"),
        Key::Delete => out.push_str("delete"),
        Key::Insert => out.push_str("insert"),
        Key::Space => out.push_str("space"),
        Key::Up => out.push_str("up"),
        Key::Down => out.push_str("down"),
        Key::Left => out.push_str("left"),
        Key::Right => out.push_str("right"),
        Key::Home => out.push_str("home"),
        Key::End => out.push_str("end"),
        Key::PageUp => out.push_str("pageup"),
        Key::PageDown => out.push_str("pagedown"),
        Key::F(n) => out.push_str(&format!("f{n}")),
    }
    out
}

/// `items` as GPUI's native menus (macOS): GPUI's `MenuItem` has no image,
/// so these show no icons, unlike the rows [`menus`] draws.
fn native_items(
    surface: u64,
    items: &[MenuItem],
    entries: &mut Vec<(u32, Option<MenuRole>)>,
    bindings: &mut Vec<gpui::KeyBinding>,
    cx: &App,
) -> Vec<gpui::MenuItem> {
    items
        .iter()
        .map(|item| match item {
            MenuItem::Separator => gpui::MenuItem::separator(),
            MenuItem::Action(a) => {
                let action = MenuCommand {
                    surface,
                    index: entries.len(),
                };
                entries.push((a.id, a.role));
                if let Some(s) = a.shortcut.or_else(|| a.role.and_then(|r| r.shortcut(true))) {
                    // `KeyBinding::new` takes static keystrokes; `load` parses
                    // this one with the same mapping on macOS, where the menu
                    // bar is native.
                    let context = gpui::KeyBindingContextPredicate::parse(MENU_SHORTCUT_CONTEXT)
                        .unwrap()
                        .into();
                    bindings.push(
                        gpui::KeyBinding::load(
                            &gpui_keystroke(&s),
                            Box::new(action.clone()),
                            Some(context),
                            false,
                            None,
                            cx,
                        )
                        .unwrap(),
                    );
                }
                gpui::MenuItem::action(menus::label(a), action)
                    .checked(a.checked == Some(true))
                    .disabled(!a.enabled)
            }
            MenuItem::Submenu {
                label,
                enabled,
                items,
                ..
            } => gpui::MenuItem::submenu(gpui::Menu {
                name: label.clone().into(),
                items: native_items(surface, items, entries, bindings, cx),
                disabled: !enabled,
            }),
        })
        .collect()
}

/// Sets the application menu as macOS's menu bar.
fn set_native_menus(surface: &Surface, cx: &mut App) {
    thread_local! {
        static LISTENING: Cell<bool> = const { Cell::new(false) };
    }
    if !LISTENING.with(|l| l.replace(true)) {
        cx.on_action(|command: &MenuCommand, cx| {
            if let Some(surface) = Surface::by_key(command.surface) {
                let entry = surface.chrome.entries.borrow().get(command.index).copied();
                if let Some((id, role)) = entry {
                    choose(&surface, id, role);
                }
            }
            crate::rt::flush(cx);
        });
    }
    let c = &surface.chrome;
    let items = c
        .menu
        .borrow()
        .clone()
        .unwrap_or_else(|| default_mac_menu(&c.title.borrow()));
    let mut entries = Vec::new();
    let mut bindings = Vec::new();
    // The menu bar holds menus: top-level items of other kinds are left
    // out.
    let menus: Vec<gpui::Menu> = items
        .iter()
        .filter_map(|item| match item {
            MenuItem::Submenu {
                label,
                enabled,
                items,
                ..
            } => Some(gpui::Menu {
                name: label.clone().into(),
                items: native_items(surface.key(), items, &mut entries, &mut bindings, cx),
                disabled: !enabled,
            }),
            _ => None,
        })
        .collect();
    *c.entries.borrow_mut() = entries;
    cx.clear_key_bindings();
    cx.bind_keys(bindings);
    cx.set_menus(menus);
}

// --- Colors -----------------------------------------------------------------------------

/// The chrome's colors in the app's appearance.
#[derive(Clone, Copy)]
pub(crate) struct Theme {
    /// A menu's background, border and separators.
    panel: gpui::Rgba,
    border: gpui::Rgba,
    separator: gpui::Rgba,
    /// Text, disabled text and shortcuts.
    text: gpui::Rgba,
    disabled: gpui::Rgba,
    secondary: gpui::Rgba,
    /// The highlighted item (and the open menu of the bar).
    highlight: gpui::Rgba,
    /// The menu bar and the title row.
    bar: gpui::Rgba,
    bar_border: gpui::Rgba,
    title_text: gpui::Rgba,
    /// Windows' caption buttons.
    caption_hover: gpui::Rgba,
    caption_press: gpui::Rgba,
    close_hover: gpui::Rgba,
    close_press: gpui::Rgba,
    /// GTK-style window buttons.
    button: gpui::Rgba,
    button_hover: gpui::Rgba,
    button_press: gpui::Rgba,
}

impl Theme {
    fn new(dark: bool) -> Theme {
        use gpui::rgba;
        if dark {
            Theme {
                panel: rgba(0x2c2c2eff),
                border: rgba(0xffffff1f),
                separator: rgba(0xffffff1a),
                text: rgba(0xf2f2f2ff),
                disabled: rgba(0xffffff5c),
                secondary: rgba(0xffffff99),
                highlight: rgba(0xffffff17),
                bar: rgba(0x202020ff),
                bar_border: rgba(0xffffff14),
                title_text: rgba(0xe6e6e6ff),
                caption_hover: rgba(0xffffff14),
                caption_press: rgba(0xffffff0c),
                close_hover: rgba(0xc42b1cff),
                close_press: rgba(0xc42b1ce6),
                button: rgba(0xffffff17),
                button_hover: rgba(0xffffff26),
                button_press: rgba(0xffffff33),
            }
        } else {
            Theme {
                panel: rgba(0xffffffff),
                border: rgba(0x00000024),
                separator: rgba(0x0000001a),
                text: rgba(0x1c1c1eff),
                disabled: rgba(0x00000059),
                secondary: rgba(0x0000008c),
                highlight: rgba(0x0000000f),
                bar: rgba(0xf3f3f3ff),
                bar_border: rgba(0x00000014),
                title_text: rgba(0x1c1c1eff),
                caption_hover: rgba(0x00000012),
                caption_press: rgba(0x0000001c),
                close_hover: rgba(0xc42b1cff),
                close_press: rgba(0xc42b1ce6),
                button: rgba(0x0000000f),
                button_hover: rgba(0x0000001a),
                button_press: rgba(0x00000026),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::desktop::{Key, Shortcut};

    use super::*;

    #[test]
    fn set_frame_keeps_the_size_asked_until_the_window_changes() {
        let size = |width: f32, height: f32| gpui::size(gpui::px(width), gpui::px(height));
        let current = size(800.0, 600.0);
        // Nothing asked yet: a size left out is the window's.
        assert_eq!(
            frame_size(current, None, Some(640.0), None),
            size(640.0, 600.0)
        );
        // The platform has not applied the last size: a size left out is that one's.
        let asked = Some(AskedSize {
            size: size(640.0, 600.0),
            from: current,
        });
        assert_eq!(
            frame_size(current, asked, None, Some(400.0)),
            size(640.0, 400.0)
        );
        // It has (or the user has dragged the window): the window's own size counts.
        assert_eq!(
            frame_size(size(700.0, 500.0), asked, None, Some(400.0)),
            size(700.0, 400.0)
        );
    }

    #[test]
    fn set_frame_sizes_each_side_at_least_one_point() {
        let size = |width: f32, height: f32| gpui::size(gpui::px(width), gpui::px(height));
        let current = size(800.0, 600.0);
        assert_eq!(
            frame_size(current, None, Some(0.4), Some(0.4)),
            size(1.0, 1.0)
        );
        assert_eq!(frame_size(current, None, None, Some(0.0)), size(800.0, 1.0));
        assert_eq!(frame_size(current, None, Some(1.5), None), size(1.5, 600.0));
    }

    #[gpui::test]
    fn focus_activates_without_rendering_and_leaves_embedded_windows_alone(
        cx: &mut gpui::TestAppContext,
    ) {
        use gpui::AppContext;

        let (surface, target, other, _app) = cx.update(|cx| {
            let app = crate::rt::init_test_app(cx);
            let target = cx
                .open_window(Default::default(), |_, cx| cx.new(|_| gpui::Empty))
                .unwrap();
            let other = cx
                .open_window(Default::default(), |_, cx| cx.new(|_| gpui::Empty))
                .unwrap();
            other
                .update(cx, |_, window, _| window.activate_window())
                .unwrap();
            (Surface::new(Default::default()), target, other, app)
        });
        cx.run_until_parked();
        command(
            &surface,
            &DesktopCommand::Request(nsh_core::desktop::WindowRequest::Focus),
        );
        cx.run_until_parked();
        cx.update(|cx| assert_eq!(cx.active_window(), Some(other.into())));

        set_standalone(&surface, "Target", target.into());
        command(
            &surface,
            &DesktopCommand::Request(nsh_core::desktop::WindowRequest::Focus),
        );
        // No frame is rendered: activation must not depend on the render queue.
        cx.run_until_parked();
        cx.update(|cx| assert_eq!(cx.active_window(), Some(target.into())));
    }

    #[test]
    fn title_bar_areas() {
        assert_eq!(
            title_bar_area(Platform::Windows, false, false, None),
            Insets::default()
        );
        let windows = title_bar_area(Platform::Windows, true, false, Some(40.0));
        assert_eq!(
            (windows.top.0, windows.right.0, windows.left.0),
            (40.0, 138.0, 0.0)
        );
        let mac = title_bar_area(Platform::Mac, true, false, None);
        assert_eq!((mac.top.0, mac.left.0, mac.right.0), (28.0, 71.0, 0.0));
        // Linux reports an area only when the window draws its own
        // decorations.
        assert_eq!(
            title_bar_area(Platform::Linux, true, false, Some(40.0)),
            Insets::default()
        );
        let linux = title_bar_area(Platform::Linux, true, true, None);
        assert_eq!((linux.top.0, linux.right.0), (46.0, 98.0));
    }

    #[test]
    fn reserved_keys() {
        let ctrl_q = Shortcut {
            ctrl: true,
            ..Shortcut::key(Key::Char('q'))
        };
        assert_eq!(reserved(Platform::Linux, &ctrl_q), Some(Op::Quit));
        assert_eq!(reserved(Platform::Mac, &ctrl_q), None);
        let f11 = Shortcut::key(Key::F(11));
        assert_eq!(
            reserved(Platform::Windows, &f11),
            Some(Op::ToggleFullScreen)
        );
        let ctrl_cmd_f = Shortcut {
            ctrl: true,
            meta: true,
            ..Shortcut::key(Key::Char('f'))
        };
        assert_eq!(
            reserved(Platform::Mac, &ctrl_cmd_f),
            Some(Op::ToggleFullScreen)
        );
        // Ctrl+W is the app's to bind: not reserved.
        let ctrl_w = Shortcut {
            ctrl: true,
            ..Shortcut::key(Key::Char('w'))
        };
        assert_eq!(reserved(Platform::Linux, &ctrl_w), None);
    }

    #[test]
    fn shortcut_keys() {
        assert_eq!(shortcut_key(0x4E), Some(Key::Char('n')));
        assert_eq!(shortcut_key(0x7A), Some(Key::F(11)));
        assert_eq!(shortcut_key(0xBB), Some(Key::Char('=')));
        assert_eq!(shortcut_key(0x10), None);
    }

    #[test]
    fn gpui_keystrokes() {
        let s = Shortcut {
            meta: true,
            shift: true,
            ..Shortcut::key(Key::Char('n'))
        };
        assert_eq!(gpui_keystroke(&s), "shift-cmd-n");
        assert_eq!(gpui_keystroke(&Shortcut::key(Key::F(5))), "f5");
        let minus = Shortcut {
            meta: true,
            ..Shortcut::key(Key::Char('-'))
        };
        assert_eq!(gpui_keystroke(&minus), "cmd--");
    }
}
