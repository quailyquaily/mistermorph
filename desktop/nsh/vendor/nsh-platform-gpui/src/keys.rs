//! Keys: GPUI's keystrokes as the virtual key codes ([`crate::input::KeyEvent::vk`],
//! Windows' `VK_*` values) the input, scrolling, keymap and editing code
//! shared with the Windows backend work with, and as the raw logical keys
//! a focused view hears ([`RawKey`], `on_key_down` / `on_key_up`).
//!
//! GPUI's platform code resolves a key to the character it types on the
//! user's layout (`Keystroke::key`, lower case for letters, and
//! `Keystroke::key_char` for what the key actually types with Shift and
//! AltGr), and exposes neither a scan code nor a key position. So a
//! [`RawKey`] reports the logical key GPUI names and no `code` at all
//! (there is no physical identity to report), its repeats are only the
//! ones the platform marks (`KeyDownEvent::is_held`), and its releases are
//! only the ones the platform sends (X11 may drop them, and GPUI never
//! delivers a modifier key's own down or up).

use nsh_core::{
    element::SharedString,
    keymap::{Key as ShortcutKey, Keystroke, Modifiers as KeyModifiers},
    platform::Os,
};

/// `VK_BACK`.
pub(crate) const VK_BACK: u16 = 0x08;
/// `VK_TAB`.
pub(crate) const VK_TAB: u16 = 0x09;
/// `VK_RETURN`.
pub(crate) const VK_RETURN: u16 = 0x0D;
/// `VK_SHIFT`.
pub(crate) const VK_SHIFT: u16 = 0x10;
/// `VK_CONTROL`.
pub(crate) const VK_CONTROL: u16 = 0x11;
/// `VK_MENU` (Alt).
pub(crate) const VK_MENU: u16 = 0x12;
/// `VK_ESCAPE`.
pub(crate) const VK_ESCAPE: u16 = 0x1B;
/// `VK_SPACE`.
pub(crate) const VK_SPACE: u16 = 0x20;
/// `VK_PRIOR` (Page Up).
pub(crate) const VK_PRIOR: u16 = 0x21;
/// `VK_NEXT` (Page Down).
pub(crate) const VK_NEXT: u16 = 0x22;
/// `VK_END`.
pub(crate) const VK_END: u16 = 0x23;
/// `VK_HOME`.
pub(crate) const VK_HOME: u16 = 0x24;
/// `VK_LEFT`.
pub(crate) const VK_LEFT: u16 = 0x25;
/// `VK_UP`.
pub(crate) const VK_UP: u16 = 0x26;
/// `VK_RIGHT`.
pub(crate) const VK_RIGHT: u16 = 0x27;
/// `VK_DOWN`.
pub(crate) const VK_DOWN: u16 = 0x28;
/// `VK_INSERT`.
pub(crate) const VK_INSERT: u16 = 0x2D;
/// `VK_DELETE`.
pub(crate) const VK_DELETE: u16 = 0x2E;
/// `VK_LWIN` (the Windows / Command / Super key).
pub(crate) const VK_LWIN: u16 = 0x5B;
/// `VK_BROWSER_BACK`.
pub(crate) const VK_BROWSER_BACK: u16 = 0xA6;

/// The virtual key code of GPUI key name `key` (`Keystroke::key`), or
/// `None` for keys nsh does not use.
pub(crate) fn vk_of(key: &str) -> Option<u16> {
    Some(match key {
        "backspace" => VK_BACK,
        "tab" => VK_TAB,
        "enter" => VK_RETURN,
        "shift" => VK_SHIFT,
        "control" => VK_CONTROL,
        "alt" => VK_MENU,
        "platform" | "cmd" | "super" | "win" => VK_LWIN,
        "escape" => VK_ESCAPE,
        "space" => VK_SPACE,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "end" => VK_END,
        "home" => VK_HOME,
        "left" => VK_LEFT,
        "up" => VK_UP,
        "right" => VK_RIGHT,
        "down" => VK_DOWN,
        "insert" => VK_INSERT,
        "delete" => VK_DELETE,
        "back" => VK_BROWSER_BACK,
        ";" => 0xBA,
        "=" => 0xBB,
        "," => 0xBC,
        "-" => 0xBD,
        "." => 0xBE,
        "/" => 0xBF,
        "`" => 0xC0,
        "[" => 0xDB,
        "\\" => 0xDC,
        "]" => 0xDD,
        "'" => 0xDE,
        _ => {
            if let Some(n) = key.strip_prefix('f').and_then(|n| n.parse::<u16>().ok())
                && (1..=24).contains(&n)
            {
                return Some(0x6F + n);
            }
            let mut chars = key.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            match c {
                '0'..='9' => c as u16,
                'a'..='z' => c.to_ascii_uppercase() as u16,
                'A'..='Z' => c as u16,
                _ => return None,
            }
        }
    })
}

