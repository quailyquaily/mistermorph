# Choose the name set for subagents and coder

## factory · 2026-11-11 00:55
Requested by the owner in Console; placement and scope confirmed in the discussion.

Add an **Agent name set** dropdown to the **Tools page, below the individual tool settings**. This is a shared preference for both subagents (spawn) and coder, not a setting nested inside either individual tool.

Options:
- Great scientists (default; preserve the existing naming behavior)
- Great musicians
- Great artists

Persist the selected preference and use its name pool for newly created subagent and coder sessions. Existing sessions and historical names must remain unchanged. Changing the name set affects names only, not model selection or agent behavior.

Show a few example names for the selected set and a concise hint that it applies to new subagent and coder sessions. Follow the existing Tools page styling and settings persistence conventions.

Acceptance:
- The control appears below all individual tool settings on the Tools page.
- All three sets are available and survive reload via the existing settings mechanism.
- Both newly created subagents and coder sessions use the selected set.
- Existing names remain stable when the preference changes.
- Missing or invalid stored values safely fall back to Great scientists.
- Add regression coverage for selection/persistence, default fallback, both naming consumers, and unchanged existing names.
