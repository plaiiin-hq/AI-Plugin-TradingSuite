#!/usr/bin/env node

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "fs";
import {homedir} from "os";
import {join} from "path";
import http from "http";

// The parent (Forge) passes PLAIIIN_RUN_DIR when it spawns the MCP bridge under
// a sandboxed/App-Group layout; fall back to the dev path otherwise.
const PLAIIIN_RUN_DIR = process.env.PLAIIIN_RUN_DIR
  || join(homedir(), ".plaiiin", "run");
const PLAIIIN_DOCS_DIR = join(homedir(), "Documents", "Plaiiin");

// Forge serves its HTTP API over a UNIX domain socket now (forge.sock) — no TCP
// port, no api.port file. The bind IS the publish, so discovery is socket-file
// presence. We speak HTTP over the socket via Node's http.request({ socketPath }).
function getForgeSocket() {
  const socketPath = join(PLAIIIN_RUN_DIR, "forge.sock");
  if (!existsSync(socketPath)) {
    return { error: "Strategy Forge is not running. Start the app first." };
  }
  return { socketPath };
}

async function apiCall(method, path, body = null) {
  const sock = getForgeSocket();
  if (sock.error) {
    return { error: sock.error };
  }

  const payload = body ? JSON.stringify(body) : null;
  const options = {
    socketPath: sock.socketPath,   // HTTP over the unix socket (no host/port)
    path,
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (payload) {
    options.headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let text = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ error: `API error (${res.statusCode}): ${text}` });
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve({ raw: text });
        }
      });
    });
    req.on("error", (e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        return resolve({ error: "Cannot connect to Strategy Forge on forge.sock. Make sure the app is running." });
      }
      resolve({ error: `API call failed: ${e.message}` });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// DSL syntax help for descriptions
const DSL_EXAMPLES = `
DSL Syntax Examples:
- Indicators: RSI(14), SMA(200), EMA(50), ATR(14), ADX(14)
- MACD: MACD(12,26,9).line, MACD(12,26,9).signal, MACD(12,26,9).histogram
- Bollinger: BBANDS(20,2).upper, BBANDS(20,2).lower, BBANDS(20,2).middle
- Stochastic: STOCHASTIC(14).k, STOCHASTIC(14).d
- Price: price, close, open, high, low, volume
- Range: HIGH_OF(20), LOW_OF(20), RANGE_POSITION(20)
- Operators: AND, OR, >, <, >=, <=, ==, crosses_above, crosses_below
- Time: HOUR, DAYOFWEEK (1=Mon), DAY, MONTH
- Example: RSI(14) < 30 AND price > SMA(200) AND ADX(14) > 25
`.trim();

// Define available tools with improved descriptions
const TOOLS = [
  {
    name: "plaiiin_show_chart",
    description: "Open an INTERACTIVE candlestick chart (pan/zoom, crosshair) for a symbol inside Claude Desktop. The chart widget loads its own OHLC data from the running Plaiiin app and lets the user explore price action. Use when the user wants to SEE a chart rather than read numbers. Requires an MCP-Apps-capable host (Claude Desktop); on other hosts it degrades to returning the symbol/timeframe as text.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol to chart, e.g. BTCUSDT" },
        timeframe: { type: "string", description: "Timeframe, e.g. 1h, 4h, 1d", default: "1h" },
      },
      required: ["symbol"],
    },
    _meta: { "ui": { "resourceUri": "ui://plaiiin/chart" } },
  },
  {
    name: "plaiiin_list_strategies",
    description: "List all trading strategies with their IDs, names, symbols, and timeframes. Use this first to discover available strategies.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "plaiiin_get_strategy",
    description: "Get the full configuration of a strategy including entry/exit conditions, position sizing, and backtest settings. Returns the complete strategy JSON.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID (e.g., 'rsi-reversal', 'ema-crossover')",
        },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "plaiiin_create_strategy",
    description: `Create a new trading strategy. Provide a unique ID and full strategy configuration.

${DSL_EXAMPLES}

Required fields: id, name, entrySettings.condition, backtestSettings (symbol, timeframe, duration)`,
    inputSchema: {
      type: "object",
      properties: {
        strategy: {
          type: "object",
          description: `Full strategy object. Example:
{
  "id": "my-rsi-strategy",
  "name": "My RSI Strategy",
  "entrySettings": {
    "condition": "RSI(14) < 30 AND price > SMA(200)",
    "maxOpenTrades": 1
  },
  "exitSettings": {
    "zones": [{
      "name": "Default",
      "stopLossType": "trailing_percent",
      "stopLossValue": 2.0,
      "takeProfitType": "fixed_percent",
      "takeProfitValue": 5.0
    }]
  },
  "backtestSettings": {
    "symbol": "BTCUSDT",
    "timeframe": "1h",
    "duration": "6m",
    "initialCapital": 10000,
    "positionSizingType": "fixed_percent",
    "positionSizingValue": 10
  }
}`,
        },
      },
      required: ["strategy"],
    },
  },
  {
    name: "plaiiin_validate_strategy",
    description: `Validate strategy updates WITHOUT saving. ALWAYS use this before plaiiin_update_strategy to catch DSL syntax errors and invalid settings.

${DSL_EXAMPLES}`,
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID to validate against",
        },
        updates: {
          type: "object",
          description: `Partial updates to validate. Example:
{
  "entrySettings": { "condition": "RSI(14) < 25" },
  "exitSettings": { "zones": [{ "stopLossValue": 1.5 }] }
}`,
        },
      },
      required: ["strategyId", "updates"],
    },
  },
  {
    name: "plaiiin_update_strategy",
    description: "Update a strategy configuration. Supports partial updates - only provide fields you want to change. IMPORTANT: Use plaiiin_validate_strategy first!",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID to update",
        },
        updates: {
          type: "object",
          description: "Partial updates to apply (merged with existing config)",
        },
      },
      required: ["strategyId", "updates"],
    },
  },
  {
    name: "plaiiin_run_backtest",
    description: "Run a backtest for a strategy. Blocks until complete and returns performance metrics including win rate, profit factor, Sharpe ratio, max drawdown, and trade count.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID to backtest",
        },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "plaiiin_delete_strategy",
    description: "Delete a strategy and all its backtest results. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID to delete",
        },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "plaiiin_get_summary",
    description: "Get AI-friendly backtest summary with: metrics, win/loss analysis by phase/hour/day, improvement suggestions, and history trends comparing to previous runs. Also returns trade filenames for selective deep-dives.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID",
        },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "plaiiin_get_trade",
    description: "Get detailed data for a specific trade including entry/exit prices, P&L, MFE/MAE (max favorable/adverse excursion), active phases, and indicator values at entry/exit. Use trade filenames from plaiiin_get_summary.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID",
        },
        tradeFile: {
          type: "string",
          description: "Trade filename from tradeFiles array (e.g., '0001_WIN_+2p5pct_uptrend.json')",
        },
      },
      required: ["strategyId", "tradeFile"],
    },
  },
  {
    name: "plaiiin_list_phases",
    description: "List all available market phases for strategy filtering. Phases include: trend detection (uptrend, downtrend, ranging), sessions (asian, european, us-market), calendar (fomc, holidays), time (weekdays, specific days), funding rates, and moon phases.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "plaiiin_get_candles",
    description: "Get OHLCV candle data for a symbol/timeframe. Returns open, high, low, close, volume for each bar. Useful for custom analysis.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Trading symbol (default: BTCUSDT)",
          default: "BTCUSDT",
        },
        timeframe: {
          type: "string",
          description: "Timeframe: 1m, 5m, 15m, 1h, 4h, 1d (default: 1h)",
          default: "1h",
        },
        bars: {
          type: "number",
          description: "Number of bars to return (default: 100, max: 1000)",
          default: 100,
        },
      },
      required: [],
    },
  },
  {
    name: "plaiiin_get_indicator",
    description: `Calculate indicator values for analysis. Computed by the Compute service (server adds warmup bars automatically so requested bars are accurate).

Supported indicators:
- RSI(period): Relative Strength Index, 0-100
- SMA(period), EMA(period): Moving averages
- ATR(period): Average True Range (volatility)
- ADX(period), PLUS_DI(period), MINUS_DI(period): Trend strength
- MACD(fast,slow,signal).line/signal/histogram
- BBANDS(period,stddev).upper/middle/lower
- STOCHASTIC(k,d).k/.d
- SUPERTREND(period,mult).trend, ICHIMOKU().tenkan/.kijun/...
- VWAP, DELTA, CUM_DELTA, OHLCV_DELTA, OHLCV_CVD, BUY_RATIO, TRADE_COUNT
- FUNDING, FUNDING_8H, OI, PREMIUM, FEAR_GREED, RVOL(weeks)
- PREV_DAY_POC/VAH/VAL, TODAY_POC/VAH/VAL
- price/close/open/high/low/volume, QUOTE_VOLUME, BUY_VOLUME, SELL_VOLUME
- Bar-derived: RANGE_POSITION(n,skip), HIGH_OF(n), LOW_OF(n), AVG_VOLUME(n), HAMMER/SHOOTING_STAR/DOJI, BODY_SIZE/BODY_RATIO/IS_BULLISH/IS_BEARISH, HOUR/DAYOFWEEK/DAY/MONTH, MOON_PHASE, IS_US_HOLIDAY, IS_FOMC_MEETING
- Footprint: IMBALANCE_AT_POC/VAH/VAL, STACKED_BUY/SELL_IMBALANCES(n), ABSORPTION(vol,move), HIGH_VOLUME_NODE_COUNT(t), VOLUME_ABOVE/BELOW_POC_RATIO, FOOTPRINT_POC, FOOTPRINT_DELTA
- Spectrum/whale: SPECTRUM_VOLUME/COUNT/DELTA(...), WHALE_RATIO(b), WHALE_DELTA/WHALE_BUY_VOL/WHALE_SELL_VOL/LARGE_TRADE_COUNT(threshold)
- Rotating rays: RESISTANCE_RAY_BROKEN/CROSSED/DISTANCE(ray,look,skip), RESISTANCE_RAYS_BROKEN/RAY_COUNT(look,skip), SUPPORT_ variants
- Ring-derived: OI_CHANGE, OI_DELTA(n), PREMIUM_AVG(n), FEAR_GREED_AVG(n)
- Rolling candle-ring volume profile: POC(n), VAH(n), VAL(n)

Note: sub-minute timeframes are not available via this endpoint (the server's Compute window fetch is bar-timeframe granular) — use a bar timeframe of 1m or coarser, or evaluate via plaiiin_eval_condition instead.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Indicator (e.g., 'RSI(14)', 'SMA(200)', 'MACD(12,26,9).histogram')",
        },
        symbol: {
          type: "string",
          description: "Trading symbol (default: BTCUSDT)",
          default: "BTCUSDT",
        },
        timeframe: {
          type: "string",
          description: "Timeframe (default: 1h)",
          default: "1h",
        },
        bars: {
          type: "number",
          description: "Number of result bars (default: 50). Extra warmup bars added automatically.",
          default: 50,
        },
      },
      required: ["name"],
    },
  },
  {
    name: "plaiiin_eval_condition",
    description: `Find bars where a DSL condition evaluates to true. Great for testing entry/exit conditions before adding to strategy.

${DSL_EXAMPLES}`,
    inputSchema: {
      type: "object",
      properties: {
        condition: {
          type: "string",
          description: "DSL condition (e.g., 'RSI(14) < 30 AND price > SMA(200)')",
        },
        symbol: {
          type: "string",
          description: "Trading symbol (default: BTCUSDT)",
          default: "BTCUSDT",
        },
        timeframe: {
          type: "string",
          description: "Timeframe (default: 1h)",
          default: "1h",
        },
        bars: {
          type: "number",
          description: "Number of bars to scan (default: 500)",
          default: 500,
        },
      },
      required: ["condition"],
    },
  },

  // ========== Phase Tools ==========
  {
    name: "plaiiin_get_phase",
    description: "Get details of a specific market phase including its DSL condition, timeframe, and category.",
    inputSchema: {
      type: "object",
      properties: {
        phaseId: {
          type: "string",
          description: "Phase ID (e.g., 'uptrend', 'us-market-hours', 'fomc-meeting-day')",
        },
      },
      required: ["phaseId"],
    },
  },
  {
    name: "plaiiin_create_phase",
    description: `Create a custom market phase for filtering strategy entries.

${DSL_EXAMPLES}

Categories: Trend, Session, Time, Calendar, Technical, Funding, Moon, Custom`,
    inputSchema: {
      type: "object",
      properties: {
        phase: {
          type: "object",
          description: `Phase object. Example:
{
  "id": "my-trend-filter",
  "name": "My Trend Filter",
  "description": "Custom trend detection",
  "category": "Trend",
  "condition": "ADX(14) > 30 AND PLUS_DI(14) > MINUS_DI(14)",
  "timeframe": "4h",
  "symbol": "BTCUSDT"
}`,
        },
      },
      required: ["phase"],
    },
  },
  {
    name: "plaiiin_update_phase",
    description: "Update a custom phase. Built-in phases cannot be modified.",
    inputSchema: {
      type: "object",
      properties: {
        phaseId: {
          type: "string",
          description: "Phase ID to update",
        },
        updates: {
          type: "object",
          description: "Partial updates (e.g., { condition: 'ADX(14) > 35' })",
        },
      },
      required: ["phaseId", "updates"],
    },
  },
  {
    name: "plaiiin_delete_phase",
    description: "Delete a custom phase. Built-in phases cannot be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        phaseId: {
          type: "string",
          description: "Phase ID to delete",
        },
      },
      required: ["phaseId"],
    },
  },

  // ========== Level Tools ==========
  // Levels are the PRICE-axis parallel to phases: a level is "active" when
  // price sits inside the zone(s) computed for its type. CRUD over the Forge
  // HTTP API (/levels, /level/{id}) — the API validates + persists.
  {
    name: "plaiiin_list_levels",
    description: "List all price levels. Levels filter strategy entries on the PRICE axis (the parallel to phases on the TIME axis) — active when price is inside the level's computed zone. Types: ATH/ATL (extremes), FIB (retracements), HTF (weekly/monthly structure), SR (support/resistance), CUSTOM (fixed price bounds), plus ICT (FVG, ORDER_BLOCK, LIQUIDITY, STRUCTURE_BREAK), PROJECTION/CONDITION_PROJECTION, RAY, ROUND.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "plaiiin_get_level",
    description: "Get the full definition of a specific price level, including type-specific config (ratios, anchors, mode, proximity, price bounds, …).",
    inputSchema: {
      type: "object",
      properties: {
        levelId: {
          type: "string",
          description: "Level ID (e.g., 'ath-daily', 'fib-swing')",
        },
      },
      required: ["levelId"],
    },
  },
  {
    name: "plaiiin_create_level",
    description: `Create a price level. Provide a 'level' object. Required: id, timeframe, type. Type-specific fields:
- ATH/ATL/SWING: mode ("latest"|"all"|index), minDominance (int), proximity (% activation range)
- FIB: ratios (e.g. [0.382, 0.5, 0.618]), anchorHigh / anchorLow ("auto" | DSL expr | static price)
- HTF: reference (e.g. "WEEKLY_HIGH", "MONTHLY_OPEN"), lookback (int)
- CUSTOM: minPrice / maxPrice (static prices)
Common: name, category (Fib/ATH/HTF/SR/Custom/…), proximity, recalculate ("STATIC"|"DYNAMIC"), notes.`,
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "object",
          description: `Level object. Example:
{
  "id": "fib-swing",
  "name": "Swing Fib Retracement",
  "timeframe": "4h",
  "type": "FIB",
  "category": "Fib",
  "ratios": [0.382, 0.5, 0.618],
  "anchorHigh": "auto",
  "anchorLow": "auto",
  "proximity": 0.5
}`,
          properties: {
            id: { type: "string", description: "Unique level ID (required)" },
            name: { type: "string", description: "Display name" },
            timeframe: { type: "string", description: "Candle resolution: 1m/5m/15m/1h/4h/1d/1w (required)" },
            type: {
              type: "string",
              description: "Level type (required)",
              enum: ["ATH", "ATL", "FIB", "HTF", "SR", "CONDITION_PROJECTION", "PROJECTION", "RAY", "ROUND", "CUSTOM", "FVG", "ORDER_BLOCK", "LIQUIDITY", "STRUCTURE_BREAK"],
            },
            category: { type: "string", description: "Grouping label: Fib, ATH, HTF, SR, Custom, …" },
            proximity: { type: "number", description: "% range around the level for activation" },
            recalculate: { type: "string", description: "STATIC (fixed drawn zone) or DYNAMIC (follows new swings/ATH/period)", enum: ["STATIC", "DYNAMIC"] },
            mode: { type: "string", description: "ATH/ATL/SWING: latest | all | index number" },
            minDominance: { type: "number", description: "ATH/ATL/SWING: min dominance for a valid extreme" },
            ratios: { type: "array", items: { type: "number" }, description: "FIB retracement/extension ratios" },
            anchorHigh: { type: "string", description: "FIB: 'auto' | DSL expr | static price" },
            anchorLow: { type: "string", description: "FIB: 'auto' | DSL expr | static price" },
            reference: { type: "string", description: "HTF reference, e.g. WEEKLY_HIGH, MONTHLY_OPEN" },
            lookback: { type: "number", description: "HTF: number of periods to look back" },
            minPrice: { type: "number", description: "CUSTOM: static lower price bound" },
            maxPrice: { type: "number", description: "CUSTOM: static upper price bound" },
            notes: { type: "string", description: "Free-form notes" },
          },
        },
      },
      required: ["level"],
    },
  },
  {
    name: "plaiiin_update_level",
    description: "Update a price level (partial). Provide the levelId and an 'updates' object with the fields to change; each present field replaces the stored value.",
    inputSchema: {
      type: "object",
      properties: {
        levelId: {
          type: "string",
          description: "Level ID to update",
        },
        updates: {
          type: "object",
          description: "Partial updates (e.g., { proximity: 1.0, ratios: [0.5, 0.618] })",
        },
      },
      required: ["levelId", "updates"],
    },
  },
  {
    name: "plaiiin_delete_level",
    description: "Delete a price level.",
    inputSchema: {
      type: "object",
      properties: {
        levelId: {
          type: "string",
          description: "Level ID to delete",
        },
      },
      required: ["levelId"],
    },
  },

  // ========== Strategy Version Tools ==========
  // Publishing cuts an IMMUTABLE, forever-kept snapshot of the working
  // strategy, tagged with a git-style commit message. Versions live under
  // strategies/{id}/versions/; the version id is a conflict-free UTC date-time.
  {
    name: "plaiiin_publish_strategy_version",
    description: "Publish the current working strategy as an IMMUTABLE, forever-kept version tagged with a git-style commit message describing what changed. Returns the new version id (a UTC date-time, conflict-free across iCloud sync + git sharing). Does NOT modify the working strategy — it freezes a snapshot under strategies/{id}/versions/.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "Strategy ID to publish a version of",
        },
        message: {
          type: "string",
          description: "Git-style commit message describing the change (required)",
        },
      },
      required: ["strategyId", "message"],
    },
  },
  {
    name: "plaiiin_list_strategy_versions",
    description: "List the published, immutable versions of a strategy, newest-first. Each entry has the version id (UTC date-time), publishedAt (epoch ms) and the git-style message. An unpublished strategy returns an empty list.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "Strategy ID whose version lineage to list",
        },
      },
      required: ["strategyId"],
    },
  },

  // ========== Hoop Pattern Tools ==========
  {
    name: "plaiiin_list_hoops",
    description: "List all hoop patterns. Hoops are sequential price checkpoints for detecting chart patterns like double bottoms, head & shoulders, etc.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "plaiiin_get_hoop",
    description: "Get details of a specific hoop pattern including all checkpoint definitions.",
    inputSchema: {
      type: "object",
      properties: {
        hoopId: {
          type: "string",
          description: "Hoop pattern ID",
        },
      },
      required: ["hoopId"],
    },
  },
  {
    name: "plaiiin_create_hoop",
    description: `Create a hoop pattern for detecting price formations. Each hoop is a price checkpoint with a target range and timing.

Hoop fields:
- name: Checkpoint name (e.g., 'first-low', 'breakout')
- minPricePercent/maxPricePercent: Price range relative to anchor (-5.0 to +5.0)
- distance: Expected bars from previous hoop
- tolerance: Allowed variance in bars
- anchorMode: 'actual_hit' or 'expected_position'`,
    inputSchema: {
      type: "object",
      properties: {
        hoop: {
          type: "object",
          description: `Hoop pattern object. Example:
{
  "id": "double-bottom",
  "name": "Double Bottom",
  "description": "Classic reversal pattern",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "hoops": [
    { "name": "first-low", "minPricePercent": -3.0, "maxPricePercent": -1.0, "distance": 5, "tolerance": 2, "anchorMode": "actual_hit" },
    { "name": "middle-peak", "minPricePercent": 1.0, "maxPricePercent": 4.0, "distance": 7, "tolerance": 3, "anchorMode": "actual_hit" },
    { "name": "second-low", "minPricePercent": -3.0, "maxPricePercent": 0.5, "distance": 7, "tolerance": 3, "anchorMode": "actual_hit" },
    { "name": "breakout", "minPricePercent": 2.0, "maxPricePercent": null, "distance": 5, "tolerance": 3, "anchorMode": "actual_hit" }
  ],
  "cooldownBars": 20,
  "allowOverlap": false
}`,
        },
      },
      required: ["hoop"],
    },
  },
  {
    name: "plaiiin_update_hoop",
    description: "Update an existing hoop pattern.",
    inputSchema: {
      type: "object",
      properties: {
        hoopId: {
          type: "string",
          description: "Hoop pattern ID to update",
        },
        updates: {
          type: "object",
          description: "Partial updates to apply",
        },
      },
      required: ["hoopId", "updates"],
    },
  },
  {
    name: "plaiiin_delete_hoop",
    description: "Delete a hoop pattern.",
    inputSchema: {
      type: "object",
      properties: {
        hoopId: {
          type: "string",
          description: "Hoop pattern ID to delete",
        },
      },
      required: ["hoopId"],
    },
  },

  // ========== Phase Analysis Tools ==========
  {
    name: "plaiiin_analyze_phases",
    description: "Analyze strategy trades against ALL available phases. For each phase, shows performance when phase is active vs inactive at trade entry. Returns REQUIRE/EXCLUDE recommendations with confidence scores. Requires a backtest run first.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: {
          type: "string",
          description: "The strategy ID to analyze",
        },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "plaiiin_phase_bounds",
    description: "Analyze when a phase is active over time. Returns time ranges when the phase condition was true, plus statistics. Great for understanding market regimes and validating phase filters.",
    inputSchema: {
      type: "object",
      properties: {
        phaseId: {
          type: "string",
          description: "Phase ID (e.g., 'uptrend', 'us-market-hours', 'high-funding')",
        },
        symbol: {
          type: "string",
          description: "Trading symbol (default: uses phase's symbol or BTCUSDT)",
        },
        timeframe: {
          type: "string",
          description: "Timeframe (default: uses phase's timeframe or 1h)",
        },
        bars: {
          type: "number",
          description: "Number of bars to analyze (default: 500)",
          default: 500,
        },
      },
      required: ["phaseId"],
    },
  },

  // ========== Help Tools ==========
  {
    name: "plaiiin_get_help",
    description: `Get help documentation as text. Returns the full content of a help topic, or searches for a term across all help docs.

Available topics:
- dsl: DSL syntax reference (all indicators, functions, operators, examples)
- strategy: Strategy guide (concepts, entry/exit settings, phases, hoops, metrics)

Use the 'search' parameter to find specific terms (e.g., search for "RSI" or "trailing stop").`,
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Help topic: 'dsl' or 'strategy'. If omitted with a search term, searches all topics.",
        },
        search: {
          type: "string",
          description: "Search term to find in help docs. Returns matching sections with context. Case-insensitive.",
        },
      },
      required: [],
    },
  },

  // ========== UI Tools ==========
  {
    name: "plaiiin_open_window",
    description: `Open a window in the Strategy Forge UI. Available windows:
- phases: Open the Phases editor
- hoops: Open the Hoops pattern editor
- settings: Open Settings dialog
- data: Open Data Management dialog
- dsl-help: Open DSL syntax help
- strategy-help: Open Strategy Guide
- downloads: Open Download Dashboard (data loading status and logs)
- launcher: Bring the launcher window to front
- project: Open a specific strategy project (requires strategyId)`,
    inputSchema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description: "Window to open: phases, hoops, settings, data, dsl-help, strategy-help, downloads, launcher, project",
        },
        strategyId: {
          type: "string",
          description: "Strategy ID (required only for window='project')",
        },
      },
      required: ["window"],
    },
  },

  // ========== Data / UI State Tools ==========
  {
    name: "plaiiin_get_pages",
    description: `Get all active data pages with their loading state, progress, listener count, and record counts.

Returns pages grouped by type: candles, aggTrades, funding, openInterest, premium, indicators.
Each page shows: key, symbol, timeframe, state (LOADING/READY/ERROR), loadProgress (0-100%), listeners, records, consumers.
Also returns aggTradesRecordCount (total aggTrade records in memory) and a summary with totalPages/totalListeners.

Use this to:
- Monitor aggTrades loading progress
- Check which data pages are active and their states
- Debug data loading issues
- See which consumers are using each page`,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "plaiiin_get_context",
    description: `Get full session context in one call. CALL THIS FIRST at the start of every session.

Returns everything about the strategy the user is currently looking at:
- ui.lastFocusedStrategyId: The active strategy — this is "the strategy" the user means
- focusedStrategy: Full config (entry/exit conditions, backtest settings)
- focusedSummary: Backtest metrics (win rate, profit factor, etc.), analysis by phase/hour, AI suggestions
- chartConfig: Enabled overlays and indicators on the chart

After calling this, summarize the focused strategy and its key metrics. Do NOT call plaiiin_list_strategies — focus on the active strategy.`,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "plaiiin_update_chart_config",
    description: `Update chart overlays and indicators. Accepts partial updates - only include what you want to change. Charts refresh automatically.

Example: { "overlays": { "SMA": { "enabled": true, "periods": [50, 200] } }, "indicators": { "RSI": { "enabled": true, "period": 14 } } }

Available overlays: SMA/EMA (periods array), BBANDS (period, stdDev), HighLow/Mayer (period), VWAP, DailyPOC, FloatingPOC, Rays, Ichimoku.
Available indicators: RSI/ATR/ADX/RANGE_POSITION (period), MACD (fast, slow, signal), STOCHASTIC (kPeriod, dPeriod), DELTA, CVD, FUNDING, OI, PREMIUM.`,
    inputSchema: {
      type: "object",
      properties: {
        overlays: {
          type: "object",
          description: "Overlay updates, e.g. { \"SMA\": { \"enabled\": true, \"periods\": [50, 200] } }",
        },
        indicators: {
          type: "object",
          description: "Indicator updates, e.g. { \"RSI\": { \"enabled\": true, \"period\": 14 } }",
        },
      },
    },
  },
  {
    name: "plaiiin_jump_chart_range",
    description: `Jump the chart window to a fixed date range ending at a given time — "show me what the chart looked like around <date>". No replay cursor is started; overlays/indicators keep streaming from the newly-pinned window. Use plaiiin_return_chart_to_live to go back to the live-streaming window.

Denied if the chart is currently in cursor-driven replay mode (call the /replay/exit HTTP route first, if that's ever exposed here) — jumping while replay owns the window would race the replay cursor.`,
    inputSchema: {
      type: "object",
      properties: {
        endMs: {
          type: "number",
          description: "Epoch milliseconds the window should end at (the chart shows bars leading up to this time).",
        },
      },
      required: ["endMs"],
    },
  },
  {
    name: "plaiiin_return_chart_to_live",
    description: `Return the chart window to the live anchor after a plaiiin_jump_chart_range — resumes streaming the current live window. Safe to call even if the chart was never jumped (idempotent no-op success).`,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// Tool handlers
async function handleTool(name, args) {
  switch (name) {
    case "plaiiin_show_chart":
      // The interactive chart is rendered by the ui://plaiiin/chart MCP App
      // (host reads _meta.ui.resourceUri); the widget fetches its own candles
      // via plaiiin_get_candles. This result is the text fallback + the initial
      // params the widget reads.
      return {
        symbol: (args.symbol || "BTCUSDT").toUpperCase(),
        timeframe: args.timeframe || "1h",
        note: "Interactive chart opened — pan/zoom inside the widget; data loads from the running Plaiiin app.",
      };

    case "plaiiin_list_strategies":
      return apiCall("GET", "/strategies");

    case "plaiiin_get_strategy": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      return apiCall("GET", `/strategy/${encodeURIComponent(args.strategyId)}`);
    }

    case "plaiiin_create_strategy": {
      if (!args.strategy) {
        return { error: "Missing required parameter: strategy object" };
      }
      const strategy = args.strategy;

      // Validate required fields
      if (!strategy.id) {
        return { error: "Strategy must have an 'id' field (e.g., 'my-rsi-strategy')" };
      }
      if (!strategy.name) {
        return { error: "Strategy must have a 'name' field" };
      }
      if (!strategy.entrySettings?.condition) {
        return { error: "Strategy must have entrySettings.condition (DSL entry condition)" };
      }
      if (!strategy.backtestSettings?.symbol) {
        return { error: "Strategy must have backtestSettings.symbol (e.g., 'BTCUSDT')" };
      }

      // Check if strategy already exists
      const strategyDir = join(PLAIIIN_DOCS_DIR, "strategies", strategy.id);
      const strategyPath = join(strategyDir, "strategy.json");
      if (existsSync(strategyPath)) {
        return { error: `Strategy '${strategy.id}' already exists. Use plaiiin_update_strategy to modify it.` };
      }

      // Set defaults
      const fullStrategy = {
        id: strategy.id,
        name: strategy.name,
        description: strategy.description || "",
        enabled: true,
        entrySettings: {
          condition: strategy.entrySettings.condition,
          maxOpenTrades: strategy.entrySettings?.maxOpenTrades || 1,
          minCandlesBetween: strategy.entrySettings?.minCandlesBetween || 0,
          dca: strategy.entrySettings?.dca || { enabled: false, maxEntries: 3, barsBetween: 1 },
        },
        exitSettings: strategy.exitSettings || {
          zones: [{
            name: "Default",
            stopLossType: "trailing_percent",
            stopLossValue: 2.0,
            takeProfitType: "none",
            takeProfitValue: null,
          }],
          evaluation: "candle_close",
        },
        backtestSettings: {
          symbol: strategy.backtestSettings.symbol,
          timeframe: strategy.backtestSettings?.timeframe || "1h",
          duration: strategy.backtestSettings?.duration || "6m",
          initialCapital: strategy.backtestSettings?.initialCapital || 10000,
          positionSizingType: strategy.backtestSettings?.positionSizingType || "fixed_percent",
          positionSizingValue: strategy.backtestSettings?.positionSizingValue || 10,
          feePercent: strategy.backtestSettings?.feePercent || 0.1,
          slippagePercent: strategy.backtestSettings?.slippagePercent || 0.05,
        },
        phaseSettings: strategy.phaseSettings || { requiredPhaseIds: [], excludedPhaseIds: [] },
        orderflowSettings: strategy.orderflowSettings || { mode: "disabled" },
      };

      // Create directory and write file
      try {
        mkdirSync(strategyDir, { recursive: true });
        writeFileSync(strategyPath, JSON.stringify(fullStrategy, null, 2));
        return {
          success: true,
          message: `Strategy '${strategy.id}' created successfully. Use plaiiin_run_backtest to test it.`,
          strategyId: strategy.id,
        };
      } catch (e) {
        return { error: `Failed to create strategy: ${e.message}` };
      }
    }

    case "plaiiin_validate_strategy": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      if (!args.updates) {
        return { error: "Missing required parameter: updates object" };
      }
      return apiCall("POST", `/strategy/${encodeURIComponent(args.strategyId)}/validate`, args.updates);
    }

    case "plaiiin_update_strategy": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      if (!args.updates) {
        return { error: "Missing required parameter: updates object" };
      }
      return apiCall("POST", `/strategy/${encodeURIComponent(args.strategyId)}`, args.updates);
    }

    case "plaiiin_run_backtest": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      return apiCall("POST", `/strategy/${encodeURIComponent(args.strategyId)}/backtest`);
    }

    case "plaiiin_delete_strategy": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }

      const strategyDir = join(PLAIIIN_DOCS_DIR, "strategies", args.strategyId);
      if (!existsSync(strategyDir)) {
        return { error: `Strategy '${args.strategyId}' not found.` };
      }

      try {
        const { rmSync } = await import("fs");
        rmSync(strategyDir, { recursive: true });
        return { success: true, message: `Strategy '${args.strategyId}' and all results deleted.` };
      } catch (e) {
        return { error: `Failed to delete strategy: ${e.message}` };
      }
    }

    case "plaiiin_get_summary": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      const strategyDir = join(PLAIIIN_DOCS_DIR, "strategies", args.strategyId);
      const summaryPath = join(strategyDir, "summary.json");

      if (!existsSync(strategyDir)) {
        return { error: `Strategy '${args.strategyId}' not found. Use plaiiin_list_strategies to see available strategies.` };
      }
      if (!existsSync(summaryPath)) {
        return { error: `No backtest results for '${args.strategyId}'. Run plaiiin_run_backtest first.` };
      }

      try {
        const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));

        // Remove large objects, keep metrics and analysis
        delete summary.trades;
        delete summary.strategy;
        delete summary.config;

        // List trade files
        const tradesDir = join(strategyDir, "trades");
        if (existsSync(tradesDir)) {
          summary.tradeFiles = readdirSync(tradesDir)
            .filter(f => f.endsWith(".json"))
            .sort();
        } else {
          summary.tradeFiles = [];
        }

        return summary;
      } catch (e) {
        return { error: `Failed to read summary: ${e.message}` };
      }
    }

    case "plaiiin_get_trade": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      if (!args.tradeFile) {
        return { error: "Missing required parameter: tradeFile (get from plaiiin_get_summary tradeFiles)" };
      }

      const tradePath = join(PLAIIIN_DOCS_DIR, "strategies", args.strategyId, "trades", args.tradeFile);

      if (!existsSync(tradePath)) {
        return { error: `Trade file not found: ${args.tradeFile}. Check tradeFiles from plaiiin_get_summary.` };
      }

      try {
        return JSON.parse(readFileSync(tradePath, "utf-8"));
      } catch (e) {
        return { error: `Failed to read trade: ${e.message}` };
      }
    }

    case "plaiiin_list_phases":
      return apiCall("GET", "/phases");

    case "plaiiin_get_candles": {
      const symbol = args.symbol || "BTCUSDT";
      const timeframe = args.timeframe || "1h";
      const bars = Math.min(args.bars || 100, 1000);
      return apiCall("GET", `/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&bars=${bars}`);
    }

    case "plaiiin_get_indicator": {
      if (!args.name) {
        return { error: "Missing required parameter: name (e.g., 'RSI(14)')" };
      }
      const symbol = args.symbol || "BTCUSDT";
      const timeframe = args.timeframe || "1h";
      const bars = args.bars || 50;

      // The server owns warmup now: the Compute-backed /indicator endpoint
      // fetches its window at bars + WARMUP_BARS and trims to the requested
      // count itself (ComputeIndicatorFetch.WARMUP_BARS). No MCP-side
      // inflation — it would double the warmup and slow the fetch.
      return apiCall(
        "GET",
        `/indicator?name=${encodeURIComponent(args.name)}&symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&bars=${bars}`
      );
    }

    case "plaiiin_eval_condition": {
      if (!args.condition) {
        return { error: "Missing required parameter: condition (DSL expression)" };
      }
      const symbol = args.symbol || "BTCUSDT";
      const timeframe = args.timeframe || "1h";
      const bars = args.bars || 500;
      return apiCall(
        "GET",
        `/eval?condition=${encodeURIComponent(args.condition)}&symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&bars=${bars}`
      );
    }

    // ========== Phase Handlers ==========

    case "plaiiin_get_phase": {
      if (!args.phaseId) {
        return { error: "Missing required parameter: phaseId" };
      }
      return apiCall("GET", `/phase/${encodeURIComponent(args.phaseId)}`);
    }

    case "plaiiin_create_phase": {
      if (!args.phase) {
        return { error: "Missing required parameter: phase object" };
      }
      const phase = args.phase;

      if (!phase.id) {
        return { error: "Phase must have an 'id' field" };
      }
      if (!phase.name) {
        return { error: "Phase must have a 'name' field" };
      }
      if (!phase.condition) {
        return { error: "Phase must have a 'condition' field (DSL expression)" };
      }

      const phaseDir = join(PLAIIIN_DOCS_DIR, "phases", phase.id);
      const phasePath = join(phaseDir, "phase.json");

      if (existsSync(phasePath)) {
        return { error: `Phase '${phase.id}' already exists. Use plaiiin_update_phase to modify it.` };
      }

      const fullPhase = {
        id: phase.id,
        name: phase.name,
        description: phase.description || "",
        category: phase.category || "Custom",
        condition: phase.condition,
        timeframe: phase.timeframe || "1h",
        symbol: phase.symbol || "BTCUSDT",
        builtIn: false,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };

      try {
        mkdirSync(phaseDir, { recursive: true });
        writeFileSync(phasePath, JSON.stringify(fullPhase, null, 2));
        return {
          success: true,
          message: `Phase '${phase.id}' created. Add it to strategy's phaseSettings.requiredPhaseIds to use.`,
          phaseId: phase.id,
        };
      } catch (e) {
        return { error: `Failed to create phase: ${e.message}` };
      }
    }

    case "plaiiin_update_phase": {
      if (!args.phaseId) {
        return { error: "Missing required parameter: phaseId" };
      }
      if (!args.updates) {
        return { error: "Missing required parameter: updates object" };
      }

      const phaseDir = join(PLAIIIN_DOCS_DIR, "phases", args.phaseId);
      const phasePath = join(phaseDir, "phase.json");

      if (!existsSync(phasePath)) {
        return { error: `Phase '${args.phaseId}' not found.` };
      }

      try {
        const existing = JSON.parse(readFileSync(phasePath, "utf-8"));

        if (existing.builtIn) {
          return { error: `Cannot modify built-in phase '${args.phaseId}'. Create a custom phase instead.` };
        }

        const updated = { ...existing, ...args.updates, updated: new Date().toISOString() };
        // Preserve immutable fields
        updated.id = existing.id;
        updated.builtIn = false;
        updated.created = existing.created;

        writeFileSync(phasePath, JSON.stringify(updated, null, 2));
        return { success: true, message: `Phase '${args.phaseId}' updated.`, phase: updated };
      } catch (e) {
        return { error: `Failed to update phase: ${e.message}` };
      }
    }

    case "plaiiin_delete_phase": {
      if (!args.phaseId) {
        return { error: "Missing required parameter: phaseId" };
      }

      const phaseDir = join(PLAIIIN_DOCS_DIR, "phases", args.phaseId);
      const phasePath = join(phaseDir, "phase.json");

      if (!existsSync(phasePath)) {
        return { error: `Phase '${args.phaseId}' not found.` };
      }

      try {
        const existing = JSON.parse(readFileSync(phasePath, "utf-8"));

        if (existing.builtIn) {
          return { error: `Cannot delete built-in phase '${args.phaseId}'.` };
        }

        // Remove the directory
        const { rmSync } = await import("fs");
        rmSync(phaseDir, { recursive: true });
        return { success: true, message: `Phase '${args.phaseId}' deleted.` };
      } catch (e) {
        return { error: `Failed to delete phase: ${e.message}` };
      }
    }

    // ========== Level Handlers ==========
    // CRUD over the Forge HTTP API (/levels, /level/{id}) — the API validates
    // required fields (id/timeframe/type) and rejects unknown types with a 400.

    case "plaiiin_list_levels":
      return apiCall("GET", "/levels");

    case "plaiiin_get_level": {
      if (!args.levelId) {
        return { error: "Missing required parameter: levelId" };
      }
      return apiCall("GET", `/level/${encodeURIComponent(args.levelId)}`);
    }

    case "plaiiin_create_level": {
      if (!args.level) {
        return { error: "Missing required parameter: level object" };
      }
      const level = args.level;
      if (!level.id) {
        return { error: "Level must have an 'id' field" };
      }
      if (!level.timeframe) {
        return { error: "Level must have a 'timeframe' field" };
      }
      if (!level.type) {
        return { error: "Level must have a 'type' field" };
      }
      return apiCall("POST", "/levels", level);
    }

    case "plaiiin_update_level": {
      if (!args.levelId) {
        return { error: "Missing required parameter: levelId" };
      }
      if (!args.updates) {
        return { error: "Missing required parameter: updates object" };
      }
      return apiCall("POST", `/level/${encodeURIComponent(args.levelId)}`, args.updates);
    }

    case "plaiiin_delete_level": {
      if (!args.levelId) {
        return { error: "Missing required parameter: levelId" };
      }
      return apiCall("DELETE", `/level/${encodeURIComponent(args.levelId)}`);
    }

    // ========== Strategy Version Handlers ==========
    // Route through the validated Forge HTTP API (POST /strategy/{id}/publish,
    // GET /strategy/{id}/versions) — the API freezes the immutable snapshot and
    // appends the manifest. Fail-visible: a blank message -> 400, unknown id -> 404.

    case "plaiiin_publish_strategy_version": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      if (!args.message || !String(args.message).trim()) {
        return { error: "A publish 'message' (git-style commit message) is required" };
      }
      return apiCall("POST", `/strategy/${encodeURIComponent(args.strategyId)}/publish`,
        { message: args.message });
    }

    case "plaiiin_list_strategy_versions": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      return apiCall("GET", `/strategy/${encodeURIComponent(args.strategyId)}/versions`);
    }

    // ========== Hoop Pattern Handlers ==========

    case "plaiiin_list_hoops": {
      const hoopsDir = join(PLAIIIN_DOCS_DIR, "hoops");
      if (!existsSync(hoopsDir)) {
        return { hoops: [] };
      }

      try {
        const dirs = readdirSync(hoopsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        const hoops = [];
        for (const dir of dirs) {
          const hoopPath = join(hoopsDir, dir, "hoop.json");
          if (existsSync(hoopPath)) {
            try {
              const hoop = JSON.parse(readFileSync(hoopPath, "utf-8"));
              hoops.push({
                id: hoop.id,
                name: hoop.name,
                description: hoop.description,
                symbol: hoop.symbol,
                timeframe: hoop.timeframe,
                hoopCount: hoop.hoops?.length || 0,
              });
            } catch {}
          }
        }
        return { hoops };
      } catch (e) {
        return { error: `Failed to list hoops: ${e.message}` };
      }
    }

    case "plaiiin_get_hoop": {
      if (!args.hoopId) {
        return { error: "Missing required parameter: hoopId" };
      }

      const hoopPath = join(PLAIIIN_DOCS_DIR, "hoops", args.hoopId, "hoop.json");
      if (!existsSync(hoopPath)) {
        return { error: `Hoop pattern '${args.hoopId}' not found.` };
      }

      try {
        return JSON.parse(readFileSync(hoopPath, "utf-8"));
      } catch (e) {
        return { error: `Failed to read hoop: ${e.message}` };
      }
    }

    case "plaiiin_create_hoop": {
      if (!args.hoop) {
        return { error: "Missing required parameter: hoop object" };
      }
      const hoop = args.hoop;

      if (!hoop.id) {
        return { error: "Hoop must have an 'id' field" };
      }
      if (!hoop.name) {
        return { error: "Hoop must have a 'name' field" };
      }
      if (!hoop.hoops || !Array.isArray(hoop.hoops) || hoop.hoops.length === 0) {
        return { error: "Hoop must have a 'hoops' array with at least one checkpoint" };
      }

      const hoopDir = join(PLAIIIN_DOCS_DIR, "hoops", hoop.id);
      const hoopPath = join(hoopDir, "hoop.json");

      if (existsSync(hoopPath)) {
        return { error: `Hoop '${hoop.id}' already exists. Use plaiiin_update_hoop to modify it.` };
      }

      // Calculate pattern bars
      let totalBars = 0;
      let minBars = 0;
      let maxBars = 0;
      for (const h of hoop.hoops) {
        totalBars += h.distance || 0;
        minBars += (h.distance || 0) - (h.tolerance || 0);
        maxBars += (h.distance || 0) + (h.tolerance || 0);
      }

      const fullHoop = {
        id: hoop.id,
        name: hoop.name,
        description: hoop.description || null,
        hoops: hoop.hoops.map(h => ({
          name: h.name || "checkpoint",
          minPricePercent: h.minPricePercent ?? -2.0,
          maxPricePercent: h.maxPricePercent ?? 2.0,
          distance: h.distance || 5,
          tolerance: h.tolerance || 2,
          anchorMode: h.anchorMode || "actual_hit",
        })),
        symbol: hoop.symbol || "BTCUSDT",
        timeframe: hoop.timeframe || "1h",
        cooldownBars: hoop.cooldownBars || 0,
        allowOverlap: hoop.allowOverlap || false,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        totalExpectedBars: totalBars,
        minPatternBars: Math.max(0, minBars),
        maxPatternBars: maxBars,
      };

      try {
        mkdirSync(hoopDir, { recursive: true });
        writeFileSync(hoopPath, JSON.stringify(fullHoop, null, 2));
        return {
          success: true,
          message: `Hoop pattern '${hoop.id}' created with ${fullHoop.hoops.length} checkpoints.`,
          hoopId: hoop.id,
        };
      } catch (e) {
        return { error: `Failed to create hoop: ${e.message}` };
      }
    }

    case "plaiiin_update_hoop": {
      if (!args.hoopId) {
        return { error: "Missing required parameter: hoopId" };
      }
      if (!args.updates) {
        return { error: "Missing required parameter: updates object" };
      }

      const hoopDir = join(PLAIIIN_DOCS_DIR, "hoops", args.hoopId);
      const hoopPath = join(hoopDir, "hoop.json");

      if (!existsSync(hoopPath)) {
        return { error: `Hoop pattern '${args.hoopId}' not found.` };
      }

      try {
        const existing = JSON.parse(readFileSync(hoopPath, "utf-8"));
        const updated = { ...existing, ...args.updates, updated: new Date().toISOString() };

        // Preserve immutable fields
        updated.id = existing.id;
        updated.created = existing.created;

        // Recalculate pattern bars if hoops changed
        if (updated.hoops && Array.isArray(updated.hoops)) {
          let totalBars = 0, minBars = 0, maxBars = 0;
          for (const h of updated.hoops) {
            totalBars += h.distance || 0;
            minBars += (h.distance || 0) - (h.tolerance || 0);
            maxBars += (h.distance || 0) + (h.tolerance || 0);
          }
          updated.totalExpectedBars = totalBars;
          updated.minPatternBars = Math.max(0, minBars);
          updated.maxPatternBars = maxBars;
        }

        writeFileSync(hoopPath, JSON.stringify(updated, null, 2));
        return { success: true, message: `Hoop pattern '${args.hoopId}' updated.`, hoop: updated };
      } catch (e) {
        return { error: `Failed to update hoop: ${e.message}` };
      }
    }

    case "plaiiin_delete_hoop": {
      if (!args.hoopId) {
        return { error: "Missing required parameter: hoopId" };
      }

      const hoopDir = join(PLAIIIN_DOCS_DIR, "hoops", args.hoopId);
      if (!existsSync(hoopDir)) {
        return { error: `Hoop pattern '${args.hoopId}' not found.` };
      }

      try {
        const { rmSync } = await import("fs");
        rmSync(hoopDir, { recursive: true });
        return { success: true, message: `Hoop pattern '${args.hoopId}' deleted.` };
      } catch (e) {
        return { error: `Failed to delete hoop: ${e.message}` };
      }
    }

    // ========== Phase Analysis Handlers ==========

    case "plaiiin_analyze_phases": {
      if (!args.strategyId) {
        return { error: "Missing required parameter: strategyId" };
      }
      return apiCall("GET", `/strategy/${encodeURIComponent(args.strategyId)}/analyze-phases`);
    }

    case "plaiiin_phase_bounds": {
      if (!args.phaseId) {
        return { error: "Missing required parameter: phaseId" };
      }
      let url = `/phase/${encodeURIComponent(args.phaseId)}/bounds`;
      const queryParams = [];
      if (args.symbol) queryParams.push(`symbol=${encodeURIComponent(args.symbol)}`);
      if (args.timeframe) queryParams.push(`timeframe=${encodeURIComponent(args.timeframe)}`);
      if (args.bars) queryParams.push(`bars=${args.bars}`);
      if (queryParams.length > 0) {
        url += '?' + queryParams.join('&');
      }
      return apiCall("GET", url);
    }

    // ========== Help Handlers ==========

    case "plaiiin_get_help": {
      const HELP_TOPICS = {
        dsl: { file: "DSL_REFERENCE.md", label: "DSL Reference" },
        strategy: { file: "STRATEGY_GUIDE.md", label: "Strategy Guide" },
      };

      const topic = args.topic;
      const search = args.search;

      // Determine which files to read
      let topicEntries;
      if (topic) {
        const entry = HELP_TOPICS[topic];
        if (!entry) {
          return { error: `Unknown topic '${topic}'. Available: ${Object.keys(HELP_TOPICS).join(", ")}` };
        }
        topicEntries = [[topic, entry]];
      } else {
        topicEntries = Object.entries(HELP_TOPICS);
      }

      const results = [];
      for (const [key, entry] of topicEntries) {
        const filePath = join(PLAIIIN_RUN_DIR, entry.file);
        if (!existsSync(filePath)) {
          results.push({ topic: key, error: `Help file not found: ${entry.file}. Start Strategy Forge to generate it.` });
          continue;
        }

        const content = readFileSync(filePath, "utf-8");

        if (!search) {
          // Return full content
          results.push({ topic: key, title: entry.label, content });
        } else {
          // Search: find matching sections with context
          const searchLower = search.toLowerCase();
          const lines = content.split("\n");
          const matches = [];
          let currentSection = "";

          for (let i = 0; i < lines.length; i++) {
            // Track section headers
            if (lines[i].startsWith("## ")) {
              currentSection = lines[i].replace(/^#+\s*/, "");
            }

            if (lines[i].toLowerCase().includes(searchLower)) {
              // Grab context: 2 lines before and after
              const start = Math.max(0, i - 2);
              const end = Math.min(lines.length - 1, i + 2);
              const contextLines = lines.slice(start, end + 1).join("\n");
              matches.push({
                section: currentSection,
                line: i + 1,
                context: contextLines,
              });
            }
          }

          if (matches.length > 0) {
            // Deduplicate overlapping contexts
            const deduped = [];
            let lastEnd = -1;
            for (const m of matches) {
              if (m.line - 2 > lastEnd) {
                deduped.push(m);
              }
              lastEnd = m.line + 2;
            }
            results.push({ topic: key, title: entry.label, searchTerm: search, matchCount: matches.length, matches: deduped });
          }
        }
      }

      if (search && results.length === 0) {
        return { message: `No matches found for '${search}' in ${topic ? `topic '${topic}'` : "any help topic"}.` };
      }

      return results.length === 1 ? results[0] : { results };
    }

    // ========== UI Handlers ==========

    case "plaiiin_open_window": {
      if (!args.window) {
        return { error: "Missing required parameter: window. Options: phases, hoops, settings, data, dsl-help, launcher, project" };
      }
      let url = `/ui/open?window=${encodeURIComponent(args.window)}`;
      if (args.strategyId) {
        url += `&id=${encodeURIComponent(args.strategyId)}`;
      }
      return apiCall("POST", url);
    }

    // ========== Data / UI State Handlers ==========

    case "plaiiin_get_pages": {
      return apiCall("GET", "/pages");
    }

    case "plaiiin_get_context": {
      const result = {};

      // Get UI state
      const ui = await apiCall("GET", "/ui");
      result.ui = ui.error ? { error: ui.error } : ui;

      // Get chart config
      const chartConfig = await apiCall("GET", "/ui/chart-config");
      result.chartConfig = chartConfig.error ? { error: chartConfig.error } : chartConfig;

      // Get focused strategy details + summary
      const focusedId = ui.lastFocusedStrategyId;
      if (focusedId) {
        // Strategy config
        const strategyPath = join(PLAIIIN_DOCS_DIR, "strategies", focusedId, "strategy.yaml");
        const strategyJsonPath = join(PLAIIIN_DOCS_DIR, "strategies", focusedId, "strategy.json");
        const strategy = await apiCall("GET", `/strategy/${encodeURIComponent(focusedId)}`);
        result.focusedStrategy = strategy.error ? { error: strategy.error } : strategy;

        // Summary (backtest results)
        const summaryPath = join(PLAIIIN_DOCS_DIR, "strategies", focusedId, "summary.json");
        if (existsSync(summaryPath)) {
          try {
            const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
            delete summary.trades;
            delete summary.strategy;
            delete summary.config;

            const tradesDir = join(PLAIIIN_DOCS_DIR, "strategies", focusedId, "trades");
            if (existsSync(tradesDir)) {
              summary.tradeFiles = readdirSync(tradesDir).filter(f => f.endsWith(".json")).sort();
            }
            result.focusedSummary = summary;
          } catch (e) {
            result.focusedSummary = { error: `Failed to read summary: ${e.message}` };
          }
        } else {
          result.focusedSummary = null;
        }
      }

      return result;
    }

    case "plaiiin_update_chart_config": {
      const body = {};
      if (args.overlays) body.overlays = args.overlays;
      if (args.indicators) body.indicators = args.indicators;
      return apiCall("POST", "/ui/chart-config", body);
    }

    case "plaiiin_jump_chart_range": {
      if (args.endMs === undefined || args.endMs === null) {
        return { error: "Missing required parameter: endMs" };
      }
      return apiCall("POST", "/chart/jump", { endMs: args.endMs });
    }

    case "plaiiin_return_chart_to_live":
      return apiCall("POST", "/chart/live");

    default:
      return { error: `Unknown tool: ${name}. Available tools: ${TOOLS.map(t => t.name).join(', ')}` };
  }
}

