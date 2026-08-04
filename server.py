#!/usr/bin/env python3
"""
Home Budget Planner - local web server

Serves every page of this site (Budget, Stock Trader, ...) to any browser
on your local network, and persists data to JSON files on this computer, so
every device that visits sees the same live numbers.

Run:
    python3 server.py

Then visit:
    http://localhost:8000                       (on this computer)
    http://<this computer's LAN IP>:8000         (from any other device on
                                                   your network - printed
                                                   at startup below)

The Budget pages need nothing beyond the standard library. The Stock
Trader page needs a few extra packages - see requirements-stocks.txt and
STOCKS_README.md. Those imports only happen when you actually use a
/api/stocks/* endpoint, so the Budget app works even if they're not
installed.
"""

import glob
import json
import os
import shutil
import socket
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = "0.0.0.0"          # listen on all interfaces so the LAN can reach it
PORT = 8000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_FILE = os.path.join(BASE_DIR, "data.json")
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
BACKUP_KEEP = 30  # keep this many most-recent daily snapshots per file

if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)  # so `import stocks_engine` works regardless of cwd

DATA_LOCK = threading.Lock()


# One-per-calendar-day snapshot of a data file, kept in backups/, so an
# accidental "Clear Data" click or a bad edit doesn't wipe out data that
# can't be gotten back. Only the first save of each day creates a new
# snapshot; older ones beyond BACKUP_KEEP are pruned. Best-effort - a
# backup failure should never block a save the user is waiting on.
def snapshot_backup(src_path, prefix):
    try:
        if not os.path.exists(src_path):
            return
        os.makedirs(BACKUP_DIR, exist_ok=True)
        today = datetime.now().strftime("%Y-%m-%d")
        dest = os.path.join(BACKUP_DIR, "{}-{}.json".format(prefix, today))
        if not os.path.exists(dest):
            shutil.copy2(src_path, dest)
        existing = sorted(glob.glob(os.path.join(BACKUP_DIR, "{}-*.json".format(prefix))))
        for old in existing[:-BACKUP_KEEP]:
            os.remove(old)
    except OSError:
        pass  # backups are a bonus, never worth failing a save over


# The server has no opinion on the budget schema - it just persists whatever
# JSON blob the client sends. All month/category/pay-period defaults and
# templating logic live in static/app.js so the schema can evolve freely
# without touching this file.


def build_default_data():
    return {
        "months": {},
        "tsp": {
            "currentBalance": 0,
            "monthlyContribution": 0,
            "retirementYear": None,
        },
        "nextId": 1,
    }


def load_data():
    with DATA_LOCK:
        if not os.path.exists(DATA_FILE):
            data = build_default_data()
            _write_data(data)
            return data
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            data = build_default_data()
            _write_data(data)
            return data


def _write_data(data):
    tmp_path = DATA_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, DATA_FILE)


def save_data(data):
    with DATA_LOCK:
        _write_data(data)
    snapshot_backup(DATA_FILE, "data")


# Meal Planner has its own JSON blob, same generic "server has no opinion on
# the schema" approach as the Budget app - all meal/plan/shopping-list logic
# lives in static/meals/app.js, not here.

MEALS_DATA_FILE = os.path.join(BASE_DIR, "meals_data.json")
MEALS_DATA_LOCK = threading.Lock()


def build_default_meals_data():
    return {
        "meals": [],
        "plans": {},
        "shoppingLists": {},
        "nextId": 1,
    }


def load_meals_data():
    with MEALS_DATA_LOCK:
        if not os.path.exists(MEALS_DATA_FILE):
            data = build_default_meals_data()
            _write_meals_data(data)
            return data
        try:
            with open(MEALS_DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            data = build_default_meals_data()
            _write_meals_data(data)
            return data


def _write_meals_data(data):
    tmp_path = MEALS_DATA_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, MEALS_DATA_FILE)


def save_meals_data(data):
    with MEALS_DATA_LOCK:
        _write_meals_data(data)
    snapshot_backup(MEALS_DATA_FILE, "meals_data")


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


