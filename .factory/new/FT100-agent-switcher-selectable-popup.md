# Fix agent switcher selection and reuse the profile-selector popup

## factory · 2026-11-13 00:26
Owner request:
> New UI fix:
> The desktop version agent switch, the avatar drop-down list cannot be selected. But the overview entry works. The agent times do not work. You can use the new popup bubble component(llm profile selector) to re implement it, but the caret direction and popup direction should change 180deg.
> The mobile view can also apply this style, to popup.sa

### Expected behavior
- Fix the desktop avatar/agent-switcher menu: agent entries must be selectable and actually switch to the selected agent. The working Overview entry must keep working.
- Reuse the existing LLM profile-selector popup bubble component/style. Rotate the caret direction and popup opening direction 180 degrees relative to the profile selector, appropriate to the agent-switcher anchor.
- Apply the same popup-bubble style to the mobile agent switcher, with viewport-safe placement and usable touch targets.
- Preserve current-agent indication, labels/avatars, navigation semantics, and closing behavior after selection. Do not change agent data or backend routing.

### Interpretation
- Treat “agent times” as “agent items”: agent rows, contrasted with the working Overview entry.
- Treat the final “sa” as a typing artifact; infer no additional feature.
- Prefer reuse; make only minimal shared-component changes for opposite placement/caret orientation and mobile support.

### Acceptance checks
- Desktop app: select each available agent through the avatar popup and verify the selected agent and corresponding view change; Overview remains selectable.
- Inspect hit testing, layering, and dismissal for lost clicks; determine the actual cause rather than assuming one.
- Verify opposite popup/caret orientation, active-agent indication, repeat switching, outside-click dismissal, Escape, and existing keyboard/focus behavior.
- Mobile: open and select by touch at narrow widths; popup and actionable rows remain visible and usable without clipping.
- Add regression coverage for agent-item selection and Overview navigation, plus applicable popup interaction/placement tests. Run configured repository and Console checks/tests.
- Visually verify desktop and mobile layouts; explicitly record any native-desktop, touch, or visual checks that cannot be performed.

Scope: agent-switcher interaction and popup presentation, plus minimal reusable popup support; no unrelated navigation redesign.
