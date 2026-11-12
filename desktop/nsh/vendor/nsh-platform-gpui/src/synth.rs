//! Input as a user's hands give it, made in process (GPUI's main thread):
//! pointers through the handlers real input goes through
//! ([`crate::input`]), keys and text ([`crate::text_input`]), and pictures
//! of the window. The agent of `nsh test --target gpui` acts with them
//! ([`crate::agent`]).

use std::{cell::Cell, rc::Rc, time::Duration};

use gpui::{AnyWindowHandle, App, AppContext as _, AsyncApp, Window};

use crate::{
    input::{KeyEvent, Modifiers},
    surface::Surface,
};

/// Runs `f` in window `window` (the main one or one of the app's own) on
/// the main thread, then redraws what changed. `None` when it is gone.
fn in_window<R>(
    window: AnyWindowHandle,
    cx: &mut AsyncApp,
    f: impl FnOnce(&mut Window, &mut App) -> R,
) -> Option<R> {
    cx.update_window(window, |_, window, cx| {
        let r = f(window, cx);
        crate::rt::flush(cx);
        r
    })
    .ok()
}

pub(crate) async fn sleep(cx: &mut AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(ms))
        .await;
}

/// Waits until the window drew a frame with everything changed so far
/// (false when the window closed). A window that draws no frames (hidden,
/// minimized) is given up on after a second.
pub(crate) async fn drawn(window: AnyWindowHandle, cx: &mut AsyncApp) -> bool {
    // Next-frame callbacks run before their frame is drawn: the second
    // one runs once the frame the first one asked for is drawn.
    let done = Rc::new(Cell::new(false));
    let flag = done.clone();
    let Some(()) = in_window(window, cx, move |window, _| {
        window.refresh();
        window.on_next_frame(move |window, _| {
            window.on_next_frame(move |_, _| flag.set(true));
        });
    }) else {
        return false;
    };
    let start = std::time::Instant::now();
    while !done.get() {
        if start.elapsed() > Duration::from_secs(1) {
            log::warn!("test: the window draws no frames");
            break;
        }
        sleep(cx, 4).await;
    }
    true
}

/// Presses and releases key `vk` in the surface's input root, as GPUI's
/// key events reach it; true when the press was taken.
pub(crate) fn press(surface: &Rc<Surface>, vk: u16, modifiers: Modifiers) -> bool {
    let mut taken = false;
    for down in [true, false] {
        let handled = crate::input::key(
            surface,
            KeyEvent {
                vk,
                down,
                repeat: false,
                modifiers,
            },
        );
        if down {
            taken = handled;
        }
        // Unhandled printable keys type their character, as GPUI's input
        // handler would get it.
        if down && !handled && !modifiers.ctrl && !modifiers.alt && !modifiers.meta {
            let ch = match vk {
                0x20 => Some(' '),
                // The US layout's character, Shift's for `shift+8` (`*`).
                _ => match nsh_core::keymap::Key::from_virtual_key(vk) {
                    Some(nsh_core::keymap::Key::Char(c)) if modifiers.shift => {
                        Some(nsh_core::keymap::shifted(c))
                    }
                    Some(nsh_core::keymap::Key::Char(c)) => Some(c),
                    _ => None,
                },
            };
            if let Some(ch) = ch {
                crate::text_input::char_input(surface, &ch.to_string());
            }
        }
    }
    taken
}

/// Draws what changed in window `window` (the main one or one of the
/// app's own) and takes its content, in device pixels, with its size in
/// points. `None` when the window closed.
pub(crate) async fn frame(
    window: AnyWindowHandle,
    cx: &mut AsyncApp,
) -> Option<anyhow::Result<(::image::RgbaImage, gpui::Size<gpui::Pixels>)>> {
    #[cfg(target_os = "linux")]
    {
        let watch = match in_window(window, cx, |window, _| x11::Watch::new(window))? {
            Ok(watch) => watch,
            Err(err) => return Some(Err(err)),
        };
        if !drawn(window, cx).await {
            return None;
        }
        watch.presented(cx).await;
        let frame = watch.capture();
        in_window(window, cx, |window, _| Ok((frame?, window.viewport_size())))
    }
    #[cfg(not(target_os = "linux"))]
    {
        if !drawn(window, cx).await {
            return None;
        }
        in_window(window, cx, |window, _| {
            Ok((capture(window)?, window.viewport_size()))
        })
    }
}

