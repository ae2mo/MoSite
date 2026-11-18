# Stock Trader

A short-term swing-trading screener and order-execution page for your
Alpaca account, built on top of the same local site as the Budget Planner.
Reachable from any page by clicking the blue **$** logo top-left and
choosing **Stock Trader**.

> **Not financial advice.** This tool ranks stocks using a handful of
> technical indicators (moving averages, RSI, recent return, volume,
> relative strength) and sizes/exits positions using a rules-based risk
> model (ATR-based stops, trailing stops, time-stops). That is a
> heuristic screen and risk-management tool, not a validated predictive
> model — no combination of technical indicators reliably predicts that a
> stock will gain any specific amount in any timeframe. Past performance
> never guarantees future results. Nothing here should be treated as
> investment advice, and no trade is ever placed without you personally
> clicking the Buy or Sell button.

## The strategy, and why it's "swing" not "day" trading

This page only ever looks at once-a-day price bars (via yfinance) and only
ever acts when you click a button — there's no background process and no
intraday/real-time feed watching the market between your visits. Given
that, literal same-day "day trading" (entering and exiting a position
within the same session) isn't something this architecture can honestly
claim to do. What it runs instead is a short-term **swing** strategy —
typically holding a position anywhere from a few days to a few weeks —
built from three angles:

- **A day trader's risk discipline:** cut losses fast with a hard,
  volatility-adjusted stop-loss; let winners run but protect gains with a
  trailing stop once a position is up enough; size every position off its
  own risk rather than splitting money evenly regardless of volatility.
