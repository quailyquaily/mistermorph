---
date: 2026-09-26
title: Skills page, skill install and the skill store
status: draft (decisions recorded in §8)
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
- Icon: `PhPuzzlePiece` (or `PhLightning`), registered in `icons/phosphor.js`.
- Settings loses its Skills section entirely (no pointer left behind). Tools and MCP stay in
  Settings: they are set up once, while skills are browsed.

### 3.2 Layout

Same shape as TODO and Contacts: an index list and a detail pane.

```text
+------------------------------+------------------------------------------------+
| SKILLS            [on] [+]   |  jsonbill                        [loaded ●]    |
|------------------------------|  Make and send JSON invoices.                  |
| ● jsonbill                   |  -------------------------------------------   |
|   Make and send JSON invoi…  |  ID            jsonbill                        |
| ● inventory-cli              |  LOCATION      ~/.morph/skills/jsonbill        |
|   Track household inventory  |  SOURCE        built-in · assets/skills        |
| ○ guizang-ppt-skill          |  REQUIRES      bash, curl                      |
|   Generate slide decks       |  AUTH PROFILE  jsonbill_api                    |
|                              |  LAST USED     Sep 25, 14:03 · chat            |
|                              |  FILES         SKILL.md, scripts/send.sh       |
|                              |  -------------------------------------------   |
|                              |  (SKILL.md rendered as Markdown)               |
+------------------------------+------------------------------------------------+
```

- Index rows: name, one-line description and a square status mark (filled = loaded, hollow =
  available but not loaded), the same marks used for agents.
- Header: the global Enable switch (`skills.enabled`) and an Install button. On mobile the
  install action is the floating add button, as on Chat and TODO.
- Detail: facts in the mono datasheet style used by Usage, then the rendered `SKILL.md`,
  read-only. The content is untrusted, so the renderer must sanitise it (no raw HTML, no
  scripts); check the console's markdown renderer does before reusing it here.
- The per-skill switch moves into the detail header. Changes save immediately (one small
  config write) instead of through a save bar, so this page has no pending-changes state.
- Empty state: explains where skills live and offers Install.

### 3.3 API

The page acts on the selected agent: skills live in each agent's own state dir, and remote
agents are reached through the existing endpoint proxy.

| Route | Purpose |
| --- | --- |
| `GET /skills` | Enabled flag, and all discovered skills with id, name, description, dir, requirements, auth profiles, loaded flag, source (provenance, §4.4) and file list. |
| `GET /skills/{id}` | The same fields plus `SKILL.md` content (size-capped). |
| (existing) agent settings update | Switches keep using the agent settings API's `skills: {enabled, load}` update, as Settings did, so no new write route is needed. |

Agents without these routes answer 404; the page then shows an "update this agent" notice,
as the daily usage chart does.

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

1. Skills page → Install → paste a link. The console starts a task in a new topic
   ("Install skill: <link>") and opens it.
2. Chat: the user pastes a link into any topic and asks the agent to install it.
3. Store (Stage 3): Install on a store card starts the same task with the store entry.

In all three the agent does the same thing: it calls `skill_install_preview`, explains the
result in the conversation (what the skill does, its files, requirements and risks), and then
calls `skill_install`. `skill_install` always requires approval through the existing approval
card, so nothing is installed until the user approves in that topic; the agent can prepare an
install but never approve one. The user can ask follow-up questions about the skill before
approving.

