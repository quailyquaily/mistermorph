//! Keeps the network proxy's password out of the desktop log and the startup diagnostics.
//!
//! While an explicit proxy with a password is running, the backend's environment holds the proxy
//! URL with that password, and the backend's output is copied into `desktop.log`. This filter
//! replaces the forms the password is known to take: as typed, percent-encoded, as the
//! `user:password@` part of a proxy URL, and as the Base64 of `user:password` (the value of a
//! `Proxy-Authorization: Basic` header). It is a second line of defense for these forms, not a
//! promise about arbitrary output.
use std::sync::Arc;

use base64::Engine;

const MASK: &[u8] = b"[redacted]";
const MASK_USERINFO: &[u8] = b"[redacted]@";
/// An unfinished line is held back up to this size; a longer one is written in parts.
const MAX_HELD: usize = 64 << 10;

#[derive(Clone, Default)]
pub struct Redactor {
    /// What to replace and with what, longest first.
    needles: Arc<Vec<(Vec<u8>, &'static [u8])>>,
}

impl std::fmt::Debug for Redactor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Redactor({} forms)", self.needles.len())
    }
}

/// Percent-encodes all but the unreserved characters (`A-Z a-z 0-9 - . _ ~`): how the app writes
/// credentials into a proxy URL.
pub fn percent_encode(value: &str) -> String {
    encode(value, |b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'), false)
}

fn encode(value: &str, keep: impl Fn(u8) -> bool, plus_for_space: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if keep(byte) {
            out.push(byte as char);
        } else if plus_for_space && byte == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The spellings a credential part can take in a URL: as typed, the app's own encoding, Go's
/// user-info encoding (which leaves `$&+,;=` alone) and Go's query encoding (a space as `+`),
/// each with upper- and lower-case hex digits.
fn spellings(value: &str) -> Vec<String> {
    let unreserved = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
    let mut out = vec![
        value.to_owned(),
        percent_encode(value),
        encode(value, |b| unreserved(b) || matches!(b, b'$' | b'&' | b'+' | b',' | b';' | b'='), false),
        encode(value, unreserved, true),
    ];
    let lower: Vec<String> = out.iter().map(|s| lower_hex(s)).collect();
    out.extend(lower);
    out.sort();
    out.dedup();
    out
}

/// `%2F` as `%2f`: only the two digits after a `%` change.
fn lower_hex(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(b'%');
            out.push(bytes[i + 1].to_ascii_lowercase());
            out.push(bytes[i + 2].to_ascii_lowercase());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| encoded.to_owned())
}

impl Redactor {
    /// A filter that changes nothing.
    pub fn none() -> Redactor {
        Redactor::default()
    }

    /// The filter for a proxy's credentials; it changes nothing when there is no password.
    pub fn for_credentials(username: &str, password: &str) -> Redactor {
        if password.is_empty() {
            return Redactor::none();
        }
        let mut needles: Vec<(Vec<u8>, &'static [u8])> = Vec::new();
        let passwords = spellings(password);
        for user in spellings(username) {
            for pass in &passwords {
                needles.push((format!("{user}:{pass}@").into_bytes(), MASK_USERINFO));
            }
        }
        for pass in &passwords {
            needles.push((pass.clone().into_bytes(), MASK));
        }
        let pair = format!("{username}:{password}");
        for engine in [
            &base64::engine::general_purpose::STANDARD,
            &base64::engine::general_purpose::STANDARD_NO_PAD,
            &base64::engine::general_purpose::URL_SAFE,
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        ] {
            needles.push((engine.encode(&pair).into_bytes(), MASK));
        }
        needles.retain(|(needle, _)| !needle.is_empty());
        needles.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        needles.dedup_by(|a, b| a.0 == b.0);
        Redactor { needles: Arc::new(needles) }
    }

    pub fn is_active(&self) -> bool {
        !self.needles.is_empty()
    }

    fn longest(&self) -> usize {
        self.needles.first().map_or(0, |(needle, _)| needle.len())
    }

    /// The needle that starts at `at`, the longest one.
    fn matching(&self, bytes: &[u8], at: usize) -> Option<(usize, &'static [u8])> {
        self.needles
            .iter()
            .find(|(needle, _)| bytes[at..].starts_with(needle))
            .map(|(needle, mask)| (needle.len(), *mask))
    }

    /// `bytes` with every known form replaced.
    pub fn bytes(&self, bytes: &[u8]) -> Vec<u8> {
        if !self.is_active() {
            return bytes.to_vec();
        }
        let mut out = Vec::with_capacity(bytes.len());
        let mut at = 0;
        while at < bytes.len() {
            match self.matching(bytes, at) {
                Some((len, mask)) => {
                    out.extend_from_slice(mask);
                    at += len;
                }
                None => {
                    out.push(bytes[at]);
                    at += 1;
                }
            }
        }
        out
    }

    /// `text` with every known form replaced.
    pub fn text(&self, text: &str) -> String {
        if !self.is_active() {
            return text.to_owned();
        }
        String::from_utf8_lossy(&self.bytes(text.as_bytes())).into_owned()
    }

    /// A filter for a stream read in chunks: a secret split across two reads is still found.
    pub fn lines(&self) -> LineRedactor {
        LineRedactor { redactor: self.clone(), held: Vec::new() }
    }
}

/// Redacts a stream on whole lines: an unfinished line waits for its end.
pub struct LineRedactor {
    redactor: Redactor,
    held: Vec<u8>,
}

impl LineRedactor {
    /// Takes the next chunk and returns what can be written now.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        if !self.redactor.is_active() {
            return chunk.to_vec();
        }
        self.held.extend_from_slice(chunk);
        let mut cut = self.held.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        if self.held.len() - cut > MAX_HELD {
            // A line longer than the limit: write all of it but a tail as long as the longest
            // form, where the start of a secret may be waiting for its rest.
            cut = self.held.len() - self.redactor.longest().saturating_sub(1).min(self.held.len());
            // A secret that is whole and lies across the cut stays together.
            let mut at = 0;
            while at < self.held.len() {
                match self.redactor.matching(&self.held, at) {
                    Some((len, _)) => {
                        if at < cut && cut < at + len {
                            cut = at;
                            break;
                        }
                        at += len;
                    }
                    None => at += 1,
                }
            }
        }
        if cut == 0 {
            return Vec::new();
        }
        let ready: Vec<u8> = self.held.drain(..cut).collect();
        self.redactor.bytes(&ready)
    }

    /// The end of the stream: what was still held.
    pub fn finish(&mut self) -> Vec<u8> {
        let rest = std::mem::take(&mut self.held);
        self.redactor.bytes(&rest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "mo rph@x";
    const SECRET: &str = "S3ntinel p@ss:w%rd/+&=";

    fn forms() -> Vec<String> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(format!("{USER}:{SECRET}"));
        vec![
            SECRET.to_owned(),
            percent_encode(SECRET),
            format!("http://{}:{}@127.0.0.1:8080", percent_encode(USER), percent_encode(SECRET)),
            format!("Proxy-Authorization: Basic {b64}"),
            // As Go prints a parsed proxy URL.
            "socks5://mo%20rph%40x:S3ntinel%20p%40ss%3Aw%25rd%2F+&=@127.0.0.1:1080".to_owned(),
            lower_hex(&percent_encode(SECRET)),
        ]
    }

    fn leaks(text: &str) -> bool {
        let b64 = base64::engine::general_purpose::STANDARD.encode(format!("{USER}:{SECRET}"));
        text.contains(SECRET)
            || text.contains(&percent_encode(SECRET))
            || text.contains("S3ntinel")
            || text.contains(&b64)
            || text.contains("w%25rd")
            || text.contains("w%rd")
    }

    #[test]
    fn replaces_every_known_form() {
        let redactor = Redactor::for_credentials(USER, SECRET);
        assert!(redactor.is_active());
        for form in forms() {
            let line = format!("level=error msg=\"dial failed\" detail={form} end");
            let out = redactor.text(&line);
            assert!(!leaks(&out), "{form} leaked: {out}");
            assert!(out.contains("[redacted]"), "{out}");
            assert!(out.starts_with("level=error") && out.ends_with(" end"), "{out}");
        }
        // The user-info part goes as a whole, the host stays.
        let url = format!("http://{}:{}@127.0.0.1:8080/x", percent_encode(USER), percent_encode(SECRET));
        assert_eq!(redactor.text(&url), "http://[redacted]@127.0.0.1:8080/x");
    }

    #[test]
    fn without_a_password_nothing_changes() {
        let redactor = Redactor::for_credentials("user", "");
        assert!(!redactor.is_active());
        assert_eq!(redactor.text("user: a b"), "user: a b");
        let mut lines = redactor.lines();
        assert_eq!(lines.push(b"half a line"), b"half a line");
        assert!(lines.finish().is_empty());
        assert!(!Redactor::none().is_active());
    }

    #[test]
    fn finds_a_secret_split_across_reads() {
        let redactor = Redactor::for_credentials(USER, SECRET);
        for form in forms() {
            let line = format!("before {form} after\n");
            let bytes = line.as_bytes();
            // Every split point, the ones inside the secret included.
            for split in 1..bytes.len() {
                let mut lines = redactor.lines();
                let mut out = lines.push(&bytes[..split]);
                out.extend(lines.push(&bytes[split..]));
                out.extend(lines.finish());
                let out = String::from_utf8(out).unwrap();
                assert!(!leaks(&out), "split {split} of {form} leaked: {out}");
                assert!(out.starts_with("before ") && out.ends_with(" after\n"), "{out}");
            }
        }
    }

    #[test]
    fn holds_an_unfinished_line_and_ends_the_stream() {
        let redactor = Redactor::for_credentials(USER, SECRET);
        let mut lines = redactor.lines();
        assert_eq!(lines.push(b"one\ntwo "), b"one\n");
        assert_eq!(lines.push(b"three\n"), b"two three\n");
        assert!(lines.push(b"no newline S3ntinel").is_empty());
        let rest = String::from_utf8(lines.finish()).unwrap();
        assert_eq!(rest, "no newline S3ntinel", "a part of the password alone is not a known form");
        let mut lines = redactor.lines();
        assert!(lines.push(SECRET.as_bytes()).is_empty());
        assert_eq!(lines.finish(), b"[redacted]");
    }

    #[test]
    fn redacts_a_line_longer_than_one_read() {
        let redactor = Redactor::for_credentials(USER, SECRET);
        // One line of several hundred kilobytes with the secret at many offsets, read 8 KB at a
        // time as the backend's output is.
        let mut line = Vec::new();
        let mut filler = 0usize;
        while line.len() < 400 << 10 {
            filler += 1;
            line.extend(std::iter::repeat_n(b'x', 1000 + filler * 37 % 911));
            line.extend_from_slice(SECRET.as_bytes());
        }
        line.push(b'\n');
        let mut lines = redactor.lines();
        let mut out = Vec::new();
        let mut written_before_end = 0;
        for chunk in line.chunks(8192) {
            let part = lines.push(chunk);
            written_before_end += part.len();
            out.extend(part);
        }
        out.extend(lines.finish());
        let out = String::from_utf8(out).unwrap();
        assert!(!leaks(&out));
        assert!(written_before_end > 0, "a long line is not held in memory whole");
        assert_eq!(out.matches("[redacted]").count(), filler);
        assert!(out.ends_with('\n'));
    }
}
