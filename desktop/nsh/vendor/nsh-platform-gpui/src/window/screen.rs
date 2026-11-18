//! Screen coordinates: the app's window and display rectangles (states,
//! placements, `displays()`, `defaultPosition`, `setBounds`) are points
//! from the primary display's top left corner, `y` down, on every backend.
//! GPUI's are those on Windows and Linux. On macOS GPUI measures a window
//! and a display from that display's own top left corner, and opens a
//! window at a point of the display it is given: [`global`] and [`place`]
//! convert, with each display's [`origin`].

use gpui::{App, Bounds, Pixels, PlatformDisplay, Point, point, px};

/// A display as windows are placed on it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Screen {
    /// GPUI's id of the display.
    pub(crate) id: gpui::DisplayId,
    /// Its bounds, in screen coordinates.
    pub(crate) bounds: Bounds<Pixels>,
    /// Where GPUI's coordinates on it start, in screen coordinates.
    pub(crate) origin: Point<Pixels>,
}

/// Where GPUI's coordinates on display `d` start, in screen coordinates:
/// its top left corner on macOS (its global display bounds' origin).
#[cfg(target_os = "macos")]
pub(crate) fn origin(d: &dyn PlatformDisplay) -> Point<Pixels> {
    // GPUI's id of a macOS display is its `CGDirectDisplayID`.
    mac::display_origin(u64::from(d.id()) as u32)
}

/// Where GPUI's coordinates on display `d` start, in screen coordinates:
/// GPUI's are screen coordinates here.
#[cfg(not(target_os = "macos"))]
pub(crate) fn origin(_d: &dyn PlatformDisplay) -> Point<Pixels> {
    Point::default()
}

/// Display `d` as windows are placed on it.
pub(crate) fn screen(d: &dyn PlatformDisplay) -> Screen {
    let origin = origin(d);
    Screen {
        id: d.id(),
        bounds: global(d.bounds(), origin),
        origin,
    }
}

/// Every display as windows are placed on it.
pub(crate) fn screens(cx: &App) -> Vec<Screen> {
    cx.displays().iter().map(|d| screen(&**d)).collect()
}

/// `local`, in coordinates that start at `origin`, in screen coordinates.
pub(crate) fn global(local: Bounds<Pixels>, origin: Point<Pixels>) -> Bounds<Pixels> {
    local + origin
}

/// Where GPUI opens a window at `bounds` (screen coordinates): on the
/// display holding their center (else the nearest one), at these bounds in
/// its coordinates. Without displays, GPUI's own choice at `bounds`.
pub(crate) fn place(
    screens: &[Screen],
    bounds: Bounds<Pixels>,
) -> (Option<gpui::DisplayId>, Bounds<Pixels>) {
    match screen_at(screens, bounds.center()) {
        Some(s) => (Some(s.id), bounds - s.origin),
        None => (None, bounds),
    }
}

/// The display at `p` (screen coordinates): the one holding it, else the
/// nearest one.
pub(crate) fn screen_at(screens: &[Screen], p: Point<Pixels>) -> Option<&Screen> {
    screens.iter().find(|s| s.bounds.contains(&p)).or_else(|| {
        screens
            .iter()
            .min_by(|a, b| distance(a.bounds, p).total_cmp(&distance(b.bounds, p)))
    })
}

/// The squared distance from `p` to the nearest point of `b`.
fn distance(b: Bounds<Pixels>, p: Point<Pixels>) -> f32 {
    let (x, y) = (f32::from(p.x), f32::from(p.y));
    let (left, top) = (f32::from(b.origin.x), f32::from(b.origin.y));
    let (right, bottom) = (
        left + f32::from(b.size.width),
        top + f32::from(b.size.height),
    );
    let dx = (left - x).max(x - right).max(0.0);
    let dy = (top - y).max(y - bottom).max(0.0);
    dx * dx + dy * dy
}

/// The top left corner of an AppKit rectangle (`x`, `y` its bottom left
/// corner, `y` up from the primary screen's bottom) of `height`, in screen
/// coordinates, the primary screen `primary_height` high.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn top_left_of_appkit_rect(
    x: f64,
    y: f64,
    height: f64,
    primary_height: f64,
) -> Point<Pixels> {
    point(px(x as f32), px((primary_height - y - height) as f32))
}

/// Where a window whose top left corner is at `now` goes for a move to
/// `x` / `y`: a coordinate left out stays. `now` is read as the move runs,
/// so moves asked in a row each start where the one before ended.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) fn moved_to<T>(x: Option<T>, y: Option<T>, now: (T, T)) -> (T, T) {
    (x.unwrap_or(now.0), y.unwrap_or(now.1))
}

#[cfg(target_os = "macos")]
mod mac {
    use gpui::{Pixels, Point, point, px};
    use objc2_foundation::NSRect;