/// The window's last frame, in device pixels.
#[cfg(all(feature = "shot", any(target_os = "macos", windows)))]
pub(crate) fn capture(window: &mut Window) -> anyhow::Result<::image::RgbaImage> {
    window.render_to_image()
}

/// The window's last frame, in device pixels.
#[cfg(all(not(feature = "shot"), any(target_os = "macos", windows)))]
pub(crate) fn capture(_window: &mut Window) -> anyhow::Result<::image::RgbaImage> {
    anyhow::bail!("shots need nsh-platform-gpui's feature `shot`")
}

/// Shots on Linux: a redirected pixmap, independent of window stacking.
#[cfg(target_os = "linux")]
pub(crate) mod x11 {
    use std::time::{Duration, Instant};

    use anyhow::{Context, bail};
    use gpui::{AsyncApp, Window};
    use x11rb::{
        connection::{Connection, RequestConnection},
        protocol::{
            Event,
            composite::{ConnectionExt as _, Redirect},
            present::{self, ConnectionExt as _},
            xproto::{ConnectionExt as _, ImageFormat, ImageOrder},
        },
        rust_connection::RustConnection,
    };

    /// A window being shot, through a connection of our own.
    pub(super) struct Watch {
        conn: RustConnection,
        window: u32,
        /// GPUI's frames reach the X server through DRI3 buffers and the
        /// Present extension, which shows them on the window's vertical
        /// blanks (otherwise they are copied in when presented).
        present: bool,
    }

    /// The vertical blanks to wait for after the frame: a frame waits for
    /// the ones queued before it (`desired_maximum_frame_latency` 2).
    const BLANKS: u64 = 3;

    impl Watch {
        /// A connection to `window`'s X server.
        pub(super) fn new(window: &Window) -> anyhow::Result<Watch> {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            let id = match HasWindowHandle::window_handle(window)?.as_raw() {
                RawWindowHandle::Xlib(h) => h.window as u32,
                RawWindowHandle::Xcb(h) => h.window.get(),
                _ => bail!("shots need X11 (run with `WAYLAND_DISPLAY=`)"),
            };
            Self::connect(id)
        }

        fn connect(id: u32) -> anyhow::Result<Watch> {
            let (conn, _) = x11rb::connect(None).context("cannot connect to the X server")?;
            // Automatic redirection keeps normal presentation, but retains all
            // of our pixels even where another window covers us. GetImage on
            // the window itself has undefined pixels in those regions.
            conn.composite_query_version(0, 2)?
                .reply()
                .context("shots need X Composite 0.2 (use Xvfb or Xwayland -shm)")?;
            conn.composite_redirect_window(id, Redirect::AUTOMATIC)?
                .check()
                .context("cannot redirect the window for a screenshot")?;
            let has = |name| {
                conn.extension_information(name)
                    .is_ok_and(|info| info.is_some())
            };
            let present = has(x11rb::protocol::dri3::X11_EXTENSION_NAME)
                && has(present::X11_EXTENSION_NAME)
                && conn
                    .present_query_version(1, 2)
                    .ok()
                    .and_then(|c| c.reply().ok())
                    .is_some()
                && conn
                    .present_select_input(
                        conn.generate_id()?,
                        id,
                        present::EventMask::COMPLETE_NOTIFY,
                    )
                    .ok()
                    .and_then(|c| c.check().ok())
                    .is_some();
            Ok(Watch {
                conn,
                window: id,
                present,
            })
        }

