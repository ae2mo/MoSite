"""
stocks_engine.py - Alpaca momentum screener & order execution

Imported lazily by server.py only when a /api/stocks/* route is hit, so the
Budget app never needs these dependencies installed.

WHAT THIS IS: a rules-based technical screener over the Dow + S&P 500
constituents. It scores each stock on trend (price vs. 50/200-day moving
averages), 20-day momentum, RSI positioning, volume, and consistency, then
ranks them. The highest scorers are not a prediction that a stock will
rise 10% in a week - no indicator combination reliably predicts that. This
is a heuristic screening/ranking tool for experimentation, not financial
advice, and past performance never guarantees future results.

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
CONFIG_FILE = os.path.join(BASE_DIR, "stocks_config.json")
DATA_FILE = os.path.join(BASE_DIR, "stocks_data.json")

DATA_LOCK = threading.Lock()

DEFAULT_SETTINGS = {
    "topN": 10,
    "universe": "sp500_dow",   # sp500_dow | sp500 | dow
    "minPrice": 5.0,
    "excludeHeld": True,
    "lookbackDays": 365,
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
        if key in ("topN",):
            value = max(1, int(value))
        elif key in ("minPrice", "lookbackDays"):
            value = float(value)
        elif key == "excludeHeld":
            value = bool(value)
        data["settings"][key] = value
    _save_data(data)
    return data["settings"]


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


def _score_symbol(df):
    """df: DataFrame with 'Close' (and ideally 'Volume'), oldest row first.
    Returns (score 0-100, details dict) or (None, None) if there isn't
    enough history to compute a 200-day moving average."""
    import numpy as np

    if df is None or len(df) < 210:
        return None, None

    close = df["Close"]
    volume = df["Volume"] if "Volume" in df.columns else None

    ma50 = close.rolling(50).mean()
    ma200 = close.rolling(200).mean()
    rsi = _compute_rsi(close)

    last_close = float(close.iloc[-1])
    last_ma50 = float(ma50.iloc[-1]) if not np.isnan(ma50.iloc[-1]) else None
    last_ma200 = float(ma200.iloc[-1]) if not np.isnan(ma200.iloc[-1]) else None
    last_rsi = float(rsi.iloc[-1]) if not np.isnan(rsi.iloc[-1]) else 50.0

    if last_ma50 is None or last_ma200 is None or last_close <= 0:
        return None, None

    ret_20d = (last_close / float(close.iloc[-21]) - 1) * 100 if len(close) > 21 else 0.0
    daily_returns_20d = close.pct_change().iloc[-20:].dropna()
    volatility_20d = float(daily_returns_20d.std() * 100) if len(daily_returns_20d) > 5 else None

    score = 0.0

    # Trend alignment (30 pts): price above its 50-day average, and the
    # 50-day average itself above the 200-day average (classic uptrend).
    if last_close > last_ma50:
        score += 15
    if last_ma50 > last_ma200:
        score += 15

    # Recent momentum (25 pts): 20-trading-day return, capped at +20% for
    # full credit so one outlier stock doesn't dominate the ranking.
    score += max(0.0, min(ret_20d, 20.0)) / 20.0 * 25

    # RSI positioning (20 pts): rewards bullish-but-not-overheated momentum.
    if 50 <= last_rsi <= 70:
        score += 20
    elif 40 <= last_rsi < 50 or 70 < last_rsi <= 80:
        score += 10

    # Volume confirmation (15 pts): recent 10-day volume vs. the prior
    # 50 days - elevated volume suggests the move has real interest behind it.
    if volume is not None and len(volume) >= 60:
        recent_vol = float(volume.iloc[-10:].mean())
        base_vol = float(volume.iloc[-60:-10].mean())
        if base_vol > 0:
            vol_ratio = recent_vol / base_vol
            score += max(0.0, min(vol_ratio - 1.0, 1.0)) * 15

    # Consistency bonus (10 pts): reward smoother gains (return relative to
    # its own volatility) over an equally-sized but choppier move.
    if volatility_20d and volatility_20d > 0 and ret_20d > 0:
        risk_adjusted = ret_20d / volatility_20d
        score += max(0.0, min(risk_adjusted / 3.0, 1.0)) * 10

    details = {
        "price": round(last_close, 2),
        "ma50": round(last_ma50, 2),
        "ma200": round(last_ma200, 2),
        "rsi14": round(last_rsi, 1),
        "return20d": round(ret_20d, 2),
    }
    return round(score, 1), details


def _sell_signal(df):
    """Exit rule: trend broken (price under its 50-day average) or badly
    overbought (RSI > 78). Returns (should_sell, details)."""
    import numpy as np

    if df is None or len(df) < 55:
        return False, {}

    close = df["Close"]
    ma50 = close.rolling(50).mean()
    rsi = _compute_rsi(close)

    last_close = float(close.iloc[-1])
    last_ma50 = float(ma50.iloc[-1]) if not np.isnan(ma50.iloc[-1]) else None
    last_rsi = float(rsi.iloc[-1]) if not np.isnan(rsi.iloc[-1]) else 50.0

    details = {
        "price": round(last_close, 2),
        "ma50": round(last_ma50, 2) if last_ma50 is not None else None,
        "rsi14": round(last_rsi, 1),
    }

    if last_ma50 is not None and last_close < last_ma50:
        return True, dict(details, reason="Price fell below its 50-day average")
    if last_rsi > 78:
        return True, dict(details, reason="RSI overbought (above 78)")
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

    if used_fallback:
        _append_log(
            "error",
            "Could not fetch the Dow/S&P 500 constituent list from Wikipedia - "
            "scanning the built-in %d-symbol watchlist instead." % len(symbols),
        )

    _append_log("scan", "Scanning %d symbols..." % len(symbols))

    raw = _download_history(symbols, settings.get("lookbackDays", 365))
    multi = len(symbols) > 1

    scored = []
    skipped = 0
    for symbol in symbols:
        df = _extract_symbol_df(raw, symbol, multi)
        score, details = _score_symbol(df)
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
    }

    data = _load_data()
    data["lastScan"] = result
    _save_data(data)

    _append_log(
        "scan",
        "Scan complete: %d picks from %d scored symbols (%d skipped for insufficient data)."
        % (len(picks), len(scored), skipped),
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

    data = _load_data()
    last_scan = data.get("lastScan")
    if not last_scan or not last_scan.get("picks"):
        last_scan = run_scan()

    settings = get_settings()
    client, cfg = _trading_client()
    account = client.get_account()
    buying_power = float(account.buying_power)

    held_symbols = set()
    if settings.get("excludeHeld", True):
        held_symbols = {p.symbol for p in client.get_all_positions()}

    candidates = [p for p in last_scan["picks"] if p["symbol"] not in held_symbols]
    if not candidates:
        _append_log("buy", "No eligible picks to buy (top picks are already held, or the last scan returned nothing).")
        return {"orders": [], "skipped": [], "message": "No eligible picks."}

    fresh_prices = _latest_prices([c["symbol"] for c in candidates])

    # Spread funds equally in DOLLARS, not whole shares. A modest account
    # split 10 ways often can't afford one full share of every large-cap
    # pick - e.g. a $92 allocation can't buy a whole share of a $539 stock,
    # so it got silently skipped even though the split itself was correct.
    # Alpaca supports fractional ("notional") orders for most liquid US
    # stocks, so each pick gets bought for a precise dollar amount instead
    # of being rounded down to zero shares. Falls back to a whole-share
    # order (sized to fit the same allocation) only if a symbol turns out
    # not to be fractionable. The per-stock share is also recomputed as we
    # go (not fixed upfront) and a 2% buffer is held back, so price drift
    # or one pricier pick can't starve the orders placed after it.
    remaining_budget = buying_power * 0.98
    remaining_count = len(candidates)
    orders = []
    skipped = []

    for pick in candidates:
        price = fresh_prices.get(pick["symbol"], pick["price"])
        allocation = remaining_budget / remaining_count if remaining_count else 0
        remaining_count -= 1

        if allocation < 1 or not price:
            skipped.append({"symbol": pick["symbol"], "reason": "Allocation below $1."})
            continue

        notional = round(allocation, 2)
        try:
            order = client.submit_order(order_data=MarketOrderRequest(
                symbol=pick["symbol"],
                notional=notional,
                side=OrderSide.BUY,
                time_in_force=TimeInForce.DAY,
            ))
            remaining_budget -= notional
            est_qty = round(notional / price, 4)
            orders.append({
                "symbol": pick["symbol"],
                "qty": est_qty,
                "estCost": notional,
                "score": pick["score"],
                "orderId": str(order.id),
            })
            _append_log("buy", "Bought ~$%.2f (~%s shares) of %s." % (notional, est_qty, pick["symbol"]), pick)
            continue
        except Exception as e:
            # Symbol isn't fractionable (or the notional order was rejected
            # for another reason) - retry as a whole-share order sized to
            # fit inside the same dollar allocation before giving up on it.
            qty = int(allocation // price)
            if qty < 1:
                skipped.append({
                    "symbol": pick["symbol"],
                    "reason": "Not fractionable, and its price is too high for this allocation to buy one whole share (%s)." % e,
                })
                continue
            try:
                order = client.submit_order(order_data=MarketOrderRequest(
                    symbol=pick["symbol"],
                    qty=qty,
                    side=OrderSide.BUY,
                    time_in_force=TimeInForce.DAY,
                ))
                est_cost = round(qty * price, 2)
                remaining_budget -= est_cost
                orders.append({
                    "symbol": pick["symbol"],
                    "qty": qty,
                    "estCost": est_cost,
                    "score": pick["score"],
                    "orderId": str(order.id),
                })
                _append_log("buy", "Bought %d whole share(s) of %s (~$%s) - not fractionable." % (qty, pick["symbol"], est_cost), pick)
            except Exception as e2:
                skipped.append({"symbol": pick["symbol"], "reason": str(e2)})
                _append_log("error", "Buy failed for %s: %s" % (pick["symbol"], e2))

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
        should_sell, details = _sell_signal(df)
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
            "ma50": details.get("ma50"),
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
        _append_log("sell", "Sold %s shares of %s (confirmed by you)." % (qty, symbol))
        return {"symbol": symbol, "qty": qty, "orderId": str(order.id)}
    except Exception as e:
        _append_log("error", "Sell failed for %s: %s" % (symbol, e))
        raise
