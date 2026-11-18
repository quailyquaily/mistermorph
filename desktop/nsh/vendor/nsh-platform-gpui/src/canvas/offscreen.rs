//! `Command::RenderCanvas` (`OffscreenCanvas`'s `convertToBlob`): a drawing
//! replayed as a canvas view's is ([`record`]), into pixmaps of its own on
//! a thread of its own, and encoded as PNG. The images it names load
//! first, on the main thread, through the canvas' loader ([`load_image`]);
//! the image goes to the engine as one root [`EventKind::CanvasImage`],
//! from the main thread's queue ([`crate::rt::invoke`]).
//!
//! The replay is the on-screen one with the view's transform the scale
//! alone (y down, `scale` pixels per point, animated values at 0), into
//! one pixmap the size of the image: glyphs drawn as GPUI glyphs on screen
//! (those without an outline: emoji, fonts whose file is not found) are
//! not in the image, so the drawing never splits into layers. Only what
//! needs pixels of its own allocates more, sized to what it touches: a
//! shadow, a composite operation other than `source-over`, a gradient.
//! Text waits for the system's fonts to be found.

use std::{cell::RefCell, rc::Rc, sync::Arc};

use gpui::WindowTextSystem;
use nsh_core::{
    EventKind, EventPayload, ROOT_ID,
    canvas::{
        CanvasOp, Drawing,
        render::{ImageFormat, RenderFailure},
    },
};
use rustc_hash::FxHashMap;
use tiny_skia as sk;

use super::{IRect, Key, Replay, load_image, wait_for_fonts_here};
use crate::surface::Surface;

type Images = FxHashMap<Arc<str>, Option<super::CanvasBitmap>>;

/// The longest a render waits for the system's fonts.
const FONTS_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Renders `drawing` into a `width` × `height` pixel image at `scale`
/// pixels per point and answers request `id`.
pub(crate) fn render(
    surface: &Rc<Surface>,
    id: u32,
    drawing: Arc<Drawing>,
    (width, height): (u32, u32),
    scale: f32,
    format: ImageFormat,
) {
    let key = surface.key();
    // Without the app's (a surface not drawn yet), text draws no glyphs.
    let system =
        surface.text_system.borrow().clone().unwrap_or_else(|| {
            Arc::new(gpui::TextSystem::new(Arc::new(gpui::NoopTextSystem::new())))
        });
    let mut uris: Vec<Arc<str>> = drawing.images().map(|i| i.uri.clone()).collect();
    uris.sort_unstable();
    uris.dedup();
    let job = move |images: Images| {
        let job = Job {
            drawing,
            images,
            system,
            width,
            height,
            scale,
            format,
        };
        let answer = move |result: Result<Vec<u8>, RenderFailure>| {
            crate::rt::invoke(move || {
                if let Some(surface) = Surface::by_key(key) {
                    surface.event(
                        ROOT_ID,
                        EventKind::CanvasImage,
                        EventPayload::CanvasImage { id, result },
                    );
                }
            });
        };
        let spawned = std::thread::Builder::new()
            .name("nsh-canvas-offscreen".into())
            .spawn(move || answer(job.encode()));
        if let Err(e) = spawned {
            answer(Err(format!(
                "cannot start a thread to render the canvas: {e}"
            )
            .into()));
        }
    };
    if uris.is_empty() {
        job(Images::default());
        return;
    }
    let waiting = Rc::new(RefCell::new((uris.len(), Images::default(), Some(job))));
    for uri in uris {
        let waiting = waiting.clone();
        let key = uri.clone();
        load_image(surface, &uri, scale, move |result| {
            let mut w = waiting.borrow_mut();
            let image = result
                .inspect_err(|e| log::warn!("offscreen canvas: {e}"))
                .ok();
            w.1.insert(key, image);
            w.0 -= 1;
            if w.0 == 0
                && let Some(job) = w.2.take()
            {
                let images = std::mem::take(&mut w.1);
                drop(w);
                job(images);
            }
        });
    }
}

/// What a background thread paints and encodes.
struct Job {
    drawing: Arc<Drawing>,
    images: Images,
    /// The app's text system (fonts are resolved and text shaped in it).
    system: Arc<gpui::TextSystem>,
    width: u32,
    height: u32,
    scale: f32,
    format: ImageFormat,
}

impl Job {
    fn encode(self) -> Result<Vec<u8>, RenderFailure> {
        let format = self.format;
        let pixmap = self.paint()?;
        encode(pixmap, format)
    }

