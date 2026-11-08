# Mobile composer responsiveness, voice input, tab spacing, and sheet transitions

## factory · 2026-11-08 12:18
Registered from the owner's Console request:

> Factory new bugs on mobile view:
> 1. Paste text on composer cause UI lagging for some unknown reason.
> 2. No voice input button.
> 3. The tabs component, the padding is not correct visualy.
> 4. The bottom sheets of bottom nav's 4th and 5th need animation for show and hide

Requested scope and acceptance:
- Investigate and fix mobile composer lag when pasting text. Preserve pasted content, selection, and normal editing; check both ordinary and large multiline pastes. Determine the actual cause rather than assuming one.
- Make the voice input button available and usable in the mobile composer, reusing existing voice-input behavior where available. Handle microphone permission denial and unsupported browsers explicitly without breaking text input.
- Correct mobile tabs component padding so labels/icons are visually aligned, spacing is consistent, and touch targets remain usable. Check narrow screens and overflow.
- Add smooth opening and closing animations to the bottom sheets opened by the fourth and fifth bottom navigation items. Keep sheets mounted long enough for exit animation; preserve dismissal, focus behavior, safe-area spacing, and rapid repeated toggling. Respect reduced-motion preferences.
- Add relevant regression coverage and verify mobile layouts; avoid regressing desktop behavior. Coordinate with FT23 and FT24 without expanding their scope or duplicating their fixes.

This item registers the request only; no implementation or root-cause verification has been performed.
