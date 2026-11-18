//! The keyboard focus on views that are not text fields: `focus()` moves
//! it to a stop ([`nsh_core::ViewProps::focus_stop`]), as on macOS, Linux
//! and the web. A focused stop reports `FOCUSED`, `onFocus` and `onBlur`;
//! its keys reach the app's keymap (bound while it has the focus) as with
//! no field focused, but for Return and Space, which only the focus' own
//! bindings take (`Keymap::find_at`); else they press it. A stop the newest
//! modal covers (the app left the focus there) is never pressed, and its
//! own bindings give way to the others (`Keymap::find_with`).
//!
//! The focus leaves the stop when a field takes it, on `blur()`, when the
//! pointer goes down outside the stop, or when the stop goes away.

use std::{cell::RefCell, rc::Rc};

use nsh_core::{EventKind, EventPayload, PointerEvents, ViewKind, tailwind::state};
use rustc_hash::FxHashMap;

use crate::{input::KeyEvent, surface::Surface, view::NshView};

thread_local! {
    /// The focused stop of each surface, by surface key.
    static FOCUSED: RefCell<FxHashMap<u64, NshView>> = RefCell::default();
}

/// Whether `view` can take the focus: it is a stop, attached and shown.
fn is_stop(view: &NshView) -> bool {
    {
        let s = view.state();
        if s.kind == ViewKind::Input || !s.props.focus_stop(s.events.contains(EventKind::Press)) {
            return false;
        }
    }
    let mut at = Some(view.clone());
    while let Some(v) = at {
        {
            let s = v.state();
            if s.style.hidden || s.concealed || s.props.pointer_events == PointerEvents::None {
                return false;
            }
        }
        at = v.parent_view();
        if at.is_none() && !v.attached() {
            return false;
        }
    }
    true
}

/// The stop that has the keyboard focus on `surface`.
pub(crate) fn focused(surface: &Surface) -> Option<NshView> {
    FOCUSED.with_borrow(|f| f.get(&surface.key()).cloned())
}

/// Whether the keyboard focus is on a stop the newest modal covers: a
/// focus the app left there (a popup closing gave it back to its trigger
/// as a dialog opened). That stop's own bindings take no keys
/// ([`nsh_core::keymap::KeyFocus::covered`]).
pub(crate) fn covered(surface: &Surface) -> bool {
    focused(surface).is_some_and(|view| !crate::navigation::in_focus_scope(surface, &view))
}

/// `focus()` on a view that is not an input: it takes the keyboard focus
/// if it is a stop (a field that had it lets go).
pub(crate) fn focus(surface: &Rc<Surface>, view: &NshView) {
    if !is_stop(view) || focused(surface).as_ref() == Some(view) {
        return;
    }
    crate::text_input::blur_all(surface);
    clear(surface);
    FOCUSED.with_borrow_mut(|f| f.insert(surface.key(), view.clone()));
    surface.window_focus_requested.set(true);
    crate::input::set_state(surface, view, state::FOCUSED, true);
    surface.event(view.id(), EventKind::Focus, EventPayload::None);
    crate::scroll::reveal(surface, view);
    view.changed();
    surface.invalidate();
}

/// `blur()` on a view that is not an input: true when it had the focus.
pub(crate) fn blur(surface: &Surface, view: &NshView) -> bool {
    if focused(surface).as_ref() != Some(view) {
        return false;
    }
    clear(surface);
    true
}

/// The focused stop, if any, lets go of the focus.
pub(crate) fn clear(surface: &Surface) {
    let Some(old) = FOCUSED.with_borrow_mut(|f| f.remove(&surface.key())) else {
        return;
    };
    crate::input::set_state(surface, &old, state::FOCUSED, false);
    surface.event(old.id(), EventKind::Blur, EventPayload::None);
    old.changed();
    surface.invalidate();
}

/// The pointer went down on `hit`: a focused stop it is not inside of lets
/// go of the focus.
pub(crate) fn pointer_down(surface: &Surface, hit: &NshView) {
    let Some(stop) = focused(surface) else {
        return;
    };
    let mut at = Some(hit.clone());
    while let Some(v) = at {
        if v == stop {
            return;
        }
        at = v.parent_view();
    }
    clear(surface);
}

/// A view was removed: if it holds the focused stop, the focus goes, at
/// once (a removal animation or a departing screen keeps it attached a
/// while, when Return and Space must not press it).
pub(crate) fn detached(surface: &Surface, view: &NshView) {
    let Some(stop) = focused(surface) else {
        return;
    };
    let mut at = Some(stop.clone());
    while let Some(v) = at {
        if v == *view {
            // Gone: no `onBlur` to a view that no longer exists. Its state
            // is cleared all the same: a kept node may be inserted again.
            FOCUSED.with_borrow_mut(|f| f.remove(&surface.key()));
            crate::input::set_state(surface, &stop, state::FOCUSED, false);
            return;
        }
        at = v.parent_view();
    }
}

/// Whether the focused stop is a control that Return and Space press (it
/// takes presses): the app's bindings of those keys then give way to it,
/// but for the focus' own (`Keymap::find_at`).
pub(crate) fn on_control(surface: &Surface) -> bool {
    control(surface).is_some()
}

/// The focused stop if Return and Space press it: it takes presses and is
/// in the newest modal over its window. One the modal covers is not
/// pressed, and the app's bindings (the dialog's Return) keep those keys,
/// as on macOS.
fn control(surface: &Surface) -> Option<NshView> {
    focused(surface).filter(|view| {
        view.state().events.contains(EventKind::Press)
            && crate::navigation::in_focus_scope(surface, view)
    })
}

/// Return or Space press the focused stop when it takes presses
/// ([`nsh_core::input::presses_focused_control`]), once the bindings of
/// the focus passed on them: a binding of Return elsewhere does not act
/// instead of the control the focus was moved to. True when handled.
pub(crate) fn key(surface: &Surface, event: &KeyEvent) -> bool {
    use nsh_core::keymap::{Key, Modifiers};

    use crate::keys::{VK_RETURN, VK_SPACE};
    let key = match event.vk {
        VK_RETURN => Key::Enter,
        VK_SPACE => Key::Char(' '),
        _ => return false,
    };
    let m = &event.modifiers;
    let held = Modifiers {
        ctrl: m.ctrl,
        alt: m.alt,
        shift: m.shift,
        cmd: m.meta,
    };
    if !event.down || !nsh_core::input::presses_focused_control(key, held) {
        return false;
    }
    let Some(view) = control(surface) else {
        return false;
    };
    surface.event(view.id(), EventKind::Press, EventPayload::None);
    true
}

/// The surface is gone.
pub(crate) fn forget(surface: &Surface) {
    FOCUSED.with_borrow_mut(|f| f.remove(&surface.key()));
}
