# Agents: Clones, Sub-agents and Neighbors

Mister Morph has three kinds of agent, told apart by how they relate to the agent you run:

- **Clones** are the agent itself, working on one task in one topic.
- **Sub-agents** are its children, started for one piece of work.
- **Neighbors** are other agents.

Each kind shares context in its own way, gets its own level of trust, and leaves its own record. This page defines the terms. The rest of the docs, the Console and the prompts use them in these senses.

## Why three kinds

A kind of agent exists only if it has a reason no other kind has. Two kinds with the same reason would be one kind.

The reason is always the same one, at a different level: some work needs a context of its own. Context has three layers ([Context](#context)), and each kind is a boundary at one of them:

| Boundary at | Kind | Its reason | Use it when |
| --- | --- | --- | --- |
| The agent layer | Neighbor | It needs its own identity and state | The work belongs to another memory, persona or owner |
| The topic layer | Clone | It has a goal of its own | Someone will come back to the work: to continue it, to run it again, or to talk to it |
| The task layer | Sub-agent | It is a piece of one goal | Only the result matters, and the context that produced it can be thrown away |

Three layers give three kinds. A fourth kind would need a fourth layer.

Inside a kind there are variants, and a variant is not a new kind:
- Clones vary by **trigger**: what started them ([Clones](#clones)).
- Sub-agents vary by **engine**: what runs them ([Sub-agents](#sub-agents)).

## The three kinds

| | Clone | Sub-agent | Neighbor |
| --- | --- | --- | --- |
| What it is | The agent running one task in one topic | A child run started with `spawn` or `coder` | Another `morph` runtime, with its own identity |
| Relationship | The same self | Parent and child | Peers |
| How long it lives | As long as its topic | Until its task ends | Indefinitely |
| How it shares context | Agent-level state, live; its own topic | The parent's instructions down, one result up | Channels, Agent Link, shared outside state |
| Started by | A trigger (below) | A clone, or another sub-agent | Its own owner |
| Where it shows today | Tasks, in their topics | **Workers** in the chat's activity (kinds **Subagent** and **Coder**) | Contacts, the Console's agents (endpoints), Agent Link topics |

Avoid two other words for these:
- **Avatar** already means a profile image (contacts, Agent Link peers, `/persona/avatar`).
- **Worker** also names the runtime's per-conversation queue workers.

## Clones

The runtime runs several tasks at once: Solo, other Console topics, channel conversations, scheduled jobs. Each running task is a **clone**. All clones are the same agent, with one persona, memory and toolset. They differ only in the topic they work in, and so in the context they carry.

What started a clone is an attribute of that clone, not a different kind of agent. The trigger also picks the clone's topic:

| Trigger | Examples | Topic it runs in |
| --- | --- | --- |
| A person | Console or terminal chat; a Telegram, Slack or LINE message | The chat's topic, or the channel conversation |
| Another clone | Solo's `work_thread` (trigger event `solo_thread`) | A new thread topic marked `started_from: "_solo"`, or the existing topic given more work |
| Awareness: a scheduled job | A TODO item's run by its schedule | That item's own topic, `_cron_<id>`, shared by all its runs |
| Awareness: heartbeat | A periodic heartbeat check, or `POST /poke` | Awareness, `_awareness` |
| Outside: a webhook | `POST /poke/{job_id}` | That job's topic |
| Outside: a message trigger | A job's `message` trigger on Telegram, Slack or Agent Link | That job's topic |
| Outside: a neighbor | A message over Agent Link | One topic per neighbor, `_agentlink_<instance id>` |

**The trigger picks the topic, and the topic carries the context.** That is why continuity follows the source:
- A job's fifth run sees its fourth.
- A neighbor's new message sees the earlier conversation with that neighbor.
- A Solo thread keeps its history apart from Solo's.

A new kind of trigger needs one decision above all others: which topic it runs in.

A Solo work thread is an ordinary clone. Solo writes its first instructions and receives its summary, but the thread then lives on in its own topic, like any other.

A clone and a sub-agent can look alike at the start: both are given work by another run. The difference is the goal. A clone's work has a goal of its own, and a sub-agent's work is a piece of its parent's goal. How complicated the work is only hints at the answer: complicated work is usually work someone comes back to. Work that a trigger starts (a schedule, a heartbeat, a webhook, a neighbor) is always a clone, because it is a new goal and no parent waits for its result.

Clones share writable agent-level state, so they can collide: two clones can save contradicting memories, or work in the same git workspace at the same time. Neighbors share nothing directly, and a sub-agent is bounded by its parent, so neither has this problem.

The runtime does not limit how many clones work in one workspace. Git and the file system keep the repository intact, and clones that work on one repository at the same time keep their changes apart with a git worktree each.

## Sub-agents

A clone starts a sub-agent for a piece of its goal that is better done in a separate context. What the piece read and tried stays out of the parent's context, and only the result comes back. That also lets several pieces run at once: translating an app into ten languages is one goal and ten sub-agents, not ten topics.

Context flows down as the instructions and up as one result. A sub-agent sees nothing of its parent's topic beyond what the instructions say. When its task ends, its working context is gone: the parent keeps the result, and the record keeps the transcript, but nothing can continue it.

### Engines

A sub-agent runs on one of two engines. The engine decides who does the work, not what kind of agent it is.

| | `spawn` | `coder` |
| --- | --- | --- |
| Runs | A child of our own engine | An external coding CLI: Codex, Claude Code or Antigravity |
| Why | The general case | These CLIs do coding work better than our own loop |
| Tools | Only the ones the parent lists (`tools`) | The CLI's own |
| Model | The parent's, or a `model_profile` | The CLI's own, on the CLI's account |
| Sub-agents of its own | Yes, within the depth limit | Whatever the CLI does inside itself |

A **coder session** is topic-level state, like the attached workspace. In a Console conversation the CLI's session is kept, and the next task in that topic picks it up (`--resume`), so the CLI remembers the earlier coding work ([Tools](tools.md)). Each coder run is still an ordinary sub-agent: instructions down, one result up. Outside the Console a session lasts for one run.

The person can talk to a running `spawn` sub-agent directly ([Messages to running subagents](console.md#messages-to-running-subagents)). The sub-agent reads that as a message from the person, not from its parent.

## Neighbors

A neighbor is another Mister Morph runtime with its own identity, memory and owner. It may belong to someone else, or to the same person on another machine.

What makes a neighbor is its own state. A runtime on another machine or under another user account has its own identity and memory, so it is always a neighbor, never the same agent in a second place. This is also how to get past a resource limit, such as one coding plan's quota: a runtime uses one account per coding CLI, so a second account means a second runtime, and that runtime is a neighbor.

Neighbors relate the way people do, and share context the way people do:

- **Channels:** Telegram, Slack and the others, where both agents can take part.
- **Outside state:** git repositories, documents, issue trackers.
- **Agent Link:** point-to-point messages and files between two agents (`agent_send`; [Aqua](aqua.md)).

This context is long-lived. It stays in the channel, the repository or the Agent Link topic, not in either agent's head.

The neighbor is the other agent. The work that answers it here is one of our own clones, started by an outside trigger in that neighbor's topic.

The Console can also connect to several runtimes as endpoints. From the Console, each is an agent you can open. From each runtime's point of view, the others are its neighbors.

## Context

Context comes in three layers. Every kind of agent sees a different slice of them.

| Layer | What it holds | Clones | Sub-agents | Neighbors |
| --- | --- | --- | --- | --- |
| Agent | Identity and soul, memory, journal, contacts, TODO items, known workspaces, config | Shared, live | Only what the parent passes on, and through the tools it is given | Not shared; only what is sent |
| Topic | History, compacted context, the attached workspace, the coder session | One each | Not shared; the instructions stand in for it | Their Agent Link topic holds the exchange |
| Task | The current run's working state | One each | One each, gone when it ends | Not shared |

Clones share by pulling. A clone sees what another learned only after it is written to the agent layer (a memory, a journal entry, a TODO item), or by reading the other's topic with `topic_search` or `topic_read`. `work_thread` is the one push from clone to clone: Solo's instructions go to the thread, and the thread's summary comes back.

## Trust

The agent's own persona and memory are trusted. The input that starts a run is trusted according to where it came from:

| Input | Trust |
| --- | --- |
| A message from the owner, in Console or a direct chat | Instructions |
| A TODO item's task text, written by the owner | Instructions, written ahead of time |
| Solo's instructions to a work thread | Instructions, written by the agent from the owner's request |
| A parent's instructions to a sub-agent | Instructions, within the tools the parent gave |
| A message from another contact in a channel | That contact's permissions, not the owner's |
| A neighbor's message over Agent Link | A peer's request, not an order |
| A webhook body (`/poke`, `/poke/{job_id}`) | Data, never instructions |
| A thread's summary in Solo; a sub-agent's result | The agent's own work, quoted as data: it can repeat injected text from what it read |

The last row is the general rule. Text that reached the agent from outside (a web page, a file, a message) stays data, whichever kind of agent passes it along.

## Observability

Every run should answer four questions:
- **Who:** which agent ran.
- **Why:** what started it.
- **What:** what it did.
- **Cost:** what it spent.

This is what each kind records today, and where to look.

### Clones

- **Who and why:** a task belongs to one topic. Its trigger (`source`, `event`, `ref`, `trace_id`) is in the task journal. Thread topics carry `started_from`, and job runs carry their cause (`GET /todo/runs/history`).
- **What:** the task's record has the activity (tool calls, processes, approvals) and the final reply. Topics with a running task are marked in the topic list. The Runtime panel counts running tasks per entry (Console, CLI, each channel). Tool approvals and guarded actions go to the audit log ([Security](security.md)).
- **Cost:** every model request is a row in `usage.db` with its `run_id` and `scene` (`chat.loop`, `console.loop`, `awareness.*`, `todo.run_outcome`, …), shown on the Usage page.
- **Across clones:** Solo shows a card for each thread it started, and its state. A job's runs are listed in that job's topic, and quiet ones are folded.

### Sub-agents

- **Who and why:** each worker is listed in its parent task's activity (`result.activity.workers[]`). The list has the worker's ID, name, kind (Subagent or Coder) and state, and the processes it ran. Its instructions are the parent's tool call.
- **What:** the worker's panel shows its steps, and any messages the person sent it. Those messages are also kept in `result.child_messages`.
- **Cost:**
  - `spawn` requests are recorded under the parent's `run_id`.
  - `coder` runs are recorded under the CLI's host (`codex-cli`, `claude-code`, `antigravity-cli`) with operation `coder`.
  - The coding plans' remaining quota is on the Usage page.

### Neighbors

- **Who:** each neighbor is a contact, and an Agent Link peer with an instance ID. The sidebar's agents button lists their topics, with each agent's avatar.
- **What:** what they send is in their `_agentlink_<instance id>` topic, read-only. What we send them goes out with `agent_send` from a clone, and is recorded in that clone's task. A neighbor's own runs are visible only in its own Console. The Console's overview shows each connected endpoint's model, channels, cost, requests, tokens and uptime.
- **Cost:** what a neighbor spends is on its own books. Our side is the clone that answered it.

### Gaps

These are not yet recorded in one place:

- A usage row names its run and scene, but not its topic, its trigger, or which sub-agent made it. Cost per clone, per trigger or per sub-agent needs the task records alongside.
- `spawn` sub-agents' requests merge into the parent run's usage, with no worker ID.
- Nothing shows all running clones together with their triggers in one list. The topic list shows where tasks run, and the Runtime panel shows how many.
- A memory keeps its sources in the journal, but `memory_save` replaces a memory of the same subject and name without keeping the old one. Writes to TODO items are not tagged with the clone that made them.

## Terms in code and UI

| Term here | In code and UI today |
| --- | --- |
| Clone | A task (`taskdomain`), run by a topic's conversation runner |
| Trigger | `TaskTrigger` (`source`, `event`, `ref`, `trace_id`); a job run's cause |
| Sub-agent | A worker (`agent.WorkerMetadata`); "Workers" in the chat's activity |
| Engine | The tools `spawn` and `coder`; a worker's kind (Subagent or Coder) |
| Neighbor | A contact; an Agent Link peer; a Console endpoint |
| Agent-level state | `agent.db`, `memory.db` and the journal ([Configuration](configuration.md)) |
