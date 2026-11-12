//! The keyboard focus on views that are not text fields: `focus()` moves
//! it to a stop ([`nsh_core::ViewProps::focus_stop`]), as on macOS, Linux
//! and the web. A focused stop reports `FOCUSED`, `onFocus` and `onBlur`;
//! its keys reach the app's keymap (bound while it has the focus) as with
//! no field focused, and Return or Space press it when nothing took them.
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

/// A view was removed: if it holds the focused stop, the focus goes.
pub(crate) fn detached(surface: &Surface, view: &NshView) {
    let Some(stop) = focused(surface) else {
        return;
    };
    let mut at = Some(stop.clone());
    while let Some(v) = at {
        if v == *view {
            // Gone: no `onBlur` to a view that no longer exists.
            FOCUSED.with_borrow_mut(|f| f.remove(&surface.key()));
            return;
        }
        at = v.parent_view();
    }
}

/// A key nothing else took: Return or Space press the focused stop when
/// it takes presses. True when handled.
pub(crate) fn key(surface: &Surface, event: &KeyEvent) -> bool {
    const VK_RETURN: u16 = 0x0D;
    const VK_SPACE: u16 = 0x20;
    let m = &event.modifiers;
    if !event.down || !matches!(event.vk, VK_RETURN | VK_SPACE) || m.ctrl || m.alt || m.meta {
        return false;
    }
    let Some(view) = focused(surface) else {
        return false;
    };
    if !view.state().events.contains(EventKind::Press) {
        return false;
    }
    surface.event(view.id(), EventKind::Press, EventPayload::None);
    true
}

/// The surface is gone.
pub(crate) fn forget(surface: &Surface) {
    FOCUSED.with_borrow_mut(|f| f.remove(&surface.key()));
}
