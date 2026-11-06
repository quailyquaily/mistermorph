# Two-Level Subtask Nesting

## Goal

Let a sub-agent delegate once more. The main task (depth 0) can start sub-agents (depth 1), and
those can start their own sub-agents (depth 2). A depth 2 sub-agent cannot go deeper.

## Behavior

- The limit is `agent.SubtaskMaxDepth = 2`, fixed and not configurable. `agent.ValidateSubtaskStart`
  rejects a subtask started at depth 2 with `subtask depth limit reached (max=2)`; the local runner
  and the task runtime return that as a failed envelope without calling the callback or the model.
- `spawn` gives a sub-agent its own `spawn` only when the parent lists `spawn` in `tools`
  (`SubtaskRequest.AllowSpawn`) and the sub-agent runs below the limit (`agent.SubtaskCanSpawn`).
  The parent's `spawn` instance is never copied into the child registry.
- The sub-agent's `spawn` looks tools up in the sub-agent's own registry, so each level can only
  narrow the whitelist. Other engine tools are not added on their own; `coder` reaches a
  sub-agent only through its whitelist.
- A depth 1 sub-agent with `spawn` also gets `list_model_profiles` and model profile selection:
  the task runtime builds its engine like any run on its route; the local runner passes the
  parent engine's profile resolver and lister, with `current` on the sub-agent's own profile.
- `coder` and `bash` `run_in_subtask` share the limit: below depth 2 they start a direct subtask;
  at depth 2 `coder` fails and `bash` runs the command in place.
- Cancellation, deadlines and result envelopes are unchanged; each level reports its child's
  envelope as the `spawn` result, and children stop with the parent's context.
- Insights, memory reminders and other root-only behavior stay limited to depth 0.

## Tests

- `agent/subtask_depth_test.go`: local runner nesting to depth 2 with leaf tool lists, whitelist
  narrowing, nested cancellation, and the depth 0/1 allowed, depth 2 rejected table.
- `internal/channelruntime/taskruntime/subtask_depth_test.go`: the same chain through the task
  runtime, including a model profile picked at depth 1, and nested cancellation.
- `coder` and `bash` tests for running at depth 1 and stopping at depth 2.
