---
date: 2026-10-05
title: Other fits for the decision route
status: research
---

# Other fits for the decision route

## Goal

Go through every place in the code that calls the model directly, and find which calls, besides the group reply check, could move to `llm.routes.decision`. This note is research only; no code changes.

For the group check as it stands, see [Group reply decision on Evaluate and the decision route](feat_20260922_group_decision_evaluate.md).

## Criteria

The decision route is not "a cheaper Chat route". It runs on `llm.Evaluate` (`llm/evaluate.go`), which brings hard limits:

- There are only three answer kinds: `Boolean`, `Score` and `Choice`. There is no free-text answer, so the model cannot write anything.
- The `typesafe` provider is allowed only on the decision route, and it supports only Evaluate, not Chat (`internal/llmutil/llmutil.go:446`, `providers/uniai/client.go:143`). Any call moved to this route must therefore switch to Evaluate; it cannot keep using Chat.
- A `Choice` has at most 255 options (the native TypeSafe limit).
- Input goes in `State`, as data to judge, not as instructions.

So a call fits the decision route only when all of these hold:

1. **The output is a closed set.** The answer can be yes/no, a level, or one of a fixed list, and the program can carry on from the answer alone.
2. **No text is needed.** Nothing is shown to the user or written back to a file or message.
3. **A wrong answer is survivable.** The program can contain the mistake (an error, asking the user, staying quiet), with no hard-to-undo action and no security impact.

The route supports `candidates` and `fallback_profiles` (`internal/llmutil/evaluate_client.go`), so moved calls can still have backup profiles.

## All calls

Scope: every non-test `Client.Chat` and `llm.Evaluate` call outside the provider wrappers.

| # | Call | Where | Route today | Output | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | Group reply check | `internal/grouptrigger/evaluate.go`, via each channel's `trigger.go` (Telegram, Slack, Lark, LINE, Discord) | decision | Boolean / Score / Choice | Already uses it |
| 2 | Matching a TODO to delete | `internal/cron/semantic_llm.go:22` | Current task's main client | `matched` + index / `no_match` / `ambiguous` | **Fits** |
| 3 | TODO contact references | `internal/todo/reference_llm.go:65` | Current task's main client | The whole sentence, rewritten | Partly, if split; not recommended for now |
| 4 | Console topic title | `cmd/mistermorph/consolecmd/local_runtime.go:2862` | main_loop | Title text + icon | No |
| 5 | TUI topic title | `cmd/mistermorph/chatcmd/local_topics.go:56` | Main client | Title text + icon | No |
| 6 | Console progress summary | `cmd/mistermorph/consolecmd/stream_observer.go:31` | main_loop | One or two sentences of progress | No |
| 7 | Skill install review | `internal/skillinstall/review.go:53` | Passed in by the caller | Summary, capabilities, findings with quoted evidence | No |
| 8 | Remote skill file planning | `cmd/mistermorph/skillscmd/skills_install_builtin.go:900` | Passed in by the caller | File URLs, paths and risks | No |
| 9 | Context compaction checkpoint | `agent/context_compaction_engine.go:330` | Current task's main client | Checkpoint summary | No |
| 10 | `plan_create` | `tools/builtin/plan_create.go:168` | plan_create | Plan steps | No |
| 11 | Main loop / think | `agent/engine.go`, via `taskruntime` | main_loop / think | Replies and tool calls | No |
| 12 | Heartbeat / awareness task | `internal/channelruntime/awareness/run.go:373` | awareness / heartbeat | A full agent run | No |
| 13 | Settings-page model test | `internal/llmbench/bench.go` | The profile under test | Chat text, JSON and tool-call tests | No |

These hold a client but do not generate anything, so they are not listed:

- `internal/topiccontext/count.go`: counts tokens only.
- `PromptSpecWithSkills` in `internal/skillsutil/skillsutil.go`: takes a client, but picks skills without calling it.
- `internal/llmstats`, `internal/llminspect`, `request_retry.go` / `route_client.go` in `internal/llmutil`, and the `taskruntime` client wrappers: they only pass calls through.

## Fits: matching a TODO to delete

> **Implemented (2026-10-06):** when the decision route has its own profile and `todo_update` is enabled, `taskruntime` passes the decision client to the tool, and `cron.LLMSemanticResolver` asks one Evaluate choice (`task_<i>`, `no_match`, `ambiguous`; scene `todo.delete_match`). It falls back to Chat when Evaluate is unsupported or there are more than 253 tasks; an invalid answer is an error. Awareness runs (heartbeat, cron) still use the Chat path.

### Today

When `todo_update` deletes a task, `cron.Store` calls `MatchTaskIndex` so the model can pick, from the tasks in `cron.yaml`, the one the user wants deleted (`internal/cron/store.go:166`). It uses Chat with `ForceJSON` and returns one of three statuses:

