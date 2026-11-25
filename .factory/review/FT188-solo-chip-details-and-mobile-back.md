---
branch: factory/FT188-solo-chip-details-and-mobile-back
round: 1
---
# Solo chips: details dialog, and Back to Solo on phones

## lyric · 2026-11-25 21:46
Two changes to Solo's chips and thread cards (FT186) in the Console.

1. The workspace, memory and journal chips under a Solo reply can't be pressed today; only the thread and topic chips can (they open the topic). Pressing one of these three should open a dialog with some details about it: what the reply used and how. It should not take the user to another page.
2. On the phone layout, when the user opens a thread or topic from Solo, by pressing a thread or topic chip or a thread card's Open thread button, Back from that topic should return to Solo, because that is where the user came from. On the desktop layout, keep the current behaviour for now.

Where it is today:
- Chips: `web/console-nsh/components/chat/ChatSoloSources.tsx`, used in `components/chat/ChatHistoryItem.tsx` (`ctx.onOpenTopic`, which is `selectTopic` in `pages/chat/chatController.ts`). Thread cards: `ChatSoloThread` in the same file.
- What a chip records comes from `internal/solo/sources.go` (`SourceCollector`, stored as `result.solo_sources`): today only kind, id and label. The dialog's details may need more recorded there.

## lyric · 2026-11-25 21:55
3. A thread chip and a topic chip often point at the same thing: a later Solo reply that reads a thread Solo started (to report on it, say) shows it as a topic chip. When the topic a reply reads is one Solo started (`started_from: "_solo"`), show it as a thread chip instead. Topic chips then mean only ordinary topics the agent looked into. Within one reply the collector already folds a topic into the thread it started (`Sources()` in `internal/solo/sources.go`); this extends that to threads started by earlier replies.

## factory · plan · 2026-11-25 22:40
Behaviour
- Workspace, memory and journal chips open an in-place, accessible details dialog. Thread/topic chips and Open thread still open their topic.
- Show the source identity and what successful tools used it for. Aggregate deduplicated, bounded, structured action metadata; do not copy raw tool args, outputs, shell commands, file content or search text. Existing records with no details show an honest unavailable-details message plus their known identity, not invented actions.
- On phone layouts, opening a topic from a Solo source chip or thread card remembers Solo as the Back destination. Toolbar Back and platform/browser navigation should agree with existing routing semantics; the first toolbar Back still dismisses the keyboard. Ordinary topic selection, endpoint changes and new-topic entry must not keep stale Solo provenance. Desktop behaviour stays unchanged.
Scope
- Extend Solo source recording, transport/types/parsing only where necessary; preserve older data and source ordering/deduplication. Change source-chip UI/dialog and narrow Solo-origin navigation, plus regression tests and localization.
- No new pages, general navigation redesign, full tool logs in dialogs, or unrelated UI changes.
Decisions
- Record minimal successful tool/action identifiers and safe display metadata, not sensitive payloads; details describe observed operations, not guessed context. Multiple uses of one source accumulate rather than disappearing after deduplication.
- Use the existing dialog and responsive/router conventions; current nsh version in the repo takes precedence over the stale version in factory rules.
Checking
- Go coverage for aggregation, successful-only recording, old JSON compatibility and detached snapshot semantics where applicable.
- Console coverage for all five chip kinds, dialog contents/close, old/empty details, thread cards, phone Solo return versus normal topic Back, desktop and stale provenance.
- Run configured gofmt/vet/go tests, nsh check and scripts/test.sh. UI visual/physical-device checks must be reported as unverified if unavailable.

Additional behaviour and checking
- A persisted topic with started_from `_solo` is collected as a thread even when started by an earlier reply; ordinary topics stay topics. Cover prior-reply classification and same-reply deduplication with regression tests.

## factory · 2026-11-25 22:40
Built in commits 366c55ea, 50440132 and e0ce1674; advanced to current master before implementation.
- Workspace, memory and journal chips open a localized in-place details dialog with successful action counts; old replies honestly report that details were not recorded. No raw arguments or output are recorded.
- On phone layouts, topic/thread chips and Open thread remember Solo as their Back destination; ordinary navigation clears that provenance, desktop stays unchanged. Toolbar Back uses existing keyboard-dismiss behavior. Browser history follows existing replacement semantics, so browser Back may visit Solo twice.
- Persisted started_from metadata identifies Solo threads read by later replies; existing stored replies are not rewritten.
- Tests: configured gofmt, go vet ./... and go test ./... passed, independently verified by manager. Coder reports nsh check passed; scripts/test.sh passed 172 files, with chat-attachments passing its isolated rerun. Regression coverage includes source safety/aggregation/old records, stored thread origin, dialog interactions and mobile/desktop navigation.
- Installs: none.
- Not checked: visual UI, real Android/iPhone, dedicated iPhone edge-swipe test, and dedicated endpoint-change/browser-history provenance tests. UI appearance has not been inspected.
- Recovery: resumed an interrupted build's uncommitted item work; removed stale temporary files. No /tmp additions observed during this run.
- Written outside dir: coder reported creating its FT188 memory note and updating its memory index under its own Claude project memory; no secrets or machine paths were committed. This was outside the requested work area.
- Branch push initially failed because the credential request omitted the repository path; retry with per-command credential.useHttpPath=true succeeded.
