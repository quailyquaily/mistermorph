//! What GPUI has no call for, on the native window under a GPUI window:
//! AppKit's `NSWindow` on macOS, the `HWND` on Windows. On Linux (X11,
//! Wayland) GPUI's calls are all there is: these do what GPUI can, or
//! nothing.

use gpui::Window;
#[cfg(target_os = "linux")]
pub(crate) use linux::*;
#[cfg(target_os = "macos")]
pub(crate) use mac::*;
use nsh_core::desktop::{TitleBarStyle, WindowAttributes, WindowKind};
#[cfg(windows)]
pub(crate) use win::*;

/// What each platform does with an attribute it has a native call for:
/// shared by the three implementations so they read alike.
#[allow(dead_code)]
fn on<T: Clone>(value: &Option<T>, f: impl FnOnce(T)) {
    if let Some(v) = value {
        f(v.clone());
    }
}

/// Whether a move to `x` / `y` moves the window: a coordinate given,
/// every one given a number.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn valid_origin(x: Option<f32>, y: Option<f32>) -> bool {
    (x.is_some() || y.is_some()) && x.is_none_or(f32::is_finite) && y.is_none_or(f32::is_finite)
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};

    use nsh_core::desktop::{WindowLevel, Workspaces};
    use objc2::{MainThreadMarker, rc::Retained};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        NSApplication, NSApplicationActivationPolicy, NSRequestUserAttentionType, NSScreen, NSView,
        NSWindow, NSWindowButton, NSWindowCollectionBehavior, NSWindowLevel, NSWindowOrderingMode,
        NSWindowStyleMask, NSWindowTitleVisibility,
    };
    use objc2_foundation::{NSNumber, NSPoint, NSRect, NSSize, ns_string};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use super::*;

    /// `FLT_MAX`, AppKit's default content maximum size.
    const NO_LIMIT: f64 = f32::MAX as f64;

    /// A size AppKit can take: finite and not negative.
    fn finite_size(s: nsh_core::Size<nsh_core::Points>) -> Option<NSSize> {
        let (w, h) = (s.width.0, s.height.0);
        (w.is_finite() && h.is_finite() && w >= 0.0 && h >= 0.0)
            .then(|| NSSize::new(w.into(), h.into()))
    }

    /// The `NSWindow` of a GPUI window.
    fn ns_window(window: &Window) -> Option<Retained<NSWindow>> {
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return None;
        };
        // SAFETY: GPUI owns this live NSView, and window updates run on
        // AppKit's main thread. The borrowed reference stays in this call.
        let view = unsafe { &*handle.ns_view.as_ptr().cast::<NSView>() };
        view.window()
    }

    /// The level of each of `WindowLevel`'s.
    pub(crate) fn level(level: WindowLevel) -> NSWindowLevel {
        match level {
            WindowLevel::Normal => 0,
            WindowLevel::Floating => 3,
            // Above the Dock (20) and the menu bar (24): the status level.
            WindowLevel::AboveDock => 25,
            // `CGWindowLevelForKey(kCGDesktopIconWindowLevelKey)`.
            WindowLevel::DesktopIcon => -2_147_483_603,
            #[allow(unreachable_patterns)]
            _ => 0,
        }
    }

    fn set_mask(w: &NSWindow, bits: NSWindowStyleMask, on: bool) {
        let mask = w.styleMask();
        let next = if on { mask | bits } else { mask & !bits };
        if next != mask {
            w.setStyleMask(next);
        }
    }

    pub(crate) fn apply(window: &Window, a: &WindowAttributes) {
        let Some(w) = ns_window(window) else { return };
        on(&a.level, |l| w.setLevel(level(l)));
        on(&a.workspaces, |ws| {
            let mut b = w.collectionBehavior();
            b.set(
                NSWindowCollectionBehavior::CanJoinAllSpaces,
                ws == Workspaces::All,
            );
            if ws == Workspaces::All {
                b.remove(NSWindowCollectionBehavior::MoveToActiveSpace);
            }
            w.setCollectionBehavior(b);
        });
        on(&a.shadow, |s| w.setHasShadow(s));
        on(&a.taskbar, |t| w.setExcludedFromWindowsMenu(!t));
        on(&a.movable, |m| w.setMovable(m));
        on(&a.resizable, |r| {
            set_mask(&w, NSWindowStyleMask::Resizable, r)
        });
        on(&a.minimizable, |m| {
            set_mask(&w, NSWindowStyleMask::Miniaturizable, m)
        });
        on(&a.closable, |c| {
            set_mask(&w, NSWindowStyleMask::Closable, c)
        });
        on(&a.maximizable, |m| {
            if let Some(button) = w.standardWindowButton(NSWindowButton::ZoomButton) {
                button.setEnabled(m);
            }
        });
        on(&a.min_size, |s| {
            let s = s.and_then(finite_size).unwrap_or(NSSize::new(0.0, 0.0));
            w.setContentMinSize(s);
        });
        on(&a.max_size, |s| {
            // AppKit's own "no limit" (`FLT_MAX`): zooming does arithmetic
            // with the limit, and `f64::MAX` overflows it into a NaN frame.
            let s = s
                .and_then(finite_size)
                .unwrap_or(NSSize::new(NO_LIMIT, NO_LIMIT));
            w.setContentMaxSize(s);
        });
    }

    /// Its frame drawn dark or light (`None`: the system's).
    pub(crate) fn set_scheme(window: &Window, dark: Option<bool>) {
        let Some(w) = ns_window(window) else { return };
        // SAFETY: AppKit's constant appearance names.
        let name = unsafe {
            match dark {
                Some(false) => Some(NSAppearanceNameAqua),
                Some(true) => Some(NSAppearanceNameDarkAqua),
                None => None,
            }
        };
        let appearance = name.and_then(NSAppearance::appearanceNamed);
        w.setAppearance(appearance.as_deref());
    }

    /// The title bar shown, hidden (the content under it, the traffic
    /// lights over it) or gone with the frame.
    pub(crate) fn set_title_bar(window: &mut Window, style: TitleBarStyle, frameless: bool) {
        let Some(w) = ns_window(window) else { return };
        let hidden = frameless || style == TitleBarStyle::Hidden;
        set_mask(&w, NSWindowStyleMask::FullSizeContentView, hidden);
        w.setTitlebarAppearsTransparent(hidden);
        w.setTitleVisibility(if hidden {
            NSWindowTitleVisibility::Hidden
        } else {
            NSWindowTitleVisibility::Visible
        });
        for b in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(button) = w.standardWindowButton(b) {
                button.setHidden(frameless);
            }
        }
    }

    pub(crate) fn set_click_through(window: &Window, through: bool) {
        if let Some(w) = ns_window(window) {
            w.setIgnoresMouseEvents(through);
        }
    }

    thread_local! {
        /// The order-ins [`show`] left to the next turn, by window, each
        /// with its own number: a hide, a removal or another show of the
        /// window before it runs takes it out, and it does nothing.
        static ORDER_INS: RefCell<Vec<(usize, u64)>> = const { RefCell::new(Vec::new()) };
        static NEXT_ORDER_IN: Cell<u64> = const { Cell::new(0) };
    }

    fn key(w: &NSWindow) -> usize {
        std::ptr::from_ref(w) as usize
    }

    /// The window's order-in left to the next turn, if one was, no longer
    /// runs.
    fn cancel_order_in(w: &NSWindow) {
        let key = key(w);
        ORDER_INS.with_borrow_mut(|o| o.retain(|&(k, _)| k != key));
    }

    /// Orders the window in unless it `activate`s (GPUI's activation shows
    /// it then); one that `keep`s its size gets its frame back after AppKit
    /// fitted it to its screen.
    pub(crate) fn show(window: &Window, activate: bool, keep: bool) {
        let Some(w) = ns_window(window).filter(|_| !activate) else {
            return;
        };
        cancel_order_in(&w);
        if !keep {
            order_in(&w, false);
            return;
        }
        // On the next turn, outside GPUI's app: AppKit fits a window to its
        // screen as it orders it in, and a frame set is reported to GPUI's
        // resize callback at once, which cannot update the app while it is
        // being updated (as it is here) and drops the resize. Out of it,
        // GPUI follows both, and knows the size the window ends up at.
        // Requests after this one in the same turn run before it: a hide
        // or a removal takes it out ([`cancel_order_in`]), and the frame
        // put back is the one the window has when it runs.
        let number = NEXT_ORDER_IN.replace(NEXT_ORDER_IN.get() + 1);
        let entry = (key(&w), number);
        ORDER_INS.with_borrow_mut(|o| o.push(entry));
        crate::rt::outside_app(move || {
            let pending = ORDER_INS.with_borrow_mut(|o| {
                let i = o.iter().position(|&e| e == entry);
                i.map(|i| o.swap_remove(i)).is_some()
            });
            if pending {
                order_in(&w, true);
            }
        });
    }

    /// Orders `w` in; with `keep`, at the frame it had before AppKit
    /// fitted it to its screen.
    fn order_in(w: &NSWindow, keep: bool) {
        let frame = w.frame();
        // An inactive app's window ordered front stays behind the front
        // app's: a background app's shows regardless.
        if in_background() {
            w.orderFrontRegardless();
        } else {
            w.orderFront(None);
        }
        if keep && w.frame() != frame {
            w.setFrame_display(frame, true);
        }
    }

    /// The window is about to be removed: an order-in left to the next
    /// turn does not bring it back.
    pub(crate) fn removing(window: &Window) {
        if let Some(w) = ns_window(window) {
            cancel_order_in(&w);
        }
    }

    /// The displays with their frames in the desktop (CoreGraphics' global
    /// coordinates, so a mirror's frame is its primary's), the main display
    /// (the one with the menu bar) first, then the others in the system's
    /// order; their ids are GPUI's (`CGDirectDisplayID`). GPUI's own frames
    /// all start at the origin.
    pub(crate) fn displays(_cx: &gpui::App) -> Vec<(gpui::DisplayId, gpui::Bounds<gpui::Pixels>)> {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGMainDisplayID() -> u32;
            fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
            fn CGDisplayBounds(display: u32) -> NSRect;
        }
        let mut ids = [0u32; 32];
        let mut count = 0u32;
        // SAFETY: `ids` has room for the entries asked for, and `count`
        // reports how many were written.
        if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } != 0 {
            return Vec::new();
        }
        let ids = &ids[..(count as usize).min(ids.len())];
        // SAFETY: a plain query.
        let main = unsafe { CGMainDisplayID() };
        let primary = ids.iter().filter(|&&id| id == main);
        let others = ids.iter().filter(|&&id| id != main);
        primary
            .chain(others)
            .map(|&id| {
                // SAFETY: a plain query of an active display.
                let r = unsafe { CGDisplayBounds(id) };
                let bounds = gpui::Bounds::new(
                    gpui::point(gpui::px(r.origin.x as f32), gpui::px(r.origin.y as f32)),
                    gpui::size(
                        gpui::px(r.size.width as f32),
                        gpui::px(r.size.height as f32),
                    ),
                );
                (gpui::DisplayId::new(u64::from(id)), bounds)
            })
            .collect()
    }

    /// The cutouts of display `id` (GPUI's id, its `CGDirectDisplayID`)
    /// whose screen bounds are `bounds`: the notch of the `NSScreen` that
    /// is that display, computed as the AppKit backend does
    /// ([`nsh_core::desktop::notch`]). Only the auxiliary areas' sizes and
    /// the safe area's inset are read, so `bounds` alone places it in the
    /// same screen coordinates as the display.
    pub(crate) fn cutouts(
        id: gpui::DisplayId,
        bounds: nsh_core::Bounds<nsh_core::Points>,
    ) -> Vec<nsh_core::Bounds<nsh_core::Points>> {
        let Some(mtm) = MainThreadMarker::new() else {
            return Vec::new();
        };
        let number = u64::from(id) as u32;
        let Some(screen) = NSScreen::screens(mtm)
            .iter()
            .find(|s| screen_number(s) == Some(number))
        else {
            return Vec::new();
        };
        let area = |r: NSRect| {
            nsh_core::Size::new(
                nsh_core::Points(r.size.width as f32),
                nsh_core::Points(r.size.height as f32),
            )
        };
        nsh_core::desktop::notch(
            bounds,
            area(screen.auxiliaryTopLeftArea()),
            area(screen.auxiliaryTopRightArea()),
            nsh_core::Points(screen.safeAreaInsets().top as f32),
        )
        .into_iter()
        .collect()
    }

    /// The screen's display id (`CGDirectDisplayID`).
    fn screen_number(screen: &NSScreen) -> Option<u32> {
        let number = screen
            .deviceDescription()
            .objectForKey(ns_string!("NSScreenNumber"))?;
        let number = number.downcast::<NSNumber>().ok()?;
        Some(number.unsignedIntValue())
    }

    /// The app runs in the background: it never becomes the active app
    /// (`NSApplicationActivationPolicyProhibited`, which keeps it out of
    /// the Dock too; an `Accessory` app is not guaranteed to stay inactive
    /// as its window comes up).
    pub(crate) fn run_in_background() {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm)
                .setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
        }
    }

    fn in_background() -> bool {
        MainThreadMarker::new().is_some_and(|mtm| {
            NSApplication::sharedApplication(mtm).activationPolicy()
                == NSApplicationActivationPolicy::Prohibited
        })
    }

    pub(crate) fn hide(window: &Window) {
        if let Some(w) = ns_window(window) {
            cancel_order_in(&w);
            w.orderOut(None);
        }
    }

    /// Not hidden: on screen, or minimized.
    pub(crate) fn visible(window: &Window) -> bool {
        ns_window(window).is_none_or(|w| w.isVisible() || w.isMiniaturized())
    }

    pub(crate) fn restore(window: &Window) {
        if let Some(w) = ns_window(window)
            && w.isMiniaturized()
        {
            w.deminiaturize(None);
        }
    }

    pub(crate) fn minimized(window: &Window) -> bool {
        ns_window(window).is_some_and(|w| w.isMiniaturized())
    }

    /// Moves the window's top left corner to `(x, y)` (points, from the
    /// primary display's top left corner, `y` down; one left out stays),
    /// once the GPUI update this runs in ends: AppKit tells GPUI of the
    /// move (and of a new display) as it moves the window, which GPUI
    /// cannot take during one. The coordinate left out is the window's when
    /// the move runs, after the moves asked before it.
    pub(crate) fn set_origin(window: &Window, x: Option<f32>, y: Option<f32>) {
        if !valid_origin(x, y) {
            return;
        }
        let Some(w) = ns_window(window) else { return };
        crate::rt::outside_app(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let screens = NSScreen::screens(mtm);
            let Some(primary) = screens.firstObject() else {
                return;
            };
            let height = primary.frame().size.height;
            if !height.is_finite() {
                return;
            }
            let f = w.frame();
            let now = crate::window::screen::top_left_of_appkit_rect(
                f.origin.x,
                f.origin.y,
                f.size.height,
                height,
            );
            let (x, y) =
                crate::window::screen::moved_to(x, y, (f32::from(now.x), f32::from(now.y)));
            w.setFrameTopLeftPoint(NSPoint::new(x.into(), height - f64::from(y)));
        });
    }

    /// Where the coordinates of `window`'s bounds start, in screen
    /// coordinates: GPUI measures a window from the top left corner of
    /// the screen it is on.
    pub(crate) fn bounds_origin(window: &Window) -> gpui::Point<gpui::Pixels> {
        let origin = || {
            let screen = ns_window(window)?.screen()?;
            let primary = NSScreen::screens(MainThreadMarker::new()?).firstObject()?;
            let f = screen.frame();
            Some(crate::window::screen::top_left_of_appkit_rect(
                f.origin.x,
                f.origin.y,
                f.size.height,
                primary.frame().size.height,
            ))
        };
        origin().unwrap_or_default()
    }

    pub(crate) fn request_attention(window: &Window, critical: bool) {
        if !critical {
            window.request_attention();
            return;
        }
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm)
                .requestUserAttention(NSRequestUserAttentionType::CriticalRequest);
        }
    }

    /// Makes `window` a child of `parent` (it moves with it and stays above
    /// it), or of no window.
    pub(crate) fn set_parent(
        window: &Window,
        parent: Option<&Window>,
        _modal: bool,
        _kind: WindowKind,
    ) {
        let Some(child) = ns_window(window) else {
            return;
        };
        if let Some(old) = child.parentWindow() {
            old.removeChildWindow(&child);
        }
        if let Some(parent) = parent.and_then(ns_window) {
            // SAFETY: both windows are alive; AppKit keeps the relation
            // until one closes or it is removed above.
            unsafe { parent.addChildWindow_ordered(&child, NSWindowOrderingMode::Above) };
        }
    }

    /// A modal window blocks its parent's input: nsh holds it back itself
    /// (`crate::window::blocked`).
    pub(crate) fn enable(_window: &Window, _enabled: bool) {}
}

