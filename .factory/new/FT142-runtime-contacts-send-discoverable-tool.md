# Ordinary runtime: discoverable contacts send tool

## factory · 2026-11-17 18:45

Owner request:
> Add a tool for sending messages to ordinary contacts in the ordinary runtime as well. Do not provide it by default, but allow it to be found through tool search.

Scope and acceptance:
- Provide a contacts-send capability for ordinary human contacts in the ordinary runtime, not just Agent messaging or Console-only functionality. Inspect and reuse existing contact resolution and delivery infrastructure where available; confirm the canonical tool name during implementation.
- Keep this tool out of the default tool set supplied to the model. Register it in the searchable tool catalog so `tool_search` queries such as `contacts send` and the canonical tool name discover it, and the discovered tool can be invoked normally.
- Describe target identifiers, required message inputs, supported delivery routes, and errors accurately in the tool schema/help. Resolve recipients using existing contact identifiers; do not silently substitute another recipient or channel.
- Preserve existing permissions, recipient restrictions, credential handling, and delivery safeguards. Discovery must not bypass authorization, and unsupported or unreachable recipients must return clear failures rather than claim successful delivery.
- Add regression coverage for absence from the default tool set, discovery via tool search, invocation after discovery, successful delivery through the existing delivery path, and invalid/unsupported recipients or delivery failure.
- Keep existing `contacts_list` and `agent_send` behavior unchanged; this request is not an instruction to send any message now.

Requested status: new. Investigation and implementation are pending.

## factory · 2026-11-17 18:46

Owner clarification: "Ordinary runtime" includes Console, Telegram, Slack, and similar regular conversation runtimes. It does not mean only a CLI/headless runtime or only Console.

- Make the contacts-send tool searchable and callable after discovery in Console, Telegram, and Slack runtimes, while keeping it absent from each runtime's default model-visible tool set.
- Check registration and discovery/invocation coverage across those runtimes; do not implement this as a Console-only capability. Preserve the existing delivery and authorization safeguards in every runtime.
