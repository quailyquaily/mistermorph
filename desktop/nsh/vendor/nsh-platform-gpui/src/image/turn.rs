//! Pictures under a rotation, skew or perspective, which GPUI's color
//! sprites cannot take: they are axis-aligned rectangles, and only its
//! monochrome sprites carry a (2D affine) transform.
//!
//! A one-color SVG (tinted, or drawn in one color) under an affine
//! transform is such a monochrome sprite ([`draw_mask`]): GPUI's
//! `paint_svg` with a [`TransformationMatrix`], so the GPU turns it exactly
//! every frame. GPUI's SVG renderer never sees the app's SVG (untrusted
//! input, which nsh's own renderer draws within its limits): it gets a
//! generated document holding only the picture's alpha as an inline PNG.
//! GPUI keeps that tile in its atlas for the window's life, as it keeps its
//! own icons (it has no way to drop one).
//!
//! Everything else (colors, perspective, a picture that its view's box or a
//! rounded or rotated clip cuts) is resampled on the CPU through the view's
//! whole transform, as canvases are rasterized ([`draw_resampled`]): into a
//! bitmap of the device pixels the turned picture covers, cut to the view's
//! box and the clip's polygon with antialiased edges, painted as an
//! upright sprite. The bitmap is kept while the transform's linear part
//! (and the picture, its frame and what cuts it) stays the same: a still
//! turned image is resampled once and moves with scrolling as it is; a
//! turning one is resampled every frame (on the main thread: a 24 pt icon
//! takes microseconds, a photo milliseconds).

use std::{rc::Rc, sync::Arc};

use gpui::{Corners, RenderImage, SharedString, TransformationMatrix};
use nsh_core::Color;

use super::{Texture, unpremultiply};
use crate::{
    decor::shape::{self, Pt},
    render::{DrawCx, bounds},
};

/// What a view last drew one of its pictures (its image, its placeholder)
/// turned with, kept for the next frame.
#[derive(Default)]
pub(crate) struct Turned {
    resampled: Option<Resampled>,
    mask: Option<Mask>,
}

/// A picture resampled through a transform.
struct Resampled {
    key: Key,
    texture: Rc<Texture>,
}

/// What a resampled bitmap depends on. Coordinates are device pixels
/// relative to where the view's origin lands, so moving the view (a
/// scroll) changes none of them.
struct Key {
    /// The GPUI image resampled, and its frame.
    image: usize,
    frame: usize,
    /// Device pixels to the picture's texels (homogeneous, row vectors).
    to_texel: [[f32; 3]; 3],
    /// The device pixels covered: left, top, width, height.
    region: (i32, i32, u32, u32),
    /// The outline it is cut to (convex).
    outline: Vec<Pt>,
}

impl Key {
    /// The same, up to float noise (the transform is remade every frame).
    fn same(&self, other: &Key) -> bool {
        let close = |a: f32, b: f32| (a - b).abs() <= 1e-4 * (1.0 + a.abs().max(b.abs()));
        self.image == other.image
            && self.frame == other.frame
            && self.region == other.region
            && self
                .to_texel
                .iter()
                .flatten()
                .zip(other.to_texel.iter().flatten())
                .all(|(a, b)| close(*a, *b))
            && self.outline.len() == other.outline.len()
            && self
                .outline
                .iter()
                .zip(&other.outline)
                .all(|(a, b)| close(a.0, b.0) && close(a.1, b.1))
    }
}

/// A picture's alpha as the SVG document GPUI draws as a monochrome sprite.
struct Mask {
    /// The GPUI image it was made from, and its frame.
    image: usize,
    frame: usize,
    /// Its name in GPUI's atlas.
    path: SharedString,
    svg: Arc<[u8]>,
}

/// `m · n` (row vectors: a point goes through `m`, then `n`).
fn mul3(m: &[[f32; 3]; 3], n: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| m[r][k] * n[k][c]).sum();
        }
    }
    out
}

