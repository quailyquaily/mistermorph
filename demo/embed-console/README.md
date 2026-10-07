# Demo: Connect a Console to an `integration` program

This demo is a Go program built on `mistermorph/integration` that a Console can connect to. It is the support agent of a made-up Example Shop:

- it has its own tool, `get_order_status`, that answers from a small in-memory order list;
- it serves the runtime API with `rt.ServeRuntimeAPI(...)`, so a Console can add it as an endpoint, chat with it and watch its tasks;
- with `--report-every`, it also runs its own scheduled task, which shows in the Console next to the chats.

## Run

From `demo/embed-console/`:

```bash
export OPENAI_API_KEY="..."
export MISTER_MORPH_ENDPOINT_TOKEN="$(openssl rand -hex 24)"
go run . --report-every 30m
```

It prints the endpoint to add to the Console:

```text
Serving the runtime API on http://127.0.0.1:8790/runtime

Add this program to a Console, in its config.yaml:

  console:
    endpoints:
      - name: "Example Shop"
        url: "http://127.0.0.1:8790/runtime"
        auth_token: "..."
```

Without `MISTER_MORPH_ENDPOINT_TOKEN` (or `--token`), it makes up a token at each start and prints it.

## Connect the Console

Add the block above to the Console's `config.yaml` (reference the token as `"${MISTER_MORPH_ENDPOINT_TOKEN}"` rather than pasting it), or add the endpoint from the Console: **Overview → Add Agent**. Start the Console:

```bash
mistermorph console serve
```

"Example Shop" appears on the Overview next to Console Local. Open it and ask, for example, "Where is order A1001?": the answer comes from the program's `get_order_status` tool.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--listen` | `127.0.0.1:8790` | Address the runtime API listens on (`server.listen`). |
| `--token` | `$MISTER_MORPH_ENDPOINT_TOKEN` | Bearer token the Console must send (`server.auth_token`); empty makes one up. |
| `--state-dir` | `./state` | Where the program keeps its tasks, topics, usage and logs (`file_state_dir`). |
| `--provider` | `openai` | `llm.inference_provider`. |
| `--model` | `gpt-5.2` | `llm.model`. |
| `--api-key` | `$OPENAI_API_KEY` | `llm.api_key`. |
| `--endpoint` | | Base URL of an OpenAI-compatible API (`llm.endpoint`), with `--provider openai_chat_compatible`. |
| `--report-every` | `0` | Run the order report this often; `0` runs none. |

See [Connect a Console to Your Program](../../web/vitepress/docs/guide/connect-console.md) for how chats run and what the Console can do with this endpoint.
