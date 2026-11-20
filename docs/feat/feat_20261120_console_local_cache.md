---
date: 2026-11-20
title: "Console: a local cache, so pages open with their last data"
status: implemented (steps 1 to 4)
---

# Console: a local cache, so pages open with their last data

## Problem

Every time a Console page opens (the topic list, a topic, the to-do list), it shows loading rows until its requests return. On the phone apps this is the most visible delay in the app: the network is slower, and the app is opened and left many times a day.

Three facts in `web/console-nsh` cause it:

| Fact | Where |
|---|---|
| Pages call the fetch helpers directly and keep the answer in their own signals. A page's state is built when the page opens (`createChatController()` in `pages/chat/ChatPage.tsx`, the to-do state in `components/todo/todo-state.ts`), so it starts empty. | about 80 call sites of `apiFetch` / `runtimeApiFetch` / `runtimeApiFetchForEndpoint` |
| The one shared cache is in memory and opt-in. Only contacts opts in (`cache: true` in `lib/stores/contactsStore.js`). Chat history uses `loadResource` only to share a request in flight. | `lib/core/resources.js` |
| Nothing a server returned is kept across a restart. The phone apps keep only small saved values (nsh `Storage`). | `lib/mobileHost.ts` |

## Goals

1. A page that was seen before shows its last data on the first frame, then updates when the server answers.
2. The phone apps (Android, later iOS) do the same after a cold start.
3. Data is never shown for another server, account or endpoint than the one it came from.

Not goals: working offline (sending tasks, editing without a connection), and caching files or images.

## Where this stands

| Step | State |
|---|---|
| 1. Memory layer | built |
| 2. Topic list, topic layout, to-do list, heartbeat workflows, chat profiles | built |
| 3. Topic history, newest page | built |
| 4. Disk layer for the phone apps | built; checked on a file system in memory, **not on a device** |
| 5. The remaining pages (contacts, memories, skills, stats, overview) | not built |
| 6. iOS | the same store; not checked |

