//! The app's keyboard shortcuts (`nsh/keymap`): the table the engine
//! mounts ([`MountItem::Keymap`](nsh_core::MountItem::Keymap)), matched on
//! every key down the window gets ([`crate::input::key`]): after the
//! window's shortcuts and the dialogs the surface shows, before the
//! application menu's shortcuts ([`crate::chrome::shortcut`]: a binding
//! wins over a menu item of the same keystroke), the focused field,
//! selectable text, navigation and scroll views. A key that fires a
//! binding is consumed and reported to JS with the root's `KeyCommand`
//! event; JS runs the handler afterwards.
//!
//! Modifiers are GPUI's: `cmd` is the platform key (Command on macOS, the
//! Super / Windows key elsewhere), so `mod` (Command on macOS, Control
//! elsewhere, resolved by the engine for [`OS`]) matches the key users
//! expect. Keys are matched by virtual key code ([`crate::keys`]): letters
//! and digits by the key GPUI names, punctuation by the US layout's keys.
//!
//! Auto-repeats: GPUI marks them on macOS, Windows and Wayland
//! (`KeyDownEvent::is_held`), not on X11, where they come as more key
//! downs of the same key with no release between (GPUI drops the
//! releases X11 makes up). So a key down of the key that went down last
//! and has not been released counts as a repeat too: a binding without
//! `repeat` fires once until the key is released, the modifiers change or
//! the window is deactivated ([`forget_held`]).

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    keymap::{Key, Keymap, Keystroke, Modifiers},
    platform::Os,
};

use crate::{input::KeyEvent, keys, surface::Surface};

/// The platform bindings are read for.
const OS: Os = if cfg!(target_os = "macos") {
    Os::MacOs
} else if cfg!(windows) {
    Os::Windows
} else {
    Os::Linux
};

/// A surface's table, while it has bindings.
#[derive(Default)]
pub(crate) struct KeymapState {
    table: RefCell<Option<Arc<Keymap>>>,
    /// The key that went down last and is still down (not a modifier).
    held: Cell<Option<u16>>,
}

/// `MountItem::Keymap`: replaces the surface's table.
pub(crate) fn set(surface: &Surface, keymap: Arc<Keymap>) {
    *surface.keymap.table.borrow_mut() = (!keymap.is_empty()).then_some(keymap);
}

/// Drops the table (the app stopped).
pub(crate) fn clear(surface: &Surface) {
    surface.keymap.table.borrow_mut().take();
}

/// A key down: whether one of the bindings consumes it (it fired one, or,
/// held, repeats one). A binding passing the key through fires and leaves
/// it to the window. `editing`: a text field or a native component has
/// the keyboard focus.
pub(crate) fn key(surface: &Rc<Surface>, event: &KeyEvent, editing: bool) -> bool {
    let repeat = repeats(&surface.keymap, event);
    let Some(table) = surface.keymap.table.borrow().clone() else {
        return false;
    };
    let Some(keystroke) = keystroke(event) else {
        return false;
    };
    // The dev host's Ctrl+R / Cmd+R reloads, whatever the app binds.
    if cfg!(feature = "dev") && keystroke.reloads(OS) {
        return false;
    }
    // Only the bindings of the window the key is in (and JS's) take it.
    let window = surface.input_root().id();
    let found = table.find_in(window, keystroke, editing, repeat);
    if let Some(id) = found.fired() {
        surface.event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(id as f64)),
        );
        // Escape cancels text waiting for a field. Every other binding may
        // move focus, so text typed straight after it waits for that field.
        if event.vk != keys::VK_ESCAPE {
            crate::text_input::arm(surface);
        }
    }
    found.consumed()
}

/// Whether a key down is an auto-repeat (see the module docs), noting the
/// key held.
fn repeats(state: &KeymapState, event: &KeyEvent) -> bool {
    if modifier(event.vk) {
        return event.repeat;
    }
    state.held.replace(Some(event.vk)) == Some(event.vk) || event.repeat
}