/// GPUI's modifiers as the input code's.
pub(crate) fn modifiers(m: &gpui::Modifiers) -> crate::input::Modifiers {
    crate::input::Modifiers {
        shift: m.shift,
        ctrl: m.control,
        alt: m.alt,
        meta: m.platform,
    }
}

/// GPUI's modifiers as the keymap's (the raw key events').
pub(crate) fn key_modifiers(m: &gpui::Modifiers) -> KeyModifiers {
    KeyModifiers {
        shift: m.shift,
        ctrl: m.control,
        alt: m.alt,
        cmd: m.platform,
    }
}

/// The platform keys and bindings are read for.
pub(crate) const OS: Os = if cfg!(target_os = "macos") {
    Os::MacOs
} else if cfg!(windows) {
    Os::Windows
} else {
    Os::Linux
};

/// A key as GPUI's platform reported it, for the raw key notifications of
/// the focused view (`on_key_down` / `on_key_up`): the logical key and the
/// modifiers it came with.
///
/// The key is GPUI's own name for it, in the web's spelling where both
/// name a key alike (`Enter`, `ArrowLeft`), or the character it types as
/// the platform reported it (`A` for Shift+A, the layout's `é`): it is
/// never mapped onto another layout's key, and its case is the source's.
/// There is no `code`: GPUI's public API exposes no scan code or key
/// position, so the event reports the empty DOM code rather than guessing
/// one from the logical key.
///
/// Alongside it, [`RawKey::stroke`] is the source's own key in the
/// keymap's spelling, for capture rules and for app bindings of a key
/// that has no virtual key code: matching only, never the reported
/// payload. It comes from GPUI's key (what the key is on the layout, and
/// lower case for letters), not from the character it types (Caps Lock's
/// `A` is still the `a` key).
#[derive(Debug, Clone)]
pub(crate) struct RawKey {
    /// A key down (else the key was released).
    pub(crate) down: bool,
    /// The key's name, as reported (above).
    key: SharedString,
    /// The modifiers held, as reported.
    modifiers: KeyModifiers,
    /// An auto-repeat the platform marked (never on X11's).
    repeat: bool,
    /// The key in the keymap's spelling, for matching ([`source_stroke`]).
    stroke: Option<Keystroke>,
}

impl RawKey {
    /// The key down GPUI reported (`repeat`: `KeyDownEvent::is_held`).
    pub(crate) fn down(keystroke: &gpui::Keystroke, repeat: bool) -> Self {
        RawKey::new(keystroke, true, repeat)
    }

    /// The key up GPUI reported.
    pub(crate) fn up(keystroke: &gpui::Keystroke) -> Self {
        RawKey::new(keystroke, false, false)
    }

    /// The key a test step asked for (`nsh/test`'s `keyboard.press`): the
    /// step's explicit keystroke is the source, so the event and the
    /// stroke a capture rule matches are both that keystroke — the
    /// character it types on the US layout (Shift's), the web's name for
    /// a named key — with no hardware metadata (`code` stays empty).
    /// `down` is the transition the step generates; it marks no repeat.
    #[cfg(any(feature = "dev", test))]
    pub(crate) fn requested(keystroke: &Keystroke, down: bool) -> Self {
        let modifiers = keystroke.modifiers;
        let key = match keystroke.key {
            ShortcutKey::Char(c) => {
                let typed = if modifiers.shift {
                    nsh_core::keymap::shifted(c)
                } else {
                    c
                };
                SharedString::from(typed.to_string())
            }
            named => named_key(named),
        };
        RawKey {
            down,
            key,
            modifiers,
            repeat: false,
            stroke: Some(*keystroke),
        }
    }

    fn new(keystroke: &gpui::Keystroke, down: bool, repeat: bool) -> Self {
        let modifiers = key_modifiers(&keystroke.modifiers);
        let stroke = source_stroke(&keystroke.key, modifiers);
        RawKey {
            down,
            key: name(keystroke),
            modifiers,
            repeat,
            stroke,
        }
    }

