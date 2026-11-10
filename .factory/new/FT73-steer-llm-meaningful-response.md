# Handle every steer command or message through the LLM with a meaningful response

## factory · 2026-11-10 22:30
Owner request:
> new feature request: for each steer cmd or steer message, the agent need to handle it via llm and give a meaningful response. replace the emoji only response.

Add to new/ as a feature request; implementation has not started.

Acceptance criteria:
- Every accepted steer command or steer message is processed by the LLM with the relevant conversation and active-task context, rather than handled solely by a fixed emoji acknowledgement.
- Return a meaningful, user-visible textual response addressing the specific steer input (for example, how the request changes the ongoing work, an answer, or a necessary clarification). An emoji-only response does not satisfy this requirement.
- Preserve steering of the active task; a response must not replace or silently discard the requested steering. Do not claim work is completed merely because steering was received.
- Ensure each accepted input is accounted for when multiple steer messages arrive while work is running; avoid lost inputs and duplicate replies.
- If processing fails or steering cannot be applied, show an explicit failure or limitation rather than an emoji-only acknowledgement or a false success.
- Cover both command and message entry paths, active-task steering, successive inputs, and failure handling with regression tests.

Scope: replace emoji-only steer responses; do not remove unrelated emoji reactions elsewhere.
