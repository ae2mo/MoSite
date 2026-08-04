# Stock Trader

A momentum screener and order-execution page for your Alpaca account, built
on top of the same local site as the Budget Planner. Reachable from any
page by clicking the blue **$** logo top-left and choosing **Stock Trader**.

> **Not financial advice.** This tool ranks stocks using a handful of
> technical indicators (moving averages, RSI, recent return, volume,
> volatility). That is a heuristic screen, not a validated predictive
> model — no combination of technical indicators reliably predicts that a
> stock will gain 10%, or any specific amount, in a week or any other
> timeframe. Past performance never guarantees future results. Nothing
> here should be treated as investment advice, and no trade is ever placed
> without you personally clicking the Buy or Sell button.

## Setup

1. **Install the extra packages** (the Budget pages don't need these —
   only this page does). If you launch the site with `Start Budget
   Site.bat`, this happens automatically every time you start it — pip
   just confirms everything's already installed if it is, and only
   actually downloads anything the first time (needs internet for that
   first run). Running it by hand instead, or on macOS/Linux? Install once
   with:

   ```
   pip install -r requirements-stocks.txt
   ```

2. **Get Alpaca API keys.** Log into [alpaca.markets](https://alpaca.markets),
   and generate a key/secret pair — start with a **paper trading** key
   (simulated money, no risk) from the Paper Trading section of your
   dashboard.

   > You pasted a paper API key and secret into our chat earlier while
   > sharing your original script. I didn't put those values into any
   > file — but since they were typed into a chat conversation, it's good
   > practice to regenerate them in your Alpaca dashboard before relying
   > on this page, even though they're paper-only.

3. **Enter your key and secret.** Open the Stock Trader page and click the
   gear icon (top right). Paste your API Key ID and Secret Key, leave Mode
   on **Paper**, and click Save Settings. This writes `stocks_config.json`
   (same folder as `server.py`) for you — no manual file editing needed.

   `stocks_config.json` is read directly by the local server and is never
   served over the network to browsers, and the page never displays your
   secret back to you once saved — but don't paste it into chat, commit it
   to version control, or share the folder without removing it first. (You
   can still create/edit it by hand instead if you prefer — copy
   `stocks_config.example.json` to `stocks_config.json` and fill it in.)

4. Once saved, the setup banner disappears and Scan/Buy/Sell become
   available immediately — no restart needed.

### Paper vs. live trading

Paper mode keeps every order on Alpaca's simulated paper account — no real
money moves. The gear icon's **Live** option switches to your live
brokerage account and real orders with real money.

Switching to Live asks for an explicit confirmation dialog first ("You're
switching to LIVE trading... Continue?"). Please only confirm that once
you've watched how the screener and the buy/sell logic behave on paper
trades and are comfortable with them. The account summary always shows a
PAPER or LIVE badge so the current mode is never ambiguous.

## What's on the page

- **Account summary** — buying power, portfolio value, cash, and a
  PAPER/LIVE badge so the current mode is never ambiguous.
- **Momentum Screener** — click **Scan Market** to download roughly a
  year of daily price history for the S&P 500 + Dow 30 (or just one of
  the two, see Settings) and rank them by a composite score. This can
  take up to a minute since it's pulling data for 500+ tickers. Nothing is
  bought or sold by scanning — it only builds the ranked list.
- **Buy Top Picks** — splits your current buying power evenly, in dollars,
  across the scanned top picks (skipping any you already hold, if that
  setting is on) and places market buy orders. Asks for confirmation
  first. Orders are placed as fractional ("notional") buys for a precise
  dollar amount of each stock, since a modest account split 10 ways often
  can't afford one whole share of every large-cap pick — a $92 allocation
  can't buy a full share of a $539 stock. If a symbol turns out not to be
  fractionable, it automatically falls back to a whole-share order sized
  to fit the same allocation. Prices are refreshed right before ordering
  (not the scan's cached prices), a 2% cash buffer is held back, and each
  stock's share of the budget is recalculated as orders go out. Anything
  skipped shows up with its reason in the Activity Log.
- **Check & Sell Signals** — re-checks every open position against a
  simple exit rule (price fell below its 50-day average, or RSI is above
  78/overbought) and lists all of them below, each one, with what the rule
  found — SELL with a reason, or Hold. Nothing is sold automatically:
  review the list and click Sell on whichever position(s) you want to
  close, confirming each one individually. You can Sell a Hold position
  too if you want to exit manually; you'll just get a heads-up that no
  signal is currently tripped for it.
- **Positions** — your current holdings with live unrealized P/L.
- **Portfolio Value Trend** — a chart built from snapshots recorded
  automatically each time the page loads or refreshes account data, so
  you can see how the account is actually doing over time.
- **Activity Log** — a running history of every scan, buy, sell, and
  error, persisted in `stocks_data.json` so it survives restarts.
- **Settings** — how many top picks to buy, which universe to scan, a
  minimum share price filter, and whether to skip stocks you already hold.

## How the score works

For each stock, using about a year of daily closes:

- **Trend (30 pts):** price above its 50-day average (+15), and the
  50-day average above the 200-day average (+15) — a classic uptrend
  signature.
- **Momentum (25 pts):** 20-trading-day (~1 month) return, capped at +20%
  so one outlier doesn't dominate the ranking.
- **RSI positioning (20 pts):** full credit for RSI(14) between 50–70
  (bullish but not overheated); partial credit just outside that band;
  nothing for RSI under 40 or over 80.
- **Volume confirmation (15 pts):** rewards a pickup in the last 10 days
  of volume relative to the prior 50 days — a sign the move has real
  interest behind it.
- **Consistency bonus (10 pts):** rewards a smoother 20-day gain (return
  relative to its own volatility) over an equally-sized but choppier one.

Stocks need at least ~210 days of price history to be scored at all (the
200-day average requires it), and anything under the minimum price
setting is filtered out before ranking.

## Where things live

```
homebudget/
  stocks_engine.py               All Alpaca/pandas/yfinance logic (server-side only)
  stocks_config.json              Your real API keys (you create this — never share it)
  stocks_config.example.json       Template, safe to share
  stocks_data.json                 Settings, activity log, portfolio snapshots, last scan
  requirements-stocks.txt          pip install -r this
  static/
    nav.js, nav.css                Shared dropdown menu (used by every page)
    stocks/
      index.html, style.css, app.js   This page
```

## Troubleshooting

- **"Missing Python packages"** — run
  `pip install -r requirements-stocks.txt` from the `homebudget` folder,
  then refresh the page.
- **"stocks_config.json not found"** — copy
  `stocks_config.example.json` to `stocks_config.json` and fill in your
  keys.
- **Scan seems stuck** — it's normal for a full-universe scan to take
  30–90 seconds; yfinance is fetching data for 500+ tickers. If it's
  still running after a few minutes, Yahoo Finance may be rate-limiting —
  try again shortly, or narrow the universe to "Dow 30 only" in Settings.
- **Scan returns very few symbols (around 20)** — the Dow/S&P 500
  constituent lists are scraped from Wikipedia tables; if that page can't
  be reached or its layout changes enough that no "Symbol" column can be
  found, the scan falls back to a small built-in watchlist so the page
  still works, and both the scan summary and Activity Log will say so
  explicitly. If you see that warning, check that this computer has
  internet access to en.wikipedia.org; if it does and the warning
  persists, let me know and I can update the scraping logic.
