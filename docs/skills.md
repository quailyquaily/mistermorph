---
title: Skills
---

# Skills

`mister_morph` supports “skills”: small, self-contained folders that contain a `SKILL.md` file (required) plus optional scripts/resources. Skills are discovered from a set of root directories and can be loaded into the agent prompt either explicitly or via an LLM-based “router”.

Important: a skill is **not automatically a tool**. Skills add prompt context; tools are registered separately (e.g. `url_fetch`, `web_search`). If a skill includes scripts that you want the agent to execute, you must enable the `bash` tool (or implement a dedicated tool).

## Discovery and priority (dedupe)

Skills are discovered by scanning roots recursively for `SKILL.md`.

Default roots (highest priority first):

1. `~/.morph/skills`
2. `~/.claude/skills`
3. `~/.codex/skills`

If the same skill `id` appears in multiple roots, the first root wins (higher priority). This avoids duplicates and allows you to override a built-in or shared skill by installing a modified copy into `~/.morph/skills`.

## Listing and inspecting skills

- List: `mister_morph skills list`
- Show one skill: `mister_morph skills show <skill>`

`<skill>` can be either a skill `id` or a directory name.

## How skills are chosen (selection modes)

Skill loading is controlled by `skills.mode`:

- `off`: never load skills
- `explicit`: only load skills requested by config/flags and (optionally) `$SkillName` references
- `smart`: use a small router model call to choose skills automatically (default)

### Explicit selection

You can request skills via config:

- `skills.load: ["some-skill-id", "some-skill-name"]`

If `skills.auto=true`, the agent also loads skills referenced inside your task text as `$SkillName` (e.g. “Use $google-maps-parse to extract coordinates.”).

### Smart selection

In `smart` mode, the agent:

1. Discovers skills (with priority + dedupe).
2. Builds a catalog of `SKILL.md` previews (bytes capped by `skills.preview_bytes`, and total skills capped by `skills.catalog_limit`).
3. Calls the selector model (defaults to `model`, override with `skills.selector_model`) to return a JSON list of skill `id`s to load.
4. Loads up to `skills.max_load` skills into the prompt.

If the selector returns unknown skill ids, they are ignored.

## Installing / updating built-in skills

`mister_morph` ships some built-in skills under `assets/skills/`. To install (or update) them into your user skills directory:

- `mister_morph skills install`

By default this writes to `~/.morph/skills`.

Useful flags:

- `--dry-run`: print what would be written
- `--clean`: remove an existing skill directory before copying (destructive)
- `--dest <dir>`: install somewhere else (useful for testing)

After installation, the built-in skills are picked up automatically via the default roots.

## Creating your own skill

Create a folder under one of the roots (recommended: `~/.morph/skills/<my-skill>/`) with this structure:

```
<my-skill>/
  SKILL.md
  scripts/
    ...
  references/
    ...
  assets/
    ...
```

### `SKILL.md` (required)

`SKILL.md` must begin with YAML frontmatter containing at least:

```yaml
---
name: my-skill
description: What this skill is for and when to use it.
---
```

Keep `SKILL.md` small and action-oriented:

- what the skill is for
- the recommended workflow / commands
- where scripts live and how to run them
- any prerequisites (tools, env vars)

Put large reference material in `references/` instead of bloating `SKILL.md`.

### Scripts

Prefer putting deterministic logic into `scripts/` so the agent can run it instead of re-deriving the same parsing/transformations. Make scripts executable when appropriate.

If you want the agent to execute scripts:

- Enable `bash` in config:
  - `tools.bash.enabled: true`
  - optionally `tools.bash.confirm: true` (safer)
  - keep `tools.bash.deny_paths` configured
- In your `SKILL.md`, tell the agent the exact script path to run.
  - Prefer absolute paths like `~/.morph/skills/<skill>/scripts/...`.
  - If you want to use a relative path like `./scripts/...`, include a `cd ~/.morph/skills/<skill>` step in the command.

### Using a skill

- Explicitly in a task: reference it as `$MySkillName` (works when `skills.auto=true`).
- Or add it to `skills.load` for always-on behavior.
