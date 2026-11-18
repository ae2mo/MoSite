"""
stocks_engine.py - Alpaca short-term swing screener & order execution

Imported lazily by server.py only when a /api/stocks/* route is hit, so the
Budget app never needs these dependencies installed.

STRATEGY (reworked): this screener only ever looks at daily bars and only
ever trades when you click a button on the page - there's no background
process and no intraday/real-time feed, so literal same-day "day trading"
isn't something this architecture can actually do honestly. What it does
instead is a short-term SWING strategy (positions typically held days to a
few weeks), combining:
  - A market regime filter: new buys pause while the S&P 500 itself is
    below its own 200-day average, since even good stock-picking tends to
    lose money fighting a broad downtrend.
  - Entry scoring on short-term trend (price/20MA/50MA), momentum that's
    positive but not already overextended, RSI in a "room to run" zone,
    volume confirmation, and relative strength vs. the S&P 500 (only credit
    stocks actually leading the market, not just rising with it).
  - Risk-based position sizing: each position is sized off its own ATR
    (volatility) and a fixed % of account equity risked to its stop, capped
    at a max % of equity per position - not a flat equal-dollar split.
  - A layered exit rule: hard ATR-based stop-loss, a trailing stop once a
    position is up enough to protect gains, a time-stop if a short-term
    setup hasn't worked out within a max holding window, and a trend-break
    fallback.
None of this is a prediction that a stock will rise, or a guarantee of
profit - it's a heuristic, rules-based ranking and risk-management tool for
experimentation, not financial advice, and past performance never
guarantees future results.

WHAT THIS ISN'T: it does not decide anything on its own. Every buy/sell only
happens when you click the corresponding button on the Stock Trader page.

Data flow:
- Historical prices come from yfinance (free, no Alpaca data subscription
  needed).
- Account info, positions, and order execution go through Alpaca's
  alpaca-py SDK, using the paper or live account configured in
  stocks_config.json (never hardcoded - see stocks_config.example.json).
- Settings, activity log, and portfolio snapshots persist in
  stocks_data.json next to this file.
"""

import json
import os
import threading
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("MOSITE_DATA_DIR") or BASE_DIR  # see server.py
CONFIG_FILE = os.path.join(DATA_DIR, "stocks_config.json")
DATA_FILE = os.path.join(DATA_DIR, "stocks_data.json")

DATA_LOCK = threading.Lock()

DEFAULT_SETTINGS = {
    "topN": 10,
    "universe": "sp500_dow",   # sp500_dow | sp500 | dow
    "minPrice": 5.0,
    "excludeHeld": True,
    "lookbackDays": 365,
    "momentumLookbackDays": 10,       # short-term momentum/relative-strength window
    "riskPercent": 1.5,               # % of equity risked per trade (via stop distance)
    "maxPositionPercent": 20.0,       # cap on % of equity in any one position
    "stopLossAtrMultiple": 2.0,       # hard stop = entry - this many ATRs
    "profitTrailTriggerPercent": 15.0,  # switch to trailing stop once up this much
    "trailingStopAtrMultiple": 1.5,   # trailing stop = peak - this many ATRs
    "maxHoldingDays": 20,             # time-stop window for a short-term setup
    "requireMarketRegimeFilter": True,  # pause buys when S&P 500 < its 200-day MA
    "autoMode": False,                # hourly automatic sell/scan/buy cycle
}

MAX_LOG_ENTRIES = 200
MAX_SNAPSHOTS = 2000

FALLBACK_WATCHLIST = [
    "AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "TSLA", "BRK-B", "JPM", "V",
    "UNH", "HD", "PG", "MA", "DIS", "KO", "PEP", "COST", "MRK", "XOM",
]


# ---------- config (API keys - never hardcoded, never committed) ----------

def load_config():
    if not os.path.exists(CONFIG_FILE):
        raise RuntimeError(
            "stocks_config.json not found. Copy stocks_config.example.json to "
            "stocks_config.json and fill in your Alpaca API key/secret."
        )
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    for field in ("apiKey", "apiSecret"):
        if not cfg.get(field):
            raise RuntimeError("stocks_config.json is missing '%s'." % field)
    cfg.setdefault("paper", True)
    return cfg


def get_config_public():
    """Safe-to-return view of the config file: never sends the actual
    secret back to the browser, only whether one is set and a short
    preview of the key so the settings panel can confirm it's correct."""
    try:
        cfg = load_config()
    except Exception:
        return {"hasKey": False, "hasSecret": False, "keyPreview": None, "paper": True}

    key = cfg.get("apiKey", "") or ""
    secret = cfg.get("apiSecret", "") or ""
    preview = (key[:4] + "…" + key[-4:]) if len(key) > 8 else (key if key else None)
    return {
        "hasKey": bool(key),
        "hasSecret": bool(secret),
        "keyPreview": preview,
        "paper": cfg.get("paper", True),
    }


def save_config(payload):
    """Writes stocks_config.json from the settings panel. Blank key/secret
    fields mean 'keep what's already there' - only a non-empty value
    overwrites it, so you can flip paper/live without retyping keys."""
    cfg = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, OSError):
            cfg = {}

    api_key = (payload.get("apiKey") or "").strip()
    api_secret = (payload.get("apiSecret") or "").strip()
    if api_key:
        cfg["apiKey"] = api_key
    if api_secret:
        cfg["apiSecret"] = api_secret
    if "paper" in payload:
        cfg["paper"] = bool(payload["paper"])
    cfg.setdefault("paper", True)

    if not cfg.get("apiKey") or not cfg.get("apiSecret"):
        raise RuntimeError("An API key and secret are required before saving.")

    tmp_path = CONFIG_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp_path, CONFIG_FILE)

    _append_log(
        "config",
        "Updated Alpaca settings (%s mode)." % ("LIVE" if cfg["paper"] is False else "PAPER"),
    )
    return get_config_public()


# ---------- local data file: settings, activity log, snapshots, last scan ----------

def _default_data():
    return {
        "settings": dict(DEFAULT_SETTINGS),
        "log": [],
        "snapshots": [],
        "lastScan": None,
        "positionTracking": {},
        "lastAutoRun": None,
    }


def _load_data():
    with DATA_LOCK:
        if not os.path.exists(DATA_FILE):
            data = _default_data()
            _write_data(data)
            return data
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            data = _default_data()
            _write_data(data)
            return data

        defaults = _default_data()
        for key, value in defaults.items():
            data.setdefault(key, value)
        for key, value in DEFAULT_SETTINGS.items():
            data["settings"].setdefault(key, value)
        return data


def _write_data(data):
    tmp_path = DATA_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
    os.replace(tmp_path, DATA_FILE)


def _save_data(data):
    with DATA_LOCK:
        _write_data(data)


def _append_log(entry_type, message, details=None):
    data = _load_data()
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": entry_type,
        "message": message,
    }
    if details is not None:
        entry["details"] = details
    data["log"].insert(0, entry)
    data["log"] = data["log"][:MAX_LOG_ENTRIES]
    _save_data(data)


def get_log():
    return _load_data()["log"]


def get_settings():
    return _load_data()["settings"]


