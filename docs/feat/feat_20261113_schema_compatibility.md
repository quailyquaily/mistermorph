---
date: 2026-11-13
title: "SQLite schema changes that older builds survive"
status: proposed
---

# SQLite schema changes that older builds survive

## Goal

Several builds of different ages open the same state folder: a development `bin/morph`, the installed
`/usr/local/bin/morph`, the desktop app's backend, and the agents on other machines after a sync or
copy. A schema change made by the newest one must not lock the others out of the file, unless the
change really is one they cannot work with. When it is, the older build should say what it needs, and
the data from before the change should be recoverable.

## Why

`internal/sqlitedb` runs each database's migrations in order and records how many ran in `PRAGMA
user_version`. A build that finds a higher version than it knows refuses the file:

```
open usage database: ~/.morph/usage.db: schema version 3 is newer than this build, which knows 2
```

That happened on 2026-11-13. The coder quota change added a `coder_quota` table to `usage.db` as a
third step. A build from the day before then refused the whole file, and the Usage page, over a table
it never reads. The fix (`coder_quota` created with `CREATE TABLE IF NOT EXISTS` on every open, not as
a step) keeps `usage.db` at version 2. `agent.db` has the same problem: it is at version 5, and each of
its additive steps locked out the builds before it.

Running the missing migrations on a version mismatch does not help here. It fixes a file that is
behind the build, and every build already does it. This file was ahead: the older build has no code
for the step it is missing and cannot undo it. Down migrations do not help either, because they would
be in the newer build, and the older build is the one opening the file.

## Design

### Two numbers per file

Each database records two numbers:

- `version`: how many steps of its list have run (`PRAGMA user_version`, as now).
- `compatible_version`: the number of steps a build must know to use the file. It is the number of the
  last breaking step that ran, or 0 when no step was breaking.

`sqlitedb` keeps `compatible_version` in a table of its own, the same in every database:

```sql
CREATE TABLE IF NOT EXISTS sqlitedb_schema (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- compatible_version: "7"
-- compatible_written_by: "v0.42.0" (the build that raised it, for the error message)
```

Chrome's `sql::MetaTable` uses the same pair (`version` and `last_compatible_version`), and SQLite's
own file header has separate read and write versions for the same reason.

### Steps are additive or breaking

`sqlitedb.Migration` gets a field:

```go
type Migration struct {
	Name     string
	SQL      string
	Apply    func(ctx context.Context, tx *sql.Tx) error
	// Breaking marks a step that builds without it cannot work with. Running it raises the file's
	// compatible_version to this step's number, and a backup of the file is taken first.
	Breaking bool
}
```

A step is **additive** when a build that does not know it still reads and writes the file correctly:

- a new table, index or view;
- a new column that is nullable or has a default (`ALTER TABLE … ADD COLUMN … DEFAULT …`);
- new rows in a settings or meta table that older builds ignore.

A step is **breaking** when an older build would fail, or would write data the newer build then
misreads:

- renaming or dropping a table or column;
- a new `NOT NULL` column without a default, or a new `CHECK`, `UNIQUE` or foreign key constraint on
  an existing table;
- changing what a value means (units, encoding, an enum's values) or moving data between tables;
- a trigger or invariant the older build's writes would break.

### Opening a file

`migrate` reads `version` and `compatible_version` in its transaction. `N` is the number of steps the
build knows.

| File | What the build does |
|---|---|
| `version < N` | Runs the missing steps, as now. If one of them is breaking, it snapshots the file first (below) and sets `compatible_version`. |
| `version == N` | Opens it. |
| `version > N` and `compatible_version <= N` | Opens it without migrating. It leaves `user_version` as it is: it must not lower it, and the newer build will not run the steps again. |
| `version > N` and `compatible_version > N` | Refuses: `usage.db needs a newer mistermorph (schema 7, written by v0.42.0); this build knows schema 5`. |

When two builds take turns on one file, the newer one sees `version == N` and the older one sees an
additive newer file. Neither runs anything.

### Backup before a breaking step

Before running a breaking step, `sqlitedb` copies the file with `SnapshotInto` (`VACUUM INTO`) to
`<name>.v<version>.bak` beside it, with mode 0600, and keeps only the latest one per database. This
happens outside the migration transaction, because `VACUUM INTO` cannot run inside one. If the step
fails, the transaction rolls back and the backup is not needed. If the user goes back to an older
build, they can rename the backup into place. Writes made after the upgrade are not in it, so the
refusal message names the backup.

Additive steps take no backup: they are frequent, and an older build can still open the file.

### Rules for code that reads and writes the databases

`compatible_version` is safe only if older code tolerates what additive steps add:

- no `SELECT *` scanned by position: name the columns;
- `INSERT` names its columns, so a new column takes its default;
- new columns are nullable or have a default, and the code that reads them handles both;
- an older build's rows, which lack the new columns' values, must still be valid for the newer build.

### Changing something in stages

A rename or a change of meaning is done in two releases (expand, then contract):

1. **Expand (additive).** Add the new column or table. The build writes both the old and the new,
   reads the new one, and fills it from the old one when it is missing.
2. **Contract (breaking).** Once going back to builds before step 1 is no longer supported, stop writing
   the old column and drop it. This step is breaking and raises `compatible_version` to its number.

Only the contract step locks out older builds, and only builds the project has decided to stop
supporting.

### Large data moves

A schema step runs while the database opens. A step that would rewrite many rows, such as a backfill
or a re-pricing, adds the column in the step and fills it afterwards in batches that can be
resumed. `usage.db` already re-prices this way, outside its migrations.

### Where the steps live

Each database keeps one list of steps in its own package (`internal/agentdb/schema.go`,
`internal/llmstats/usagedb.go`, `internal/memories/store.go`, `internal/domainjournal/schema.go`).
Some steps call code in those packages (the JSONL imports), so moving them to a shared package would
create import cycles. The version check, compatibility rule and backup live in one place,
`internal/sqlitedb`.

## Transition

Builds released before this change only compare `user_version`, and they will still refuse any
version they do not know. Until the oldest build the project supports has the new rule:

- additive changes are not steps: they run as `CREATE … IF NOT EXISTS` (or a guarded `ADD COLUMN`)
  each time the database opens, as `coder_quota` does, and `user_version` stays where it is;
- breaking changes are steps with `Breaking: true`, as above.

After that, additive changes go back to being normal steps, and the open-time statements can move into
the lists as steps.

## Tests

- `internal/sqlitedb`: a file migrated by a longer list opens with a shorter one when the extra steps
  are additive, and is refused with the message above when one is breaking; `user_version` is never
  lowered; a breaking step takes a backup first and records `compatible_version` and the build; a
  failed breaking step leaves the file and its versions unchanged.
- Each database: a test that opens a file migrated by its full list with the list minus its trailing
  additive steps, as the previous release would. It would have caught the `usage.db` problem.
- Each database: a fixture file from each released schema, upgraded by the current build, with its
  rows read back.
- Each database: its `compatible_version` is pinned in a test, so a breaking step changes it only on
  purpose.

## Docs

A short "Schema changes" section in `AGENTS.md`: additive or breaking, the rules for code that reads
and writes the databases, expand and contract, and the transition rule above.

## Open questions

- Which builds the project supports going back to: for example, the previous release, or any release
  from the last 90 days. This decides when a contract step can ship and when the transition ends.
- Whether the desktop app should offer to restore the backup itself when it is refused, rather than
  only naming the file.
