# Demo: Embed `mister_morph` as a Go library

This shows how another Go project can import `mister_morph` packages and run the agent engine in-process, with project-specific tools.

## Run

From `demo/embed-go/`:

```bash
export OPENAI_API_KEY="..."
GOCACHE=/tmp/gocache GOPATH=/tmp/gopath GOMODCACHE=/tmp/gomodcache \
  go run . --task "List files in the current directory and summarize what this project is." --model gpt-4o-mini
```

Notes:
- This demo uses the OpenAI-compatible provider, so it needs network access to actually run.
- It logs progress via `slog` to stderr; final JSON goes to stdout.

