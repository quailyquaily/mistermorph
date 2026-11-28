//! A clipboard image as `onPaste` hands it to the app (`PasteEvent::files`).
//!
//! GPUI says what format each clipboard image is. Upstream drops that and lets
//! `PastedFile::image` guess from the bytes, naming anything it does not know
//! `image.png`: an SVG (markup) became a "PNG". And the formats apps expect
//! (PNG, JPEG, WebP) are not what every system puts there: a Windows
//! screenshot is a device-independent bitmap, which GPUI makes a BMP, and
//! macOS apps may offer only TIFF. Here PNG, JPEG, WebP and GIF go as they
//! are, an SVG keeps its own type, and BMP, TIFF and ICO become PNG, decoded
//! within limits (an image too large to decode keeps its own type, which the
//! app refuses with the formats it takes). Pasted bytes are never logged.

use ::image::{ImageFormat, ImageReader, Limits};
use std::io::Cursor;

/// The formats GPUI reads from the clipboard (`gpui::ImageFormat`), without
/// GPUI's type so the conversion can be tested on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClipboardFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
    Svg,
    Bmp,
    Tiff,
    Ico,
    Pnm,
}

/// The largest image a paste decodes to convert it: wider or taller than a
/// 16K screen, or more than 256 MiB of pixels, keeps its own type.
const MAX_SIDE: u32 = 16_384;
const MAX_ALLOC: u64 = 256 * 1024 * 1024;

/// The name, type and bytes of a pasted clipboard image of `format`.
pub(crate) fn pasted_image(format: ClipboardFormat, bytes: Vec<u8>) -> (String, String, Vec<u8>) {
    let (mime, extension, decode) = match format {
        ClipboardFormat::Png => ("image/png", "png", None),
        ClipboardFormat::Jpeg => ("image/jpeg", "jpg", None),
        ClipboardFormat::Webp => ("image/webp", "webp", None),
        ClipboardFormat::Gif => ("image/gif", "gif", None),
        ClipboardFormat::Svg => ("image/svg+xml", "svg", None),
        ClipboardFormat::Bmp => ("image/bmp", "bmp", Some(ImageFormat::Bmp)),
        ClipboardFormat::Tiff => ("image/tiff", "tiff", Some(ImageFormat::Tiff)),
        ClipboardFormat::Ico => ("image/x-icon", "ico", Some(ImageFormat::Ico)),
        ClipboardFormat::Pnm => ("image/x-portable-anymap", "pnm", None),
    };
    if let Some(decode) = decode
        && let Some(png) = to_png(&bytes, decode)
    {
        return ("image.png".to_owned(), "image/png".to_owned(), png);
    }
    (format!("image.{extension}"), mime.to_owned(), bytes)
}

