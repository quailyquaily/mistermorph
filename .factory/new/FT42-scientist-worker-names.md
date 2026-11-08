# Use famous scientist names for subagent and coder workers

## factory · 2026-11-09 07:06
The owner explicitly requested this feature and placement in new via Console:
> new feature request: use the famous scientist names to build the subagent / coder name list. Put it to new.

### Requirements
- Replace the current ordinary-person name pools with curated names of famous scientists for both subagents and coder workers, including nested workers.
- Use recognizable names, for example Einstein, Curie, Newton, Darwin, and Noether. These are examples, not an exhaustive or mandatory list.
- Preserve supported Console languages, using conventional localized scientist names where available and a consistent fallback otherwise. This supersedes FT21's ordinary native-person name requirement, not its identity or allocation guarantees.
- Keep existing random allocation, task-wide duplicate avoidance, exhaustion suffixes, and stable assignments across refresh, reconnect, replay and approval resume. Locale changes must not alter worker identity; switching back restores the name.
- Apply the same naming consistently to every worker-name surface. Keep execution identifiers, event associations, avatars and main-agent identity unchanged.
- Preserve readability of existing histories and handle existing persisted name indices safely when changing the pools.

### Acceptance checks
- Tests cover scientist pools and localized names, both worker types and nested workers, consistent display across surfaces, pool exhaustion, locale round trips, persisted assignments and legacy histories.
- Run repository-required checks and the Console checks if affected.

Queued in new at the owner's request. This intake does not implement or release the feature.
