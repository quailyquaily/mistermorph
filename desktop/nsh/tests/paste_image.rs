//! The clipboard images `onPaste` hands the Console (vendor/nsh-platform-gpui/src/paste_image.rs,
//! patches/nsh-paste-images.patch): its tests, run with the app's `cargo test`, which does not run
//! the vendored crate's own.

#[allow(dead_code)]
#[path = "../vendor/nsh-platform-gpui/src/paste_image.rs"]
mod paste_image;