The Skills page shows installs in progress (a row linking to the task's topic) and refreshes
when a task installs a skill.

Both tools share one backend package (`internal/skillinstall`) extracted from the CLI
command. The CLI keeps its TTY prompts on top of the same package.

### 4.2 Accepted links

| Link | Handling |
| --- | --- |
| Raw `SKILL.md` URL | As today. |
| `github.com/<owner>/<repo>/blob/<ref>/…/SKILL.md` | Rewritten to the raw URL. |
| `github.com/<owner>/<repo>/tree/<ref>/<dir>` | The skill directory: list files with the GitHub contents API and take the whole directory (limits below). |
| `github.com/<owner>/<repo>` | Look for `SKILL.md` at the root, then `skills/*/SKILL.md`; if several are found, the preview asks which. |
| Anything else | Rejected with a clear message. |

For GitHub directories the file list is deterministic, so the LLM file extraction is skipped;
the reviewer is still used for the risk review. Refs are resolved to a commit SHA at preview
time, and the install uses that SHA, so what gets installed is what was reviewed.

Limits: https only (the CLI also allows http; the console should not), 512 KiB per file, 2 MiB
and 50 files per skill, no symlinks, no files outside the skill directory, and no binaries:
every file must be text (UTF-8, no NUL bytes). The same rule applies to the store.

### 4.3 Flow

```text
task: "Install skill: <link>"
  agent ──> skill_install_preview {link}
              resolve link → pin commit → download into a temp dir
              parse frontmatter, list files, reject binaries and over-limit files
              LLM review (untrusted content; risks only, no instructions followed)
              heuristic risk scan (curl|bash, credentials, remote exec, …)
            <── preview_id, name, description, source, commit, files + sizes,
                SKILL.md text, requirements, auth profiles, risks,
                conflict (same id already installed)
  agent explains the preview in the conversation
  agent ──> skill_install {preview_id, replace?}
              approval card in the topic ── user approves or denies
              re-verify checksums of the previewed files, move into place,
              write provenance, switch the skill on
            <── installed skill
```

- The preview is stored server-side under a short-lived id; `skill_install` accepts only that
  id, so the files installed are byte-for-byte the files that were reviewed and approved.
- Nothing downloaded is ever executed during preview or install.
- New installs are switched on immediately: added to `skills.load` when a load list is in use
  (with an empty list every discovered skill is already loaded).
- A same-id conflict is part of the preview; approving with `replace` keeps the old copy as
  `<dir>.bak-<time>` until the install succeeds.
- The approval card shows the skill name, source, commit, file list and risks, so the decision
  can be made from the card alone.

### 4.4 Provenance, update and removal

Each installed skill gets `.mistermorph-skill.json`:

```json
{
  "source": "github",
  "url": "https://github.com/acme/skills/tree/main/pdf-tools",
  "commit": "3f9c2e1…",
  "installed_at": "2026-09-26T08:00:00Z",
  "files": { "SKILL.md": "sha256:…", "scripts/run.sh": "sha256:…" },
  "store": null
}
```

It powers the Source row, "modified locally" (checksums differ) and "update available"
(Stage 3). Skills without the file are shown as "local".

Removing a skill is deleting its folder under the skills root; there is no uninstall flow.
Discovery simply stops finding it, and an id left in `skills.load` is ignored (unknown entries
already are).

## 5) Stage 3: the skill store

### 5.1 Repository

The **Morph Skill Store**, [quailyquaily/morph-skill-store](https://github.com/quailyquaily/morph-skill-store)
(created, empty so far), accepts third-party skills by pull request:

```text
skills/
  <skill-id>/
    SKILL.md
    skill.yaml        # store manifest
    scripts/…         # optional
index.json            # generated by CI, never edited by hand
```

`skill.yaml`: id, name, version (semver), author, license, homepage, short description,
tags, requirements, auth profiles, minimum mistermorph version.

CI on every PR:

- lint frontmatter and manifest; id unique and matching the directory; size limits; text
  files only (binaries are rejected);
- a static risk scan, reported on the PR (the same heuristics as §4.3);
- maintainer review is required to merge.

On merge, CI rebuilds `index.json`: every skill with its manifest fields, the commit it was
last changed in, and per-file SHA-256 checksums. It is served from the repository itself
(raw URL on the default branch) and its URL is a config key (`skills.store.index_url`,
default the Morph Skill Store) so forks and private stores work.

### 5.2 In the console

- The page gets two tabs: Installed and Store.
- Store: search and tag filter over `index.json` (cached, refreshed on open), cards with
  name, author, description and tags, and an Installed badge.
- Install from the store starts the same install task (§4.1), pinned to the index commit and
  verified against the index checksums. The LLM review still runs as a second check after the
  store's own review; store skills are marked "reviewed by the store" and risks are still
  listed.
- Installed skills whose provenance points at the store show "Update available" when the
  index version is newer; Update starts an install task with `replace`, and the preview
  includes a diff of changed files.

### 5.3 Trust levels

| Source | Badge | Preview |
| --- | --- | --- |
| Store | Store | Full preview; risks listed. |
| Any other link | Unreviewed | Full preview; a warning that nobody else has reviewed it. |

## 6) Security

Skills are instructions the agent follows, and they can ship scripts the agent may run with
`bash`. A malicious skill is effectively a prompt injection with tools.

- Install never runs anything; files only land inside the skills root.
- Every install is a task whose preview the agent explains in the conversation, and
  `skill_install` always needs the user's approval in that topic.
- Pinned commits plus checksums: installed files are exactly the reviewed files.
- The LLM reviewer treats the content as untrusted and only lists files and risks; its output
  is advisory and never used to decide what to run.
- Provenance lets users see where every skill came from and remove it.
- `requirements` and `auth_profiles` are displayed before install, so users see what a skill
  expects to use.

## 7) Stages and tests

| Stage | Scope | Tests |
| --- | --- | --- |
| 1 | Skills page, `GET /skills`, `GET /skills/{id}`, `PUT /skills/settings`; Settings section removed; sidebar and mobile entries | Route tests with a temp skills dir; console core tests for list/detail state; screenshots desktop and 390 px |
| 1b | `skill_used` event and last-used projection | Projection tests |
| 2 | `internal/skillinstall` extracted from the CLI; GitHub link resolution; `skill_install_preview` and `skill_install` tools for the console runtime only (install behind approval); Install on the Skills page starts a task in a new topic; provenance | Link resolution table tests; limits, path safety and binary rejection; preview-id binding; checksum re-verify; `skill_install` refuses without approval; new install switched on |
| 3 | Store repo with CI and `index.json`; Store tab; update flow | Index schema tests; install-from-index checksum mismatch rejected; update diff |

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
| Removing a skill | Delete its folder under the skills root. No uninstall flow or route. |
| Settings | The Skills section is removed. |
