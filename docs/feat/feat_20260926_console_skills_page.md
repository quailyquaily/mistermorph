---
date: 2026-09-26
title: Skills page, skill install and the skill store
status: implemented (decisions recorded in §8)
---

# Skills page, skill install and the skill store

## 1) Goals

1. Move Skills out of Settings into its own page in the console sidebar, as something to browse
   rather than a configuration section.
2. Let users install a skill they found elsewhere (typically a GitHub link), either on this page
   or by pasting the link into a console chat and asking the agent to install it. Only the web
   console is in scope; channels (Telegram, Slack, …) do not get install tools.
3. Grow the page into a skill store backed by a GitHub repository that accepts third-party
   skills.

Each stage ships on its own; later stages build on earlier ones.

## 2) What exists today

| Area | Today |
| --- | --- |
| Discovery | `skills.Discover` walks `file_state_dir/<skills.dir_name>` (default `skills`) for `SKILL.md` files. Frontmatter: `name`, `description`, `requirements`, `auth_profiles` (`skills/frontmatter.go`). |
| Loading | `skills.enabled` (bool) and `skills.load` (names or ids; empty = all). A `$name` reference in a task loads that skill for the run even when disabled. The system prompt lists loaded skills by name, path and description; the agent reads a skill's `SKILL.md` with `read_file` when it needs it. |
| Console | Settings → Skills: an Enable switch plus "Loaded" and "Available" lists of cards (name, id, description, switch). Data comes from the agent settings API (`skills.loaded`, `skills.available`, `internal/agentsettings`); changes save through the settings save bar. |
| Chat | `/skills` command lists loaded skills. |
| Built-ins | `assets/skills/` (`google-maps-parse`, `jsonbill`, `moltbook`), installed with `mistermorph skills install`. Retired: the page does not list or offer them (§8). |
| Remote install | `mistermorph skills install <SKILL.md URL>` (`cmd/mistermorph/skillscmd/skills_install_builtin.go`): download (512 KiB cap, 20 s timeout) → show the untrusted SKILL.md → confirm → an LLM reviewer extracts only the extra files the SKILL.md says to download (never commands) plus risks → heuristic risk scan → show plan and risks → confirm → write under the skills root only (`safeJoin` rejects absolute paths and `..`). CLI and TTY only. |

The reviewed install pipeline is the part worth keeping. The console work mostly moves it
behind an API and adds provenance.

## 3) Stage 1: the Skills page

### 3.1 Placement

- Desktop sidebar: first group, after TODO (`Chat · Contacts · TODO · Skills`). Skills are
  about the agent itself, like Contacts and TODO; the second group (Usage, Audit) is for
  watching what happened.
- Mobile: under More, next to Usage and Audit. The mobile strip already shows the current
  page's icon in the More slot.
- Icon: `PhMagicWand`, the icon the Settings section used.
- Settings loses its Skills section entirely (no pointer left behind). Tools and MCP stay in
  Settings: they are set up once, while skills are browsed.

### 3.2 Layout

The page shows only what is needed to manage skills and add new ones.

```text
Skills                                               LOAD SKILLS [on]  [+ Add skill]
┌──────────────────────────────────────────────────────────────────────────────────┐
│ jsonbill                                                                   [on]  │
│ Generate PDF invoices from JSON…                                                 │
│ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -  │
│ weather                                                                    [off] │
│ Look up forecasts with wttr.in…                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘

side sheet:  jsonbill                                         [switch]  [x]
             Generate PDF invoices…
             ! Edited since it was added: SKILL.md.   (only when checksums differ)
             SOURCE    owner/repo @ 3f9c2e1 · 2026-09-20   (only for skills added from a link)
             LOCATION / REQUIRES / AUTH PROFILE / FILES   (rows only when they have values)
             > SKILL.md                                    (collapsed)
             ─────────────────────────────────────────────
             [Remove]  → Remove jsonbill? …  [Cancel] [Remove]
```

- A row is the name, the description and a switch; the switch is the loaded state, and skills
  that are off have a quieter name. Search appears only when there are more than 8 skills.
- Add skill (the floating button on phones) asks for a link and starts the install task.
- The Store tab is not on the page for now; the store route and tools stay in the backend.
- The switches save immediately (one small config write); the page has no pending state.
- `skills.load` cannot express "none" (empty means all), so switching off the last loaded skill
  turns skills off and keeps the list, and switching one on while skills are off loads just
  that one (`core/skills-load.js`). The old Settings switches turned "none" into "all".
- The rendered `SKILL.md` is untrusted; the console's markdown renderer (the one chat uses) was
  checked against it: `<script>` is dropped, event-handler attributes are stripped and
  `javascript:` links lose their href. It is collapsed by default so the summary and files
  come first.
- Mobile: the Install action is the floating add button, as on Chat and TODO.
- Empty state: offers Install from a link and Browse the store.

### 3.3 API