/// True if `p` lies inside the convex polygon `poly` or within `eps` of it
/// (a picture's corner on its view's clipped edge is inside).
fn inside_convex(poly: &[Pt], p: Pt, eps: f32) -> bool {
    let n = poly.len();
    if n < 3 {
        return true;
    }
    let area: f32 = (0..n)
        .map(|i| {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum();
    let orientation = area.signum();
    (0..n).all(|i| {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let len = (b.0 - a.0).hypot(b.1 - a.1).max(1e-6);
        let side = ((b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0)) * orientation / len;
        side >= -eps
    })
}

/// Draws a one-color picture under the current (affine) transform as a
/// monochrome sprite GPUI turns: `texture`'s alpha (frame `frame`) over
/// `placed` (view coordinates: x, y, width, height), in `color` (filtered
/// and faded with the pass) at `alpha`. False when it cannot be drawn so
/// (a perspective, a picture its view's box or a clip polygon would cut,
/// GPUI failing): the caller resamples it instead.
#[allow(clippy::too_many_arguments)]
pub(super) fn draw_mask(
    cx: &mut DrawCx<'_>,
    turned: &mut Turned,
    texture: &Rc<Texture>,
    frame: usize,
    view: (f32, f32),
    placed: (f32, f32, f32, f32),
    color: Color,
    alpha: f32,
) -> bool {
    const EPS: f32 = 0.01;
    let (x, y, fw, fh) = placed;
    if !cx.transform.is_affine()
        || x < -EPS
        || y < -EPS
        || x + fw > view.0 + EPS
        || y + fh > view.1 + EPS
    {
        return false;
    }
    if let Some(clip) = cx.clip_polygon() {
        let corners = [(x, y), (x + fw, y), (x + fw, y + fh), (x, y + fh)];
        let shown = corners.iter().all(|&(px, py)| {
            cx.transform
                .map(px, py)
                .is_some_and(|p| inside_convex(clip, p, 0.05))
        });
        if !shown {
            return false;
        }
    }
    let image = texture.image().clone();
    let size = image.size(frame);
    let (tw, th) = (size.width.0, size.height.0);
    if tw <= 0 || th <= 0 {
        return true;
    }
    let id = image.id.0;
    if turned
        .mask
        .as_ref()
        .is_none_or(|m| (m.image, m.frame) != (id, frame))
    {
        let Some(svg) = alpha_svg(&image, frame) else {
            return false;
        };
        turned.mask = Some(Mask {
            image: id,
            frame,
            path: format!("nsh-image-alpha:{id}:{frame}").into(),
            svg: svg.into_bytes().into(),
        });
    }
    let Some(mask) = &turned.mask else {
        return false;
    };
    // The sprite is the texture at one texel a device pixel (GPUI scales
    // by nothing); its transform takes a texel to the view's coordinates
    // of the picture, then through the view's transform to the window's
    // device pixels. GPUI culls and orders a sprite by its untransformed
    // rectangle, so that rectangle is centered in the part that shows.
    let s = cx.scale;
    let shown = cx.rect(x, y, fw, fh).intersect(&cx.clip);
    if shown.size.width <= gpui::px(0.0) || shown.size.height <= gpui::px(0.0) {
        return true;
    }
    let center = shown.center();
    let origin = (
        (f32::from(center.x) * s - tw as f32 / 2.0).round(),
        (f32::from(center.y) * s - th as f32 / 2.0).round(),
    );
    let matrix = sprite_matrix(
        cx.transform.affine(),
        s,
        placed,
        (tw as f32, th as f32),
        origin,
    );
    let mut fill = cx.color(color);
    fill.a *= alpha;
    let sprite = bounds(origin.0 / s, origin.1 / s, tw as f32 / s, th as f32 / s);
    let (path, svg) = (mask.path.clone(), mask.svg.clone());
    let painted =
        cx.paint(|window, app| window.paint_svg(sprite, path, Some(&svg), matrix, fill, app));
    match painted {
        Ok(()) => true,
        Err(e) => {
            log::debug!("image: not turned by GPUI: {e}");
            false
        }
    }
}

/// The transform of a sprite of `texels` (width, height) at `origin`
/// (device pixels) that lands it on `placed` (view coordinates: x, y,
/// width, height) under the view's `affine` transform, in device pixels
/// (`s` a point).
fn sprite_matrix(
    affine: [f32; 6],
    s: f32,
    placed: (f32, f32, f32, f32),
    texels: (f32, f32),
    origin: Pt,
) -> TransformationMatrix {
    let [a, b, c, d, tx, ty] = affine;
    let (x, y, fw, fh) = placed;
    let (kx, ky) = (fw / texels.0, fh / texels.1);
    let m = [[s * a * kx, s * c * ky], [s * b * kx, s * d * ky]];
    TransformationMatrix {
        rotation_scale: m,
        translation: [
            s * (a * x + c * y + tx) - m[0][0] * origin.0 - m[0][1] * origin.1,
            s * (b * x + d * y + ty) - m[1][0] * origin.0 - m[1][1] * origin.1,
        ],
    }
}

/// An SVG document of `image`'s frame alpha, at its size: an inline PNG
/// (luminance and alpha) GPUI's renderer reads the alpha of.
fn alpha_svg(image: &RenderImage, frame: usize) -> Option<String> {
    use base64::Engine as _;
    use image::ImageEncoder as _;
    let bytes = image.as_bytes(frame)?;
    let size = image.size(frame);
    let (w, h) = (size.width.0 as u32, size.height.0 as u32);
    let la: Vec<u8> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|px| [0, px[3]])
        .collect();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::NoFilter,
    )
    .write_image(&la, w, h, image::ExtendedColorType::La8)
    .ok()?;
    let data = base64::engine::general_purpose::STANDARD.encode(&png);
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" \
         viewBox=\"0 0 {w} {h}\"><image width=\"{w}\" height=\"{h}\" \
         preserveAspectRatio=\"none\" href=\"data:image/png;base64,{data}\"/></svg>"
    ))
}