Not built from the first draft of this document: topic metadata, `/commands` and `/settings/agent`, and the "updated 2 h ago" note. See [Left out](#left-out).

## Solution

Stale-while-revalidate, in two layers behind one API.

```
page ──read──▶ memory layer ──miss──▶ disk layer (phone apps)
  ▲                │                        │
  └── update ◀── revalidate (network) ──────┘ write through
```

- **Read:** the page gets the cached value at once, if there is one, and asks the runtime as before. The answer replaces the cached value and what the page shows.
- **Loading rows** show only when there is no cached value at all.
- **A failed revalidation** keeps the cached data on screen and reports the error the way the page did before. It does not blank the page.

### Layer 1: memory (web, desktop, phone)

`lib/core/resource-cache.js` holds the entries (no nsh imports, so `node --test` runs it). `lib/core/resources.js` gives pages three functions next to what it had:

```js
peekResource(key)                  // the cached value now, or undefined; no request, no disk
await readResource(key)            // from memory, else from disk
writeResource(key, value, options) // after a request, or after a change the user made
```

`options`: `eager` (read from disk before the first frame), `group: "history"` (memory keeps the 20 used last), `persist: false` (memory only).

`invalidateResource(keyOrPrefix)` also drops the cached entries, in memory and on disk.

The loaders keep their own signals and their own guards against late answers; each does the same three things:

```js
const cached = peekResource(key) ?? (await readResource(key));
if (cached !== undefined && /* still the same page state */) show(cached);
const data = await runtimeApiFetchForEndpoint(endpointRef, path);
writeResource(key, data, { eager: true });
show(data);
```

`peekResource` first, so a value in memory is shown in the same turn the page is built, and the first frame has it.

### Layer 2: disk (phone apps)

`lib/cacheFiles.ts` is the store: files in the app's own data directory through nsh's `fs/promises`.

```
${dataDir}/cache/index.json   { version, scope, next, entries: { key: { file, size, used, eager } } }
${dataDir}/cache/e<n>.json    one entry: { value, at, group }
```

- `nsh.json` grants the directory: `capabilities.fs.read` and `.write` are `["${dataDir}/cache"]`.
- An entry's file is written before the index names it, and removed after the index dropped it. A file the index does not name is removed at the next start.
- The index is replaced whole (written beside, then renamed). One that does not parse starts empty.
- Writes from the memory layer are gathered for 250 ms and sent off the caller's path.

`lib/cache.ts` starts it (`startCache()` in `App.tsx`, after the session is restored and before the first page mounts): it opens the store, then reads the **eager** entries into memory. Those are the small, bounded ones (topic list, layout, to-do, heartbeat, profiles: a few per agent). History is read when a conversation is opened.

If the directory cannot be written, the app warns once and goes on with the memory layer alone.

Web and desktop have no store: the memory layer covers a session, and a reload asks again as before.

**Not nsh `Storage`.** `mobileHost.ts` reads every `Storage` key into memory at boot, so cached payloads there would slow every launch and stay in memory.

### Keys and scope

Keys are `resourceKey(...)` as before, with the agent's endpoint ref in them:

| Key | Request |
|---|---|
| `chat:topics:<endpoint>` | `/topics?limit=100` |
| `chat:topic-layout:<endpoint>` | `/topics/layout` |
| `chat:llm-profiles:<endpoint>` | `/llm/profiles` |
| `chat:history:<endpoint>:<path>` | `/tasks?limit=…&topic_id=…` |
| `todo:tasks:<endpoint>` | `/todo/tasks` |
| `todo:heartbeat:<endpoint>` | `/heartbeat/workflows` |

The server and the account are not in the keys. They are the store's **scope** (`<origin><base path>|<account>`), kept in the index: an index of another scope, or of another `CACHE_VERSION`, is emptied when the store opens, and a store whose scope changed in the same run reads nothing and empties on its first write.

The cache is emptied when:

| Event | Where |
|---|---|
| Logout | `pages/settings/store.ts` |
| The console rejects the session (401) | `handleUnauthorized` in `lib/core/context.js` |
| Another server is entered | `setServer` in `lib/platform.ts` |
| Another account logs in, in the same run | `lib/cache.ts` |

It is **not** emptied when the router's guard drops the session because `/auth/me` could not be reached (`lib/router.ts`): that is a network failure, and the same account's data is still its own.

### What is cached

| Resource | Kept fresh by |
|---|---|
| Topic list, first page | Every open asks again. The first 100 topics on screen are written back whenever the list changes (a rename, tags, a pin, a delete, a new topic), so the next visit opens with the list as it was left. |
| Topic layout | Every open asks again; a moved group or topic is written back. |
| Topic history, newest page | Every open asks again; so does the end of each run (`refreshHistory`). A deleted topic's entry is removed. |
| To-do list | Every open asks again. After a save the list is asked for once more, only to keep it. |
| Heartbeat workflows | Every open asks again; a save writes what the runtime returned. |
| Chat profiles | Every open asks again. |

Two rules for what is stored:

- **A history entry holds finished runs only.** A run still under way is left out, so a conversation never opens with a reply stopped half way; the answer brings it.
- **The to-do entry holds no run state** (`runs` is dropped): what ran then is not running now.

Never cached: approvals, a running task's state, settings, logs, audit, files.

### Limits

- Disk: 20 MB in total (counted in characters), the least recently used entries removed first. One entry over 1 MB is not stored.
- Memory: the newest page of the 20 conversations used last; the other resources are one entry per agent.
- No time limit on an entry: every open asks again, so an entry is as old as the last answer.

### What changes on screen

Nothing new is drawn.

- **Topic list:** the spinner shows only on a first load. A list shown from the cache is not dimmed while it refreshes (`topicsFromLastTime`).
- **To-do list:** the placeholder rows show only on a first load (`placeholderRows`, `tasksPending`). The list still takes no edits until the runtime answered (`loading` stays true), so nothing is edited on old data. When the answer comes, the items keep their keys (none flashes as new) and a selected item stays selected.
- **Conversation:** the cached messages show at once, at the end; the answer is merged into them. The list is not scrolled again when the answer comes.

## Tests

- `lib/core/resource-cache.test.mjs`: reads and writes, prefix drops, the 20-conversation limit, gathered writes, a clear during a read, eager hydration, a failing store.
- `lib/core/cache-files.test.mjs`: the store on a file system in memory: round trips, eager entries, removal, the size limits, a bad or foreign index, another account in the same run, stray files, a directory that takes no write.
- `tests/local-cache.test.tsx`: the app itself. The topic list, the to-do list and a conversation open again with what they had while the runtime has not answered; a first visit still shows the spinner; a running run is not kept; the phone app closed and opened again shows its topics and to-do items from disk; a rejected session empties the store.

The app tests give the store a file system kept in the app's storage (`tests/cacheFilesConsole.tsx`, `openConsole({ cacheFiles: true })`), because a headless app has no files of its own.

Not covered by a test: a to-do item selected between the cached list and the answer staying selected (a test's steps wait for the app's requests, so nothing can be pressed during one).

## Left out

1. **The router's guard still waits for the network before a page shows.** `guard()` in `lib/router.ts` awaits `/auth/me` on every navigation, and on a cold start also `/setup/integrity`, `/endpoints` and the setup stage, one after another. A page shows its cached data on its first frame, but that frame comes after those requests. This is the largest delay left, and it is a change to how the session is checked, so it is not part of this work. The fix would be to let a navigation through at once when the session is valid locally and the endpoints are known, and to run the checks behind it.
2. **Topic metadata** (`/topic/<id>/metadata`): applying it twice resets the workspace tree, so it needs its own care.
3. **`/commands` and `/settings/agent`**: loaded when the composer's suggestions open, not when the page does.
4. **Older history pages**: not cached at all.
5. **"Updated 2 h ago"** after a failed refresh: the entry's time is stored (`at`), nothing shows it.
6. **The remaining pages** (step 5) and **web persistence** (IndexedDB in `host.js`).

## Open questions

1. **`fs/promises` on a device.** The Android runtime carries the data directory and the capability is accepted by `nsh build`, but nothing here ran on a phone: the headless tests have no file system. Check on a device that the log does not say `cache: no store on disk`, and that topics show from a cold start with the network off. If it does not hold, the fallback is the native part (`android/src`) answering the same five calls over the host channel.
2. **The size of a history page.** Not measured. It decides whether 20 conversations and 1 MB per entry are the right limits.
