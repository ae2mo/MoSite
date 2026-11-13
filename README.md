# Home Budget Planner

A locally hosted site for your home network, running entirely on your own
computer — everyone on your network can view and update the same live data
from their own browser. It now has more than one section: click the blue
**$** logo top-left on any page to switch between them.

- **Budget Planner** (this page) — income, expenses, savings, 401K/TSP, accounts.
- **[Stock Trader](STOCKS_README.md)** — an Alpaca-connected momentum
  screener and order-execution page. Needs a one-time `pip install` and an
  Alpaca API key; see `STOCKS_README.md` for setup.
- **Home/Car Maintenance** — a logbook-style page with a **Home** tab
  (recurring chores like air and water filters, each with part number,
  size, repeat interval, last-done date, a dated history, and a due/overdue
  badge, plus a planned-projects list) and a **Cars** tab (add/remove cars,
  record the odometer, and track oil changes and other manufacturer-recommended
  services by miles and/or months, plus planned work per car). Data lives in
  `maintenance_data.json`.
- **Meal Planner** — keep a list of favorite meals with ingredients and
  instructions (or import them straight from a recipe URL - TheMealDB,
  RecipeDB, or most recipe blogs - or pull in TheMealDB's entire database
  in one click), assign them to Lunch/Dinner across the week with
  adjustable serving sizes, and generate a shopping list grouped by
  grocery category. Export the list as text, or send it straight into a
  Home Assistant to-do list (needs a one-time Home Assistant URL + token;
  see the gear next to "Send to Home Assistant" on the Shopping List tab).

## What's included

- **Month navigator** — a ‹ Prev / month picker / Next › bar (visible on
  Dashboard, Income, Expenses, and Savings) lets you browse any past month or
  jump ahead to a future one. Every month is independent, so bills that
  changed last month don't affect this one.
