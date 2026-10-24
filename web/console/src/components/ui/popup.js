// Popup closing and the theme mark, the two helpers the console took from quail-ui.
//
// Every open dropdown menu listens for one window event; a click anywhere on the page (main.js
// installs the listener) sends it, so a click outside a menu closes it, and a menu sends it itself
// before it opens, so opening one closes the others.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).

const POPUP_CLOSE_EVENT = "quailui:close-popup";

function closePopupMenu() {
  window.dispatchEvent(new CustomEvent(POPUP_CLOSE_EVENT));
}

function onPopupClose(handler) {
  window.addEventListener(POPUP_CLOSE_EVENT, handler);
  return () => window.removeEventListener(POPUP_CLOSE_EVENT, handler);
}

// applyTheme marks the page with its theme: styles/ui-kit.css and the app's styles key their tokens
// and rules off body[data-theme]. The console has one theme, morph.
function applyTheme(theme = "morph") {
  if (typeof document === "undefined" || !document.body) {
    return theme;
  }
  document.body.dataset.theme = theme;
  document.body.classList.add("light");
  return theme;
}

// opensKeyboard reports whether focusing el would raise an on-screen keyboard: a text field on a
// touch screen without a mouse. Menus and dialogs opened there leave such fields for a tap.
function opensKeyboard(el) {
  if (typeof window === "undefined" || !el?.matches) {
    return false;
  }
  const touchOnly = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
  const textField = el.matches("textarea, [contenteditable=''], [contenteditable='true'], input:not([type]), input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input[type='number'], input[type='password']");
  return Boolean(touchOnly && textField);
}

export { applyTheme, closePopupMenu, onPopupClose, opensKeyboard };
