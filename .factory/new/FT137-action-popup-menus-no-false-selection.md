# Action popup menus: remove false selected-item styling

## factory · 2026-11-16 18:20

Owner request:
> Most popup menus contain actions, not selections. For example, on mobile, Settings → Models → the top-right menu should not have a selected item.

Scope and acceptance:
- Reproduce the selected-item appearance in the mobile Settings → Models top-right popup menu and inspect its cause.
- Audit action-only popup menus for the same behavior; opening an action menu must not mark the first item or another action as a persistent selection.
- Distinguish action menus from genuine choice pickers. Preserve selected-state indicators where they represent a real current choice, such as the LLM-profile picker.
- Keep keyboard focus, hover, and pressed feedback accessible and visually distinct from persistent selection; do not remove keyboard navigation or focus visibility to hide the issue.
- Preserve action activation, dismissal, and popup positioning. Verify the reported mobile case and affected desktop menus.
- Add regression coverage for opening action menus without a selected item and retaining genuine picker selection.
- Related: FT136 covers the composer plus-menu selection and popup sizing; this request extends the action-versus-selection fix to other popup menus without duplicating its scroll-sizing work.

Requested status: new. Investigation and implementation are pending.