    /// The drawing replayed into a transparent pixmap, y down, `scale`
    /// pixels per point (premultiplied); [`RenderFailure::TooLarge`] when
    /// the memory for it, or for a layer of its size, could not be
    /// allocated.
    fn paint(self) -> Result<sk::Pixmap, RenderFailure> {
        let text =
            |op: &CanvasOp| matches!(op, CanvasOp::FillText { .. } | CanvasOp::StrokeText { .. });
        if self.drawing.ops.iter().any(text) {
            crate::text::init_thread();
            wait_for_fonts_here(FONTS_LIMIT);
        }
        let s = self.scale;
        let key = Key {
            linear: [s, 0.0, 0.0, s],
            scale: s,
            size: (self.width as f32 / s, self.height as f32 / s),
        };
        let (width, height) = (self.width, self.height);
        let too_large = || {
            RenderFailure::TooLarge(format!(
                "the system could not allocate a {width}×{height} bitmap"
            ))
        };
        let region = IRect {
            x0: 0,
            y0: 0,
            x1: i32::try_from(width).map_err(|_| too_large())?,
            y1: i32::try_from(height).map_err(|_| too_large())?,
        };
        let shaping = WindowTextSystem::new(self.system.clone());
        let text = (&shaping, &self.system);
        // Without GPUI's glyphs, everything paints into the one pixmap the
        // replay starts with: no layer of its own per run of glyphs.
        let mut replay = Replay::new(&[], &self.images, text, key, region, (0.0, 0.0), false);
        for op in &self.drawing.ops {
            replay.op(op);
        }
        if replay.out_of_memory {
            return Err(too_large());
        }
        replay
            .pixmap
            .take()
            .ok_or_else(|| "the canvas could not be drawn".into())
    }
}

