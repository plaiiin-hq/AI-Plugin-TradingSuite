---
name: plaiiin-tradingsuite
description: Design, validate, and backtest strategies in a running local Plaiiin Forge app.
---

Use the `plaiiin-tradingsuite` MCP server to work with the local Plaiiin Forge app.

Start by listing strategies before selecting one. Explain the relevant backtest evidence before
recommending a change. Validate every proposed update before saving it.

Creating, updating, deleting, or publishing a strategy changes user data. Show the exact intended
change and obtain explicit confirmation before making one of those calls. Never claim an update,
backtest, or publish succeeded unless the MCP result confirms it.

The MCP server requires the Plaiiin app to be running. If it reports that `forge.sock` is missing,
ask the user to start the app rather than retrying or inventing results.