    /// The source's key as a canonical shortcut keystroke
    /// ([`source_stroke`]): what a capture rule and an app binding match.
    /// `None` for a key no shortcut can name (a non-ASCII character, a
    /// key the keymap does not name), which only [`nsh_core::KeyCapture::All`]
    /// captures.
    pub(crate) fn stroke(&self) -> Option<&Keystroke> {
        self.stroke.as_ref()
    }

    /// The notification for the focused view, `default_prevented` the
    /// mounted capture policy's decision for this transition.
    pub(crate) fn event(&self, default_prevented: bool) -> nsh_core::KeyEvent {
        let mut event = nsh_core::KeyEvent::default();
        event.key = self.key.clone();
        // GPUI's public API exposes no scan code, key position or modifier
        // side: `code` stays the empty DOM code, never guessed from the key.
        event.modifiers = self.modifiers;
        event.repeat = self.repeat;
        event.default_prevented = default_prevented;
        event
    }
}

/// The key's name: the character the platform reports it types (its case
/// as reported), else the web's spelling of a key both platforms name
/// alike, else GPUI's own name for it.
fn name(keystroke: &gpui::Keystroke) -> SharedString {
    if let Some(text) = &keystroke.key_char {
        let mut chars = text.chars();
        if let (Some(c), None) = (chars.next(), chars.next())
            && !c.is_control()
        {
            return SharedString::from(c.to_string());
        }
    }
    named(&keystroke.key).unwrap_or_else(|| SharedString::from(keystroke.key.clone()))
}

/// The name the web gives key `key` (`KeyboardEvent.key`), where GPUI
/// names it too; `None` for the keys it reports as the characters they
/// type.
fn named(key: &str) -> Option<SharedString> {
    let name = match key {
        "enter" => "Enter",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "insert" => "Insert",
        "escape" => "Escape",
        "space" => " ",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "shift" => "Shift",
        "control" => "Control",
        "alt" => "Alt",
        "platform" | "cmd" | "super" | "win" => "Meta",
        "back" => "BrowserBack",
        "forward" => "BrowserForward",
        other => {
            let n = other
                .strip_prefix('f')
                .filter(|n| !n.starts_with('0'))
                .and_then(|n| n.parse::<u8>().ok())
                // GPUI names F1 to F35 so.
                .filter(|n| (1..=35).contains(n))?;
            return Some(SharedString::from(format!("F{n}")));
        }
    };
    Some(SharedString::new_static(name))
}

/// The web's name for a named key a test step asked for.
#[cfg(any(feature = "dev", test))]
fn named_key(key: ShortcutKey) -> SharedString {
    let name = match key {
        ShortcutKey::Enter => "Enter",
        ShortcutKey::Escape => "Escape",
        ShortcutKey::Tab => "Tab",
        ShortcutKey::Backspace => "Backspace",
        ShortcutKey::Delete => "Delete",
        ShortcutKey::Insert => "Insert",
        ShortcutKey::Home => "Home",
        ShortcutKey::End => "End",
        ShortcutKey::PageUp => "PageUp",
        ShortcutKey::PageDown => "PageDown",
        ShortcutKey::Up => "ArrowUp",
        ShortcutKey::Down => "ArrowDown",
        ShortcutKey::Left => "ArrowLeft",
        ShortcutKey::Right => "ArrowRight",
        ShortcutKey::F(n) => return SharedString::from(format!("F{n}")),
        ShortcutKey::Char(c) => return SharedString::from(c.to_string()),
    };
    SharedString::new_static(name)
}

/// The canonical shortcut keystroke of the key GPUI reports as `key` with
/// `modifiers`, for matching only: a capture rule
/// (`KeyCapture::captures_key`) or an app binding of a key that has no
/// virtual key code.
///
/// GPUI reports a key by what it is on the user's layout (`a`, lower case
/// for letters; the ASCII-equivalent key on layouts without ASCII ones)
/// and what it types separately (`key_char`), so the key, not the typed
/// character, is matched: Caps Lock's `A` is the `a` key with no Shift.
/// The named keys take the keymap's spelling ([`shortcut_key`]); a US
/// symbol the source resolved and cleared Shift for gets it back (`?` is
/// `shift+/`, `*` is `shift+8`), and every other key keeps the source's
/// modifiers. Nothing is allocated, and nothing here changes the event.
fn source_stroke(key: &str, mut modifiers: KeyModifiers) -> Option<Keystroke> {
    if let Some(base) = unshifted_symbol(key) {
        modifiers.shift = true;
        return Some(Keystroke {
            modifiers,
            key: ShortcutKey::Char(base),
        });
    }
    Some(Keystroke {
        modifiers,
        key: shortcut_key(key)?,
    })
}