/// A modifier key (which does not end another key's auto-repeat).
pub(crate) fn modifier(vk: u16) -> bool {
    matches!(
        vk,
        keys::VK_SHIFT | keys::VK_CONTROL | keys::VK_MENU | keys::VK_LWIN
    )
}

/// A key up: the key held is released.
pub(crate) fn released(surface: &Surface, event: &KeyEvent) {
    let held = &surface.keymap.held;
    if held.get() == Some(event.vk) {
        held.set(None);
    }
}

/// The window was deactivated (the key held may be released elsewhere),
/// or the modifiers changed: GPUI's X11 backend loses a key's release
/// when another release follows in the same batch of events (releasing
/// K and then Ctrl of Ctrl+K), so the next Ctrl+K must not count as a
/// repeat.
pub(crate) fn forget_held(surface: &Surface) {
    surface.keymap.held.set(None);
}

/// The keystroke of a key down.
fn keystroke(event: &KeyEvent) -> Option<Keystroke> {
    let m = event.modifiers;
    let modifiers = Modifiers {
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        cmd: m.meta,
    };
    Some(Keystroke {
        modifiers,
        key: key_of(event.vk)?,
    })
}

/// The key of virtual key code `vk` (`VK_*`).
fn key_of(vk: u16) -> Option<Key> {
    Key::from_virtual_key(vk)
}

#[cfg(test)]
mod tests {
    use nsh_core::keymap::Key;

    #[test]
    fn repeats_without_releases() {
        use super::{KeyEvent, KeymapState, repeats};
        let state = KeymapState::default();
        let down = |vk: u16| KeyEvent {
            vk,
            down: true,
            repeat: false,
            modifiers: Default::default(),
        };
        assert!(!repeats(&state, &down(0x4B)));
        // X11's auto-repeat: the same key again, unreleased.
        assert!(repeats(&state, &down(0x4B)));
        // Shift going down does not end it.
        assert!(!repeats(&state, &down(0x10)));
        assert!(repeats(&state, &down(0x4B)));
        // Another key does; so does a release.
        assert!(!repeats(&state, &down(0x4C)));
        state.held.set(None);
        assert!(!repeats(&state, &down(0x4C)));
    }

    #[test]
    fn a_key_takes_only_the_bindings_of_the_window_it_is_in() {
        use nsh_core::keymap::{KeyBinding, Keymap, Keystroke, When};

        use super::KeyEvent;
        use crate::{keys::VK_ESCAPE, surface::Surface, view::NshView};

        let surface = Surface::new(nsh_engine::Environment::default());
        let escape = Keystroke::parse_with("escape", true).unwrap();
        // Window 7's binding alone.
        let binding = KeyBinding::new(1, escape, When::Always, false).in_window(7);
        *surface.keymap.table.borrow_mut() = Some(std::sync::Arc::new(Keymap::new(vec![binding])));
        let press = || {
            super::key(
                &surface,
                &KeyEvent {
                    vk: VK_ESCAPE,
                    down: true,
                    repeat: false,
                    modifiers: Default::default(),
                },
                false,
            )
        };
        // Pressed in the main window: not its binding, the key goes on.
        assert!(!press());
        surface.keymap.held.set(None);
        // Pressed in window 7 (what `window::enter` sets): its binding fires.
        let window = NshView::new(7, nsh_core::ViewKind::View);
        let outer = surface.input_root.replace(Some(window));
        assert!(press());
        *surface.input_root.borrow_mut() = outer;
    }

    #[test]
    fn virtual_keys() {
        assert_eq!(super::key_of(0x4B), Some(Key::Char('k')));
        assert_eq!(super::key_of(0x31), Some(Key::Char('1')));
        assert_eq!(super::key_of(0x74), Some(Key::F(5)));
        assert_eq!(super::key_of(0xBF), Some(Key::Char('/')));
        assert_eq!(super::key_of(0x10), None);
    }
}