/// `bytes` of `format` encoded as PNG, or `None` when they do not decode
/// within the limits.
fn to_png(bytes: &[u8], format: ImageFormat) -> Option<Vec<u8>> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    let mut png = Vec::new();
    let encoder = ::image::codecs::png::PngEncoder::new_with_quality(
        Cursor::new(&mut png),
        ::image::codecs::png::CompressionType::Fast,
        ::image::codecs::png::FilterType::Adaptive,
    );
    image.write_with_encoder(encoder).ok()?;
    Some(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let image =
            ::image::RgbImage::from_fn(5, 3, |x, y| ::image::Rgb([x as u8 * 40, y as u8 * 80, 7]));
        let mut out = Vec::new();
        ::image::DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut out), format)
            .unwrap();
        out
    }

    fn decoded(bytes: &[u8]) -> ::image::RgbImage {
        ::image::load_from_memory_with_format(bytes, ImageFormat::Png)
            .unwrap()
            .to_rgb8()
    }

    #[test]
    fn png_jpeg_webp_and_gif_pass_as_they_are_with_their_types() {
        for (format, mime, name) in [
            (ClipboardFormat::Png, "image/png", "image.png"),
            (ClipboardFormat::Jpeg, "image/jpeg", "image.jpg"),
            (ClipboardFormat::Webp, "image/webp", "image.webp"),
            (ClipboardFormat::Gif, "image/gif", "image.gif"),
        ] {
            let bytes = vec![1, 2, 3, 4];
            assert_eq!(
                pasted_image(format, bytes.clone()),
                (name.to_owned(), mime.to_owned(), bytes)
            );
        }
    }

    #[test]
    fn an_svg_keeps_its_type_and_is_never_called_a_png() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>".to_vec();
        let (name, mime, bytes) = pasted_image(ClipboardFormat::Svg, svg.clone());
        assert_eq!(
            (name.as_str(), mime.as_str()),
            ("image.svg", "image/svg+xml")
        );
        assert_eq!(bytes, svg);
    }

    #[test]
    fn a_bitmap_or_tiff_becomes_a_png_of_the_same_pixels() {
        for (format, kind) in [
            (ClipboardFormat::Bmp, ImageFormat::Bmp),
            (ClipboardFormat::Tiff, ImageFormat::Tiff),
        ] {
            let source = encoded(kind);
            let (name, mime, png) = pasted_image(format, source.clone());
            assert_eq!(
                (name.as_str(), mime.as_str()),
                ("image.png", "image/png"),
                "{format:?}"
            );
            assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"), "{format:?}");
            let original = ::image::load_from_memory_with_format(&source, kind)
                .unwrap()
                .to_rgb8();
            assert_eq!(decoded(&png), original, "{format:?}");
        }
    }

    #[test]
    fn a_windows_dib_made_a_bmp_converts() {
        // GPUI prepends a BITMAPFILEHEADER to CF_DIB (gpui-fast-windows `convert_dib_to_bmp`):
        // a bottom-up 24-bit BITMAPINFOHEADER bitmap, as the Snipping Tool puts there.
        let (width, height) = (2u32, 2u32);
        let row = ((width * 3 + 3) & !3) as usize;
        let mut dib = Vec::new();
        dib.extend_from_slice(&40u32.to_le_bytes());
        dib.extend_from_slice(&(width as i32).to_le_bytes());
        dib.extend_from_slice(&(height as i32).to_le_bytes());
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&24u16.to_le_bytes());
        dib.extend_from_slice(&[0u8; 24]);
        // Bottom row first: blue, green; then the top row: red, white.
        let mut pixels = vec![0u8; row * height as usize];
        pixels[0..6].copy_from_slice(&[255, 0, 0, 0, 255, 0]);
        pixels[row..row + 6].copy_from_slice(&[0, 0, 255, 255, 255, 255]);
        dib.extend_from_slice(&pixels);
        let mut bmp = Vec::new();
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(14 + dib.len() as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&dib);
        let (_, mime, png) = pasted_image(ClipboardFormat::Bmp, bmp);
        assert_eq!(mime, "image/png");
        let image = decoded(&png);
        assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(image.get_pixel(1, 0).0, [255, 255, 255]);
        assert_eq!(image.get_pixel(0, 1).0, [0, 0, 255]);
        assert_eq!(image.get_pixel(1, 1).0, [0, 255, 0]);
    }

    #[test]
    fn bytes_that_do_not_decode_or_are_too_large_keep_their_own_type() {
        let (name, mime, bytes) = pasted_image(ClipboardFormat::Bmp, b"BMnot really".to_vec());
        assert_eq!(
            (name.as_str(), mime.as_str(), bytes.as_slice()),
            ("image.bmp", "image/bmp", &b"BMnot really"[..])
        );
        // A bitmap header claiming 20000 x 20000 pixels is not decoded.
        let mut huge = encoded(ImageFormat::Bmp);
        huge[18..22].copy_from_slice(&20_000i32.to_le_bytes());
        huge[22..26].copy_from_slice(&20_000i32.to_le_bytes());
        let (_, mime, _) = pasted_image(ClipboardFormat::Bmp, huge);
        assert_eq!(mime, "image/bmp");
        let (_, mime, _) = pasted_image(ClipboardFormat::Pnm, b"P6\n1 1\n255\n\0\0\0".to_vec());
        assert_eq!(mime, "image/x-portable-anymap");
    }
}
