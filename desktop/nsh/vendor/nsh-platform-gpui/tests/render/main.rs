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

/// A scroll view 200 × 160 at (20, 10) over 200 × 160 of content, the
/// photo 100 × 80 at its top left, zoomed to 2× around its middle: the
/// viewport shows the content from (50, 40), the photo's right half at
/// twice its size in its top left quarter. `text` adds 60 lines of text
/// under the photo, `steps` zooms by another step every 16 ms.
fn zoom_app(text: bool, steps: bool) -> String {
    let lines = if text {
        r#"<Each of={LINES}>{(i) => <Text style={{ fontSize: 9 }}>Line {i} of zoomed text</Text>}</Each>"#
    } else {
        ""
    };
    let steps = if steps {
        r#"let i = 0;
setInterval(() => {
  i += 1;
  scroll.zoomTo({ scale: 1 + (i % 60) / 20, animated: false });
}, 16);"#
    } else {
        ""
    };
    format!(
        r##"
import {{ mount, Image, Scroll, type ScrollRef, Text, View }} from "nsh";

const PHOTO = "{photo}";
const LINES = Array.from({{ length: 60 }}, (_, i) => i);
let scroll!: ScrollRef;

function App() {{
  return (
    <View style={{{{ flex: 1, backgroundColor: "#ffffff" }}}}>
      <Scroll ref={{scroll}} maximumZoomScale={{4}} zoomScale={{2}} style={{{{ position: "absolute", left: 20, top: 10, width: 200, height: 160 }}}}>
        <View style={{{{ width: 200, height: 160 }}}}>
          <Image src={{PHOTO}} style={{{{ width: 100, height: 80 }}}} />
          {lines}
        </View>
      </Scroll>
    </View>
  );
}}
mount(App);
{steps}
"##,
        photo = halves(100, 80),
    )
}

/// What the zoomed scroll view shows (window points).
const ZOOMED: &[((f32, f32), [u8; 3], &str)] = &[
    (
        (25.0, 15.0),
        GREEN,
        "the photo's right half at the viewport's top left (red unzoomed)",
    ),
    (
        (60.0, 40.0),
        GREEN,
        "content (70, 55), the photo's right half (red unzoomed)",
    ),
    ((115.0, 85.0), GREEN, "near the photo's zoomed bottom right"),
    ((125.0, 40.0), WHITE, "right of the zoomed photo"),
    ((60.0, 100.0), WHITE, "below the zoomed photo"),
    ((230.0, 100.0), WHITE, "outside the scroll view"),
];

fn main() {
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
    shows(&mut cx, &app(), EXPECTED, "turned-images");
    println!("render: turned images and icons turn with their views: ok");
    shows(&mut cx, &zoom_app(false, false), ZOOMED, "zoomed-scroll");
    println!("render: zoomed scroll views draw their content scaled: ok");
    if std::env::var_os("NSH_RENDER_BENCH").is_some() {
        zoom_frames(&mut cx);
    }
}

/// Opens a 240 × 180 window running `code`.
fn open(cx: &mut HeadlessAppContext, code: &str) -> gpui::WindowHandle<AppView> {
    let window = cx
        .open_window(size(px(240.0), px(180.0)), |window, cx| {
            cx.new(|cx| AppView::new(AppOptions::default(), window, cx))
        })
        .unwrap();
    let code = nsh_bundler::compile_module("App.tsx", code, &[]).unwrap();
    cx.update(|cx| {
        window
            .update(cx, |view, _, _| view.load(App::Js(Bundle::source(code))))
            .unwrap()
    });
    window
}

/// Draws a frame of `window`; how long drawing took.
fn draw(cx: &mut HeadlessAppContext, window: gpui::WindowHandle<AppView>) -> Duration {
    cx.run_until_parked();
    cx.update_window(window.into(), |_, window, cx| {
        window.refresh();
        let start = Instant::now();
        window.draw(cx).clear(cx);
        start.elapsed()
    })
    .unwrap()
}

/// Runs `code` until a frame shows what `expected` says (the screenshot is
/// saved as `nsh-<name>.png` in the temporary directory when none does).
fn shows(
    cx: &mut HeadlessAppContext,
    code: &str,
    expected: &[((f32, f32), [u8; 3], &str)],
    name: &str,
) {
    let window = open(cx, code);
    let start = Instant::now();
    loop {
        draw(cx, window);
        let shot = cx.capture_screenshot(window.into()).unwrap();
        let scale = shot.width() as f32 / 240.0;
        let wrong: Vec<String> = expected
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
            let path = std::env::temp_dir().join(format!("nsh-{name}.png"));
            shot.save(&path).unwrap();
            panic!("{} (screenshot: {})", wrong.join("; "), path.display());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// What drawing costs while the zoom changes every 16 ms (a new scale,
/// so new glyph sizes, nearly every frame), against the same content at
/// rest: `NSH_RENDER_BENCH=1`.
fn zoom_frames(cx: &mut HeadlessAppContext) {
    for (steps, what) in [(false, "at rest, 2x"), (true, "zooming")] {
        let window = open(cx, &zoom_app(true, steps));
        let warm = Instant::now();
        while warm.elapsed() < Duration::from_secs(2) {
            draw(cx, window);
            std::thread::sleep(Duration::from_millis(8));
        }
        let mut times = Vec::new();
        let mut changed = 0;
        let mut last = cx.capture_screenshot(window.into()).unwrap();
        while times.len() < 240 {
            times.push(draw(cx, window).as_secs_f64() * 1e3);
            if times.len() % 20 == 0 {
                let shot = cx.capture_screenshot(window.into()).unwrap();
                changed += usize::from(shot != last);
                last = shot;
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        times.sort_by(f64::total_cmp);
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        println!(
            "render: {what}: mean {mean:.2} ms, median {:.2} ms, p95 {:.2} ms, max {:.2} ms a frame ({changed} of 12 samples changed)",
            times[times.len() / 2],
            times[times.len() * 95 / 100],
            times[times.len() - 1],
        );
    }
}
