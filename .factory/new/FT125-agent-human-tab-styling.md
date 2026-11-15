# Agent/Human selector: use tab styling

## factory · 2026-11-15 09:26

Owner request:
> Apply tab style to the agent human buttons, they are a tab.
> Add to the new status.

Acceptance criteria:
- Present the existing Agent/Human selector as tabs rather than standalone buttons, using the app's established tab styling and spacing.
- Clearly distinguish the active tab and preserve existing selection, filtering, labels, and counts where present.
- Apply consistently on mobile and desktop without overflow or reduced touch-target usability.
- Preserve keyboard operation and accessible selected-state semantics appropriate to the selector's actual behavior.
- Add regression coverage for switching between Agent and Human and verify active-tab presentation in both viewport sizes.
