---
date: 2026-10-08
title: Subagent Context Isolation and Model Profile Selection
status: implemented
---

# Subagent Context Isolation and Model Profile Selection

## Goal

When a subtask is expected to produce a lot of intermediate content, the main model should consider `spawn`, and pick a model profile for the subagent that fits the task.

This change has five parts:

1. Describe in the prompt when delegating helps keep the main context small.
2. Replace the `spawn` parameter `model` with `model_profile`.
3. Add a `list_model_profiles` tool, registered in the runtime when more than one profile can be chosen.
4. Add an optional `description` to profiles, returned together with the profile name and model name.
5. Add an optional `abilities` list to profiles, so `spawn` only accepts profiles that can do text chat.

## Current Behavior

- The main model decides when to call `spawn`. There is no automatic trigger based on task complexity, duration or token count.
- The tool description tells the model to delegate self-contained subtasks, but does not mention keeping intermediate content out of the main context. It also says "Use this to parallelise independent work items", which is wrong: the call blocks until the subagent finishes.
- `spawn.model` only carries a model name. It is applied on the parent's connection, so it cannot pick a different provider, connection or reasoning setting.
- When `model` is omitted, `spawn` copies the parent's default model name into `SubtaskRequest.Model` (`agent/spawn_tool.go`). Runners cannot tell "omitted" from "set".
- `internal/llmutil` already has `ListProfiles` (`default` first, the rest sorted by name), `ResolveProfile` and `ResolveRouteWithProfileOverride`. `internal/llmselect` and `integration` expose profile queries on top of them.
- `ListProfiles` fails as a whole when any one profile fails to resolve.
- Profiles have no `description` and no way to declare what they can be used for.
- Subtasks run through two runners:
  - The task runtime runner (`boundSubtaskRunner`) holds the parent's main route after the weighted candidate is picked and the reasoning effort override is applied, so it already inherits the parent's configuration.
  - The local runner (`localSubtaskRunner`), used by callers that construct an engine directly, always reuses the parent's client. `SubClientFactory` exists but has no production callers.
- Building a client for a non-decision route already rejects the `typesafe` provider (`internal/llmutil/llmutil.go`).

## Delegation Guidance

Only when `spawn` is available, add prompt guidance with this meaning:

> If a self-contained subtask is expected to produce a lot of intermediate content, and the main task only needs a small conclusion from it, consider `spawn`. Give the necessary background, a clear goal and what to return. Ask the subagent for a concise conclusion with the evidence needed to check it, not the full raw content. Do simple tasks directly.

Examples: searching and filtering web pages, analyzing long logs, inspecting many files and summarizing findings. Whether the content deserves a place in the main context is a better reason to delegate than the length of the task.

The main model should put the background the subtask needs into `task`, and not assume the subagent shares the conversation history. The return requirements should keep what is needed to verify the conclusion, such as source links, file locations or key excerpts.

When `list_model_profiles` is available and the main model wants a different configuration for a subtask, tell it to call that tool. If the current context already has a result, it can reuse it; it does not need to call the tool before every `spawn`.

This is decision guidance for the model. It adds no automatic splitter and no forced delegation threshold.

## Profile Description

Add optional config fields:

- `llm.description`: description of the `default` profile (the top-level config).
- `llm.profiles.<name>.description`: description of a named profile.

The person writing the config fills it in: what the profile is good for, its main limits, and whether it leans toward speed or cost. For example:

```yaml
llm:
  description: "Complex analysis and reviewing results."
  profiles:
    fast:
      description: "Extraction, classification and short summaries; favors speed."
      # Configure provider, model, credentials, etc. for this profile as usual.
```

This shows only the new field, not a full connection config. Named profiles keep the existing rule of being configured independently; they do not inherit the top-level description or connection fields.

`description` is only a hint for choosing. It does not change routing and is not treated as a system instruction. When missing, it is returned as an empty string; nothing is generated from the model name about capability or price.

Places that must carry the field, so saving config does not drop it:

- `llmutil.ProfileConfig` (named profiles) and the values used to resolve `default` (top-level `llm.description`).
- `llmselect.ProfileInfo` and `integration.LLMProfile`.
- Settings payloads and the settings writer. Settings saves `llm.profiles` as a whole array, so the console forms (`web/console/src/components/LLMConfigForm.js`, `web/console/src/views/SettingsView.js`) must send `description` back, or saving from the UI deletes it. The forms should show it as an editable field.
- `assets/config/config.example.yaml`.

## Profile Abilities

Add optional config fields:

- `llm.abilities`: abilities of the `default` profile.
- `llm.profiles.<name>.abilities`: abilities of a named profile.

`abilities` is an array of strings. Allowed values:

| Value | Meaning |
| --- | --- |
| `text` | Text chat with tool calls; can run an agent loop, including a subagent. |
| `image` | Image generation and editing (`routes.image`). |
| `decision` | Evaluate requests (`routes.decision`). |

