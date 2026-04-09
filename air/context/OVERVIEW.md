# Project Overview

## Description

**pi-agent-extensions-extra** is a collection of extra [pi](https://github.com/mariozechner/pi) coding agent extensions — useful for some, not all. This is a companion to [pi-agent-extensions](https://github.com/rytswd/pi-agent-extensions) which contains broadly useful extensions.

Extensions here are more opinionated or depend on external services (e.g. Telegram).

## Core Principles

- **Opt-in by default** — extensions that connect to external services don't auto-enable
- **XDG-compliant config** — all mutable state in `~/.config/` (Nix-store safe)
- **Zero npm dependencies** — only peerDependencies on pi's built-in packages
- **Session-scoped activation** — external connections are per-session, not persistent

## Technology Stack

- **Language**: TypeScript
- **Runtime**: Node.js (via pi's jiti loader — no compilation needed)
- **Extension API**: `@mariozechner/pi-coding-agent`

## Project Structure

```
pi-agent-extensions-extra/
├── telegram-connect/       # Telegram bridge
│   ├── index.ts
│   └── src/
│       ├── telegram.ts     # Telegram Bot API client
│       ├── format.ts       # Message formatting and draft state
│       └── queue.ts        # Message queue
├── package.json
├── air/                    # Air documentation
│   ├── context/            # Project context (this directory)
│   ├── telegram-bridge.org # Future: persistent bridge server
│   └── ...
└── README.org
```

## Extensions

### telegram-connect/
Bridges pi sessions to Telegram. Bidirectional: agent responses pushed to phone, text/photos from Telegram injected as prompts. Based on [walkie](https://github.com/aldoborrero/pi-agent-kit/tree/main/extensions/walkie) by aldoborrero.

- **Config**: `~/.config/pi-telegram-connect/config.json`
- **Commands**: `/telegram`, `/telegram setup`, `/telegram start`, `/telegram stop`
- **Activation**: Session-scoped — must run `/telegram start` per session
- **Air doc**: `air/telegram-connect.org` (complete), `air/telegram-bridge.org` (planned)

## Current Focus

telegram-connect is functional but has a known limitation: multiple pi sessions sharing the same bot token race for updates. The planned telegram-bridge architecture solves this with a persistent HTTP server that dispatches updates to the right session.

Use `airctl status` to see planning documents and their states.
