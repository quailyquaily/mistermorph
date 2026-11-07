//! Files the user picked (`morph.file.pick`), their uploads (`morph.file.upload`) and saves
//! (`morph.file.save`). As in the browser, a picked file's bytes stay here: the app holds an id.
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct Picked {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

impl Picked {
    pub fn describe(path: &Path) -> std::io::Result<Picked> {
        let meta = std::fs::metadata(path)?;
        Ok(Picked {
            path: path.to_path_buf(),
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            size: meta.len(),
            mime: mime_guess::from_path(path).first_raw().unwrap_or("").to_owned(),
        })
    }

    /// The app's `PickedFile`: images get a `file://` preview an `Image` can show.
    pub fn to_json(&self, id: &str) -> Value {
        let preview = if self.mime.starts_with("image/") {
            url::Url::from_file_path(&self.path).map(String::from).unwrap_or_default()
        } else {
            String::new()
        };
        json!({ "id": id, "name": self.name, "size": self.size, "type": self.mime, "preview": preview })
    }
}

/// The files the app holds ids of.
#[derive(Default)]
pub struct Registry {
    next: u64,
    files: HashMap<String, Picked>,
}

impl Registry {
    pub fn add(&mut self, picked: Picked) -> String {
        self.next += 1;
        let id = self.next.to_string();
        self.files.insert(id.clone(), picked);
        id
    }

    pub fn get(&self, id: &str) -> Option<Picked> {
        self.files.get(id).cloned()
    }

    pub fn release(&mut self, id: &str) {
        self.files.remove(id);
    }
}

/// Whether `name` (or its type) is one `accept` (`image/*,.pdf`) lets through; an empty
/// `accept` takes everything.
pub fn accepts(accept: &str, picked: &Picked) -> bool {
    let rules: Vec<String> = accept.split(',').map(|r| r.trim().to_lowercase()).filter(|r| !r.is_empty()).collect();
    if rules.is_empty() {
        return true;
    }
    let name = picked.name.to_lowercase();
    let mime = picked.mime.to_lowercase();
    rules.iter().any(|rule| {
        if rule.starts_with('.') {
            name.ends_with(rule.as_str())
        } else if let Some(prefix) = rule.strip_suffix("/*") {
            mime.starts_with(&format!("{prefix}/"))
        } else {
            &mime == rule
        }
    })
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct UploadRequest {
    pub id: String,
    pub url: String,
    pub method: Option<String>,
    pub headers: HashMap<String, String>,
    pub field: String,
    pub fields: HashMap<String, String>,
    /// Send the image cropped, scaled and re-encoded instead of the file (an avatar).
    pub image: Option<ImageTarget>,
}

#[derive(Debug, Deserialize, Clone, Copy, Default, PartialEq)]
#[serde(default)]
pub struct Crop {
    pub sx: f64,
    pub sy: f64,
    pub sw: f64,
    pub sh: f64,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct ImageTarget {
    /// The rectangle to keep, in the source image's pixels (after its EXIF orientation, as a
    /// browser draws it).
    pub crop: Crop,
    pub width: u32,
    pub height: u32,
    /// `image/webp` (lossless here: the `image` crate has no lossy WebP encoder), `image/png`
    /// or `image/jpeg`.
    #[serde(rename = "type")]
    pub mime: String,
    /// 0..1, for JPEG.
    pub quality: f64,
}

/// The picked image cropped to `target.crop`, scaled to `target.width`×`target.height` and encoded
/// as `target.mime` (host.js's `encodeImage`).
pub fn encode_image(path: &Path, target: &ImageTarget) -> Result<Vec<u8>, String> {
    use image::{ImageDecoder, ImageReader, imageops::FilterType};
    if target.width == 0 || target.height == 0 {
        return Err("the image size is empty".to_owned());
    }
    let mut decoder = ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| format!("read the image: {e}"))?
        .into_decoder()
        .map_err(|e| format!("read the image: {e}"))?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut source = image::DynamicImage::from_decoder(decoder).map_err(|e| format!("read the image: {e}"))?;
    source.apply_orientation(orientation);
    let (w, h) = (source.width() as f64, source.height() as f64);
    let Crop { sx, sy, sw, sh } = target.crop;
    let x0 = sx.max(0.0).min(w);
    let y0 = sy.max(0.0).min(h);
    let x1 = (sx + sw).max(0.0).min(w);
    let y1 = (sy + sh).max(0.0).min(h);
    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return Err("the crop is outside the image".to_owned());
    }
    let cropped = source.crop_imm(x0.round() as u32, y0.round() as u32, (x1 - x0).round().max(1.0) as u32, (y1 - y0).round().max(1.0) as u32);
    let scaled = cropped.resize_exact(target.width, target.height, FilterType::Lanczos3);
    let mut out = Vec::new();
    match target.mime.as_str() {
        "image/webp" => scaled
            .to_rgba8()
            .write_with_encoder(image::codecs::webp::WebPEncoder::new_lossless(&mut out)),
        "image/png" => scaled.to_rgba8().write_with_encoder(image::codecs::png::PngEncoder::new(&mut out)),
        "image/jpeg" => {
            let quality = if target.quality > 0.0 { (target.quality.min(1.0) * 100.0).round() as u8 } else { 92 };
            scaled
                .to_rgb8()
                .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.max(1)))
        }
        other => return Err(format!("cannot encode {other}")),
    }
    .map_err(|e| format!("encode the image: {e}"))?;
    Ok(out)
}