        /// Waits for the X server to show the frame GPUI drew last: for the
        /// window's vertical blanks to pass the ones that frame waits for.
        /// They come once a second for a hidden Xwayland (its compositor
        /// sends it no frame callbacks), which makes every shot take
        /// seconds; Xwayland started with `-shm` copies frames in at once.
        pub(super) async fn presented(&self, cx: &mut AsyncApp) {
            if !self.present {
                return;
            }
            let start = Instant::now();
            let Some(now) = self.msc(0, 1, cx).await else {
                return;
            };
            if self.msc(now + BLANKS, 2, cx).await.is_none() {
                return;
            }
            if start.elapsed() > Duration::from_secs(1) {
                log::warn!(
                    "test: the X server shows frames slowly (a hidden Xwayland? start it with -shm)"
                );
            }
        }

        /// Waits for the window's vertical blank `target` (0: the next
        /// event tells the current one) and returns its number; `None` on
        /// errors or after 5 s.
        async fn msc(&self, target: u64, serial: u32, cx: &mut AsyncApp) -> Option<u64> {
            self.conn
                .present_notify_msc(self.window, serial, target, 0, 0)
                .ok()?;
            self.conn.flush().ok()?;
            let start = Instant::now();
            loop {
                while let Some(event) = self.conn.poll_for_event().ok()? {
                    if let Event::PresentCompleteNotify(e) = event
                        && e.window == self.window
                        && e.kind == present::CompleteKind::NOTIFY_MSC
                        && e.serial == serial
                    {
                        return Some(e.msc);
                    }
                }
                if start.elapsed() > Duration::from_secs(5) {
                    log::warn!("test: the X server reports no vertical blanks");
                    return None;
                }
                super::sleep(cx, 2).await;
            }
        }

