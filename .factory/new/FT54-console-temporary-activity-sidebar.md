# Temporary right sidebar for progress, plans, and agent output

## factory · 2026-11-10 00:50
Requested by the owner:
> New UI feature: design new temporary right sidebar for progress, plan, etc and subagent/ coder output. When clicking them, do not expand in the chat view anymore, instead, open the temporary sidebar. The sidebar and the original right  sidebar, they are mutually exclusive, so only one right sidebar will be shown, another will be close. And of course, use a good transition that fit our design.

Requirements and acceptance criteria:
- Clicking chat entries for progress, plans, and subagent/coder output opens their details in a temporary right sidebar rather than expanding details inline in the chat. Keep compact, identifiable entry points in the conversation.
- Show the selected entry's title/context and full available detail; preserve live updates, formatting, scrolling, and relevant existing actions. Switching entries updates the temporary sidebar without creating extra panels.
- The temporary detail sidebar and the existing right sidebar are mutually exclusive in both directions: opening either closes the other. Maintain a single active right-panel state, including during transitions.
- Provide an obvious close control and keyboard dismissal; return focus appropriately. Closing details must not alter task execution, chat draft, or conversation scroll position. Clear stale detail selection when changing conversation.
- Use restrained transitions consistent with existing Console styling, timing, and easing. Avoid panel overlap, layout flashes, and unnecessary chat scroll jumps; respect reduced-motion preferences.
- On narrow/mobile screens, use the existing responsive panel conventions with safe areas and reachable controls; do not squeeze the chat into an unusable column or restore inline expansion as a fallback.
- Cover opening each supported detail type, switching selections, mutual exclusion in both directions, dismissal, conversation changes, and streaming updates with regression tests. Check desktop/mobile layouts and transitions visually; explicitly report anything not verified.

Queued only; implementation and review have not started.