The page acts on the selected agent: skills live in each agent's own state dir, and remote
agents are reached through the existing endpoint proxy. The routes sit next to the agent
settings routes on both the daemon (`internal/daemonruntime`) and the console server (the
console's own agent), and read the same settings view, so the page and the agent agree on what
is loaded (`internal/agentsettings/skills_catalog.go`).

| Route | Purpose |
| --- | --- |
| `GET /settings/agent/skills` | Enabled flag, load list, skills roots, read-only state, config revision, and every discovered skill with id, name, description, dir, requirements, auth profiles, loaded flag, file list (dot-folders and the provenance file skipped, capped at 200 files), `source` (from provenance, with `installed_at`) and `modified` (files whose checksum changed since install). |
| `GET /settings/agent/skills/detail?id=<id>` | The same fields plus `SKILL.md` content, capped at 256 KiB. Only discovered skills are readable, so an id cannot reach outside the skills roots. |
| `POST /settings/agent/skills/remove` `{id}` | Deletes the skill's folder (only a direct child of a skills root; a linked folder loses its link, not its target) and drops the id from `skills.load` unless it was the only entry. 404 for unknown ids, 409 for nested skills. |
| `GET /settings/agent/skills/store` | The store index (`skills.store.index_url`, cached for 10 minutes) with `installed`, `installed_version` and `update_available` per entry, matched through provenance `store_id`. 502 when the store cannot be reached. |
| (existing) agent settings update | Switches use the agent settings API's `skills: {enabled, load}` update. |

Agents without these routes answer 404; the page then shows an "update this agent" notice.

### 3.4 Last used

The agent reads a skill's `SKILL.md` with `read_file` before following it, and `$name` loads a
skill explicitly. Last-used time and trigger (chat, channel, cron) can come from the
`tool_call` log/audit records whose path is a skill's `SKILL.md`, plus the `$name` path.
Scanning logs on every page load is slow, so record a small `skill_used` event (skill id, run
id, time, trigger) when either happens, and keep the latest per skill in a projection. This is
optional for Stage 1; the page works without it.

## 4) Stage 2: install from a link

### 4.1 Installing is a task

Installing a skill is an ordinary agent task, so it appears in the topics list like any other
conversation, with its review and outcome kept in the history:

1. Skills page → Install → paste a link. The console posts a task in a new topic and opens it.
2. Chat: the user pastes a link into a console topic and asks the agent to install it.
3. Store: Install or Update on a store card starts the same task with the store id.

The task text (localised, `skills_install_task_*`) asks the agent to call
`skill_install_preview`, explain what the skill does and every risk, and then call
`skill_install`. `skill_install` always needs approval (§4.3), so nothing is installed until the
user approves in that topic. The user can ask follow-up questions before approving.

The tools live in `internal/skillinstall` and are registered only in the console runtime's task
registry (`consolecmd/skill_install.go`); channels build their own registries and do not get
them. The existing CLI `skills install` command is unchanged.

### 4.2 Accepted links

| Link | Handling |
| --- | --- |
| `github.com/<owner>/<repo>/tree/<ref>/<dir>` | The skill folder, listed with the git trees API. |
| `github.com/<owner>/<repo>/blob/<ref>/…/SKILL.md`, `raw.githubusercontent.com/…/SKILL.md` | The folder containing that `SKILL.md`. |
| `github.com/<owner>/<repo>` | `SKILL.md` at the root, else the only `<dir>/SKILL.md` or `skills/<dir>/SKILL.md`; with several, the preview lists them and the agent asks which. |
| Any other `https://…/SKILL.md` | That single file. |
| Anything else (including http) | Rejected. |

GitHub refs are resolved to a commit SHA at preview time and every file is fetched at that SHA.

Limits (same for the store): 512 KiB per file, 2 MiB and 50 files per skill, no symlinks, safe
relative paths only, and text only (UTF-8, no NUL bytes).

### 4.3 Flow

```text
task (new topic)
  agent ──> skill_install_preview {link | store_id}
              resolve link → pin commit → download → check limits
              store: commit and every sha256 must match index.json
              heuristic risk scan (curl|sh, sudo, credential files, …)
              separate LLM review: sees SKILL.md as data only (untrusted-data prompt, JSON out)
              stage files under <state>/skill_install_staging/<preview_id>
            <── {preview: id, skill_id, name, description, source, files + sha256,
                 requirements, auth_profiles, risks, review, conflict, expires_at},
                next_step
  agent explains the preview in the conversation
  agent ──> skill_install {preview_id, name, source, commit, replace?}
              approval card (params: name, source, commit, replace) ── approve / deny
              name, source and commit must equal the preview's; checksums re-verified
              move into <skills root>/<skill_id>, write provenance, switch the skill on
            <── installed skill
```

- The agent never sees the raw `SKILL.md` during a preview, only the reviewer's summary, the
  risk list and the file list, so a malicious skill cannot instruct the installing agent.
- Previews are single use and expire after 30 minutes.
- Approval is forced for `skill_install` (`guard/forced.go`): it asks even when the guard is
  disabled, and if approvals are unavailable the call is denied. The approvals store is now
  always created so this works with `guard.enabled: false`.
- Nothing downloaded is executed during preview or install.
- New installs are switched on immediately (`agentsettings.EnableSkill`): with skills off, skills
  are turned on with a load list of just the new skill; with an empty or `*` list nothing
  changes; otherwise the id is appended.
- A same-id conflict is part of the preview; `replace` keeps the old copy as `<dir>.bak-<time>`
  until the install succeeds, and restores it on failure.

### 4.4 Provenance, update and removal

Each installed skill gets `.mistermorph-skill.json`:

```json
{
  "source": {
    "kind": "store",
    "url": "https://github.com/quailyquaily/morph-skill-store/tree/3f9c2e1…/skills/weather",
    "repo": "quailyquaily/morph-skill-store",
    "path": "skills/weather",
    "commit": "3f9c2e1…",
    "store_id": "weather",
    "version": "1.0.0"
  },
  "installed_at": "2026-09-26T08:00:00Z",
  "files": { "SKILL.md": "<sha256>", "skill.yaml": "<sha256>" }
}
```

`kind` is `github`, `url` or `store`. It powers the Source row, Edited (checksums differ) and
Update (store version differs). Skills without the file are shown as Local.

Remove, at the bottom of a skill's side sheet, asks in place (the footer turns into a
confirmation showing the folder) and then calls `POST /settings/agent/skills/remove`. Deleting
the folder by hand works too.