- **An economics-minded read on realistic edges:** markets are close to
  efficient, especially for large caps, so no indicator combination
  reliably predicts short-term moves. Given that, a market-wide regime
  filter (don't buy into a broad downtrend) and a relative-strength check
  (only credit stocks actually outrunning the index, not just rising with
  it) matter at least as much as stock-picking precision.
- **A programmer's honesty about the architecture:** every rule above is
  something a once-a-day, click-triggered scan can actually evaluate
  reliably — short-term (10-day) momentum and relative strength instead of
  intraday signals, a time-stop so a stalled setup doesn't sit forever
  since nothing is watching it continuously, and position tracking
  (entry date/price, peak price) persisted locally since Alpaca's own
  position data doesn't include either.

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

- **The Strategy** — a plain-English explainer of the entry, sizing, exit,
  and market-filter rules, always visible on the page itself so you don't
  need to come back to this README to remember how it works.
- **Market Conditions** — appears after a scan; shows whether the S&P 500
  is currently above or below its own 200-day average (the market regime
  filter's read on the broad market).
- **Account summary** — buying power, portfolio value, cash, and a
  PAPER/LIVE badge so the current mode is never ambiguous.
- **Swing Screener** — click **Scan Market** to download roughly a
  year of daily price history for the S&P 500 + Dow 30 (or just one of
  the two, see Settings) and rank them by the swing score below. This can
  take up to a minute since it's pulling data for 500+ tickers. Nothing is
  bought or sold by scanning — it only builds the ranked list. The table
  also shows each pick's ATR(14) and an estimated dollar allocation (a
  preview of the risk-based sizing described below — the actual order is
  computed server-side when you click Buy).
- **Buy Top Picks** — sizes each pick by its own risk (see "How sizing
  works" below) rather than splitting money evenly, skipping any symbol
  you already hold if that setting is on, and places market buy orders.
  Asks for confirmation first. New buys pause automatically if the market
  regime filter is on and the S&P 500 is below its 200-day average — the
  Activity Log and the failed action message explain why. Orders are
  placed as fractional ("notional") buys for a precise dollar amount of
  each stock, falling back to a whole-share order sized to fit the same
  allocation if a symbol turns out not to be fractionable. Prices are
  refreshed right before ordering (not the scan's cached prices), and a
  2% cash buffer is held back. Anything skipped shows up with its reason
  in the Activity Log. Every successful buy also records an entry
  date/price locally (in `stocks_data.json`) so the exit rule below can
  evaluate trailing stops and time-stops against it later.
- **Check & Sell Signals** — re-checks every open position against the
  layered exit rule below and lists all of them, each with what the rule
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
- **Scan Settings** — how many top picks to buy, which universe to scan,
  a minimum share price filter, the short-term lookback window, whether
  to skip stocks you already hold, and whether to pause buying during a
  broad-market downtrend.
- **Strategy & Risk Settings** — the knobs behind sizing and exits: risk
  % per trade, max position size, stop-loss distance, trailing-stop
  trigger and distance, and the max holding window. The defaults are a
  deliberately conservative, risk-first starting point.

## How the score works

For each stock, using about a year of daily closes, scored against a
10-trading-day (configurable) short-term lookback:

- **Trend (25 pts):** price above its 20-day average (+12), and the
  20-day average above the 50-day average (+13) — short-term trend
  intact, on a swing-trade timescale rather than a multi-month one.
- **Momentum (25 pts):** short-term return, scaled up to full credit at
  +15%, then tapering off above that — a move already that large in just
  a couple weeks is read as more likely overextended than about to keep
  accelerating, so chasing it risks buying the top.
- **RSI positioning (20 pts):** full credit for RSI(14) between 45–65
  (bullish with room left to run); partial credit just outside that band;
  nothing for RSI under 35 or over 75.
- **Volume confirmation (15 pts):** rewards a pickup in the last 5 days
  of volume relative to the prior 20 days — a sign the move has real
  interest behind it.
- **Relative strength vs. the S&P 500 (15 pts):** only credit for actually
  outrunning the index over the same stretch — a stock merely matching a
  rising market isn't a leader, it's just along for the ride.

Stocks need at least ~60 days of price history to be scored at all, and
anything under the minimum price setting is filtered out before ranking.

## How sizing works

Each position is sized by its own volatility (ATR, Average True Range)
rather than splitting the account evenly: the risk % setting times your
account equity, divided by the stop distance (stop-loss ATR multiple ×
that stock's own ATR), gives a target dollar allocation — capped at the
max position % setting so no single low-volatility stock can dominate the
account. If the combined target across all picks exceeds what's actually
available, every allocation scales down proportionally to fit.

## How the exit rule works

Checked in this order for every open position:

1. **Hard stop-loss** — price fell to (or below) the stop-loss ATR
   multiple × ATR below the tracked entry price.
2. **Trailing stop** — once a position is up at least the trailing-stop
   trigger % from entry, exits if price falls the trailing-stop ATR
   multiple × ATR off its peak price since entry — locks in a bounded
   slice of the gain instead of giving it all back.
3. **Time-stop** — still open after the max holding days setting with
   RSI back under 50 (momentum faded) — a short-term setup that hasn't
   worked by then probably isn't going to.
4. **Trend-break** — price fell below its 20-day average.

Rules 1–3 need an entry date/price and peak-price-since-entry that this
tool tracks itself (Alpaca's own position data doesn't include either).
A position bought outside this tool, or one that existed before this
feature shipped, has no tracked data for those rules and falls back to
rule 4 alone.

## Where things live

```
homebudget/
  mosite/stocks_engine.py        All Alpaca/pandas/yfinance logic (server-side only)
  stocks_config.json              Your real API keys (you create this — never share it)
  stocks_config.example.json       Template, safe to share
  stocks_data.json                 Settings, activity log, portfolio snapshots, last scan,
                                    and position tracking (entry date/price, peak price)
  requirements-stocks.txt          pip install -r this
  mosite/static/
    nav.js, nav.css                Shared dropdown menu (used by every page)
    stocks/
      index.html, style.css, app.js   This page
```

## Troubleshooting

- **"Buying is paused by the market regime filter"** — this is expected
  behavior, not an error: the filter saw the S&P 500 below its own
  200-day average and is declining to place new buys into what it reads
  as a broad downtrend. Wait for conditions to improve, or turn the
  filter off in Scan Settings if you want to buy anyway.
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
