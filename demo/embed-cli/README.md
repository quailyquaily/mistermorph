# Demo: Embed `mister_morph` as a CLI subprocess

This shows how another Go project can call the `mister_morph` binary as a subprocess and parse its JSON output.

## Run

1) Build `mister_morph` (from repo root):

```bash
cd mister_morph
GOCACHE=/tmp/gocache GOPATH=/tmp/gopath GOMODCACHE=/tmp/gomodcache go build ./cmd/mister_morph
```

2) Run the demo (from `demo/embed-cli/`):

```bash
export MISTER_MORPH_BIN=../../mister_morph/mister_morph
export OPENAI_API_KEY="..."
GOCACHE=/tmp/gocache GOPATH=/tmp/gopath GOMODCACHE=/tmp/gomodcache \
  go run . --task "Search for OpenAI and fetch the first result"
```

Notes:
- Agent logs go to stderr; the final JSON output is captured from stdout and printed as pretty JSON.

