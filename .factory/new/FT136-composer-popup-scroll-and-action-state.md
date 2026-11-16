# Composer popups: remove excess scroll space and false action selection

## factory · 2026-11-16 17:53

Owner request:
> The composer's plus-button and LLM-profile popups have scrollable content much taller than their actual items, creating unnecessary scrollbars. The plus-button popup should not need scrolling; the LLM-profile popup should scroll only when there are many profiles. The plus-button popup should not preselect its first item because its items are actions, not selections.

Scope and acceptance:
- Inspect the composer plus-button action popup and LLM-profile picker for excess scroll height, blank space, sizing constraints, and overflow behavior; establish the cause rather than assuming it.
- Size both popups to their actual content when it fits the available viewport; remove artificial empty scroll space and unnecessary scrollbars.
- The plus-button popup's normal action list needs no scrolling. Keep every action reachable on unusually constrained viewports without introducing artificial overflow.
- The LLM-profile picker scrolls only when its real content exceeds the available height, such as with many profiles; verify short and long profile lists.
- Do not render the first plus-button action as selected when opening the popup. These are actions, not persistent choices; retain appropriate keyboard focus and hover indicators without presenting them as selected.
- Preserve the actual selected-profile indication in the LLM-profile picker, popup placement, dismissal, and action activation.
- Verify mobile and desktop, constrained viewport heights, and keyboard navigation; add regression coverage for content sizing, real overflow, and the absence of a default selected action.

Requested status: new. Implementation and root-cause investigation are pending.