    // `CGRect` is `NSRect` on 64-bit macOS; GPUI links CoreGraphics.
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGDisplayBounds(display: u32) -> NSRect;
    }

    /// The top left corner of display `id` in screen coordinates
    /// (CoreGraphics' global display coordinates are those).
    pub(super) fn display_origin(id: u32) -> Point<Pixels> {
        // SAFETY: a query by value; a display that is gone gives an empty
        // rectangle.
        let r = unsafe { CGDisplayBounds(id) };
        if !r.origin.x.is_finite() || !r.origin.y.is_finite() {
            return Point::default();
        }
        point(px(r.origin.x as f32), px(r.origin.y as f32))
    }
}

#[cfg(test)]
mod tests {
    use gpui::{bounds, size};

    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        bounds(point(px(x), px(y)), size(px(w), px(h)))
    }

    /// The primary display at the origin, a second one to its right whose
    /// top is 200 points higher, as GPUI on macOS sees them (each from its
    /// own top left corner).
    fn screens() -> Vec<Screen> {
        vec![
            Screen {
                id: gpui::DisplayId::new(1),
                bounds: rect(0.0, 0.0, 1512.0, 982.0),
                origin: point(px(0.0), px(0.0)),
            },
            Screen {
                id: gpui::DisplayId::new(2),
                bounds: rect(1512.0, -200.0, 2560.0, 1440.0),
                origin: point(px(1512.0), px(-200.0)),
            },
        ]
    }

    #[test]
    fn local_bounds_become_screen_bounds() {
        let s = screens();
        assert_eq!(
            global(rect(100.0, 50.0, 480.0, 360.0), s[1].origin),
            rect(1612.0, -150.0, 480.0, 360.0)
        );
        assert_eq!(
            global(rect(100.0, 50.0, 480.0, 360.0), s[0].origin),
            rect(100.0, 50.0, 480.0, 360.0)
        );
    }

    #[test]
    fn bounds_open_on_the_display_holding_their_center() {
        let s = screens();
        // On the second display: its id, in its own coordinates.
        let (id, local) = place(&s, rect(1700.0, 300.0, 480.0, 360.0));
        assert_eq!(id, Some(gpui::DisplayId::new(2)));
        assert_eq!(local, rect(188.0, 500.0, 480.0, 360.0));
        // Placing and back again gives the screen bounds.
        assert_eq!(
            global(local, s[1].origin),
            rect(1700.0, 300.0, 480.0, 360.0)
        );
        // Mostly on the primary display: the primary display.
        let (id, local) = place(&s, rect(1300.0, 100.0, 400.0, 300.0));
        assert_eq!(id, Some(gpui::DisplayId::new(1)));
        assert_eq!(local, rect(1300.0, 100.0, 400.0, 300.0));
    }

    #[test]
    fn bounds_off_every_display_open_on_the_nearest() {
        let s = screens();
        // Below the second display (it ends at 1240).
        let (id, local) = place(&s, rect(2000.0, 1400.0, 200.0, 100.0));
        assert_eq!(id, Some(gpui::DisplayId::new(2)));
        assert_eq!(local, rect(488.0, 1600.0, 200.0, 100.0));
        // Left of the primary display.
        let (id, _) = place(&s, rect(-900.0, 100.0, 200.0, 100.0));
        assert_eq!(id, Some(gpui::DisplayId::new(1)));
    }

    #[test]
    fn without_displays_bounds_stay() {
        let b = rect(10.0, 20.0, 30.0, 40.0);
        assert_eq!(place(&[], b), (None, b));
        assert_eq!(screen_at(&[], point(px(0.0), px(0.0))), None);
    }

    #[test]
    fn a_move_keeps_the_coordinate_left_out_from_where_the_window_is() {
        // Two moves asked in a row run in order, each from where the one
        // before left the window: centered (x 516), then to the top.
        let start = (100.0_f32, 300.0);
        let centered = moved_to(Some(516.0), Some(311.0), start);
        assert_eq!(moved_to(None, Some(0.0), centered), (516.0, 0.0));
        // Only `x`, from the window's `y`.
        assert_eq!(moved_to(Some(40), None, (10, 20)), (40, 20));
        // Nothing given: where it is.
        assert_eq!(moved_to(None, None, (10, 20)), (10, 20));
    }

    #[test]
    fn appkit_rects_flip_from_the_primary_screens_bottom() {
        // The primary screen, 982 high: its own frame starts at its top.
        assert_eq!(
            top_left_of_appkit_rect(0.0, 0.0, 982.0, 982.0),
            point(px(0.0), px(0.0))
        );
        // A screen right of it, 1440 high, whose top is 200 points higher:
        // its bottom is 258 below the primary screen's (982 + 200 - 1440).
        assert_eq!(
            top_left_of_appkit_rect(1512.0, -258.0, 1440.0, 982.0),
            point(px(1512.0), px(-200.0))
        );
    }
}