/// `.webp` for `image/webp`, `.jpg` for `image/jpeg` (host.js's `extensionOf`).
fn extension_of(mime: &str) -> String {
    let sub = mime.split('/').nth(1).filter(|s| !s.is_empty()).unwrap_or("bin");
    format!(".{}", if sub == "jpeg" { "jpg" } else { sub })
}

fn renamed(name: &str, mime: &str) -> String {
    let stem = match name.rfind('.') {
        Some(dot) => &name[..dot],
        None => name,
    };
    format!("{stem}{}", extension_of(mime))
}

/// Counts what is read and reports it, at most every 50 ms and once at the end.
struct Progress<R, F> {
    inner: R,
    loaded: u64,
    total: u64,
    last: Instant,
    report: F,
}

impl<R: Read, F: FnMut(u64, u64)> Read for Progress<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.loaded += n as u64;
        if n == 0 || self.loaded == self.total || self.last.elapsed() >= Duration::from_millis(50) {
            self.last = Instant::now();
            (self.report)(self.loaded, self.total);
        }
        Ok(n)
    }
}

/// `"` and line breaks in a form field's name, as browsers write them.
fn quote(value: &str) -> String {
    value.replace('"', "%22").replace('\r', "%0D").replace('\n', "%0A")
}

/// The multipart body around the file: what comes before it and after it, and its boundary.
pub fn multipart_frame(field: &str, fields: &[(String, String)], picked: &Picked, boundary: &str) -> (Vec<u8>, Vec<u8>) {
    let mut head = String::new();
    for (name, value) in fields {
        head.push_str(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{value}\r\n", quote(name)));
    }
    let mime = if picked.mime.is_empty() { "application/octet-stream" } else { &picked.mime };
    head.push_str(&format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {mime}\r\n\r\n",
        quote(field),
        quote(&picked.name)
    ));
    (head.into_bytes(), format!("\r\n--{boundary}--\r\n").into_bytes())
}

fn boundary() -> String {
    use sha2::{Digest, Sha256};
    let seed = format!("{:?}{}{:?}", Instant::now(), std::process::id(), std::thread::current().id());
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let digest = Sha256::digest(format!("{seed}{nanos}"));
    format!("----MisterMorphFormBoundary{}", &hex::encode(digest)[..24])
}