def save_settings(new_settings):
    data = _load_data()
    for key in DEFAULT_SETTINGS:
        if key not in new_settings:
            continue
        value = new_settings[key]
        if key in ("topN", "maxHoldingDays", "momentumLookbackDays"):
            value = max(1, int(value))
        elif key in (
            "minPrice", "lookbackDays", "riskPercent", "maxPositionPercent",
            "stopLossAtrMultiple", "profitTrailTriggerPercent", "trailingStopAtrMultiple",
        ):
            value = float(value)
        elif key in ("excludeHeld", "requireMarketRegimeFilter", "autoMode"):
            value = bool(value)
        data["settings"][key] = value
    _save_data(data)
    return data["settings"]


# ---------- position tracking (entry date/price, peak since entry) ----------
# Alpaca's position objects don't expose when a position was opened or its
# peak price since then, but the exit rule needs both (for the trailing
# stop and the time-stop) - so this engine tracks them itself, keyed by
# symbol, in stocks_data.json. A position bought outside this tool (or one
# that already existed before this feature shipped) simply has no tracking
# entry; the exit rule below degrades gracefully to a plain trend-break
# check for those rather than guessing at history it doesn't have.

def _position_tracking_set_entry(symbol, entry_price, qty):
    data = _load_data()
    data.setdefault("positionTracking", {})
    existing = data["positionTracking"].get(symbol)
    if existing:
        existing["peakPrice"] = max(existing.get("peakPrice", entry_price), entry_price)
    else:
        data["positionTracking"][symbol] = {
            "entryDate": datetime.now(timezone.utc).isoformat(),
            "entryPrice": entry_price,
            "peakPrice": entry_price,
        }
    _save_data(data)


def _position_tracking_clear(symbol):
    data = _load_data()
    if data.get("positionTracking", {}).pop(symbol, None) is not None:
        _save_data(data)


def _position_tracking_update_peak(symbol, current_price):
    data = _load_data()
    tracking = data.get("positionTracking", {}).get(symbol)
    if tracking and current_price and current_price > tracking.get("peakPrice", 0):
        tracking["peakPrice"] = current_price
        _save_data(data)
    return tracking


def _today_key():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _record_sell(symbol):
    """Remembers which symbols were sold today, so a buy later the same day
    (e.g. the next hourly Auto cycle) doesn't immediately buy them back."""
    data = _load_data()
    today = _today_key()
    sells = {s: d for s, d in (data.get("recentSells") or {}).items() if d == today}
    sells[symbol] = today
    data["recentSells"] = sells
    _save_data(data)


def _sold_today():
    today = _today_key()
    return {s for s, d in (_load_data().get("recentSells") or {}).items() if d == today}


def get_history():
    return _load_data()["snapshots"]


def _append_snapshot(account):
    data = _load_data()
    data["snapshots"].append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "portfolioValue": account["portfolioValue"],
        "cash": account["cash"],
        "buyingPower": account["buyingPower"],
    })
    data["snapshots"] = data["snapshots"][-MAX_SNAPSHOTS:]
    _save_data(data)


# ---------- status (used by the UI to show setup progress) ----------

def get_status():
    missing = []
    for pkg in ("alpaca", "pandas", "numpy", "yfinance"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)

    configured = os.path.exists(CONFIG_FILE)
    paper = True
    config_error = None
    if configured:
        try:
            paper = load_config().get("paper", True)
        except Exception as e:
            configured = False
            config_error = str(e)

    return {
        "installed": len(missing) == 0,
        "missing": missing,
        "configured": configured,
        "configError": config_error,
        "paper": paper,
    }


# ---------- Alpaca client ----------

def _trading_client():
    from alpaca.trading.client import TradingClient
    cfg = load_config()
    client = TradingClient(cfg["apiKey"], cfg["apiSecret"], paper=cfg.get("paper", True))
    return client, cfg


def get_account():
    client, cfg = _trading_client()
    acct = client.get_account()
    status_value = getattr(acct.status, "value", None) or str(acct.status)
    result = {
        "paper": cfg.get("paper", True),
        "cash": float(acct.cash),
        "buyingPower": float(acct.buying_power),
        "portfolioValue": float(acct.portfolio_value),
        "equity": float(acct.equity),
        "status": status_value,
    }
    _append_snapshot(result)
    return result


def get_positions():
    client, _ = _trading_client()
    positions = client.get_all_positions()
    result = []
    for p in positions:
        cost_basis = float(p.cost_basis)
        unrealized_pl = float(p.unrealized_pl)
        result.append({
            "symbol": p.symbol,
            "qty": float(p.qty),
            "avgEntryPrice": float(p.avg_entry_price),
            "currentPrice": float(p.current_price) if p.current_price is not None else None,
            "marketValue": float(p.market_value),
            "costBasis": cost_basis,
            "unrealizedPL": unrealized_pl,
            "unrealizedPLPercent": (unrealized_pl / cost_basis * 100) if cost_basis else 0.0,
        })
    result.sort(key=lambda x: x["marketValue"], reverse=True)
    return result


# ---------- universe (Dow + S&P 500 constituents, via Wikipedia) ----------

def _fetch_url(url):
    """Plain urllib GET with a browser-like User-Agent. Wikipedia (and most
    sites) reject requests carrying pandas/urllib's default user agent with
    a 403, which made read_html() fail silently and fall back to the small
    watchlist - this is what was causing "only 20 symbols scanned"."""
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HomeBudgetStocksBot/1.0"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def _find_table_with_column(tables, column):
    """Wikipedia occasionally reorders/add tables on these pages - search
    for the one that actually has the column we need instead of assuming
    a fixed table index, which breaks the moment the page layout shifts."""
    for t in tables:
        if column in [str(c) for c in t.columns]:
            return t
    return None


def _get_universe(universe_key):
    """Returns (symbols, used_fallback)."""
    import pandas as pd
    import io

    symbols = set()
    fallback_needed = False

    if universe_key in ("sp500_dow", "sp500"):
        try:
            html = _fetch_url("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")
            sp500 = _find_table_with_column(pd.read_html(io.BytesIO(html)), "Symbol")
            if sp500 is None or sp500.empty:
                raise ValueError("no Symbol table found on the S&P 500 page")
            symbols.update(sp500["Symbol"].astype(str).str.replace(".", "-", regex=False).tolist())
        except Exception:
            fallback_needed = True

    if universe_key in ("sp500_dow", "dow"):
        try:
            html = _fetch_url("https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average")
            dow = _find_table_with_column(pd.read_html(io.BytesIO(html)), "Symbol")
            if dow is None or dow.empty:
                raise ValueError("no Symbol table found on the Dow 30 page")
            symbols.update(dow["Symbol"].astype(str).str.replace(".", "-", regex=False).tolist())
        except Exception:
            fallback_needed = True

    if not symbols:
        symbols = set(FALLBACK_WATCHLIST)  # Wikipedia layout changed or fetch failed
        fallback_needed = True

    return sorted(symbols), fallback_needed


# ---------- technical scoring ----------

