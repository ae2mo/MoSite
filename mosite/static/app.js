/* Home Budget Planner - client logic
   No external dependencies. Talks to /api/data (GET to load, POST to save).

   Data model:
   state = {
     months: {
       "YYYY-MM": {
         income: { payPeriods: [{id, label, gross, net}] },
         expenses: [{ category, items: [{id, name, budgeted, actual}] }]
       }, ...
     },
     tsp: { currentBalance, monthlyContribution, years },
     accounts: [{id, name, url, username, password, cost, description}],
     nextId: <counter>,
     activeMonth: "YYYY-MM"
   }

   A month that hasn't been visited yet is created on demand by cloning the
   nearest earlier month (budgeted amounts and pay period labels carry over,
   actual spend resets to 0). Every name/amount stays fully editable per
   month, so nothing is permanently locked in. */

(function () {
  "use strict";

  var state = null;
  var saveTimer = null;
  var monthOrigin = {}; // key -> sourceKey (string) | null, only for months created this session

  var CATEGORY_COLORS = [
    "#2f6fed", "#1f9d55", "#b8860b", "#d64545",
    "#7a5cf0", "#0aa3a3", "#c2612a", "#5b6b8c", "#a13d8f"
  ];

  var DEFAULT_CATEGORY_TEMPLATE = [
    { category: "Housing", items: ["Rent / Mortgage", "Property Tax", "HOA Fees", "Homeowners / Renters Insurance", "Home Maintenance & Repairs"] },
    { category: "Utilities", items: ["Electricity", "Natural Gas / Heating Oil", "Water & Sewer", "Trash & Recycling", "Internet", "Cell Phone"] },
    { category: "Transportation", items: ["Car Payment", "Fuel", "Auto Insurance", "Maintenance & Repairs", "Public Transit / Parking / Tolls"] },
    { category: "Food", items: ["Groceries", "Dining Out"] },
    { category: "Insurance & Healthcare", items: ["Health Insurance Premium", "Life Insurance", "Medical / Dental Out-of-Pocket", "Prescriptions"] },
    { category: "Debt Payments", items: ["Credit Cards", "Student Loans", "Personal Loans"] },
    { category: "Personal & Family", items: ["Childcare / Tuition", "Subscriptions & Memberships", "Entertainment", "Clothing", "Pet Care"] },
    { category: "Taxes", items: ["Sales Tax"] },
    { category: "Miscellaneous", items: ["Miscellaneous / Buffer"] }
  ];

  // Savings gets its own tab (not folded into Expenses) so "money you keep"
  // is never confused with "money you spend."
  var DEFAULT_SAVINGS_TEMPLATE = [
    { category: "Savings", items: ["Emergency Fund", "Retirement / 401K/TSP Contributions", "Vacation / Big Purchase Fund", "Other Savings"] }
  ];

  // ---------- generic helpers ----------

  function fmt(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
  }

  function fmtShort(n) {
    var v = Number(n) || 0;
    var abs = Math.abs(v);
    if (abs >= 1000000) return (v / 1000000).toFixed(1) + "M";
    if (abs >= 1000) return (v / 1000).toFixed(0) + "k";
    return Math.round(v).toString();
  }

  function pctStr(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return v.toFixed(1) + "%";
  }

  // Canvas drawing can't use CSS var() directly - fillStyle/strokeStyle
  // need a resolved color string. This reads the current theme's actual
  // value for a given custom property, so charts redraw correctly in both
  // light and dark mode instead of hardcoding light-mode colors.
  function themeColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  function setSaveStatus(text) {
    var el = document.getElementById("save-status");
    if (el) el.textContent = text;
  }

  function scheduleSave() {
    setSaveStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state)
      }).then(function (r) {
        if (!r.ok) throw new Error("bad status");
        setSaveStatus("All changes saved");
      }).catch(function () {
        setSaveStatus("Save failed — check that the server is running");
      });
    }, 500);
  }

  function nextId() {
    if (!state.nextId) state.nextId = 1;
    return state.nextId++;
  }

  function buildCurrencyInput(value, onChange) {
    var wrap = document.createElement("div");
    wrap.className = "input-prefix";
    var prefix = document.createElement("span");
    prefix.textContent = "$";
    var input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.01";
    input.placeholder = "0.00";
    input.value = value || "";
    input.addEventListener("input", function () {
      onChange(parseFloat(input.value) || 0);
    });
    wrap.appendChild(prefix);
    wrap.appendChild(input);
    return wrap;
  }

  function setDiffSpan(span, diff) {
    span.textContent = fmt(diff);
    span.classList.remove("positive", "negative");
    span.classList.add(diff >= 0 ? "positive" : "negative");
  }

  // Every expense/savings item can accumulate a log of receipt lines that
  // were added into it (see the receipt modal below) - lazily initialized
  // since most items never get one and old saves won't have it.
  function ensureReceiptLog(item) {
    if (!item.receiptLog) item.receiptLog = [];
    return item.receiptLog;
  }

  // Self-heals a category shell (e.g. "Taxes") into a categories array if
  // it's missing - used so a category added to the template after someone
  // already has months saved still shows up for them, the same way the
  // Savings tab backfill works.
  function ensureCategoryExists(categoriesArray, categoryName, starterItemNames) {
    var exists = categoriesArray.some(function (c) { return c.category === categoryName; });
    if (!exists) {
      categoriesArray.push({
        category: categoryName,
        items: (starterItemNames || []).map(function (name) {
          return { id: nextId(), name: name, budgeted: 0, actual: 0, recurring: false, receiptLog: [] };
        })
      });
    }
  }

  // ---------- month helpers ----------

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function monthKeyFromDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
  }

  function todayMonthKey() {
    return monthKeyFromDate(new Date());
  }

  function addMonths(key, delta) {
    var parts = key.split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var d = new Date(y, (m - 1) + delta, 1);
    return monthKeyFromDate(d);
  }

  function monthLabel(key) {
    var parts = key.split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var d = new Date(y, m - 1, 1);
    return d.toLocaleString("default", { month: "long", year: "numeric" });
  }

  function monthShortLabel(key) {
    var parts = key.split("-");
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var d = new Date(y, m - 1, 1);
    return d.toLocaleString("default", { month: "short" }) + " '" + String(y).slice(-2);
  }

  function findNearestPriorMonthKey(key) {
    var keys = Object.keys(state.months).filter(function (k) { return k < key; }).sort();
    return keys.length ? keys[keys.length - 1] : null;
  }

  function buildDefaultCategories() {
    return DEFAULT_CATEGORY_TEMPLATE.map(function (cat) {
      return {
        category: cat.category,
        items: cat.items.map(function (name) {
          return { id: nextId(), name: name, budgeted: 0, actual: 0, recurring: false, receiptLog: [] };
        })
      };
    });
  }

  // Savings items are a running balance, not a budget-vs-actual line: each
  // one tracks currentBalance (what's in the account today), plannedThisMonth
  // (what you intend to add - counts against your leftover the same way an
  // expense does), and actualSaved (what you actually added, incremented by
  // receipt lines or edited by hand). Projected New Balance (plan-based) and
  // Carryover Balance (actual-based) are always computed, never stored.
  function buildDefaultSavings() {
    return DEFAULT_SAVINGS_TEMPLATE.map(function (cat) {
      return {
        category: cat.category,
        items: cat.items.map(function (name) {
          return { id: nextId(), name: name, currentBalance: 0, plannedThisMonth: 0, actualSaved: 0, recurring: false, receiptLog: [] };
        })
      };
    });
  }

  // Old saves used the same budgeted/actual/frequency shape as Expenses -
  // migrate those fields into currentBalance/plannedThisMonth the first
  // time we touch an item saved under the old schema, so existing data
  // keeps working. Also backfills actualSaved/receiptLog for saves from
  // before those existed.
  function migrateSavingsItem(item) {
    if (item.currentBalance === undefined) item.currentBalance = Number(item.actual) || 0;
    if (item.plannedThisMonth === undefined) item.plannedThisMonth = Number(item.budgeted) || 0;
    if (item.actualSaved === undefined) item.actualSaved = 0;
    ensureReceiptLog(item);
    delete item.actual;
    delete item.budgeted;
    delete item.frequency;
    return item;
  }

  function migrateSavingsSchema(savingsArray) {
    savingsArray.forEach(function (cat) { cat.items.forEach(migrateSavingsItem); });
  }

  // Expense items used to carry a Monthly/Annual frequency selector. That
  // field has been removed - budgeted is always a monthly figure now. Any
  // item still saved with frequency: "annual" has its budgeted value
  // divided by 12 once, here, so the monthly-equivalent amount it was
  // already showing keeps showing after the field is dropped.
  function migrateExpenseItem(item) {
    if (item.frequency === "annual") {
      item.budgeted = (Number(item.budgeted) || 0) / 12;
    }
    delete item.frequency;
    ensureReceiptLog(item);
    return item;
  }

  function migrateExpensesSchema(expensesArray) {
    expensesArray.forEach(function (cat) { cat.items.forEach(migrateExpenseItem); });
  }

  // Backfills receiptLog for pay periods saved before it existed, same as
  // migrateExpenseItem/migrateSavingsItem do for their items.
  function migrateIncomeSchema(income) {
    income.payPeriods.forEach(ensureReceiptLog);
  }

  // The two starter paychecks are recurring by default, since getting paid
  // regularly is the normal expectation — star/unstar per pay period from there.
  function buildDefaultPayPeriods() {
    return [
      { id: nextId(), label: "Paycheck 1", gross: 0, net: 0, recurring: true, receiptLog: [] },
      { id: nextId(), label: "Paycheck 2", gross: 0, net: 0, recurring: true, receiptLog: [] }
    ];
  }

  // Only items starred as recurring carry forward into a newly-created month.
  // Un-starred items were one-off for the month they were entered in and stay
  // there. The category shells (Housing, Utilities, etc.) always carry
  // forward so there's still somewhere to add new items. The star itself is
  // a one-time "carry this over" decision, not a lasting setting - the new
  // copy always starts unstarred, so the user makes a fresh call each month
  // on what continues from there instead of it silently cascading forever.
  function cloneCategories(categories) {
    return categories.map(function (cat) {
      return {
        category: cat.category,
        items: cat.items.filter(function (it) { return !!it.recurring; }).map(function (it) {
          return { id: nextId(), name: it.name, budgeted: it.budgeted, actual: 0, recurring: false, receiptLog: [] };
        })
      };
    });
  }

  // Gross and Net both carry forward as-is when a pay period is starred -
  // same paycheck amount happens again next month for both. The receipt
  // log itself still resets to empty (last month's individual deposit
  // lines don't apply to a month that hasn't happened yet), but the Net
  // total they added up to does carry over, same as Gross. Same
  // one-time-carry rule as expenses: the star is a decision made in the
  // source month, so the new copy always starts unstarred rather than
  // cascading forever.
  function clonePayPeriods(payPeriods) {
    return payPeriods.filter(function (pp) { return !!pp.recurring; }).map(function (pp) {
      return { id: nextId(), label: pp.label, gross: pp.gross, net: pp.net, recurring: false, receiptLog: [] };
    });
  }

  // Savings carry forward differently from expenses/income: the new
  // month's Current Balance is the prior month's CARRYOVER balance
  // (current + actually saved) - the real, reconciled figure, not just
  // the plan - while plannedThisMonth carries the same target amount
  // forward (editable, same as a recurring bill). actualSaved and the
  // receipt log both reset since they belong to this new month's activity.
  // Once this new month is created, this snapshot is independent - later
  // edits to the prior month never retroactively change it. Same
  // one-time-carry rule as expenses/income: starts unstarred.
  function cloneSavingsCategories(categories) {
    return categories.map(function (cat) {
      return {
        category: cat.category,
        items: cat.items.filter(function (it) { return !!it.recurring; }).map(function (it) {
          return {
            id: nextId(),
            name: it.name,
            currentBalance: (Number(it.currentBalance) || 0) + (Number(it.actualSaved) || 0),
            plannedThisMonth: it.plannedThisMonth,
            actualSaved: 0,
            recurring: false,
            receiptLog: []
          };
        })
      };
    });
  }

  // Tops up a month with recurring items/pay periods that exist in the
  // nearest prior month but are missing here — matched by name (pay period
  // label / expense item name within the same category). This runs every
  // time a month is opened, not just when it's first created, so starring
  // something in July still reaches August even if August was already
  // opened (and therefore already saved) before the star was clicked.
  // It only ever ADDS missing entries; it never overwrites or re-adds
  // something you've already customized or deleted in this specific month.
  function syncRecurringIntoMonth(month, key) {
    var sourceKey = findNearestPriorMonthKey(key);
    if (!sourceKey) return;
    var source = state.months[sourceKey];

    migrateExpensesSchema(source.expenses);
    migrateExpensesSchema(month.expenses);

    source.income.payPeriods.forEach(function (srcPP) {
      if (!srcPP.recurring) return;
      var exists = month.income.payPeriods.some(function (pp) { return pp.label === srcPP.label; });
      if (!exists) {
        // Starts unstarred here too, same as expense items - carrying over
        // is a one-time decision made in the source month, not a setting
        // that keeps reproducing itself month after month.
        month.income.payPeriods.push({ id: nextId(), label: srcPP.label, gross: srcPP.gross, net: srcPP.net, recurring: false, receiptLog: [] });
      }
    });

    source.expenses.forEach(function (srcCat) {
      var cat = month.expenses.filter(function (c) { return c.category === srcCat.category; })[0];
      if (!cat) return;
      srcCat.items.forEach(function (srcItem) {
        if (!srcItem.recurring) return;
        var exists = cat.items.some(function (it) { return it.name === srcItem.name; });
        if (!exists) {
          // Starts unstarred here too, same as cloneCategories - carrying
          // over is a one-time decision made in the source month, not a
          // setting that keeps reproducing itself month after month.
          cat.items.push({ id: nextId(), name: srcItem.name, budgeted: srcItem.budgeted, actual: 0, recurring: false, receiptLog: [] });
        }
      });
    });

    if (month.savings && source.savings) {
      migrateSavingsSchema(source.savings);
      migrateSavingsSchema(month.savings);
      source.savings.forEach(function (srcCat) {
        var cat = month.savings.filter(function (c) { return c.category === srcCat.category; })[0];
        if (!cat) return;
        srcCat.items.forEach(function (srcItem) {
          if (!srcItem.recurring) return;
          var exists = cat.items.some(function (it) { return it.name === srcItem.name; });
          if (!exists) {
            // Starts unstarred here too, same as expense items.
            cat.items.push({
              id: nextId(),
              name: srcItem.name,
              currentBalance: (Number(srcItem.currentBalance) || 0) + (Number(srcItem.actualSaved) || 0),
              plannedThisMonth: srcItem.plannedThisMonth,
              actualSaved: 0,
              recurring: false,
              receiptLog: []
            });
          }
        });
      });
    }
  }

  // Edits to a recurring (starred) expense item's budgeted amount live-sync
  // one month forward, since that number is meant to represent the same
  // planned bill going forward, not a snapshot that's now wrong in the
  // month you just corrected it in. Only propagates if the next month
  // already exists (nothing to touch if it hasn't been created yet - it'll
  // just clone/top up with the current value whenever it is) and only one
  // hop forward, never backward, and never further than one month - each
  // month's own star decision governs whether it keeps going from there.
  function propagateBudgetedForward(catName, itemName, budgeted) {
    var nextKey = addMonths(state.activeMonth, 1);
    var nextMonth = state.months[nextKey];
    if (!nextMonth) return;
    var cat = nextMonth.expenses.filter(function (c) { return c.category === catName; })[0];
    if (!cat) return;
    var item = cat.items.filter(function (it) { return it.name === itemName; })[0];
    if (!item) return;
    item.budgeted = budgeted;
  }

  // Same one-hop, forward-only live-sync as propagateBudgetedForward, but
  // for a recurring (starred) pay period's Gross - matched by label within
  // next month's pay periods.
  function propagateGrossForward(ppLabel, gross) {
    var nextKey = addMonths(state.activeMonth, 1);
    var nextMonth = state.months[nextKey];
    if (!nextMonth) return;
    var pp = nextMonth.income.payPeriods.filter(function (p) { return p.label === ppLabel; })[0];
    if (!pp) return;
    pp.gross = gross;
  }

  // Same one-hop, forward-only live-sync as propagateGrossForward, but for
  // a recurring (starred) pay period's Net - matched by label within next
  // month's pay periods. Net now carries forward the same way Gross does
  // (same paycheck amount happens again next month) rather than resetting
  // to 0, per the same one-time-carry star rule as everything else: only
  // while this pay period stays starred, and only one month forward.
  function propagateNetForward(ppLabel, net) {
    var nextKey = addMonths(state.activeMonth, 1);
    var nextMonth = state.months[nextKey];
    if (!nextMonth) return;
    var pp = nextMonth.income.payPeriods.filter(function (p) { return p.label === ppLabel; })[0];
    if (!pp) return;
    pp.net = net;
  }

  // Same one-hop, forward-only live-sync as propagateBudgetedForward, but
  // for a recurring (starred) savings item's Planned This Month - matched
  // by category + name within next month's savings.
  function propagatePlannedForward(catName, itemName, planned) {
    var nextKey = addMonths(state.activeMonth, 1);
    var nextMonth = state.months[nextKey];
    if (!nextMonth || !nextMonth.savings) return;
    var cat = nextMonth.savings.filter(function (c) { return c.category === catName; })[0];
    if (!cat) return;
    var item = cat.items.filter(function (it) { return it.name === itemName; })[0];
    if (!item) return;
    item.plannedThisMonth = planned;
  }

  // Same one-hop, forward-only live-sync as the others above, but this one
  // feeds a recurring (starred) savings item's Carryover Balance (Current
  // Balance + Actual Saved) into next month's CURRENT BALANCE - matched by
  // category + name. This is what makes starring a savings item actually
  // mean "roll the real, reconciled balance forward": cloneSavingsCategories
  // / syncRecurringIntoMonth already do this math once, at the moment next
  // month is first created, but if next month already exists (you've
  // already opened it, or another starred item created it first) any
  // further edits here to Current Balance or Actual Saved - or starring the
  // item in the first place - need this to keep next month's Current
  // Balance in sync, the same way propagateBudgetedForward/GrossForward do
  // for their fields.
  function propagateCarryoverForward(catName, itemName, carryover) {
    var nextKey = addMonths(state.activeMonth, 1);
    var nextMonth = state.months[nextKey];
    if (!nextMonth || !nextMonth.savings) return;
    var cat = nextMonth.savings.filter(function (c) { return c.category === catName; })[0];
    if (!cat) return;
    var item = cat.items.filter(function (it) { return it.name === itemName; })[0];
    if (!item) return;
    item.currentBalance = carryover;
  }

  function ensureMonth(key) {
    var month = state.months[key];
    if (month) {
      if (!month.savings) month.savings = buildDefaultSavings(); // back-fill for months saved before Savings existed
      migrateSavingsSchema(month.savings);
      ensureCategoryExists(month.expenses, "Taxes", ["Sales Tax"]); // back-fill for months saved before Taxes existed
      migrateExpensesSchema(month.expenses); // back-fill for months saved before Frequency was removed
      migrateIncomeSchema(month.income); // back-fill for months saved before pay periods had a receipt log
      syncRecurringIntoMonth(month, key);
      return month;
    }

    var sourceKey = findNearestPriorMonthKey(key);
    if (sourceKey) {
      var source = state.months[sourceKey];
      if (!source.savings) source.savings = buildDefaultSavings();
      migrateSavingsSchema(source.savings);
      ensureCategoryExists(source.expenses, "Taxes", ["Sales Tax"]);
      migrateExpensesSchema(source.expenses);
      migrateIncomeSchema(source.income);
      month = {
        income: { payPeriods: clonePayPeriods(source.income.payPeriods) },
        expenses: cloneCategories(source.expenses),
        savings: cloneSavingsCategories(source.savings)
      };
      monthOrigin[key] = sourceKey;
    } else {
      month = {
        income: { payPeriods: buildDefaultPayPeriods() },
        expenses: buildDefaultCategories(),
        savings: buildDefaultSavings()
      };
      monthOrigin[key] = null;
    }
    state.months[key] = month;
    return month;
  }

  function getActiveMonth() {
    return ensureMonth(state.activeMonth);
  }

  // ---------- month bar ----------

  function initMonthBar() {
    document.getElementById("month-prev").addEventListener("click", function () {
      setActiveMonth(addMonths(state.activeMonth, -1));
    });
    document.getElementById("month-next").addEventListener("click", function () {
      setActiveMonth(addMonths(state.activeMonth, 1));
    });
    document.getElementById("month-today").addEventListener("click", function () {
      setActiveMonth(todayMonthKey());
    });
    document.getElementById("month-input").addEventListener("change", function (e) {
      if (e.target.value) setActiveMonth(e.target.value);
    });
  }

  function renderMonthBar() {
    document.getElementById("month-input").value = state.activeMonth;
    var hintEl = document.getElementById("month-copy-hint");
    if (Object.prototype.hasOwnProperty.call(monthOrigin, state.activeMonth)) {
      var src = monthOrigin[state.activeMonth];
      hintEl.textContent = src ? ("Started from " + monthLabel(src) + " — edit anything") : "New month — starting blank";
    } else {
      hintEl.textContent = "";
    }
  }

  function setActiveMonth(key) {
    state.activeMonth = key;
    ensureMonth(key);
    renderMonthBar();
    renderIncomeStructure();
    renderExpensesStructure();
    renderSavingsStructure();
    renderDashboard();
    renderTrends();
    scheduleSave();
  }

  // ---------- tabs ----------

  function initTabs() {
    var buttons = document.querySelectorAll(".tab-btn");
    var monthBar = document.getElementById("month-bar");
    var MONTH_TABS = ["dashboard", "income", "expenses", "savings"];
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        buttons.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("active"); });
        var target = document.getElementById("panel-" + btn.dataset.tab);
        if (target) target.classList.add("active");

        if (MONTH_TABS.indexOf(btn.dataset.tab) > -1) {
          monthBar.classList.remove("hidden");
        } else {
          monthBar.classList.add("hidden");
        }

        if (!state) return;
        // Savings items are shown (and editable) both here and in the
        // Expenses tab's linked "Savings" category, since they're the same
        // underlying data. Re-rendering whichever tab you switch TO keeps
        // it showing the latest values without having to thread a manual
        // sync call through every single field on both tabs.
        switch (btn.dataset.tab) {
          case "dashboard": renderDashboard(); break;
          case "income": renderIncomeStructure(); break;
          case "expenses": renderExpensesStructure(); break;
          case "savings": renderSavingsStructure(); break;
          case "trends": renderTrends(); break;
          case "accounts": renderAccountsStructure(); break;
        }
      });
    });
  }

  // ---------- income ----------

  function computeIncomeTotals(month) {
    var gross = 0, net = 0;
    month.income.payPeriods.forEach(function (pp) {
      gross += Number(pp.gross) || 0;
      net += Number(pp.net) || 0;
    });
    return { gross: gross, net: net };
  }

  function renderIncomeStructure() {
    var month = getActiveMonth();
    var container = document.getElementById("pay-periods-list");
    container.innerHTML = "";

    var labels = document.createElement("div");
    labels.className = "pay-period-labels";
    labels.innerHTML = "<span></span><span>Label</span><span>Gross</span><span>Net</span><span></span><span></span>";
    container.appendChild(labels);

    month.income.payPeriods.forEach(function (pp) {
      container.appendChild(buildPayPeriodRow(pp, month));
    });

    updateIncomeTotalsDOM();
  }

  function buildPayPeriodRow(pp, month) {
    var wrap = document.createElement("div");
    wrap.className = "item-wrap";

    var row = document.createElement("div");
    row.className = "pay-period-row";
    row.dataset.ppId = pp.id;

    // Sub-items: individual logged deposits feeding this pay period's Net,
    // same expand/collapse pattern as an expense item's receipt lines.
    // Statement Import adds lines here; each one only ever touches Net,
    // never Gross (Gross stays a hand-entered planned figure). If this pay
    // period is starred, the resulting Net total also carries forward the
    // same as an edit made by hand would.
    var receiptUI = attachReceiptLogUI(pp, "net", function () {
      if (pp.recurring) propagateNetForward(pp.label, pp.net);
      updateIncomeTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = pp.label;
    labelInput.addEventListener("input", function () {
      pp.label = labelInput.value;
      scheduleSave();
    });

    var grossWrap = buildCurrencyInput(pp.gross, function (val) {
      pp.gross = val;
      if (pp.recurring) propagateGrossForward(pp.label, val);
      updateIncomeTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var netWrap = buildCurrencyInput(pp.net, function (val) {
      pp.net = val;
      if (pp.recurring) propagateNetForward(pp.label, val);
      updateIncomeTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "star-btn" + (pp.recurring ? " starred" : "");
    starBtn.innerHTML = "&#9733;";
    starBtn.title = pp.recurring
      ? "Recurring — Gross and Net both carry into next month. Click to make one-off."
      : "One-off — click to make recurring (Gross and Net both carry into next month)";
    starBtn.addEventListener("click", function () {
      pp.recurring = !pp.recurring;
      starBtn.classList.toggle("starred", pp.recurring);
      starBtn.title = pp.recurring
        ? "Recurring — Gross and Net both carry into next month. Click to make one-off."
        : "One-off — click to make recurring (Gross and Net both carry into next month)";
      if (pp.recurring) {
        propagateGrossForward(pp.label, pp.gross);
        propagateNetForward(pp.label, pp.net);
      }
      scheduleSave();
    });

    var removeBtn = document.createElement("button");
    removeBtn.className = "remove-item-btn";
    removeBtn.type = "button";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove pay period";
    removeBtn.addEventListener("click", function () {
      var idx = month.income.payPeriods.indexOf(pp);
      if (idx > -1) month.income.payPeriods.splice(idx, 1);
      renderIncomeStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    row.appendChild(receiptUI.expandBtn);
    row.appendChild(labelInput);
    row.appendChild(grossWrap);
    row.appendChild(netWrap);
    row.appendChild(starBtn);
    row.appendChild(removeBtn);

    wrap.appendChild(row);
    wrap.appendChild(receiptUI.panel);

    installReceiptDropZone(wrap, pp, "net", function () {
      renderIncomeStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    return wrap;
  }

  function updateIncomeTotalsDOM() {
    var month = getActiveMonth();
    var totals = computeIncomeTotals(month);
    document.getElementById("derived-gross-total").textContent = fmt(totals.gross);
    document.getElementById("derived-net-total").textContent = fmt(totals.net);
    var deductionRate = totals.gross > 0 ? ((totals.gross - totals.net) / totals.gross) * 100 : 0;
    if (deductionRate < 0) deductionRate = 0;
    document.getElementById("derived-deduction-rate").textContent = pctStr(deductionRate);
  }

  function initIncomeAddButton() {
    document.getElementById("add-pay-period-btn").addEventListener("click", function () {
      var month = getActiveMonth();
      var n = month.income.payPeriods.length + 1;
      month.income.payPeriods.push({ id: nextId(), label: "Paycheck " + n, gross: 0, net: 0, recurring: false, receiptLog: [] });
      renderIncomeStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });
  }

  // ---------- expenses ----------

  var EXPENSES_CFG = { containerId: "expense-categories", budgetedId: "expenses-grand-budgeted", actualId: "expenses-grand-actual", diffId: "expenses-grand-diff" };

  function categoryBudgeted(cat) {
    return cat.items.reduce(function (s, it) { return s + (Number(it.budgeted) || 0); }, 0);
  }

  function categoryActual(cat) {
    return cat.items.reduce(function (s, it) { return s + (Number(it.actual) || 0); }, 0);
  }

  function monthExpenseTotals(month) {
    var budgeted = 0, actual = 0;
    month.expenses.forEach(function (cat) {
      budgeted += categoryBudgeted(cat);
      actual += categoryActual(cat);
    });
    return { budgeted: budgeted, actual: actual, diff: budgeted - actual };
  }

  // The Expenses tab shows two kinds of category blocks: your regular
  // spending categories, and (appended after them) a mirror of the
  // Savings tab's category, rendered from the exact same items so a
  // deposit or plan change made from either tab shows up in both -
  // there's no separate copy to keep in sync.
  function renderExpensesStructure() {
    var month = getActiveMonth();
    var container = document.getElementById(EXPENSES_CFG.containerId);
    container.innerHTML = "";

    month.expenses.forEach(function (cat, catIndex) {
      container.appendChild(buildExpenseCategoryCard(cat, catIndex));
    });

    month.savings.forEach(function (cat, catIndex) {
      container.appendChild(buildLinkedSavingsCategoryCard(cat, catIndex));
    });

    updateExpenseTotalsDOM();
    updateLinkedSavingsBlockDOM();
  }

  // Remembers which categories are collapsed across re-renders within this
  // session (not persisted - purely a UI convenience, resets on reload).
  var collapsedExpenseCategories = {};

  function buildExpenseCategoryCard(cat, catIndex) {
    var catDiv = document.createElement("div");
    catDiv.className = "expense-category";
    catDiv.dataset.catIndex = catIndex;

    var isCollapsed = !!collapsedExpenseCategories[cat.category];

    var header = document.createElement("div");
    header.className = "expense-category-header";

    var titleWrap = document.createElement("div");
    titleWrap.className = "expense-category-title-wrap";

    var collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "expand-btn" + (isCollapsed ? "" : " open");
    collapseBtn.innerHTML = "&#9656;";
    collapseBtn.title = isCollapsed ? "Expand category" : "Collapse category";

    var titleH3 = document.createElement("h3");
    titleH3.textContent = cat.category;

    titleWrap.appendChild(collapseBtn);
    titleWrap.appendChild(titleH3);

    var totalSpan = document.createElement("span");
    totalSpan.className = "expense-category-total";
    totalSpan.dataset.catBudgeted = catIndex;
    totalSpan.textContent = fmt(categoryBudgeted(cat)) + " budgeted";

    header.appendChild(titleWrap);
    header.appendChild(totalSpan);

    var removeCategoryBtn = document.createElement("button");
    removeCategoryBtn.type = "button";
    removeCategoryBtn.className = "remove-category-btn";
    removeCategoryBtn.textContent = "Remove Category";
    removeCategoryBtn.title = "Delete this entire category and its items";
    removeCategoryBtn.addEventListener("click", function () {
      var ok = confirm('Delete the "' + cat.category + '" category and all ' + cat.items.length + ' item(s) in it? This can\'t be undone.');
      if (!ok) return;
      var month = getActiveMonth();
      var idx = month.expenses.indexOf(cat);
      if (idx > -1) month.expenses.splice(idx, 1);
      renderExpensesStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });
    header.appendChild(removeCategoryBtn);

    catDiv.appendChild(header);

    var itemsDiv = document.createElement("div");
    itemsDiv.className = "expense-items";
    itemsDiv.hidden = isCollapsed;

    function toggleCollapse() {
      var nowCollapsed = !collapsedExpenseCategories[cat.category];
      collapsedExpenseCategories[cat.category] = nowCollapsed;
      collapseBtn.classList.toggle("open", !nowCollapsed);
      collapseBtn.title = nowCollapsed ? "Expand category" : "Collapse category";
      itemsDiv.hidden = nowCollapsed;
    }
    collapseBtn.addEventListener("click", toggleCollapse);
    titleH3.addEventListener("click", toggleCollapse);

    var labels = document.createElement("div");
    labels.className = "expense-items-labels";
    labels.innerHTML = "<span></span><span></span><span>Item</span><span>Budgeted</span><span>Actual</span><span>Difference</span><span></span><span></span>";
    itemsDiv.appendChild(labels);

    cat.items.forEach(function (item) {
      itemsDiv.appendChild(buildExpenseItemRow(item, cat));
    });

    var addBtn = document.createElement("button");
    addBtn.className = "add-item-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add Item";
    addBtn.addEventListener("click", function () {
      cat.items.push({ id: nextId(), name: "New Item", budgeted: 0, actual: 0, recurring: false, receiptLog: [] });
      renderExpensesStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    itemsDiv.appendChild(addBtn);
    catDiv.appendChild(itemsDiv);
    return catDiv;
  }

  function buildReceiptAddButton(kind, categoryName, itemId, title) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "receipt-add-btn";
    btn.innerHTML = "&#43;";
    btn.title = title || "Log a receipt line for this item";
    btn.addEventListener("click", function () {
      openReceiptModal({ kind: kind, categoryName: categoryName, itemId: itemId });
    });
    return btn;
  }

  // Remembers which items are expanded across re-renders within this
  // session (not persisted - purely a UI convenience, resets on reload).
  var expandedItemIds = {};

  // ---------- drag-and-drop: moving a receipt sub-item to a different item ----------
  // Lets a misfiled sub-item (logged under the wrong item/category) be
  // dragged from its receipt log straight onto the item it actually
  // belongs to - on Expenses, Savings, or Income alike, all built on the
  // same generic {item, actualFieldName, receiptLog} shape. Only one drag
  // can be in flight at a time, tracked here rather than via
  // dataTransfer's payload (simpler, and this is same-page-only anyway).
  var receiptDragPayload = null;

  function moveReceiptEntry(payload, destItem, destFieldName) {
    var srcItem = payload.item, srcField = payload.actualFieldName, entry = payload.entry;
    if (destItem === srcItem) return;
    var idx = srcItem.receiptLog.indexOf(entry);
    if (idx === -1) return;
    srcItem.receiptLog.splice(idx, 1);
    srcItem[srcField] = Math.max(0, (Number(srcItem[srcField]) || 0) - entry.amount);
    ensureReceiptLog(destItem);
    destItem.receiptLog.push(entry);
    destItem[destFieldName] = (Number(destItem[destFieldName]) || 0) + entry.amount;
  }

  // Wires up `dropEl` (an item's whole row block) as a place a dragged
  // sub-item can be released onto. `afterMove` should fully re-render
  // whatever tab(s) this item lives on, so both the item that lost the
  // line and the item that gained it redraw correctly - simpler and more
  // reliable than trying to patch two separate already-built panels.
  function installReceiptDropZone(dropEl, item, actualFieldName, afterMove) {
    dropEl.addEventListener("dragover", function (e) {
      if (!receiptDragPayload || receiptDragPayload.item === item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      dropEl.classList.add("drop-target-hover");
    });
    dropEl.addEventListener("dragleave", function () {
      dropEl.classList.remove("drop-target-hover");
    });
    dropEl.addEventListener("drop", function (e) {
      dropEl.classList.remove("drop-target-hover");
      if (!receiptDragPayload || receiptDragPayload.item === item) return;
      e.preventDefault();
      moveReceiptEntry(receiptDragPayload, item, actualFieldName);
      receiptDragPayload = null;
      afterMove();
    });
  }

  // Builds the expand/collapse toggle plus the sub-panel listing every
  // receipt line feeding an item's Actual (or Actual Saved). Each line can
  // be edited or deleted in place; both adjust actualFieldName on item by
  // the right delta so it stays consistent with the log. onChange() is
  // called after any edit/delete so the caller can do its own lightweight
  // total refresh without losing focus elsewhere on the page.
  function attachReceiptLogUI(item, actualFieldName, onChange) {
    ensureReceiptLog(item);

    var expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.innerHTML = "&#9656;";

    var panel = document.createElement("div");
    panel.className = "receipt-log-panel";
    panel.hidden = !expandedItemIds[item.id];

    function refreshToggleState() {
      var hasLines = item.receiptLog.length > 0;
      expandBtn.disabled = !hasLines;
      expandBtn.className = "expand-btn" + (hasLines ? "" : " empty") + (expandedItemIds[item.id] ? " open" : "");
      expandBtn.title = hasLines
        ? "Show receipt lines (" + item.receiptLog.length + ")"
        : "No receipt lines yet";
      if (!hasLines) {
        expandedItemIds[item.id] = false;
        panel.hidden = true;
      }
    }

    function buildLogEntryRow(entry) {
      var row = document.createElement("div");
      row.className = "receipt-log-row";
      row.draggable = true;
      row.title = "Drag to move this line to a different item";
      row.addEventListener("dragstart", function (e) {
        receiptDragPayload = { item: item, actualFieldName: actualFieldName, entry: entry };
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(entry.id)); } catch (err) { /* Safari needs this set but ignores the value */ }
      });
      row.addEventListener("dragend", function () {
        row.classList.remove("dragging");
        receiptDragPayload = null;
      });

      function renderStatic() {
        row.innerHTML = "";
        row.classList.remove("editing");

        var dateSpan = document.createElement("span");
        dateSpan.className = "receipt-log-date";
        dateSpan.textContent = new Date(entry.date).toLocaleDateString();

        var descSpan = document.createElement("span");
        descSpan.className = "receipt-log-desc";
        descSpan.textContent = entry.description;

        var amountSpan = document.createElement("span");
        amountSpan.className = "receipt-log-amount";
        amountSpan.textContent = fmt(entry.amount);

        var editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "receipt-log-edit-btn";
        editBtn.innerHTML = "&#9998;";
        editBtn.title = "Edit this line";
        editBtn.addEventListener("click", renderEditing);

        var deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "remove-item-btn";
        deleteBtn.innerHTML = "&times;";
        deleteBtn.title = "Delete this line";
        deleteBtn.addEventListener("click", function () {
          var idx = item.receiptLog.indexOf(entry);
          if (idx === -1) return;
          item.receiptLog.splice(idx, 1);
          item[actualFieldName] = Math.max(0, (Number(item[actualFieldName]) || 0) - entry.amount);
          renderPanel();
          refreshToggleState();
          onChange();
        });

        row.appendChild(dateSpan);
        row.appendChild(descSpan);
        row.appendChild(amountSpan);
        row.appendChild(editBtn);
        row.appendChild(deleteBtn);
      }

      function renderEditing() {
        row.innerHTML = "";
        row.classList.add("editing");

        var descInput = document.createElement("input");
        descInput.type = "text";
        descInput.value = entry.description;

        var amountInput = document.createElement("input");
        amountInput.type = "number";
        amountInput.min = "0";
        amountInput.step = "0.01";
        amountInput.value = entry.amount;
        amountInput.className = "receipt-log-edit-amount";

        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "receipt-log-save-btn";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", function () {
          var newAmount = parseFloat(amountInput.value) || 0;
          var delta = newAmount - entry.amount;
          entry.description = descInput.value.trim() || entry.description;
          entry.amount = newAmount;
          item[actualFieldName] = Math.max(0, (Number(item[actualFieldName]) || 0) + delta);
          renderStatic();
          onChange();
        });

        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "receipt-log-cancel-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", renderStatic);

        row.appendChild(descInput);
        row.appendChild(amountInput);
        row.appendChild(saveBtn);
        row.appendChild(cancelBtn);
      }

      renderStatic();
      return row;
    }

    function renderPanel() {
      panel.innerHTML = "";
      if (!item.receiptLog.length) {
        panel.innerHTML = '<p class="empty-row">No receipt lines yet.</p>';
        return;
      }
      item.receiptLog.forEach(function (entry) {
        panel.appendChild(buildLogEntryRow(entry));
      });
    }

    expandBtn.addEventListener("click", function () {
      if (expandBtn.disabled) return;
      expandedItemIds[item.id] = !expandedItemIds[item.id];
      expandBtn.classList.toggle("open", expandedItemIds[item.id]);
      panel.hidden = !expandedItemIds[item.id];
    });

    refreshToggleState();
    renderPanel();

    return { expandBtn: expandBtn, panel: panel };
  }

  function buildExpenseItemRow(item, cat) {
    var wrap = document.createElement("div");
    wrap.className = "item-wrap";

    var row = document.createElement("div");
    row.className = "expense-item-row";
    row.dataset.itemId = item.id;

    var receiptUI = attachReceiptLogUI(item, "actual", function () {
      updateExpenseTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var receiptBtn = buildReceiptAddButton("expenses", cat.category, item.id, "Log a receipt line for this item");

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name;
    nameInput.addEventListener("input", function () {
      item.name = nameInput.value;
      scheduleSave();
    });

    var budgetedWrap = buildCurrencyInput(item.budgeted, function (val) {
      item.budgeted = val;
      if (item.recurring) propagateBudgetedForward(cat.category, item.name, val);
      updateExpenseTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var actualWrap = buildCurrencyInput(item.actual, function (val) {
      item.actual = val;
      updateExpenseTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var diffSpan = document.createElement("span");
    diffSpan.className = "expense-item-diff";
    diffSpan.dataset.itemDiff = item.id;
    setDiffSpan(diffSpan, (Number(item.budgeted) || 0) - (Number(item.actual) || 0));

    var starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "star-btn" + (item.recurring ? " starred" : "");
    starBtn.innerHTML = "&#9733;";
    starBtn.title = item.recurring
      ? "Recurring — carries into next month. Click to make one-off."
      : "One-off — click to make recurring (carries into next month)";
    starBtn.addEventListener("click", function () {
      item.recurring = !item.recurring;
      starBtn.classList.toggle("starred", item.recurring);
      starBtn.title = item.recurring
        ? "Recurring — carries into next month. Click to make one-off."
        : "One-off — click to make recurring (carries into next month)";
      // Push the current budgeted amount into next month right away if it
      // already exists (rather than only on a later budgeted-amount edit) -
      // covers the common case of starring an item that already has a
      // budgeted number, with a same-named placeholder already sitting in
      // next month at $0.
      if (item.recurring) propagateBudgetedForward(cat.category, item.name, item.budgeted);
      scheduleSave();
    });

    var removeBtn = document.createElement("button");
    removeBtn.className = "remove-item-btn";
    removeBtn.type = "button";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove item";
    removeBtn.addEventListener("click", function () {
      var idx = cat.items.indexOf(item);
      if (idx > -1) cat.items.splice(idx, 1);
      renderExpensesStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    row.appendChild(receiptUI.expandBtn);
    row.appendChild(receiptBtn);
    row.appendChild(nameInput);
    row.appendChild(budgetedWrap);
    row.appendChild(actualWrap);
    row.appendChild(diffSpan);
    row.appendChild(starBtn);
    row.appendChild(removeBtn);

    wrap.appendChild(row);
    wrap.appendChild(receiptUI.panel);

    installReceiptDropZone(wrap, item, "actual", function () {
      renderExpensesStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    return wrap;
  }

  function updateExpenseTotalsDOM() {
    var month = getActiveMonth();
    var containerSelector = "#" + EXPENSES_CFG.containerId + " ";

    month.expenses.forEach(function (cat, catIndex) {
      var el = document.querySelector(containerSelector + '[data-cat-budgeted="' + catIndex + '"]');
      if (el) el.textContent = fmt(categoryBudgeted(cat)) + " budgeted";
      cat.items.forEach(function (item) {
        var diffEl = document.querySelector(containerSelector + '[data-item-diff="' + item.id + '"]');
        if (diffEl) setDiffSpan(diffEl, (Number(item.budgeted) || 0) - (Number(item.actual) || 0));
      });
    });

    var totals = monthExpenseTotals(month);
    document.getElementById(EXPENSES_CFG.budgetedId).textContent = fmt(totals.budgeted);
    document.getElementById(EXPENSES_CFG.actualId).textContent = fmt(totals.actual);
    var diffEl = document.getElementById(EXPENSES_CFG.diffId);
    diffEl.textContent = fmt(totals.diff);
    diffEl.classList.remove("positive", "negative");
    diffEl.classList.add(totals.diff >= 0 ? "positive" : "negative");
  }

  // ---------- Savings category, mirrored inside the Expenses tab ----------
  // Same month.savings items as the Savings tab, just displayed with
  // Budgeted/Actual framing (plannedThisMonth / actualSaved) to match the
  // rest of the Expenses tab. Not counted into the Expenses grand totals
  // footer above, since saving isn't spending.

  function buildLinkedSavingsCategoryCard(cat, catIndex) {
    var catDiv = document.createElement("div");
    catDiv.className = "expense-category";
    catDiv.dataset.linkedCatIndex = catIndex;

    var header = document.createElement("div");
    header.className = "expense-category-header";
    header.innerHTML =
      "<h3>" + escapeHtml(cat.category) + ' <span class="linked-badge">synced with Savings tab</span></h3>' +
      '<span class="expense-category-total" data-linked-cat-total="' + catIndex + '">' + fmt(categorySavingsTotals(cat).plannedThisMonth) + " planned</span>";
    catDiv.appendChild(header);

    var itemsDiv = document.createElement("div");
    itemsDiv.className = "expense-items";

    var labels = document.createElement("div");
    labels.className = "expense-items-labels";
    labels.innerHTML = "<span></span><span></span><span>Account</span><span>Budgeted</span><span>Actual</span><span>Difference</span><span></span><span></span>";
    itemsDiv.appendChild(labels);

    cat.items.forEach(function (item) {
      itemsDiv.appendChild(buildLinkedSavingsRow(item, cat));
    });

    var addBtn = document.createElement("button");
    addBtn.className = "add-item-btn";
    addBtn.type = "button";
    addBtn.textContent = "+ Add Savings Account";
    addBtn.addEventListener("click", function () {
      cat.items.push({ id: nextId(), name: "New Savings Goal", currentBalance: 0, plannedThisMonth: 0, actualSaved: 0, recurring: false, receiptLog: [] });
      renderExpensesStructure();
      renderSavingsStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    itemsDiv.appendChild(addBtn);
    catDiv.appendChild(itemsDiv);
    return catDiv;
  }

  function buildLinkedSavingsRow(item, cat) {
    var wrap = document.createElement("div");
    wrap.className = "item-wrap";

    var row = document.createElement("div");
    row.className = "expense-item-row";
    row.dataset.itemId = item.id;

    var receiptUI = attachReceiptLogUI(item, "actualSaved", function () {
      if (item.recurring) propagateCarryoverForward(cat.category, item.name, savingsItemCarryover(item));
      updateLinkedSavingsBlockDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var receiptBtn = buildReceiptAddButton("savings", cat.category, item.id, "Log a deposit/receipt for this savings account");

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name;
    nameInput.addEventListener("input", function () {
      item.name = nameInput.value;
      scheduleSave();
    });

    var plannedWrap = buildCurrencyInput(item.plannedThisMonth, function (val) {
      item.plannedThisMonth = val;
      if (item.recurring) propagatePlannedForward(cat.category, item.name, val);
      updateLinkedSavingsBlockDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var actualSavedWrap = buildCurrencyInput(item.actualSaved, function (val) {
      item.actualSaved = val;
      if (item.recurring) propagateCarryoverForward(cat.category, item.name, savingsItemCarryover(item));
      updateLinkedSavingsBlockDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var diffSpan = document.createElement("span");
    diffSpan.className = "expense-item-diff";
    diffSpan.dataset.linkedItemDiff = item.id;
    setDiffSpan(diffSpan, (Number(item.plannedThisMonth) || 0) - (Number(item.actualSaved) || 0));

    var starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "star-btn" + (item.recurring ? " starred" : "");
    starBtn.innerHTML = "&#9733;";
    starBtn.title = item.recurring
      ? "Recurring — next month's Current Balance rolls forward automatically. Click to make one-off."
      : "One-off — click to make recurring (rolls forward into next month's Current Balance automatically)";
    starBtn.addEventListener("click", function () {
      item.recurring = !item.recurring;
      starBtn.classList.toggle("starred", item.recurring);
      starBtn.title = item.recurring
        ? "Recurring — next month's Current Balance rolls forward automatically. Click to make one-off."
        : "One-off — click to make recurring (rolls forward into next month's Current Balance automatically)";
      if (item.recurring) {
        propagatePlannedForward(cat.category, item.name, item.plannedThisMonth);
        propagateCarryoverForward(cat.category, item.name, savingsItemCarryover(item));
      }
      scheduleSave();
    });

    var removeBtn = document.createElement("button");
    removeBtn.className = "remove-item-btn";
    removeBtn.type = "button";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove savings account";
    removeBtn.addEventListener("click", function () {
      var idx = cat.items.indexOf(item);
      if (idx > -1) cat.items.splice(idx, 1);
      renderExpensesStructure();
      renderSavingsStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    row.appendChild(receiptUI.expandBtn);
    row.appendChild(receiptBtn);
    row.appendChild(nameInput);
    row.appendChild(plannedWrap);
    row.appendChild(actualSavedWrap);
    row.appendChild(diffSpan);
    row.appendChild(starBtn);
    row.appendChild(removeBtn);

    wrap.appendChild(row);
    wrap.appendChild(receiptUI.panel);

    installReceiptDropZone(wrap, item, "actualSaved", function () {
      renderExpensesStructure();
      renderSavingsStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    return wrap;
  }

  function updateLinkedSavingsBlockDOM() {
    var month = getActiveMonth();
    var containerSelector = "#" + EXPENSES_CFG.containerId + " ";

    month.savings.forEach(function (cat, catIndex) {
      var el = document.querySelector(containerSelector + '[data-linked-cat-total="' + catIndex + '"]');
      if (el) el.textContent = fmt(categorySavingsTotals(cat).plannedThisMonth) + " planned";
      cat.items.forEach(function (item) {
        var diffEl = document.querySelector(containerSelector + '[data-linked-item-diff="' + item.id + '"]');
        if (diffEl) setDiffSpan(diffEl, (Number(item.plannedThisMonth) || 0) - (Number(item.actualSaved) || 0));
      });
    });
  }

  // ---------- savings (a running balance, not a budget-vs-actual line) ----------

  function savingsItemProjected(item) {
    return (Number(item.currentBalance) || 0) + (Number(item.plannedThisMonth) || 0);
  }

  function savingsItemCarryover(item) {
    return (Number(item.currentBalance) || 0) + (Number(item.actualSaved) || 0);
  }

  function categorySavingsTotals(cat) {
    var currentBalance = 0, plannedThisMonth = 0, actualSaved = 0;
    cat.items.forEach(function (it) {
      currentBalance += Number(it.currentBalance) || 0;
      plannedThisMonth += Number(it.plannedThisMonth) || 0;
      actualSaved += Number(it.actualSaved) || 0;
    });
    return {
      currentBalance: currentBalance,
      plannedThisMonth: plannedThisMonth,
      actualSaved: actualSaved,
      projected: currentBalance + plannedThisMonth,
      carryover: currentBalance + actualSaved
    };
  }

  function monthSavingsTotals(month) {
    var currentBalance = 0, plannedThisMonth = 0, actualSaved = 0;
    month.savings.forEach(function (cat) {
      var t = categorySavingsTotals(cat);
      currentBalance += t.currentBalance;
      plannedThisMonth += t.plannedThisMonth;
      actualSaved += t.actualSaved;
    });
    return {
      currentBalance: currentBalance,
      plannedThisMonth: plannedThisMonth,
      actualSaved: actualSaved,
      projected: currentBalance + plannedThisMonth,
      carryover: currentBalance + actualSaved
    };
  }

  function renderSavingsStructure() {
    var month = getActiveMonth();
    var container = document.getElementById("savings-categories");
    container.innerHTML = "";

    month.savings.forEach(function (cat, catIndex) {
      var catDiv = document.createElement("div");
      catDiv.className = "expense-category";
      catDiv.dataset.catIndex = catIndex;

      var header = document.createElement("div");
      header.className = "expense-category-header";
      header.innerHTML =
        "<h3>" + escapeHtml(cat.category) + "</h3>" +
        '<span class="expense-category-total" data-cat-projected="' + catIndex + '">' + fmt(categorySavingsTotals(cat).projected) + " projected new balance</span>";
      catDiv.appendChild(header);

      var itemsDiv = document.createElement("div");
      itemsDiv.className = "expense-items";

      var labels = document.createElement("div");
      labels.className = "savings-items-labels";
      labels.innerHTML = "<span></span><span></span><span>Account</span><span>Current Balance</span><span>Planned This Month</span><span>Projected New Balance</span><span>Actual Saved</span><span>Carryover Balance</span><span></span><span></span>";
      itemsDiv.appendChild(labels);

      cat.items.forEach(function (item) {
        itemsDiv.appendChild(buildSavingsItemRow(item, cat));
      });

      var addBtn = document.createElement("button");
      addBtn.className = "add-item-btn";
      addBtn.type = "button";
      addBtn.textContent = "+ Add Savings Account";
      addBtn.addEventListener("click", function () {
        cat.items.push({ id: nextId(), name: "New Savings Goal", currentBalance: 0, plannedThisMonth: 0, actualSaved: 0, recurring: false, receiptLog: [] });
        renderSavingsStructure();
        renderExpensesStructure();
        renderDashboard();
        renderTrends();
        scheduleSave();
      });

      itemsDiv.appendChild(addBtn);
      catDiv.appendChild(itemsDiv);
      container.appendChild(catDiv);
    });

    updateSavingsTotalsDOM();
  }

  function buildSavingsItemRow(item, cat) {
    var wrap = document.createElement("div");
    wrap.className = "item-wrap";

    var row = document.createElement("div");
    row.className = "savings-item-row";
    row.dataset.itemId = item.id;

    var receiptUI = attachReceiptLogUI(item, "actualSaved", function () {
      if (item.recurring) propagateCarryoverForward(cat.category, item.name, savingsItemCarryover(item));
      updateSavingsTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var receiptBtn = buildReceiptAddButton("savings", cat.category, item.id, "Log a deposit/receipt for this savings account");

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name;
    nameInput.addEventListener("input", function () {
      item.name = nameInput.value;
      scheduleSave();
    });

    var currentWrap = buildCurrencyInput(item.currentBalance, function (val) {
      item.currentBalance = val;
      if (item.recurring) propagateCarryoverForward(cat.category, item.name, savingsItemCarryover(item));
      updateSavingsTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var plannedWrap = buildCurrencyInput(item.plannedThisMonth, function (val) {
      item.plannedThisMonth = val;
      if (item.recurring) propagatePlannedForward(cat.category, item.name, val);
      updateSavingsTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var projectedSpan = document.createElement("span");
    projectedSpan.className = "savings-item-projected";
    projectedSpan.dataset.itemProjected = item.id;
    projectedSpan.textContent = fmt(savingsItemProjected(item));

    var actualSavedWrap = buildCurrencyInput(item.actualSaved, function (val) {
      item.actualSaved = val;
      if (item.recurring) propagateCarryoverForward(cat.category, item.name, savingsItemCarryover(item));
      updateSavingsTotalsDOM();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    var carryoverSpan = document.createElement("span");
    carryoverSpan.className = "savings-item-carryover";
    carryoverSpan.dataset.itemCarryover = item.id;
    carryoverSpan.textContent = fmt(savingsItemCarryover(item));

    var starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "star-btn" + (item.recurring ? " starred" : "");
    starBtn.innerHTML = "&#9733;";
    starBtn.title = item.recurring
      ? "Recurring — next month's Current Balance rolls forward automatically. Click to make one-off."
      : "One-off — click to make recurring (rolls forward into next month's Current Balance automatically)";
    starBtn.addEventListener("click", function () {
      item.recurring = !item.recurring;
      starBtn.classList.toggle("starred", item.recurring);
      starBtn.title = item.recurring
        ? "Recurring — next month's Current Balance rolls forward automatically. Click to make one-off."
        : "One-off — click to make recurring (rolls forward into next month's Current Balance automatically)";
      if (item.recurring) {
        propagatePlannedForward(cat.category, item.name, item.plannedThisMonth);
        propagateCarryoverForward(cat.category, item.name, savingsItemCarryover(item));
      }
      scheduleSave();
    });

    var removeBtn = document.createElement("button");
    removeBtn.className = "remove-item-btn";
    removeBtn.type = "button";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove savings account";
    removeBtn.addEventListener("click", function () {
      var idx = cat.items.indexOf(item);
      if (idx > -1) cat.items.splice(idx, 1);
      renderSavingsStructure();
      renderExpensesStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    row.appendChild(receiptUI.expandBtn);
    row.appendChild(receiptBtn);
    row.appendChild(nameInput);
    row.appendChild(currentWrap);
    row.appendChild(plannedWrap);
    row.appendChild(projectedSpan);
    row.appendChild(actualSavedWrap);
    row.appendChild(carryoverSpan);
    row.appendChild(starBtn);
    row.appendChild(removeBtn);

    wrap.appendChild(row);
    wrap.appendChild(receiptUI.panel);

    installReceiptDropZone(wrap, item, "actualSaved", function () {
      renderSavingsStructure();
      renderExpensesStructure();
      renderDashboard();
      renderTrends();
      scheduleSave();
    });

    return wrap;
  }

  function updateSavingsTotalsDOM() {
    var month = getActiveMonth();

    month.savings.forEach(function (cat, catIndex) {
      var el = document.querySelector('#savings-categories [data-cat-projected="' + catIndex + '"]');
      if (el) el.textContent = fmt(categorySavingsTotals(cat).projected) + " projected new balance";
      cat.items.forEach(function (item) {
        var projEl = document.querySelector('#savings-categories [data-item-projected="' + item.id + '"]');
        if (projEl) projEl.textContent = fmt(savingsItemProjected(item));
        var carryEl = document.querySelector('#savings-categories [data-item-carryover="' + item.id + '"]');
        if (carryEl) carryEl.textContent = fmt(savingsItemCarryover(item));
      });
    });

    var totals = monthSavingsTotals(month);
    document.getElementById("savings-grand-current").textContent = fmt(totals.currentBalance);
    document.getElementById("savings-grand-planned").textContent = fmt(totals.plannedThisMonth);
    document.getElementById("savings-grand-projected").textContent = fmt(totals.projected);
    document.getElementById("savings-grand-actual-saved").textContent = fmt(totals.actualSaved);
    document.getElementById("savings-grand-carryover").textContent = fmt(totals.carryover);
  }

  // ---------- dashboard ----------

  function renderDashboard() {
    var month = getActiveMonth();
    var incomeTotals = computeIncomeTotals(month);
    var expenseTotals = monthExpenseTotals(month);
    var savingsTotals = monthSavingsTotals(month);
    var netIncome = incomeTotals.net;
    // Projected Savings = every Savings-tab item's Current Balance plus its
    // Planned This Month, summed - i.e. monthSavingsTotals' own "projected"
    // figure (currentBalance + plannedThisMonth), not an income-minus-
    // expenses leftover calculation.
    var projectedSavings = savingsTotals.projected;
    var remainingBudget = expenseTotals.budgeted - expenseTotals.actual;

    document.getElementById("sum-net-income").textContent = fmt(netIncome);
    document.getElementById("sum-leftover").textContent = fmt(projectedSavings);

    var actualExpensesEl = document.getElementById("sum-actual-expenses");
    actualExpensesEl.textContent = fmt(expenseTotals.actual);
    actualExpensesEl.classList.remove("positive", "negative");
    actualExpensesEl.classList.add(expenseTotals.actual <= expenseTotals.budgeted ? "positive" : "negative");
    document.getElementById("sum-actual-expenses-sub").textContent = "of " + fmt(expenseTotals.budgeted) + " budgeted";

    var leftoverCard = document.getElementById("sum-leftover-card");
    leftoverCard.classList.remove("positive", "negative");
    leftoverCard.classList.add(projectedSavings >= 0 ? "positive" : "negative");

    var remainingEl = document.getElementById("sum-remaining-budget");
    remainingEl.textContent = fmt(remainingBudget);
    var remainingCard = document.getElementById("sum-remaining-budget-card");
    remainingCard.classList.remove("positive", "negative");
    remainingCard.classList.add(remainingBudget >= 0 ? "positive" : "negative");

    var catData = month.expenses.map(function (cat) {
      return { label: cat.category, budgeted: categoryBudgeted(cat), actual: categoryActual(cat) };
    });

    var tbody = document.getElementById("dashboard-category-body");
    tbody.innerHTML = "";
    var sorted = catData.slice().sort(function (a, b) { return b.budgeted - a.budgeted; });
    sorted.forEach(function (c) {
      var diff = c.budgeted - c.actual;
      var pctUsed = c.budgeted > 0 ? (c.actual / c.budgeted) * 100 : (c.actual > 0 ? null : 0);
      var overBudget = diff < 0;
      var tr = document.createElement("tr");
      if (overBudget) tr.classList.add("dashboard-row-over");
      tr.innerHTML =
        "<td>" + escapeHtml(c.label) + "</td>" +
        "<td>" + fmt(c.budgeted) + "</td>" +
        "<td>" + fmt(c.actual) + "</td>" +
        '<td class="' + (diff >= 0 ? "diff-positive" : "diff-negative") + '">' + fmt(diff) + "</td>" +
        '<td class="' + (overBudget ? "diff-negative" : "diff-positive") + '">' + (pctUsed === null ? "—" : pctStr(pctUsed)) + "</td>";
      tbody.appendChild(tr);
    });

    var totalsRow = document.createElement("tr");
    totalsRow.className = "dashboard-totals-row";
    var totalDiff = expenseTotals.budgeted - expenseTotals.actual;
    var totalPct = expenseTotals.budgeted > 0 ? (expenseTotals.actual / expenseTotals.budgeted) * 100 : 0;
    totalsRow.innerHTML =
      "<td><strong>Total</strong></td>" +
      "<td><strong>" + fmt(expenseTotals.budgeted) + "</strong></td>" +
      "<td><strong>" + fmt(expenseTotals.actual) + "</strong></td>" +
      '<td class="' + (totalDiff >= 0 ? "diff-positive" : "diff-negative") + '"><strong>' + fmt(totalDiff) + "</strong></td>" +
      '<td class="' + (totalDiff >= 0 ? "diff-positive" : "diff-negative") + '"><strong>' + pctStr(totalPct) + "</strong></td>";
    tbody.appendChild(totalsRow);

    drawBarChart(
      document.getElementById("chart-breakdown"),
      catData.filter(function (c) { return c.budgeted > 0 || c.actual > 0; })
    );

    var savingsData = month.savings.map(function (cat) {
      return { label: cat.category, totals: categorySavingsTotals(cat) };
    });
    var savingsBody = document.getElementById("dashboard-savings-body");
    savingsBody.innerHTML = "";
    savingsData.forEach(function (c) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHtml(c.label) + "</td>" +
        "<td>" + fmt(c.totals.currentBalance) + "</td>" +
        "<td>" + fmt(c.totals.plannedThisMonth) + "</td>" +
        "<td>" + fmt(c.totals.projected) + "</td>" +
        "<td>" + fmt(c.totals.actualSaved) + "</td>" +
        '<td><strong>' + fmt(c.totals.carryover) + "</strong></td>";
      savingsBody.appendChild(tr);
    });
  }

  // ---------- receipt modal ----------
  // A single reusable "log a receipt" modal: itemize a receipt into lines,
  // each tied to a specific existing budget item - in Expenses OR the
  // linked Savings category - or a brand-new item you name on the spot.
  // Lines add into that item's Actual (or Actual Saved, for Savings).
  // Opened blank from the Dashboard button, or pre-filled from the small
  // "+" button next to any item row so you only have to type a
  // description and amount.

  var receiptDraftItems = [];
  var receiptPrefill = null;

  function receiptCategoryOptionValue(kind, categoryName) {
    return kind + "::" + categoryName;
  }

  function findReceiptCategoryArray(kind) {
    var month = getActiveMonth();
    return kind === "savings" ? month.savings : month.expenses;
  }

  function findReceiptCategory(kind, categoryName) {
    var arr = findReceiptCategoryArray(kind);
    return arr.filter(function (c) { return c.category === categoryName; })[0] || null;
  }

  function populateReceiptCategorySelect() {
    var select = document.getElementById("receipt-item-category");
    if (!select || !state) return;
    var month = getActiveMonth();
    var prevValue = select.value;
    select.innerHTML = "";

    month.expenses.forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = receiptCategoryOptionValue("expenses", cat.category);
      opt.textContent = cat.category;
      select.appendChild(opt);
    });
    month.savings.forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = receiptCategoryOptionValue("savings", cat.category);
      opt.textContent = cat.category + " (Savings)";
      select.appendChild(opt);
    });

    if (prevValue && Array.prototype.some.call(select.options, function (o) { return o.value === prevValue; })) {
      select.value = prevValue;
    }
    populateReceiptTargetSelect();
  }

  function populateReceiptTargetSelect(selectItemId) {
    var categorySelect = document.getElementById("receipt-item-category");
    var targetSelect = document.getElementById("receipt-item-target");
    if (!categorySelect || !targetSelect || !categorySelect.value) return;

    var parts = categorySelect.value.split("::");
    var kind = parts[0], categoryName = parts.slice(1).join("::");
    var cat = findReceiptCategory(kind, categoryName);

    targetSelect.innerHTML = "";
    if (cat) {
      cat.items.forEach(function (it) {
        var opt = document.createElement("option");
        opt.value = String(it.id);
        opt.textContent = it.name;
        targetSelect.appendChild(opt);
      });
    }
    var newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "+ Create new item…";
    targetSelect.appendChild(newOpt);

    if (selectItemId != null) targetSelect.value = String(selectItemId);
    updateReceiptNewItemVisibility();
  }

  function updateReceiptNewItemVisibility() {
    var targetSelect = document.getElementById("receipt-item-target");
    var newItemRow = document.getElementById("receipt-new-item-row");
    if (!targetSelect || !newItemRow) return;
    newItemRow.hidden = targetSelect.value !== "__new__";
  }

  function openReceiptModal(prefill) {
    if (!state) return;
    receiptPrefill = prefill || null;
    document.getElementById("receipt-overlay").hidden = false;
    populateReceiptCategorySelect();

    if (prefill) {
      document.getElementById("receipt-item-category").value = receiptCategoryOptionValue(prefill.kind, prefill.categoryName);
      populateReceiptTargetSelect(prefill.itemId);
    }
    updateReceiptNewItemVisibility();
    document.getElementById("receipt-item-name").focus();
  }

  function closeReceiptModal() {
    var overlay = document.getElementById("receipt-overlay");
    if (overlay) overlay.hidden = true;
  }

  function renderReceiptDraftList() {
    var container = document.getElementById("receipt-draft-list");
    if (!container) return;
    container.innerHTML = "";

    if (!receiptDraftItems.length) {
      container.innerHTML = '<p class="empty-row">No lines added yet.</p>';
    } else {
      receiptDraftItems.forEach(function (draft, idx) {
        var row = document.createElement("div");
        row.className = "receipt-draft-item";

        var nameSpan = document.createElement("span");
        nameSpan.className = "receipt-draft-name";
        nameSpan.textContent = draft.description;

        var targetSpan = document.createElement("span");
        targetSpan.className = "receipt-draft-category";
        targetSpan.textContent = draft.categoryName + " > " + draft.itemName + (draft.isNew ? " (new)" : "") + (draft.kind === "savings" ? " · Savings" : "");

        var amountSpan = document.createElement("span");
        amountSpan.className = "receipt-draft-amount";
        amountSpan.textContent = fmt(draft.amount);

        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "remove-item-btn";
        removeBtn.innerHTML = "&times;";
        removeBtn.title = "Remove line";
        removeBtn.addEventListener("click", function () {
          receiptDraftItems.splice(idx, 1);
          renderReceiptDraftList();
        });

        row.appendChild(nameSpan);
        row.appendChild(targetSpan);
        row.appendChild(amountSpan);
        row.appendChild(removeBtn);
        container.appendChild(row);
      });
    }

    var itemizedTotal = receiptDraftItems.reduce(function (s, d) { return s + d.amount; }, 0);
    document.getElementById("receipt-itemized-total").textContent = fmt(itemizedTotal);

    var receiptTotalInput = document.getElementById("receipt-total-input");
    var receiptTotal = parseFloat(receiptTotalInput.value) || 0;
    var remainingNote = document.getElementById("receipt-remaining-note");
    remainingNote.classList.remove("diff-positive", "diff-negative");
    if (receiptTotal > 0) {
      var remaining = receiptTotal - itemizedTotal;
      if (Math.abs(remaining) < 0.01) {
        remainingNote.textContent = "Fully itemized.";
        remainingNote.classList.add("diff-positive");
      } else if (remaining > 0) {
        remainingNote.textContent = "Remaining to itemize: " + fmt(remaining);
      } else {
        remainingNote.textContent = "Over the receipt total by: " + fmt(Math.abs(remaining));
        remainingNote.classList.add("diff-negative");
      }
    } else {
      remainingNote.textContent = "";
    }

    document.getElementById("receipt-commit-btn").disabled = !receiptDraftItems.length;
  }

  function addReceiptDraftLine() {
    var descInput = document.getElementById("receipt-item-name");
    var categorySelect = document.getElementById("receipt-item-category");
    var targetSelect = document.getElementById("receipt-item-target");
    var newItemNameInput = document.getElementById("receipt-new-item-name");
    var amountInput = document.getElementById("receipt-item-amount");

    var amount = parseFloat(amountInput.value) || 0;
    if (amount <= 0 || !categorySelect.value) { amountInput.focus(); return; }

    var parts = categorySelect.value.split("::");
    var kind = parts[0], categoryName = parts.slice(1).join("::");
    var isNew = targetSelect.value === "__new__";
    var itemId = null, itemName = "";

    if (isNew) {
      itemName = newItemNameInput.value.trim();
      if (!itemName) { newItemNameInput.focus(); return; }
    } else {
      if (!targetSelect.value) { targetSelect.focus(); return; }
      itemId = parseInt(targetSelect.value, 10);
      var cat = findReceiptCategory(kind, categoryName);
      var existingItem = cat ? cat.items.filter(function (it) { return it.id === itemId; })[0] : null;
      if (!existingItem) return;
      itemName = existingItem.name;
    }

    receiptDraftItems.push({
      description: descInput.value.trim() || itemName,
      kind: kind,
      categoryName: categoryName,
      itemId: itemId,
      itemName: itemName,
      isNew: isNew,
      amount: amount
    });

    descInput.value = "";
    amountInput.value = "";
    if (isNew) newItemNameInput.value = "";
    descInput.focus();
    renderReceiptDraftList();
  }

  function commitReceiptDraft() {
    if (!receiptDraftItems.length) return;
    var month = getActiveMonth();
    var addedCount = 0;

    receiptDraftItems.forEach(function (draft) {
      var categoryArray = draft.kind === "savings" ? month.savings : month.expenses;
      var cat = categoryArray.filter(function (c) { return c.category === draft.categoryName; })[0];
      if (!cat) return;

      var item = null;
      if (!draft.isNew && draft.itemId != null) {
        item = cat.items.filter(function (it) { return it.id === draft.itemId; })[0];
      }

      if (!item) {
        // Explicitly new, or the original target was removed since the
        // line was drafted - create it fresh so the line isn't lost.
        item = draft.kind === "savings"
          ? { id: nextId(), name: draft.itemName, currentBalance: 0, plannedThisMonth: 0, actualSaved: 0, recurring: false, receiptLog: [] }
          : { id: nextId(), name: draft.itemName, budgeted: 0, actual: 0, recurring: false, receiptLog: [] };
        cat.items.push(item);
      }

      ensureReceiptLog(item);
      if (draft.kind === "savings") {
        item.actualSaved = (Number(item.actualSaved) || 0) + draft.amount;
      } else {
        item.actual = (Number(item.actual) || 0) + draft.amount;
      }
      item.receiptLog.push({ id: nextId(), date: new Date().toISOString(), description: draft.description, amount: draft.amount });
      addedCount++;
    });

    receiptDraftItems = [];
    document.getElementById("receipt-total-input").value = "";
    renderReceiptDraftList();

    renderExpensesStructure();
    renderSavingsStructure();
    renderDashboard();
    renderTrends();
    scheduleSave();

    var statusEl = document.getElementById("receipt-commit-status");
    statusEl.textContent = "Added " + addedCount + " item(s).";
    setTimeout(function () {
      statusEl.textContent = "";
      closeReceiptModal();
    }, 1100);
  }

  function initReceiptModal() {
    document.getElementById("receipt-open-btn").addEventListener("click", function () { openReceiptModal(null); });
    document.getElementById("receipt-close-btn").addEventListener("click", closeReceiptModal);
    document.getElementById("receipt-overlay").addEventListener("click", function (e) {
      if (e.target.id === "receipt-overlay") closeReceiptModal();
    });
    document.addEventListener("keydown", function (e) {
      var overlay = document.getElementById("receipt-overlay");
      if (e.key === "Escape" && overlay && !overlay.hidden) closeReceiptModal();
    });

    document.getElementById("receipt-item-category").addEventListener("change", function () {
      populateReceiptTargetSelect();
    });
    document.getElementById("receipt-item-target").addEventListener("change", updateReceiptNewItemVisibility);
    document.getElementById("receipt-total-input").addEventListener("input", renderReceiptDraftList);
    document.getElementById("receipt-add-item-btn").addEventListener("click", addReceiptDraftLine);
    document.getElementById("receipt-commit-btn").addEventListener("click", commitReceiptDraft);

    renderReceiptDraftList();
  }

  // ---------- statement import ----------
  // Parses a bank/card statement PDF (server-side, in statement_import.py -
  // this file only extracts raw facts, no opinion on budget schema) into a
  // flat transaction list, then lets you go through each one: pick which
  // Expenses category/item it belongs to (or add a new one), or add it as
  // an Income pay period for credits. Nothing is saved until "Import
  // Selected" - each row also starts unchecked if its amount already
  // matches something logged this month, so re-running an import (or
  // reconciling against stuff you already entered by hand) doesn't
  // double-count by default, but you can always check the box to add it
  // anyway if it's genuinely a different transaction with the same amount.

  var statementRows = [];

  var STATEMENT_CATEGORY_HINTS = [
    { match: /food|dining|groceries/i, category: "Food" },
    { match: /transportation|fuel|auto/i, category: "Transportation" },
    { match: /housing|mortgage|rent/i, category: "Housing" },
    { match: /utilit/i, category: "Utilities" },
    { match: /healthcare|hsa|medical|copay|insurance/i, category: "Insurance & Healthcare" },
    { match: /debt|loan/i, category: "Debt Payments" },
    { match: /cloth|personal care|education|contribution|entertainment|hobby|shopping/i, category: "Personal & Family" }
  ];

  function suggestExpenseCategory(bankCategory) {
    for (var i = 0; i < STATEMENT_CATEGORY_HINTS.length; i++) {
      if (STATEMENT_CATEGORY_HINTS[i].match.test(bankCategory)) return STATEMENT_CATEGORY_HINTS[i].category;
    }
    return "Miscellaneous";
  }

  function statementDefaultInclude(tx, hasMatch) {
    if (hasMatch) return false; // possible duplicate - default to "already added"
    return !/transfer between accounts/i.test(tx.bankCategory);
  }

  // Bank statements often glue a date code onto the front of the merchant
  // name and a masked card number onto the back (e.g.
  // "0726SHELL OIL 5754 GONZALES LA************2793") - this is a
  // best-effort cleanup for a default item/label name, not a precise
  // parse; you can always edit it before importing.
  function guessMerchantName(description) {
    var text = (description || "").replace(/^\d{4}(?=[A-Z])/, "");
    text = text.replace(/\s*[A-Z]{0,4}\*{4,}\d*\s*$/, "");
    text = text.replace(/\s+/g, " ").trim();
    return (text || description || "").slice(0, 60);
  }

  function statementFmtDate(isoDate) {
    var d = new Date(isoDate + "T00:00:00");
    if (isNaN(d.getTime())) return isoDate;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // Amount-only match (no date requirement, per how this is meant to be
  // used) against whatever's already logged in that transaction's target
  // month - existing receipt-log entries (expenses/savings) for debits,
  // existing pay periods for credits.
  function statementFindAmountMatch(tx) {
    var d = new Date(tx.date + "T00:00:00");
    if (isNaN(d.getTime())) return null;
    var month = state.months[monthKeyFromDate(d)];
    if (!month) return null;

    if (tx.direction === "credit") {
      var foundPP = null;
      (month.income.payPeriods || []).forEach(function (p) {
        if (foundPP) return;
        (p.receiptLog || []).forEach(function (entry) {
          if (foundPP) return;
          if (Math.abs((Number(entry.amount) || 0) - tx.amount) < 0.005) {
            foundPP = { label: p.label };
          }
        });
      });
      return foundPP;
    }

    var found = null;
    ["expenses", "savings"].forEach(function (kind) {
      if (found || !month[kind]) return;
      month[kind].forEach(function (cat) {
        if (found) return;
        cat.items.forEach(function (it) {
          if (found) return;
          (it.receiptLog || []).forEach(function (entry) {
            if (found) return;
            if (Math.abs((Number(entry.amount) || 0) - tx.amount) < 0.005) {
              found = { label: it.name };
            }
          });
        });
      });
    });
    return found;
  }

  function populateStatementCategorySelect(selectEl) {
    selectEl.innerHTML = "";
    getActiveMonth().expenses.forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = cat.category;
      opt.textContent = cat.category;
      selectEl.appendChild(opt);
    });
  }

  // Item options come from the transaction's actual target month (read-only
  // lookup - doesn't call ensureMonth, so just opening the review list
  // never creates/mutates a month that isn't otherwise touched yet).
  function populateStatementItemSelect(rowState) {
    var categoryName = rowState.categorySelect.value;
    var itemSelect = rowState.itemSelect;
    itemSelect.innerHTML = "";

    var d = new Date(rowState.tx.date + "T00:00:00");
    var existingMonth = state.months[monthKeyFromDate(d)];
    var cat = existingMonth ? existingMonth.expenses.filter(function (c) { return c.category === categoryName; })[0] : null;

    if (cat) {
      cat.items.forEach(function (it) {
        var opt = document.createElement("option");
        opt.value = String(it.id);
        opt.textContent = it.name;
        itemSelect.appendChild(opt);
      });
    }
    var newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "+ New item…";
    itemSelect.appendChild(newOpt);
    itemSelect.value = "__new__";

    rowState.newItemInput.value = guessMerchantName(rowState.tx.description);
    rowState.newItemInput.hidden = itemSelect.value !== "__new__";
  }

  // Pay period options come from the transaction's actual target month
  // (read-only lookup, same as populateStatementItemSelect above).
  function populateStatementPayPeriodSelect(rowState) {
    var ppSelect = rowState.ppSelect;
    ppSelect.innerHTML = "";

    var d = new Date(rowState.tx.date + "T00:00:00");
    var existingMonth = state.months[monthKeyFromDate(d)];
    var payPeriods = existingMonth ? existingMonth.income.payPeriods : [];

    payPeriods.forEach(function (pp) {
      var opt = document.createElement("option");
      opt.value = String(pp.id);
      opt.textContent = pp.label;
      ppSelect.appendChild(opt);
    });
    var newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "+ New pay period…";
    ppSelect.appendChild(newOpt);
    ppSelect.value = "__new__";

    rowState.newPPInput.value = guessMerchantName(rowState.tx.description);
    rowState.newPPInput.hidden = ppSelect.value !== "__new__";
  }

  function buildStatementRow(tx) {
    var rowEl = document.createElement("div");
    rowEl.className = "statement-row";

    var main = document.createElement("div");
    main.className = "statement-row-main";

    var include = document.createElement("input");
    include.type = "checkbox";

    var match = statementFindAmountMatch(tx);
    include.checked = statementDefaultInclude(tx, !!match);

    var dateSpan = document.createElement("span");
    dateSpan.className = "statement-row-date";
    dateSpan.textContent = statementFmtDate(tx.date);

    var desc = document.createElement("div");
    desc.className = "statement-row-desc";
    var descText = document.createElement("span");
    descText.className = "statement-row-desc-text";
    descText.textContent = tx.description;
    descText.title = tx.description;
    var bankCat = document.createElement("span");
    bankCat.className = "statement-row-bank-cat";
    bankCat.textContent = tx.bankCategory;
    desc.appendChild(descText);
    desc.appendChild(bankCat);

    var amount = document.createElement("span");
    amount.className = "statement-row-amount " + tx.direction;
    amount.textContent = (tx.direction === "debit" ? "-" : "+") + fmt(tx.amount);

    main.appendChild(include);
    main.appendChild(dateSpan);
    main.appendChild(desc);
    main.appendChild(amount);
    rowEl.appendChild(main);

    if (match) {
      var hint = document.createElement("p");
      hint.className = "statement-row-hint";
      hint.textContent = "Possible duplicate - matches an amount already logged for “" + match.label + "”. Left unchecked (assumed already added); check the box if this is actually a different transaction.";
      rowEl.appendChild(hint);
    }

    var target = document.createElement("div");
    target.className = "statement-row-target";

    var rowState = { tx: tx, rowEl: rowEl, includeInput: include };

    if (tx.direction === "credit") {
      var ppSelect = document.createElement("select");
      var newPPInput = document.createElement("input");
      newPPInput.type = "text";
      newPPInput.className = "income-label-input new-item-input";
      newPPInput.placeholder = "New pay period name";

      target.appendChild(ppSelect);
      target.appendChild(newPPInput);

      rowState.ppSelect = ppSelect;
      rowState.newPPInput = newPPInput;

      populateStatementPayPeriodSelect(rowState);

      ppSelect.addEventListener("change", function () {
        newPPInput.hidden = ppSelect.value !== "__new__";
      });
    } else {
      var categorySelect = document.createElement("select");
      var itemSelect = document.createElement("select");
      var newItemInput = document.createElement("input");
      newItemInput.type = "text";
      newItemInput.className = "new-item-input";
      newItemInput.placeholder = "New item name";

      target.appendChild(categorySelect);
      target.appendChild(itemSelect);
      target.appendChild(newItemInput);

      rowState.categorySelect = categorySelect;
      rowState.itemSelect = itemSelect;
      rowState.newItemInput = newItemInput;

      populateStatementCategorySelect(categorySelect);
      var suggested = suggestExpenseCategory(tx.bankCategory);
      if (Array.prototype.some.call(categorySelect.options, function (o) { return o.value === suggested; })) {
        categorySelect.value = suggested;
      }
      populateStatementItemSelect(rowState);

      categorySelect.addEventListener("change", function () { populateStatementItemSelect(rowState); });
      itemSelect.addEventListener("change", function () {
        newItemInput.hidden = itemSelect.value !== "__new__";
      });
    }

    rowEl.appendChild(target);

    function syncEnabled() {
      rowEl.classList.toggle("statement-row-excluded", !include.checked);
      target.style.display = include.checked ? "" : "none";
    }
    include.addEventListener("change", syncEnabled);
    syncEnabled();
    rowState.syncEnabled = syncEnabled;

    return rowState;
  }

  function renderStatementRows(transactions) {
    var container = document.getElementById("statement-rows");
    container.innerHTML = "";
    statementRows = transactions.map(function (tx) {
      var rowState = buildStatementRow(tx);
      container.appendChild(rowState.rowEl);
      return rowState;
    });
  }

  function showStatementSummary(summary) {
    var line = document.getElementById("statement-summary-line");
    var text = "Found " + summary.count + " transaction" + (summary.count === 1 ? "" : "s") +
      " (" + fmt(summary.totalCredit) + " in, " + fmt(summary.totalDebit) + " out).";
    if (summary.statedItemCount != null) {
      text += (summary.statedItemCount === summary.count)
        ? " Matches the statement's own total."
        : " The statement itself says " + summary.statedItemCount + " items - double check nothing got missed.";
    }
    line.textContent = text;
  }

  function openStatementModal() {
    if (!state) return;
    document.getElementById("statement-overlay").hidden = false;
    document.getElementById("statement-upload-step").hidden = false;
    document.getElementById("statement-review-step").hidden = true;
    document.getElementById("statement-file-input").value = "";
    document.getElementById("statement-parse-btn").disabled = true;
    document.getElementById("statement-parse-status").textContent = "";
  }

  function closeStatementModal() {
    document.getElementById("statement-overlay").hidden = true;
  }

  function parseStatementFile() {
    var input = document.getElementById("statement-file-input");
    var file = input.files && input.files[0];
    if (!file) return;

    var btn = document.getElementById("statement-parse-btn");
    var status = document.getElementById("statement-parse-status");
    btn.disabled = true;
    status.textContent = "Reading " + file.name + "…";

    fetch("/api/statement/parse", { method: "POST", body: file })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
          return body;
        });
      })
      .then(function (result) {
        status.textContent = "";
        document.getElementById("statement-upload-step").hidden = true;
        document.getElementById("statement-review-step").hidden = false;
        showStatementSummary(result.summary);
        renderStatementRows(result.transactions);
      })
      .catch(function (e) {
        status.textContent = "Couldn't parse that file: " + e.message;
        btn.disabled = false;
      });
  }

  function commitStatementImport() {
    var addedExpense = 0, addedIncome = 0, skipped = 0;

    statementRows.forEach(function (row) {
      if (!row.includeInput.checked) { skipped++; return; }
      var tx = row.tx;
      var d = new Date(tx.date + "T00:00:00");
      if (isNaN(d.getTime())) { skipped++; return; }
      var month = ensureMonth(monthKeyFromDate(d));

      if (tx.direction === "credit") {
        var pp = null;
        if (row.ppSelect.value !== "__new__") {
          var ppId = parseInt(row.ppSelect.value, 10);
          pp = month.income.payPeriods.filter(function (p) { return p.id === ppId; })[0];
        }
        if (!pp) {
          var ppLabel = (row.newPPInput.value || "").trim() || guessMerchantName(tx.description);
          pp = { id: nextId(), label: ppLabel, gross: 0, net: 0, recurring: false, receiptLog: [] };
          month.income.payPeriods.push(pp);
        }

        ensureReceiptLog(pp);
        pp.net = (Number(pp.net) || 0) + tx.amount;
        pp.receiptLog.push({ id: nextId(), date: new Date(tx.date + "T12:00:00").toISOString(), description: tx.description, amount: tx.amount });
        addedIncome++;
        return;
      }

      var categoryName = row.categorySelect.value;
      var cat = month.expenses.filter(function (c) { return c.category === categoryName; })[0];
      if (!cat) {
        cat = { category: categoryName, items: [] };
        month.expenses.push(cat);
      }

      var item = null;
      if (row.itemSelect.value !== "__new__") {
        var itemId = parseInt(row.itemSelect.value, 10);
        item = cat.items.filter(function (it) { return it.id === itemId; })[0];
      }
      if (!item) {
        var itemName = (row.newItemInput.value || "").trim() || guessMerchantName(tx.description);
        item = { id: nextId(), name: itemName, budgeted: 0, actual: 0, recurring: false, receiptLog: [] };
        cat.items.push(item);
      }

      ensureReceiptLog(item);
      item.actual = (Number(item.actual) || 0) + tx.amount;
      item.receiptLog.push({ id: nextId(), date: new Date(tx.date + "T12:00:00").toISOString(), description: tx.description, amount: tx.amount });
      addedExpense++;
    });

    renderIncomeStructure();
    renderExpensesStructure();
    renderSavingsStructure();
    renderDashboard();
    renderTrends();
    scheduleSave();

    var status = document.getElementById("statement-commit-status");
    status.textContent = "Added " + addedExpense + " expense line(s) and " + addedIncome +
      " income entr" + (addedIncome === 1 ? "y" : "ies") + " (" + skipped + " skipped).";
    setTimeout(function () {
      status.textContent = "";
      closeStatementModal();
    }, 1800);
  }

  // ---------- header settings gear / Clear Data ----------
  // Same open/close/outside-click/Escape pattern as the shared $
  // page-switcher menu in nav.js (and the Meals page's settings gear).

  function closeBudgetSettingsMenu() {
    var trigger = document.getElementById("budget-settings-trigger");
    var menu = document.getElementById("budget-settings-menu");
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  function initBudgetSettingsMenu() {
    var trigger = document.getElementById("budget-settings-trigger");
    var menu = document.getElementById("budget-settings-menu");
    if (!trigger || !menu) return;

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) {
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      } else {
        closeBudgetSettingsMenu();
      }
    });

    document.addEventListener("click", function (e) {
      if (!menu.hidden && e.target !== trigger && !menu.contains(e.target)) closeBudgetSettingsMenu();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeBudgetSettingsMenu();
    });

    document.getElementById("menu-clear-data-btn").addEventListener("click", function () {
      closeBudgetSettingsMenu();
      openClearDataModal();
    });

    document.getElementById("menu-download-backup-btn").addEventListener("click", function () {
      closeBudgetSettingsMenu();
    });
  }

  // Zeroes out numbers only - categories, items, and pay periods stay
  // exactly as they are. Scoped to whichever single month is passed in
  // (the currently active one), never touches any other month.
  function clearIncomeData(month) {
    month.income.payPeriods.forEach(function (pp) {
      pp.gross = 0;
      pp.net = 0;
      pp.receiptLog = [];
    });
  }

  function clearExpensesData(month) {
    month.expenses.forEach(function (cat) {
      cat.items.forEach(function (it) {
        it.budgeted = 0;
        it.actual = 0;
        it.receiptLog = [];
      });
    });
  }

  function clearSavingsData(month) {
    month.savings.forEach(function (cat) {
      cat.items.forEach(function (it) {
        it.currentBalance = 0;
        it.plannedThisMonth = 0;
        it.actualSaved = 0;
        it.receiptLog = [];
      });
    });
  }

  var CLEAR_DATA_CHECKBOX_IDS = ["clear-data-income", "clear-data-expenses", "clear-data-savings"];

  function openClearDataModal() {
    if (!state) return;
    document.getElementById("clear-data-month-label").textContent = monthLabel(state.activeMonth);
    CLEAR_DATA_CHECKBOX_IDS.forEach(function (id) { document.getElementById(id).checked = false; });
    document.getElementById("clear-data-confirm-btn").disabled = true;
    document.getElementById("clear-data-status").textContent = "";
    document.getElementById("clear-data-overlay").hidden = false;
  }

  function closeClearDataModal() {
    document.getElementById("clear-data-overlay").hidden = true;
  }

  function updateClearDataConfirmEnabled() {
    var anyChecked = CLEAR_DATA_CHECKBOX_IDS.some(function (id) { return document.getElementById(id).checked; });
    document.getElementById("clear-data-confirm-btn").disabled = !anyChecked;
  }

  function runClearData() {
    var clearIncome = document.getElementById("clear-data-income").checked;
    var clearExpenses = document.getElementById("clear-data-expenses").checked;
    var clearSavings = document.getElementById("clear-data-savings").checked;
    if (!clearIncome && !clearExpenses && !clearSavings) return;

    var parts = [];
    if (clearIncome) parts.push("Income");
    if (clearExpenses) parts.push("Expenses");
    if (clearSavings) parts.push("Savings");
    var monthText = monthLabel(state.activeMonth);

    var ok = confirm(
      "Clear " + parts.join(", ") + " for " + monthText + "? This zeroes out the numbers " +
      "in those tabs for this month only (other months are untouched) and can't be undone."
    );
    if (!ok) return;

    var month = getActiveMonth();
    if (clearIncome) clearIncomeData(month);
    if (clearExpenses) clearExpensesData(month);
    if (clearSavings) clearSavingsData(month);

    renderIncomeStructure();
    renderExpensesStructure();
    renderSavingsStructure();
    renderDashboard();
    renderTrends();
    scheduleSave();

    var status = document.getElementById("clear-data-status");
    status.textContent = "Cleared " + parts.join(", ") + " for " + monthText + ".";
    setTimeout(function () {
      status.textContent = "";
      closeClearDataModal();
    }, 1400);
  }

  function initClearDataModal() {
    document.getElementById("clear-data-close-btn").addEventListener("click", closeClearDataModal);
    document.getElementById("clear-data-overlay").addEventListener("click", function (e) {
      if (e.target.id === "clear-data-overlay") closeClearDataModal();
    });
    document.addEventListener("keydown", function (e) {
      var overlay = document.getElementById("clear-data-overlay");
      if (e.key === "Escape" && overlay && !overlay.hidden) closeClearDataModal();
    });
    CLEAR_DATA_CHECKBOX_IDS.forEach(function (id) {
      document.getElementById(id).addEventListener("change", updateClearDataConfirmEnabled);
    });
    document.getElementById("clear-data-confirm-btn").addEventListener("click", runClearData);
  }

  function setAllStatementRowsChecked(checked) {
    statementRows.forEach(function (row) {
      row.includeInput.checked = checked;
      row.syncEnabled();
    });
  }

  function initStatementImport() {
    document.getElementById("statement-import-open-btn").addEventListener("click", openStatementModal);
    document.getElementById("statement-select-all-btn").addEventListener("click", function () { setAllStatementRowsChecked(true); });
    document.getElementById("statement-deselect-all-btn").addEventListener("click", function () { setAllStatementRowsChecked(false); });
    document.getElementById("statement-close-btn").addEventListener("click", closeStatementModal);
    document.getElementById("statement-overlay").addEventListener("click", function (e) {
      if (e.target.id === "statement-overlay") closeStatementModal();
    });
    document.addEventListener("keydown", function (e) {
      var overlay = document.getElementById("statement-overlay");
      if (e.key === "Escape" && overlay && !overlay.hidden) closeStatementModal();
    });
    document.getElementById("statement-file-input").addEventListener("change", function () {
      document.getElementById("statement-parse-btn").disabled = !this.files.length;
    });
    document.getElementById("statement-parse-btn").addEventListener("click", parseStatementFile);
    document.getElementById("statement-commit-btn").addEventListener("click", commitStatementImport);
    document.getElementById("statement-start-over-btn").addEventListener("click", openStatementModal);
  }

  // ---------- canvas: category breakdown bar chart ----------

  // Two bars per category - budgeted vs actual - so it's an actual
  // comparison at a glance, not just a budgeted-only breakdown. The actual
  // bar turns the "over budget" color when it's run past what was budgeted.
  function drawBarChart(canvas, data) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!data.length) {
      ctx.fillStyle = themeColor("--slate-400");
      ctx.font = "13px sans-serif";
      ctx.fillText("No budgeted expenses yet.", 16, 30);
      return;
    }

    data = data.slice().sort(function (a, b) { return b.budgeted - a.budgeted; });
    var max = Math.max.apply(null, data.map(function (d) { return Math.max(d.budgeted, d.actual); })) || 1;

    var padLeft = 130, padRight = 70, padTop = 20, padBottom = 12;
    var rowH = Math.min(46, (H - padTop - padBottom) / data.length);
    var barAreaWidth = W - padLeft - padRight;
    var barH = Math.max(5, (rowH - 10) / 2);

    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";

    // Legend
    ctx.fillStyle = themeColor("--accent");
    ctx.fillRect(padLeft, 2, 10, 10);
    ctx.fillStyle = themeColor("--navy-950");
    ctx.textAlign = "left";
    ctx.fillText("Budgeted", padLeft + 14, 7);
    ctx.fillStyle = themeColor("--slate-400");
    ctx.fillRect(padLeft + 90, 2, 10, 10);
    ctx.fillStyle = themeColor("--navy-950");
    ctx.fillText("Actual", padLeft + 104, 7);

    data.forEach(function (d, i) {
      var y = padTop + i * rowH;
      var overBudget = d.actual > d.budgeted;
      var budgetedColor = themeColor("--accent");
      var actualColor = overBudget ? themeColor("--red") : themeColor("--slate-400");

      ctx.fillStyle = themeColor("--navy-950");
      ctx.textAlign = "right";
      var label = d.label.length > 20 ? d.label.slice(0, 18) + "…" : d.label;
      ctx.fillText(label, padLeft - 10, y + rowH / 2 - 1);

      var budgetedW = (d.budgeted / max) * barAreaWidth;
      ctx.fillStyle = budgetedColor;
      roundRect(ctx, padLeft, y, Math.max(2, budgetedW), barH, 3);
      ctx.fill();
      ctx.fillStyle = themeColor("--slate-600");
      ctx.textAlign = "left";
      ctx.fillText("$" + fmtShort(d.budgeted), padLeft + budgetedW + 6, y + barH / 2);

      var actualY = y + barH + 4;
      var actualW = (d.actual / max) * barAreaWidth;
      ctx.fillStyle = actualColor;
      roundRect(ctx, padLeft, actualY, Math.max(2, actualW), barH, 3);
      ctx.fill();
      ctx.fillStyle = overBudget ? themeColor("--red") : themeColor("--slate-600");
      ctx.textAlign = "left";
      ctx.fillText("$" + fmtShort(d.actual), padLeft + actualW + 6, actualY + barH / 2);
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- trends ----------

  function renderTrends() {
    var keys = Object.keys(state.months).sort();
    var data = keys.map(function (k) {
      var month = state.months[k];
      var incomeTotals = computeIncomeTotals(month);
      var expenseTotals = monthExpenseTotals(month);
      var savingsTotals = monthSavingsTotals(month);
      return {
        key: k,
        label: monthShortLabel(k),
        income: incomeTotals.net,
        expenses: expenseTotals.actual,
        savings: savingsTotals.actualSaved,
        leftover: incomeTotals.net - expenseTotals.actual - savingsTotals.actualSaved
      };
    });

    drawTrendsChart(document.getElementById("chart-trends"), data);

    var tbody = document.getElementById("trends-table-body");
    tbody.innerHTML = "";
    if (!data.length) {
      var emptyRow = document.createElement("tr");
      emptyRow.innerHTML = '<td colspan="5" style="color:var(--slate-400);">Visit a month on the Income, Expenses, or Savings tab to start tracking trends.</td>';
      tbody.appendChild(emptyRow);
      return;
    }
    data.forEach(function (d) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + monthLabel(d.key) + "</td>" +
        "<td>" + fmt(d.income) + "</td>" +
        "<td>" + fmt(d.expenses) + "</td>" +
        "<td>" + fmt(d.savings) + "</td>" +
        '<td class="' + (d.leftover >= 0 ? "diff-positive" : "diff-negative") + '">' + fmt(d.leftover) + "</td>";
      tbody.appendChild(tr);
    });
  }

  function drawBar(ctx, x, baselineY, w, topY, color) {
    var y = Math.min(baselineY, topY);
    var h = Math.abs(baselineY - topY);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, Math.max(1, h));
  }

  function drawTrendsChart(canvas, data) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!data.length) {
      ctx.fillStyle = themeColor("--slate-400");
      ctx.font = "13px sans-serif";
      ctx.fillText("No months tracked yet.", 16, 30);
      return;
    }

    var padLeft = 64, padRight = 20, padTop = 16, padBottom = 36;
    var chartW = W - padLeft - padRight;
    var chartH = H - padTop - padBottom;

    var maxVal = 0, minVal = 0;
    data.forEach(function (d) {
      maxVal = Math.max(maxVal, d.income, d.expenses, d.savings, d.leftover);
      minVal = Math.min(minVal, d.leftover);
    });
    if (maxVal <= 0) maxVal = 1000;
    var range = (maxVal - minVal) || 1;

    function yForVal(v) { return padTop + chartH - ((v - minVal) / range) * chartH; }
    var zeroY = yForVal(0);

    ctx.strokeStyle = themeColor("--slate-100");
    ctx.fillStyle = themeColor("--slate-400");
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    var divisions = 4;
    for (var i = 0; i <= divisions; i++) {
      var val = minVal + (range / divisions) * i;
      var y = yForVal(val);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + chartW, y);
      ctx.stroke();
      ctx.fillText("$" + fmtShort(val), padLeft - 8, y);
    }

    var groupWidth = chartW / data.length;
    var barWidth = Math.min(20, groupWidth / 6);
    var gap = barWidth * 0.3;
    var barsTotalWidth = barWidth * 4 + gap * 3;

    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    data.forEach(function (d) {
      var idx = data.indexOf(d);
      var groupX = padLeft + idx * groupWidth + groupWidth / 2;
      var startX = groupX - barsTotalWidth / 2;
      var xIncome = startX + barWidth / 2;
      var xExpenses = xIncome + barWidth + gap;
      var xSavings = xExpenses + barWidth + gap;
      var xLeftover = xSavings + barWidth + gap;

      drawBar(ctx, xIncome - barWidth / 2, zeroY, barWidth, yForVal(d.income), "#2f6fed");
      drawBar(ctx, xExpenses - barWidth / 2, zeroY, barWidth, yForVal(d.expenses), "#8996ab");
      drawBar(ctx, xSavings - barWidth / 2, zeroY, barWidth, yForVal(d.savings), "#7a5cf0");
      drawBar(ctx, xLeftover - barWidth / 2, zeroY, barWidth, yForVal(d.leftover), d.leftover >= 0 ? "#1f9d55" : "#d64545");

      ctx.fillStyle = themeColor("--slate-600");
      ctx.fillText(d.label, groupX, padTop + chartH + 8);
    });

    ctx.strokeStyle = themeColor("--slate-200");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY);
    ctx.lineTo(padLeft + chartW, zeroY);
    ctx.stroke();
  }

  // ---------- TSP (global, not month-specific) ----------

  var TSP_SCENARIOS = [
    { key: "low", rate: 0.08, color: "#8996ab", label: "Low (8%)" },
    { key: "mid", rate: 0.10, color: "#2f6fed", label: "Expected (10%)" },
    { key: "high", rate: 0.12, color: "#1f9d55", label: "High (12%)" }
  ];

  function getCurrentYear() {
    return new Date().getFullYear();
  }

  function defaultRetirementYear() {
    return getCurrentYear() + 20;
  }

  // Whole years from now until the projected retirement year (never negative).
  function yearsToRetirement() {
    var target = Number(state.tsp.retirementYear) || defaultRetirementYear();
    return Math.max(0, Math.round(target - getCurrentYear()));
  }

  // Chart/table always run 5 years past the target retirement date so the
  // "5 years late" milestone has somewhere to land.
  function totalProjectionYears() {
    return yearsToRetirement() + 5;
  }

  // { early, target, late } as years-from-now; early is clamped to 0 so it
  // never goes negative when retirement is under 5 years away.
  function retirementMilestoneYears() {
    var t = yearsToRetirement();
    return { early: Math.max(0, t - 5), target: t, late: t + 5 };
  }

  function computeTSPProjection() {
    var currentBalance = Number(state.tsp.currentBalance) || 0;
    var monthlyContribution = Number(state.tsp.monthlyContribution) || 0;
    var years = totalProjectionYears();
    var annualContribution = monthlyContribution * 12;

    var result = {};
    TSP_SCENARIOS.forEach(function (scenario) {
      var rows = [{ year: 0, start: currentBalance, contributions: 0, growth: 0, end: currentBalance }];
      var balance = currentBalance;
      for (var y = 1; y <= years; y++) {
        var start = balance;
        var preGrowth = start + annualContribution;
        var end = preGrowth * (1 + scenario.rate);
        var growth = end - preGrowth;
        rows.push({ year: y, start: start, contributions: annualContribution, growth: growth, end: end });
        balance = end;
      }
      result[scenario.key] = rows;
    });
    return result;
  }

  function initTSPInputs() {
    var balance = document.getElementById("input-tsp-balance");
    var contribution = document.getElementById("input-tsp-contribution");
    var retirementYear = document.getElementById("input-tsp-retirement-year");

    balance.addEventListener("input", function () {
      state.tsp.currentBalance = parseFloat(balance.value) || 0;
      renderTSP();
      scheduleSave();
    });

    contribution.addEventListener("input", function () {
      state.tsp.monthlyContribution = parseFloat(contribution.value) || 0;
      renderTSP();
      scheduleSave();
    });

    retirementYear.addEventListener("input", function () {
      state.tsp.retirementYear = parseInt(retirementYear.value, 10) || null;
      renderTSP();
      scheduleSave();
    });

    var withdrawalRate = document.getElementById("input-tsp-withdrawal-rate");
    withdrawalRate.addEventListener("input", function () {
      state.tsp.withdrawalRate = parseFloat(withdrawalRate.value) || 4;
      renderTSP();
      scheduleSave();
    });

    var retirementGrowthRate = document.getElementById("input-tsp-retirement-growth-rate");
    retirementGrowthRate.addEventListener("input", function () {
      var v = parseFloat(retirementGrowthRate.value);
      state.tsp.retirementGrowthRate = isNaN(v) ? 4.5 : v;
      renderTSP();
      scheduleSave();
    });
  }

  function populateTSPInputs() {
    document.getElementById("input-tsp-balance").value = state.tsp.currentBalance || "";
    document.getElementById("input-tsp-contribution").value = state.tsp.monthlyContribution || "";
    if (!state.tsp.retirementYear) {
      state.tsp.retirementYear = defaultRetirementYear();
      scheduleSave();
    }
    document.getElementById("input-tsp-retirement-year").value = state.tsp.retirementYear;
    document.getElementById("input-tsp-withdrawal-rate").value = state.tsp.withdrawalRate || 4;
    document.getElementById("input-tsp-retirement-growth-rate").value =
      state.tsp.retirementGrowthRate != null ? state.tsp.retirementGrowthRate : 4.5;
  }

  function renderTSP() {
    var projection = computeTSPProjection();

    var yearsAway = yearsToRetirement();
    document.getElementById("tsp-years-away-note").textContent =
      yearsAway === 0 ? "That's this year." : (yearsAway + (yearsAway === 1 ? " year from now." : " years from now."));

    renderTSPMilestoneTable(projection);
    renderTSPBurnBox(projection);
    renderTSPBurndown(projection);
    drawTSPChart(document.getElementById("chart-tsp"), projection);
    renderFers();
    renderSS();
  }

  // Withdrawal rate is user-adjustable via the slider (defaults to 4%, the
  // common rule-of-thumb "safe withdrawal rate" for retirement savings -
  // roughly what you can draw out each year without running the balance down
  // faster than it historically grows). Based on the Expected (10%)
  // scenario's balance at your target retirement year - the same figure as
  // the milestone table's "Expected / Target Retirement" cell - rather than
  // showing three separate low/expected/high numbers here too.
  function renderTSPBurnBox(projection) {
    var m = retirementMilestoneYears();
    var balanceAtRetirement = projection.mid[m.target].end;
    var rate = (Number(state.tsp.withdrawalRate) || 4) / 100;
    var annualIncome = balanceAtRetirement * rate;
    document.getElementById("tsp-burn-value").textContent = fmt(annualIncome);
    document.getElementById("tsp-withdrawal-rate-display").textContent = pctStr(state.tsp.withdrawalRate || 4);
    document.getElementById("tsp-burn-note").textContent =
      "Based on " + fmt(balanceAtRetirement) + " projected in " + (getCurrentYear() + m.target) + ".";
  }

  // Simulates the balance draining down after retirement: each year, the
  // fixed annual withdrawal amount (the "Annual Income from TSP/401k"
  // figure above) comes OUT FIRST - you're living on that money through the
  // year, so it never gets a year of growth - and only what's left over
  // keeps compounding, at the conservative rate set by the slider below
  // (defaults to a bond-like 4.5%, standing in for a retirement portfolio
  // shifted toward the TSP's G/F Funds, rather than the stock-heavy 10%
  // assumption used for the accumulation phase above). Runs up to 50 years
  // past retirement or until the balance hits zero, whichever comes first -
  // long enough to cover a realistic retirement horizon without running
  // forever for low withdrawal rates that never actually deplete the
  // balance.
  function computeTSPBurndown(balanceAtRetirement, rate, growthRate) {
    var maxYears = 50;
    var withdrawal = balanceAtRetirement * rate;
    var rows = [{ year: 0, balance: balanceAtRetirement }];
    var balance = balanceAtRetirement;
    var depletedYear = null;
    for (var y = 1; y <= maxYears; y++) {
      var afterWithdrawal = balance - withdrawal;
      if (afterWithdrawal <= 0) {
        balance = 0;
        rows.push({ year: y, balance: balance });
        depletedYear = y;
        break;
      }
      balance = afterWithdrawal * (1 + growthRate);
      rows.push({ year: y, balance: balance });
    }
    return { rows: rows, depletedYear: depletedYear, withdrawal: withdrawal };
  }

  function renderTSPBurndown(projection) {
    var m = retirementMilestoneYears();
    var balanceAtRetirement = projection.mid[m.target].end;
    var rate = (Number(state.tsp.withdrawalRate) || 4) / 100;
    var growthRatePct = state.tsp.retirementGrowthRate != null ? Number(state.tsp.retirementGrowthRate) : 4.5;
    var growthRate = growthRatePct / 100;
    var retirementCalendarYear = getCurrentYear() + m.target;

    document.getElementById("tsp-retirement-growth-rate-display").textContent = pctStr(growthRatePct);

    var result = computeTSPBurndown(balanceAtRetirement, rate, growthRate);

    var note;
    if (result.depletedYear) {
      note = "At a " + pctStr(state.tsp.withdrawalRate || 4) + " withdrawal rate (" + fmt(result.withdrawal) +
        "/yr, taken out before that year's growth) and " + pctStr(growthRatePct) +
        " growth on the rest, your balance is projected to run out " + result.depletedYear +
        (result.depletedYear === 1 ? " year" : " years") + " into retirement, around " +
        (retirementCalendarYear + result.depletedYear) + ".";
    } else {
      note = "At a " + pctStr(state.tsp.withdrawalRate || 4) + " withdrawal rate (" + fmt(result.withdrawal) +
        "/yr, taken out before that year's growth), " + pctStr(growthRatePct) +
        " growth on the rest keeps outpacing your withdrawals - this balance is projected to keep growing rather than run out, at least through the next " +
        (result.rows.length - 1) + " years of retirement.";
    }
    document.getElementById("tsp-burndown-note").textContent = note;

    drawTSPBurndownChart(document.getElementById("chart-tsp-burndown"), result, retirementCalendarYear);
  }

  function drawTSPBurndownChart(canvas, result, retirementCalendarYear) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    var padLeft = 70, padRight = 20, padTop = 26, padBottom = 34;
    var chartW = W - padLeft - padRight;
    var chartH = H - padTop - padBottom;

    var rows = result.rows;
    var years = rows[rows.length - 1].year || 1;
    var maxVal = 0;
    rows.forEach(function (r) { maxVal = Math.max(maxVal, r.balance); });
    if (maxVal <= 0) maxVal = 1000;
    var magnitude = Math.pow(10, Math.floor(Math.log(maxVal) / Math.LN10));
    maxVal = Math.ceil(maxVal / magnitude) * magnitude;

    function xForYear(y) { return padLeft + (y / years) * chartW; }
    function yForVal(v) { return padTop + chartH - (v / maxVal) * chartH; }

    ctx.strokeStyle = themeColor("--slate-100");
    ctx.fillStyle = themeColor("--slate-400");
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    var divisions = 5;
    for (var i = 0; i <= divisions; i++) {
      var val = (maxVal / divisions) * i;
      var y = yForVal(val);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + chartW, y);
      ctx.stroke();
      ctx.fillText("$" + fmtShort(val), padLeft - 8, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xStep = years >= 20 ? 5 : (years >= 10 ? 2 : 1);
    for (var yr = 0; yr <= years; yr += xStep) {
      ctx.fillText((retirementCalendarYear + yr), xForYear(yr), padTop + chartH + 8);
    }

    if (result.depletedYear) {
      var dx = xForYear(result.depletedYear);
      ctx.strokeStyle = themeColor("--red") || "#d64545";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dx, padTop);
      ctx.lineTo(dx, padTop + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = themeColor("--red") || "#d64545";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.font = "10.5px sans-serif";
      ctx.fillText("Runs out", dx, padTop - 2);
    }

    ctx.strokeStyle = themeColor("--accent-dark") || "#2f6fed";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    rows.forEach(function (r, idx) {
      var x = xForYear(r.year);
      var yy = yForVal(r.balance);
      if (idx === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    });
    ctx.stroke();

    var last = rows[rows.length - 1];
    ctx.fillStyle = themeColor("--accent-dark") || "#2f6fed";
    ctx.beginPath();
    ctx.arc(xForYear(last.year), yForVal(last.balance), 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = themeColor("--slate-200");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop + chartH);
    ctx.lineTo(padLeft + chartW, padTop + chartH);
    ctx.stroke();
  }

  function renderTSPMilestoneTable(projection) {
    var m = retirementMilestoneYears();
    var currentYear = getCurrentYear();

    document.getElementById("tsp-milestone-early-label").textContent =
      m.target < 5 ? ("Today (" + currentYear + ")") : ("5 Years Early (" + (currentYear + m.early) + ")");
    document.getElementById("tsp-milestone-target-label").textContent = "Target Retirement (" + (currentYear + m.target) + ")";
    document.getElementById("tsp-milestone-late-label").textContent = "5 Years Late (" + (currentYear + m.late) + ")";

    TSP_SCENARIOS.forEach(function (s) {
      var rows = projection[s.key];
      document.getElementById("tsp-milestone-" + s.key + "-early").textContent = fmt(rows[m.early].end);
      document.getElementById("tsp-milestone-" + s.key + "-target").textContent = fmt(rows[m.target].end);
      document.getElementById("tsp-milestone-" + s.key + "-late").textContent = fmt(rows[m.late].end);
    });
  }

  function drawTSPChart(canvas, projection) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    var padLeft = 70, padRight = 20, padTop = 26, padBottom = 34;
    var chartW = W - padLeft - padRight;
    var chartH = H - padTop - padBottom;

    var years = totalProjectionYears();
    var maxVal = 0;
    TSP_SCENARIOS.forEach(function (s) {
      var rows = projection[s.key];
      maxVal = Math.max(maxVal, rows[rows.length - 1].end);
    });
    if (maxVal <= 0) maxVal = 1000;
    var magnitude = Math.pow(10, Math.floor(Math.log(maxVal) / Math.LN10));
    maxVal = Math.ceil(maxVal / magnitude) * magnitude;

    function xForYear(y) { return padLeft + (y / years) * chartW; }
    function yForVal(v) { return padTop + chartH - (v / maxVal) * chartH; }

    ctx.strokeStyle = themeColor("--slate-100");
    ctx.fillStyle = themeColor("--slate-400");
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    var divisions = 5;
    for (var i = 0; i <= divisions; i++) {
      var val = (maxVal / divisions) * i;
      var y = yForVal(val);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + chartW, y);
      ctx.stroke();
      ctx.fillText("$" + fmtShort(val), padLeft - 8, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xStep = years >= 20 ? 5 : (years >= 10 ? 2 : 1);
    for (var yr = 0; yr <= years; yr += xStep) {
      ctx.fillText("Yr " + yr, xForYear(yr), padTop + chartH + 8);
    }

    // milestone reference lines (5 years early / target retirement / 5 years late)
    var milestones = retirementMilestoneYears();
    var milestoneList = [
      { year: milestones.early, label: "-5" },
      { year: milestones.target, label: "Target" },
      { year: milestones.late, label: "+5" }
    ];
    ctx.strokeStyle = themeColor("--slate-400");
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.font = "10.5px sans-serif";
    milestoneList.forEach(function (m) {
      var x = xForYear(m.year);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + chartH);
      ctx.stroke();
      ctx.fillStyle = themeColor("--slate-600");
      ctx.fillText(m.label, x, padTop - 2);
    });
    ctx.setLineDash([]);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    TSP_SCENARIOS.forEach(function (s) {
      var rows = projection[s.key];
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      rows.forEach(function (r, idx) {
        var x = xForYear(r.year);
        var y = yForVal(r.end);
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      var last = rows[rows.length - 1];
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(xForYear(last.year), yForVal(last.end), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.strokeStyle = themeColor("--slate-200");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop + chartH);
    ctx.lineTo(padLeft + chartW, padTop + chartH);
    ctx.stroke();
  }

  // ---------- FERS pension estimate (global, not month-specific) ----------
  // A rough estimate of the FERS Basic Annuity: High-3 average salary x
  // years of creditable service x a multiplier (1% standard, or 1.1%
  // "enhanced" if retiring at 62+ with 20+ years of service - the one
  // eligibility rule this can't check automatically since there's no birth
  // date anywhere on this page, so a checkbox lets you say which applies to
  // you instead). Years of service is computed from your Service
  // Computation Date forward to each projected year, reusing the same
  // "years from now" axis as the 401K/TSP projection above and its
  // Projected Retirement Year field, so the two stay in sync automatically.

  var FERS_STANDARD_MULTIPLIER = 0.01;
  var FERS_ENHANCED_MULTIPLIER = 0.011;

  function parseDateInputValue(str) {
    if (!str) return null;
    var parts = String(str).split("-");
    if (parts.length !== 3) return null;
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
    if (!y || !m || !d) return null;
    var dt = new Date(y, m - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // Approximate calendar date "y" years from today (same month/day, y years
  // out) - matches the whole-year granularity yearsToRetirement() already
  // uses elsewhere on this tab.
  function dateYearsFromNow(y) {
    var d = new Date();
    d.setFullYear(d.getFullYear() + y);
    return d;
  }

  function yearsOfServiceAt(targetDate, scdDate) {
    if (!scdDate || !targetDate) return 0;
    var ms = targetDate.getTime() - scdDate.getTime();
    if (ms <= 0) return 0;
    return ms / (365.25 * 24 * 60 * 60 * 1000);
  }

  function computeFersProjection() {
    var scd = parseDateInputValue(state.fers.serviceCompDate);
    var high3 = Number(state.fers.high3) || 0;
    var years = totalProjectionYears();
    var rows = [];
    for (var y = 0; y <= years; y++) {
      var svc = yearsOfServiceAt(dateYearsFromNow(y), scd);
      rows.push({
        year: y,
        yearsOfService: svc,
        standard: high3 * FERS_STANDARD_MULTIPLIER * svc,
        enhanced: high3 * FERS_ENHANCED_MULTIPLIER * svc
      });
    }
    return rows;
  }

  function initFersInputs() {
    var scdInput = document.getElementById("input-fers-scd");
    if (!scdInput) return; // this page doesn't have the FERS section
    var high3Input = document.getElementById("input-fers-high3");
    var enhancedInput = document.getElementById("input-fers-enhanced-eligible");

    scdInput.addEventListener("input", function () {
      state.fers.serviceCompDate = scdInput.value;
      renderFers();
      scheduleSave();
    });

    high3Input.addEventListener("input", function () {
      state.fers.high3 = parseFloat(high3Input.value) || 0;
      renderFers();
      scheduleSave();
    });

    enhancedInput.addEventListener("change", function () {
      state.fers.enhancedEligible = enhancedInput.checked;
      renderFers();
      scheduleSave();
    });
  }

  function populateFersInputs() {
    var scdInput = document.getElementById("input-fers-scd");
    if (!scdInput) return;
    scdInput.value = state.fers.serviceCompDate || "";
    document.getElementById("input-fers-high3").value = state.fers.high3 || "";
    document.getElementById("input-fers-enhanced-eligible").checked = !!state.fers.enhancedEligible;
  }

  function renderFersPensionBox(projection) {
    var m = retirementMilestoneYears();
    var row = projection[m.target];
    var usingEnhanced = !!state.fers.enhancedEligible;
    var amount = usingEnhanced ? row.enhanced : row.standard;

    document.getElementById("fers-pension-value").textContent = fmt(amount);

    if (!state.fers.serviceCompDate) {
      document.getElementById("fers-pension-note").textContent = "Enter a Service Computation Date to calculate.";
      document.getElementById("fers-years-service-note").textContent = "";
      return;
    }

    var svcText = row.yearsOfService.toFixed(1) + (row.yearsOfService === 1 ? " year" : " years");
    document.getElementById("fers-pension-note").textContent =
      svcText + " of service by " + (getCurrentYear() + m.target) + ", using the " +
      (usingEnhanced ? "Enhanced (1.1%)" : "Standard (1%)") + " multiplier.";
    document.getElementById("fers-years-service-note").textContent =
      svcText + " of service by your target retirement year.";
  }

  function renderFersMilestoneTable(projection) {
    var m = retirementMilestoneYears();
    var currentYear = getCurrentYear();

    document.getElementById("fers-milestone-early-label").textContent =
      m.target < 5 ? ("Today (" + currentYear + ")") : ("5 Years Early (" + (currentYear + m.early) + ")");
    document.getElementById("fers-milestone-target-label").textContent = "Target Retirement (" + (currentYear + m.target) + ")";
    document.getElementById("fers-milestone-late-label").textContent = "5 Years Late (" + (currentYear + m.late) + ")";

    document.getElementById("fers-milestone-standard-early").textContent = fmt(projection[m.early].standard);
    document.getElementById("fers-milestone-standard-target").textContent = fmt(projection[m.target].standard);
    document.getElementById("fers-milestone-standard-late").textContent = fmt(projection[m.late].standard);

    document.getElementById("fers-milestone-enhanced-early").textContent = fmt(projection[m.early].enhanced);
    document.getElementById("fers-milestone-enhanced-target").textContent = fmt(projection[m.target].enhanced);
    document.getElementById("fers-milestone-enhanced-late").textContent = fmt(projection[m.late].enhanced);
  }

  function drawFersChart(canvas, projection) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    var padLeft = 70, padRight = 20, padTop = 26, padBottom = 34;
    var chartW = W - padLeft - padRight;
    var chartH = H - padTop - padBottom;

    var years = totalProjectionYears();
    var maxVal = 0;
    projection.forEach(function (r) { maxVal = Math.max(maxVal, r.standard, r.enhanced); });
    if (maxVal <= 0) maxVal = 1000;
    var magnitude = Math.pow(10, Math.floor(Math.log(maxVal) / Math.LN10));
    maxVal = Math.ceil(maxVal / magnitude) * magnitude;

    function xForYear(y) { return padLeft + (y / years) * chartW; }
    function yForVal(v) { return padTop + chartH - (v / maxVal) * chartH; }

    ctx.strokeStyle = themeColor("--slate-100");
    ctx.fillStyle = themeColor("--slate-400");
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    var divisions = 5;
    for (var i = 0; i <= divisions; i++) {
      var val = (maxVal / divisions) * i;
      var y = yForVal(val);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + chartW, y);
      ctx.stroke();
      ctx.fillText("$" + fmtShort(val), padLeft - 8, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xStep = years >= 20 ? 5 : (years >= 10 ? 2 : 1);
    for (var yr = 0; yr <= years; yr += xStep) {
      ctx.fillText("Yr " + yr, xForYear(yr), padTop + chartH + 8);
    }

    var milestones = retirementMilestoneYears();
    var milestoneList = [
      { year: milestones.early, label: "-5" },
      { year: milestones.target, label: "Target" },
      { year: milestones.late, label: "+5" }
    ];
    ctx.strokeStyle = themeColor("--slate-400");
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.font = "10.5px sans-serif";
    milestoneList.forEach(function (m) {
      var x = xForYear(m.year);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + chartH);
      ctx.stroke();
      ctx.fillStyle = themeColor("--slate-600");
      ctx.fillText(m.label, x, padTop - 2);
    });
    ctx.setLineDash([]);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    // Same color convention as the Low/High TSP scenario lines, so the
    // visual language matches between the two charts on this tab.
    var lines = [
      { key: "standard", color: "#8996ab" },
      { key: "enhanced", color: "#1f9d55" }
    ];
    lines.forEach(function (line) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      projection.forEach(function (r, idx) {
        var x = xForYear(r.year);
        var y = yForVal(r[line.key]);
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      var last = projection[projection.length - 1];
      ctx.fillStyle = line.color;
      ctx.beginPath();
      ctx.arc(xForYear(last.year), yForVal(last[line.key]), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.strokeStyle = themeColor("--slate-200");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop + chartH);
    ctx.lineTo(padLeft + chartW, padTop + chartH);
    ctx.stroke();
  }

  function renderFers() {
    if (!document.getElementById("fers-pension-value")) return; // this page doesn't have the FERS section
    var projection = computeFersProjection();
    renderFersPensionBox(projection);
    renderFersMilestoneTable(projection);
    drawFersChart(document.getElementById("chart-fers"), projection);
    renderTotalRetirementIncome();
  }

  // ---------- Social Security (global, not month-specific) ----------
  // Deliberately simple: rather than re-deriving a full AIME/bend-point
  // calculation (which needs a complete 35-year, wage-indexed earnings
  // history), this takes the benefit estimate straight from your own
  // Social Security statement (ssa.gov/myaccount - "your estimated benefit
  // at Full Retirement Age") and applies Social Security's own published
  // adjustment rules for claiming earlier or later than that:
  //   - Early (as far back as 62): -5/9 of 1% per month for the first 36
  //     months early, then -5/12 of 1% per month beyond that.
  //   - Delayed (up to 70): +2/3 of 1% per month (8%/year) past Full
  //     Retirement Age.
  // These are the same percentages SSA itself uses, just applied to a
  // benefit you already know rather than one estimated from scratch.

  function computeSSAnnual() {
    var monthlyAtFRA = Number(state.ss.monthlyAtFRA) || 0;
    var fra = Number(state.ss.fullRetirementAge) || 67;
    var claimAge = Number(state.ss.claimingAge) || fra;

    var monthsEarly = Math.max(0, (fra - claimAge) * 12);
    var monthsLate = Math.max(0, (claimAge - fra) * 12);

    var adjustedMonthly = monthlyAtFRA;
    var note = "at your Full Retirement Age benefit (claiming at " + fra + ").";

    if (monthsEarly > 0) {
      var first36 = Math.min(monthsEarly, 36);
      var remainder = Math.max(0, monthsEarly - 36);
      var reductionPct = (first36 * (5 / 9) + remainder * (5 / 12)) / 100;
      adjustedMonthly = monthlyAtFRA * (1 - reductionPct);
      note = "reduced " + pctStr(reductionPct * 100) + " for claiming at " + claimAge +
        " (" + (monthsEarly / 12).toFixed(1) + " years before Full Retirement Age).";
    } else if (monthsLate > 0) {
      var increasePct = (monthsLate * (2 / 3)) / 100;
      adjustedMonthly = monthlyAtFRA * (1 + increasePct);
      note = "increased " + pctStr(increasePct * 100) + " for claiming at " + claimAge +
        " (" + (monthsLate / 12).toFixed(1) + " years past Full Retirement Age).";
    }

    return { monthly: adjustedMonthly, annual: adjustedMonthly * 12, note: note };
  }

  function initSSInputs() {
    var monthlyInput = document.getElementById("input-ss-monthly-fra");
    if (!monthlyInput) return; // this page doesn't have the Social Security section
    var fraInput = document.getElementById("input-ss-fra");
    var claimInput = document.getElementById("input-ss-claim-age");

    monthlyInput.addEventListener("input", function () {
      state.ss.monthlyAtFRA = parseFloat(monthlyInput.value) || 0;
      renderSS();
      scheduleSave();
    });

    fraInput.addEventListener("input", function () {
      state.ss.fullRetirementAge = parseFloat(fraInput.value) || 67;
      renderSS();
      scheduleSave();
    });

    claimInput.addEventListener("input", function () {
      state.ss.claimingAge = parseFloat(claimInput.value) || state.ss.fullRetirementAge || 67;
      renderSS();
      scheduleSave();
    });
  }

  function populateSSInputs() {
    var monthlyInput = document.getElementById("input-ss-monthly-fra");
    if (!monthlyInput) return;
    monthlyInput.value = state.ss.monthlyAtFRA || "";
    document.getElementById("input-ss-fra").value = state.ss.fullRetirementAge || 67;
    document.getElementById("input-ss-claim-age").value = state.ss.claimingAge || state.ss.fullRetirementAge || 67;
  }

  function renderSS() {
    var valueEl = document.getElementById("ss-annual-value");
    if (!valueEl) return; // this page doesn't have the Social Security section
    var result = computeSSAnnual();
    valueEl.textContent = fmt(result.annual);
    document.getElementById("ss-annual-note").textContent = fmt(result.monthly) + "/mo, " + result.note;
    renderTotalRetirementIncome();
  }

  // Annual income from TSP/401k, the estimated FERS pension, and Social
  // Security, combined - all three already independently recalculated
  // above, so this just adds them together at the same target retirement
  // year (Social Security isn't tied to the TSP retirement year the same
  // way, but uses your own claiming age input instead).
  function renderTotalRetirementIncome() {
    var valueEl = document.getElementById("total-retirement-income-value");
    if (!valueEl) return; // this page doesn't have the FERS section

    var m = retirementMilestoneYears();

    var tspProjection = computeTSPProjection();
    var balanceAtRetirement = tspProjection.mid[m.target].end;
    var withdrawalRate = (Number(state.tsp.withdrawalRate) || 4) / 100;
    var tspIncome = balanceAtRetirement * withdrawalRate;

    var fersProjection = computeFersProjection();
    var fersRow = fersProjection[m.target];
    var fersIncome = state.fers.enhancedEligible ? fersRow.enhanced : fersRow.standard;

    var ssIncome = computeSSAnnual().annual;

    valueEl.textContent = fmt(tspIncome + fersIncome + ssIncome);
    document.getElementById("total-retirement-income-note").textContent =
      fmt(tspIncome) + " TSP/401k + " + fmt(fersIncome) + " FERS + " + fmt(ssIncome) + " Social Security.";
  }

  // ---------- accounts ----------

  // Accounts aren't tied to any month - it's a single running list of
  // login/account info you want to keep track of (site, username,
  // password, cost, notes). Stored in plain text in data.json, same as
  // everything else this app saves - see the note in the chat reply.
  // Cards collapse down to just the account name; clicking the name (or
  // its chevron) expands it. The list itself always sorts alphabetically
  // by name, re-applied whenever a card is added, removed, or a name
  // field loses focus (not on every keystroke, so typing doesn't jump
  // the card around mid-edit).
  var expandedAccountIds = {};

  function buildAccountFieldRow(labelText, type, acct, field, placeholder) {
    var row = document.createElement("label");
    row.className = "account-field-row";
    var labelEl = document.createElement("span");
    labelEl.className = "account-field-label";
    labelEl.textContent = labelText;
    var input = document.createElement("input");
    input.type = type;
    input.value = acct[field] || "";
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("input", function () {
      acct[field] = input.value;
      scheduleSave();
    });
    row.appendChild(labelEl);
    row.appendChild(input);
    return row;
  }

  function buildAccountPasswordRow(acct) {
    var row = document.createElement("label");
    row.className = "account-field-row";
    var labelEl = document.createElement("span");
    labelEl.className = "account-field-label";
    labelEl.textContent = "Password";

    var wrap = document.createElement("div");
    wrap.className = "password-wrap";
    var input = document.createElement("input");
    input.type = "password";
    input.value = acct.password || "";
    input.addEventListener("input", function () {
      acct.password = input.value;
      scheduleSave();
    });
    var toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "toggle-password-btn";
    toggleBtn.textContent = "Show";
    toggleBtn.addEventListener("click", function () {
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggleBtn.textContent = showing ? "Show" : "Hide";
    });

    wrap.appendChild(input);
    wrap.appendChild(toggleBtn);
    row.appendChild(labelEl);
    row.appendChild(wrap);
    return row;
  }

  function buildAccountCostRow(acct) {
    var row = document.createElement("label");
    row.className = "account-field-row";
    var labelEl = document.createElement("span");
    labelEl.className = "account-field-label";
    labelEl.textContent = "Cost";
    var costWrap = buildCurrencyInput(acct.cost, function (val) {
      acct.cost = val;
      scheduleSave();
    });
    row.appendChild(labelEl);
    row.appendChild(costWrap);
    return row;
  }

  function buildAccountNameFieldRow(acct) {
    var row = document.createElement("label");
    row.className = "account-field-row";
    var labelEl = document.createElement("span");
    labelEl.className = "account-field-label";
    labelEl.textContent = "Account Name";
    var input = document.createElement("input");
    input.type = "text";
    input.value = acct.name || "";
    input.addEventListener("input", function () {
      acct.name = input.value;
      scheduleSave();
    });
    input.addEventListener("blur", function () {
      // Re-sort (and refresh the collapsed label) once you're done editing
      // the name, rather than on every keystroke.
      renderAccountsStructure();
    });
    row.appendChild(labelEl);
    row.appendChild(input);
    return row;
  }

  function buildAccountCard(acct) {
    var expanded = !!expandedAccountIds[acct.id];

    var card = document.createElement("div");
    card.className = "account-card" + (expanded ? " expanded" : "");

    var header = document.createElement("div");
    header.className = "account-card-header";

    var expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "expand-btn" + (expanded ? " open" : "");
    expandBtn.innerHTML = "&#9656;";
    expandBtn.title = expanded ? "Collapse" : "Expand";

    var nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "account-name-toggle";
    nameBtn.textContent = acct.name || "New Account";
    nameBtn.title = expanded ? "Collapse" : "Expand";

    function toggle() {
      expandedAccountIds[acct.id] = !expandedAccountIds[acct.id];
      renderAccountsStructure();
    }
    expandBtn.addEventListener("click", toggle);
    nameBtn.addEventListener("click", toggle);

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-item-btn";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove account";
    removeBtn.addEventListener("click", function () {
      var ok = confirm('Remove "' + (acct.name || "this account") + '"? This can\'t be undone.');
      if (!ok) return;
      var idx = state.accounts.indexOf(acct);
      if (idx > -1) state.accounts.splice(idx, 1);
      delete expandedAccountIds[acct.id];
      renderAccountsStructure();
      scheduleSave();
    });

    header.appendChild(expandBtn);
    header.appendChild(nameBtn);
    header.appendChild(removeBtn);
    card.appendChild(header);

    if (expanded) {
      var fieldsGrid = document.createElement("div");
      fieldsGrid.className = "account-fields-grid";
      fieldsGrid.appendChild(buildAccountNameFieldRow(acct));
      fieldsGrid.appendChild(buildAccountFieldRow("Web Address", "text", acct, "url", "https://example.com"));
      fieldsGrid.appendChild(buildAccountFieldRow("Username", "text", acct, "username", ""));
      fieldsGrid.appendChild(buildAccountPasswordRow(acct));
      fieldsGrid.appendChild(buildAccountCostRow(acct));
      card.appendChild(fieldsGrid);

      var descRow = document.createElement("div");
      descRow.className = "account-desc-row";
      var descLabel = document.createElement("span");
      descLabel.className = "account-field-label";
      descLabel.textContent = "Description / Notes";
      var descArea = document.createElement("textarea");
      descArea.rows = 3;
      descArea.placeholder = "Anything else worth remembering about this account…";
      descArea.value = acct.description || "";
      descArea.addEventListener("input", function () {
        acct.description = descArea.value;
        scheduleSave();
      });
      descRow.appendChild(descLabel);
      descRow.appendChild(descArea);
      card.appendChild(descRow);
    }

    return card;
  }

  function sortAccounts() {
    state.accounts.sort(function (a, b) {
      return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
    });
  }

  function renderAccountsStructure() {
    var container = document.getElementById("accounts-list");
    if (!container) return;
    container.innerHTML = "";

    sortAccounts();

    if (!state.accounts.length) {
      var empty = document.createElement("p");
      empty.className = "card-hint";
      empty.textContent = "No accounts yet - click “+ Add Account” to start keeping track of one.";
      container.appendChild(empty);
    }

    state.accounts.forEach(function (acct) {
      container.appendChild(buildAccountCard(acct));
    });
  }

  function initAccountsTab() {
    var addBtn = document.getElementById("add-account-btn");
    if (!addBtn) return;
    addBtn.addEventListener("click", function () {
      var acct = { id: nextId(), name: "New Account", url: "", username: "", password: "", cost: 0, description: "" };
      state.accounts.push(acct);
      expandedAccountIds[acct.id] = true; // open right away so it's ready to fill in
      renderAccountsStructure();
      scheduleSave();
    });
  }

  // ---------- init ----------

  function init() {
    initTabs();
    initMonthBar();
    initIncomeAddButton();
    initTSPInputs();
    initFersInputs();
    initSSInputs();
    initReceiptModal();
    initStatementImport();
    initBudgetSettingsMenu();
    initClearDataModal();
    initAccountsTab();

    fetch("/api/data")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state = data || {};
        if (!state.months) state.months = {};
        if (!state.tsp) state.tsp = { currentBalance: 0, monthlyContribution: 0, retirementYear: null, withdrawalRate: 4 };
        if (!state.tsp.withdrawalRate) state.tsp.withdrawalRate = 4;
        if (state.tsp.retirementGrowthRate == null) state.tsp.retirementGrowthRate = 4.5;
        if (!state.fers) state.fers = { serviceCompDate: "", high3: 0, enhancedEligible: false };
        if (!state.ss) state.ss = { monthlyAtFRA: 0, fullRetirementAge: 67, claimingAge: 67 };
        if (!state.accounts) state.accounts = [];
        if (!state.nextId) state.nextId = 1;
        if (!state.activeMonth) state.activeMonth = todayMonthKey();
        delete state.taxPrep; // Tax Prep section was removed; drop its leftover saved data

        ensureMonth(state.activeMonth);

        renderMonthBar();
        renderIncomeStructure();
        renderExpensesStructure();
        renderSavingsStructure();
        renderDashboard();
        renderTrends();
        populateTSPInputs();
        populateFersInputs();
        populateSSInputs();
        renderTSP();
        renderAccountsStructure();
        setSaveStatus("All changes saved");
      })
      .catch(function () {
        setSaveStatus("Could not load data from the server");
      });

    // Canvas charts bake in resolved colors at draw time (see themeColor
    // above), so a theme toggle needs an explicit redraw to pick up the
    // new palette - CSS alone only handles the non-canvas UI.
    window.addEventListener("themechange", function () {
      if (!state || !state.months) return;
      renderDashboard();
      renderTrends();
      renderTSP();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