class BudgetRequestHandler(BaseHTTPRequestHandler):
    server_version = "HomeBudget/1.0"

    def log_message(self, fmt, *args):
        # sys.stderr is None under pythonw.exe (no console attached, e.g.
        # when running via tray_launcher.py) - writing to it unconditionally
        # would crash every single request right as it starts, before any
        # response is sent. Silently skip logging in that case instead.
        if sys.stderr is None:
            return
        try:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            # The client is already gone (closed the tab, navigated away,
            # or - for a long-running request like the TheMealDB bulk
            # import - the connection simply timed out while waiting).
            # Nothing to send it to anymore, so drop it quietly instead of
            # letting the write error blow up the request thread (which,
            # without this, could itself trigger a second failed write from
            # an except-block trying to report the first one).
            pass

    def _send_json_download(self, status, payload, filename):
        body = json.dumps(payload, indent=2).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass

    def _send_file(self, path):
        if not os.path.isfile(path):
            self._send_json(404, {"error": "not found"})
            return
        ext = os.path.splitext(path)[1]
        content_type = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _read_raw_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path

        if route == "/api/data":
            self._send_json(200, load_data())
            return

        if route == "/api/data/export":
            filename = "mosite-budget-backup-%s.json" % datetime.now().strftime("%Y-%m-%d")
            self._send_json_download(200, load_data(), filename)
            return

        if route == "/api/meals-data":
            self._send_json(200, load_meals_data())
            return

        if route == "/api/meals/homeassistant-config":
            import homeassistant_export
            self._send_json(200, homeassistant_export.get_config_public())
            return

        if route.startswith("/api/stocks/"):
            self._handle_stocks_get(route[len("/api/stocks/"):])
            return

        if route == "/" or route == "":
            route = "/index.html"
        elif route.endswith("/"):
            route = route + "index.html"

        # prevent path traversal - resolve against STATIC_DIR only
        safe_rel = os.path.normpath(route).lstrip("/\\")
        full_path = os.path.abspath(os.path.join(STATIC_DIR, safe_rel))
        if not full_path.startswith(os.path.abspath(STATIC_DIR)):
            self._send_json(403, {"error": "forbidden"})
            return

        if os.path.isdir(full_path):
            # e.g. someone typed /stocks with no trailing slash - send them
            # to /stocks/ so the browser's relative asset paths still work
            self.send_response(301)
            self.send_header("Location", parsed.path + "/")
            self.end_headers()
            return

        self._send_file(full_path)

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/data":
            try:
                incoming = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid json"})
                return
            save_data(incoming)
            self._send_json(200, {"status": "ok"})
            return

        if parsed.path == "/api/statement/parse":
            # Raw PDF bytes as the whole request body (the browser just does
            # fetch(url, { method: "POST", body: file }) with the File object
            # directly) - not JSON, so this doesn't go through
            # _read_json_body like every other POST route here.
            body = self._read_raw_body()
            if not body:
                self._send_json(400, {"error": "No file received."})
                return
            try:
                import statement_import
                result = statement_import.parse_statement_pdf(body)
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/meals-data":
            try:
                incoming = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid json"})
                return
            save_meals_data(incoming)
            self._send_json(200, {"status": "ok"})
            return

        if parsed.path == "/api/meals/import-recipe":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid json"})
                return
            try:
                import meals_recipe_import
                result = meals_recipe_import.import_recipe(body.get("url"))
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/meals/homeassistant-config":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid json"})
                return
            try:
                import homeassistant_export
                result = homeassistant_export.save_config(body)
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/meals/send-to-homeassistant":
            try:
                body = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid json"})
                return
            try:
                import homeassistant_export
                result = homeassistant_export.send_items(body.get("items") or [])
                self._send_json(200, result)
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path == "/api/meals/import-all-themealdb":
            # Walks TheMealDB's full catalog (every category, every meal in
            # it) and looks up full details for each - several hundred
            # sequential requests to TheMealDB's API, so this one call can
            # take a minute or two. ThreadingHTTPServer runs it on its own
            # thread, so it doesn't block other requests while it works.
            try:
                import meals_recipe_import
                recipes = meals_recipe_import.import_all_themealdb()
                self._send_json(200, {"recipes": recipes})
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        if parsed.path.startswith("/api/stocks/"):
            self._handle_stocks_post(parsed.path[len("/api/stocks/"):])
            return

        self._send_json(404, {"error": "not found"})

    # ---------- Stock Trader API ----------
    # All the heavy lifting (Alpaca, pandas, numpy, yfinance) lives in
    # stocks_engine.py and is imported lazily here, so the Budget app never
    # depends on those packages being installed.

    def _stocks_engine(self):
        try:
            import stocks_engine
            return stocks_engine, None
        except ImportError as e:
            return None, str(e)

    def _handle_stocks_get(self, subpath):
        engine, import_error = self._stocks_engine()
        if engine is None:
            self._send_json(200, {"error": "not_installed", "detail": import_error})
            return

        try:
            if subpath == "status":
                self._send_json(200, engine.get_status())
            elif subpath == "account":
                self._send_json(200, engine.get_account())
            elif subpath == "positions":
                self._send_json(200, {"positions": engine.get_positions()})
            elif subpath == "settings":
                self._send_json(200, engine.get_settings())
            elif subpath == "config":
                self._send_json(200, engine.get_config_public())
            elif subpath == "log":
                self._send_json(200, {"entries": engine.get_log()})
            elif subpath == "history":
                self._send_json(200, {"snapshots": engine.get_history()})
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _handle_stocks_post(self, subpath):
        engine, import_error = self._stocks_engine()
        if engine is None:
            self._send_json(200, {"error": "not_installed", "detail": import_error})
            return

        try:
            body = self._read_json_body()
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid json"})
            return

        try:
            if subpath == "settings":
                self._send_json(200, engine.save_settings(body))
            elif subpath == "config":
                self._send_json(200, engine.save_config(body))
            elif subpath == "scan":
                self._send_json(200, engine.run_scan())
            elif subpath == "buy":
                self._send_json(200, engine.run_buy())
            elif subpath == "sell-check":
                self._send_json(200, engine.run_sell_check())
            elif subpath == "sell":
                symbol = (body or {}).get("symbol")
                self._send_json(200, engine.run_sell_symbol(symbol))
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as e:
            self._send_json(500, {"error": str(e)})


def _local_network_ip():
    """Best-effort guess at this machine's own LAN IP, so the startup
    message points at an address that actually works on whatever network
    this copy of the site happens to be running on - never a hardcoded
    address from wherever the code was written. Doesn't actually send
    anything (UDP connect() just picks the outbound interface/address the
    OS would use); falls back to None if there's no network at all, in
    which case the caller just skips the Network line."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return None


def main():
    load_data()  # ensure data.json exists
    load_meals_data()  # ensure meals_data.json exists
    snapshot_backup(DATA_FILE, "data")
    snapshot_backup(MEALS_DATA_FILE, "meals_data")
    httpd = ThreadingHTTPServer((HOST, PORT), BudgetRequestHandler)
    print("Home Budget Planner running.")
    print(f"  Local:   http://localhost:{PORT}")
    local_ip = _local_network_ip()
    if local_ip:
        print(f"  Network: http://{local_ip}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == "__main__":
    main()