/// The keymap key of the key GPUI reports as `name`: GPUI's own spelling
/// of a named key (`"enter"`, `"pageup"`, `"f5"`) or a single printable
/// ASCII character, letters in lower case. `None` for a key no shortcut
/// can name (a modifier, a dead key, another layout's character): only
/// [`nsh_core::KeyCapture::All`] captures those.
///
/// This is the backend's own adapter for matching; the app-facing
/// [`nsh_core::keymap::Key`] has no name parser of its own. A key's
/// position on the US layout is what it is here, not what the current
/// layout types.
fn shortcut_key(name: &str) -> Option<ShortcutKey> {
    let named = match name {
        "enter" | "return" => ShortcutKey::Enter,
        "escape" | "esc" => ShortcutKey::Escape,
        "tab" => ShortcutKey::Tab,
        "space" => ShortcutKey::Char(' '),
        "backspace" => ShortcutKey::Backspace,
        "delete" | "del" => ShortcutKey::Delete,
        "insert" => ShortcutKey::Insert,
        "up" | "arrowup" => ShortcutKey::Up,
        "down" | "arrowdown" => ShortcutKey::Down,
        "left" | "arrowleft" => ShortcutKey::Left,
        "right" | "arrowright" => ShortcutKey::Right,
        "home" => ShortcutKey::Home,
        "end" => ShortcutKey::End,
        "pageup" => ShortcutKey::PageUp,
        "pagedown" => ShortcutKey::PageDown,
        // The plus key is the one typing `=`, as on the US layout.
        "plus" => ShortcutKey::Char('='),
        "minus" => ShortcutKey::Char('-'),
        " " => ShortcutKey::Char(' '),
        other => {
            if let Some(rest) = other.strip_prefix('f').or_else(|| other.strip_prefix('F'))
                && !rest.starts_with('0')
                && let Ok(number) = rest.parse::<u8>()
                && (1..=24).contains(&number)
            {
                return Some(ShortcutKey::F(number));
            }
            let mut chars = other.chars();
            return match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_graphic() => {
                    Some(ShortcutKey::Char(c.to_ascii_lowercase()))
                }
                _ => None,
            };
        }
    };
    Some(named)
}

/// The US key `key` is the shifted form of, when it is one: `'/'` for
/// `'?'`, `'8'` for `'*'`.
///
/// Only symbols: a letter's Shift is reported as a modifier, and a capital
/// without it is Caps Lock's (or a layout's), not a shifted key.
fn unshifted_symbol(key: &str) -> Option<char> {
    let mut chars = key.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        return None;
    };
    if !c.is_ascii_punctuation() {
        return None;
    }
    // The keymap's `shifted` in reverse, without a second table.
    (0x20u8..=0x7e)
        .map(char::from)
        .find(|&base| base != c && nsh_core::keymap::shifted(base) == c)
}

#[cfg(test)]
mod tests {
    use nsh_core::KeyCapture;

    use super::*;

    /// A GPUI keystroke as a platform reports it (`key_char`: what it
    /// types, when it types anything).
    fn stroke(key: &str, key_char: Option<&str>, modifiers: gpui::Modifiers) -> gpui::Keystroke {
        gpui::Keystroke {
            modifiers,
            key: key.to_string(),
            key_char: key_char.map(str::to_string),
        }
    }

    fn shift() -> gpui::Modifiers {
        gpui::Modifiers {
            shift: true,
            ..Default::default()
        }
    }

    #[test]
    fn names() {
        assert_eq!(vk_of("a"), Some(0x41));
        assert_eq!(vk_of("7"), Some(0x37));
        assert_eq!(vk_of("f5"), Some(0x74));
        assert_eq!(vk_of("enter"), Some(VK_RETURN));
        assert_eq!(vk_of("/"), Some(0xBF));
        assert_eq!(vk_of("é"), None);
    }

