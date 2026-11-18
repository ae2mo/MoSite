/* Home/Car Maintenance - client logic.
   Talks to /api/maintenance-data (GET to load, POST to save the whole blob).

   Data model:
   state = {
     home: { tasks: [{id, name, category, partNumber, size, notes, intervalMonths,
                      lastDone, history: [{id, date, notes}]}],
             plans: [{id, title, notes, targetDate, priority, done}] },
     cars: [{id, name, vin, odometer, odometerDate, odometerLog: [{date, miles}],
             items: [{id, name, intervalMiles, intervalMonths, lastMiles, lastDate,
                      partNumber, notes, history: [{id, date, miles, notes}]}],
             plans: [same as home plans]}],
     activeCar: <car id>,
     nextId: <counter>
   } */

(function () {
  "use strict";

  var state = null;
  var saveTimer = null;
  var openLogForms = {}; // entry id -> true while its "Log it" form is open

  // Cards start collapsed (just the title, status badge and due line). Which
  // ones the user has opened is remembered per browser.
  var expanded = {};
  try { expanded = JSON.parse(localStorage.getItem("maint-expanded") || "{}") || {}; } catch (e) { expanded = {}; }
  function saveExpanded() {
    try { localStorage.setItem("maint-expanded", JSON.stringify(expanded)); } catch (e) { /* ignore */ }
  }
  function expandNew(id) { expanded[id] = true; saveExpanded(); }

  // Adds a chevron button to a card's title row that shows/hides the details.
  function makeCollapsible(card, top, id) {
    var btn = el("button", { type: "button", class: "collapse-btn", title: "Expand / collapse" });
    function apply() {
      var open = !!expanded[id];
      card.classList.toggle("collapsed", !open);
      btn.textContent = open ? "▾" : "▸";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    btn.addEventListener("click", function () {
      expanded[id] = !expanded[id];
      if (!expanded[id]) delete expanded[id];
      saveExpanded();
      apply();
    });
    apply();
    top.insertBefore(btn, top.firstChild);
  }

  // Unit for the "odometer" of a vehicle: miles by default, hours for equipment.
  function unitOf(car) { return car && car.unit === "hours" ? "hr" : "mi"; }
  function unitWord(car) { return car && car.unit === "hours" ? "hours" : "miles"; }

  // ---------- helpers ----------

  function el(tag, props, kids) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === "text") node.textContent = props[k];
        else if (k === "html") node.innerHTML = props[k];
        else if (k === "class") node.className = props[k];
        else node[k] = props[k];
      });
    }
    (kids || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function setSaveStatus(text) {
    var s = document.getElementById("save-status");
    if (s) s.textContent = text;
  }

  function scheduleSave() {
    setSaveStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch("/api/maintenance-data", {
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

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ---------- activity history ----------
  // Every action (adding/removing/editing an item, logging a service,
  // odometer changes, planned work) is appended to state.activity with a
  // timestamp, and never edited or deleted afterwards - it's the permanent
  // record for future reference. scope is "home" or a car's id.

  // Only completions are kept in the history (jobs logged as done, planned
  // items marked complete). Other actions - adding, editing, removing - just
  // trigger a save via logAction() and aren't recorded.
  function logCompletion(scope, text, carName) {
    if (!state.activity) state.activity = [];
    state.activity.push({ id: nextId(), ts: new Date().toISOString(), kind: "completion", scope: scope, car: carName || "", text: text });
    scheduleSave();
  }

  function logAction() {
    scheduleSave();
  }

  function shorten(v) {
    v = String(v == null ? "" : v);
    return v.length > 60 ? v.slice(0, 57) + "…" : v;
  }

  // Builds an opts.audit callback that records a field edit once it's committed.
  function aud(scope, entry, label, carName) {
    return function (v) {
      logAction(scope, 'Updated ' + label + ' on "' + (entry.name || entry.title || "item") + '"' + (v !== "" ? ' → ' + shorten(v) : " (cleared)"), carName);
    };
  }

  function activityFor(scope) {
    return (state.activity || []).filter(function (a) { return a.scope === scope && a.kind === "completion"; })
      .sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
  }

  function fmtStamp(ts) {
    var d = new Date(ts);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function renderActivity(container, scope) {
    container.innerHTML = "";
    var items = activityFor(scope);
    if (!items.length) {
      container.appendChild(el("p", { class: "empty-note", text: "No activity recorded yet." }));
      return;
    }
    var ul = el("ul", { class: "history-list activity-list" });
    items.forEach(function (a) {
      var li = el("li");
      li.appendChild(el("span", { class: "hist-date activity-ts", text: fmtStamp(a.ts) }));
      li.appendChild(el("span", { text: a.text }));
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  // ---------- printable logbook (Print → Save as PDF) ----------

  var PRINT_CSS =
    "body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:12px}" +
    "h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:22px 0 8px;border-bottom:2px solid #333;padding-bottom:3px}" +
    ".sub{color:#555;margin-bottom:10px}" +
    ".entry{border:1px solid #999;border-radius:4px;padding:8px 10px;margin:0 0 10px;page-break-inside:avoid}" +
    ".entry h3{margin:0 0 4px;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px}" +
    ".lbl{color:#555}.badge{float:right;font-size:11px;font-weight:bold}" +
    "table{border-collapse:collapse;width:100%;margin-top:5px}th,td{border:1px solid #bbb;padding:3px 6px;text-align:left;vertical-align:top}" +
    "th{background:#eee}.cat{font-weight:bold;margin:12px 0 4px;text-transform:uppercase;font-size:11px;color:#444}" +
    ".none{color:#777;font-style:italic}";

  function row(label, value) {
    if (value == null || value === "") return "";
    return '<div><span class="lbl">' + escapeHtml(label) + ":</span> " + escapeHtml(value) + "</div>";
  }

  function histTable(history, withMiles) {
    if (!history || !history.length) return '<div class="none">No log entries yet.</div>';
    var rows = history.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (h) {
      return "<tr><td>" + escapeHtml(prettyDate(h.date)) + "</td>" +
        (withMiles ? "<td>" + (h.miles != null ? fmtMiles(h.miles) : "") + "</td>" : "") +
        "<td>" + escapeHtml(h.notes || "") + "</td></tr>";
    }).join("");
    return "<table><tr><th>Date</th>" + (withMiles ? "<th>Odometer</th>" : "") + "<th>Notes</th></tr>" + rows + "</table>";
  }

  function plansHtml(plans) {
    if (!plans || !plans.length) return '<div class="none">Nothing planned.</div>';
    return "<table><tr><th>Done</th><th>Item</th><th>Target</th><th>Priority</th><th>Notes</th></tr>" +
      plans.map(function (p) {
        return "<tr><td>" + (p.done ? "Yes" : "") + "</td><td>" + escapeHtml(p.title) + "</td><td>" +
          escapeHtml(p.targetDate ? prettyDate(p.targetDate) : "") + "</td><td>" + escapeHtml(p.priority || "") +
          "</td><td>" + escapeHtml(p.notes || "") + "</td></tr>";
      }).join("") + "</table>";
  }

  function activityHtml(scope) {
    var items = activityFor(scope);
    if (!items.length) return '<div class="none">No activity recorded.</div>';
    return "<table><tr><th>When</th><th>Action</th></tr>" + items.map(function (a) {
      return "<tr><td>" + escapeHtml(fmtStamp(a.ts)) + "</td><td>" + escapeHtml(a.text) + "</td></tr>";
    }).join("") + "</table>";
  }

  function printHtml(title, bodyHtml) {
    var frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(frame);
    var doc = frame.contentWindow.document;
    doc.open();
    doc.write("<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + escapeHtml(title) + "</title><style>" + PRINT_CSS + "</style></head><body>" + bodyHtml + "</body></html>");
    doc.close();
    setTimeout(function () {
      frame.contentWindow.focus();
      frame.contentWindow.print(); // choose "Save as PDF" as the destination
      setTimeout(function () { document.body.removeChild(frame); }, 2000);
    }, 300);
  }

  function printHomeLogbook() {
    var html = "<h1>Home Maintenance Logbook</h1><div class='sub'>Printed " + escapeHtml(prettyDate(new Date())) + "</div>";
    html += "<h2>Maintenance Items</h2>";
    var groups = {};
    state.home.tasks.forEach(function (t) { (groups[t.category || "General"] = groups[t.category || "General"] || []).push(t); });
    Object.keys(groups).sort().forEach(function (cat) {
      html += "<div class='cat'>" + escapeHtml(cat) + "</div>";
      groups[cat].forEach(function (t) {
        var info = homeDueInfo(t);
        html += "<div class='entry'><span class='badge'>" + escapeHtml(info.label) + "</span><h3>" + escapeHtml(t.name) + "</h3><div class='grid'>" +
          row("Parts", partsText(t)) + row("Size / spec", t.size) +
          row("Repeat every", t.intervalMonths ? t.intervalMonths + " months" : "") +
          row("Last done", t.lastDone ? prettyDate(t.lastDone) : "") + row("Status", info.text) +
          "</div>" + row("Other info", t.notes) + histTable(t.history, false) + "</div>";
      });
    });
    if (!state.home.tasks.length) html += "<div class='none'>No maintenance items.</div>";
    html += "<h2>Planned Projects</h2>" + plansHtml(state.home.plans);
    printHtml("Home Maintenance Logbook", html);
  }

  function printCarLogbook(car) {
    var html = "<h1>" + escapeHtml(car.name || "Car") + " — Maintenance Logbook</h1><div class='sub'>Printed " +
      escapeHtml(prettyDate(new Date())) + (car.vin ? " · VIN/Plate: " + escapeHtml(car.vin) : "") +
      " · Odometer: " + fmtMiles(car.odometer) + " mi" + (car.odometerDate ? " (as of " + escapeHtml(prettyDate(car.odometerDate)) + ")" : "") + "</div>";
    html += "<h2>Service Items</h2>";
    car.items.forEach(function (i) {
      var info = carItemInfo(car, i);
      html += "<div class='entry'><span class='badge'>" + escapeHtml(info.label) + "</span><h3>" + escapeHtml(i.name) + "</h3><div class='grid'>" +
        row("Recommended every", [i.intervalMiles ? fmtMiles(i.intervalMiles) + " mi" : "", i.intervalMonths ? i.intervalMonths + " mo" : ""].filter(Boolean).join(" / ")) +
        row("Last done", [i.lastMiles != null ? fmtMiles(i.lastMiles) + " mi" : "", i.lastDate ? prettyDate(i.lastDate) : ""].filter(Boolean).join(" · ")) +
        row("Parts", partsText(i)) + row("Status", info.text) +
        "</div>" + row("Other info", i.notes) + histTable(i.history, true) + "</div>";
    });
    if (!car.items.length) html += "<div class='none'>No service items.</div>";
    html += "<h2>Manufacturer Inspections &amp; Checks</h2>";
    (car.inspections || []).forEach(function (i) {
      var info = carItemInfo(car, i);
      html += "<div class='entry'><span class='badge'>" + escapeHtml(info.label) + "</span><h3>" + escapeHtml(i.name) + "</h3><div class='grid'>" +
        row("Recommended every", [i.intervalMiles ? fmtMiles(i.intervalMiles) + " " + unitOf(car) : "", i.intervalMonths ? i.intervalMonths + " mo" : ""].filter(Boolean).join(" / ")) +
        row("Last done", [i.lastMiles != null ? fmtMiles(i.lastMiles) + " " + unitOf(car) : "", i.lastDate ? prettyDate(i.lastDate) : ""].filter(Boolean).join(" · ")) +
        row("Status", info.text) +
        "</div>" + row("Other info", i.notes) + histTable(i.history, true) + "</div>";
    });
    if (!(car.inspections || []).length) html += "<div class='none'>No inspections.</div>";
    html += "<h2>Odometer Readings</h2>";
    var log = (car.odometerLog || []).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    html += log.length
      ? "<table><tr><th>Date</th><th>Miles</th></tr>" + log.map(function (o) { return "<tr><td>" + escapeHtml(prettyDate(o.date)) + "</td><td>" + fmtMiles(o.miles) + "</td></tr>"; }).join("") + "</table>"
      : "<div class='none'>No readings recorded.</div>";
    html += "<h2>Planned Work</h2>" + plansHtml(car.plans);
    printHtml((car.name || "Car") + " Maintenance Logbook", html);
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function isoDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function todayISO() { return isoDate(new Date()); }

  function parseISO(s) {
    if (!s) return null;
    var p = s.split("-");
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  function addMonthsTo(dateStr, months) {
    var d = parseISO(dateStr);
    if (!d || !months) return null;
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + Math.round(months));
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }

  function prettyDate(d) {
    if (!d) return "—";
    if (typeof d === "string") d = parseISO(d);
    return d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
  }

  function daysUntil(d) {
    var t = new Date();
    t.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - t.getTime()) / 86400000);
  }

  function fmtMiles(n) {
    return Math.round(Number(n) || 0).toLocaleString("en-US");
  }

  function numOrNull(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  // A labelled input/select/textarea used on every logbook entry.
  function field(label, value, onChange, opts) {
    opts = opts || {};
    var wrap = el("div", { class: "entry-field" + (opts.wide ? " wide" : "") });
    wrap.appendChild(el("label", { text: label }));
    var input;
    if (opts.textarea) {
      input = el("textarea", { rows: 2, value: value == null ? "" : value });
    } else {
      input = el("input", { type: opts.type || "text", value: value == null ? "" : value });
      if (opts.step) input.step = opts.step;
      if (opts.min != null) input.min = opts.min;
    }
    if (opts.readOnly) { input.disabled = true; input.title = "Taken from the latest logbook entry"; }
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.list) input.setAttribute("list", opts.list);
    input.addEventListener(opts.onChangeEvent ? "change" : "input", function () { onChange(input.value); });
    if (opts.audit) input.addEventListener("change", function () { opts.audit(input.value); });
    wrap.appendChild(input);
    return wrap;
  }

  // Parts list for a task card: any number of rows, each a label (what it
  // is - "Oil", "Filter") and a part number / spec ("0W-20 synthetic",
  // "PF66"). Edits save as you type; rows are added/removed in place.
  function partsEditor(entry) {
    if (!entry.parts) entry.parts = [];
    var wrap = el("div", { class: "entry-field wide parts-editor" });
    wrap.appendChild(el("label", { text: "Parts / fluids (part number or spec)" }));
    var list = el("div", { class: "parts-list" });
    wrap.appendChild(list);

    function addRow(part) {
      var row = el("div", { class: "part-row" });
      var label = el("input", { type: "text", value: part.label || "", placeholder: "What (e.g. Oil, Filter)" });
      label.addEventListener("input", function () { part.label = label.value; scheduleSave(); });
      var number = el("input", { type: "text", value: part.number || "", placeholder: "Part number / spec (e.g. 0W-20, PF66)" });
      number.addEventListener("input", function () { part.number = number.value; scheduleSave(); });
      var shop = el("button", { type: "button", class: "entry-btn part-shop", text: "Amazon", title: "Search Amazon for this part number" });
      shop.addEventListener("click", function () {
        var q = (part.number || "").trim();
        if (!q) { number.focus(); return; }
        window.open("https://www.amazon.com/s?k=" + encodeURIComponent(q), "_blank", "noopener");
      });
      var qty = el("input", { type: "text", value: part.qty || "", placeholder: "Qty (e.g. 7 qt, 1)" });
      qty.addEventListener("input", function () { part.qty = qty.value; scheduleSave(); });
      var del = el("button", { type: "button", class: "hist-del part-del", title: "Remove this part", html: "&times;" });
      del.addEventListener("click", function () {
        entry.parts = entry.parts.filter(function (p) { return p !== part; });
        list.removeChild(row);
        scheduleSave();
      });
      row.appendChild(label);
      row.appendChild(number);
      row.appendChild(shop);
      row.appendChild(qty);
      row.appendChild(del);
      list.appendChild(row);
      return label;
    }

    entry.parts.forEach(addRow);
    var add = el("button", { type: "button", class: "entry-btn", text: "+ Add part" });
    add.addEventListener("click", function () {
      var part = { id: nextId(), label: "", number: "", qty: "" };
      entry.parts.push(part);
      addRow(part).focus();
      scheduleSave();
    });
    wrap.appendChild(add);
    return wrap;
  }

  function partsText(entry) {
    return (entry.parts || []).filter(function (p) { return p.label || p.number || p.qty; }).map(function (p) {
      return (p.label ? p.label + ": " : "") + (p.number || "") + (p.qty ? " (qty " + p.qty + ")" : "");
    }).join("; ");
  }

  function historyList(entry, onChange, showMiles) {
    var ul = el("ul", { class: "history-list" });
    var items = (entry.history || []).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    items.forEach(function (h) {
      var li = el("li");
      li.appendChild(el("span", { class: "hist-date", text: prettyDate(h.date) }));
      var txt = [];
      if (showMiles && h.miles != null) txt.push(fmtMiles(h.miles) + " mi");
      if (h.notes) txt.push(h.notes);
      li.appendChild(el("span", { text: txt.join(" — ") }));
      var del = el("button", { type: "button", class: "hist-del", title: "Delete this log entry", html: "&times;" });
      del.addEventListener("click", function () {
        entry.history = entry.history.filter(function (x) { return x.id !== h.id; });
        onChange();
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
    return ul;
  }

  // ---------- tabs ----------

  function initTabs() {
    var buttons = document.querySelectorAll(".tab-btn");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        buttons.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("active"); });
        document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
      });
    });
  }

  // ---------- planned projects (shared by Home and each car) ----------

  function renderPlans(container, plans, rerender, scope, carName) {
    container.innerHTML = "";
    if (!plans.length) {
      container.appendChild(el("p", { class: "empty-note", text: "Nothing planned yet." }));
      return;
    }
    var sorted = plans.slice().sort(function (a, b) {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      return (a.targetDate || "9999") < (b.targetDate || "9999") ? -1 : 1;
    });
    sorted.forEach(function (plan) {
      var card = el("div", { class: "log-entry-card" + (plan.done ? " status-done" : "") });

      var top = el("div", { class: "entry-top" });
      var check = el("input", { type: "checkbox", class: "plan-done-check", checked: !!plan.done, title: "Mark done" });
      check.addEventListener("change", function () {
        plan.done = check.checked;
        if (plan.done) logCompletion(scope, 'Completed planned item "' + (plan.title || "untitled") + '"', carName);
        else logAction();
        rerender();
      });
      var title = el("input", { type: "text", class: "entry-name", value: plan.title || "", placeholder: "What needs doing?" });
      makeCollapsible(card, top, plan.id);
      title.addEventListener("input", function () { plan.title = title.value; scheduleSave(); });
      title.addEventListener("change", function () { logAction(scope, 'Planned item named "' + shorten(plan.title) + '"', carName); });
      var del = el("button", { type: "button", class: "entry-btn danger", text: "Remove" });
      del.addEventListener("click", function () {
        if (!confirm('Remove "' + (plan.title || "this item") + '"?')) return;
        var idx = plans.indexOf(plan);
        if (idx > -1) plans.splice(idx, 1);
        logAction(scope, 'Removed planned item "' + (plan.title || "untitled") + '"', carName);
        rerender();
      });
      top.appendChild(check);
      top.appendChild(title);
      top.appendChild(del);
      card.appendChild(top);

      var fields = el("div", { class: "entry-fields" });
      fields.appendChild(field("Target date", plan.targetDate, function (v) { plan.targetDate = v; scheduleSave(); }, { type: "date", audit: aud(scope, plan, "target date", carName) }));

      var prioWrap = el("div", { class: "entry-field" });
      prioWrap.appendChild(el("label", { text: "Priority" }));
      var sel = el("select");
      ["Low", "Medium", "High"].forEach(function (p) {
        var o = el("option", { value: p, text: p });
        if ((plan.priority || "Medium") === p) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { plan.priority = sel.value; logAction(scope, 'Set priority of "' + (plan.title || "untitled") + '" to ' + sel.value, carName); });
      prioWrap.appendChild(sel);
      fields.appendChild(prioWrap);

      fields.appendChild(field("Notes / parts / materials", plan.notes, function (v) { plan.notes = v; scheduleSave(); }, { textarea: true, wide: true, audit: aud(scope, plan, "notes", carName) }));
      card.appendChild(fields);
      container.appendChild(card);
    });
  }

  // ---------- Home tab ----------

  var HOME_STARTERS = [
    { name: "HVAC / furnace air filter", category: "HVAC", intervalMonths: 3 },
    { name: "Refrigerator water filter", category: "Water", intervalMonths: 6 },
    { name: "Whole-house water filter", category: "Water", intervalMonths: 6 },
    { name: "Smoke / CO detector batteries", category: "Safety", intervalMonths: 12 },
    { name: "Water heater flush", category: "Plumbing", intervalMonths: 12 },
    { name: "Furnace / AC service", category: "HVAC", intervalMonths: 12 },
    { name: "Dryer vent cleaning", category: "Appliances", intervalMonths: 12 },
    { name: "Clean gutters", category: "Exterior", intervalMonths: 6 }
  ];

  function newHomeTask(base) {
    base = base || {};
    return {
      id: nextId(), name: base.name || "New maintenance item", category: base.category || "General",
      parts: [], size: "", notes: "", intervalMonths: base.intervalMonths || null,
      lastDone: "", history: []
    };
  }

  function homeDueInfo(task) {
    var due = task.lastDone && task.intervalMonths ? addMonthsTo(task.lastDone, task.intervalMonths) : null;
    if (!task.intervalMonths) return { cls: "", label: "No schedule", text: task.lastDone ? "Last done " + prettyDate(task.lastDone) : "Not logged yet", due: null };
    if (!due) return { cls: "", label: "Not logged", text: "Not logged yet — press Log it when you do this.", due: null };
    var days = daysUntil(due);
    if (days < 0) return { cls: "status-overdue", label: "Overdue " + (-days) + "d", text: "Was due " + prettyDate(due), due: due };
    if (days <= 30) return { cls: "status-soon", label: "Due in " + days + "d", text: "Due " + prettyDate(due), due: due };
    return { cls: "status-ok", label: "OK", text: "Next due " + prettyDate(due), due: due };
  }

  function buildLogNowForm(entry, opts) {
    // opts: { withMiles, defaultMiles, onSave(date, miles, notes) }
    var form = el("div", { class: "log-now-form" });
    form.hidden = !openLogForms[entry.id];
    var date = el("input", { type: "date", value: todayISO() });
    form.appendChild(date);
    var miles = null;
    if (opts.withMiles) {
      miles = el("input", { type: "number", min: 0, step: 1, placeholder: opts.milesPlaceholder || "Odometer", value: opts.defaultMiles || "" });
      form.appendChild(miles);
    }
    var notes = el("input", { type: "text", placeholder: "Notes (part used, cost, who did it…)" });
    form.appendChild(notes);
    var save = el("button", { type: "button", class: "entry-btn primary", text: "Save log entry" });
    save.addEventListener("click", function () {
      if (!date.value) return;
      delete openLogForms[entry.id];
      opts.onSave(date.value, miles ? numOrNull(miles.value) : null, notes.value.trim());
    });
    form.appendChild(save);
    return form;
  }

  function buildHomeTaskCard(task, rerender) {
    var info = homeDueInfo(task);
    var card = el("div", { class: "log-entry-card " + info.cls });

    var top = el("div", { class: "entry-top" });
    var name = el("input", { type: "text", class: "entry-name", value: task.name });
    var oldName = task.name;
    name.addEventListener("input", function () { task.name = name.value; scheduleSave(); });
    name.addEventListener("change", function () { logAction("home", 'Renamed "' + oldName + '" to "' + task.name + '"'); oldName = task.name; });
    top.appendChild(name);
    top.appendChild(el("span", { class: "status-badge " + info.cls, text: info.label }));
    makeCollapsible(card, top, task.id);
    card.appendChild(top);

    card.appendChild(el("div", { class: "entry-due", text: info.text }));

    var fields = el("div", { class: "entry-fields" });
    fields.appendChild(field("Category", task.category, function (v) { task.category = v; scheduleSave(); }, { list: "home-categories", audit: aud("home", task, "category") }));
    fields.appendChild(partsEditor(task));
    fields.appendChild(field("Size / spec", task.size, function (v) { task.size = v; scheduleSave(); }, { placeholder: "e.g. 20x25x1", audit: aud("home", task, "size / spec") }));
    fields.appendChild(field("Repeat every (months)", task.intervalMonths, function (v) { task.intervalMonths = numOrNull(v); scheduleSave(); rerender(); }, { type: "number", min: 0, step: 1, onChangeEvent: true, audit: aud("home", task, "repeat interval (months)") }));
    fields.appendChild(field("Last done", task.lastDone, function (v) { task.lastDone = v; scheduleSave(); rerender(); }, { type: "date", onChangeEvent: true, audit: aud("home", task, "last done date") }));
    fields.appendChild(field("Other info (brand, where bought, how-to…)", task.notes, function (v) { task.notes = v; scheduleSave(); }, { textarea: true, wide: true, audit: aud("home", task, "other info") }));
    card.appendChild(fields);

    var actions = el("div", { class: "entry-actions" });
    var logBtn = el("button", { type: "button", class: "entry-btn primary", text: "Log it" });
    var form = buildLogNowForm(task, {
      onSave: function (date, miles, notes) {
        task.history.push({ id: nextId(), date: date, notes: notes });
        if (!task.lastDone || date >= task.lastDone) task.lastDone = date;
        logCompletion("home", '"' + task.name + '" completed on ' + prettyDate(date) + (notes ? " — " + shorten(notes) : ""));
        rerender();
      }
    });
    logBtn.addEventListener("click", function () {
      if (openLogForms[task.id]) delete openLogForms[task.id]; else openLogForms[task.id] = true;
      form.hidden = !openLogForms[task.id];
    });
    var remove = el("button", { type: "button", class: "entry-btn danger", text: "Remove item" });
    remove.addEventListener("click", function () {
      if (!confirm('Remove "' + task.name + '" and its log history?')) return;
      state.home.tasks = state.home.tasks.filter(function (t) { return t !== task; });
      logAction("home", 'Removed maintenance item "' + task.name + '"');
      rerender();
    });
    actions.appendChild(logBtn);
    actions.appendChild(remove);
    card.appendChild(actions);
    card.appendChild(form);

    if (task.history.length) card.appendChild(historyList(task, function () { logAction("home", 'Deleted a log entry from "' + task.name + '"'); rerender(); }, false));
    return card;
  }

  function renderHome() {
    var container = document.getElementById("home-tasks");
    container.innerHTML = "";

    var dl = document.getElementById("home-categories");
    if (!dl) {
      dl = el("datalist", { id: "home-categories" });
      document.body.appendChild(dl);
    }
    dl.innerHTML = "";
    var cats = {};
    state.home.tasks.forEach(function (t) { if (t.category) cats[t.category] = true; });
    Object.keys(cats).forEach(function (c) { dl.appendChild(el("option", { value: c })); });

    if (!state.home.tasks.length) {
      container.appendChild(el("p", { class: "empty-note", text: "No maintenance items yet." }));
      var starter = el("button", { type: "button", class: "entry-btn", text: "Start with common household items" });
      starter.addEventListener("click", function () {
        HOME_STARTERS.forEach(function (s) { state.home.tasks.push(newHomeTask(s)); });
        logAction("home", "Added the starter list of common household items");
        renderHome();
      });
      container.appendChild(starter);
    } else {
      var groups = {};
      state.home.tasks.forEach(function (t) {
        var c = t.category || "General";
        (groups[c] = groups[c] || []).push(t);
      });
      Object.keys(groups).sort().forEach(function (cat) {
        container.appendChild(el("div", { class: "log-group-title", text: cat }));
        groups[cat].sort(function (a, b) {
          var da = homeDueInfo(a).due, db = homeDueInfo(b).due;
          if (da && db) return da - db;
          if (da) return -1;
          if (db) return 1;
          return (a.name || "").localeCompare(b.name || "");
        }).forEach(function (t) {
          container.appendChild(buildHomeTaskCard(t, renderHome));
        });
      });
    }

    renderPlans(document.getElementById("home-plans"), state.home.plans, renderHome, "home");
    renderActivity(document.getElementById("home-activity"), "home");
  }

  function initHome() {
    document.getElementById("home-add-task-btn").addEventListener("click", function () {
      var nt = newHomeTask();
      state.home.tasks.push(nt);
      expandNew(nt.id);
      logAction("home", "Added a new maintenance item");
      renderHome();
    });
    document.getElementById("home-add-plan-btn").addEventListener("click", function () {
      var np = { id: nextId(), title: "", notes: "", targetDate: "", priority: "Medium", done: false };
      state.home.plans.push(np);
      expandNew(np.id);
      logAction("home", "Added a new planned project");
      renderHome();
    });
    document.getElementById("home-print-btn").addEventListener("click", printHomeLogbook);
  }

  // ---------- Cars tab ----------

  // Typical starting intervals only. Every manufacturer is different, so each
  // one is fully editable - enter the numbers from the car's owner's manual /
  // maintenance schedule.
  var CAR_STARTERS = [
    { name: "Oil & filter change", intervalMiles: 5000, intervalMonths: 6 },
    { name: "Tire rotation", intervalMiles: 7500, intervalMonths: 6 },
    { name: "Engine air filter", intervalMiles: 30000, intervalMonths: 24 },
    { name: "Cabin air filter", intervalMiles: 15000, intervalMonths: 12 },
    { name: "Brake fluid", intervalMiles: null, intervalMonths: 36 },
    { name: "Brake pads / rotors inspection", intervalMiles: 25000, intervalMonths: 12 },
    { name: "Coolant flush", intervalMiles: 60000, intervalMonths: 60 },
    { name: "Transmission fluid", intervalMiles: 60000, intervalMonths: 60 },
    { name: "Spark plugs", intervalMiles: 60000, intervalMonths: null },
    { name: "Battery check / replacement", intervalMiles: null, intervalMonths: 48 }
  ];

  function newCarItem(base) {
    base = base || {};
    return {
      id: nextId(), name: base.name || "New service item",
      intervalMiles: base.intervalMiles == null ? null : base.intervalMiles,
      intervalMonths: base.intervalMonths == null ? null : base.intervalMonths,
      lastMiles: null, lastDate: "", parts: [], notes: "", history: []
    };
  }

  function newCar() {
    return {
      id: nextId(), name: "New car", vin: "", odometer: 0, odometerDate: "",
      odometerLog: [],
      items: CAR_STARTERS.map(newCarItem),
      inspections: [],
      plans: []
    };
  }

  function activeCar() {
    return state.cars.filter(function (c) { return c.id === state.activeCar; })[0] || null;
  }

  // "Last done" always comes from the item's most recent logbook entry once
  // it has any. (Before the first entry, the manual last-done fields act as
  // a starting baseline.) Called after every log/delete and on load.
  function syncLastDone(item) {
    var h = (item.history || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.id - a.id;
    })[0];
    if (h) {
      item.lastDate = h.date;
      item.lastMiles = h.miles != null ? h.miles : null;
      item.lastFromLog = true;
    } else if (item.lastFromLog) {
      item.lastDate = "";
      item.lastMiles = null;
      item.lastFromLog = false;
    }
  }

  function carItemInfo(car, item) {
    if (item.recall) {
      var rc = item.recall.campaign;
      if (!item.history.length) {
        var openText = "OPEN RECALL (NHTSA " + rc + ")" + (item.recall.parkIt ? " - MANUFACTURER SAYS DON'T DRIVE" : "") +
          " - repair is free at a dealer. Confirm it applies to your VIN at nhtsa.gov/recalls, then press Log it once it's fixed.";
        return { cls: "status-overdue", label: "OPEN RECALL", parts: [{ bad: true, text: openText }], text: openText };
      }
      var doneText = "Recall " + rc + " completed " + prettyDate(item.lastDate);
      return { cls: "status-ok", label: "Recall done", parts: [{ bad: false, text: doneText }], text: doneText };
    }
    var u = unitOf(car), isHrs = u === "hr";
    var hasMiles = item.intervalMiles && item.lastMiles != null;
    var hasDate = item.intervalMonths && item.lastDate;
    if (!item.intervalMiles && !item.intervalMonths) return { cls: "", label: "No schedule", text: "Set a mileage and/or time interval from the owner's manual." };
    if (!hasMiles && !hasDate) return { cls: "", label: "Not logged", text: "Not logged yet — press Log it, or fill in Last done." };

    // Each requirement (miles, months) is checked on its own. Missing
    // EITHER one makes the item red - whichever limit is hit first counts.
    var parts = [];
    var overdue = false, soon = false;

    if (hasMiles) {
      var nextMiles = Number(item.lastMiles) + Number(item.intervalMiles);
      var left = nextMiles - (Number(car.odometer) || 0);
      var milesBad = left <= 0;
      parts.push({
        bad: milesBad,
        text: milesBad ? (isHrs ? "HOURS" : "MILES") + " NOT MET: overdue by " + fmtMiles(-left) + " " + u + " (was due at " + fmtMiles(nextMiles) + " " + u + ")" : (isHrs ? "Hours" : "Miles") + " OK: due at " + fmtMiles(nextMiles) + " " + u + " (" + fmtMiles(left) + " to go)"
      });
      if (milesBad) overdue = true; else if (left <= (isHrs ? 5 : 500)) soon = true;
    } else if (item.intervalMiles) {
      parts.push({ bad: false, text: (isHrs ? "Hours" : "Mileage") + " requirement not tracked - enter the " + (isHrs ? "hour meter reading" : "odometer") + " it was last done at" });
    }
    if (hasDate) {
      var dueDate = addMonthsTo(item.lastDate, item.intervalMonths);
      var days = daysUntil(dueDate);
      var dateBad = days < 0;
      parts.push({
        bad: dateBad,
        text: dateBad ? "TIME NOT MET: overdue by " + (-days) + " days (was due " + prettyDate(dueDate) + ")" : "Time OK: due by " + prettyDate(dueDate)
      });
      if (dateBad) overdue = true; else if (days <= 30) soon = true;
    } else if (item.intervalMonths) {
      parts.push({ bad: false, text: "Time requirement not tracked - enter the date it was last done" });
    }

    var label = overdue ? "Overdue" : (soon ? "Due soon" : "OK");
    var cls = overdue ? "status-overdue" : (soon ? "status-soon" : "status-ok");
    return { cls: cls, label: label, parts: parts, text: parts.map(function (p) { return p.text; }).join(" · ") };
  }

  function buildCarItemCard(car, item, rerender, listName) {
    listName = listName || "items";
    var uw = unitWord(car), u = unitOf(car);
    var info = carItemInfo(car, item);
    var card = el("div", { class: "log-entry-card " + info.cls });

    var top = el("div", { class: "entry-top" });
    var name = el("input", { type: "text", class: "entry-name", value: item.name });
    var oldName = item.name;
    name.addEventListener("input", function () { item.name = name.value; scheduleSave(); });
    name.addEventListener("change", function () { logAction(car.id, 'Renamed "' + oldName + '" to "' + item.name + '"', car.name); oldName = item.name; });
    top.appendChild(name);
    top.appendChild(el("span", { class: "status-badge " + info.cls, text: info.label }));
    makeCollapsible(card, top, item.id);
    card.appendChild(top);
    var dueBox = el("div", { class: "entry-due" });
    if (info.parts) {
      info.parts.forEach(function (p) {
        dueBox.appendChild(el("div", { class: p.bad ? "req-line req-bad" : "req-line", text: p.text }));
      });
    } else {
      dueBox.textContent = info.text;
    }
    card.appendChild(dueBox);

    var fields = el("div", { class: "entry-fields" });
    fields.appendChild(field("Recommended every (" + uw + ")", item.intervalMiles, function (v) { item.intervalMiles = numOrNull(v); scheduleSave(); rerender(); }, { type: "number", min: 0, step: u === "hr" ? 5 : 500, onChangeEvent: true, audit: aud(car.id, item, "mileage interval", car.name) }));
    fields.appendChild(field("Recommended every (months)", item.intervalMonths, function (v) { item.intervalMonths = numOrNull(v); scheduleSave(); rerender(); }, { type: "number", min: 0, step: 1, onChangeEvent: true, audit: aud(car.id, item, "month interval", car.name) }));
    var fromLog = item.history.length > 0;
    var meter = u === "hr" ? "hour meter" : "odometer";
    var lastMilesLabel = fromLog ? "Last done (" + meter + ") - from latest log entry" : "Last done (" + meter + ")";
    var lastDateLabel = fromLog ? "Last done (date) - from latest log entry" : "Last done (date)";
    fields.appendChild(field(lastMilesLabel, item.lastMiles, function (v) { item.lastMiles = numOrNull(v); scheduleSave(); rerender(); }, { type: "number", min: 0, step: 1, onChangeEvent: true, readOnly: fromLog }));
    fields.appendChild(field(lastDateLabel, item.lastDate, function (v) { item.lastDate = v; scheduleSave(); rerender(); }, { type: "date", onChangeEvent: true, readOnly: fromLog }));
    fields.appendChild(partsEditor(item));
    fields.appendChild(field("Other info (manufacturer note, shop, cost…)", item.notes, function (v) { item.notes = v; scheduleSave(); }, { textarea: true, wide: true, audit: aud(car.id, item, "other info", car.name) }));
    card.appendChild(fields);

    var actions = el("div", { class: "entry-actions" });
    var logBtn = el("button", { type: "button", class: "entry-btn primary", text: "Log it" });
    var form = buildLogNowForm(item, {
      withMiles: true,
      milesPlaceholder: u === "hr" ? "Hour meter" : "Odometer",
      defaultMiles: car.odometer || "",
      onSave: function (date, miles, notes) {
        item.history.push({ id: nextId(), date: date, miles: miles, notes: notes });
        syncLastDone(item);
        if (miles != null && miles > (Number(car.odometer) || 0)) setOdometer(car, miles, date);
        logCompletion(car.id, '"' + item.name + '" completed on ' + prettyDate(date) + (miles != null ? " at " + fmtMiles(miles) + " " + u : "") + (notes ? " — " + shorten(notes) : ""), car.name);
        rerender();
      }
    });
    logBtn.addEventListener("click", function () {
      if (openLogForms[item.id]) delete openLogForms[item.id]; else openLogForms[item.id] = true;
      form.hidden = !openLogForms[item.id];
    });
    var remove = el("button", { type: "button", class: "entry-btn danger", text: "Remove item" });
    remove.addEventListener("click", function () {
      if (!confirm('Remove "' + item.name + '" and its log history?')) return;
      car[listName] = car[listName].filter(function (i) { return i !== item; });
      logAction(car.id, 'Removed service item "' + item.name + '"', car.name);
      rerender();
    });
    actions.appendChild(logBtn);
    actions.appendChild(remove);
    card.appendChild(actions);
    card.appendChild(form);

    if (item.history.length) card.appendChild(historyList(item, function () { syncLastDone(item); logAction(); rerender(); }, true));
    return card;
  }

  function setOdometer(car, miles, dateStr) {
    car.odometer = miles;
    car.odometerDate = dateStr || todayISO();
    car.odometerLog = car.odometerLog || [];
    car.odometerLog.push({ date: car.odometerDate, miles: miles });
  }

  function renderCars() {
    // car picker chips
    var picker = document.getElementById("car-picker");
    picker.innerHTML = "";
    if (!state.cars.length) {
      picker.appendChild(el("p", { class: "empty-note", text: "No cars yet — click “+ Add Car”." }));
    }
    state.cars.forEach(function (c) {
      var chip = el("button", { type: "button", class: "car-chip" + (c.id === state.activeCar ? " active" : ""), text: c.name || "Unnamed car" });
      chip.addEventListener("click", function () {
        state.activeCar = c.id;
        scheduleSave();
        renderCars();
      });
      picker.appendChild(chip);
    });

    var detail = document.getElementById("car-detail");
    detail.innerHTML = "";
    var car = activeCar();
    if (!car) return;

    // car header card
    var head = el("div", { class: "card" });
    var hh = el("div", { class: "log-header" });
    hh.appendChild(el("h2", { text: (car.name || "Car") + " — Logbook" }));
    var removeCar = el("button", { type: "button", class: "entry-btn danger", text: "Remove this car" });
    removeCar.addEventListener("click", function () {
      if (!confirm('Remove "' + (car.name || "this car") + '" and ALL of its maintenance history? This can\'t be undone.')) return;
      logAction("garage", 'Removed car "' + (car.name || "Unnamed") + '" and its logbook');
      state.cars = state.cars.filter(function (c) { return c !== car; });
      state.activeCar = state.cars.length ? state.cars[0].id : null;
      renderCars();
    });
    var printCar = el("button", { type: "button", class: "entry-btn primary", text: "Print / Save logbook as PDF" });
    printCar.addEventListener("click", function () { printCarLogbook(car); });
    var headBtns = el("div", { class: "entry-actions" }, [printCar, removeCar]);
    hh.appendChild(headBtns);
    head.appendChild(hh);
    head.appendChild(el("p", { class: "card-hint", text: "Update the odometer whenever you like — due dates for every item below are measured against it. Intervals start from typical values; replace them with what your manufacturer's maintenance schedule (owner's manual) actually says." }));

    var grid = el("div", { class: "car-header-grid" });
    var oldCarName = car.name;
    grid.appendChild(field("Car (year / make / model)", car.name, function (v) { car.name = v; scheduleSave(); }, { onChangeEvent: true, placeholder: "e.g. 2019 Honda CR-V" }));
    grid.lastChild.querySelector("input").addEventListener("change", function () {
      logAction(car.id, 'Car renamed from "' + oldCarName + '" to "' + car.name + '"', car.name);
      renderCars();
    });
    grid.appendChild(field("VIN / plate (optional)", car.vin, function (v) { car.vin = v; scheduleSave(); }, { audit: aud(car.id, { name: car.name }, "VIN / plate", car.name) }));

    var odoWrap = el("div", { class: "entry-field" });
    odoWrap.appendChild(el("label", { text: car.unit === "hours" ? "Current hour meter (hours)" : "Current odometer (miles)" }));
    var odo = el("input", { type: "number", min: 0, step: 1, value: car.odometer || "", class: "odo-big" });
    odo.addEventListener("change", function () {
      var m = numOrNull(odo.value);
      if (m == null) return;
      setOdometer(car, m, todayISO());
      logAction(car.id, "Odometer updated to " + fmtMiles(m) + " " + unitOf(car), car.name);
      renderCars();
    });
    odoWrap.appendChild(odo);
    if (car.odometerDate) odoWrap.appendChild(el("span", { class: "field-note", text: "Updated " + prettyDate(car.odometerDate) }));
    grid.appendChild(odoWrap);
    head.appendChild(grid);
    detail.appendChild(head);

    // maintenance items
    var itemsCard = el("div", { class: "card" });
    var ih = el("div", { class: "log-header" });
    ih.appendChild(el("h2", { text: "Service Schedule" }));
    var addItem = el("button", { type: "button", class: "add-item-btn", text: "+ Add Service Item" });
    addItem.addEventListener("click", function () {
      var ni = newCarItem();
      car.items.push(ni);
      expandNew(ni.id);
      logAction(car.id, "Added a new service item", car.name);
      renderCars();
    });
    ih.appendChild(addItem);
    itemsCard.appendChild(ih);

    var rank = { "status-overdue": 0, "status-soon": 1, "": 2, "status-ok": 3 };
    function byUrgency(a, b) {
      return rank[carItemInfo(car, a).cls] - rank[carItemInfo(car, b).cls];
    }
    car.items.slice().sort(byUrgency).forEach(function (item) {
      itemsCard.appendChild(buildCarItemCard(car, item, renderCars, "items"));
    });
    if (!car.items.length) itemsCard.appendChild(el("p", { class: "empty-note", text: "No service items." }));
    detail.appendChild(itemsCard);

    // manufacturer-recommended inspections / checks (own section)
    var inspCard = el("div", { class: "card" });
    var nh = el("div", { class: "log-header" });
    nh.appendChild(el("h2", { text: "Manufacturer Inspections & Checks" }));
    var addInsp = el("button", { type: "button", class: "add-item-btn", text: "+ Add Inspection" });
    addInsp.addEventListener("click", function () {
      var nn = newCarItem({ name: "New inspection" });
      car.inspections.push(nn);
      expandNew(nn.id);
      logAction(car.id, "Added a new inspection", car.name);
      renderCars();
    });
    nh.appendChild(addInsp);
    inspCard.appendChild(nh);
    inspCard.appendChild(el("p", { class: "card-hint", text: "Checks the manufacturer says to perform at set " + (car.unit === "hours" ? "hours" : "mileage") + " or time intervals (inspect, check, adjust) as opposed to replacing a part. Press Log it each time you do one." }));
    car.inspections.slice().sort(byUrgency).forEach(function (item) {
      inspCard.appendChild(buildCarItemCard(car, item, renderCars, "inspections"));
    });
    if (!car.inspections.length) inspCard.appendChild(el("p", { class: "empty-note", text: "No inspections yet." }));
    detail.appendChild(inspCard);

    // planned work for this car
    var plansCard = el("div", { class: "card" });
    var ph = el("div", { class: "log-header" });
    ph.appendChild(el("h2", { text: "Planned Work" }));
    var addPlan = el("button", { type: "button", class: "add-item-btn", text: "+ Add Planned Work" });
    addPlan.addEventListener("click", function () {
      var cp = { id: nextId(), title: "", notes: "", targetDate: "", priority: "Medium", done: false };
      car.plans.push(cp);
      expandNew(cp.id);
      logAction(car.id, "Added a new planned work item", car.name);
      renderCars();
    });
    ph.appendChild(addPlan);
    plansCard.appendChild(ph);
    var plansBox = el("div");
    plansCard.appendChild(plansBox);
    detail.appendChild(plansCard);
    renderPlans(plansBox, car.plans, renderCars, car.id, car.name);

    var actCard = el("div", { class: "card" });
    actCard.appendChild(el("h2", { text: "Activity History" }));
    actCard.appendChild(el("p", { class: "card-hint", text: "A permanent record of each time a service or planned job was completed on this car." }));
    var actBox = el("div", { class: "activity-box" });
    actCard.appendChild(actBox);
    detail.appendChild(actCard);
    renderActivity(actBox, car.id);
  }

  // ---------- recall check ----------

  function parseCarName(name) {
    // Accepts "2020 Honda CR-V" or "2020/Honda/CR-V" style names.
    var m = String(name || "").match(/(\d{4})[\s\/,-]+([^\s\/]+)[\s\/,-]+([^\s\/]+)/);
    return m ? { year: m[1], make: m[2], model: m[3] } : {};
  }

  function checkCarRecalls(car) {
    var vin = String(car.vin || "").trim().slice(0, 17);
    var p = parseCarName(car.name);
    var qs = "vin=" + encodeURIComponent(vin.length === 17 ? vin : "") +
      "&year=" + encodeURIComponent(p.year || "") + "&make=" + encodeURIComponent(p.make || "") +
      "&model=" + encodeURIComponent(p.model || "");
    return fetch("/api/maintenance/recalls?" + qs).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || ("HTTP " + r.status));
        return body;
      });
    }).then(function (result) {
      car.recallsSeen = car.recallsSeen || [];
      var added = 0;
      result.recalls.forEach(function (rec) {
        if (car.recallsSeen.indexOf(rec.campaign) > -1) return; // already added once (even if since removed)
        car.recallsSeen.push(rec.campaign);
        var item = newCarItem({ name: "RECALL " + rec.campaign + ": " + (rec.component || "Safety recall") });
        item.intervalMiles = null;
        item.intervalMonths = null;
        item.recall = rec;
        item.notes = "NHTSA recall issued " + (rec.reported || "") + " for " + result.vehicle.year + " " + result.vehicle.make + " " + result.vehicle.model +
          ".\nSUMMARY: " + rec.summary + "\nRISK: " + rec.consequence + "\nREMEDY: " + rec.remedy;
        car.items.push(item);
        added++;
      });
      return { car: car, vehicle: result.vehicle, found: result.recalls.length, added: added, byVin: vin.length === 17 };
    });
  }

  function initRecallButton() {
    var btn = document.getElementById("check-recalls-btn");
    var status = document.getElementById("recall-status");
    btn.addEventListener("click", function () {
      if (!state.cars.length) { status.textContent = "Add a car first."; return; }
      btn.disabled = true;
      status.textContent = "Checking NHTSA for recalls…";
      var lines = [];
      var chain = Promise.resolve();
      state.cars.forEach(function (car) {
        chain = chain.then(function () {
          return checkCarRecalls(car).then(function (r) {
            var v = r.vehicle;
            var label = (car.name || "Car") + " (" + [v.year, v.make, v.model].join(" ").trim() + ")";
            if (!r.found) lines.push(label + ": no recalls on record" + (r.byVin ? "." : " (no VIN entered, so matched by name only)."));
            else lines.push(label + ": " + r.found + " recall(s) on record, " + r.added + " new task(s) added.");
          }).catch(function (e) {
            lines.push((car.name || "Car") + ": couldn't check (" + e.message + ").");
          });
        });
      });
      chain.then(function () {
        logAction();
        renderCars();
        status.innerHTML = "";
        lines.forEach(function (l) { status.appendChild(el("div", { text: l })); });
        status.appendChild(el("div", { class: "field-note", text: "Recalls are listed per model and year. Confirm each applies to (and is still unrepaired on) your exact vehicle with its VIN at nhtsa.gov/recalls. Non-road equipment like the mower isn't covered by NHTSA." }));
        btn.disabled = false;
      });
    });
  }

  function initCars() {
    initRecallButton();
    document.getElementById("car-add-btn").addEventListener("click", function () {
      var car = newCar();
      state.cars.push(car);
      state.activeCar = car.id;
      logAction("garage", "Added a car (" + car.name + ")");
      logAction(car.id, "Car added to the garage", car.name);
      renderCars();
    });
  }

  // Older saves kept a single partNumber string; move it into the parts list.
  function migrateParts(entry) {
    if (!entry.parts) {
      entry.parts = entry.partNumber ? [{ id: nextId(), label: "", number: entry.partNumber }] : [];
    }
    delete entry.partNumber;
  }

  // ---------- init ----------

  function init() {
    initTabs();
    initHome();
    initCars();

    fetch("/api/maintenance-data")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state = data || {};
        if (!state.home) state.home = {};
        if (!state.home.tasks) state.home.tasks = [];
        if (!state.home.plans) state.home.plans = [];
        if (!state.cars) state.cars = [];
        if (!state.activity) state.activity = [];
        if (!state.nextId) state.nextId = 1;
        state.cars.forEach(function (c) {
          if (!c.items) c.items = [];
          if (!c.inspections) c.inspections = [];
          if (!c.plans) c.plans = [];
          if (!c.odometerLog) c.odometerLog = [];
          c.items.concat(c.inspections).forEach(function (i) { if (!i.history) i.history = []; migrateParts(i); syncLastDone(i); });
        });
        state.home.tasks.forEach(function (t) { if (!t.history) t.history = []; migrateParts(t); });
        if (!activeCar() && state.cars.length) state.activeCar = state.cars[0].id;

        renderHome();
        renderCars();
        setSaveStatus("All changes saved");
      })
      .catch(function () {
        setSaveStatus("Could not load data from the server");
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