- `matched` + `index`: delete that task.
- `no_match`: error, "no matching task".
- `ambiguous` + `candidate_indices`: error, "match is not unique". The candidate indices are only range-checked; they are never passed back to the caller.

The client is the current task's main client (`internal/toolsutil/runtime_register.go:85`; in awareness tasks, the task client). So every delete has the main model answer a multiple-choice question.

### Why it fits

- The output is already a closed set; the model writes nothing.
- The `ambiguous` candidates are thrown away today, so a single choice loses nothing.
- Mistakes are contained: `no_match` and `ambiguous` only return errors, and the agent goes back to the user. The one real risk is picking the wrong task; see "Risks".

### Design sketch

One `Choice` question:

- Options: a stable id per task, `task_0` … `task_{n-1}`, plus `no_match` and `ambiguous`.
- Each task option's description carries its `name`, `cron`, `tz` and `content`, as the payload does today.
- `State` holds the user's delete request, `query`.
- The instructions keep today's rules: choose `no_match` when unsure, and `ambiguous` when several tasks are plausible.

The program maps `task_i` back to an index. The other two options keep today's error messages, so `Store` doesn't change.

With more than 253 tasks the options don't fit. Then keep the current Chat path, or narrow the candidates by keyword before asking.

### Wiring

`todo_update` only receives the main client today. Its registration needs to take a decision-route client as well:

- Channel runtimes already build a decision client in `channel_bootstrap.go` (`AddressingClient`), which can be reused.
- The Console local runtime, the `run` command and awareness tasks each need to resolve `RoutePurposeDecision` themselves.

Fallback: when the decision client doesn't support Evaluate (`llm.ErrEvaluateUnsupported`) or wasn't built, use the existing Chat path. When Evaluate returns an invalid answer, return an error; don't guess an index.

### Risks

- **A wrong pick deletes the task straight away**, with no confirmation. A smaller model is more likely to confuse similar tasks. Before switching, run a comparison set (similar names, same cron, requests in different languages) and check that the small model is no more eager than the main model to commit when it should say `ambiguous`. Alternatively, echo the deleted task in the result so the user can notice and restore it.
- Name the scene `todo.delete_match` so it shows separately in the usage stats.

## Partly fits if split, not recommended for now: TODO contact references

`ResolveAddContent` does three things in one call: maps names to contact ids, rewrites relative times as `YYYY-MM-DD hh:mm`, and rewrites the sentence naturally with `[Name](protocol:id)` links. The last two need text, so the call can't move as it is.

"Which contact does this name mean" is a choice question: one `Choice` per `people` entry, with the reachable contact ids plus `unresolved` as options. Split that way, the flow would be:

1. The decision route picks a contact id per person.
2. The program, or the main model, writes the links back into the sentence and handles the time rewrite.

Not recommended now:

- The time rewrite still needs a Chat call, so splitting increases the number of calls.
- Putting links back into the original sentence means finding each name in it; same names, pronouns ("I", "him") and other languages make that error-prone.
- Many contacts can exceed 255 options.

Revisit if time parsing moves into code and the rewrite becomes a plain name substitution.

## Do not fit

| Call | Why |
| --- | --- |
| Topic titles (Console and TUI) | The title is text for the user. The icon is a choice, but it comes from the same call; splitting it out only adds a request. |
| Console progress summary | The output is progress text for the user. |
| Skill install review | Needs a summary, reasons and quoted evidence; it's a security judgment where a miss is costly, so it should stay on the main model. |
| Remote skill file planning | Outputs URLs and paths to download, an open set. |
| Context compaction checkpoint | Outputs a summary, and small models drop facts. Whether to compact is decided by token ratio, not by a model. |
| `plan_create` | Outputs plan text, and already has its own `plan_create` route. |
| Main loop / think | Needs full replies and tool calls. |
| Heartbeat / awareness | Full agent runs, with their own `awareness` and `heartbeat` routes. |
| Settings-page model test | Tests the chosen profile's Chat ability, so it can't switch routes. The decision route needs its own Evaluate test; see below. |

## Follow-ups

- The settings-page model test only covers Chat; passing it doesn't mean Evaluate works. The decision connection test listed as not implemented in the [group decision doc](feat_20260922_group_decision_evaluate.md) is still needed, more so if delete matching moves over.
- No call today asks "is this worth doing?" before starting a full task. The lightweight reply pre-check is one such new gate; see [Lightweight reply pre-check](feat_20261006_lightweight_precheck.md). Others (such as checking whether a heartbeat has anything to do) would change behavior and are out of scope here.

## Conclusion

Among existing calls, only **matching a TODO to delete** meets all three criteria and can move to the decision route. Moving it means switching to an Evaluate `Choice` question, giving `todo_update` a decision client, and keeping the Chat path as a fallback. Every other call either has to write text or is too costly to get wrong, and should stay as it is.