    #[test]
    fn a_raw_key_keeps_what_the_source_reported_and_matches_by_its_key() {
        // Shift+A: GPUI lower cases the key and reports the typed `A`.
        let raw = RawKey::down(&stroke("a", Some("A"), shift()), false);
        let event = raw.event(false);
        assert_eq!(event.key, "A");
        assert!(event.modifiers.shift);
        // No scan code or position exists to report: the event carries no
        // DOM code, and never guesses one from the logical key.
        assert_eq!(event.code, "");
        // Matching is the source's key, without rewriting the payload.
        let matching = raw.stroke().expect("a is a shortcut key");
        assert_eq!(matching.key, ShortcutKey::Char('a'));
        assert!(matching.modifiers.shift);
        assert!(KeyCapture::keys([stroke_of("shift+a")]).captures_key(Some(matching)));
        assert!(!KeyCapture::keys([stroke_of("a")]).captures_key(Some(matching)));

        // Caps Lock: the source reports the typed `A` with no Shift, and
        // the key stays `a`: a capital is no evidence of Shift.
        let caps = RawKey::down(&stroke("a", Some("A"), Default::default()), false);
        let event = caps.event(false);
        assert_eq!(event.key, "A");
        assert!(!event.modifiers.shift);
        let matching = caps.stroke().expect("a is a shortcut key");
        assert_eq!(matching.key, ShortcutKey::Char('a'));
        assert!(!matching.modifiers.shift);
        assert!(KeyCapture::keys([stroke_of("a")]).captures_key(Some(matching)));
        assert!(!KeyCapture::keys([stroke_of("shift+a")]).captures_key(Some(matching)));

        // Shift+/ comes as `?` (Shift already cleared by GPUI) and the
        // event keeps it: the payload is not rewritten onto a US `/`.
        let raw = RawKey::down(&stroke("?", Some("?"), Default::default()), false);
        let event = raw.event(false);
        assert_eq!(event.key, "?");
        assert!(!event.modifiers.shift);
        assert_eq!(event.code, "");
        assert_eq!(vk_of("?"), None);
        // Its shortcut, for matching only, is the keymap's `shift+/`.
        let matching = raw.stroke().expect("? is a shortcut key");
        assert_eq!(matching.key, ShortcutKey::Char('/'));
        assert!(matching.modifiers.shift);
        assert!(KeyCapture::keys([stroke_of("shift+/")]).captures_key(Some(matching)));
        assert!(!KeyCapture::keys([stroke_of("/")]).captures_key(Some(matching)));

        // The rest of the shifted symbols as GPUI resolves them, the same.
        let raw = RawKey::down(&stroke("*", Some("*"), Default::default()), false);
        assert_eq!(raw.event(false).key, "*");
        let matching = raw.stroke().expect("* is a shortcut key");
        assert_eq!(matching.key, ShortcutKey::Char('8'));
        assert!(matching.modifiers.shift);
        assert!(KeyCapture::keys([stroke_of("shift+8")]).captures_key(Some(matching)));

        // A layout's own character stays in the payload, while matching
        // uses the key the source names it by (GPUI's ASCII-equivalent
        // key on layouts without ASCII ones).
        let raw = RawKey::down(&stroke("q", Some("ๆ"), Default::default()), false);
        let event = raw.event(false);
        assert_eq!(event.key, "ๆ");
        let matching = raw.stroke().expect("q is a shortcut key");
        assert_eq!(matching.key, ShortcutKey::Char('q'));
        assert!(KeyCapture::keys([stroke_of("q")]).captures_key(Some(matching)));

        // A non-ASCII key with no ASCII-equivalent key has no stroke: only
        // `All` captures it, and nothing is guessed.
        let raw = RawKey::down(&stroke("é", Some("é"), Default::default()), false);
        let event = raw.event(false);
        assert_eq!(event.key, "é");
        assert!(raw.stroke().is_none());
        assert!(KeyCapture::All.captures_key(raw.stroke()));
        assert!(!KeyCapture::keys([stroke_of("a")]).captures_key(raw.stroke()));
    }