- **Recurring items (the star)** — every pay period, expense, and savings
  goal has a star (&#9733;) button. Starred items automatically carry into
  next month; unstarred ones are treated as one-off and stay in the month
  you entered them. Editing a starred item's amount only affects months you
  haven't opened yet — a month you've already visited keeps whatever it had.
  This applies the same way whether you're revisiting an old month or
  opening a brand-new one, so starring something in July still reaches
  August even if you'd already clicked ahead to August before starring it.
- **Income** — add one row per paycheck you actually received that month
  (Label / Gross / Net). Paid biweekly? Add two rows most months and a third
  whenever that extra paycheck lands — totals and the effective tax &
  deduction rate recalculate automatically either way. Star your regular
  paychecks so they carry forward; leave a one-off bonus check unstarred.
- **Expenses** — eight pre-built categories covering typical household
  costs. Every line item tracks **Budgeted** (your plan) vs. **Actual**
  (what really happened) vs. **Difference**, mark items Monthly or Annual,
  and add/remove rows freely per month.
- **Savings** — tracked separately from Expenses so saving money is never
  confused with spending it. Same Projected vs. Actual vs. Difference
  pattern, with a starter category for things like an emergency fund or a
  vacation fund.
- **Dashboard** — net income, budgeted expenses, budgeted savings,
  leftover/shortfall, and savings rate (% of income you're planning to
  save) for whichever month is selected, plus a spending breakdown chart
  and Budgeted/Actual/Difference tables for both expense categories and
  savings goals. Leftover = income − budgeted expenses − budgeted savings,
  so it reflects money that isn't allocated to anything yet.
- **Log a Receipt / Import Statement** — itemize a paper receipt by hand,
  or upload a bank/card statement PDF (a transaction-list export) and go
  through every transaction at once: pick which Expenses category and item
  each one belongs to (or create a new item on the spot), and credits add
  as new Income pay periods. Anything whose amount already matches
  something you've logged that month starts unchecked so re-importing, or
  reconciling against entries you already made by hand, doesn't
  double-count — check the box for any that are genuinely a separate
  transaction. Needs a one-time `pip install` (pdfplumber); see
  Requirements below.
- **Trends** — a chart and table across every month you've opened, so you
  can see the effect of a planned future expense or savings goal before it
  happens: jump to that month on the Expenses or Savings tab, add the line
  item, then check Trends.
- **401K/TSP Projection** — enter your current 401K/TSP balance,
  optional monthly contribution, and projected retirement year, and see a
  forward projection (to that year, ±5 years) compounded annually at three
  scenarios: 8% (low), 10% (expected), and 12% (high). Includes a chart, a
  milestone comparison table, and a full year-by-year table. This is
  separate from the monthly budget — it isn't tied to a specific month.

All data is saved automatically to `data.json` on the host computer, so
closing the browser or restarting a device never loses anything.

### Backups

Every time `data.json` (or `meals_data.json`) is saved, the server also
keeps a dated snapshot in `backups/` — one per calendar day, with the
oldest pruned once there are more than 30. If something ever gets
accidentally cleared or overwritten, the previous day's `backups/data-
YYYY-MM-DD.json` has the last known good copy of everything.

For an on-demand copy you control, open the Budget page, click the gear
icon (top right) → **Download Backup** to save a `.json` file of all your
budget data wherever you'd like (a second drive, cloud storage, etc.).
This uses the same file format as `data.json`, so restoring it is just a
matter of renaming it back to `data.json` and restarting the server.

### A note on future changes (for whoever's developing this next)

Every entry you've made — receipts, pay periods, accounts, everything —
lives in `data.json` and is precious; it's not sample data. When this app
gains new features or its schema changes, existing months/items are never
dropped or reset to add a new field. Instead, a `migrate*Schema()`
function (see `static/app.js`, e.g. `migrateIncomeSchema`,
`migrateExpensesSchema`, `migrateSavingsSchema`) backfills the new field
onto old entries the first time that month is touched, so nothing already
entered is ever lost or overwritten by a code update. Any new schema
change should follow the same pattern: add, don't replace.

## Requirements

Python 3.7+ (already included on most Windows, macOS, and Linux systems).
The Budget and Meal Planner pages need no pip installs, no Node, no
external libraries — everything, including the charts, is built with the
Python standard library and vanilla JavaScript, with two exceptions: the
optional Stock Trader page needs a few extra packages (see
`STOCKS_README.md`), and the Budget page's Import Statement feature needs
`pdfplumber` (see `requirements-statement-import.txt`) to read PDFs, since
the standard library has no PDF support. On Windows, double-clicking
`Start Budget Site.bat` installs all of this automatically each time (an
internet connection is only needed the first time).

## Running it

**Windows:** just double-click `Start Budget Site.bat` — it finds Python,
installs requirements automatically, and starts the server for you. It
runs with no console window at all: instead you'll get a small **$** icon
in the system tray (near the clock, with your other background apps).
Click it to open the site in your browser, or right-click it for "Open
MoSite" / "Restart" / "Quit" - Quit is how you stop the server. (If
`pystray`/`Pillow` can't be installed for some reason - no internet on
first run, for example - it automatically falls back to a normal console
window instead, so the site still works either way.)

Otherwise, from this folder:

```
python server.py
```

or on some systems:

```
python3 server.py
```

You should see:

```
Home Budget Planner running.
  Local:   http://localhost:8000
  Network: http://<your computer's LAN IP>:8000
```

Leave that terminal window open while you use the site — closing it (or
Ctrl+C) stops the server. From this computer, open `http://localhost:8000`.
From any other device on your home network, open the "Network" address
shown in that terminal (the server prints your computer's actual LAN IP
each time it starts, since it's different on every network).

If you'd rather run the tray version by hand instead of through the
`.bat` file: `pip install -r requirements-tray.txt` once, then
`pythonw tray_launcher.py` (use `pythonw`, not `python`, so no console
window opens).

### Running it automatically

If you want the site available whenever the host computer is on, you can:

- **Windows**: create a shortcut to `Start Budget Site.bat` (or directly to
  `tray_launcher.py`, run with `pythonw`) in the Startup folder
  (`shell:startup`), or set up a Scheduled Task that runs it at logon -
  either way you'll get the tray icon with no window popping up at login.
- **macOS/Linux**: add a `launchd`/`systemd`/cron entry that runs
  `python3 server.py` on boot or login.

Ask me if you'd like help setting either of these up.

## Firewall note

If other devices on your network can't reach the "Network" address shown
in the terminal on port 8000, your host computer's firewall may be
blocking inbound connections on port 8000. Allow Python (or port 8000)
through the firewall for private/home networks.

## File layout

```
homebudget/
  server.py                       Local web server (stdlib only)
  data.json                        Your saved budget data (created automatically)
  meals_data.json                   Your saved meal planner data (created automatically)
  backups/                           Daily snapshots of data.json/meals_data.json (created automatically)
  meals_recipe_import.py             Recipe URL/bulk import logic (stdlib only)
  homeassistant_export.py             Sends the shopping list to Home Assistant (stdlib only)
  homeassistant_config.json            Your Home Assistant URL/token (created when you save settings)
  Start Budget Site.bat             Double-click to launch on Windows
  tray_launcher.py                   Runs the server with a system tray icon, no console window
  requirements-tray.txt               pip install -r this, for the tray icon
  statement_import.py                  Parses a bank statement PDF (needs pdfplumber)
  requirements-statement-import.txt     pip install -r this, for Import Statement
  stocks_engine.py                   Stock Trader logic (see STOCKS_README.md)
  stocks_config.example.json          Template for your Alpaca API keys
  requirements-stocks.txt              pip install -r this, for the Stock Trader page
  STOCKS_README.md                      Setup & details for the Stock Trader page
  static/
    nav.js, nav.css                     Shared page-switcher menu (the $ logo)
    index.html, style.css, app.js         This page
    stocks/
      index.html, style.css, app.js        Stock Trader page
    meals/
      index.html, style.css, app.js        Meal Planner page
```

## Notes on the 401K/TSP projection math

Each year, your annual contribution (monthly amount × 12) is added to the
balance, then the full balance is grown by that scenario's annual rate —
mirroring how the investor.gov compound interest calculator compounds
periodic contributions. This is a planning estimate, not investment advice;
actual 401K/TSP fund performance will vary.