/// Draws `texture` (frame `frame`) over `placed` (view coordinates: x, y,
/// width, height) under the current transform, resampled into a bitmap
/// of the device pixels it covers, cut to the view's box (`view`: width,
/// height) and to the clip polygon. False when part of it is behind the
/// viewer: the caller draws it upright.
pub(super) fn draw_resampled(
    cx: &mut DrawCx<'_>,
    turned: &mut Turned,
    texture: &Rc<Texture>,
    frame: usize,
    view: (f32, f32),
    placed: (f32, f32, f32, f32),
) -> bool {
    let (px, py, fw, fh) = placed;
    let (x0, y0) = (px.max(0.0), py.max(0.0));
    let (x1, y1) = ((px + fw).min(view.0), (py + fh).min(view.1));
    if x1 <= x0 || y1 <= y0 {
        return true;
    }
    let t = cx.transform;
    let (Some(origin), Some(inverse)) = (t.map(0.0, 0.0), t.plane_inverse()) else {
        return false;
    };
    let mut quad = Vec::with_capacity(4);
    for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
        match t.map(x, y) {
            Some(p) => quad.push(p),
            None => return false,
        }
    }
    let outline = match cx.clip_polygon() {
        Some(clip) if !quad.iter().all(|&p| inside_convex(clip, p, 0.05)) => {
            shape::clip_convex(&quad, clip)
        }
        _ => quad,
    };
    if outline.len() < 3 {
        return true;
    }
    let s = cx.scale;
    // Device pixels from where the view's origin lands.
    let outline: Vec<Pt> = outline
        .iter()
        .map(|p| ((p.0 - origin.0) * s, (p.1 - origin.1) * s))
        .collect();
    let (mut l, mut tp, mut r, mut b) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in &outline {
        (l, tp, r, b) = (l.min(p.0), tp.min(p.1), r.max(p.0), b.max(p.1));
    }
    let clip = cx.clip;
    l = l.max((f32::from(clip.left()) - origin.0) * s);
    tp = tp.max((f32::from(clip.top()) - origin.1) * s);
    r = r.min((f32::from(clip.right()) - origin.0) * s);
    b = b.min((f32::from(clip.bottom()) - origin.1) * s);
    let (left, top) = (l.floor() as i32, tp.floor() as i32);
    let (right, bottom) = (r.ceil() as i32, b.ceil() as i32);
    if right <= left || bottom <= top {
        return true;
    }
    let region = (left, top, (right - left) as u32, (bottom - top) as u32);
    let image = texture.image().clone();
    let size = image.size(frame);
    let (tw, th) = (size.width.0, size.height.0);
    if tw <= 0 || th <= 0 || fw <= 0.0 || fh <= 0.0 {
        return true;
    }
    let (kx, ky) = (tw as f32 / fw, th as f32 / fh);
    let to_window = [
        [1.0 / s, 0.0, 0.0],
        [0.0, 1.0 / s, 0.0],
        [origin.0, origin.1, 1.0],
    ];
    let to_pixels = [[kx, 0.0, 0.0], [0.0, ky, 0.0], [-px * kx, -py * ky, 1.0]];
    let key = Key {
        image: image.id.0,
        frame,
        to_texel: mul3(&mul3(&to_window, &inverse), &to_pixels),
        region,
        outline,
    };
    if turned.resampled.as_ref().is_none_or(|r| !r.key.same(&key)) {
        let started = std::time::Instant::now();
        let Some(pixels) = image.as_bytes(frame) else {
            return true;
        };
        let Some(made) = resample(
            pixels,
            (tw as u32, th as u32),
            &key.to_texel,
            key.region,
            &key.outline,
        ) else {
            return true;
        };
        log::debug!(
            target: "nsh::perf",
            "image: {}×{} px resampled in {:.2} ms",
            region.2,
            region.3,
            started.elapsed().as_secs_f64() * 1000.0
        );
        turned.resampled = Some(Resampled {
            key,
            texture: Rc::new(Texture::new(Arc::new(made))),
        });
    }
    let Some(resampled) = &turned.resampled else {
        return true;
    };
    // Whole device pixels, as the bitmap's are the screen's: at most half
    // a pixel off the view's subpixel position.
    let (ox, oy) = ((origin.0 * s).round(), (origin.1 * s).round());
    let (rx, ry, rw, rh) = resampled.key.region;
    let at = bounds(
        (ox + rx as f32) / s,
        (oy + ry as f32) / s,
        rw as f32 / s,
        rh as f32 / s,
    );
    let data = resampled.texture.image().clone();
    cx.paint(|window, _| {
        if let Err(e) = window.paint_image(at, at, Corners::default(), data, 0, false) {
            log::warn!("image: cannot paint: {e}");
        }
    });
    true
}