    #[test]
    fn all_named_keys_are_reported_even_without_a_virtual_code() {
        for (key, name, vk) in [
            ("enter", "Enter", VK_RETURN),
            ("tab", "Tab", VK_TAB),
            ("backspace", "Backspace", VK_BACK),
            ("delete", "Delete", VK_DELETE),
            ("insert", "Insert", VK_INSERT),
            ("escape", "Escape", VK_ESCAPE),
            ("space", " ", VK_SPACE),
            ("left", "ArrowLeft", VK_LEFT),
            ("right", "ArrowRight", VK_RIGHT),
            ("up", "ArrowUp", VK_UP),
            ("down", "ArrowDown", VK_DOWN),
            ("home", "Home", VK_HOME),
            ("end", "End", VK_END),
            ("pageup", "PageUp", VK_PRIOR),
            ("pagedown", "PageDown", VK_NEXT),
            ("shift", "Shift", VK_SHIFT),
            ("control", "Control", VK_CONTROL),
            ("alt", "Alt", VK_MENU),
            ("platform", "Meta", VK_LWIN),
            ("back", "BrowserBack", VK_BROWSER_BACK),
            ("f5", "F5", 0x74),
            ("f24", "F24", 0x87),
        ] {
            let event = RawKey::down(&stroke(key, None, Default::default()), false).event(false);
            assert_eq!(event.key, name, "{key}");
            assert_eq!(event.code, "", "{key}");
            assert_eq!(vk_of(key), Some(vk), "{key}");
        }
        assert_eq!(
            RawKey::down(&stroke("space", Some(" "), Default::default()), false)
                .event(false)
                .key,
            " "
        );
        // GPUI's F keys past F24 have no virtual code and keep their name.
        assert_eq!(vk_of("f35"), None);
        assert_eq!(
            RawKey::down(&stroke("f35", None, Default::default()), false)
                .event(false)
                .key,
            "F35"
        );
        // A key GPUI names and the web does not name alike keeps GPUI's
        // name, and captures under `All` alone.
        let dead = RawKey::down(&stroke("dead_acute", None, Default::default()), false);
        assert_eq!(dead.event(false).key, "dead_acute");
        assert!(dead.stroke().is_none());
        assert!(KeyCapture::All.captures_key(dead.stroke()));
        assert!(!KeyCapture::None.captures_key(dead.stroke()));
    }

    #[test]
    fn a_test_steps_key_is_the_keystroke_it_asked_for() {
        // A step naming `shift+/`: its event is the `?` the US layout
        // types, and the stroke a capture rule or binding matches is the
        // step's own keystroke.
        let shift_slash = stroke_of("shift+/");
        let down = RawKey::requested(&shift_slash, true);
        let event = down.event(false);
        assert_eq!(event.key, "?");
        assert!(event.modifiers.shift);
        assert_eq!(event.code, "");
        assert!(!event.repeat);
        assert_eq!(down.stroke(), Some(&shift_slash));
        assert!(KeyCapture::keys([shift_slash]).captures_key(down.stroke()));
        // A release carries the same stroke and key.
        let up = RawKey::requested(&shift_slash, false);
        assert_eq!(up.event(false).key, "?");
        assert_eq!(up.stroke(), Some(&shift_slash));
        // A shortcut's key is its character.
        let event = RawKey::requested(&stroke_of("ctrl+a"), true).event(false);
        assert_eq!(event.key, "a");
        // A named key takes the web's spelling.
        let event = RawKey::requested(&stroke_of("enter"), true).event(false);
        assert_eq!(event.key, "Enter");
    }

    #[test]
    fn an_event_is_the_transition_the_source_reported() {
        let down = |k: &gpui::Keystroke| RawKey::down(k, false).event(false);
        // Modifiers do not turn a key into a different key: `a` stays `a`
        // under Control, Alt and Command, which are reported as held.
        for modifiers in [
            gpui::Modifiers {
                control: true,
                ..Default::default()
            },
            gpui::Modifiers {
                alt: true,
                ..Default::default()
            },
            gpui::Modifiers {
                platform: true,
                ..Default::default()
            },
        ] {
            let event = down(&stroke("a", None, modifiers));
            assert_eq!(event.key, "a");
            assert_eq!(event.code, "");
        }
        // A repeat is the platform's own mark, and a release never is one.
        assert!(
            RawKey::down(&stroke("a", Some("a"), Default::default()), true)
                .event(false)
                .repeat
        );
        assert!(
            !RawKey::up(&stroke("a", Some("a"), Default::default()))
                .event(false)
                .repeat
        );
        // `default_prevented` is the mounted policy's decision for this
        // transition, as the platform hands it over.
        assert!(
            RawKey::down(&stroke("a", Some("a"), Default::default()), false)
                .event(true)
                .default_prevented
        );
        assert!(
            !RawKey::down(&stroke("a", Some("a"), Default::default()), false)
                .event(false)
                .default_prevented
        );
    }

    /// The canonical shortcut `text` names.
    fn stroke_of(text: &str) -> nsh_core::keymap::Keystroke {
        nsh_core::keymap::Keystroke::parse_with(text, false).expect(text)
    }
}
