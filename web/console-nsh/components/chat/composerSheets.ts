// The composer's popups on touch screens. nsh's Menu and Select are sheets at the bottom of the
// screen there (their `placement` is the desktops'), and the software keyboard lies over the bottom
// of the surface: Android shrinks neither the surface nor an overlay for it (PORTING.md). The
// composer lowers the keyboard as its add menu or model picker opens; the model picker's search
// field can raise it again, and then its sheet rises above the keyboard (`bottomSheetInsets` in
// lib/systemInsets.ts, with the keyboard's height). Every sheet keeps above the navigation bar or
// the gesture handle the same way (`bottomSheetStyle` in components/ui.tsx).

/** The model picker's list at most (`max-h-80`), as on the desktops. */
export const PROFILE_SHEET_MAX_HEIGHT = 320;
/** The model picker's padding under its last row (`py-1`). */
export const PROFILE_SHEET_PADDING = 4;
