# Modes

This page collects the runtime entrypoints that are not covered in the top-level README.

The README focuses on:

- `morph run`
- the desktop App wrapper

For the other runtime modes, use the docs below.

## Terminal chat

- Command: `morph chat` (also the default for `morph`)
- Purpose: run the agent locally and share topics and history with Web Console through the same state directory; Console is started separately. Includes a subagent thread inspector
- Docs: [chat.md](./chat.md)

## Console

- Command: `morph console` (`morph console serve` remains supported)
- Purpose: local web UI backend plus in-process local runtime
- Docs: [console.md](./console.md)

## Telegram

- Command: `morph telegram`
- Purpose: long-polling Telegram bot runtime
- Docs: [telegram.md](./telegram.md)

## Slack

- Command: `morph slack`
- Purpose: Slack Socket Mode runtime
- Docs: [slack.md](./slack.md)

## LINE

- Command: `morph line`
- Purpose: LINE webhook runtime
- Docs: [line.md](./line.md)

## Lark

- Command: `morph lark`
- Purpose: Lark webhook runtime
- Docs: [lark.md](./lark.md)

## Mixin Messenger

- Command: `morph mixin`
- Purpose: Mixin Blaze WebSocket bot runtime
- Docs: [mixin.md](./mixin.md)

## Discord

- Command: `morph discord`
- Purpose: Discord Gateway bot runtime (DMs, server channels, threads)
- Docs: [discord.md](./discord.md)

## WeChat

- Command: `morph wechat` (`morph wechat login` to connect by QR code)
- Purpose: WeChat bot runtime over Tencent's iLink protocol (private chats)
- Docs: [wechat.md](./wechat.md)

## WhatsApp

- Command: `morph whatsapp`
- Purpose: WhatsApp Agent Platform runtime (a private chat with the agent's creator)
- Docs: [whatsapp.md](./whatsapp.md)

## Note

Legacy standalone daemon mode (`morph serve`) has been removed.
