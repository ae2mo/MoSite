/* Meal Planner - client logic.
   Talks to /api/meals-data (GET to load, POST to save) - a single generic
   JSON blob, same "server has no opinion on the schema" approach as the
   Budget app. All meal/plan/shopping-list logic lives here.

   Data model:
   state = {
     meals: [{id, name, favorite, notes, instructions, ingredients: [{id, name, quantity, unit, category}]}],
     plans: {
       "<mondayDateKey>": { "Monday": {lunch, dinner}, ... "Sunday": {lunch, dinner} }
     },
     shoppingLists: {
       "<mondayDateKey>": { extraItems: [{id, name, quantity, unit, category, checked}], checked: {"<lineKey>": true} }
     },
     activeWeek: "<mondayDateKey>",
     nextId: <counter>
   }

   Shopping list lines are never stored - they're recomputed live from
   whichever meals are assigned that week, combining ingredients that share
   the same name and unit. Only the checked-off state (keyed by a
   normalized name|unit key) and any manually-added extra items persist. */

(function () {
  "use strict";

  var state = null;
  var saveTimer = null;
  var expandedMealIds = {};
  var importRows = []; // working ingredient rows while the Import Recipe modal is open
  var mealSearchFilters = ["", "", "", ""]; // Meals tab ingredient-search sidebar - session-only, not saved

  var GROCERY_CATEGORIES = [
    "Produce", "Meat & Seafood", "Dairy & Eggs", "Bakery",
    "Pantry", "Frozen", "Beverages", "Spices & Condiments", "Other"
  ];

  var DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  var SLOTS = ["lunch", "dinner"];
  var MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------- small helpers ----------

  function fmtQty(n) {
    var v = Number(n);
    if (!isFinite(v) || v === 0) return "";
    if (Number.isInteger(v)) return v.toString();
    return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  function setSaveStatus(text) {
    var el = document.getElementById("save-status");
    if (el) el.textContent = text;
  }

  function scheduleSave() {
    setSaveStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch("/api/meals-data", {
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

  function jsonFetch(url, options) {
    return fetch(url, options).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
        return body;
      });
    });
  }

  // ---------- week/date helpers ----------

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function toDateKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseDateKey(key) {
    var parts = key.split("-").map(function (n) { return Number(n); });
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function mondayOf(d) {
    var day = d.getDay(); // 0 = Sunday .. 6 = Saturday
    var diff = day === 0 ? -6 : 1 - day;
    var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
    return monday;
  }

  function todayWeekKey() {
    return toDateKey(mondayOf(new Date()));
  }

  function addWeeks(weekKey, n) {
    var d = parseDateKey(weekKey);
    d.setDate(d.getDate() + n * 7);
    return toDateKey(d);
  }

  function weekLabel(weekKey) {
    var start = parseDateKey(weekKey);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    var startStr = MONTH_ABBR[start.getMonth()] + " " + start.getDate();
    var endStr = MONTH_ABBR[end.getMonth()] + " " + end.getDate() + ", " + end.getFullYear();
    return "Week of " + startStr + " – " + endStr;
  }

  // ---------- ingredient line parsing (recipe import) ----------
  // Turns a free-text line like "1 1/2 cups flour" into {name, quantity,
  // unit}. Used for both paths in the Import Recipe modal: lines pasted by
  // hand, and lines fetched from a recipe URL's structured data (the server
  // only extracts the raw ingredient strings a site published - it doesn't
  // parse them itself, so there's exactly one parser to maintain). This is
  // a best-effort heuristic, not a full NLP parser - the review table next
  // to it is always editable so a bad guess is a quick fix, not a blocker.

  var UNICODE_FRACTIONS = {
    "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3,
    "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
    "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875
  };

  var KNOWN_UNITS = [
    "cups", "cup", "tablespoons", "tablespoon", "tbsp", "tbsps", "tbs",
    "teaspoons", "teaspoon", "tsp", "tsps", "ounces", "ounce", "oz",
    "pounds", "pound", "lbs", "lb", "grams", "gram", "g", "kilograms", "kilogram", "kg",
    "milliliters", "milliliter", "ml", "liters", "liter", "l",
    "cloves", "clove", "cans", "can", "packages", "package", "pkg",
    "pinches", "pinch", "dashes", "dash", "slices", "slice",
    "bunches", "bunch", "heads", "head", "stalks", "stalk",
    "sprigs", "sprig", "quarts", "quart", "qt", "pints", "pint", "pt",
    "large", "medium", "small", "whole"
  ];

  var CATEGORY_KEYWORDS = [
    { category: "Produce", keywords: ["onion", "garlic", "tomato", "potato", "carrot", "celery", "lettuce", "spinach", "bell pepper", "cucumber", "broccoli", "apple", "banana", "lemon", "lime", "avocado", "mushroom", "basil", "cilantro", "parsley", "ginger", "kale", "zucchini"] },
    { category: "Meat & Seafood", keywords: ["chicken", "beef", "pork", "turkey", "bacon", "sausage", "shrimp", "salmon", "fish", "steak", "ground beef", "lamb"] },
    { category: "Dairy & Eggs", keywords: ["milk", "cheese", "butter", "egg", "cream", "yogurt", "sour cream"] },
    { category: "Bakery", keywords: ["bread", "bun", "baguette", "roll", "tortilla", "bagel"] },
    { category: "Pantry", keywords: ["flour", "sugar", "rice", "pasta", "noodle", "oil", "vinegar", "salt", "spice", "cumin", "paprika", "cinnamon", "bean", "broth", "stock", "sauce", "canned", "cereal", "baking soda", "baking powder", "honey", "syrup"] },
    { category: "Frozen", keywords: ["frozen"] },
    { category: "Beverages", keywords: ["juice", "soda", "wine", "beer", "coffee", "tea"] }
  ];

  function guessCategory(name) {
    var lower = (name || "").toLowerCase();
    for (var i = 0; i < CATEGORY_KEYWORDS.length; i++) {
      var group = CATEGORY_KEYWORDS[i];
      for (var j = 0; j < group.keywords.length; j++) {
        if (lower.indexOf(group.keywords[j]) > -1) return group.category;
      }
    }
    return "Other";
  }

  function normalizeFractionChars(str) {
    return str.replace(/[¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, function (ch) {
      return " " + UNICODE_FRACTIONS[ch] + " ";
    });
  }

  function parseLeadingQuantity(str) {
    var s = str.trim();
    var m = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(\.\d+)?)/);
    if (!m) return null;
    var matched = m[0];
    var numPart = m[1];
    var value;
    if (numPart.indexOf("/") > -1 && numPart.indexOf(" ") > -1) {
      var parts = numPart.split(" ");
      var fracParts = parts[1].split("/");
      value = parseFloat(parts[0]) + (parseFloat(fracParts[0]) / parseFloat(fracParts[1]));
    } else if (numPart.indexOf("/") > -1) {
      var fp = numPart.split("/");
      value = parseFloat(fp[0]) / parseFloat(fp[1]);
    } else {
      value = parseFloat(numPart);
    }
    return { value: value, rest: s.slice(matched.length).trim() };
  }

  function parseIngredientLine(line) {
    var text = normalizeFractionChars(line || "").replace(/\s+/g, " ").trim();
    if (!text) return null;

    var quantity = 1;
    var rest = text;
    var qtyResult = parseLeadingQuantity(text);
    if (qtyResult) {
      quantity = qtyResult.value;
      rest = qtyResult.rest;
    }

    var unit = "";
    for (var i = 0; i < KNOWN_UNITS.length; i++) {
      var u = KNOWN_UNITS[i];
      var re = new RegExp("^" + u + "\\b\\.?\\s*", "i");
      if (re.test(rest)) {
        unit = u;
        rest = rest.replace(re, "");
        break;
      }
    }

    var name = rest.replace(/^of\s+/i, "").trim();
    if (!name) {
      name = text;
      quantity = 1;
      unit = "";
    }

    return { name: name, quantity: quantity, unit: unit };
  }

  // ---------- meals: favorite list ----------

  function sortMeals() {
    state.meals.sort(function (a, b) {
      var fa = a.favorite ? 1 : 0;
      var fb = b.favorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
    });
  }

  function mealById(id) {
    if (id == null) return null;
    for (var i = 0; i < state.meals.length; i++) {
      if (state.meals[i].id === id) return state.meals[i];
    }
    return null;
  }

  function clearMealFromAllPlans(mealId) {
    Object.keys(state.plans).forEach(function (weekKey) {
      var plan = state.plans[weekKey];
      DAYS.forEach(function (day) {
        if (!plan[day]) return;
        SLOTS.forEach(function (slot) {
          var a = plan[day][slot];
          var assignedId = a && typeof a === "object" ? a.mealId : a;
          if (assignedId === mealId) plan[day][slot] = null;
        });
      });
    });
  }

  function buildCategorySelect(value, onChange) {
    var select = document.createElement("select");
    GROCERY_CATEGORIES.forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      if (cat === value) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", function () { onChange(select.value); });
    return select;
  }

  function buildIngredientRow(meal, ing) {
    var row = document.createElement("div");
    row.className = "ingredient-row";

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Ingredient";
    nameInput.value = ing.name || "";
    nameInput.addEventListener("input", function () {
      ing.name = nameInput.value;
      scheduleSave();
    });

    var qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.min = "0";
    qtyInput.step = "any";
    qtyInput.placeholder = "Qty";
    qtyInput.className = "ingredient-qty-input";
    qtyInput.value = ing.quantity || "";
    qtyInput.addEventListener("input", function () {
      ing.quantity = parseFloat(qtyInput.value) || 0;
      scheduleSave();
    });

    var unitInput = document.createElement("input");
    unitInput.type = "text";
    unitInput.placeholder = "cup, lb, box…";
    unitInput.className = "ingredient-unit-input";
    unitInput.value = ing.unit || "";
    unitInput.addEventListener("input", function () {
      ing.unit = unitInput.value;
      scheduleSave();
    });

    var categorySelect = buildCategorySelect(ing.category || "Other", function (val) {
      ing.category = val;
      scheduleSave();
    });

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-item-btn";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove ingredient";
    removeBtn.addEventListener("click", function () {
      var idx = meal.ingredients.indexOf(ing);
      if (idx > -1) meal.ingredients.splice(idx, 1);
      renderMealsStructure();
      scheduleSave();
    });

    row.appendChild(nameInput);
    row.appendChild(qtyInput);
    row.appendChild(unitInput);
    row.appendChild(categorySelect);
    row.appendChild(removeBtn);
    return row;
  }

  function buildMealCard(meal) {
    var expanded = !!expandedMealIds[meal.id];

    var card = document.createElement("div");
    card.className = "meal-card" + (expanded ? " expanded" : "");

    var header = document.createElement("div");
    header.className = "meal-card-header";

    var expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "expand-btn" + (expanded ? " open" : "");
    expandBtn.innerHTML = "&#9656;";
    expandBtn.title = expanded ? "Collapse" : "Expand";

    var starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "star-btn" + (meal.favorite ? " starred" : "");
    starBtn.innerHTML = meal.favorite ? "&#9733;" : "&#9734;";
    starBtn.title = meal.favorite ? "Unfavorite" : "Favorite - pins this meal to the top of the list";
    starBtn.addEventListener("click", function () {
      meal.favorite = !meal.favorite;
      renderMealsStructure();
      scheduleSave();
    });

    var nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "meal-name-toggle";
    nameBtn.textContent = meal.name || "New Meal";

    function toggle() {
      expandedMealIds[meal.id] = !expandedMealIds[meal.id];
      renderMealsStructure();
    }
    expandBtn.addEventListener("click", toggle);
    nameBtn.addEventListener("click", toggle);

    var countSpan = document.createElement("span");
    countSpan.className = "meal-ingredient-count";
    var n = meal.ingredients.length;
    countSpan.textContent = n + (n === 1 ? " ingredient" : " ingredients");

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-item-btn";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove meal";
    removeBtn.addEventListener("click", function () {
      var ok = confirm('Remove "' + (meal.name || "this meal") + '"? Any day it\'s currently assigned to will go back to "—". This can\'t be undone.');
      if (!ok) return;
      var idx = state.meals.indexOf(meal);
      if (idx > -1) state.meals.splice(idx, 1);
      delete expandedMealIds[meal.id];
      clearMealFromAllPlans(meal.id);
      renderMealsStructure();
      renderPlanStructure();
      scheduleSave();
    });

    header.appendChild(expandBtn);
    header.appendChild(starBtn);
    header.appendChild(nameBtn);
    header.appendChild(countSpan);
    header.appendChild(removeBtn);
    card.appendChild(header);

    if (expanded) {
      var nameRow = document.createElement("div");
      nameRow.className = "meal-field-row";
      var nameLabel = document.createElement("span");
      nameLabel.className = "account-field-label";
      nameLabel.textContent = "Meal Name";
      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = meal.name || "";
      nameInput.addEventListener("input", function () {
        meal.name = nameInput.value;
        scheduleSave();
      });
      nameInput.addEventListener("blur", function () {
        renderMealsStructure();
        renderPlanStructure();
      });
      nameRow.appendChild(nameLabel);
      nameRow.appendChild(nameInput);
      card.appendChild(nameRow);

      var servingsRow = document.createElement("div");
      servingsRow.className = "meal-field-row";
      var servingsLabel = document.createElement("span");
      servingsLabel.className = "account-field-label";
      servingsLabel.textContent = "Default Servings";
      var servingsField = document.createElement("input");
      servingsField.type = "number";
      servingsField.min = "0.5";
      servingsField.step = "0.5";
      servingsField.value = meal.servings || 1;
      servingsField.title = "How many servings this recipe naturally makes - assigning it to the Weekly Plan starts at this many, then you can adjust per day.";
      servingsField.addEventListener("input", function () {
        var val = parseFloat(servingsField.value);
        meal.servings = val > 0 ? val : 1;
        scheduleSave();
      });
      servingsRow.appendChild(servingsLabel);
      servingsRow.appendChild(servingsField);
      card.appendChild(servingsRow);

      var ingLabels = document.createElement("div");
      ingLabels.className = "ingredient-labels";
      ingLabels.innerHTML = "<span>Ingredient</span><span>Qty</span><span>Unit</span><span>Category</span><span></span>";
      card.appendChild(ingLabels);

      var ingList = document.createElement("div");
      ingList.className = "ingredients-list";
      meal.ingredients.forEach(function (ing) {
        ingList.appendChild(buildIngredientRow(meal, ing));
      });
      card.appendChild(ingList);

      var addIngBtn = document.createElement("button");
      addIngBtn.type = "button";
      addIngBtn.className = "add-item-btn";
      addIngBtn.textContent = "+ Add Ingredient";
      addIngBtn.addEventListener("click", function () {
        meal.ingredients.push({ id: nextId(), name: "", quantity: 1, unit: "", category: "Other" });
        renderMealsStructure();
        scheduleSave();
      });
      card.appendChild(addIngBtn);

      var instructionsRow = document.createElement("div");
      instructionsRow.className = "meal-field-row";
      var instructionsLabel = document.createElement("span");
      instructionsLabel.className = "account-field-label";
      instructionsLabel.textContent = "Instructions";
      var instructionsArea = document.createElement("textarea");
      instructionsArea.rows = 6;
      instructionsArea.placeholder = "Step-by-step instructions…";
      instructionsArea.value = meal.instructions || "";
      instructionsArea.addEventListener("input", function () {
        meal.instructions = instructionsArea.value;
        scheduleSave();
      });
      instructionsRow.appendChild(instructionsLabel);
      instructionsRow.appendChild(instructionsArea);
      card.appendChild(instructionsRow);

      var notesRow = document.createElement("div");
      notesRow.className = "meal-field-row";
      var notesLabel = document.createElement("span");
      notesLabel.className = "account-field-label";
      notesLabel.textContent = "Notes";
      var notesArea = document.createElement("textarea");
      notesArea.rows = 2;
      notesArea.placeholder = "Prep notes, links, whatever's useful…";
      notesArea.value = meal.notes || "";
      notesArea.addEventListener("input", function () {
        meal.notes = notesArea.value;
        scheduleSave();
      });
      notesRow.appendChild(notesLabel);
      notesRow.appendChild(notesArea);
      card.appendChild(notesRow);
    }

    return card;
  }

  // ---------- Meals tab: ingredient search sidebar ----------
  // 4 cascading "type or select" boxes. Box 1 lists every ingredient across
  // all meals; picking one narrows the meal list to meals containing it.
  // Box 2 then only offers ingredients that appear in meals within that
  // narrowed set (excluding what's already picked), and so on through boxes
  // 3 and 4. Matching is substring/case-insensitive so partial typing works
  // without requiring an exact pick from the list. Purely a client-side view
  // filter - never saved, resets on reload.

  function ingredientNamesForMeals(meals) {
    var seen = {};
    var names = [];
    meals.forEach(function (m) {
      (m.ingredients || []).forEach(function (ing) {
        var name = (ing.name || "").trim();
        if (!name) return;
        var key = name.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        names.push(name);
      });
    });
    names.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: "base" }); });
    return names;
  }

  function mealHasIngredient(meal, term) {
    var target = (term || "").trim().toLowerCase();
    if (!target) return true;
    return (meal.ingredients || []).some(function (ing) {
      return (ing.name || "").toLowerCase().indexOf(target) !== -1;
    });
  }

  // Meals matching filter levels [0, upTo) of mealSearchFilters.
  function mealsMatchingFiltersUpTo(upTo) {
    return state.meals.filter(function (meal) {
      for (var i = 0; i < upTo; i++) {
        if (mealSearchFilters[i] && !mealHasIngredient(meal, mealSearchFilters[i])) return false;
      }
      return true;
    });
  }

  function visibleMealsForSearch() {
    return mealsMatchingFiltersUpTo(4);
  }

  function renderMealSearchPanel() {
    for (var i = 0; i < 4; i++) {
      var candidateMeals = mealsMatchingFiltersUpTo(i);
      var names = ingredientNamesForMeals(candidateMeals);
      var datalist = document.getElementById("meal-search-" + (i + 1) + "-list");
      if (!datalist) continue;
      datalist.innerHTML = "";
      names.forEach(function (name) {
        var option = document.createElement("option");
        option.value = name;
        datalist.appendChild(option);
      });
    }

    var matched = visibleMealsForSearch();
    var anyFilter = mealSearchFilters.some(function (f) { return f; });
    var note = document.getElementById("meal-search-count-note");
    if (note) {
      note.textContent = anyFilter
        ? ("Showing " + matched.length + " of " + state.meals.length + " meal" + (state.meals.length === 1 ? "" : "s") + ".")
        : "";
    }
  }

  function initMealSearchPanel() {
    for (var i = 0; i < 4; i++) {
      (function (idx) {
        var input = document.getElementById("meal-search-" + (idx + 1));
        if (!input) return;
        input.addEventListener("input", function () {
          mealSearchFilters[idx] = input.value;
          // Everything after this level was scoped to the old value - clear
          // it so a stale, no-longer-relevant ingredient doesn't linger.
          for (var j = idx + 1; j < 4; j++) {
            mealSearchFilters[j] = "";
            var laterInput = document.getElementById("meal-search-" + (j + 1));
            if (laterInput) laterInput.value = "";
          }
          renderMealSearchPanel();
          renderMealsStructure();
        });
      })(i);
    }

    var clearBtn = document.getElementById("meal-search-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        mealSearchFilters = ["", "", "", ""];
        for (var i = 0; i < 4; i++) {
          var input = document.getElementById("meal-search-" + (i + 1));
          if (input) input.value = "";
        }
        renderMealSearchPanel();
        renderMealsStructure();
      });
    }
  }

  function renderMealsStructure() {
    var container = document.getElementById("meals-list");
    if (!container) return;
    container.innerHTML = "";

    sortMeals();
    renderMealSearchPanel();

    var visibleMeals = visibleMealsForSearch();

    if (!state.meals.length) {
      var empty = document.createElement("p");
      empty.className = "card-hint";
      empty.textContent = "No favorite meals yet - click “+ Add Meal” to start building your list.";
      container.appendChild(empty);
    } else if (!visibleMeals.length) {
      var noMatch = document.createElement("p");
      noMatch.className = "card-hint";
      noMatch.textContent = "No meals match those ingredients.";
      container.appendChild(noMatch);
    }

    visibleMeals.forEach(function (meal) {
      container.appendChild(buildMealCard(meal));
    });
  }

  function initMealsTab() {
    document.getElementById("add-meal-btn").addEventListener("click", function () {
      var meal = { id: nextId(), name: "New Meal", notes: "", instructions: "", servings: 1, ingredients: [] };
      state.meals.push(meal);
      expandedMealIds[meal.id] = true;
      renderMealsStructure();
      renderPlanStructure();
      scheduleSave();
    });
  }

  function initClearAllMeals() {
    var btn = document.getElementById("menu-clear-all-meals-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      closeSettingsMenu();
      if (!state.meals.length) {
        alert("There are no meals to clear.");
        return;
      }
      var ok = confirm(
        "This permanently removes all " + state.meals.length + " meal(s) from your Meals list. " +
        "Any day they're currently assigned to on the Weekly Plan will go back to \"—\". This can't be undone. Continue?"
      );
      if (!ok) return;

      state.meals.forEach(function (meal) {
        clearMealFromAllPlans(meal.id);
      });
      state.meals = [];
      expandedMealIds = {};
      mealSearchFilters = ["", "", "", ""];
      renderMealsStructure();
      renderPlanStructure();
      scheduleSave();
    });
  }

  // ---------- weekly plan ----------

  function buildEmptyDayPlan() {
    return { lunch: null, dinner: null };
  }

  // Each slot holds either null (nothing assigned) or {mealId, servings}.
  // Older saves stored a bare meal id number - normalized here into the
  // {mealId, servings: 1} shape so everything downstream can assume the
  // object form. Runs every time a week is touched, not just once, same
  // self-healing pattern as the Budget app's schema backfills.
  function normalizeAssignment(value) {
    if (value == null) return null;
    if (typeof value === "number") return { mealId: value, servings: 1 };
    if (typeof value === "object" && value.mealId != null) {
      var servings = Number(value.servings);
      return { mealId: value.mealId, servings: servings > 0 ? servings : 1 };
    }
    return null;
  }

  function ensureWeekPlan(weekKey) {
    if (!state.plans[weekKey]) state.plans[weekKey] = {};
    var plan = state.plans[weekKey];
    DAYS.forEach(function (day) {
      if (!plan[day]) plan[day] = buildEmptyDayPlan();
      SLOTS.forEach(function (slot) {
        plan[day][slot] = normalizeAssignment(plan[day][slot]);
      });
    });
    return plan;
  }

  function buildPlanSlotCell(day, slot, plan) {
    var wrap = document.createElement("div");
    wrap.className = "plan-slot";

    var assignment = plan[day][slot];

    var select = document.createElement("select");
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "—";
    select.appendChild(noneOpt);

    state.meals.forEach(function (meal) {
      var opt = document.createElement("option");
      opt.value = String(meal.id);
      opt.textContent = meal.name || "Untitled Meal";
      if (assignment && assignment.mealId === meal.id) opt.selected = true;
      select.appendChild(opt);
    });

    var servingsWrap = document.createElement("div");
    servingsWrap.className = "servings-wrap";
    servingsWrap.hidden = !assignment;

    var xLabel = document.createElement("span");
    xLabel.textContent = "×";

    var servingsInput = document.createElement("input");
    servingsInput.type = "number";
    servingsInput.min = "0.5";
    servingsInput.step = "0.5";
    servingsInput.className = "servings-input";
    servingsInput.title = "Servings - scales this meal's ingredient amounts on the shopping list";
    servingsInput.value = assignment ? assignment.servings : 1;

    select.addEventListener("change", function () {
      if (!select.value) {
        plan[day][slot] = null;
        servingsWrap.hidden = true;
      } else {
        var mealId = Number(select.value);
        var newServings;
        if (plan[day][slot] && plan[day][slot].mealId === mealId) {
          // Re-selecting the same recipe that was already here - keep
          // whatever servings you'd already set for this day, don't reset it.
          newServings = plan[day][slot].servings;
        } else {
          // Switching to a different recipe - start from THAT recipe's own
          // default serving size (set on the Meals tab, or detected at
          // import time), not whatever the previous recipe in this slot
          // happened to be scaled to.
          var selectedMeal = state.meals.filter(function (m) { return m.id === mealId; })[0];
          newServings = selectedMeal && Number(selectedMeal.servings) > 0 ? Number(selectedMeal.servings) : 1;
        }
        plan[day][slot] = { mealId: mealId, servings: newServings };
        servingsInput.value = newServings;
        servingsWrap.hidden = false;
      }
      scheduleSave();
    });

    servingsInput.addEventListener("input", function () {
      var val = parseFloat(servingsInput.value);
      if (!val || val <= 0) val = 1;
      if (plan[day][slot]) {
        plan[day][slot].servings = val;
        scheduleSave();
      }
    });

    servingsWrap.appendChild(xLabel);
    servingsWrap.appendChild(servingsInput);
    wrap.appendChild(select);
    wrap.appendChild(servingsWrap);
    return wrap;
  }

  function renderPlanStructure() {
    var plan = ensureWeekPlan(state.activeWeek);
    document.getElementById("week-label").textContent = weekLabel(state.activeWeek);

    var tbody = document.getElementById("plan-body");
    tbody.innerHTML = "";

    DAYS.forEach(function (day) {
      var tr = document.createElement("tr");

      var dayTd = document.createElement("td");
      dayTd.textContent = day;
      dayTd.className = "plan-day-label";
      tr.appendChild(dayTd);

      SLOTS.forEach(function (slot) {
        var td = document.createElement("td");
        td.appendChild(buildPlanSlotCell(day, slot, plan));
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  }

  function updateSettingsGearVisibility(activeTab) {
    var wrap = document.getElementById("meals-settings-wrap");
    if (!wrap) return;
    wrap.hidden = activeTab !== "meals";
    if (wrap.hidden) closeSettingsMenu();
  }

  function initTabs() {
    var buttons = document.querySelectorAll(".tab-btn");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        buttons.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("active"); });
        var target = document.getElementById("panel-" + btn.dataset.tab);
        if (target) target.classList.add("active");

        updateSettingsGearVisibility(btn.dataset.tab);

        if (!state) return;
        switch (btn.dataset.tab) {
          case "plan": renderActiveWeek(); break;
          case "meals": renderMealsStructure(); break;
          case "shopping": renderShoppingList(); break;
        }
      });
    });
  }

  function initWeekBar() {
    document.getElementById("week-prev").addEventListener("click", function () {
      state.activeWeek = addWeeks(state.activeWeek, -1);
      renderActiveWeek();
      scheduleSave();
    });
    document.getElementById("week-next").addEventListener("click", function () {
      state.activeWeek = addWeeks(state.activeWeek, 1);
      renderActiveWeek();
      scheduleSave();
    });
    document.getElementById("week-today").addEventListener("click", function () {
      state.activeWeek = todayWeekKey();
      renderActiveWeek();
      scheduleSave();
    });
  }

  function renderActiveWeek() {
    renderPlanStructure();
    renderShoppingList();
  }

  // One-time migration: meals imported before this fix had their ingredient
  // quantities divided down to a per-1-serving basis at import time. The
  // shopping list now expects quantities for the recipe's own default
  // serving count instead (like a printed recipe: "serves 4, needs 2 lbs"),
  // so this undoes that old division exactly once, for imported meals only
  // - manually-entered meals were never divided and don't need touching.
  // Guarded by a flag on state so it can never double-apply.
  function migrateImportedIngredientQuantities() {
    if (state.ingredientQuantityBasisFixed) return;
    state.meals.forEach(function (meal) {
      if (!meal.sourceUrl) return;
      var servings = Number(meal.servings) > 0 ? Number(meal.servings) : 1;
      if (servings === 1) return;
      (meal.ingredients || []).forEach(function (ing) {
        ing.quantity = (Number(ing.quantity) || 0) * servings;
      });
    });
    state.ingredientQuantityBasisFixed = true;
    scheduleSave();
  }

  // ---------- shopping list ----------

  function ensureShoppingList(weekKey) {
    if (!state.shoppingLists[weekKey]) {
      state.shoppingLists[weekKey] = { extraItems: [], checked: {} };
    }
    var sl = state.shoppingLists[weekKey];
    if (!sl.extraItems) sl.extraItems = [];
    if (!sl.checked) sl.checked = {};
    return sl;
  }

  function normalizeKey(name, unit) {
    return (name || "").trim().toLowerCase() + "|" + (unit || "").trim().toLowerCase();
  }

  function buildShoppingLines(weekKey) {
    var plan = ensureWeekPlan(weekKey);
    var lines = {};

    DAYS.forEach(function (day) {
      SLOTS.forEach(function (slot) {
        var assignment = plan[day][slot];
        if (!assignment || assignment.mealId == null) return;
        var meal = mealById(assignment.mealId);
        if (!meal) return;
        // Ingredient quantities are stored for this meal's own default
        // serving count (like a printed recipe: "serves 4, needs 2 lbs...").
        // Scale relative to that base, not the raw assigned-servings number,
        // so a meal assigned at its own default comes out 1:1 and only
        // actually scaling away from that default changes the amounts.
        var baseServings = Number(meal.servings) > 0 ? Number(meal.servings) : 1;
        var servingsCount = assignment.servings || baseServings;
        var scaleRatio = servingsCount / baseServings;
        var mealLabel = meal.name + (servingsCount !== baseServings ? " (" + fmtQty(servingsCount) + "×)" : "");

        meal.ingredients.forEach(function (ing) {
          var name = (ing.name || "").trim();
          if (!name) return;
          var unit = (ing.unit || "").trim();
          var key = normalizeKey(name, unit);

          if (!lines[key]) {
            lines[key] = {
              key: key,
              name: name,
              unit: unit,
              category: ing.category || "Other",
              quantity: 0,
              meals: []
            };
          }
          lines[key].quantity += (Number(ing.quantity) || 0) * scaleRatio;
          if (lines[key].meals.indexOf(mealLabel) === -1) lines[key].meals.push(mealLabel);
        });
      });
    });

    return Object.keys(lines).map(function (k) { return lines[k]; });
  }

  function buildShoppingLineRow(line, sl) {
    var row = document.createElement("div");
    row.className = "shopping-line-row";
    if (sl.checked[line.key]) row.classList.add("checked");

    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!sl.checked[line.key];
    checkbox.addEventListener("change", function () {
      if (checkbox.checked) sl.checked[line.key] = true; else delete sl.checked[line.key];
      row.classList.toggle("checked", checkbox.checked);
      scheduleSave();
    });

    var textSpan = document.createElement("span");
    textSpan.className = "shopping-line-text";
    var qtyUnit = (fmtQty(line.quantity) + " " + line.unit).trim();
    textSpan.textContent = (qtyUnit ? qtyUnit + " " : "") + line.name;

    var mealsSpan = document.createElement("span");
    mealsSpan.className = "shopping-line-meals";
    mealsSpan.textContent = "for " + line.meals.join(", ");
    textSpan.appendChild(mealsSpan);

    row.appendChild(checkbox);
    row.appendChild(textSpan);
    return row;
  }

  function buildExtraItemRow(item, sl) {
    var row = document.createElement("div");
    row.className = "shopping-line-row";
    if (item.checked) row.classList.add("checked");

    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!item.checked;
    checkbox.addEventListener("change", function () {
      item.checked = checkbox.checked;
      row.classList.toggle("checked", checkbox.checked);
      scheduleSave();
    });

    var textSpan = document.createElement("span");
    textSpan.className = "shopping-line-text";
    var qtyUnit = ((item.quantity || "") + " " + (item.unit || "")).trim();
    textSpan.textContent = (qtyUnit ? qtyUnit + " " : "") + item.name;

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-item-btn";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove item";
    removeBtn.addEventListener("click", function () {
      var idx = sl.extraItems.indexOf(item);
      if (idx > -1) sl.extraItems.splice(idx, 1);
      renderShoppingList();
      scheduleSave();
    });

    row.appendChild(checkbox);
    row.appendChild(textSpan);
    row.appendChild(removeBtn);
    return row;
  }

  function renderShoppingList() {
    var weekKey = state.activeWeek;
    var sl = ensureShoppingList(weekKey);
    var lines = buildShoppingLines(weekKey);

    var container = document.getElementById("shopping-list");
    container.innerHTML = "";

    if (!lines.length && !sl.extraItems.length) {
      container.innerHTML = '<p class="empty-row">No items yet — assign some meals above, or add an extra item below.</p>';
      return;
    }

    var byCategory = {};
    lines.forEach(function (line) {
      var cat = line.category || "Other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(line);
    });

    var categoriesInUse = GROCERY_CATEGORIES.filter(function (c) { return byCategory[c] && byCategory[c].length; });
    Object.keys(byCategory).forEach(function (c) {
      if (categoriesInUse.indexOf(c) === -1) categoriesInUse.push(c);
    });

    categoriesInUse.forEach(function (cat) {
      var group = document.createElement("div");
      group.className = "shopping-group";
      var heading = document.createElement("h3");
      heading.textContent = cat;
      group.appendChild(heading);

      byCategory[cat].sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      byCategory[cat].forEach(function (line) {
        group.appendChild(buildShoppingLineRow(line, sl));
      });

      container.appendChild(group);
    });

    if (sl.extraItems.length) {
      var extraGroup = document.createElement("div");
      extraGroup.className = "shopping-group";
      var extraHeading = document.createElement("h3");
      extraHeading.textContent = "Extra Items";
      extraGroup.appendChild(extraHeading);
      sl.extraItems.forEach(function (item) {
        extraGroup.appendChild(buildExtraItemRow(item, sl));
      });
      container.appendChild(extraGroup);
    }
  }

  function populateExtraCategorySelect() {
    var select = document.getElementById("extra-item-category");
    select.innerHTML = "";
    GROCERY_CATEGORIES.forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });
  }

  function initShoppingListActions() {
    document.getElementById("generate-list-btn").addEventListener("click", function () {
      renderShoppingList();
      var lineCount = buildShoppingLines(state.activeWeek).length;
      var status = document.getElementById("shopping-status");
      status.textContent = lineCount
        ? ("Built from this week's planned meals (" + lineCount + " item line" + (lineCount === 1 ? "" : "s") + ").")
        : "No meals assigned this week yet — pick some in the plan above.";
    });

    populateExtraCategorySelect();

    document.getElementById("add-extra-item-btn").addEventListener("click", function () {
      var nameInput = document.getElementById("extra-item-name");
      var qtyInput = document.getElementById("extra-item-qty");
      var unitInput = document.getElementById("extra-item-unit");
      var categorySelect = document.getElementById("extra-item-category");

      var name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }

      var sl = ensureShoppingList(state.activeWeek);
      sl.extraItems.push({
        id: nextId(),
        name: name,
        quantity: qtyInput.value.trim(),
        unit: unitInput.value.trim(),
        category: categorySelect.value,
        checked: false
      });

      nameInput.value = "";
      qtyInput.value = "";
      unitInput.value = "";
      nameInput.focus();

      renderShoppingList();
      scheduleSave();
    });
  }

  // ---------- shopping list export / Send to Home Assistant ----------
  // Both actions work off the same "what's still unshopped this week" list:
  // the combined ingredient lines (skipping anything already checked off)
  // plus any manually-added extra items (skipping checked ones there too) -
  // formatted the same "qty unit name" way the on-screen list shows them.

  var haConfig = { baseUrl: "", todoEntity: "", hasToken: false, tokenPreview: null };

  function collectUnshoppedItems() {
    var weekKey = state.activeWeek;
    var sl = ensureShoppingList(weekKey);
    var lines = buildShoppingLines(weekKey);
    var texts = [];

    lines.forEach(function (line) {
      if (sl.checked[line.key]) return;
      var qtyUnit = (fmtQty(line.quantity) + " " + line.unit).trim();
      texts.push((qtyUnit ? qtyUnit + " " : "") + line.name);
    });

    sl.extraItems.forEach(function (item) {
      if (item.checked) return;
      var qtyUnit = ((item.quantity || "") + " " + (item.unit || "")).trim();
      texts.push((qtyUnit ? qtyUnit + " " : "") + item.name);
    });

    return texts;
  }

  function openExportModal() {
    var items = collectUnshoppedItems();
    var textarea = document.getElementById("export-text");
    textarea.value = items.length ? items.join("\n") : "Nothing left on this week's list.";
    document.getElementById("export-overlay").hidden = false;
    textarea.focus();
    textarea.select();
  }

  function closeExportModal() {
    document.getElementById("export-overlay").hidden = true;
  }

  function downloadExportText() {
    var text = document.getElementById("export-text").value;
    var blob = new Blob([text], { type: "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "shopping-list-" + state.activeWeek + ".txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function initExportModal() {
    document.getElementById("export-list-btn").addEventListener("click", openExportModal);
    document.getElementById("export-close-btn").addEventListener("click", closeExportModal);
    document.getElementById("export-close-btn-2").addEventListener("click", closeExportModal);
    document.getElementById("export-overlay").addEventListener("click", function (e) {
      if (e.target.id === "export-overlay") closeExportModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("export-overlay").hidden) closeExportModal();
    });
    document.getElementById("export-download-btn").addEventListener("click", downloadExportText);
  }

  function loadHaConfig() {
    return jsonFetch("/api/meals/homeassistant-config").then(function (cfg) {
      haConfig = cfg;
      return cfg;
    }).catch(function () {
      return haConfig;
    });
  }

  function refreshHaSettingsForm() {
    document.getElementById("ha-base-url").value = haConfig.baseUrl || "";
    document.getElementById("ha-todo-entity").value = haConfig.todoEntity || "";
    var tokenInput = document.getElementById("ha-token");
    tokenInput.value = "";
    tokenInput.placeholder = haConfig.hasToken
      ? ("Current token " + haConfig.tokenPreview + " — leave blank to keep it")
      : "Paste your long-lived access token";
    document.getElementById("ha-settings-current").textContent = haConfig.hasToken
      ? "Connected. Change any field below and save to update it."
      : "Not set up yet — fill in all three fields below.";
  }

  function openHaSettingsModal() {
    refreshHaSettingsForm();
    document.getElementById("ha-settings-status").textContent = "";
    document.getElementById("ha-settings-overlay").hidden = false;
  }

  function closeHaSettingsModal() {
    document.getElementById("ha-settings-overlay").hidden = true;
  }

  function saveHaSettings() {
    var status = document.getElementById("ha-settings-status");
    var btn = document.getElementById("ha-settings-save-btn");
    var payload = {
      baseUrl: document.getElementById("ha-base-url").value.trim(),
      todoEntity: document.getElementById("ha-todo-entity").value.trim(),
      token: document.getElementById("ha-token").value.trim()
    };

    btn.disabled = true;
    status.textContent = "Testing connection…";

    jsonFetch("/api/meals/homeassistant-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (result) {
      haConfig = result;
      refreshHaSettingsForm();
      status.textContent = "Connected to “" + result.friendlyName + "” — settings saved.";
    }).catch(function (e) {
      status.textContent = "Couldn't save: " + e.message;
    }).then(function () {
      btn.disabled = false;
    });
  }

  function initHaSettingsModal() {
    document.getElementById("ha-settings-gear-btn").addEventListener("click", openHaSettingsModal);
    document.getElementById("ha-settings-close-btn").addEventListener("click", closeHaSettingsModal);
    document.getElementById("ha-settings-overlay").addEventListener("click", function (e) {
      if (e.target.id === "ha-settings-overlay") closeHaSettingsModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("ha-settings-overlay").hidden) closeHaSettingsModal();
    });
    document.getElementById("ha-settings-save-btn").addEventListener("click", saveHaSettings);
  }

  function initSendToHomeAssistant() {
    document.getElementById("send-ha-btn").addEventListener("click", function () {
      var status = document.getElementById("export-status");

      if (!haConfig.hasToken || !haConfig.baseUrl || !haConfig.todoEntity) {
        status.textContent = "Set up Home Assistant first — click the gear next to this button.";
        openHaSettingsModal();
        return;
      }

      var items = collectUnshoppedItems();
      if (!items.length) {
        status.textContent = "Nothing left on this week's list to send.";
        return;
      }

      var ok = confirm(
        "Send " + items.length + " item" + (items.length === 1 ? "" : "s") +
        " to Home Assistant's “" + (haConfig.todoEntity) + "” list?"
      );
      if (!ok) return;

      var btn = document.getElementById("send-ha-btn");
      btn.disabled = true;
      status.textContent = "Sending…";

      jsonFetch("/api/meals/send-to-homeassistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items })
      }).then(function (result) {
        status.textContent = "Sent " + result.added + " item" + (result.added === 1 ? "" : "s") + " to Home Assistant" +
          (result.failed && result.failed.length ? (" (" + result.failed.length + " failed — try those manually)") : ".");
      }).catch(function (e) {
        status.textContent = "Couldn't send: " + e.message;
      }).then(function () {
        btn.disabled = false;
      });
    });
  }

  // ---------- import recipe modal ----------

  function setImportStatus(text) {
    document.getElementById("import-status").textContent = text;
  }

  function updateServingsEcho() {
    var val = document.getElementById("import-servings").value || "1";
    document.getElementById("import-servings-echo").textContent = val;
  }

  function buildImportIngredientRow(rowObj) {
    var row = document.createElement("div");
    row.className = "ingredient-row";

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Ingredient";
    nameInput.value = rowObj.name || "";
    nameInput.addEventListener("input", function () { rowObj.name = nameInput.value; });

    var qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.min = "0";
    qtyInput.step = "any";
    qtyInput.placeholder = "Qty";
    qtyInput.className = "ingredient-qty-input";
    qtyInput.value = rowObj.quantity || "";
    qtyInput.addEventListener("input", function () { rowObj.quantity = parseFloat(qtyInput.value) || 0; });

    var unitInput = document.createElement("input");
    unitInput.type = "text";
    unitInput.placeholder = "cup, lb, box…";
    unitInput.className = "ingredient-unit-input";
    unitInput.value = rowObj.unit || "";
    unitInput.addEventListener("input", function () { rowObj.unit = unitInput.value; });

    var categorySelect = buildCategorySelect(rowObj.category || "Other", function (val) { rowObj.category = val; });

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-item-btn";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove ingredient";
    removeBtn.addEventListener("click", function () {
      var idx = importRows.indexOf(rowObj);
      if (idx > -1) importRows.splice(idx, 1);
      renderImportIngredientRows();
    });

    row.appendChild(nameInput);
    row.appendChild(qtyInput);
    row.appendChild(unitInput);
    row.appendChild(categorySelect);
    row.appendChild(removeBtn);
    return row;
  }

  function renderImportIngredientRows() {
    var container = document.getElementById("import-ingredients-list");
    container.innerHTML = "";
    if (!importRows.length) {
      container.innerHTML = '<p class="empty-row">No ingredients parsed yet - paste some above and click Parse Ingredients, or add a row by hand.</p>';
      return;
    }
    importRows.forEach(function (r) {
      container.appendChild(buildImportIngredientRow(r));
    });
  }

  function parseImportIngredients() {
    var text = document.getElementById("import-ingredients-text").value;
    var lines = text.split("\n")
      .map(function (l) { return l.replace(/^[\s\-*•]+/, "").trim(); })
      .filter(function (l) { return l; });

    importRows = lines.map(function (line) {
      var parsed = parseIngredientLine(line) || { name: line, quantity: 1, unit: "" };
      return { name: parsed.name, quantity: parsed.quantity, unit: parsed.unit, category: guessCategory(parsed.name) };
    });

    renderImportIngredientRows();
    setImportStatus(importRows.length
      ? ("Parsed " + importRows.length + " ingredient line(s) - double-check quantities, units, and categories below.")
      : "No ingredient lines found to parse.");
  }

  function fetchRecipeFromUrl() {
    var urlInput = document.getElementById("import-url");
    var url = urlInput.value.trim();
    if (!url) { setImportStatus("Enter a URL first."); return; }

    var fetchBtn = document.getElementById("import-fetch-btn");
    fetchBtn.disabled = true;
    setImportStatus("Fetching…");

    jsonFetch("/api/meals/import-recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url })
    }).then(function (result) {
      document.getElementById("import-meal-name").value = result.name || "";
      document.getElementById("import-servings").value = result.servings || 1;
      updateServingsEcho();
      document.getElementById("import-ingredients-text").value = (result.ingredientLines || []).join("\n");
      document.getElementById("import-instructions").value = result.instructions || "";
      parseImportIngredients();
      setImportStatus("Fetched " + (result.ingredientLines || []).length + " ingredient line(s) from the page. Review below, then Add to Meals.");
    }).catch(function (e) {
      setImportStatus("Couldn't import: " + e.message);
    }).then(function () {
      fetchBtn.disabled = false;
    });
  }

  function commitImportedMeal() {
    var name = document.getElementById("import-meal-name").value.trim() || "Imported Recipe";
    var servings = parseFloat(document.getElementById("import-servings").value) || 1;
    if (servings <= 0) servings = 1;

    var validRows = importRows.filter(function (r) { return (r.name || "").trim(); });
    if (!validRows.length) {
      setImportStatus("Add at least one ingredient first.");
      return;
    }

    var sourceUrl = document.getElementById("import-url").value.trim();

    // Quantities are stored exactly as entered/parsed - i.e. for this
    // recipe's own serving count (the "servings" value above), same as how
    // a printed recipe lists ingredients. The shopping list scales them
    // relative to that base count, so this stays correct however servings
    // is assigned on the Weekly Plan.
    var ingredients = validRows.map(function (r) {
      return {
        id: nextId(),
        name: r.name.trim(),
        quantity: Number(r.quantity) || 0,
        unit: r.unit || "",
        category: r.category || "Other"
      };
    });

    var meal = {
      id: nextId(),
      name: name,
      notes: sourceUrl ? ("Imported from " + sourceUrl) : "",
      instructions: document.getElementById("import-instructions").value.trim(),
      sourceUrl: sourceUrl || "",
      servings: servings,
      ingredients: ingredients
    };

    state.meals.push(meal);
    expandedMealIds[meal.id] = true;
    renderMealsStructure();
    renderPlanStructure();
    scheduleSave();

    closeImportModal();
  }

  function openImportModal() {
    document.getElementById("import-url").value = "";
    document.getElementById("import-meal-name").value = "";
    document.getElementById("import-servings").value = 1;
    document.getElementById("import-ingredients-text").value = "";
    document.getElementById("import-instructions").value = "";
    importRows = [];
    renderImportIngredientRows();
    setImportStatus("");
    updateServingsEcho();
    document.getElementById("import-overlay").hidden = false;
  }

  function closeImportModal() {
    document.getElementById("import-overlay").hidden = true;
  }

  // ---------- meals settings gear (Import Recipe / Import All) ----------
  // Same open/close/outside-click/Escape pattern as the shared $ page-switcher
  // menu in nav.js, but page-specific since it's only relevant on the Meals
  // tab of this page.

  function closeSettingsMenu() {
    var trigger = document.getElementById("meals-settings-trigger");
    var menu = document.getElementById("meals-settings-menu");
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  function initMealsSettingsMenu() {
    var trigger = document.getElementById("meals-settings-trigger");
    var menu = document.getElementById("meals-settings-menu");
    if (!trigger || !menu) return;

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) {
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      } else {
        closeSettingsMenu();
      }
    });

    document.addEventListener("click", function (e) {
      if (!menu.hidden && e.target !== trigger && !menu.contains(e.target)) closeSettingsMenu();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeSettingsMenu();
    });
  }

  // ---------- bulk import: all of TheMealDB ----------

  function existingSourceUrls() {
    var set = {};
    state.meals.forEach(function (m) {
      if (m.sourceUrl) set[m.sourceUrl] = true;
    });
    return set;
  }

  function addMealFromFetchedRecipe(recipe) {
    var servings = Number(recipe.servings) > 0 ? Number(recipe.servings) : 1;
    // Same convention as the single-recipe import: store quantities as
    // published, for this recipe's own serving count - not divided down to
    // a per-1-serving basis. The shopping list scales relative to servings.
    var ingredients = (recipe.ingredientLines || []).map(function (line) {
      var parsed = parseIngredientLine(line) || { name: line, quantity: 1, unit: "" };
      return {
        id: nextId(),
        name: parsed.name,
        quantity: Number(parsed.quantity) || 0,
        unit: parsed.unit || "",
        category: guessCategory(parsed.name)
      };
    });

    state.meals.push({
      id: nextId(),
      name: recipe.name || "Imported Recipe",
      notes: recipe.sourceUrl ? ("Imported from " + recipe.sourceUrl) : "",
      instructions: recipe.instructions || "",
      sourceUrl: recipe.sourceUrl || "",
      servings: servings,
      ingredients: ingredients
    });
  }

  function initImportAllThemealdb() {
    var btn = document.getElementById("menu-import-all-themealdb-btn");
    var status = document.getElementById("import-all-status");
    if (!btn) return;

    btn.addEventListener("click", function () {
      closeSettingsMenu();
      var ok = confirm(
        "This fetches TheMealDB's entire public recipe database (300+ meals, with full " +
        "ingredients and instructions) and adds any you don't already have to your Meals " +
        "list. It can take a minute or two - keep this tab open until it finishes. Continue?"
      );
      if (!ok) return;

      btn.disabled = true;
      status.textContent = "Fetching TheMealDB's full recipe list… this can take a minute or two.";

      jsonFetch("/api/meals/import-all-themealdb", { method: "POST" })
        .then(function (result) {
          var recipes = result.recipes || [];
          var already = existingSourceUrls();
          var added = 0;
          var skipped = 0;

          recipes.forEach(function (recipe) {
            if (recipe.sourceUrl && already[recipe.sourceUrl]) {
              skipped++;
              return;
            }
            addMealFromFetchedRecipe(recipe);
            if (recipe.sourceUrl) already[recipe.sourceUrl] = true;
            added++;
          });

          renderMealsStructure();
          renderPlanStructure();
          scheduleSave();

          status.textContent = "Done - added " + added + " new meal" + (added === 1 ? "" : "s") +
            (skipped ? (", skipped " + skipped + " already in your list") : "") + ".";
        })
        .catch(function (e) {
          status.textContent = "Import failed: " + e.message;
        })
        .then(function () {
          btn.disabled = false;
        });
    });
  }

  function initImportModal() {
    document.getElementById("menu-import-recipe-btn").addEventListener("click", function () {
      closeSettingsMenu();
      openImportModal();
    });
    document.getElementById("import-close-btn").addEventListener("click", closeImportModal);
    document.getElementById("import-cancel-btn").addEventListener("click", closeImportModal);
    document.getElementById("import-overlay").addEventListener("click", function (e) {
      if (e.target.id === "import-overlay") closeImportModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("import-overlay").hidden) closeImportModal();
    });

    document.getElementById("import-fetch-btn").addEventListener("click", fetchRecipeFromUrl);
    document.getElementById("import-parse-btn").addEventListener("click", parseImportIngredients);
    document.getElementById("import-add-row-btn").addEventListener("click", function () {
      importRows.push({ name: "", quantity: 1, unit: "", category: "Other" });
      renderImportIngredientRows();
    });
    document.getElementById("import-servings").addEventListener("input", updateServingsEcho);
    document.getElementById("import-commit-btn").addEventListener("click", commitImportedMeal);
  }

  // ---------- init ----------

  function init() {
    initTabs();
    initMealsTab();
    initMealSearchPanel();
    initClearAllMeals();
    initWeekBar();
    initShoppingListActions();
    initImportModal();
    initImportAllThemealdb();
    initMealsSettingsMenu();
    initExportModal();
    initHaSettingsModal();
    initSendToHomeAssistant();
    loadHaConfig();

    fetch("/api/meals-data")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state = data || {};
        if (!state.meals) state.meals = [];
        if (!state.plans) state.plans = {};
        if (!state.shoppingLists) state.shoppingLists = {};
        if (!state.nextId) state.nextId = 1;
        if (!state.activeWeek) state.activeWeek = todayWeekKey();
        migrateImportedIngredientQuantities();

        renderMealsStructure();
        renderActiveWeek();
        setSaveStatus("All changes saved");
      })
      .catch(function () {
        setSaveStatus("Could not load data from the server");
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