// Create and run server
// ---------------------------------------------------------------------------
// Prompts — guided slash-command workflows in Claude Desktop
// ---------------------------------------------------------------------------
const PROMPTS = [
  {
    name: "analyze-strategy",
    description: "Analyze a strategy: read its backtest summary + trades, diagnose why it wins/loses, and propose concrete DSL improvements.",
    arguments: [{ name: "strategyId", description: "Strategy id (from plaiiin_list_strategies)", required: true }],
  },
  {
    name: "risk-review",
    description: "Risk-review a strategy: drawdown, stop-loss/position-sizing gaps, exposure, and overfitting red flags.",
    arguments: [{ name: "strategyId", description: "Strategy id", required: true }],
  },
  {
    name: "compare-backtests",
    description: "Compare two strategies' backtests side by side (metrics + what drives the difference).",
    arguments: [
      { name: "strategyIdA", description: "First strategy id", required: true },
      { name: "strategyIdB", description: "Second strategy id", required: true },
    ],
  },
];

function promptMessage(name, args) {
  const a = args || {};
  if (name === "analyze-strategy") {
    return "Analyze the trading strategy with id \"" + (a.strategyId || "") + "\". (1) Call plaiiin_get_strategy and plaiiin_get_summary for it. (2) Inspect representative trades. (3) Diagnose WHY it wins or loses (entries/exits/phases/regime). (4) Propose specific DSL changes with rationale. (5) Offer to apply them via plaiiin_update_strategy and re-run plaiiin_run_backtest, showing a before/after metrics comparison as you iterate.";
  }
  if (name === "risk-review") {
    return "Do a RISK review of strategy \"" + (a.strategyId || "") + "\". Pull its config and summary (plaiiin_get_strategy, plaiiin_get_summary). Assess: max drawdown, stop-loss presence and sizing, position sizing, concurrent exposure, and overfitting risk (short window, too many parameters, in-sample vs out-of-sample). Flag concrete issues and safer alternatives.";
  }
  if (name === "compare-backtests") {
    return "Compare strategies \"" + (a.strategyIdA || "") + "\" and \"" + (a.strategyIdB || "") + "\". Get each one's plaiiin_get_summary, present a side-by-side metrics table (win rate, profit factor, Sharpe, max drawdown, trade count), explain what drives the difference, and recommend which is more robust and why.";
  }
  return "Unknown prompt: " + name;
}