        /// The window's pixels.
        pub(super) fn capture(&self) -> anyhow::Result<::image::RgbaImage> {
            let conn = &self.conn;
            let geometry = conn.get_geometry(self.window)?.reply()?;
            let attributes = conn.get_window_attributes(self.window)?.reply()?;
            let (w, h) = (geometry.width, geometry.height);
            // Name after drawing: a resize replaces the redirected backing
            // pixmap. The connection owns the name and releases it on drop,
            // along with our automatic redirection, including on errors.
            let pixmap = conn.generate_id()?;
            conn.composite_name_window_pixmap(self.window, pixmap)?
                .check()?;
            let reply = conn
                .get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, w, h, !0)?
                .reply()?;
            let setup = conn.setup();
            let bpp = setup
                .pixmap_formats
                .iter()
                .find(|f| f.depth == reply.depth)
                .map_or(0, |f| f.bits_per_pixel);
            let visual = setup
                .roots
                .iter()
                .flat_map(|s| &s.allowed_depths)
                .flat_map(|d| &d.visuals)
                .find(|v| v.visual_id == attributes.visual)
                .context("the window's visual is unknown")?;
            if bpp != 32 {
                bail!("{bpp} bits per pixel are not supported");
            }
            Ok(to_rgba(
                &reply.data,
                w as u32,
                h as u32,
                [visual.red_mask, visual.green_mask, visual.blue_mask],
                setup.image_byte_order == ImageOrder::MSB_FIRST,
            ))
        }
    }

    /// 32-bit Z pixmap pixels (rows of `width`, which need no padding at
    /// 32 bits) with `masks` (red, green, blue) as opaque RGBA.
    pub(super) fn to_rgba(
        data: &[u8],
        width: u32,
        height: u32,
        masks: [u32; 3],
        msb_first: bool,
    ) -> ::image::RgbaImage {
        let channel = |px: u32, mask: u32| -> u8 {
            if mask == 0 {
                return 0;
            }
            let shift = mask.trailing_zeros();
            let (v, max) = ((px & mask) >> shift, mask >> shift);
            (v as u64 * 255 / max as u64) as u8
        };
        let mut out = ::image::RgbaImage::new(width, height);
        for (px, rgba) in data.as_chunks::<4>().0.iter().zip(out.pixels_mut()) {
            let px = if msb_first {
                u32::from_be_bytes(*px)
            } else {
                u32::from_le_bytes(*px)
            };
            rgba.0 = [
                channel(px, masks[0]),
                channel(px, masks[1]),
                channel(px, masks[2]),
                255,
            ];
        }
        out
    }
    #[cfg(test)]
    mod tests {
        use x11rb::protocol::xproto::{
            ChangeGCAux, ConfigureWindowAux, CreateGCAux, CreateWindowAux, Rectangle, WindowClass,
        };

        use super::*;

        /// Run on a bare Xvfb so GetImage of a covered window cannot rely
        /// on a desktop compositor retaining the obscured pixels for us.
        #[test]
        #[ignore = "needs an X11 display with Composite (xvfb-run -a)"]
        fn screenshot_keeps_obscured_pixels_and_follows_resize() -> anyhow::Result<()> {
            let (conn, screen) = x11rb::connect(None)?;
            let root = &conn.setup().roots[screen];
            let create = |color| -> anyhow::Result<u32> {
                let id = conn.generate_id()?;
                conn.create_window(
                    root.root_depth,
                    id,
                    root.root,
                    0,
                    0,
                    48,
                    32,
                    0,
                    WindowClass::INPUT_OUTPUT,
                    root.root_visual,
                    &CreateWindowAux::new()
                        .background_pixel(color)
                        .override_redirect(1),
                )?
                .check()?;
                conn.map_window(id)?.check()?;
                Ok(id)
            };
            let window = create(0)?;
            let watch = Watch::connect(window)?;
            let gc = conn.generate_id()?;
            conn.create_gc(gc, window, &CreateGCAux::new().foreground(0xff0000))?
                .check()?;
            let paint = || -> anyhow::Result<()> {
                conn.poly_fill_rectangle(
                    window,
                    gc,
                    &[Rectangle {
                        x: 0,
                        y: 0,
                        width: 48,
                        height: 32,
                    }],
                )?
                .check()?;
                Ok(())
            };
            paint()?;
            let before = watch.capture()?;
            assert_eq!(before.dimensions(), (48, 32));
            assert!(before.pixels().all(|p| p.0 == [255, 0, 0, 255]));
            let cover = create(0x0000ff)?;
            // The root really shows the blue cover, not our red window.
            let root_pixels = conn
                .get_image(ImageFormat::Z_PIXMAP, root.root, 0, 0, 48, 32, !0)?
                .reply()?;
            let cover_pixels = conn
                .get_image(ImageFormat::Z_PIXMAP, cover, 0, 0, 48, 32, !0)?
                .reply()?;
            assert_eq!(root_pixels.data, cover_pixels.data);
            assert_eq!(watch.capture()?, before);
            // Production starts its screenshot connection while the window
            // may already be covered. Redraw into a newly redirected pixmap.
            drop(watch);
            let watch = Watch::connect(window)?;
            paint()?;
            assert_eq!(watch.capture()?, before);
            conn.configure_window(window, &ConfigureWindowAux::new().width(24).height(16))?
                .check()?;
            conn.change_gc(gc, &ChangeGCAux::new().foreground(0x00ff00))?
                .check()?;
            paint()?;
            let resized = watch.capture()?;
            assert_eq!(resized.dimensions(), (24, 16));
            assert!(resized.pixels().all(|p| p.0 == [0, 255, 0, 255]));
            Ok(())
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn x_pixels_become_rgba() {
        // BGRX, least significant byte first: red, then green.
        let data = [0, 0, 255, 0, 0, 128, 0, 0];
        let masks = [0xff0000, 0xff00, 0xff];
        let image = x11::to_rgba(&data, 2, 1, masks, false);
        assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(image.get_pixel(1, 0).0, [0, 128, 0, 255]);
        let image = x11::to_rgba(&[0, 255, 0, 0], 1, 1, masks, true);
        assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }
}
