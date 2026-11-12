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

#[cfg(target_os = "macos")]
mod mac {
    use nsh_core::desktop::{WindowLevel, Workspaces};
    use objc2::{MainThreadMarker, rc::Retained};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        NSApplication, NSRequestUserAttentionType, NSScreen, NSView, NSWindow, NSWindowButton,
        NSWindowCollectionBehavior, NSWindowLevel, NSWindowOrderingMode, NSWindowStyleMask,
        NSWindowTitleVisibility,
    };
    use objc2_foundation::{NSPoint, NSSize};
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

    pub(crate) fn show(window: &Window, activate: bool) {
        if let Some(w) = ns_window(window)
            && !activate
        {
            w.orderFront(None);
        }
    }

    pub(crate) fn hide(window: &Window) {
        if let Some(w) = ns_window(window) {
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
    /// primary display's top left corner, `y` down).
    pub(crate) fn set_origin(window: &Window, x: f32, y: f32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let Some(w) = ns_window(window) else { return };
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
        w.setFrameTopLeftPoint(NSPoint::new(x.into(), height - f64::from(y)));
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
        Foundation::HWND,
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

    pub(crate) fn show(window: &Window, activate: bool) {
        if let Some(hwnd) = hwnd(window) {
            // SAFETY: a plain call on a live window.
            unsafe { ShowWindow(hwnd, if activate { SW_SHOW } else { SW_SHOWNOACTIVATE }) };
        }
    }

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
    /// coordinates).
    pub(crate) fn set_origin(window: &Window, x: f32, y: f32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let Some(hwnd) = hwnd(window) else { return };
        let scale = window.scale_factor();
        // SAFETY: a plain call on a live window.
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                (x * scale).round() as i32,
                (y * scale).round() as i32,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
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
    pub(crate) fn show(_window: &Window, _activate: bool) {}

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
    pub(crate) fn set_origin(_window: &Window, _x: f32, _y: f32) {}

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