/// Sends the file to `request.url` (relative URLs go to the backend): multipart under
/// `request.field`, or as the body. The app's `UploadResult`.
pub fn upload(picked: &Picked, request: &UploadRequest, origin: &str, report: impl FnMut(u64, u64) + Send + 'static) -> Result<Value, String> {
    let url = crate::http::resolve(origin, &request.url);
    let method = request.method.clone().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "POST".to_owned());
    // What is sent: the file, or the image re-encoded.
    let (sent, source): (Picked, Box<dyn Read + Send>) = match &request.image {
        Some(target) => {
            let bytes = encode_image(&picked.path, target)?;
            let sent = Picked { path: picked.path.clone(), name: renamed(&picked.name, &target.mime), size: bytes.len() as u64, mime: target.mime.clone() };
            (sent, Box::new(Cursor::new(bytes)))
        }
        None => {
            let file = std::fs::File::open(&picked.path).map_err(|e| format!("the file is gone: {e}"))?;
            (picked.clone(), Box::new(file))
        }
    };
    let has_type = request.headers.keys().any(|k| k.eq_ignore_ascii_case("content-type"));
    let mut builder = ureq::http::Request::builder().method(method.to_uppercase().as_str()).uri(&url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    let (reader, total): (Box<dyn Read + Send>, u64) = if request.field.is_empty() {
        if !has_type && !sent.mime.is_empty() {
            builder = builder.header("Content-Type", &sent.mime);
        }
        (source, sent.size)
    } else {
        let mut fields: Vec<(String, String)> = request.fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        fields.sort();
        let boundary = boundary();
        let (head, tail) = multipart_frame(&request.field, &fields, &sent, &boundary);
        let total = head.len() as u64 + sent.size + tail.len() as u64;
        builder = builder.header("Content-Type", format!("multipart/form-data; boundary={boundary}"));
        (Box::new(Cursor::new(head).chain(source).chain(Cursor::new(tail))), total)
    };
    let body = Progress { inner: reader, loaded: 0, total, last: Instant::now(), report };
    let request = builder
        .body(ureq::SendBody::from_owned_reader(body))
        .map_err(|e| format!("upload failed: {e}"))?;
    let mut response = crate::http::agent(None).run(request).map_err(|e| format!("upload failed: {e}"))?;
    let status = response.status();
    let body = response
        .body_mut()
        .with_config()
        .limit(64 << 20)
        .read_to_vec()
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "statusText": status.canonical_reason().unwrap_or(""),
        "body": String::from_utf8_lossy(&body),
    }))
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct SaveRequest {
    pub name: String,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    pub text: Option<String>,
    pub base64: Option<String>,
    #[serde(rename = "type")]
    pub mime: Option<String>,
}

/// The bytes to save: the text, the decoded base64, or what the URL answers.
pub fn save_bytes(request: &SaveRequest, origin: &str) -> Result<Vec<u8>, String> {
    if let Some(text) = &request.text {
        return Ok(text.clone().into_bytes());
    }
    if let Some(data) = &request.base64 {
        return base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| format!("decode base64: {e}"));
    }
    let Some(url) = request.url.as_deref().filter(|u| !u.trim().is_empty()) else {
        return Err("nothing to save".to_owned());
    };
    let url = crate::http::resolve(origin, url);
    let mut call = crate::http::agent(None).get(&url).header("Cache-Control", "no-store");
    for (name, value) in &request.headers {
        call = call.header(name, value);
    }
    let mut response = call.call().map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    response.body_mut().with_config().limit(1 << 30).read_to_vec().map_err(|e| e.to_string())
}

