# Project Overview

## Description

**pi-agent-extensions-extra** is a collection of extra [pi](https://github.com/mariozechner/pi) coding agent extensions — useful for some, not all. This is a companion to [pi-agent-extensions](https://github.com/rytswd/pi-agent-extensions) which contains broadly useful extensions.

Extensions here are more opinionated or depend on external services (e.g. Telegram).

## Core Principles

- **Opt-in by default** — extensions that connect to external services don't auto-enable
- **XDG-compliant config** — all mutable state in `~/.config/` (Nix-store safe)
- **Zero npm dependencies** — only peerDependencies on pi's built-in packages
- **Session-scoped activation** — external connections are per-session, not persistent
- **Bridge pattern** — persistent Go server for multi-session coordination

## Technology Stack

- **Language**: TypeScript (extensions), Go (bridge server)
- **Runtime**: Node.js (via pi's jiti loader), Go stdlib
- **Extension API**: `@mariozechner/pi-coding-agent`
- **Bridge**: Zero-dep Go binary, stdlib only (`net/http`, `encoding/json`)

## Project Structure

```
pi-agent-extensions-extra/
├── telegram-connect/       # Telegram bridge extension
│   ├── index.ts            # Extension entrypoint
│   └── src/
│       ├── bridge-client.ts # Bridge HTTP/SSE client
│       ├── telegram.ts     # Telegram Bot API client (direct mode)
│       ├── format.ts       # Message formatting and draft state
│       └── queue.ts        # Message queue
├── bridge/                 # Generic message bridge (Go)
│   ├── main.go             # Config, startup, adapter init
│   ├── adapter.go          # Adapter interface
│   ├── router.go           # Session registry, SSE, routing
│   ├── send.go             # Outbound message endpoint
│   └── adapter/
│       └── telegram/
│           └── telegram.go # Telegram adapter
├── package.json
├── air/                    # Air documentation
│   ├── context/            # Project context (this directory)
│   ├── telegram-connect.org
│   └── telegram-bridge.org
└── README.org
```

## Extensions

### telegram-connect/
Bridges pi sessions to Telegram. Bidirectional: agent responses pushed to phone, text/photos from Telegram injected as prompts. Two modes: bridge (multi-session safe via pi-bridge) and direct (single-session fallback).

- **Config**: `~/.config/pi-telegram-connect/config.json`
- **Commands**: `/telegram`, `/telegram setup`, `/telegram start`, `/telegram stop`, `/telegram topic`
- **Activation**: Session-scoped — must run `/telegram` per session
- **Bridge mode**: Used when topicId configured — routes via pi-bridge
- **Direct mode**: Fallback when no topic or bridge unavailable
- **Status**: Nerd Font Telegram icon + topic name in statusline
- **Env**: `PI_NO_TELEGRAM=1` to disable, `PI_BRIDGE_BIN` to override bridge binary
- **Based on**: [walkie](https://github.com/aldoborrero/pi-agent-kit/tree/main/extensions/walkie) by aldoborrero

### bridge/
Generic Go message bridge server. Currently supports Telegram adapter, extensible to Discord/Slack/Matrix via adapter interface. Single binary, zero external deps.

- **Binary**: `pi-bridge` (built via `CGO_ENABLED=0 go install .`)
- **Config**: `~/.config/pi-bridge/config.json` (auto-created by telegram-connect)
- **Port**: 19384 (configurable)
- **Features**: Topic-based routing, SSE event streams, stale session cleanup, topic conflict rejection
- **Air doc**: `air/telegram-bridge.org`

## Current Focus

telegram-connect and pi-bridge are functional with bridge mode for multi-session safety. Direct mode serves as fallback. Future work: additional adapters (Discord, Slack), web UI for bridge status.

Use `airctl status` to see planning documents and their states.