def _compute_rsi(close, period=14):
    import numpy as np
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(period).mean()
    avg_loss = loss.rolling(period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _compute_atr(df, period=14):
    """Average True Range - the volatility measure used to size both
    position sizes and stop distances below, so a choppy stock gets a
    wider stop and a smaller position than a calm one at the same price."""
    import pandas as pd

    high = df["High"] if "High" in df.columns else df["Close"]
    low = df["Low"] if "Low" in df.columns else df["Close"]
    close = df["Close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def _market_regime():
    """Is the broad market healthy enough to be buying into? Checked via
    the S&P 500 ETF's own price vs. its 200-day average - a simple,
    well-known risk filter: even a good stock-picking model tends to lose
    money fighting a broad downtrend, so new buys pause rather than fight
    the tape. This never affects existing positions or the sell side."""
    import numpy as np

    try:
        raw = _download_history(["SPY"], 400)
        df = _extract_symbol_df(raw, "SPY", False)
        if df is None or len(df) < 210:
            return {"ok": True, "detail": "Not enough S&P 500 history to check - proceeding without the filter."}
        close = df["Close"]
        ma200 = close.rolling(200).mean()
        last_close = float(close.iloc[-1])
        last_ma200 = float(ma200.iloc[-1]) if not np.isnan(ma200.iloc[-1]) else None
        if last_ma200 is None:
            return {"ok": True, "detail": "Not enough S&P 500 history to check - proceeding without the filter."}
        healthy = last_close > last_ma200
        pct = (last_close / last_ma200 - 1) * 100
        return {
            "ok": healthy,
            "spyPrice": round(last_close, 2),
            "spyMa200": round(last_ma200, 2),
            "pctAboveMa200": round(pct, 2),
            "detail": (
                "S&P 500 is %.1f%% above its 200-day average - broad market looks healthy." % pct
            ) if healthy else (
                "S&P 500 is %.1f%% below its 200-day average - broad market looks like a downtrend." % abs(pct)
            ),
        }
    except Exception as e:
        return {"ok": True, "detail": "Couldn't check the market regime (%s) - proceeding without the filter." % e}


def _score_symbol(df, spy_return=None, lookback=10):
    """df: DataFrame with 'Close'/'High'/'Low' (and ideally 'Volume'),
    oldest row first. Returns (score 0-100, details dict) or (None, None)
    if there isn't enough history to score it."""
    import numpy as np

    if df is None or len(df) < 60:
        return None, None

    close = df["Close"]
    volume = df["Volume"] if "Volume" in df.columns else None

    ma20 = close.rolling(20).mean()
    ma50 = close.rolling(50).mean()
    rsi = _compute_rsi(close)
    atr = _compute_atr(df)

    last_close = float(close.iloc[-1])
    last_ma20 = float(ma20.iloc[-1]) if not np.isnan(ma20.iloc[-1]) else None
    last_ma50 = float(ma50.iloc[-1]) if not np.isnan(ma50.iloc[-1]) else None
    last_rsi = float(rsi.iloc[-1]) if not np.isnan(rsi.iloc[-1]) else 50.0
    last_atr = float(atr.iloc[-1]) if not np.isnan(atr.iloc[-1]) else None

    if last_ma20 is None or last_ma50 is None or last_close <= 0 or not last_atr:
        return None, None

    lb = max(2, int(lookback))
    ret_lb = (last_close / float(close.iloc[-(lb + 1)]) - 1) * 100 if len(close) > lb else 0.0

    score = 0.0

    # Trend alignment (25 pts): short-term trend intact - price above its
    # own 20-day average, which is itself above the 50-day average. Using
    # 20/50 instead of 50/200 so this reacts on a swing-trade timescale
    # instead of a multi-month one.
    if last_close > last_ma20:
        score += 12
    if last_ma20 > last_ma50:
        score += 13

    # Short-term momentum (25 pts): rewards a real recent move, but tapers
    # off above ~15% - a stock already up that much in just a few days is
    # more likely overextended than about to keep sprinting, so chasing it
    # tends to buy the top rather than catch the breakout.
    if ret_lb <= 0:
        mom_score = 0.0
    elif ret_lb <= 15:
        mom_score = (ret_lb / 15.0) * 25
    else:
        mom_score = max(25 - (ret_lb - 15) * 0.5, 10)
    score += mom_score

    # RSI positioning (20 pts): the sweet spot for a short-term entry is
    # bullish but not stretched - a name already at RSI 85 has little room
    # left before a pullback.
    if 45 <= last_rsi <= 65:
        score += 20
    elif 35 <= last_rsi < 45 or 65 < last_rsi <= 75:
        score += 10

    # Volume confirmation (15 pts): recent 5-day volume vs. the prior 20
    # days - a move on rising volume is more likely to have real buyers
    # behind it than one drifting up on thin, disinterested trading.
    if volume is not None and len(volume) >= 25:
        recent_vol = float(volume.iloc[-5:].mean())
        base_vol = float(volume.iloc[-25:-5].mean())
        if base_vol > 0:
            vol_ratio = recent_vol / base_vol
            score += max(0.0, min(vol_ratio - 1.0, 1.0)) * 15

    # Relative strength vs. the S&P 500 (15 pts): only credit a stock for
    # outrunning the index over the same stretch - a stock merely matching
    # a rising market isn't a leader, it's just along for the ride.
    if spy_return is not None:
        rel_strength = ret_lb - spy_return
        score += max(0.0, min(rel_strength / 10.0, 1.0)) * 15

    details = {
        "price": round(last_close, 2),
        "ma20": round(last_ma20, 2),
        "ma50": round(last_ma50, 2),
        "rsi14": round(last_rsi, 1),
        "atr14": round(last_atr, 2),
        "returnShort": round(ret_lb, 2),
    }
    return round(score, 1), details


def _position_size(pick, equity, settings):
    """Risk-based sizing: risks a fixed % of account equity on the distance
    to this pick's stop-loss (stopLossAtrMultiple x its own ATR), capped at
    maxPositionPercent of equity so one low-volatility stock can't eat the
    whole account. A tight, calm setup gets sized up toward the cap; a
    wide, choppy one gets sized down automatically - instead of every pick
    getting the same flat dollar amount regardless of its own risk."""
    price = pick["price"]
    atr = pick.get("atr14") or 0
    stop_multiple = float(settings.get("stopLossAtrMultiple", 2.0))
    risk_percent = float(settings.get("riskPercent", 1.5)) / 100.0
    max_position_percent = float(settings.get("maxPositionPercent", 20.0)) / 100.0

    stop_distance = stop_multiple * atr if atr > 0 else price * 0.07
    stop_distance = max(stop_distance, price * 0.01)

    risk_based_dollars = (equity * risk_percent / stop_distance) * price
    capped_dollars = equity * max_position_percent
    return max(0.0, min(risk_based_dollars, capped_dollars))


def _sell_signal(df, symbol, avg_entry_price, settings):
    """Layered exit rule, checked in priority order:
      1. Hard stop-loss: price fell stopLossAtrMultiple x ATR below entry.
      2. Trailing stop: once up profitTrailTriggerPercent% from entry,
         locks in gains by exiting if price falls trailingStopAtrMultiple x
         ATR off its peak since entry - lets a winner keep running, but
         gives back only a bounded slice of the gain instead of all of it.
      3. Time stop: still open after maxHoldingDays with momentum faded
         (RSI back under 50) - a short-term setup that hasn't worked by
         then probably isn't going to.
      4. Trend break: price fell under its 20-day average.
    Rules 1-3 need this engine's own tracked entry date/peak for the
    symbol (see _position_tracking_* above); a position with no tracking
    data (opened before this feature existed, or outside this tool) falls
    back to rule 4 alone. Returns (should_sell, details)."""
    import numpy as np

    if df is None or len(df) < 25:
        return False, {}

    close = df["Close"]
    ma20 = close.rolling(20).mean()
    rsi = _compute_rsi(close)
    atr = _compute_atr(df)

    last_close = float(close.iloc[-1])
    last_ma20 = float(ma20.iloc[-1]) if not np.isnan(ma20.iloc[-1]) else None
    last_rsi = float(rsi.iloc[-1]) if not np.isnan(rsi.iloc[-1]) else 50.0
    last_atr = float(atr.iloc[-1]) if not np.isnan(atr.iloc[-1]) else None

    details = {
        "price": round(last_close, 2),
        "ma20": round(last_ma20, 2) if last_ma20 is not None else None,
        "rsi14": round(last_rsi, 1),
    }

    tracking = _position_tracking_update_peak(symbol, last_close)

    if tracking and last_atr:
        entry_price = tracking.get("entryPrice") or avg_entry_price
        peak_price = tracking.get("peakPrice") or last_close
        stop_multiple = float(settings.get("stopLossAtrMultiple", 2.0))
        trail_multiple = float(settings.get("trailingStopAtrMultiple", 1.5))
        trail_trigger = float(settings.get("profitTrailTriggerPercent", 15.0)) / 100.0
        max_hold_days = int(settings.get("maxHoldingDays", 20))

        stop_price = entry_price - stop_multiple * last_atr
        if last_close <= stop_price:
            return True, dict(details, reason="Hit its stop-loss (%.1fx ATR below the %.2f entry)." % (stop_multiple, entry_price))

        gain_from_entry = (peak_price / entry_price - 1) if entry_price else 0
        if gain_from_entry >= trail_trigger:
            trail_stop_price = peak_price - trail_multiple * last_atr
            if last_close <= trail_stop_price:
                return True, dict(details, reason="Trailing stop hit, locking in gains after peaking at %.2f." % peak_price)

        days_held = None
        try:
            entry_date = datetime.fromisoformat(tracking.get("entryDate"))
            if entry_date.tzinfo is None:
                entry_date = entry_date.replace(tzinfo=timezone.utc)
            days_held = (datetime.now(timezone.utc) - entry_date).days
        except Exception:
            pass
        if days_held is not None and days_held >= max_hold_days and last_rsi < 50:
            return True, dict(details, reason="Held %d days with momentum faded (RSI below 50) - time stop." % days_held)

    if last_ma20 is not None and last_close < last_ma20:
        return True, dict(details, reason="Price fell below its 20-day average - short-term trend broken.")
    return False, details


# ---------- price history ----------

def _download_history(symbols, lookback_days):
    import yfinance as yf

    end = datetime.now()
    start = end - timedelta(days=int(lookback_days))
    return yf.download(
        symbols,
        start=start.strftime("%Y-%m-%d"),
        end=end.strftime("%Y-%m-%d"),
        group_by="ticker",
        threads=True,
        progress=False,
        auto_adjust=True,
    )


def _extract_symbol_df(raw, symbol, multi):
    try:
        df = raw[symbol] if multi else raw
        df = df.dropna(subset=["Close"])
        return df if not df.empty else None
    except Exception:
        return None


# ---------- scan / buy / sell ----------

def run_scan():
    settings = get_settings()
    symbols, used_fallback = _get_universe(settings.get("universe", "sp500_dow"))
    lookback = int(settings.get("momentumLookbackDays", 10))

    regime = _market_regime()

    if used_fallback:
        _append_log(
            "error",
            "Could not fetch the Dow/S&P 500 constituent list from Wikipedia - "
            "scanning the built-in %d-symbol watchlist instead." % len(symbols),
        )

    _append_log("scan", "Scanning %d symbols..." % len(symbols))

    scan_symbols = symbols if "SPY" in symbols else symbols + ["SPY"]
    raw = _download_history(scan_symbols, settings.get("lookbackDays", 365))
    multi = len(scan_symbols) > 1

    spy_df = _extract_symbol_df(raw, "SPY", multi)
    spy_return = None
    if spy_df is not None and len(spy_df) > lookback:
        spy_close = spy_df["Close"]
        spy_return = (float(spy_close.iloc[-1]) / float(spy_close.iloc[-(lookback + 1)]) - 1) * 100

    scored = []
    skipped = 0
    for symbol in symbols:
        df = _extract_symbol_df(raw, symbol, multi)
        score, details = _score_symbol(df, spy_return=spy_return, lookback=lookback)
        if score is None:
            skipped += 1
            continue
        if details["price"] < settings.get("minPrice", 5.0):
            continue
        scored.append(dict({"symbol": symbol, "score": score}, **details))

    scored.sort(key=lambda x: x["score"], reverse=True)
    top_n = int(settings.get("topN", 10))
    picks = scored[:top_n]

    result = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "universeSize": len(symbols),
        "scored": len(scored),
        "skipped": skipped,
        "usedFallback": used_fallback,
        "picks": picks,
        "marketRegime": regime,
        "spyReturnShort": round(spy_return, 2) if spy_return is not None else None,
    }

    data = _load_data()
    data["lastScan"] = result
    _save_data(data)

    _append_log(
        "scan",
        "Scan complete: %d picks from %d scored symbols (%d skipped for insufficient data). %s"
        % (len(picks), len(scored), skipped, regime.get("detail", "")),
    )
    return result


def _latest_prices(symbols):
    """Fresh last-close price for a handful of symbols, fetched right before
    placing orders. The scan can be minutes, hours, or days old by the time
    you click Buy, and dividing money using a stale price is what causes a
    stock priced higher than expected to eat far more than its 1/N share."""
    if not symbols:
        return {}
    import yfinance as yf

    prices = {}
    try:
        raw = yf.download(symbols, period="5d", group_by="ticker", threads=True, progress=False, auto_adjust=True)
        multi = len(symbols) > 1
        for symbol in symbols:
            df = _extract_symbol_df(raw, symbol, multi)
            if df is not None and not df.empty:
                prices[symbol] = float(df["Close"].iloc[-1])
    except Exception:
        pass
    return prices


def run_buy():
    from alpaca.trading.requests import MarketOrderRequest
    from alpaca.trading.enums import OrderSide, TimeInForce

    settings = get_settings()

    if settings.get("requireMarketRegimeFilter", True):
        regime = _market_regime()
        if not regime.get("ok", True):
            _append_log("buy", "Buying paused by the market regime filter: %s" % regime.get("detail"))
            raise ValueError(
                "Buying is paused by the market regime filter: %s Turn off that filter in "
                "Settings if you want to buy anyway." % regime.get("detail")
            )

    data = _load_data()
    last_scan = data.get("lastScan")
    if not last_scan or not last_scan.get("picks"):
        last_scan = run_scan()

    client, cfg = _trading_client()
    account = client.get_account()
    # Spend only real cash. Alpaca's buying_power includes margin (up to 4x
    # equity on many accounts), which would quietly leverage the account.
    buying_power = max(0.0, min(float(account.buying_power), float(account.cash)))
    equity = float(account.equity)

    held_symbols = set()
    if settings.get("excludeHeld", True):
        held_symbols = {p.symbol for p in client.get_all_positions()}

    # Don't buy back anything sold today, and don't buy a pick that's already
    # below its 20-day average - the exit rule would sell it again on the
    # very next check. Without this, Auto mode could sell and re-buy the same
    # stock every hour.
    sold_today = _sold_today()
    candidates = []
    pre_skipped = []
    for p in last_scan["picks"]:
        if p["symbol"] in held_symbols:
            continue
        if p["symbol"] in sold_today:
            pre_skipped.append({"symbol": p["symbol"], "reason": "Sold earlier today - not buying it back the same day."})
            continue
        if p.get("ma20") and p["price"] < p["ma20"]:
            pre_skipped.append({"symbol": p["symbol"], "reason": "Below its 20-day average - the exit rule would sell it right away."})
            continue
        candidates.append(p)
    if not candidates:
        _append_log("buy", "No eligible picks to buy (top picks are already held, were sold today, or the last scan returned nothing).")
        return {"orders": [], "skipped": pre_skipped, "message": "No eligible picks."}

    fresh_prices = _latest_prices([c["symbol"] for c in candidates])

    # Risk-based sizing per pick (volatility-adjusted via ATR, capped per
    # position - see _position_size) replaces a flat equal-dollar split,
    # so a tight, low-ATR setup can take a fuller position while a wide,
    # choppy one is sized down automatically. If the combined target
    # exceeds what's actually available, every allocation is scaled down
    # proportionally to fit, with a 2% buffer held back for price drift.
    targets = {pick["symbol"]: _position_size(pick, equity, settings) for pick in candidates}
    total_target = sum(targets.values())
    available = buying_power * 0.98
    scale = min(1.0, available / total_target) if total_target > 0 else 0.0

    remaining_budget = available
    orders = []
    skipped = list(pre_skipped)

    for pick in candidates:
        symbol = pick["symbol"]
        price = fresh_prices.get(symbol, pick["price"])
        allocation = min(targets[symbol] * scale, remaining_budget)

        if allocation < 1 or not price:
            skipped.append({"symbol": symbol, "reason": "Allocation below $1 after risk-based sizing."})
            continue

        notional = round(allocation, 2)
        try:
            order = client.submit_order(order_data=MarketOrderRequest(
                symbol=symbol,
                notional=notional,
                side=OrderSide.BUY,
                time_in_force=TimeInForce.DAY,
            ))
            remaining_budget -= notional
            est_qty = round(notional / price, 4)
            _position_tracking_set_entry(symbol, price, est_qty)
            orders.append({
                "symbol": symbol,
                "qty": est_qty,
                "estCost": notional,
                "score": pick["score"],
                "orderId": str(order.id),
            })
            _append_log("buy", "Bought ~$%.2f (~%s shares) of %s - risk-sized position." % (notional, est_qty, symbol), pick)
            continue
        except Exception as e:
            # Symbol isn't fractionable (or the notional order was rejected
            # for another reason) - retry as a whole-share order sized to
            # fit inside the same dollar allocation before giving up on it.
            qty = int(allocation // price)
            if qty < 1:
                skipped.append({
                    "symbol": symbol,
                    "reason": "Not fractionable, and its price is too high for this allocation to buy one whole share (%s)." % e,
                })
                continue
            try:
                order = client.submit_order(order_data=MarketOrderRequest(
                    symbol=symbol,
                    qty=qty,
                    side=OrderSide.BUY,
                    time_in_force=TimeInForce.DAY,
                ))
                est_cost = round(qty * price, 2)
                remaining_budget -= est_cost
                _position_tracking_set_entry(symbol, price, qty)
                orders.append({
                    "symbol": symbol,
                    "qty": qty,
                    "estCost": est_cost,
                    "score": pick["score"],
                    "orderId": str(order.id),
                })
                _append_log("buy", "Bought %d whole share(s) of %s (~$%s) - not fractionable." % (qty, symbol, est_cost), pick)
            except Exception as e2:
                skipped.append({"symbol": symbol, "reason": str(e2)})
                _append_log("error", "Buy failed for %s: %s" % (symbol, e2))

    if skipped:
        _append_log(
            "buy",
            "Skipped %d pick(s): %s" % (
                len(skipped),
                "; ".join("%s - %s" % (s["symbol"], s["reason"]) for s in skipped),
            ),
        )

    return {"orders": orders, "skipped": skipped}


def run_sell_check():
    """Read-only: evaluates every open position against the exit rule and
    reports what it found. Never places an order - selling only happens
    when the user reviews this list and confirms a specific position via
    run_sell_symbol()."""
    settings = get_settings()
    client, _ = _trading_client()
    positions = client.get_all_positions()

    if not positions:
        _append_log("sell", "No open positions to evaluate.")
        return {"positions": [], "checked": 0}

    symbols = [p.symbol for p in positions]
    raw = _download_history(symbols, 120)
    multi = len(symbols) > 1

    result = []
    for p in positions:
        cost_basis = float(p.cost_basis)
        unrealized_pl = float(p.unrealized_pl)
        df = _extract_symbol_df(raw, p.symbol, multi)
        should_sell, details = _sell_signal(df, p.symbol, float(p.avg_entry_price), settings)
        result.append({
            "symbol": p.symbol,
            "qty": float(p.qty),
            "avgEntryPrice": float(p.avg_entry_price),
            "currentPrice": float(p.current_price) if p.current_price is not None else None,
            "marketValue": float(p.market_value),
            "unrealizedPL": unrealized_pl,
            "unrealizedPLPercent": (unrealized_pl / cost_basis * 100) if cost_basis else 0.0,
            "shouldSell": bool(should_sell),
            "reason": details.get("reason"),
            "rsi14": details.get("rsi14"),
            "ma20": details.get("ma20"),
        })

    # Sell signals first, then largest positions, so the ones that need a
    # decision are at the top of the review list.
    result.sort(key=lambda x: (not x["shouldSell"], -x["marketValue"]))

    flagged = sum(1 for r in result if r["shouldSell"])
    _append_log("sell", "Checked %d position(s) - %d flagged for a sell signal." % (len(positions), flagged))

    return {"positions": result, "checked": len(positions)}


def run_sell_symbol(symbol):
    """Sells one specific open position, in full. Only ever called after
    the user has reviewed run_sell_check()'s results and confirmed this
    exact symbol - this function itself does not check the signal again or
    ask for confirmation; that already happened in the UI."""
    from alpaca.trading.requests import MarketOrderRequest
    from alpaca.trading.enums import OrderSide, TimeInForce

    if not symbol:
        raise ValueError("No symbol given to sell.")

    client, _ = _trading_client()
    try:
        position = client.get_open_position(symbol)
    except Exception:
        raise ValueError("No open position found for %s (already closed?)." % symbol)

    qty = abs(float(position.qty))
    try:
        order = client.submit_order(order_data=MarketOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.SELL,
            time_in_force=TimeInForce.DAY,
        ))
        _position_tracking_clear(symbol)
        _record_sell(symbol)
        _append_log("sell", "Sold %s shares of %s." % (qty, symbol))
        return {"symbol": symbol, "qty": qty, "orderId": str(order.id)}
    except Exception as e:
        _append_log("error", "Sell failed for %s: %s" % (symbol, e))
        raise


# ---------- backtest ("Test Settings") ----------
# Replays the last 365 days day by day, starting with $1,000, applying the
# same rules Auto mode uses: each morning (a) sell anything whose exit rule
# tripped, then (b) if the market filter allows, rank the universe with the
# swing score and buy the top picks with risk-based sizing. Signals use the
# PRIOR day's close and fills happen at the day's open, so there is no
# look-ahead. Settings come from the form (unsaved is fine) - nothing is
# saved and no orders are ever placed.
#
# Honest limits (also shown to the user): the universe is today's
# constituents (survivorship bias flatters results), no commissions or
# slippage, fractional shares assumed, trades only with cash (no margin), one
# decision per day (Auto's hourly runs see the same daily bars), and past
# results never predict future returns.

BACKTEST_START_CASH = 1000.0
BACKTEST_DAYS = 365
BACKTEST_LOCK = threading.Lock()
_BACKTEST = {"running": False, "stage": "", "result": None, "error": None, "startedAt": None}


def get_backtest_status():
    with BACKTEST_LOCK:
        return dict(_BACKTEST)


def _backtest_stage(msg):
    with BACKTEST_LOCK:
        _BACKTEST["stage"] = msg


def _coerce_setting(key, value):
    if key in ("topN", "maxHoldingDays", "momentumLookbackDays"):
        return max(1, int(value))
    if key in (
        "minPrice", "lookbackDays", "riskPercent", "maxPositionPercent",
        "stopLossAtrMultiple", "profitTrailTriggerPercent", "trailingStopAtrMultiple",
    ):
        return float(value)
    if key in ("excludeHeld", "requireMarketRegimeFilter"):
        return bool(value)
    return value


def start_backtest(overrides):
    """Kicks off a backtest in a background thread (it downloads a year+ of
    prices for ~500 symbols, too slow for a single HTTP request) and returns
    immediately. The page polls get_backtest_status() for progress/result."""
    with BACKTEST_LOCK:
        if _BACKTEST["running"]:
            return dict(_BACKTEST)
        _BACKTEST.update(
            running=True, stage="Starting…", result=None, error=None,
            startedAt=datetime.now(timezone.utc).isoformat(),
        )
    settings = dict(get_settings())
    for key, value in (overrides or {}).items():
        if key in DEFAULT_SETTINGS and key != "autoMode" and value is not None:
            try:
                settings[key] = _coerce_setting(key, value)
            except (TypeError, ValueError):
                pass
    threading.Thread(target=_backtest_worker, args=(settings,), daemon=True, name="stocks-backtest").start()
    return get_backtest_status()


def _backtest_worker(settings):
    try:
        result = run_backtest(settings)
        with BACKTEST_LOCK:
            _BACKTEST["result"] = result
            _BACKTEST["error"] = None
    except Exception as e:
        with BACKTEST_LOCK:
            _BACKTEST["result"] = None
            _BACKTEST["error"] = str(e)
    finally:
        with BACKTEST_LOCK:
            _BACKTEST["running"] = False
            _BACKTEST["stage"] = ""


def _bt_scores(c, ma20, ma50, rsi, ret, vr, spy_ret):
    """Vectorized copy of _score_symbol's scoring for one day across all
    symbols (arrays of equal length). Keep in sync with _score_symbol."""
    import numpy as np

    with np.errstate(invalid="ignore", divide="ignore"):
        s = np.zeros(c.shape)
        s += np.where(c > ma20, 12.0, 0.0)
        s += np.where(ma20 > ma50, 13.0, 0.0)
        mom = np.where(
            ret <= 0, 0.0,
            np.where(ret <= 15, ret / 15.0 * 25.0, np.maximum(25.0 - (ret - 15.0) * 0.5, 10.0)),
        )
        s += mom
        s += np.where(
            (rsi >= 45) & (rsi <= 65), 20.0,
            np.where(((rsi >= 35) & (rsi < 45)) | ((rsi > 65) & (rsi <= 75)), 10.0, 0.0),
        )
        vr_ok = np.isfinite(vr)
        s += np.where(vr_ok, np.clip(np.where(vr_ok, vr, 1.0) - 1.0, 0.0, 1.0) * 15.0, 0.0)
        if spy_ret is not None and np.isfinite(spy_ret):
            s += np.clip((ret - spy_ret) / 10.0, 0.0, 1.0) * 15.0
    return np.round(s, 1)


def _bt_sell_reason(pos, c, ma20, rsi, atr, today, s):
    """Same layered exit rule as _sell_signal, on pre-computed values."""
    import math

    if c > pos["peak"]:
        pos["peak"] = c
    if atr is not None and math.isfinite(atr) and atr > 0:
        entry = pos["entry"]
        if c <= entry - float(s["stopLossAtrMultiple"]) * atr:
            return "Stop-loss"
        gain = (pos["peak"] / entry - 1) if entry else 0
        if gain >= float(s["profitTrailTriggerPercent"]) / 100.0:
            if c <= pos["peak"] - float(s["trailingStopAtrMultiple"]) * atr:
                return "Trailing stop"
        days = (today - pos["date"]).days
        r = rsi if (rsi is not None and math.isfinite(rsi)) else 50.0
        if days >= int(s["maxHoldingDays"]) and r < 50:
            return "Time stop"
    if ma20 is not None and math.isfinite(ma20) and c < ma20:
        return "Trend break"
    return None


def run_backtest(settings):
    import math
    import numpy as np
    import pandas as pd

    s = settings
    lb = max(2, int(s.get("momentumLookbackDays", 10)))

    symbols, used_fallback = _get_universe(s.get("universe", "sp500_dow"))
    symbols = [x for x in symbols if x != "SPY"]

    _backtest_stage("Downloading price history for %d symbols (this can take a minute or two)…" % len(symbols))
    raw = _download_history(symbols + ["SPY"], BACKTEST_DAYS + 330)

    spy_df = _extract_symbol_df(raw, "SPY", True)
    if spy_df is None or len(spy_df) < 260:
        raise RuntimeError("Couldn't get enough S&P 500 (SPY) price history to run the test.")
    dates = spy_df.index
    n, m = len(dates), len(symbols)

    _backtest_stage("Computing indicators…")
    nan = np.nan
    O = np.full((n, m), nan); C = np.full((n, m), nan); CF = np.full((n, m), nan)
    MA20 = np.full((n, m), nan); MA50 = np.full((n, m), nan); RSI = np.full((n, m), nan)
    ATR = np.full((n, m), nan); RET = np.full((n, m), nan); VR = np.full((n, m), nan)

    usable = 0
    for k, sym in enumerate(symbols):
        df = _extract_symbol_df(raw, sym, True)
        if df is None or len(df) < 60:
            continue
        close = df["Close"]
        ind = pd.DataFrame({
            "O": df["Open"] if "Open" in df.columns else close,
            "C": close,
            "MA20": close.rolling(20).mean(),
            "MA50": close.rolling(50).mean(),
            "RSI": _compute_rsi(close),
            "ATR": _compute_atr(df),
            "RET": close.pct_change(lb) * 100,
        })
        if "Volume" in df.columns:
            v = df["Volume"]
            base = v.shift(5).rolling(20).mean()
            ind["VR"] = v.rolling(5).mean() / base.where(base > 0)
        else:
            ind["VR"] = nan
        # _score_symbol needs at least 60 bars of history
        warm = df.index[59]
        score_cols = ["MA20", "MA50", "RSI", "ATR", "RET", "VR"]
        ind.loc[ind.index < warm, score_cols] = nan
        ind = ind.reindex(dates)
        ind["CF"] = ind["C"].ffill()
        O[:, k] = ind["O"].to_numpy(); C[:, k] = ind["C"].to_numpy(); CF[:, k] = ind["CF"].to_numpy()
        MA20[:, k] = ind["MA20"].to_numpy(); MA50[:, k] = ind["MA50"].to_numpy()
        RSI[:, k] = ind["RSI"].to_numpy(); ATR[:, k] = ind["ATR"].to_numpy()
        RET[:, k] = ind["RET"].to_numpy(); VR[:, k] = ind["VR"].to_numpy()
        usable += 1
    if usable == 0:
        raise RuntimeError("None of the symbols had enough price history to test.")

    spy_close = spy_df["Close"].reindex(dates)
    spy_open = (spy_df["Open"] if "Open" in spy_df.columns else spy_df["Close"]).reindex(dates)
    spy_ma200 = spy_close.rolling(200).mean().to_numpy()
    spy_ret = (spy_close.pct_change(lb) * 100).to_numpy()
    spy_c = spy_close.to_numpy()
    spy_cf = spy_close.ffill().to_numpy()
    spy_o = spy_open.to_numpy()

    cutoff = dates[-1] - timedelta(days=BACKTEST_DAYS)
    first_i = max(1, int(dates.searchsorted(cutoff)))
    if n - first_i < 30:
        raise RuntimeError("Not enough trading days to test.")

    top_n = int(s.get("topN", 10))
    min_price = float(s.get("minPrice", 5.0))
    exclude_held = bool(s.get("excludeHeld", True))
    use_regime = bool(s.get("requireMarketRegimeFilter", True))

    cash = BACKTEST_START_CASH
    positions = {}       # symbol index -> {shares, entry, peak, date}
    trades = []
    curve = []
    paused_days = 0
    exposure_sum = 0.0
    spy_shares = None

    _backtest_stage("Simulating %d trading days…" % (n - first_i))
    for i in range(first_i, n):
        j = i - 1
        today = dates[i].to_pydatetime() if hasattr(dates[i], "to_pydatetime") else dates[i]
        if getattr(today, "tzinfo", None) is not None:
            today = today.replace(tzinfo=None)

        def px_open(k):
            p = O[i, k]
            return float(p) if math.isfinite(p) else (float(CF[i, k]) if math.isfinite(CF[i, k]) else None)

        # 1) exits, decided on yesterday's close, filled at today's open
        sold_today = set()
        for k in list(positions.keys()):
            pos = positions[k]
            cj = C[j, k]
            if not math.isfinite(cj):
                continue
            reason = _bt_sell_reason(pos, float(cj), float(MA20[j, k]), float(RSI[j, k]), float(ATR[j, k]), today, s)
            if not reason:
                continue
            price = px_open(k)
            if not price:
                continue
            proceeds = pos["shares"] * price
            cash += proceeds
            cost = pos["shares"] * pos["entry"]
            trades.append({
                "symbol": symbols[k],
                "entryDate": pos["date"].strftime("%Y-%m-%d"),
                "exitDate": today.strftime("%Y-%m-%d"),
                "entryPrice": round(pos["entry"], 2),
                "exitPrice": round(price, 2),
                "pnl": round(proceeds - cost, 2),
                "pnlPercent": round((price / pos["entry"] - 1) * 100, 2),
                "days": (today - pos["date"]).days,
                "reason": reason,
            })
            del positions[k]
            sold_today.add(k)

        # 2) market regime filter (yesterday's S&P 500 vs its 200-day average)
        regime_ok = True
        if use_regime and math.isfinite(spy_c[j]) and math.isfinite(spy_ma200[j]):
            regime_ok = spy_c[j] > spy_ma200[j]
        if use_regime and not regime_ok:
            paused_days += 1

        # 3) scan + buy
        if regime_ok:
            c = C[j]
            valid = (
                np.isfinite(c) & np.isfinite(MA20[j]) & np.isfinite(MA50[j])
                & np.isfinite(ATR[j]) & (np.nan_to_num(ATR[j]) > 0) & (np.nan_to_num(c) > 0)
            )
            with np.errstate(invalid="ignore"):
                valid &= (np.nan_to_num(c) >= min_price)
            if valid.any():
                rsi_j = np.where(np.isfinite(RSI[j]), RSI[j], 50.0)
                ret_j = np.where(np.isfinite(RET[j]), RET[j], 0.0)
                sp = spy_ret[j] if math.isfinite(spy_ret[j]) else None
                sc = _bt_scores(np.nan_to_num(c), np.nan_to_num(MA20[j]), np.nan_to_num(MA50[j]), rsi_j, ret_j, VR[j], sp)
                sc = np.where(valid, sc, -1.0)
                order = np.argsort(-sc, kind="stable")[:top_n]
                picks = [int(k) for k in order if valid[k]]

                # same buy filters as run_buy: no same-day buy-backs, nothing
                # already below its 20-day average
                candidates = [
                    k for k in picks
                    if not (exclude_held and k in positions)
                    and k not in sold_today
                    and not (math.isfinite(MA20[j, k]) and c[k] < MA20[j, k])
                ]
                if candidates:
                    equity = cash
                    for k, pos in positions.items():
                        p = px_open(k)
                        equity += pos["shares"] * (p if p else pos["entry"])
                    targets = {
                        k: _position_size({"price": float(c[k]), "atr14": float(ATR[j, k])}, equity, s)
                        for k in candidates
                    }
                    total_target = sum(targets.values())
                    available = cash * 0.98
                    scale = min(1.0, available / total_target) if total_target > 0 else 0.0
                    remaining = available
                    for k in candidates:
                        alloc = min(targets[k] * scale, remaining)
                        price = px_open(k)
                        if alloc < 1 or not price:
                            continue
                        shares = alloc / price
                        cash -= alloc
                        remaining -= alloc
                        if k in positions:
                            pos = positions[k]
                            tot = pos["shares"] + shares
                            pos["entry"] = (pos["entry"] * pos["shares"] + price * shares) / tot
                            pos["shares"] = tot
                            pos["peak"] = max(pos["peak"], price)
                        else:
                            positions[k] = {"shares": shares, "entry": price, "peak": price, "date": today}

        # 4) mark to market at the close
        held_value = 0.0
        for k, pos in positions.items():
            p = CF[i, k]
            held_value += pos["shares"] * (float(p) if math.isfinite(p) else pos["entry"])
        value = cash + held_value
        exposure_sum += (held_value / value) if value > 0 else 0.0

        if spy_shares is None:
            so = spy_o[i] if math.isfinite(spy_o[i]) else spy_cf[i]
            spy_shares = BACKTEST_START_CASH / so
        spy_value = spy_shares * (spy_cf[i] if math.isfinite(spy_cf[i]) else spy_o[i])
        curve.append({
            "date": today.strftime("%Y-%m-%d"),
            "value": round(value, 2),
            "spy": round(float(spy_value), 2),
        })

    # ---- summary stats ----
    values = [pt["value"] for pt in curve]
    final_value = values[-1]
    peak = values[0]
    max_dd = 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            max_dd = max(max_dd, (peak - v) / peak * 100)

    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    reasons = {}
    for t in trades:
        reasons[t["reason"]] = reasons.get(t["reason"], 0) + 1

    open_positions = []
    for k, pos in positions.items():
        p = CF[n - 1, k]
        last = float(p) if math.isfinite(p) else pos["entry"]
        open_positions.append({
            "symbol": symbols[k],
            "entryDate": pos["date"].strftime("%Y-%m-%d"),
            "entryPrice": round(pos["entry"], 2),
            "lastPrice": round(last, 2),
            "pnlPercent": round((last / pos["entry"] - 1) * 100, 2),
            "value": round(pos["shares"] * last, 2),
        })
    open_positions.sort(key=lambda x: -x["value"])

    days_tested = len(curve)
    return {
        "startCash": BACKTEST_START_CASH,
        "startDate": curve[0]["date"],
        "endDate": curve[-1]["date"],
        "days": days_tested,
        "finalValue": round(final_value, 2),
        "returnPercent": round((final_value / BACKTEST_START_CASH - 1) * 100, 2),
        "spyFinalValue": curve[-1]["spy"],
        "spyReturnPercent": round((curve[-1]["spy"] / BACKTEST_START_CASH - 1) * 100, 2),
        "maxDrawdownPercent": round(max_dd, 2),
        "closedTrades": len(trades),
        "winRatePercent": round(len(wins) / len(trades) * 100, 1) if trades else None,
        "avgWinPercent": round(sum(t["pnlPercent"] for t in wins) / len(wins), 2) if wins else None,
        "avgLossPercent": round(sum(t["pnlPercent"] for t in losses) / len(losses), 2) if losses else None,
        "bestTrade": max(trades, key=lambda t: t["pnlPercent"]) if trades else None,
        "worstTrade": min(trades, key=lambda t: t["pnlPercent"]) if trades else None,
        "avgDaysHeld": round(sum(t["days"] for t in trades) / len(trades), 1) if trades else None,
        "avgExposurePercent": round(exposure_sum / days_tested * 100, 1) if days_tested else 0,
        "pausedDays": paused_days,
        "exitReasons": reasons,
        "openPositions": open_positions,
        "recentTrades": trades[-40:][::-1],
        "curve": curve,
        "universeSize": len(symbols),
        "symbolsTested": usable,
        "usedFallback": used_fallback,
        "settings": {k: s.get(k) for k in DEFAULT_SETTINGS if k != "autoMode"},
    }


# ---------- auto mode (hourly cycle) ----------
# When the Auto switch is on, a background thread started by server.py wakes
# at the top of every hour and runs: refresh account data -> sell-signal
# check -> sell every flagged position -> scan -> buy top picks. It only
# trades while the US market is open (checked via Alpaca's clock) so orders
# don't pile up overnight, and the market regime filter still pauses buys.
# Everything is logged to the Activity Log. Only one cycle runs at a time.

AUTO_LOCK = threading.Lock()
_scheduler_started = False


def _console(msg):
    """Prints to the server's own output (the app log on Home Assistant)."""
    try:
        print("[stocks %s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M"), msg), flush=True)
    except Exception:
        pass


