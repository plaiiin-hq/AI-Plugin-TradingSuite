# Plaiiin TradingSuite — Claude Desktop plugin

Design, backtest, and improve trading strategies **from inside Claude** — this plugin connects
Claude Desktop to your locally running **Plaiiin** app and exposes its trading tools.

Ask Claude things like *"why is my bollinger-mean-reversion strategy losing, and can you fix it?"* —
it reads the strategy + backtest results, edits the DSL, re-runs backtests, and iterates.

## Install

1. **Download** the latest `plaiiin-tradingsuite.mcpb` from the [Releases](../../releases) page.
2. **Open it** — double-click, or drag it into Claude Desktop, or Settings → Extensions →
   Advanced → *Install Extension…*
3. Review the permissions/config prompt and install. The **Plaiiin app must be running** (the plugin
   talks to it over a local socket; the default run-dir works out of the box).

Signed with **Developer ID Application: plaiiin GmbH**.

## What it does

- **Strategies** — list / get / create / update / validate / delete, run backtests, read
  AI-friendly summaries + individual trades, publish versioned releases.
- **Phases · Levels · Hoops** — full CRUD for the strategy building blocks.
- **Market data** — candles, indicators, evaluate DSL conditions.
- **Slash commands** — `/analyze-strategy`, `/risk-review`, `/compare-backtests`.
- **Interactive chart** — `plaiiin_show_chart` opens a pan/zoom candlestick chart in the
  conversation (Claude Desktop MCP App).

## Requirements

- The **Plaiiin** desktop app, installed and running.
- Claude Desktop (macOS / Windows) — it ships a built-in Node runtime, so no extra install.

## Build from source

The MCP server (`server/index.js`) is single-sourced from the Plaiiin monorepo. To repackage:

```bash
npm install -g @anthropic-ai/mcpb
cd server && npm install && cd ..
mcpb pack . plaiiin-tradingsuite.mcpb
```

---

© plaiiin GmbH. All rights reserved.
