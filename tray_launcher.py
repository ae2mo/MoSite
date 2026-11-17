#!/usr/bin/env python3
"""
tray_launcher.py - runs the Home Budget Planner server with a small icon in
the system tray (near the clock, alongside other background apps) instead
of an open console window.

Left-click (or right-click -> "Open Home Budget Planner") opens the site in
your browser. Right-click -> "Quit" stops the server and closes the icon.

This is just an alternate front end for server.py - it reuses that file's
server setup directly (same HOST/PORT, same request handler, same data
files), so the site behaves identically either way. Run this instead of
server.py if you want it to stay out of the way in the tray; run
`python server.py` directly instead if you want to see the request log in
a console window (handy for troubleshooting).

Needs pystray + Pillow:
    pip install -r requirements-tray.txt
Start Budget Site.bat installs these (and falls back to a normal console
window automatically) if they're missing.
"""

import os
import subprocess
import sys
import threading
import traceback
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(BASE_DIR, "tray_launcher_error.log")

# pythonw.exe has no console, so a normal traceback or sys.exit() message
# just vanishes - anything that goes wrong here needs to land in a file
# instead, or troubleshooting this is impossible. This overwrites the log
# on every start, so it always reflects the most recent run.


def _log_startup_error(text):
    try:
        with open(LOG_FILE, "w", encoding="utf-8") as f:
            f.write(text)
    except Exception:
        pass


try:
    import pystray
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    _log_startup_error(
        "pystray and Pillow are required for the tray icon.\n"
        "Install with: pip install -r requirements-tray.txt\n"
        "(Start Budget Site.bat does this automatically - if you're seeing "
        "this, something went wrong with that install. You can also just "
        "run 'python server.py' instead for a console-window version.)\n"
    )
    sys.exit(1)

import server as budget_server

URL = "http://localhost:%d" % budget_server.PORT


def make_icon_image():
    """A simple blue rounded-square "$" icon, drawn at runtime so there's
    no separate image file to ship or go missing. Matches the $ logo used
    on every page of the site."""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([2, 2, size - 2, size - 2], radius=14, fill=(37, 99, 235, 255))

    font = None
    for name in ("arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"):
        try:
            font = ImageFont.truetype(name, 36)
            break
        except Exception:
            continue

    if font:
        draw.text((size / 2, size / 2 - 2), "$", fill="white", anchor="mm", font=font)
    else:
        # No TrueType font found - fall back to Pillow's tiny built-in
        # bitmap font rather than failing to make an icon at all.
        draw.text((size / 2 - 3, size / 2 - 5), "$", fill="white")

    return img


def start_http_server():
    """Sets up and starts the same ThreadingHTTPServer server.py's main()
    creates, but on a background thread instead of blocking - the tray
    icon's event loop needs the main thread."""
    budget_server.load_data()
    budget_server.load_meals_data()
    try:
        httpd = budget_server.ThreadingHTTPServer(
            (budget_server.HOST, budget_server.PORT), budget_server.BudgetRequestHandler
        )
    except OSError as e:
        raise RuntimeError(
            "Couldn't start the server on port %d (%s). This almost always "
            "means another copy is already running - check Task Manager "
            "for an existing python.exe/pythonw.exe, or a leftover console "
            "window, and close it before starting a new one." % (budget_server.PORT, e)
        )
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    # server.py's main() starts the Stock Trader's hourly Auto scheduler;
    # this launcher bypasses main(), so start it here too - otherwise Auto
    # mode never runs when the site is started from the tray.
    try:
        import stocks_engine
        stocks_engine.start_scheduler()
    except Exception:
        pass
    return httpd


def main():
    httpd = start_http_server()

    def open_site(icon=None, item=None):
        webbrowser.open(URL)

    def restart_app(icon, item):
        # Spawn a fresh copy first, then shut this one down - avoids a gap
        # where the tray icon/port would briefly disappear entirely.
        subprocess.Popen([sys.executable, os.path.abspath(__file__)], cwd=BASE_DIR)
        httpd.shutdown()
        httpd.server_close()
        icon.stop()
        os._exit(0)

    def quit_app(icon, item):
        httpd.shutdown()
        httpd.server_close()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open MoSite", open_site, default=True),
        pystray.MenuItem("Restart", restart_app),
        pystray.MenuItem("Quit", quit_app),
    )
    icon = pystray.Icon(
        "home-budget-planner",
        make_icon_image(),
        "MoSite - click to open",
        menu,
    )
    icon.run()


if __name__ == "__main__":
    try:
        # A clean start removes any stale error log from a previous failed
        # run, so an empty/missing log file means "last start was fine."
        if os.path.exists(LOG_FILE):
            os.remove(LOG_FILE)
        main()
    except Exception:
        _log_startup_error(
            "Home Budget Planner's tray launcher crashed on startup:\n\n" +
            traceback.format_exc()
        )
        sys.exit(1)