def get_auto_status():
    data = _load_data()
    return {
        "autoMode": bool(data["settings"].get("autoMode")),
        "lastAutoRun": data.get("lastAutoRun"),
    }


def run_auto_cycle():
    if not AUTO_LOCK.acquire(blocking=False):
        return {"skipped": "A cycle is already running."}
    try:
        import time
        try:
            client, _ = _trading_client()
            if not client.get_clock().is_open:
                # Not written to the Activity Log: this happens ~17 times a
                # day plus weekends and would push every real entry out of
                # the 200-entry log within days.
                _console("Auto cycle skipped - US market is closed.")
                data = _load_data()
                data["lastAutoCheck"] = {"timestamp": datetime.now(timezone.utc).isoformat(), "result": "Market closed"}
                _save_data(data)
                return {"skipped": "Market closed."}
        except Exception as e:
            _append_log("error", "Auto cycle couldn't check market hours: %s" % e)
            _console("Auto cycle couldn't check market hours: %s" % e)
            return {"error": str(e)}

        _append_log("auto", "Auto cycle started.")
        summary = {"sold": [], "bought": 0, "errors": []}
        try:
            get_account()  # refresh account data / portfolio snapshot
        except Exception as e:
            summary["errors"].append("account: %s" % e)

        try:
            review = run_sell_check()
            for p in review.get("positions", []):
                if p.get("shouldSell"):
                    try:
                        run_sell_symbol(p["symbol"])
                        summary["sold"].append(p["symbol"])
                    except Exception as e:
                        summary["errors"].append("sell %s: %s" % (p["symbol"], e))
            if summary["sold"]:
                time.sleep(15)  # let sell orders fill so buying power frees up
        except Exception as e:
            summary["errors"].append("sell check: %s" % e)

        try:
            run_scan()
            result = run_buy()
            summary["bought"] = len(result.get("orders", []))
        except Exception as e:
            summary["errors"].append("scan/buy: %s" % e)

        msg = "Auto cycle finished: sold %d, bought %d." % (len(summary["sold"]), summary["bought"])
        if summary["errors"]:
            msg += " Issues: " + "; ".join(summary["errors"])
        _append_log("auto", msg)
        _console(msg)

        data = _load_data()
        data["lastAutoRun"] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "sold": summary["sold"],
            "bought": summary["bought"],
            "errors": summary["errors"],
        }
        _save_data(data)
        return summary
    finally:
        AUTO_LOCK.release()


def _scheduler_loop():
    import time
    while True:
        now = datetime.now()
        next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        time.sleep(max(1, (next_hour - now).total_seconds()))
        try:
            if get_settings().get("autoMode"):
                run_auto_cycle()
            else:
                _console("Auto mode is off - nothing to do this hour.")
        except Exception as e:
            _console("Auto scheduler error: %s" % e)
            try:
                _append_log("error", "Auto scheduler error: %s" % e)
            except Exception:
                pass


def start_scheduler():
    """Idempotent; called once from server.py at startup."""
    global _scheduler_started
    if _scheduler_started:
        return
    _scheduler_started = True
    threading.Thread(target=_scheduler_loop, daemon=True, name="stocks-auto").start()
    _console("Auto scheduler started - checks at the top of every hour.")
