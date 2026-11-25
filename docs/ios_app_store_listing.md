# iOS App Store Listing

The text and settings for the App Store page of **Morph**, the iPhone app. Paste them into App Store Connect when you submit (see [iOS Release](ios_release.md), Part 11).

## Name, subtitle and promotional text

The store name stays `Morph - AI Agent` (Part 4). App Store search already indexes the words in the name, so the subtitle and keywords don't repeat them.

| Field | Limit | Text |
| --- | --- | --- |
| Subtitle | 30 characters | Your self-hosted assistant |
| Promotional text (optional) | 170 characters | Talk to your own Mister Morph agent from your iPhone: chat, start work in topics, check todos and follow runs, all on a server you control. |

## Description

Paste the text below as it stands. It is about 1,400 of the 4,000 characters allowed. It says up front that the app needs a server, which App Review checks under Guideline 2.1.

```text
Morph is the iPhone app for Mister Morph, an open-source AI agent you run on your own computer or server. The app connects to your agent and lets you work with it from anywhere.

Morph needs a Mister Morph server. Install Mister Morph on a Mac, Linux or Windows machine (mistermorph.com/downloads), start its Console, then sign in from the app with the server's address, or scan the QR code it shows.

What you can do

• Chat with your agent in topics, each with its own history and workspace
• Use Solo: one pinned conversation where the agent answers, recalls what you discussed, or starts work in its own topic
• Follow runs as they happen: the tools the agent calls, the files it writes, and what it is waiting on
• Send photos and files, and receive the files the agent makes
• Speak instead of typing, when your server has a transcription model
• Plan with todos and scheduled jobs, and see when each one ran
• Review memories, skills, contacts, logs and usage
• Change settings, models and integrations without a terminal

Your server, your data

The app talks only to the server you sign in to. Your messages, files and keys stay on that server and go to the model providers you configure there. Morph has no account system of its own and no analytics.

Open source

Mister Morph is open source on GitHub (quailyquaily/mistermorph). The same agent also runs as a desktop app, a command-line tool, and on Telegram, Slack, LINE and Lark.
```

## Keywords

The keywords use 97 of the 100 characters allowed. Separate them with commas and no spaces. Leave out the words already in the name (Morph, AI, Agent) and other companies' trademarks; App Review rejects trademarks.

```text
assistant,self-hosted,llm,chatbot,automation,workflow,todo,schedule,open source,skills,server,mcp
```

## The rest of the review checklist

Each row below clears one error in App Store Connect's "Unable to Add for Review" box.

| Field | Where | Value |
| --- | --- | --- |
| Support URL | Version page | https://github.com/quailyquaily/mistermorph/issues |
| Marketing URL (optional) | Version page | https://mistermorph.com |
| Primary category | App Information | Productivity (secondary: Developer Tools) |
| Price | Pricing and Availability | Free, all countries |
| Build | Version page, **+** next to **Build** | The release's build, once TestFlight has processed it |
| Contact information | Version page, **App Review Information** | Name, phone and email. For sign-in, the demo server's https address and its Console password (Part 10) |
| Review notes | **App Review Information** | The app is a client for a self-hosted Mister Morph server, and a demo server is provided for review. It allows plain http because users' own servers often run on their local network without TLS. |
| Trader status | **Business** → DSA | Trader: the account belongs to a company, and Part 11 says a company is a trader. Use business contact details, because the EU App Store shows them. |

Still missing:

- [ ] **Privacy Policy URL:** there is no privacy policy page yet. App Privacy and TestFlight's Test Information both need one.
- [ ] **Screenshots:** iPhone 6.9-inch (1320 × 2868) or 6.5-inch (1284 × 2778), taken from the TestFlight build. Expect this to be the next error once the fields above are filled.