/// `pixmap` (premultiplied) encoded as `format`, its pixels made straight
/// in place (no second copy of a large image).
fn encode(pixmap: sk::Pixmap, format: ImageFormat) -> Result<Vec<u8>, RenderFailure> {
    let format = match format {
        ImageFormat::Png => image::ImageFormat::Png,
        other => return Err(format!("unsupported image format {other:?}").into()),
    };
    let (width, height) = (pixmap.width(), pixmap.height());
    let mut rgba = pixmap.take();
    for p in rgba.as_chunks_mut::<4>().0 {
        let a = p[3];
        if a != 0 && a != 255 {
            let c =
                sk::PremultipliedColorU8::from_rgba(p[0], p[1], p[2], a).map(|c| c.demultiply());
            if let Some(c) = c {
                *p = [c.red(), c.green(), c.blue(), a];
            }
        }
    }
    let image =
        image::RgbaImage::from_raw(width, height, rgba).ok_or("the image could not be encoded")?;
    let mut out = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut out, format)
        .map_err(|e| RenderFailure::from(format!("the image could not be encoded: {e}")))?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Color,
        canvas::{CanvasGradient, FillRule, Num, Paint, PathOp},
        geometry::{Points, percentage, point},
    };

    use super::{
        super::{GlyphRun, Layer, MAX_AREA, shadow_limit, shadow_source},
        *,
    };

    fn job(ops: Vec<CanvasOp>, (width, height): (u32, u32), scale: f32) -> Job {
        Job {
            drawing: Arc::new(Drawing {
                ops,
                ..Drawing::default()
            }),
            images: Images::default(),
            system: Arc::new(gpui::TextSystem::new(Arc::new(gpui::NoopTextSystem::new()))),
            width,
            height,
            scale,
            format: ImageFormat::Png,
        }
    }

    /// The pixel at (x, y), y down, as premultiplied `[r, g, b, a]`.
    fn pixel(pixmap: &sk::Pixmap, x: u32, y: u32) -> [u8; 4] {
        let p = pixmap.pixel(x, y).unwrap();
        [p.red(), p.green(), p.blue(), p.alpha()]
    }

    fn red_rect() -> Vec<CanvasOp> {
        vec![
            CanvasOp::FillStyle(Paint::Color(Color(0xff00_00ff))),
            CanvasOp::FillRect([
                Num::Const(0.0),
                Num::Const(0.0),
                Num::Const(30.0),
                Num::Const(10.0),
            ]),
        ]
    }

    #[test]
    fn an_image_too_large_to_allocate_is_too_large() {
        let failure = job(red_rect(), (1 << 28, 1 << 30), 1.0)
            .paint()
            .unwrap_err();
        assert!(matches!(failure, RenderFailure::TooLarge(_)), "{failure:?}");
    }

    #[test]
    fn a_drawing_paints_y_down_at_its_scale() {
        let pixmap = job(red_rect(), (60, 40), 2.0).paint().unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (60, 40));
        assert_eq!(pixel(&pixmap, 5, 5), [255, 0, 0, 255]);
        assert_eq!(pixel(&pixmap, 59, 19), [255, 0, 0, 255]);
        assert_eq!(pixel(&pixmap, 5, 25)[3], 0);
    }

    #[test]
    fn animated_values_are_zero() {
        let ops = vec![
            CanvasOp::FillStyle(Paint::Color(Color(0x0000_ffff))),
            CanvasOp::FillRect([
                Num::Const(0.0),
                Num::Const(0.0),
                Num::Slot(0),
                Num::Const(10.0),
            ]),
        ];
        let pixmap = job(ops, (20, 20), 1.0).paint().unwrap();
        assert_eq!(pixel(&pixmap, 1, 1)[3], 0);
    }

    #[test]
    fn an_empty_drawing_is_transparent() {
        let pixmap = job(Vec::new(), (4, 3), 1.0).paint().unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (4, 3));
        assert!(pixmap.pixels().iter().all(|p| p.alpha() == 0));
    }

    #[test]
    fn an_image_is_encoded_as_png() {
        let png = job(Vec::new(), (3, 2), 1.0).encode().unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[16..24], &[0, 0, 0, 3, 0, 0, 0, 2]);
        // It decodes to the pixels drawn.
        let png = job(red_rect(), (60, 40), 2.0).encode().unwrap();
        let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .unwrap()
            .to_rgba8();
        assert_eq!(image.dimensions(), (60, 40));
        assert_eq!(image.get_pixel(5, 5).0, [255, 0, 0, 255]);
        assert_eq!(image.get_pixel(5, 25).0[3], 0);
    }

    fn c(v: f32) -> Num {
        Num::Const(v)
    }

    fn rect(x: f32, y: f32, w: f32, h: f32) -> [Num; 4] {
        [c(x), c(y), c(w), c(h)]
    }

    #[test]
    fn a_shape_outside_the_image_casts_its_shadow_in() {
        // Wholly left of the image, its shadow moved 30 points right.
        let ops = vec![
            CanvasOp::ShadowColor(Color(0x0000_ffff)),
            CanvasOp::ShadowOffset(point(Points(30.0), Points(0.0))),
            CanvasOp::FillStyle(Paint::Color(Color(0xff00_00ff))),
            CanvasOp::FillRect(rect(-40.0, 0.0, 30.0, 20.0)),
        ];
        let pixmap = job(ops, (40, 40), 1.0).paint().unwrap();
        assert_eq!(pixel(&pixmap, 5, 5), [0, 0, 255, 255]);
        assert_eq!(pixel(&pixmap, 25, 5)[3], 0);
        assert_eq!(pixel(&pixmap, 5, 30)[3], 0);
    }

    #[test]
    fn a_shape_past_the_edge_blurs_its_shadow_in() {
        // Two pixels left of the image: its blur (deviation 4 pixels)
        // reaches in.
        let ops = vec![
            CanvasOp::ShadowColor(Color(0x0000_ffff)),
            CanvasOp::ShadowBlur(Points(8.0)),
            CanvasOp::FillStyle(Paint::Color(Color(0xff00_00ff))),
            CanvasOp::FillRect(rect(-50.0, 0.0, 48.0, 40.0)),
        ];
        let pixmap = job(ops, (40, 40), 1.0).paint().unwrap();
        let near = pixel(&pixmap, 0, 20);
        assert!(
            near[3] > 40 && near[2] == near[3] && near[0] == 0,
            "{near:?}"
        );
        // It fades with the distance, and is gone past three deviations.
        assert!(pixel(&pixmap, 4, 20)[3] < near[3]);
        assert_eq!(pixel(&pixmap, 14, 20)[3], 0);
    }

    #[test]
    fn a_shadow_source_covers_the_blur_clamped_to_the_image() {
        let layer = IRect {
            x0: 0,
            y0: 0,
            x1: 100,
            y1: 100,
        };
        // A shape far larger than the image: what of it is within three
        // deviations (30 pixels) of where the moved shadow shows.
        let far = sk::Rect::from_ltrb(-1.0e9, -1.0e9, 1.0e9, 1.0e9).unwrap();
        let source = shadow_source(far, layer, 10.0, (5.0, -5.0), (100, 100));
        assert_eq!(
            source,
            Some(IRect {
                x0: -35,
                y0: -25,
                x1: 125,
                y1: 135
            })
        );
        // A shape whose shadow misses the image has none.
        let left = sk::Rect::from_ltrb(-200.0, 0.0, -50.0, 10.0).unwrap();
        assert_eq!(
            shadow_source(left, layer, 5.0, (0.0, 0.0), (100, 100)),
            None
        );
        // The largest shadows are those of a shape as large as the image.
        assert_eq!(shadow_limit((10, 10)), 2 * MAX_AREA);
        assert_eq!(shadow_limit((16384, 4096)), 16384 * 4096);
    }

    /// A drawing with shadows, a clip, a gradient and alpha, replayed into
    /// one pixmap, and as on screen into layers a run of glyphs splits
    /// (after operation `split`), composited bottom to top.
    #[test]
    fn one_pixmap_paints_what_layers_composite_to() {
        let g = CanvasGradient::linear(
            point(Points(0.0), Points(0.0)),
            point(Points(60.0), Points(0.0)),
        )
        .add_color_stop(percentage(0.0), Color(0xff00_00ff))
        .add_color_stop(percentage(1.0), Color(0x00ff_0080));
        let ops = vec![
            CanvasOp::Save,
            CanvasOp::ShadowColor(Color(0x0000_0080)),
            CanvasOp::ShadowBlur(Points(6.0)),
            CanvasOp::ShadowOffset(point(Points(3.0), Points(4.0))),
            CanvasOp::FillStyle(Paint::Color(Color(0x3366_ccff))),
            CanvasOp::FillRect(rect(5.0, 5.0, 30.0, 20.0)),
            CanvasOp::Restore,
            CanvasOp::GlobalAlpha(c(0.6)),
            CanvasOp::FillStyle(Paint::Gradient(Arc::new(g))),
            CanvasOp::FillRect(rect(15.0, 10.0, 40.0, 30.0)),
            CanvasOp::GlobalAlpha(c(1.0)),
            CanvasOp::BeginPath,
            CanvasOp::Path(PathOp::Rect([c(20.0), c(0.0), c(30.0), c(45.0)])),
            CanvasOp::Clip(None, FillRule::NonZero),
            CanvasOp::ShadowColor(Color(0xff00_00a0)),
            CanvasOp::ShadowBlur(Points(10.0)),
            CanvasOp::FillStyle(Paint::Color(Color(0xffcc_0099))),
            CanvasOp::FillRect(rect(25.0, 25.0, 30.0, 15.0)),
        ];
        let one = job(ops.clone(), (120, 100), 2.0).paint().unwrap();

        let system = Arc::new(gpui::TextSystem::new(Arc::new(gpui::NoopTextSystem::new())));
        let shaping = WindowTextSystem::new(system.clone());
        let images = Images::default();
        let key = Key {
            linear: [2.0, 0.0, 0.0, 2.0],
            scale: 2.0,
            size: (60.0, 50.0),
        };
        let region = IRect {
            x0: 0,
            y0: 0,
            x1: 120,
            y1: 100,
        };
        for split in [5, 9] {
            let text = (&shaping, &system);
            let mut replay = Replay::new(&[], &images, text, key, region, (0.0, 0.0), true);
            for (i, op) in ops.iter().enumerate() {
                replay.op(op);
                if i == split {
                    // A run of glyphs over everything: what paints next
                    // goes to a new pixmap above it.
                    replay.pending.push(GlyphRun {
                        glyphs: Vec::new(),
                        size: 10.0,
                        color: gpui::black(),
                        clip: None,
                    });
                    replay.pending_bounds = sk::Rect::from_ltrb(0.0, 0.0, 120.0, 100.0);
                }
            }
            replay.flush();
            let mut layers = replay.layers.into_iter().filter_map(|l| match l {
                Layer::Pixels(p, _) => Some(p),
                Layer::Text(_) => None,
            });
            let mut below = layers.next().unwrap();
            let mut count = 1;
            for above in layers {
                below.draw_pixmap(
                    0,
                    0,
                    above.as_ref(),
                    &sk::PixmapPaint::default(),
                    sk::Transform::identity(),
                    None,
                );
                count += 1;
            }
            assert_eq!(count, 2, "split after {split}");
            // Compositing a layer rounds once more than painting into the
            // pixmap below: the same pixels to within that rounding.
            for (a, b) in one.data().iter().zip(below.data()) {
                assert!(a.abs_diff(*b) <= 2, "split after {split}: {a} != {b}");
            }
        }
    }
}