#[cfg(windows)]
mod win {
    use nsh_core::desktop::WindowLevel;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::DwmSetWindowAttribute,
        UI::{Input::KeyboardAndMouse::EnableWindow, WindowsAndMessaging::*},
    };

    use super::*;

    /// `DWMWA_USE_IMMERSIVE_DARK_MODE`.
    const DARK_MODE: u32 = 20;

    fn hwnd(window: &Window) -> Option<HWND> {
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return None;
        };
        Some(handle.hwnd.get() as HWND)
    }

    fn set_style(hwnd: HWND, index: i32, bits: u32, on: bool) {
        // SAFETY: plain calls on a live window of this thread.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, index) as u32;
            let next = if on { style | bits } else { style & !bits };
            if next != style {
                SetWindowLongPtrW(hwnd, index, next as isize);
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        }
    }

    pub(crate) fn apply(window: &Window, a: &WindowAttributes) {
        let Some(hwnd) = hwnd(window) else { return };
        on(&a.level, |level| {
            let order = match level {
                WindowLevel::Floating | WindowLevel::AboveDock => HWND_TOPMOST,
                WindowLevel::DesktopIcon => HWND_BOTTOM,
                _ => HWND_NOTOPMOST,
            };
            // SAFETY: a plain call on a live window.
            unsafe {
                SetWindowPos(
                    hwnd,
                    order,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
            };
        });
        on(&a.taskbar, |t| {
            set_style(hwnd, GWL_EXSTYLE, WS_EX_TOOLWINDOW, !t);
            set_style(hwnd, GWL_EXSTYLE, WS_EX_APPWINDOW, t);
        });
        on(&a.focusable, |f| {
            set_style(hwnd, GWL_EXSTYLE, WS_EX_NOACTIVATE, !f)
        });
        on(&a.resizable, |r| {
            set_style(hwnd, GWL_STYLE, WS_THICKFRAME, r)
        });
        on(&a.minimizable, |m| {
            set_style(hwnd, GWL_STYLE, WS_MINIMIZEBOX, m)
        });
        on(&a.maximizable, |m| {
            set_style(hwnd, GWL_STYLE, WS_MAXIMIZEBOX, m)
        });
        on(&a.closable, |c| {
            // SAFETY: plain calls on a live window's system menu.
            unsafe {
                let menu = GetSystemMenu(hwnd, 0);
                if !menu.is_null() {
                    let state = if c { MF_ENABLED } else { MF_GRAYED };
                    EnableMenuItem(menu, SC_CLOSE, MF_BYCOMMAND | state);
                }
            }
        });
    }

    /// Its frame drawn dark or light (`None`: left as it is).
    pub(crate) fn set_scheme(window: &Window, dark: Option<bool>) {
        let Some(hwnd) = hwnd(window) else { return };
        let Some(dark) = dark else { return };
        let dark = i32::from(dark);
        // SAFETY: a plain call with a local value of the size given.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DARK_MODE,
                (&dark as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            )
        };
    }

    /// GPUI keeps the title bar it opened the window with.
    pub(crate) fn set_title_bar(_window: &mut Window, _style: TitleBarStyle, _frameless: bool) {}

    pub(crate) fn set_click_through(window: &Window, through: bool) {
        let Some(hwnd) = hwnd(window) else { return };
        set_style(
            hwnd,
            GWL_EXSTYLE,
            WS_EX_TRANSPARENT | WS_EX_LAYERED,
            through,
        );
        if through {
            // SAFETY: a plain call on a live layered window: fully opaque.
            unsafe { SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) };
        }
    }

    /// Windows does not fit a window to its screen as it shows it: one
    /// that keeps its size needs nothing.
    pub(crate) fn show(window: &Window, activate: bool, _keep: bool) {
        if let Some(hwnd) = hwnd(window) {
            // SAFETY: a plain call on a live window.
            unsafe { ShowWindow(hwnd, if activate { SW_SHOW } else { SW_SHOWNOACTIVATE }) };
        }
    }

    /// [`show`] leaves nothing to a later turn.
    pub(crate) fn removing(_window: &Window) {}

    /// GPUI's displays, the primary one first.
    pub(crate) fn displays(cx: &gpui::App) -> Vec<(gpui::DisplayId, gpui::Bounds<gpui::Pixels>)> {
        super::super::gpui_displays(cx)
    }

    /// No display reports a cutout here.
    pub(crate) fn cutouts(
        _id: gpui::DisplayId,
        _bounds: nsh_core::Bounds<nsh_core::Points>,
    ) -> Vec<nsh_core::Bounds<nsh_core::Points>> {
        Vec::new()
    }

    /// Windows has no app activation: a background app's windows show
    /// without activating ([`show`]) and nothing brings them to the
    /// foreground.
    pub(crate) fn run_in_background() {}

    pub(crate) fn hide(window: &Window) {
        if let Some(hwnd) = hwnd(window) {
            // SAFETY: a plain call on a live window.
            unsafe { ShowWindow(hwnd, SW_HIDE) };
        }
    }

    pub(crate) fn restore(window: &Window) {
        if let Some(hwnd) = hwnd(window) {
            // SAFETY: plain calls on a live window.
            unsafe {
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                }
            }
        }
    }

    pub(crate) fn minimized(window: &Window) -> bool {
        // SAFETY: a plain query on a live window.
        hwnd(window).is_some_and(|hwnd| unsafe { IsIconic(hwnd) } != 0)
    }

    /// Not hidden: on screen, or minimized.
    pub(crate) fn visible(window: &Window) -> bool {
        // SAFETY: a plain query on a live window.
        hwnd(window).is_none_or(|hwnd| unsafe { IsWindowVisible(hwnd) } != 0)
    }

    /// Moves the window's top left corner to `(x, y)` (points, screen
    /// coordinates; one left out stays), once the GPUI update this runs in
    /// ends: Windows tells GPUI of the move as it moves the window, which
    /// GPUI cannot take during one. The coordinate left out is the
    /// window's when the move runs, after the moves asked before it.
    pub(crate) fn set_origin(window: &Window, x: Option<f32>, y: Option<f32>) {
        if !valid_origin(x, y) {
            return;
        }
        let Some(hwnd) = hwnd(window) else { return };
        let scale = window.scale_factor();
        let physical = |v: f32| (v * scale).round() as i32;
        let (x, y) = (x.map(physical), y.map(physical));
        crate::rt::outside_app(move || {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            // SAFETY: `rect` is a valid out pointer; a window closed since
            // fails the call.
            if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
                return;
            }
            let (x, y) = crate::window::screen::moved_to(x, y, (rect.left, rect.top));
            // SAFETY: a plain call; a window closed since fails it.
            unsafe {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    x,
                    y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                )
            };
        });
    }

    /// Where the coordinates of `window`'s bounds start: GPUI's are screen
    /// coordinates here.
    pub(crate) fn bounds_origin(_window: &Window) -> gpui::Point<gpui::Pixels> {
        gpui::Point::default()
    }

    pub(crate) fn request_attention(window: &Window, critical: bool) {
        let Some(hwnd) = hwnd(window) else { return };
        let info = FLASHWINFO {
            cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
            hwnd,
            dwFlags: if critical {
                FLASHW_ALL | FLASHW_TIMERNOFG
            } else {
                FLASHW_TRAY
            },
            uCount: if critical { 0 } else { 3 },
            dwTimeout: 0,
        };
        // SAFETY: a plain call with a local, filled struct.
        unsafe { FlashWindowEx(&info) };
    }

    /// Makes `window` owned by `parent` (it stays above it and minimizes
    /// with it), or by no window.
    pub(crate) fn set_parent(
        window: &Window,
        parent: Option<&Window>,
        _modal: bool,
        _kind: WindowKind,
    ) {
        let Some(child) = hwnd(window) else { return };
        let owner = parent.and_then(hwnd).unwrap_or(std::ptr::null_mut());
        // SAFETY: a plain call on a live window; the owner outlives it or
        // is cleared before it closes.
        unsafe { SetWindowLongPtrW(child, GWLP_HWNDPARENT, owner as isize) };
    }

    /// Enables or disables the window's input (its modal child shows).
    pub(crate) fn enable(window: &Window, enabled: bool) {
        if let Some(hwnd) = hwnd(window) {
            // SAFETY: a plain call on a live window.
            unsafe { EnableWindow(hwnd, i32::from(enabled)) };
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    /// X11 and Wayland leave levels, workspaces, shadows and the rest to
    /// the window manager.
    pub(crate) fn apply(_window: &Window, _a: &WindowAttributes) {}

    /// The window manager draws the frame.
    pub(crate) fn set_scheme(_window: &Window, _dark: Option<bool>) {}

    /// Client-side decorations for a hidden title bar or no frame.
    pub(crate) fn set_title_bar(window: &mut Window, style: TitleBarStyle, frameless: bool) {
        window.request_decorations(if frameless || style == TitleBarStyle::Hidden {
            gpui::WindowDecorations::Client
        } else {
            gpui::WindowDecorations::Server
        });
    }

    /// The input region does it ([`Window::set_input_region`]).
    pub(crate) fn set_click_through(_window: &Window, _through: bool) {}

    /// GPUI shows its windows as they open.
    pub(crate) fn show(_window: &Window, _activate: bool, _keep: bool) {}

    /// [`show`] leaves nothing to a later turn.
    pub(crate) fn removing(_window: &Window) {}

    /// GPUI's displays, the primary one first.
    pub(crate) fn displays(cx: &gpui::App) -> Vec<(gpui::DisplayId, gpui::Bounds<gpui::Pixels>)> {
        super::super::gpui_displays(cx)
    }

    /// No display reports a cutout here.
    pub(crate) fn cutouts(
        _id: gpui::DisplayId,
        _bounds: nsh_core::Bounds<nsh_core::Points>,
    ) -> Vec<nsh_core::Bounds<nsh_core::Points>> {
        Vec::new()
    }

    /// Nothing to set: a background app's windows open without the focus
    /// and are never activated.
    pub(crate) fn run_in_background() {}

    /// GPUI cannot hide a window: it minimizes.
    pub(crate) fn hide(window: &Window) {
        window.minimize_window();
    }

    pub(crate) fn restore(window: &Window) {
        window.activate_window();
    }

    pub(crate) fn minimized(_window: &Window) -> bool {
        false
    }

    /// GPUI shows its windows as they open, and minimizes them for `hide`.
    pub(crate) fn visible(_window: &Window) -> bool {
        true
    }

    /// The window manager places windows.
    pub(crate) fn set_origin(_window: &Window, _x: Option<f32>, _y: Option<f32>) {}

    /// Where the coordinates of `window`'s bounds start: GPUI's are screen
    /// coordinates here.
    pub(crate) fn bounds_origin(_window: &Window) -> gpui::Point<gpui::Pixels> {
        gpui::Point::default()
    }

    pub(crate) fn request_attention(window: &Window, _critical: bool) {
        window.request_attention();
    }

    pub(crate) fn set_parent(
        _window: &Window,
        _parent: Option<&Window>,
        _modal: bool,
        _kind: WindowKind,
    ) {
    }

    pub(crate) fn enable(_window: &Window, _enabled: bool) {}
}