// ---------------------------------------------------------------------------
// MCP App — interactive candlestick chart (ui:// HTML rendered in a sandboxed
// iframe by Claude Desktop; the widget calls plaiiin_get_candles back over the
// postMessage bridge). Self-contained, no external assets (CSP-safe).
// NOTE: MCP Apps is a young spec (2026-01) — the exact bridge/_meta contract
// may need tuning against a live Claude Desktop; the plaiiin_show_chart tool
// still returns a text fallback so it degrades on non-App hosts.
// ---------------------------------------------------------------------------
const CHART_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}
html,body{margin:0;height:100%;background:#0e0f13;color:#cfd3dc;font:12px -apple-system,system-ui,sans-serif}
#bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #23252c}
#bar b{color:#e8ebf2}#bar .sp{flex:1}
button,input{background:#1a1c22;color:#cfd3dc;border:1px solid #2a2d35;border-radius:6px;padding:4px 8px;font:inherit}
#wrap{position:relative;height:calc(100% - 33px)}canvas{display:block;width:100%;height:100%}
#hud{position:absolute;top:8px;left:10px;pointer-events:none;color:#9aa0ad}
#err{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:20px;color:#e0888f;white-space:pre-line}
</style></head><body>
<div id="bar"><b id="sym">—</b><span id="tf"></span><span class="sp"></span>
<input id="symIn" placeholder="BTCUSDT" size="9"><input id="tfIn" placeholder="1h" size="4"><button id="load">Load</button></div>
<div id="wrap"><canvas id="c"></canvas><div id="hud"></div><div id="err"></div></div>
<script>
(function(){
  var pending={},msgId=0;
  function rpc(method,params){return new Promise(function(res,rej){var id=++msgId;pending[id]={res:res,rej:rej};
    try{parent.postMessage({jsonrpc:"2.0",id:id,method:method,params:params},"*");}catch(e){rej(e);}
    setTimeout(function(){if(pending[id]){pending[id].rej(new Error("timeout"));delete pending[id];}},8000);});}
  window.addEventListener("message",function(e){var m=e.data;if(!m)return;
    if(m.id!=null&&pending[m.id]){if(m.error)pending[m.id].rej(m.error);else pending[m.id].res(m.result);delete pending[m.id];return;}
    if(m.method==="setParams"&&m.params){load(m.params.symbol,m.params.timeframe);}});
  async function callTool(name,args){var r=await rpc("tools/call",{name:name,arguments:args});
    var txt=r&&r.content&&r.content.filter(function(c){return c.type==="text";}).map(function(c){return c.text;})[0];
    var data=txt?JSON.parse(txt):r;if(data&&data.error)throw new Error(data.error);return data;}
  var cv=document.getElementById("c"),ctx=cv.getContext("2d");
  var candles=[],viewCount=120,viewEnd=0,DPR=window.devicePixelRatio||1,sym="BTCUSDT",tf="1h";
  function resize(){cv.width=cv.clientWidth*DPR;cv.height=cv.clientHeight*DPR;draw();}
  window.addEventListener("resize",resize);
  function showErr(m){var el=document.getElementById("err");el.style.display=m?"flex":"none";el.textContent=m||"";}
  async function load(s,t){sym=(s||sym||"BTCUSDT").toUpperCase();tf=t||tf||"1h";
    document.getElementById("sym").textContent=sym;document.getElementById("tf").textContent=tf;
    showErr("Loading "+sym+" "+tf+"…");
    try{var d=await callTool("plaiiin_get_candles",{symbol:sym,timeframe:tf,bars:300});
      candles=(d.candles||[]).map(function(c){return {t:c.time,o:c.open,h:c.high,l:c.low,c:c.close,v:c.volume};});
      viewCount=Math.min(120,candles.length)||120;viewEnd=candles.length;
      showErr(candles.length?"":"No candle data for "+sym+" "+tf+".");draw();
    }catch(e){showErr("Couldn't load candles: "+(e.message||e)+"\\n(Is the Plaiiin app running?)");}}
  function view(){var end=Math.max(1,Math.min(viewEnd,candles.length));return candles.slice(Math.max(0,end-viewCount),end);}
  function draw(){var W=cv.width,H=cv.height;ctx.clearRect(0,0,W,H);var v=view();if(!v.length)return;
    var padT=10*DPR,padB=44*DPR,padR=58*DPR,padL=6*DPR,cw=W-padL-padR,ch=H-padT-padB;
    var hi=-1e18,lo=1e18,mv=0;v.forEach(function(c){if(c.h>hi)hi=c.h;if(c.l<lo)lo=c.l;if(c.v>mv)mv=c.v;});
    var pad=(hi-lo)*0.06||1;hi+=pad;lo-=pad;function y(p){return padT+(hi-p)/(hi-lo)*ch;}
    var n=v.length,bw=cw/n,body=Math.max(1,bw*0.6);
    ctx.strokeStyle="#20222a";ctx.fillStyle="#6b7280";ctx.lineWidth=1*DPR;ctx.font=(10*DPR)+"px system-ui";ctx.textAlign="left";
    for(var g=0;g<=4;g++){var yy=padT+ch*g/4,pp=hi-(hi-lo)*g/4;ctx.beginPath();ctx.moveTo(padL,yy);ctx.lineTo(padL+cw,yy);ctx.stroke();ctx.fillText(pp.toFixed(pp<10?4:2),padL+cw+4*DPR,yy+3*DPR);}
    v.forEach(function(c,i){var vh=(c.v/(mv||1))*(padB*0.6);ctx.fillStyle=c.c>=c.o?"rgba(38,166,154,0.35)":"rgba(239,83,80,0.35)";ctx.fillRect(padL+i*bw+(bw-body)/2,H-padB+(padB-8*DPR)-vh,body,vh);});
    v.forEach(function(c,i){var x=padL+i*bw+bw/2,up=c.c>=c.o;ctx.strokeStyle=ctx.fillStyle=up?"#26a69a":"#ef5350";ctx.lineWidth=1*DPR;ctx.beginPath();ctx.moveTo(x,y(c.h));ctx.lineTo(x,y(c.l));ctx.stroke();var yo=y(c.o),yc=y(c.c);ctx.fillRect(x-body/2,Math.min(yo,yc),body,Math.max(1*DPR,Math.abs(yc-yo)));});
    var last=v[v.length-1].c;ctx.strokeStyle="#3b82f6";ctx.setLineDash([4*DPR,4*DPR]);ctx.beginPath();ctx.moveTo(padL,y(last));ctx.lineTo(padL+cw,y(last));ctx.stroke();ctx.setLineDash([]);
    var L=v[v.length-1];document.getElementById("hud").textContent=sym+" "+tf+"  O "+L.o+"  H "+L.h+"  L "+L.l+"  C "+L.c;}
  cv.addEventListener("wheel",function(e){e.preventDefault();viewCount=Math.max(20,Math.min(candles.length||300,Math.round(viewCount*(e.deltaY>0?1.15:0.87))));draw();},{passive:false});
  var dragX=null;cv.addEventListener("mousedown",function(e){dragX=e.clientX;});window.addEventListener("mouseup",function(){dragX=null;});
  window.addEventListener("mousemove",function(e){if(dragX==null)return;var per=cv.clientWidth/viewCount,bars=Math.round((e.clientX-dragX)/per);if(bars!==0){viewEnd=Math.max(viewCount,Math.min(candles.length,viewEnd-bars));dragX=e.clientX;draw();}});
  document.getElementById("load").addEventListener("click",function(){load(document.getElementById("symIn").value,document.getElementById("tfIn").value);});
  try{parent.postMessage({jsonrpc:"2.0",method:"ui/ready"},"*");}catch(e){}
  resize();load(sym,tf);
})();
</script></body></html>`;

const server = new Server(
  {
    name: "plaiiin-mcp-server",
    version: "1.5.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args || {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error.message,
            hint: "Check if Strategy Forge is running and try again."
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Prompts (slash commands in Claude Desktop)
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return {
    messages: [{ role: "user", content: { type: "text", text: promptMessage(name, args) } }],
  };
});

// Resources — the interactive chart MCP App (ui:// HTML)
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "ui://plaiiin/chart",
      name: "Plaiiin interactive chart",
      description: "Interactive candlestick chart widget (rendered by plaiiin_show_chart).",
      mimeType: "text/html+mcp",
    },
  ],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "ui://plaiiin/chart") {
    return { contents: [{ uri: "ui://plaiiin/chart", mimeType: "text/html+mcp", text: CHART_APP_HTML }] };
  }
  return { contents: [] };
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Plaiiin MCP server v1.4.0 running");
}

main().catch(console.error);
