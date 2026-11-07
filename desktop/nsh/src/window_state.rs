//! The main window's size and position between launches (desktop_window_state.go): the same
//! `main-window.json` the Wails app wrote, so either app picks up the other's.
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const DEFAULT_WIDTH: i32 = 1360;
pub const DEFAULT_HEIGHT: i32 = 860;
pub const MIN_WIDTH: i32 = 1000;
pub const MIN_HEIGHT: i32 = 680;
const MAX_WIDTH: i32 = 3840;
const MAX_HEIGHT: i32 = 2400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct WindowState {
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    #[serde(default)]
    pub width: i32,
    #[serde(default)]
    pub height: i32,
}

/// The visible area of a display, in the same units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub fn load(path: Option<&Path>) -> Option<WindowState> {
    let bytes = std::fs::read(path?).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    normalize(serde_json::from_slice(&bytes).ok()?)
}

pub fn save(path: Option<&Path>, state: WindowState) -> Result<(), String> {
    let path = path.ok_or("empty desktop window state path")?;
    let state = normalize(state).ok_or("invalid desktop window state")?;
    let mut json = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    json.push(b'\n');
    crate::paths::write_atomic(path, &json).map_err(|e| e.to_string())
}

/// A state with a size inside the limits; `None` without a size.
pub fn normalize(mut state: WindowState) -> Option<WindowState> {
    if state.width <= 0 || state.height <= 0 {
        return None;
    }
    state.width = clamp(state.width, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
    state.height = clamp(state.height, DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT);
    Some(state)
}

/// The state moved and shrunk to fit inside `area`.
pub fn constrain(mut state: WindowState, area: Area) -> Option<WindowState> {
    if area.width <= 0 || area.height <= 0 || state.width <= 0 || state.height <= 0 {
        return None;
    }
    state.width = state.width.min(area.width);
    state.height = state.height.min(area.height);
    let max_x = area.x + area.width - state.width;
    state.x = state.x.max(area.x).min(max_x);
    let max_y = area.y + area.height - state.height;
    state.y = state.y.max(area.y).min(max_y);
    Some(state)
}

fn clamp(value: i32, fallback: i32, min: i32, max: i32) -> i32 {
    if value <= 0 { fallback } else { value.max(min).min(max) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_sizes() {
        let s = WindowState { x: 5, y: 6, width: 200, height: 9000 };
        assert_eq!(normalize(s), Some(WindowState { x: 5, y: 6, width: MIN_WIDTH, height: MAX_HEIGHT }));
        assert_eq!(normalize(WindowState { width: 0, height: 10, ..Default::default() }), None);
    }

    #[test]
    fn constrains_to_the_area() {
        let area = Area { x: 0, y: 25, width: 1440, height: 875 };
        let s = WindowState { x: -100, y: 0, width: 1600, height: 900 };
        assert_eq!(constrain(s, area), Some(WindowState { x: 0, y: 25, width: 1440, height: 875 }));
        let s = WindowState { x: 1000, y: 800, width: 1200, height: 700 };
        assert_eq!(constrain(s, area), Some(WindowState { x: 240, y: 200, width: 1200, height: 700 }));
        assert_eq!(constrain(s, Area { x: 0, y: 0, width: 0, height: 10 }), None);
    }

    #[test]
    fn saves_and_loads() {
        let dir = std::env::temp_dir().join(format!("morph-window-{}", std::process::id()));
        let file = dir.join("main-window.json");
        assert_eq!(load(Some(&file)), None);
        save(Some(&file), WindowState { x: 10, y: 20, width: 1200, height: 800 }).unwrap();
        assert_eq!(load(Some(&file)), Some(WindowState { x: 10, y: 20, width: 1200, height: 800 }));
        // The Wails app's file has the same shape.
        std::fs::write(&file, r#"{"x":1,"y":2,"width":1500,"height":900}"#).unwrap();
        assert_eq!(load(Some(&file)), Some(WindowState { x: 1, y: 2, width: 1500, height: 900 }));
        assert!(save(Some(&file), WindowState::default()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