/// Resamples `pixels` (straight BGRA of `size`) into `region` (device
/// pixels: left, top, width, height), each pixel's center taken to the
/// texels by `to_texel` and sampled bilinearly (edges clamped), cut to
/// `outline` (device pixels, convex) with antialiased edges. Straight
/// BGRA, as GPUI's images.
fn resample(
    pixels: &[u8],
    size: (u32, u32),
    to_texel: &[[f32; 3]; 3],
    region: (i32, i32, u32, u32),
    outline: &[Pt],
) -> Option<RenderImage> {
    let (rx, ry, rw, rh) = region;
    let mut coverage = tiny_skia::Mask::new(rw, rh)?;
    let mut path = tiny_skia::PathBuilder::new();
    path.move_to(outline[0].0, outline[0].1);
    for p in &outline[1..] {
        path.line_to(p.0, p.1);
    }
    path.close();
    coverage.fill_path(
        &path.finish()?,
        tiny_skia::FillRule::Winding,
        true,
        tiny_skia::Transform::from_translate(-rx as f32, -ry as f32),
    );
    let coverage = coverage.data();
    let (w, h) = (size.0 as usize, size.1 as usize);
    let (max_x, max_y) = (w as f32 - 1.0, h as f32 - 1.0);
    // A texel, premultiplied.
    let texel = |x: usize, y: usize| -> [f32; 4] {
        let at = (y * w + x) * 4;
        let p = &pixels[at..at + 4];
        let a = p[3] as f32 / 255.0;
        [
            p[0] as f32 * a,
            p[1] as f32 * a,
            p[2] as f32 * a,
            p[3] as f32,
        ]
    };
    let m = to_texel;
    let mut out = vec![0u8; rw as usize * rh as usize * 4];
    for j in 0..rh as usize {
        let y = ry as f32 + j as f32 + 0.5;
        for i in 0..rw as usize {
            let cover = coverage[j * rw as usize + i];
            if cover == 0 {
                continue;
            }
            let x = rx as f32 + i as f32 + 0.5;
            let q = x * m[0][2] + y * m[1][2] + m[2][2];
            if q <= 1e-9 {
                continue;
            }
            let u = ((x * m[0][0] + y * m[1][0] + m[2][0]) / q - 0.5).clamp(0.0, max_x);
            let v = ((x * m[0][1] + y * m[1][1] + m[2][1]) / q - 0.5).clamp(0.0, max_y);
            let (u0, v0) = (u.floor(), v.floor());
            let (fu, fv) = (u - u0, v - v0);
            let (u0, v0) = (u0 as usize, v0 as usize);
            let (u1, v1) = ((u0 + 1).min(w - 1), (v0 + 1).min(h - 1));
            let (a, b, c, d) = (texel(u0, v0), texel(u1, v0), texel(u0, v1), texel(u1, v1));
            let k = cover as f32 / 255.0;
            let at = (j * rw as usize + i) * 4;
            for ch in 0..4 {
                let top = a[ch] + (b[ch] - a[ch]) * fu;
                let bottom = c[ch] + (d[ch] - c[ch]) * fu;
                out[at + ch] = ((top + (bottom - top) * fv) * k).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    unpremultiply(&mut out);
    let frame = image::RgbaImage::from_raw(rw, rh, out)?;
    Some(RenderImage::new(vec![image::Frame::new(frame)]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Mat4;

    /// A 4 × 2 picture: its left half red, its right half green (BGRA).
    fn halves() -> Vec<u8> {
        let (red, green) = ([0, 0, 255, 255], [0, 255, 0, 255]);
        let row = [red, red, green, green];
        row.iter().chain(row.iter()).flatten().copied().collect()
    }

    /// `picture` (4 × 2 pixels over a 40 × 20 point box at 2 device
    /// pixels a point) resampled under `t`: the bitmap, its region.
    fn turned(t: Mat4) -> (Vec<u8>, (i32, i32, u32, u32)) {
        let s = 2.0;
        let origin = t.map(0.0, 0.0).unwrap();
        let quad: Vec<Pt> = [(0.0, 0.0), (40.0, 0.0), (40.0, 20.0), (0.0, 20.0)]
            .iter()
            .map(|&(x, y)| {
                let p = t.map(x, y).unwrap();
                ((p.0 - origin.0) * s, (p.1 - origin.1) * s)
            })
            .collect();
        let (mut l, mut tp, mut r, mut b) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in &quad {
            (l, tp, r, b) = (l.min(p.0), tp.min(p.1), r.max(p.0), b.max(p.1));
        }
        let region = (
            l.floor() as i32,
            tp.floor() as i32,
            (r.ceil() - l.floor()) as u32,
            (b.ceil() - tp.floor()) as u32,
        );
        let to_window = [
            [1.0 / s, 0.0, 0.0],
            [0.0, 1.0 / s, 0.0],
            [origin.0, origin.1, 1.0],
        ];
        let to_pixels = [[0.1, 0.0, 0.0], [0.0, 0.1, 0.0], [0.0, 0.0, 1.0]];
        let m = mul3(&mul3(&to_window, &t.plane_inverse().unwrap()), &to_pixels);
        let image = resample(&halves(), (4, 2), &m, region, &quad).unwrap();
        (image.as_bytes(0).unwrap().to_vec(), region)
    }

    /// The BGRA pixel of `bitmap` (`region`) at window point `(x, y)` of a
    /// view whose origin landed at `origin`.
    fn at(bitmap: &[u8], region: (i32, i32, u32, u32), origin: Pt, (x, y): Pt) -> [u8; 4] {
        let i = ((x - origin.0) * 2.0).floor() as i32 - region.0;
        let j = ((y - origin.1) * 2.0).floor() as i32 - region.1;
        assert!(i >= 0 && j >= 0 && (i as u32) < region.2 && (j as u32) < region.3);
        let at = (j as usize * region.2 as usize + i as usize) * 4;
        bitmap[at..at + 4].try_into().unwrap()
    }

    const RED: [u8; 4] = [0, 0, 255, 255];
    const GREEN: [u8; 4] = [0, 255, 0, 255];

    #[test]
    fn a_quarter_turn_puts_the_left_half_on_top() {
        // Turned a quarter clockwise about the box's center (20, 10).
        let t = Mat4::new()
            .translate(20.0, 10.0)
            .rotate(90.0)
            .translate(-20.0, -10.0)
            .then(&Mat4::new().translate(100.0, 100.0));
        let (bitmap, region) = turned(t);
        let origin = t.map(0.0, 0.0).unwrap();
        // 20 points wide and 40 tall around (120, 110): the left half on
        // top, the right half below.
        assert_eq!((region.2, region.3), (40, 80));
        assert_eq!(at(&bitmap, region, origin, (120.0, 95.0)), RED);
        assert_eq!(at(&bitmap, region, origin, (120.0, 125.0)), GREEN);
        assert_eq!(at(&bitmap, region, origin, (111.0, 91.0)), RED);
        assert_eq!(at(&bitmap, region, origin, (129.0, 129.0)), GREEN);
    }

    #[test]
    fn an_eighth_turn_leaves_the_corners_of_its_bounds_empty() {
        let t = Mat4::new()
            .translate(20.0, 10.0)
            .rotate(45.0)
            .translate(-20.0, -10.0);
        let (bitmap, region) = turned(t);
        let origin = t.map(0.0, 0.0).unwrap();
        let (l, tp) = (
            origin.0 + region.0 as f32 / 2.0,
            origin.1 + region.1 as f32 / 2.0,
        );
        let (r, b) = (l + region.2 as f32 / 2.0, tp + region.3 as f32 / 2.0);
        for corner in [
            (l + 0.5, tp + 0.5),
            (r - 0.5, tp + 0.5),
            (l + 0.5, b - 0.5),
            (r - 0.5, b - 0.5),
        ] {
            assert_eq!(at(&bitmap, region, origin, corner)[3], 0, "{corner:?}");
        }
        // The red half turned down to the left of the center.
        assert_eq!(at(&bitmap, region, origin, (12.0, 4.0)), RED);
        assert_eq!(at(&bitmap, region, origin, (28.0, 16.0)), GREEN);
    }

    #[test]
    fn a_perspective_narrows_the_far_side() {
        // Turned about its vertical axis with a perspective: the right
        // side recedes, shorter than the left.
        let t = Mat4::new()
            .translate(20.0, 10.0)
            .perspective(100.0)
            .rotate_y(50.0)
            .translate(-20.0, -10.0);
        let (bitmap, region) = turned(t);
        let origin = t.map(0.0, 0.0).unwrap();
        let column = |x: f32| {
            (0..region.3)
                .filter(|&j| {
                    let y = origin.1 + (region.1 + j as i32) as f32 / 2.0;
                    at(&bitmap, region, origin, (x, y))[3] > 128
                })
                .count()
        };
        let left = t.map(1.0, 10.0).unwrap().0;
        let right = t.map(39.0, 10.0).unwrap().0;
        assert!(
            column(left) > column(right) + 4,
            "{} vs {}",
            column(left),
            column(right)
        );
        assert_eq!(at(&bitmap, region, origin, (left, 10.0)), RED);
        assert_eq!(at(&bitmap, region, origin, (right, 10.0)), GREEN);
    }

    #[test]
    fn the_mask_transform_turns_the_texels_onto_the_view() {
        // The sprite's corners land on the turned picture's.
        let (s, (tw, th)) = (2.0f32, (80.0f32, 40.0f32));
        let t = Mat4::new()
            .translate(20.0, 10.0)
            .rotate(90.0)
            .translate(-20.0, -10.0)
            .then(&Mat4::new().translate(100.0, 100.0));
        // A 40 × 20 picture placed 4 points in, its sprite at (300, 50).
        let (ox, oy) = (300.0, 50.0);
        let matrix = sprite_matrix(t.affine(), s, (4.0, 4.0, 40.0, 20.0), (tw, th), (ox, oy));
        for (texel, local) in [
            ((0.0, 0.0), (4.0, 4.0)),
            ((tw, 0.0), (44.0, 4.0)),
            ((0.0, th), (4.0, 24.0)),
            ((tw, th), (44.0, 24.0)),
        ] {
            let p = matrix.apply(gpui::point(gpui::px(ox + texel.0), gpui::px(oy + texel.1)));
            let want = t.map(local.0, local.1).unwrap();
            assert!((f32::from(p.x) - want.0 * s).abs() < 1e-3, "{p:?} {want:?}");
            assert!((f32::from(p.y) - want.1 * s).abs() < 1e-3, "{p:?} {want:?}");
        }
    }

    #[test]
    fn alpha_documents_hold_the_alpha() {
        let image = RenderImage::new(vec![image::Frame::new(
            image::RgbaImage::from_raw(4, 2, halves()).unwrap(),
        )]);
        let svg = alpha_svg(&image, 0).unwrap();
        assert!(svg.starts_with("<svg") && svg.contains("data:image/png;base64,"));
    }

    /// Main-thread time a turning picture takes a frame: a 24 pt icon and
    /// a 600 × 600 pixel photo at 2 pixels a point, a full turn in 1°
    /// steps (`cargo test --release -p nsh-platform-gpui bench_turning --
    /// --ignored --nocapture`).
    #[test]
    #[ignore]
    fn bench_turning() {
        for (name, px) in [("24 pt icon", 48u32), ("600 × 600 px photo", 600)] {
            let pixels: Vec<u8> = (0..px * px)
                .flat_map(|i| [(i % 251) as u8, (i % 241) as u8, (i % 239) as u8, 255])
                .collect();
            let points = px as f32 / 2.0;
            let started = std::time::Instant::now();
            for degrees in 0..360 {
                let half = points / 2.0;
                let t = Mat4::new()
                    .translate(half, half)
                    .rotate(degrees as f32)
                    .translate(-half, -half)
                    .then(&Mat4::new().translate(100.3, 200.7));
                let origin = t.map(0.0, 0.0).unwrap();
                let quad: Vec<Pt> = [(0.0, 0.0), (points, 0.0), (points, points), (0.0, points)]
                    .iter()
                    .map(|&(x, y)| {
                        let p = t.map(x, y).unwrap();
                        ((p.0 - origin.0) * 2.0, (p.1 - origin.1) * 2.0)
                    })
                    .collect();
                let (mut l, mut tp, mut r, mut b) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
                for p in &quad {
                    (l, tp, r, b) = (l.min(p.0), tp.min(p.1), r.max(p.0), b.max(p.1));
                }
                let region = (
                    l.floor() as i32,
                    tp.floor() as i32,
                    (r.ceil() - l.floor()) as u32,
                    (b.ceil() - tp.floor()) as u32,
                );
                let to_window = [[0.5, 0.0, 0.0], [0.0, 0.5, 0.0], [origin.0, origin.1, 1.0]];
                let to_pixels = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 1.0]];
                let m = mul3(&mul3(&to_window, &t.plane_inverse().unwrap()), &to_pixels);
                std::hint::black_box(resample(&pixels, (px, px), &m, region, &quad));
            }
            let ms = started.elapsed().as_secs_f64() * 1000.0 / 360.0;
            println!("{name}: {ms:.3} ms a frame");
        }
    }

    #[test]
    fn corners_on_a_clipped_edge_are_inside() {
        let square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(inside_convex(&square, (10.0, 10.0), 0.05));
        assert!(inside_convex(&square, (10.01, 5.0), 0.05));
        assert!(!inside_convex(&square, (10.5, 5.0), 0.05));
    }
}
