//! Views drawn by GPUI's renderer offscreen and read back as pixels
//! (feature `shot`: GPUI's headless renderer, Metal on macOS, wgpu on
//! Linux; skipped where the machine has none). A test binary of its own,
//! run on the main thread (no test harness): nsh's main-thread queue
//! belongs to the first app a process makes, and the macOS platform that
//! gives the text system is made on the main thread.

use std::time::{Duration, Instant};

use gpui::{AppContext as _, HeadlessAppContext, px, size};
use nsh_platform_gpui::{App, AppOptions, AppView, Bundle};

/// A PNG of `w` × `h` pixels, its left half red and its right half green,
/// as a data URI.
fn halves(w: u32, h: u32) -> String {
    let image = image::RgbaImage::from_fn(w, h, |x, _| {
        if x < w / 2 {
            image::Rgba([255, 0, 0, 255])
        } else {
            image::Rgba([0, 255, 0, 255])
        }
    });
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    use base64::Engine as _;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

/// An SVG of 40 × 20 points, its left half `fill`, its right half empty.
fn half_icon(fill: &str) -> String {
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="20" height="20" fill="{fill}"/></svg>"#
    );
    use base64::Engine as _;
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    )
}

/// Turned a quarter clockwise, each picture's left half is on top:
/// a photo turned itself (resampled), a tinted icon in a turned box and a
/// one-color icon (both turned by the GPU), and a photo in a turned,
/// rounded and clipping card (resampled, cut to the card's corners).
fn app() -> String {
    format!(
        r##"
import {{ mount, Image, View }} from "nsh";

const PHOTO = "{photo}";
const ICON = "{icon}";
const RED_ICON = "{red_icon}";

function App() {{
  return (
    <View style={{{{ flex: 1, backgroundColor: "#ffffff" }}}}>
      <Image src={{PHOTO}} style={{{{ position: "absolute", left: 20, top: 30, width: 40, height: 20, transform: [{{ rotate: "90deg" }}] }}}} />
      <View style={{{{ position: "absolute", left: 100, top: 30, width: 40, height: 20, transform: [{{ rotate: "90deg" }}] }}}}>
        <Image src={{ICON}} style={{{{ width: 40, height: 20, tintColor: "#0000ff" }}}} />
      </View>
      <Image src={{RED_ICON}} style={{{{ position: "absolute", left: 180, top: 30, width: 40, height: 20, transform: [{{ rotate: "90deg" }}] }}}} />
      <View style={{{{ position: "absolute", left: 20, top: 100, width: 60, height: 60, borderRadius: 30, overflow: "hidden", transform: [{{ rotate: "90deg" }}] }}}}>
        <Image src={{PHOTO}} style={{{{ width: 60, height: 60 }}}} />
      </View>
    </View>
  );
}}
mount(App);
"##,
        photo = halves(40, 20),
        icon = half_icon("#000000"),
        red_icon = half_icon("#ff0000"),
    )
}

/// The pixel at window point `(x, y)` of a screenshot `scale` pixels a
/// point.
fn pixel(shot: &image::RgbaImage, scale: f32, (x, y): (f32, f32)) -> [u8; 3] {
    let p = shot.get_pixel((x * scale) as u32, (y * scale) as u32).0;
    [p[0], p[1], p[2]]
}

fn near(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(&b).all(|(a, b)| a.abs_diff(*b) <= 24)
}

const WHITE: [u8; 3] = [255, 255, 255];
const RED: [u8; 3] = [255, 0, 0];
const GREEN: [u8; 3] = [0, 255, 0];
const BLUE: [u8; 3] = [0, 0, 255];

/// What each point should show: (point, color, what it shows).
const EXPECTED: &[((f32, f32), [u8; 3], &str)] = &[
    // The photo (center 40, 40): 20 wide, 40 tall.
    (
        (40.0, 25.0),
        RED,
        "the photo's left half, turned to the top",
    ),
    (
        (40.0, 55.0),
        GREEN,
        "the photo's right half, turned to the bottom",
    ),
    (
        (25.0, 40.0),
        WHITE,
        "left of the turned photo (its upright left half)",
    ),
    // The tinted icon (center 120, 40).
    (
        (120.0, 25.0),
        BLUE,
        "the tinted icon's half, turned to the top",
    ),
    ((120.0, 55.0), WHITE, "the tinted icon's empty half"),
    ((105.0, 40.0), WHITE, "left of the turned tinted icon"),
    // The one-color icon (center 200, 40).
    ((200.0, 25.0), RED, "the red icon's half, turned to the top"),
    ((185.0, 40.0), WHITE, "left of the turned red icon"),
    // The round card (center 50, 130, radius 30).
    (
        (50.0, 110.0),
        RED,
        "the card's photo, its left half turned to the top",
    ),
    (
        (50.0, 150.0),
        GREEN,
        "the card's photo, its right half at the bottom",
    ),
    ((23.0, 103.0), WHITE, "outside the card's round corner"),
];

fn main() {
    turned_images_and_icons_turn_with_their_views();
    println!("render: turned images and icons turn with their views: ok");
}

fn turned_images_and_icons_turn_with_their_views() {
    let probe = gpui_platform::current_headless_renderer();
    if !matches!(probe, Ok(Some(_))) {
        eprintln!("no headless renderer here: skipped");
        return;
    }
    drop(probe);
    let text = gpui_platform::current_platform(true).text_system();
    let mut cx = HeadlessAppContext::with_platform(
        text,
        std::sync::Arc::new(()),
        gpui_platform::current_headless_renderer,
    );
    // The engine and the image decoders run on threads of their own.
    cx.allow_parking();
    let window = cx
        .open_window(size(px(240.0), px(180.0)), |window, cx| {
            cx.new(|cx| AppView::new(AppOptions::default(), window, cx))
        })
        .unwrap();
    let code = nsh_bundler::compile_module("App.tsx", &app(), &[]).unwrap();
    cx.update(|cx| {
        window
            .update(cx, |view, _, _| view.load(App::Js(Bundle::source(code))))
            .unwrap()
    });
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        cx.update_window(window.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .unwrap();
        let shot = cx.capture_screenshot(window.into()).unwrap();
        let scale = shot.width() as f32 / 240.0;
        let wrong: Vec<String> = EXPECTED
            .iter()
            .filter_map(|&(at, want, what)| {
                let got = pixel(&shot, scale, at);
                (!near(got, want)).then(|| format!("{what} at {at:?}: {got:?}, not {want:?}"))
            })
            .collect();
        if wrong.is_empty() {
            return;
        }
        if start.elapsed() > Duration::from_secs(15) {
            let path = std::env::temp_dir().join("nsh-turned-images.png");
            shot.save(&path).unwrap();
            panic!("{} (screenshot: {})", wrong.join("; "), path.display());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