/// The name a save dialog suggests.
pub fn suggested_name(name: &str) -> String {
    let name = name.trim().replace(['/', '\\'], "_");
    if name.is_empty() { "download".to_owned() } else { name }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("morph-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn describes_and_registers_files() {
        let path = temp_file("photo.png", b"png!");
        let picked = Picked::describe(&path).unwrap();
        assert_eq!((picked.name.as_str(), picked.size, picked.mime.as_str()), ("photo.png", 4, "image/png"));
        let mut registry = Registry::default();
        let id = registry.add(picked.clone());
        let json = registry.get(&id).unwrap().to_json(&id);
        assert_eq!(json["type"], "image/png");
        assert!(json["preview"].as_str().unwrap().starts_with("file:///"));
        registry.release(&id);
        assert!(registry.get(&id).is_none());
        let text = Picked::describe(&temp_file("notes.zzz", b"")).unwrap();
        assert_eq!(text.to_json("2")["preview"], "");
        assert_eq!(text.mime, "");
    }

    #[test]
    fn filters_by_accept() {
        let png = Picked { path: "a.png".into(), name: "A.PNG".into(), size: 0, mime: "image/png".into() };
        assert!(accepts("", &png));
        assert!(accepts("image/*", &png));
        assert!(accepts(".pdf, .png", &png));
        assert!(accepts("image/png", &png));
        assert!(!accepts("application/pdf,.pdf", &png));
    }

    #[test]
    fn frames_multipart_bodies() {
        let picked = Picked { path: "x".into(), name: "a\"b.txt".into(), size: 3, mime: String::new() };
        let (head, tail) = multipart_frame("file", &[("topic".into(), "t1".into())], &picked, "BOUND");
        let head = String::from_utf8(head).unwrap();
        assert!(head.starts_with("--BOUND\r\nContent-Disposition: form-data; name=\"topic\"\r\n\r\nt1\r\n"));
        assert!(head.contains("name=\"file\"; filename=\"a%22b.txt\"\r\nContent-Type: application/octet-stream\r\n\r\n"));
        assert_eq!(tail, b"\r\n--BOUND--\r\n");
    }

    /// One HTTP exchange: the request it got (head and de-chunked body), then a 201.
    fn serve_once() -> (String, std::thread::JoinHandle<(String, Vec<u8>)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let mut body = Vec::new();
            let lower = head.to_lowercase();
            if lower.contains("transfer-encoding: chunked") {
                loop {
                    let mut size = String::new();
                    reader.read_line(&mut size).unwrap();
                    let n = usize::from_str_radix(size.trim(), 16).unwrap();
                    let mut chunk = vec![0; n + 2];
                    reader.read_exact(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..n]);
                }
            } else if let Some(len) = lower.lines().find_map(|l| l.strip_prefix("content-length: ")) {
                let mut buf = vec![0; len.trim().parse().unwrap()];
                reader.read_exact(&mut buf).unwrap();
                body = buf;
            }
            let mut stream = stream;
            stream.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
            (head, body)
        });
        (origin, handle)
    }

    #[test]
    fn uploads_multipart_with_progress() {
        let content = vec![b'x'; 200_000];
        let picked = Picked::describe(&temp_file("big.txt", &content)).unwrap();
        let (origin, server) = serve_once();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let request = UploadRequest {
            url: "/api/files".into(),
            field: "file".into(),
            fields: [("topic_id".to_owned(), "t9".to_owned())].into(),
            headers: [("Authorization".to_owned(), "Bearer k".to_owned())].into(),
            ..Default::default()
        };
        let result = upload(&picked, &request, &origin, move |loaded, total| sink.lock().unwrap().push((loaded, total))).unwrap();
        assert_eq!(result["status"], 201);
        assert_eq!(result["ok"], true);
        assert_eq!(result["statusText"], "Created");
        assert_eq!(result["body"], "ok");
        let (head, body) = server.join().unwrap();
        assert!(head.starts_with("POST /api/files HTTP/1.1"), "{head}");
        assert!(head.contains("authorization: Bearer k") || head.contains("Authorization: Bearer k"), "{head}");
        assert!(head.to_lowercase().contains("content-type: multipart/form-data; boundary=----mistermorphformboundary"));
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"topic_id\"\r\n\r\nt9\r\n"));
        assert!(text.contains("filename=\"big.txt\"\r\nContent-Type: text/plain\r\n\r\n"));
        let seen = seen.lock().unwrap();
        let (loaded, total) = *seen.last().unwrap();
        assert_eq!(loaded, total);
        assert_eq!(total, body.len() as u64);
    }

    #[test]
    fn uploads_a_raw_body() {
        let picked = Picked::describe(&temp_file("raw.json", b"{\"a\":1}")).unwrap();
        let (origin, server) = serve_once();
        let request = UploadRequest { url: format!("{origin}/put"), method: Some("put".into()), ..Default::default() };
        let result = upload(&picked, &request, "http://unused", |_, _| {}).unwrap();
        assert_eq!(result["status"], 201);
        let (head, body) = server.join().unwrap();
        assert!(head.starts_with("PUT /put HTTP/1.1"), "{head}");
        assert!(head.to_lowercase().contains("content-type: application/json"));
        assert_eq!(body, b"{\"a\":1}");
    }

    #[test]
    fn saves_text_base64_and_urls() {
        let text = SaveRequest { text: Some("hi".into()), ..Default::default() };
        assert_eq!(save_bytes(&text, "").unwrap(), b"hi");
        let b64 = SaveRequest { base64: Some("aGk=".into()), ..Default::default() };
        assert_eq!(save_bytes(&b64, "").unwrap(), b"hi");
        assert_eq!(save_bytes(&SaveRequest::default(), "").unwrap_err(), "nothing to save");
        let (origin, server) = serve_once();
        let from_url = SaveRequest { url: Some("/export".into()), headers: [("X-K".to_owned(), "1".to_owned())].into(), ..Default::default() };
        assert_eq!(save_bytes(&from_url, &origin).unwrap(), b"ok");
        let (head, _) = server.join().unwrap();
        assert!(head.starts_with("GET /export HTTP/1.1"));
        assert_eq!(suggested_name(" a/b "), "a_b");
        assert_eq!(suggested_name(""), "download");
    }

    #[test]
    fn crops_scales_and_encodes_images() {
        let path = std::env::temp_dir().join(format!("morph-files-{}/src.png", std::process::id()));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // 40×20: left half red, right half blue.
        let img = image::RgbaImage::from_fn(40, 20, |x, _| if x < 20 { image::Rgba([255, 0, 0, 255]) } else { image::Rgba([0, 0, 255, 255]) });
        img.save(&path).unwrap();
        let target = ImageTarget { crop: Crop { sx: 20.0, sy: 0.0, sw: 20.0, sh: 20.0 }, width: 8, height: 8, mime: "image/webp".into(), quality: 0.9 };
        let webp = encode_image(&path, &target).unwrap();
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        let back = image::load_from_memory(&webp).unwrap().to_rgba8();
        assert_eq!(back.dimensions(), (8, 8));
        assert_eq!(back.get_pixel(4, 4).0, [0, 0, 255, 255]);
        let jpeg = encode_image(&path, &ImageTarget { mime: "image/jpeg".into(), ..target.clone() }).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        assert!(encode_image(&path, &ImageTarget { mime: "image/avif".into(), ..target.clone() }).is_err());
        let outside = ImageTarget { crop: Crop { sx: 50.0, sy: 0.0, sw: 5.0, sh: 5.0 }, ..target.clone() };
        assert!(encode_image(&path, &outside).unwrap_err().contains("outside"));
        assert_eq!(renamed("me.photo.png", "image/webp"), "me.photo.webp");
        assert_eq!(renamed("me", "image/jpeg"), "me.jpg");
    }

    #[test]
    fn uploads_an_encoded_avatar() {
        let path = std::env::temp_dir().join(format!("morph-files-{}/avatar.png", std::process::id()));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::RgbaImage::from_pixel(30, 30, image::Rgba([10, 200, 10, 255])).save(&path).unwrap();
        let picked = Picked::describe(&path).unwrap();
        let (origin, server) = serve_once();
        let request = UploadRequest {
            url: "/avatar".into(),
            field: "file".into(),
            image: Some(ImageTarget { crop: Crop { sx: 0.0, sy: 0.0, sw: 30.0, sh: 30.0 }, width: 16, height: 16, mime: "image/webp".into(), quality: 0.9 }),
            ..Default::default()
        };
        let result = upload(&picked, &request, &origin, |_, _| {}).unwrap();
        assert_eq!(result["status"], 201);
        let (_, body) = server.join().unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("filename=\"avatar.webp\"\r\nContent-Type: image/webp\r\n\r\nRIFF"), "{text}");
    }
}