## 5) Stage 3: the skill store

### 5.1 Repository

The **Morph Skill Store**, [quailyquaily/morph-skill-store](https://github.com/quailyquaily/morph-skill-store),
accepts third-party skills by pull request:

```text
skills/
  <id>/
    SKILL.md          # frontmatter name must match <id>
    skill.yaml        # version, description, author, license, homepage?, tags?
    …                 # optional text files
schema/skill.schema.json
scripts/build_index.py
index.json            # generated by CI, never edited by hand
```

CI:

- Pull requests (`validate.yml`): `build_index.py --check --base origin/main` validates
  manifests and frontmatter, limits, text-only files and safe names; rejects curl|sh, base64|sh,
  instruction-override text and request-collector URLs; warns on sudo, rm -rf, credential files,
  plain http and scripts; requires a version bump for changed skills; refuses hand edits to
  `index.json`. Maintainer review is required to merge.
- Main (`index.yml`): rebuilds `index.json` (each skill's fields, the last commit that touched its
  folder, per-file SHA-256, total size) and commits it if it changed.

The console reads it from the raw URL on `main`; `skills.store.index_url` overrides it for forks
and private stores.

### 5.2 In the console

Not on the page for now (the Store tab was taken out to keep the page to managing and adding
skills). The backend below is in place for when it returns.

- Store tab: search (name, id, description, tags) and cards with name, version, description,
  author, license, file count and size, tags, and Install / Installed / Update to vX.
- Install starts the task of §4.1 with `store_id`; the preview is pinned to the index commit and
  checked against the index checksums, and the LLM review still runs as a second check.
- The store loads in the background on page open so installed cards can show Update.

### 5.3 Trust

Store skills show "Store vX" and link-installed ones their repository; both get the same
preview, risk list and approval. There is no separate "unreviewed" badge yet.

## 6) Security

Skills are instructions the agent follows, and they can ship scripts the agent may run with
`bash`. A malicious skill is effectively a prompt injection with tools.

- Install never runs anything; files only land inside the skills root.
- The installing agent sees a summary from an isolated reviewer, never the skill text itself.
- `skill_install` always needs the user's approval, even with the guard off.
- Pinned commits plus checksums: installed files are exactly the previewed files, and store
  installs are exactly the store's files.
- Provenance lets users see where every skill came from and whether it was edited.

## 7) Stages and tests

| Stage | Scope | Tests |
| --- | --- | --- |
| 1 (done) | Skills page; catalog and detail routes; switches; Settings section removed; nav entries | Catalog/route tests; `skills-load` tests; page source tests; screenshots |
| 1b | `skill_used` event and last-used projection | — |
| 2 (done) | `internal/skillinstall`; forced approval; console-only tools; Install dialog starts a task in a new topic; provenance; `EnableSkill` | Link table, limits, symlinks, binaries, repo candidates, single-use previews, mismatch refusal, checksum re-verify, replace/backup, forced approval with guard off, `EnableSkill` cases, tool registration |
| 3 (done) | Store repo scaffold (CI, schema, seed skills); store route; Store tab; Update | Index validation, store checksum mismatch rejected, store view install/update flags, end-to-end run of a CI-built index through preview and install |

## 8) Decisions

| Question | Decision |
| --- | --- |
| Store repository | Morph Skill Store, `quailyquaily/morph-skill-store`, with `index.json` in the repository. |
| LLM review for store installs | Kept as a second check. Review and install run as a regular agent task, listed in the topics. |
| Binaries in skills | Not allowed, for links and the store alike. |
| Install on all agents at once | No; skills stay per agent. |
| New installs | Switched on immediately. |
| Where installs start | The web console only: the Skills page, the Store tab and console chat topics. |
| Built-in skills | Not needed any more; the page neither lists nor installs them. |
| Removing a skill | Remove in the side sheet deletes the skill's folder after a confirmation. |
| Settings | The Skills section is removed. |
