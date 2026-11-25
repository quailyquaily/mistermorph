# Solo chips: details dialog, and Back to Solo on phones

## lyric · 2026-11-25 21:46
Two changes to Solo's chips and thread cards (FT186) in the Console.

1. The workspace, memory and journal chips under a Solo reply can't be pressed today; only the thread and topic chips can (they open the topic). Pressing one of these three should open a dialog with some details about it: what the reply used and how. It should not take the user to another page.
2. On the phone layout, when the user opens a thread or topic from Solo, by pressing a thread or topic chip or a thread card's Open thread button, Back from that topic should return to Solo, because that is where the user came from. On the desktop layout, keep the current behaviour for now.

Where it is today:
- Chips: `web/console-nsh/components/chat/ChatSoloSources.tsx`, used in `components/chat/ChatHistoryItem.tsx` (`ctx.onOpenTopic`, which is `selectTopic` in `pages/chat/chatController.ts`). Thread cards: `ChatSoloThread` in the same file.
- What a chip records comes from `internal/solo/sources.go` (`SourceCollector`, stored as `result.solo_sources`): today only kind, id and label. The dialog's details may need more recorded there.
