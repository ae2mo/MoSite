/* Stock Trader page client logic.
   Talks to /api/stocks/* (all the Alpaca/pandas/yfinance work happens
   server-side in stocks_engine.py - this file only renders and triggers). */

(function () {
  "use strict";

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

  // Canvas fillStyle/strokeStyle need a resolved color, not a CSS var() -
  // this reads the current theme's actual value so the chart redraws
  // correctly in both light and dark mode.
  function themeColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  function fmtQty(n) {
    var v = Number(n);
    if (!isFinite(v)) return "0";
    if (Number.isInteger(v)) return v.toString();
    return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }

  function setStatus(text) {
    var el = document.getElementById("save-status");
    if (el) el.textContent = text;
  }

  function setActionStatus(text) {
    document.getElementById("action-status").textContent = text;
  }

  function jsonFetch(url, options) {
    return fetch(url, options).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
        return body;
      });
    });
  }

  // ---------- status / setup banner ----------

  function loadStatus() {
    return jsonFetch("/api/stocks/status").then(function (status) {
      var banner = document.getElementById("setup-banner");
      var msg = document.getElementById("setup-message");
      var buttons = [document.getElementById("scan-btn"), document.getElementById("buy-btn"), document.getElementById("sell-btn")];

      if (!status.installed) {
        banner.hidden = false;
        msg.textContent =
          "Missing Python packages: " + status.missing.join(", ") +
          ". From the homebudget folder, run: pip install -r requirements-stocks.txt, then refresh this page.";
        buttons.forEach(function (b) { b.disabled = true; });
      } else if (!status.configured) {
        banner.hidden = false;
        msg.textContent =
          (status.configError ? status.configError + " " : "") +
          "Copy stocks_config.example.json to stocks_config.json in the homebudget folder and fill in your Alpaca API key and secret, then refresh this page.";
        buttons.forEach(function (b) { b.disabled = true; });
      } else {
        banner.hidden = true;
        buttons.forEach(function (b) { b.disabled = false; });
      }
      return status;
    }).catch(function (e) {
      var banner = document.getElementById("setup-banner");
      banner.hidden = false;
      document.getElementById("setup-message").textContent = "Could not reach the server: " + e.message;
    });
  }

  // ---------- account ----------

  var lastAccount = null; // cached so the picks table can estimate allocations client-side

  function loadAccount() {
    return jsonFetch("/api/stocks/account").then(function (acct) {
      lastAccount = acct;
      var modeEl = document.getElementById("acct-mode");
      modeEl.innerHTML = '<span class="mode-badge ' + (acct.paper ? "paper" : "live") + '">' + (acct.paper ? "PAPER" : "LIVE") + "</span>";
      document.getElementById("acct-buying-power").textContent = fmt(acct.buyingPower);
      document.getElementById("acct-portfolio-value").textContent = fmt(acct.portfolioValue);
      document.getElementById("acct-cash").textContent = fmt(acct.cash);
      return acct;
    }).catch(function () {
      document.getElementById("acct-mode").textContent = "—";
    });
  }

  // ---------- positions ----------

  function loadPositions() {
    return jsonFetch("/api/stocks/positions").then(function (data) {
      var tbody = document.getElementById("positions-body");
      tbody.innerHTML = "";
      if (!data.positions.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No open positions.</td></tr>';
        return;
      }
      data.positions.forEach(function (p) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeHtml(p.symbol) + "</td>" +
          "<td>" + fmtQty(p.qty) + "</td>" +
          "<td>" + fmt(p.avgEntryPrice) + "</td>" +
          "<td>" + (p.currentPrice != null ? fmt(p.currentPrice) : "—") + "</td>" +
          "<td>" + fmt(p.marketValue) + "</td>" +
          '<td class="' + (p.unrealizedPL >= 0 ? "diff-positive" : "diff-negative") + '">' +
            fmt(p.unrealizedPL) + " (" + p.unrealizedPLPercent.toFixed(1) + "%)</td>";
        tbody.appendChild(tr);
      });
    }).catch(function () {});
  }

  // ---------- sell signal review ----------

  function renderSellReview(result) {
    var card = document.getElementById("sell-review-card");
    var tbody = document.getElementById("sell-review-body");
    tbody.innerHTML = "";

    var positions = (result && result.positions) || [];
    if (!positions.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    positions.forEach(function (p) {
      var tr = document.createElement("tr");
      if (p.shouldSell) tr.className = "sell-flagged-row";

      var signalHtml = p.shouldSell
        ? '<span class="signal-badge signal-sell">SELL &mdash; ' + escapeHtml(p.reason || "") + "</span>"
        : '<span class="signal-badge signal-hold">Hold</span>';

      tr.innerHTML =
        "<td>" + escapeHtml(p.symbol) + "</td>" +
        "<td>" + fmtQty(p.qty) + "</td>" +
        "<td>" + fmt(p.avgEntryPrice) + "</td>" +
        "<td>" + (p.currentPrice != null ? fmt(p.currentPrice) : "—") + "</td>" +
        "<td>" + fmt(p.marketValue) + "</td>" +
        '<td class="' + (p.unrealizedPL >= 0 ? "diff-positive" : "diff-negative") + '">' +
          fmt(p.unrealizedPL) + " (" + p.unrealizedPLPercent.toFixed(1) + "%)</td>" +
        "<td>" + signalHtml + "</td>" +
        "<td></td>";

      var rowSellBtn = document.createElement("button");
      rowSellBtn.type = "button";
      rowSellBtn.className = "sell-row-btn" + (p.shouldSell ? "" : " secondary");
      rowSellBtn.textContent = "Sell";
      rowSellBtn.addEventListener("click", function () {
        confirmAndSellPosition(p, rowSellBtn);
      });
      tr.lastElementChild.appendChild(rowSellBtn);

      tbody.appendChild(tr);
    });
  }

  function confirmAndSellPosition(p, btn) {
    var msg = p.shouldSell
      ? ("Sell all " + fmtQty(p.qty) + " share(s) of " + p.symbol + "? Signal: " + p.reason + ".")
      : ("Sell all " + fmtQty(p.qty) + " share(s) of " + p.symbol + "? No sell signal is currently tripped for this position — this would be a manual sell.");
    var ok = confirm(msg);
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = "Selling…";
    jsonFetch("/api/stocks/sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: p.symbol })
    }).then(function () {
      setActionStatus("Sold " + p.symbol + ".");
      var row = btn.closest("tr");
      if (row && row.parentNode) row.parentNode.removeChild(row);
      var tbody = document.getElementById("sell-review-body");
      if (tbody && !tbody.children.length) {
        document.getElementById("sell-review-card").hidden = true;
      }
      refreshAfterAction();
    }).catch(function (e) {
      setActionStatus("Sell failed for " + p.symbol + ": " + e.message);
      btn.disabled = false;
      btn.textContent = "Sell";
    });
  }

  // ---------- picks (last scan) ----------

  // Rough client-side mirror of the server's risk-based position sizing
  // (_position_size in stocks_engine.py), for display only - the actual
  // order placed by Buy Top Picks is computed and scaled server-side.
  function estimateAllocation(pick) {
    if (!lastAccount || !lastSettings) return null;
    var equity = Number(lastAccount.equity || lastAccount.portfolioValue) || 0;
    var atr = Number(pick.atr14) || 0;
    var price = Number(pick.price) || 0;
    var stopMultiple = Number(lastSettings.stopLossAtrMultiple) || 2;
    var riskPercent = (Number(lastSettings.riskPercent) || 1.5) / 100;
    var maxPositionPercent = (Number(lastSettings.maxPositionPercent) || 20) / 100;
    var stopDistance = atr > 0 ? stopMultiple * atr : price * 0.07;
    stopDistance = Math.max(stopDistance, price * 0.01);
    if (!stopDistance || !equity) return null;
    var riskBased = (equity * riskPercent / stopDistance) * price;
    return Math.max(0, Math.min(riskBased, equity * maxPositionPercent));
  }

  function renderPicks(scan) {
    var tbody = document.getElementById("picks-body");
    tbody.innerHTML = "";
    if (!scan || !scan.picks || !scan.picks.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-row">Click "Scan Market" to rank candidates.</td></tr>';
      document.getElementById("scan-meta").textContent = "";
      return;
    }
    scan.picks.forEach(function (p) {
      var tr = document.createElement("tr");
      var alloc = estimateAllocation(p);
      tr.innerHTML =
        "<td><strong>" + escapeHtml(p.symbol) + "</strong></td>" +
        "<td>" + p.score.toFixed(1) + "</td>" +
        "<td>" + fmt(p.price) + "</td>" +
        '<td class="' + (p.returnShort >= 0 ? "diff-positive" : "diff-negative") + '">' + p.returnShort.toFixed(1) + "%</td>" +
        "<td>" + p.rsi14.toFixed(1) + "</td>" +
        "<td>" + fmt(p.ma20) + "</td>" +
        "<td>" + fmt(p.ma50) + "</td>" +
        "<td>" + fmt(p.atr14) + "</td>" +
        "<td>" + (alloc != null ? fmt(alloc) : "—") + "</td>";
      tbody.appendChild(tr);
    });
    var when = new Date(scan.timestamp).toLocaleString();
    var meta = "Scanned " + scan.universeSize + " symbols, scored " + scan.scored + " (" + scan.skipped + " skipped for insufficient history) — " + when;
    if (scan.usedFallback) {
      meta = "⚠ Couldn't reach Wikipedia for the full Dow/S&P 500 list — using the built-in watchlist instead. " + meta;
    }
    document.getElementById("scan-meta").textContent = meta;
    renderRegimeBanner(scan.marketRegime);
  }

  function renderRegimeBanner(regime) {
    var banner = document.getElementById("regime-banner");
    var detail = document.getElementById("regime-detail");
    if (!regime || !banner || !detail) return;
    banner.hidden = false;
    banner.classList.toggle("regime-caution", regime.ok === false);
    detail.textContent = regime.detail || "";
  }

  // ---------- activity log ----------

  function loadLog() {
    return jsonFetch("/api/stocks/log").then(function (data) {
      var container = document.getElementById("activity-log");
      container.innerHTML = "";
      if (!data.entries.length) {
        container.innerHTML = '<p class="empty-row">No activity yet.</p>';
        return;
      }
      data.entries.forEach(function (entry) {
        var div = document.createElement("div");
        div.className = "log-entry log-" + entry.type;
        var when = new Date(entry.timestamp).toLocaleString();
        div.innerHTML =
          '<span class="log-time">' + when + "</span>" +
          "<span>" + escapeHtml(entry.message) + "</span>";
        container.appendChild(div);
      });
    }).catch(function () {});
  }

  // ---------- portfolio trend chart ----------

  var lastSnapshots = null; // cached for a redraw-in-place on theme toggle

  function loadHistory() {
    return jsonFetch("/api/stocks/history").then(function (data) {
      lastSnapshots = data.snapshots;
      drawPortfolioChart(document.getElementById("chart-portfolio"), data.snapshots);
    }).catch(function () {});
  }

  function drawPortfolioChart(canvas, snapshots) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!snapshots || snapshots.length < 2) {
      ctx.fillStyle = themeColor("--slate-400");
      ctx.font = "13px sans-serif";
      ctx.fillText("Not enough history yet — check back after a few visits.", 16, 30);
      return;
    }

    var padLeft = 70, padRight = 20, padTop = 16, padBottom = 30;
    var chartW = W - padLeft - padRight;
    var chartH = H - padTop - padBottom;

    var values = snapshots.map(function (s) { return s.portfolioValue; });
    var maxVal = Math.max.apply(null, values);
    var minVal = Math.min.apply(null, values);
    if (maxVal === minVal) { maxVal += 1; minVal -= 1; }
    var range = maxVal - minVal;

    function xForIdx(i) { return padLeft + (i / (snapshots.length - 1)) * chartW; }
    function yForVal(v) { return padTop + chartH - ((v - minVal) / range) * chartH; }

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

    ctx.strokeStyle = "#2f6fed";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    snapshots.forEach(function (s, idx) {
      var x = xForIdx(idx);
      var y = yForVal(s.portfolioValue);
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    var last = snapshots[snapshots.length - 1];
    ctx.fillStyle = "#2f6fed";
    ctx.beginPath();
    ctx.arc(xForIdx(snapshots.length - 1), yForVal(last.portfolioValue), 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = "left";
    ctx.fillStyle = themeColor("--slate-600");
    ctx.font = "11px sans-serif";
    ctx.fillText(new Date(snapshots[0].timestamp).toLocaleDateString(), padLeft, padTop + chartH + 20);
    ctx.textAlign = "right";
    ctx.fillText(new Date(last.timestamp).toLocaleDateString(), padLeft + chartW, padTop + chartH + 20);
  }

  // ---------- API key / secret / paper-live settings ----------

  var configWasPaper = true;

  function loadConfig() {
    return jsonFetch("/api/stocks/config").then(function (cfg) {
      configWasPaper = cfg.paper !== false;
      document.getElementById("config-mode-paper").checked = configWasPaper;
      document.getElementById("config-mode-live").checked = !configWasPaper;
      document.getElementById("config-live-warning").hidden = configWasPaper;

      var current = document.getElementById("config-current");
      if (cfg.hasKey && cfg.hasSecret) {
        current.textContent = "Current key: " + cfg.keyPreview + " (" + (configWasPaper ? "Paper" : "Live") + " mode). Leave the fields below blank to keep them.";
      } else {
        current.textContent = "No API key saved yet. Enter your Alpaca key and secret below.";
      }
      return cfg;
    }).catch(function (e) {
      document.getElementById("config-current").textContent = "Could not load current settings: " + e.message;
    });
  }

  function openConfigModal() {
    document.getElementById("config-api-key").value = "";
    document.getElementById("config-api-secret").value = "";
    document.getElementById("config-status").textContent = "";
    document.getElementById("config-overlay").hidden = false;
    document.getElementById("config-gear-btn").setAttribute("aria-expanded", "true");
    loadConfig();
  }

  function closeConfigModal() {
    document.getElementById("config-overlay").hidden = true;
    document.getElementById("config-gear-btn").setAttribute("aria-expanded", "false");
  }

  function initConfigModal() {
    document.getElementById("config-gear-btn").addEventListener("click", openConfigModal);
    document.getElementById("config-close-btn").addEventListener("click", closeConfigModal);
    document.getElementById("config-overlay").addEventListener("click", function (e) {
      if (e.target.id === "config-overlay") closeConfigModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("config-overlay").hidden) closeConfigModal();
    });

    var liveRadio = document.getElementById("config-mode-live");
    var paperRadio = document.getElementById("config-mode-paper");
    var warning = document.getElementById("config-live-warning");
    liveRadio.addEventListener("change", function () { warning.hidden = !liveRadio.checked; });
    paperRadio.addEventListener("change", function () { warning.hidden = !liveRadio.checked; });

    document.getElementById("config-save-btn").addEventListener("click", function () {
      var goingLive = document.getElementById("config-mode-live").checked;
      if (goingLive && configWasPaper) {
        var ok = confirm("You're switching to LIVE trading. Every Buy/Sell click will place real orders with real money in your Alpaca account. Continue?");
        if (!ok) return;
      }
      var payload = {
        apiKey: document.getElementById("config-api-key").value,
        apiSecret: document.getElementById("config-api-secret").value,
        paper: !goingLive
      };
      var statusEl = document.getElementById("config-status");
      statusEl.textContent = "Saving…";
      jsonFetch("/api/stocks/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function () {
        statusEl.textContent = "Saved.";
        document.getElementById("config-api-key").value = "";
        document.getElementById("config-api-secret").value = "";
        loadConfig();
        loadStatus().then(function (status) {
          if (status && status.installed && status.configured) {
            loadAccount();
            loadPositions();
            loadLog();
            loadHistory();
          }
        });
      }).catch(function (e) {
        statusEl.textContent = "Failed to save: " + e.message;
      });
    });
  }

  // ---------- settings ----------

  var lastSettings = null; // cached for the picks table's client-side allocation estimate

  function loadSettings() {
    return jsonFetch("/api/stocks/settings").then(function (settings) {
      lastSettings = settings;
      document.getElementById("setting-top-n").value = settings.topN;
      document.getElementById("setting-universe").value = settings.universe;
      document.getElementById("setting-min-price").value = settings.minPrice;
      document.getElementById("setting-momentum-lookback").value = settings.momentumLookbackDays;
      document.getElementById("setting-exclude-held").checked = !!settings.excludeHeld;
      document.getElementById("setting-market-regime").checked = settings.requireMarketRegimeFilter !== false;

      document.getElementById("setting-risk-percent").value = settings.riskPercent;
      document.getElementById("setting-max-position-percent").value = settings.maxPositionPercent;
      document.getElementById("setting-stop-loss-atr").value = settings.stopLossAtrMultiple;
      document.getElementById("setting-profit-trail-trigger").value = settings.profitTrailTriggerPercent;
      document.getElementById("setting-trailing-stop-atr").value = settings.trailingStopAtrMultiple;
      document.getElementById("setting-max-holding-days").value = settings.maxHoldingDays;
      return settings;
    }).catch(function () {});
  }

  function saveSettingsPayload(payload, statusElId) {
    var statusEl = document.getElementById(statusElId);
    statusEl.textContent = "Saving…";
    return jsonFetch("/api/stocks/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (settings) {
      lastSettings = settings;
      statusEl.textContent = "Saved.";
    }).catch(function (e) {
      statusEl.textContent = "Failed to save: " + e.message;
    });
  }

  function initSettingsForm() {
    document.getElementById("save-settings-btn").addEventListener("click", function () {
      saveSettingsPayload({
        topN: parseInt(document.getElementById("setting-top-n").value, 10) || 10,
        universe: document.getElementById("setting-universe").value,
        minPrice: parseFloat(document.getElementById("setting-min-price").value) || 0,
        momentumLookbackDays: parseInt(document.getElementById("setting-momentum-lookback").value, 10) || 10,
        excludeHeld: document.getElementById("setting-exclude-held").checked,
        requireMarketRegimeFilter: document.getElementById("setting-market-regime").checked
      }, "settings-status");
    });

    document.getElementById("save-strategy-settings-btn").addEventListener("click", function () {
      saveSettingsPayload({
        riskPercent: parseFloat(document.getElementById("setting-risk-percent").value) || 1.5,
        maxPositionPercent: parseFloat(document.getElementById("setting-max-position-percent").value) || 20,
        stopLossAtrMultiple: parseFloat(document.getElementById("setting-stop-loss-atr").value) || 2,
        profitTrailTriggerPercent: parseFloat(document.getElementById("setting-profit-trail-trigger").value) || 15,
        trailingStopAtrMultiple: parseFloat(document.getElementById("setting-trailing-stop-atr").value) || 1.5,
        maxHoldingDays: parseInt(document.getElementById("setting-max-holding-days").value, 10) || 20
      }, "strategy-settings-status");
    });
  }

  // ---------- actions ----------

  function refreshAfterAction() {
    return Promise.all([loadAccount(), loadPositions(), loadLog(), loadHistory()]);
  }

  function initActions() {
    var scanBtn = document.getElementById("scan-btn");
    var buyBtn = document.getElementById("buy-btn");
    var sellBtn = document.getElementById("sell-btn");

    scanBtn.addEventListener("click", function () {
      scanBtn.disabled = true;
      setActionStatus("Scanning market… this can take up to a minute for the full S&P 500 + Dow universe.");
      jsonFetch("/api/stocks/scan", { method: "POST" }).then(function (scan) {
        renderPicks(scan);
        setActionStatus("Scan complete.");
        loadLog();
      }).catch(function (e) {
        setActionStatus("Scan failed: " + e.message);
      }).then(function () {
        scanBtn.disabled = false;
      });
    });

    buyBtn.addEventListener("click", function () {
      var ok = confirm("This will place real (or paper) buy orders through your Alpaca account, sized per pick by its own risk (see Strategy & Risk Settings). Continue?");
      if (!ok) return;
      buyBtn.disabled = true;
      setActionStatus("Placing buy orders…");
      jsonFetch("/api/stocks/buy", { method: "POST" }).then(function (result) {
        var placed = result.orders.length;
        var skipped = result.skipped.length;
        setActionStatus("Bought " + placed + " position(s)" + (skipped ? ", skipped " + skipped : "") + ".");
        refreshAfterAction();
      }).catch(function (e) {
        setActionStatus("Buy failed: " + e.message);
      }).then(function () {
        buyBtn.disabled = false;
      });
    });

    sellBtn.addEventListener("click", function () {
      sellBtn.disabled = true;
      setActionStatus("Checking positions for sell signals…");
      jsonFetch("/api/stocks/sell-check", { method: "POST" }).then(function (result) {
        renderSellReview(result);
        var positions = result.positions || [];
        var flagged = positions.filter(function (p) { return p.shouldSell; }).length;
        setActionStatus(positions.length
          ? ("Checked " + result.checked + " position(s) — " + flagged + " flagged. Review below and confirm any sells.")
          : "No open positions to check.");
        loadLog();
      }).catch(function (e) {
        setActionStatus("Sell check failed: " + e.message);
      }).then(function () {
        sellBtn.disabled = false;
      });
    });
  }

  // ---------- Test Settings (backtest) ----------

  var lastBacktest = null;
  var backtestTimer = null;

  // Current values in both settings forms (saved or not) - what the test uses.
  function readFormSettings() {
    function num(id, fallback, isInt) {
      var v = isInt ? parseInt(document.getElementById(id).value, 10) : parseFloat(document.getElementById(id).value);
      return isFinite(v) ? v : fallback;
    }
    return {
      topN: num("setting-top-n", 10, true),
      universe: document.getElementById("setting-universe").value,
      minPrice: num("setting-min-price", 5),
      momentumLookbackDays: num("setting-momentum-lookback", 10, true),
      excludeHeld: document.getElementById("setting-exclude-held").checked,
      requireMarketRegimeFilter: document.getElementById("setting-market-regime").checked,
      riskPercent: num("setting-risk-percent", 1.5),
      maxPositionPercent: num("setting-max-position-percent", 20),
      stopLossAtrMultiple: num("setting-stop-loss-atr", 2),
      profitTrailTriggerPercent: num("setting-profit-trail-trigger", 15),
      trailingStopAtrMultiple: num("setting-trailing-stop-atr", 1.5),
      maxHoldingDays: num("setting-max-holding-days", 20, true)
    };
  }

  function pctText(v) {
    if (v == null) return "—";
    return (v >= 0 ? "+" : "") + Number(v).toFixed(1) + "%";
  }

  function summaryCard(label, value, cls) {
    return '<div class="summary-card"><span class="summary-label">' + escapeHtml(label) +
      '</span><span class="summary-value' + (cls ? " " + cls : "") + '">' + escapeHtml(value) + "</span></div>";
  }

  function drawBacktestChart(canvas, curve) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!curve || curve.length < 2) return;

    var padLeft = 70, padRight = 20, padTop = 16, padBottom = 30;
    var chartW = W - padLeft - padRight, chartH = H - padTop - padBottom;
    var all = [];
    curve.forEach(function (p) { all.push(p.value, p.spy); });
    var maxVal = Math.max.apply(null, all), minVal = Math.min.apply(null, all);
    if (maxVal === minVal) { maxVal += 1; minVal -= 1; }
    var pad = (maxVal - minVal) * 0.05;
    maxVal += pad; minVal -= pad;
    var range = maxVal - minVal;
    function x(i) { return padLeft + (i / (curve.length - 1)) * chartW; }
    function y(v) { return padTop + chartH - ((v - minVal) / range) * chartH; }

    ctx.strokeStyle = themeColor("--slate-100");
    ctx.fillStyle = themeColor("--slate-400");
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (var d = 0; d <= 4; d++) {
      var val = minVal + (range / 4) * d;
      ctx.beginPath(); ctx.moveTo(padLeft, y(val)); ctx.lineTo(padLeft + chartW, y(val)); ctx.stroke();
      ctx.fillText("$" + Math.round(val), padLeft - 8, y(val));
    }
    // $1,000 starting line
    var base = curve[0].value >= 0 ? 1000 : 1000;
    if (base > minVal && base < maxVal) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = themeColor("--slate-400");
      ctx.beginPath(); ctx.moveTo(padLeft, y(base)); ctx.lineTo(padLeft + chartW, y(base)); ctx.stroke();
      ctx.setLineDash([]);
    }

    function line(key, color, width) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath();
      curve.forEach(function (p, i) { if (i === 0) ctx.moveTo(x(i), y(p[key])); else ctx.lineTo(x(i), y(p[key])); });
      ctx.stroke();
    }
    line("spy", "#9aa5b8", 2);
    line("value", "#2f6fed", 2.5);

    ctx.textAlign = "left";
    ctx.fillStyle = themeColor("--slate-600");
    ctx.fillText(curve[0].date, padLeft, padTop + chartH + 20);
    ctx.textAlign = "right";
    ctx.fillText(curve[curve.length - 1].date, padLeft + chartW, padTop + chartH + 20);
  }

  function renderBacktest(r) {
    lastBacktest = r;
    document.getElementById("backtest-result").hidden = false;

    var up = r.returnPercent >= 0;
    var beat = r.returnPercent - r.spyReturnPercent;
    document.getElementById("backtest-summary").innerHTML =
      summaryCard("Started with", fmt(r.startCash)) +
      summaryCard("Ended with", fmt(r.finalValue), up ? "pos" : "neg") +
      summaryCard("Return", pctText(r.returnPercent), up ? "pos" : "neg") +
      summaryCard("S&P 500 buy & hold", pctText(r.spyReturnPercent) + " (" + fmt(r.spyFinalValue) + ")") +
      summaryCard("vs. S&P 500", (beat >= 0 ? "+" : "") + beat.toFixed(1) + " pts", beat >= 0 ? "pos" : "neg") +
      summaryCard("Worst drop", "-" + r.maxDrawdownPercent.toFixed(1) + "%", "neg") +
      summaryCard("Closed trades", String(r.closedTrades)) +
      summaryCard("Win rate", r.winRatePercent == null ? "—" : r.winRatePercent.toFixed(0) + "%") +
      summaryCard("Avg win / avg loss", (r.avgWinPercent == null ? "—" : pctText(r.avgWinPercent)) + " / " + (r.avgLossPercent == null ? "—" : pctText(r.avgLossPercent))) +
      summaryCard("Avg days held", r.avgDaysHeld == null ? "—" : String(r.avgDaysHeld)) +
      summaryCard("Avg % invested", r.avgExposurePercent.toFixed(0) + "%") +
      summaryCard("Days buying paused", r.pausedDays + " of " + r.days);

    document.getElementById("backtest-legend").innerHTML =
      '<span style="color:#2f6fed;font-weight:700">&#9632;</span> This strategy &nbsp; <span style="color:#9aa5b8;font-weight:700">&#9632;</span> S&amp;P 500 buy &amp; hold (SPY) &nbsp;&middot;&nbsp; ' +
      escapeHtml(r.startDate) + " to " + escapeHtml(r.endDate) + " (" + r.days + " trading days)";
    drawBacktestChart(document.getElementById("chart-backtest"), r.curve);

    var reasons = Object.keys(r.exitReasons || {}).map(function (k) { return k + ": " + r.exitReasons[k]; });
    document.getElementById("backtest-reasons").textContent = reasons.length ? reasons.join("  ·  ") : "No positions were closed during the test.";

    var tbody = document.getElementById("backtest-trades-body");
    tbody.innerHTML = "";
    if (!r.recentTrades.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No closed trades.</td></tr>';
    }
    r.recentTrades.forEach(function (t) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td><strong>" + escapeHtml(t.symbol) + "</strong></td><td>" + escapeHtml(t.entryDate) + "</td><td>" + escapeHtml(t.exitDate) + "</td><td>" + t.days + "</td>" +
        "<td>" + fmt(t.entryPrice) + "</td><td>" + fmt(t.exitPrice) + "</td>" +
        '<td class="' + (t.pnl >= 0 ? "diff-positive" : "diff-negative") + '">' + pctText(t.pnlPercent) + " (" + fmt(t.pnl) + ")</td>" +
        "<td>" + escapeHtml(t.reason) + "</td>";
      tbody.appendChild(tr);
    });

    var obody = document.getElementById("backtest-open-body");
    obody.innerHTML = "";
    document.getElementById("backtest-open-title").hidden = !r.openPositions.length;
    document.getElementById("backtest-open").hidden = !r.openPositions.length;
    r.openPositions.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td><strong>" + escapeHtml(p.symbol) + "</strong></td><td>" + escapeHtml(p.entryDate) + "</td><td>" + fmt(p.entryPrice) + "</td><td>" + fmt(p.lastPrice) + "</td><td>" + fmt(p.value) + "</td>" +
        '<td class="' + (p.pnlPercent >= 0 ? "diff-positive" : "diff-negative") + '">' + pctText(p.pnlPercent) + "</td>";
      obody.appendChild(tr);
    });

    var caveat = "Read this with care: a one-year replay of one set of settings is a single sample, not a forecast. It tests today's S&P 500 + Dow members, so it quietly leaves out companies that were dropped or went under (this flatters results); it assumes no commissions or slippage, fractional shares, cash-only buying, and fills at each day's opening price after a signal from the prior close. Tuning settings until this number looks good can just fit last year's market. Not financial advice.";
    if (r.usedFallback) caveat = "Couldn't reach Wikipedia for the full index lists, so only the built-in " + r.universeSize + "-symbol watchlist was tested. " + caveat;
    document.getElementById("backtest-caveat").textContent = caveat;
  }

  function pollBacktest() {
    var btn = document.getElementById("backtest-btn");
    var status = document.getElementById("backtest-status");
    jsonFetch("/api/stocks/backtest").then(function (st) {
      if (st.running) {
        status.textContent = st.stage || "Running…";
        backtestTimer = setTimeout(pollBacktest, 2000);
        return;
      }
      btn.disabled = false;
      if (st.error) {
        status.textContent = "Test failed: " + st.error;
      } else if (st.result) {
        status.textContent = "Done.";
        renderBacktest(st.result);
      } else {
        status.textContent = "";
      }
    }).catch(function (e) {
      btn.disabled = false;
      status.textContent = "Lost contact with the server: " + e.message;
    });
  }

  function initBacktest() {
    var btn = document.getElementById("backtest-btn");
    btn.addEventListener("click", function () {
      btn.disabled = true;
      document.getElementById("backtest-status").textContent = "Starting test…";
      jsonFetch("/api/stocks/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(readFormSettings())
      }).then(function () {
        clearTimeout(backtestTimer);
        backtestTimer = setTimeout(pollBacktest, 1500);
      }).catch(function (e) {
        btn.disabled = false;
        document.getElementById("backtest-status").textContent = "Couldn't start the test: " + e.message;
      });
    });

    // If a test was started earlier (or finished while the page was closed),
    // pick it back up.
    jsonFetch("/api/stocks/backtest").then(function (st) {
      if (st.running) {
        btn.disabled = true;
        pollBacktest();
      } else if (st.result) {
        renderBacktest(st.result);
        document.getElementById("backtest-status").textContent = "Showing the last test run.";
      }
    }).catch(function () {});
  }

  // ---------- auto mode ----------

  function loadAuto() {
    return jsonFetch("/api/stocks/auto").then(function (a) {
      document.getElementById("auto-toggle").checked = !!a.autoMode;
      if (a.lastAutoRun) {
        var r = a.lastAutoRun;
        setStatus("Last auto cycle " + new Date(r.timestamp).toLocaleString() + ": sold " + r.sold.length + ", bought " + r.bought + (r.errors.length ? " (issues - see Activity Log)" : ""));
      }
    }).catch(function () {});
  }

  function initAuto() {
    var toggle = document.getElementById("auto-toggle");
    toggle.addEventListener("change", function () {
      var on = toggle.checked;
      if (on && lastAccount && lastAccount.paper === false) {
        if (!confirm("Auto mode will place REAL orders with real money every hour while the market is open, with no confirmation click. Turn it on?")) {
          toggle.checked = false;
          return;
        }
      }
      jsonFetch("/api/stocks/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoMode: on })
      }).then(function () {
        setActionStatus(on ? "Auto mode on - runs at the top of every hour while the market is open." : "Auto mode off.");
      }).catch(function (e) {
        toggle.checked = !on;
        setActionStatus("Couldn't change auto mode: " + e.message);
      });
    });

    // Refresh page data at the top of every hour (slightly after, so the
    // server's auto cycle has had time to start), keeping the view current.
    function scheduleHourlyRefresh() {
      var now = new Date();
      var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 30);
      setTimeout(function () {
        refreshAfterAction();
        loadAuto();
        scheduleHourlyRefresh();
      }, next - now);
    }
    scheduleHourlyRefresh();
  }

  // ---------- init ----------

  function init() {
    initActions();
    initAuto();
    initSettingsForm();
    initBacktest();
    initConfigModal();

    loadStatus().then(function (status) {
      if (!status || !status.installed || !status.configured) {
        setStatus("Setup needed — see the box above.");
        loadSettings();
        return;
      }
      setStatus("Ready");
      loadAccount();
      loadPositions();
      loadLog();
      loadHistory();
      loadSettings();
      loadAuto();
    });

    window.addEventListener("themechange", function () {
      if (lastSnapshots) drawPortfolioChart(document.getElementById("chart-portfolio"), lastSnapshots);
      if (lastBacktest) drawBacktestChart(document.getElementById("chart-backtest"), lastBacktest.curve);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
