# Troubleshoots

This document tracks currently known issues and suggested workarounds.

## 1. Cloudflare provider: tool calling is currently unavailable

Symptoms:

- With `llm.provider=cloudflare`, tool calls are not returned reliably even when tools are provided.
- Setting `llm.tools_emulation_mode=force` does not fix the issue.

Status:

- Root cause is still under investigation. Treat this as a known limitation.

Workarounds:

- Do not use `cloudflare` for tool-calling workloads for now.
- Switch to another provider (for example `openai` or `gemini`) when tool execution is required.

## 2. Gemini: use the native provider

Recommendation:

- Use `llm.provider=gemini` (native Gemini provider).
- Do not use OpenAI-compatible mode for Gemini (for example: `llm.provider=openai_custom` with a Gemini-compatible endpoint).

Example:

```yaml
llm:
  provider: gemini
  model: "gemini-2.5-pro"
  api_key: "${GEMINI_API_KEY}"
```