An empty or missing list means the profile has all abilities, so existing configs keep working unchanged. Named profiles do not inherit the top-level `abilities`.

```yaml
llm:
  profiles:
    painter:
      description: "Image generation."
      abilities: ["image"]
```

Values are trimmed, lowercased and deduplicated. An unknown value is a config error for that profile, reported like other profile resolution errors.

In this change, only the query tool and `spawn` read `abilities`: a profile is a subagent candidate only if its abilities include `text`. Existing routes (`main_loop`, `image`, `decision`, ...) do not enforce it yet. The provider check stays as well: a `typesafe` profile is never a subagent candidate, even with empty `abilities`, because the provider cannot chat.

`abilities` is carried through the same places as `description` (config structs, query structs, Settings, console forms, `assets/config/config.example.yaml`). The console shows it as a multi-select of the three values, where selecting none means all.

## Query Tool

Add a read-only tool with no parameters, `list_model_profiles`. It reuses the existing profile resolution and returns only what is needed for choosing:

```json
{
  "profiles": [
    {
      "name": "default",
      "model": "configured-default-model",
      "description": "Complex analysis and reviewing results.",
      "current": true
    },
    {
      "name": "fast",
      "model": "configured-fast-model",
      "description": "Extraction, classification and short summaries; favors speed."
    },
    {
      "name": "broken",
      "model": "",
      "description": "",
      "error": "llm.profiles.broken.request_timeout: invalid duration \"ten\""
    }
  ]
}
```

`current` is `true` on the entry for the configuration the parent task is running on (the manually selected profile, or the weighted candidate picked for this run), and omitted elsewhere. It lets the model tell whether a profile is actually a change; choosing the current profile by name is the same as omitting `model_profile`, except that it resolves the profile again instead of reusing the parent's route.

Model names above are placeholders; the tool returns the resolved model names. It never returns credentials, headers or endpoints.

Registration and listing rules:

1. Candidates are `default` plus every named profile whose `abilities` include `text` (empty means all), excluding profiles whose provider is `typesafe` (Evaluate only). Excluded profiles do not appear in the list at all. Do not add a capability scoring system for this.
2. Register the tool when there is more than one candidate; do not register it when there is only one.
3. Order: `default` first, the rest by name (the order `llmutil.ListProfiles` already uses).
4. The list and the subtask selection use the same runtime config, so what is shown matches what is resolved.
5. Resolve each profile on its own. A profile that fails to resolve stays in the list with an `error` field describing what went wrong, so the model can pick another profile or omit `model_profile`. The error only appears in the tool output (and stays in the conversation history from there); it is not added to the prompt. One broken profile does not fail the whole tool or block the main task. If the config as a whole cannot be read (for example, the routes fail to parse), the tool returns that error instead of an empty list.

Registering the query tool must not bypass the subtask's existing tool whitelist.

## `spawn` Parameter and Selection Rules

Remove the `model` parameter and add an optional string parameter `model_profile`, whose value is a profile name:

```json
{
  "task": "Check the given log for the cause of the failure. Return the conclusion, the key error excerpts and their locations.",
  "tools": ["read_file"],
  "model_profile": "fast"
}
```

Behavior:

| Parameters | Behavior |
| --- | --- |
| `model_profile` omitted or empty | Keep the configuration the parent task already selected. Do not draw a new weighted route candidate. |
| `model_profile` set | Use that profile's full configuration for this subtask only. |
| `model` passed | Return an error saying `model` was replaced by `model_profile`. Do not silently ignore it. |

`spawn` no longer fills in the parent's model name. `SubtaskRequest.Model` is replaced by `SubtaskRequest.ModelProfile`; `spawn` is its only producer today.

A selected profile uses its own provider, connection, credentials, model and inference settings, including reasoning effort. The parent's reasoning effort override is not passed on, and the profile's model name is never applied to the parent's connection. Choosing `default` explicitly means the top-level config, not "inherit from the parent".

Return a clear error, without starting the subtask, when:

- the profile does not exist;
- the profile fails to resolve (the error says what failed, as in the query tool);
- the profile's `abilities` are set and do not include `text`;
- the profile's provider is `typesafe` (it supports only Evaluate, not agent chat);
- the runner has no profile resolver.

The error should tell the model it can choose another profile or omit `model_profile` to use the parent's configuration. `model_profile` is never dropped silently in favor of the parent model.

Fallbacks reuse `ResolveRouteWithProfileOverride` with the `main_loop` purpose: if the selected profile fails at request time, the subtask may fall back to the profiles in `routes.main_loop.fallback_profiles`, which can include the parent's model. There is no subagent-specific fallback config. Parameter and profile validation failures do not trigger model fallback.

Selecting a profile for a subtask does not change the session's main profile. The existing tool whitelist, the one-level subtask depth limit and the result envelope keep their current contracts.

## Implementation Scope

Pass information through the existing structure:

- Profile config and query structs carry `description` and `abilities`; `abilities` values are validated when the profile is resolved.
- Runtime assembly prepares the candidate list and registers the query tool based on the count.
- `spawn` validates parameters and passes the profile name in `SubtaskRequest.ModelProfile`.
- Runners use the existing profile resolver and client creation to pick the subtask configuration:
  - Task runtime runner: with no profile, keep using the bound parent route. With a profile, resolve the route with `ResolveRouteWithProfileOverride(values, "main_loop", name)` and pass it as `RunRequest.Route`, with `RunRequest.Model` left empty so the route's model is used.
  - Local runner: replace the unused `SubClientFactory(prefix)` with an explicit dependency that takes a profile name and returns a client and model name (or an error). The engine does not read global config itself. With a profile, the subagent also uses that profile's prompt cache setting instead of the parent's.
- The subagent candidate check (`abilities` include `text`, provider is not `typesafe`) is one shared helper used by both the query tool and `spawn`.
- The runtime passes the parent's selected profile name to the query tool so it can mark `current`.
- The prompt adds the delegation and query guidance based on which tools are available.
- Subtask start events and logs report the resolved model and the profile name.

`spawn` stays synchronous. No parallel scheduling, async task API, automatic model scoring or price comparison. The tool description must say the call blocks, and drop the line about parallelizing.

## Order and Acceptance

For each phase that changes runtime logic, add the tests first and run them to confirm they cover the target behavior, then implement. Docs and UI text are exempt from tests per repository rules.

### Phase 1: Profile Description, Abilities and Query

- [x] `description` is optional and read for both `default` and named profiles; named profiles do not inherit the top-level description.
- [x] Settings, the console forms and existing query APIs keep the description on read and write.
- [x] `abilities` is optional and read for both `default` and named profiles; empty means all abilities; named profiles do not inherit it; unknown values are reported as profile errors.
- [x] Settings, the console forms and existing query APIs keep `abilities` on read and write.
- [x] The query tool returns only `name`, `model`, `description`, `current` for the parent's profile, and `error` for profiles that failed to resolve, in a stable order.
- [x] Profiles whose `abilities` do not include `text` do not count as candidates and do not appear in the list.
- [x] One profile failing to resolve shows up as an `error` entry; the other profiles are still listed.
- [x] `typesafe` profiles do not count as candidates and do not appear in the list.
- [x] The tool is not registered with one candidate, and is registered with more than one.
- [x] Querying uses resolved config only and makes no model requests.

### Phase 2: Subtask Profile Selection

- [x] Both runners can select a profile with a different provider from the parent, and the client config matches the selected profile.
- [x] Without `model_profile`, the subtask keeps the parent's selected configuration, including a manually selected profile and the weighted candidate result.
- [x] A selected profile uses its own reasoning effort, not the parent's override.
- [x] Passing `model` returns an error that points to `model_profile`.
- [x] Unknown, unresolvable, non-`text` and `typesafe` profiles, and a missing profile resolver, return clear errors without starting the subtask.
- [x] Subtask selection does not change the parent task or session config; the tool whitelist and depth limit still apply.
- [x] Tests use a stub client and need no real model service or database.

### Phase 3: Prompt and Docs

- [x] Delegation guidance appears only when `spawn` is available, and asks for a concise result with the evidence needed.
- [x] Query guidance appears only when the query tool is available, and does not require repeated queries.
- [x] The `spawn` description matches its synchronous behavior.
- [x] Update `assets/config/config.example.yaml` and the subagent docs (`docs/tools.md`).
- [x] Related regression tests pass; record the commands and results.

## Implementation Notes

- `llmutil`: `NormalizeAbilities`, `HasAbility`, `CheckSubagentProfile`, `ListSubagentProfiles` and `ResolveSubagentRoute` (`internal/llmutil/subagent_profiles.go`). `ResolveProfile` validates `abilities`, so an unknown value is reported by Settings validation, `/model` listing and `list_model_profiles`; `ResolveRoute` (the main route) does not check it.
- `agent`: `SubtaskRequest.ModelProfile`, `SubtaskProfileError`, `WithModelProfiles` (registers `list_model_profiles` and its prompt block next to `spawn`), `WithSubtaskProfileResolver` (replaces `WithSubClientFactory` for the local runner). The delegation block is added whenever `spawn` is registered.
- Runtime: `depsutil.CommonDependencies.LLMValues` is the one new dependency, set wherever the dependencies are built. The task runtime runner and heartbeat/cron (awareness) runs, which use the local runner, share `taskruntime.ModelProfileLister` and `taskruntime.SubtaskProfileResolver`.
- Settings: `description` is in the main model form, under the model, for the default profile and named profiles, and is saved through the LLM settings payloads. `abilities` is in the Advanced section: the profile form for named profiles, and the generic `llm.abilities` config field for the default profile; string list fields now check `Enum` per item.

## Verification

Run on 2026-10-08:

- `go test ./...`: all packages pass.
- `go vet ./...`: no findings.
- `cd web/console && pnpm build`: builds.
