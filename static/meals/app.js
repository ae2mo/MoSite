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
  var SLOTS = ["breakfast", "lunch", "dinner"];
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
          var sides = plan[day].sides && plan[day].sides[slot];
          if (Array.isArray(sides)) {
            plan[day].sides[slot] = sides.filter(function (s) { return !s || s.mealId !== mealId; });
          }
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

    var sideLabel = document.createElement("label");
    sideLabel.className = "side-dish-toggle" + (meal.sideDish ? " on" : "");
    sideLabel.title = "Side dishes are offered under “+ Add side dish” on the Weekly Plan";
    var sideCheck = document.createElement("input");
    sideCheck.type = "checkbox";
    sideCheck.checked = !!meal.sideDish;
    sideCheck.addEventListener("change", function () {
      meal.sideDish = sideCheck.checked;
      sideLabel.classList.toggle("on", sideCheck.checked);
      renderPlanStructure();
      scheduleSave();
    });
    sideLabel.appendChild(sideCheck);
    sideLabel.appendChild(document.createTextNode("Side dish"));
    header.appendChild(sideLabel);

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
      servingsLabel.textContent = "Servings this recipe makes";
      var servingsField = document.createElement("input");
      servingsField.type = "number";
      servingsField.min = "0.5";
      servingsField.step = "0.5";
      servingsField.value = meal.servings || 1;
      servingsField.title = "For reference - how many servings one batch makes. On the Weekly Plan you pick 1x, 2x or 3x batches.";
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
    return { breakfast: null, lunch: null, dinner: null };
  }

  // Each slot holds either null (nothing assigned) or {mealId, multiplier}:
  // how many batches of the recipe to make (1x, 2x, 3x). The recipe's
  // ingredient amounts are multiplied by it on the shopping list.
  //
  // Older saves stored {mealId, servings} (servings relative to the
  // recipe's own default servings), and before that a bare meal id. Both
  // are converted here into the same multiplier the shopping list was
  // already using (servings / recipe servings), so existing plans keep
  // producing exactly the same amounts. Runs every time a week is touched.
  function normalizeAssignment(value) {
    if (value == null) return null;
    if (typeof value === "number") return { mealId: value, multiplier: 1 };
    if (typeof value !== "object" || value.mealId == null) return null;
    var mult = Number(value.multiplier);
    if (!(mult > 0)) {
      var meal = mealById(value.mealId);
      var base = meal && Number(meal.servings) > 0 ? Number(meal.servings) : 1;
      var serv = Number(value.servings);
      mult = serv > 0 ? Math.round((serv / base) * 100) / 100 : 1;
      if (!(mult > 0)) mult = 1;
    }
    return { mealId: value.mealId, multiplier: mult };
  }

  // Side dishes live next to each slot: plan[day].sides = {lunch: [...], dinner: [...]},
  // each entry the same {mealId, multiplier} shape as a main meal.
  function ensureWeekPlan(weekKey) {
    if (!state.plans[weekKey]) state.plans[weekKey] = {};
    var plan = state.plans[weekKey];
    DAYS.forEach(function (day) {
      if (!plan[day]) plan[day] = buildEmptyDayPlan();
      if (!plan[day].sides || typeof plan[day].sides !== "object") plan[day].sides = {};
      SLOTS.forEach(function (slot) {
        plan[day][slot] = normalizeAssignment(plan[day][slot]);
        var list = Array.isArray(plan[day].sides[slot]) ? plan[day].sides[slot] : [];
        plan[day].sides[slot] = list.map(normalizeAssignment).filter(Boolean);
      });
    });
    return plan;
  }

  // Every assignment in a slot - the main meal first, then its sides.
  function slotAssignments(plan, day, slot) {
    var out = [];
    if (plan[day][slot]) out.push({ assignment: plan[day][slot], side: false });
    ((plan[day].sides || {})[slot] || []).forEach(function (a) { out.push({ assignment: a, side: true }); });
    return out;
  }

  var MULTIPLIER_CHOICES = [1, 2, 3];

  function buildMultiplierSelect(current, onChange) {
    var sel = document.createElement("select");
    sel.className = "mult-select";
    sel.title = "How many times to make this recipe - multiplies its ingredients on the shopping list";
    var choices = MULTIPLIER_CHOICES.slice();
    if (choices.indexOf(current) === -1) {
      choices.push(current); // keeps an older non-whole amount (e.g. 1.5x) intact
      choices.sort(function (a, b) { return a - b; });
    }
    choices.forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = fmtQty(v) + "×";
      if (v === current) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () { onChange(Number(sel.value) || 1); });
    return sel;
  }

  // Meal picker. Recipes marked "Side dish" are grouped separately so the
  // main pick and the side pick each show the most likely choices first,
  // but nothing is ever hidden.
  function buildMealSelect(selectedId, placeholder, sidesFirst) {
    var select = document.createElement("select");
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = placeholder;
    select.appendChild(noneOpt);

    var sides = state.meals.filter(function (m) { return m.sideDish; });
    var mains = state.meals.filter(function (m) { return !m.sideDish; });

    function addOption(parent, meal) {
      var opt = document.createElement("option");
      opt.value = String(meal.id);
      opt.textContent = meal.name || "Untitled Meal";
      if (selectedId === meal.id) opt.selected = true;
      parent.appendChild(opt);
    }
    function addGroup(label, list) {
      if (!list.length) return;
      var group = document.createElement("optgroup");
      group.label = label;
      list.forEach(function (m) { addOption(group, m); });
      select.appendChild(group);
    }

    if (!sides.length) {
      state.meals.forEach(function (m) { addOption(select, m); });
    } else if (sidesFirst) {
      addGroup("Side dishes", sides);
      addGroup("Other meals", mains);
    } else {
      addGroup("Meals", mains);
      addGroup("Side dishes", sides);
    }
    return select;
  }

  function buildPlanSlotCell(day, slot, plan) {
    var wrap = document.createElement("div");
    wrap.className = "plan-slot";

    // main meal + its multiplier
    var mainRow = document.createElement("div");
    mainRow.className = "plan-slot-row";
    var assignment = plan[day][slot];
    var select = buildMealSelect(assignment ? assignment.mealId : null, "—", false);
    var multWrap = document.createElement("div");
    multWrap.className = "servings-wrap";
    multWrap.hidden = !assignment;
    multWrap.appendChild(buildMultiplierSelect(assignment ? assignment.multiplier : 1, function (v) {
      if (plan[day][slot]) { plan[day][slot].multiplier = v; scheduleSave(); }
    }));

    select.addEventListener("change", function () {
      if (!select.value) {
        plan[day][slot] = null;
      } else {
        var mealId = Number(select.value);
        var keep = plan[day][slot] && plan[day][slot].mealId === mealId ? plan[day][slot].multiplier : 1;
        plan[day][slot] = { mealId: mealId, multiplier: keep };
      }
      scheduleSave();
      renderPlanStructure();
    });

    mainRow.appendChild(select);
    mainRow.appendChild(multWrap);
    wrap.appendChild(mainRow);

    // side dishes
    var sides = plan[day].sides[slot];
    sides.forEach(function (side, idx) {
      var row = document.createElement("div");
      row.className = "plan-slot-row plan-side-row";
      var tag = document.createElement("span");
      tag.className = "side-tag";
      tag.textContent = "Side";
      var sideSelect = buildMealSelect(side.mealId, "— remove —", true);
      sideSelect.addEventListener("change", function () {
        if (!sideSelect.value) sides.splice(idx, 1);
        else side.mealId = Number(sideSelect.value);
        scheduleSave();
        renderPlanStructure();
      });
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-item-btn";
      removeBtn.innerHTML = "&times;";
      removeBtn.title = "Remove this side dish";
      removeBtn.addEventListener("click", function () {
        sides.splice(idx, 1);
        scheduleSave();
        renderPlanStructure();
      });
      row.appendChild(tag);
      row.appendChild(sideSelect);
      row.appendChild(buildMultiplierSelect(side.multiplier, function (v) { side.multiplier = v; scheduleSave(); }));
      row.appendChild(removeBtn);
      wrap.appendChild(row);
    });

    // "+ Add side dish" picker - choosing a recipe adds it straight away
    var addSide = buildMealSelect(null, "+ Add side dish", true);
    addSide.className = "add-side-select";
    addSide.title = "Add a side dish to " + day + " " + slot;
    addSide.addEventListener("change", function () {
      if (!addSide.value) return;
      sides.push({ mealId: Number(addSide.value), multiplier: 1 });
      scheduleSave();
      renderPlanStructure();
    });
    wrap.appendChild(addSide);
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

  // ----- merging the same item across recipes -----
  // Recipes word the same thing differently ("3 whole Carrots" / "2 carrots,
  // (peeled and sliced...)", "Ground Beef" / "lean ground beef"). To fold
  // those into one line the name is reduced to a matching key (prep notes and
  // simple descriptors dropped, last word made singular) and units are
  // grouped into families (weights, volumes, plain counts) so quantities can
  // be added together. The text shown is a cleaned version of the first
  // wording seen - this never changes the stored recipes.

  var NAME_DESCRIPTORS = /^(?:(?:fresh|freshly|lean|extra[- ]lean|large|medium|small|big|boneless|skinless|chopped|diced|minced|sliced|peeled|shredded|grated|ripe|raw|finely|roughly|thinly|coarsely)\s+)+/i;
  var NAME_TRAILING_PREP = /\s+(?:peeled|chopped|diced|minced|sliced|shredded|grated|halved|quartered|cubed|trimmed|rinsed|drained|divided|optional|melted|softened|thawed|beaten)(?:\s+and\s+\w+)*$/i;

  function cleanIngredientName(name) {
    var s = String(name || "");
    s = s.replace(/\([^)]*\)?/g, " ");       // (peeled and sliced...) - including an unclosed one
    s = s.split(",")[0];                      // ", cut into chunks"
    s = s.split(/\s+[-–—]\s+/)[0];  // " - optional"
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(NAME_DESCRIPTORS, "").replace(NAME_TRAILING_PREP, "").trim();
    return s;
  }

  function singularWord(w) {
    if (w.length <= 3) return w;
    if (/(ss|us|is)$/.test(w)) return w;
    if (/ies$/.test(w)) return w.slice(0, -3) + "y";
    if (/(oes|ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
    if (/s$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function ingredientMatchKey(cleaned) {
    var words = cleaned.toLowerCase().replace(/[^a-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return "";
    words[words.length - 1] = singularWord(words[words.length - 1]);
    return words.join(" ");
  }

  // family + size relative to the family's smallest unit (oz / tsp).
  var UNIT_FAMILIES = {
    oz: ["weight", 1], ounce: ["weight", 1], ounces: ["weight", 1],
    lb: ["weight", 16], lbs: ["weight", 16], pound: ["weight", 16], pounds: ["weight", 16],
    tsp: ["volume", 1], tsps: ["volume", 1], teaspoon: ["volume", 1], teaspoons: ["volume", 1],
    tbsp: ["volume", 3], tbsps: ["volume", 3], tbs: ["volume", 3], tablespoon: ["volume", 3], tablespoons: ["volume", 3],
    cup: ["volume", 48], cups: ["volume", 48],
    pt: ["volume", 96], pint: ["volume", 96], pints: ["volume", 96],
    qt: ["volume", 192], quart: ["volume", 192], quarts: ["volume", 192],
    "": ["count", 1], whole: ["count", 1], large: ["count", 1], medium: ["count", 1], small: ["count", 1]
  };

  var UNIT_PLURALS = {
    lb: "lbs", cup: "cups", clove: "cloves", can: "cans", slice: "slices", package: "packages",
    pkg: "pkgs", bunch: "bunches", head: "heads", stalk: "stalks", sprig: "sprigs",
    quart: "quarts", pint: "pints", pinch: "pinches", dash: "dashes"
  };

  function unitFamily(unit) {
    var u = String(unit || "").trim().toLowerCase().replace(/\.$/, "");
    if (UNIT_FAMILIES.hasOwnProperty(u)) return { family: UNIT_FAMILIES[u][0], size: UNIT_FAMILIES[u][1], raw: u };
    var single = singularWord(u);
    return { family: "other:" + single, size: 1, raw: single };
  }

  function pluralUnit(unit, qty) {
    return qty > 1 && UNIT_PLURALS[unit] ? UNIT_PLURALS[unit] : unit;
  }

  // Turns the summed base quantity (oz / tsp / plain count) back into a
  // friendly quantity + unit.
  function displayQuantity(family, baseQty, rawUnit) {
    var q, unit;
    if (family === "weight") {
      if (baseQty >= 16) { q = baseQty / 16; unit = "lb"; } else { q = baseQty; unit = "oz"; }
    } else if (family === "volume") {
      if (baseQty >= 48) { q = baseQty / 48; unit = "cup"; }
      else if (baseQty >= 3) { q = baseQty / 3; unit = "tbsp"; }
      else { q = baseQty; unit = "tsp"; }
    } else if (family === "count") {
      q = baseQty; unit = "";
    } else {
      q = baseQty; unit = rawUnit;
    }
    q = Math.round(q * 100) / 100;
    return { quantity: q, unit: pluralUnit(unit, q) };
  }

  function formatLineText(line) {
    var qtyUnit = (fmtQty(line.quantity) + " " + line.unit).trim();
    return (qtyUnit ? qtyUnit + " " : "") + line.name;
  }

  function buildShoppingLines(weekKey) {
    var plan = ensureWeekPlan(weekKey);
    var lines = {};

    DAYS.forEach(function (day) {
      SLOTS.forEach(function (slot) {
       slotAssignments(plan, day, slot).forEach(function (entry) {
        var assignment = entry.assignment;
        if (!assignment || assignment.mealId == null) return;
        var meal = mealById(assignment.mealId);
        if (!meal) return;
        // Ingredient quantities are stored as the recipe lists them; the
        // 1x/2x/3x picked on the Weekly Plan multiplies them.
        var scaleRatio = Number(assignment.multiplier) > 0 ? Number(assignment.multiplier) : 1;
        var mealLabel = meal.name + (scaleRatio !== 1 ? " (" + fmtQty(scaleRatio) + "×)" : "");

        meal.ingredients.forEach(function (ing) {
          var rawName = (ing.name || "").trim();
          if (!rawName) return;
          var cleaned = cleanIngredientName(rawName) || rawName;
          var nameKey = ingredientMatchKey(cleaned) || rawName.toLowerCase();
          var uf = unitFamily(ing.unit);
          var key = nameKey + "|" + uf.family;

          if (!lines[key]) {
            lines[key] = {
              key: key,
              name: cleaned.charAt(0).toUpperCase() + cleaned.slice(1),
              family: uf.family,
              rawUnit: uf.raw,
              category: ing.category || "Other",
              baseQty: 0,
              meals: []
            };
          }
          lines[key].baseQty += (Number(ing.quantity) || 0) * uf.size * scaleRatio;
          if (lines[key].meals.indexOf(mealLabel) === -1) lines[key].meals.push(mealLabel);
        });
       });
      });
    });

    return Object.keys(lines).map(function (k) {
      var line = lines[k];
      var d = displayQuantity(line.family, line.baseQty, line.rawUnit);
      line.quantity = d.quantity;
      line.unit = d.unit;
      return line;
    });
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
    textSpan.textContent = formatLineText(line);

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

  // ----- store walk order -----
  // The list follows a path through a typical Walmart-style store: in at the
  // front, along the outside wall through Produce, Meat and Dairy to the
  // back, then back toward the front through the center aisles, finishing
  // with drinks and bread near the front. Produce/Meat/Dairy come from the
  // ingredient's grocery category; center-aisle items are placed by what
  // they are (name keywords), because "Pantry" alone covers half the store.

  var STORE_SECTIONS = [
    { label: "Produce" },
    { label: "Meat & Seafood" },
    { label: "Dairy & Eggs" },
    { label: "Frozen", keys: ["frozen", "ice cream", "popsicle", "tater tot", "french fries"] },
    { label: "Breakfast & Coffee", keys: ["cereal", "oatmeal", "oats", "granola", "pancake mix", "waffle mix", "syrup", "maple syrup", "coffee", "tea", "creamer", "pop tart"] },
    { label: "Baking, Spices & Oils", keys: ["flour", "sugar", "brown sugar", "powdered sugar", "baking soda", "baking powder", "yeast", "vanilla", "vanilla extract", "cocoa", "chocolate chip", "cornstarch", "cornmeal", "shortening", "breadcrumb", "bread crumb", "panko", "oil", "olive oil", "vegetable oil", "canola oil", "cooking spray", "vinegar", "salt", "pepper", "black pepper", "cumin", "paprika", "smoked paprika", "cinnamon", "oregano", "thyme", "dried basil", "rosemary", "chili powder", "garlic powder", "onion powder", "seasoning", "spice", "nutmeg", "bay leaf", "bay leaves", "cayenne", "red pepper flake", "bouillon", "ginger powder", "turmeric", "allspice", "cloves"] },
    { label: "Canned Goods & Soups", keys: ["canned", "beans", "black beans", "kidney beans", "pinto beans", "chickpea", "broth", "stock", "soup", "tomato sauce", "tomato paste", "diced tomatoes", "crushed tomatoes", "tuna", "evaporated milk", "condensed milk", "coconut milk", "green chiles", "chipotle", "cream of"] },
    { label: "Pasta, Rice & International", keys: ["pasta", "spaghetti", "penne", "rotini", "macaroni", "noodle", "lasagna", "orzo", "egg noodles", "rice", "quinoa", "couscous", "marinara", "pasta sauce", "alfredo", "soy sauce", "teriyaki", "taco", "taco seasoning", "taco shell", "tortilla", "salsa", "enchilada sauce", "refried beans", "ramen", "curry"] },
    { label: "Other Pantry Items" },
    { label: "Condiments & Spreads", keys: ["ketchup", "mustard", "mayonnaise", "mayo", "dressing", "ranch", "bbq sauce", "barbecue sauce", "hot sauce", "sriracha", "worcestershire", "pickle", "relish", "peanut butter", "jelly", "jam", "honey", "olives"] },
    { label: "Snacks", keys: ["chips", "crackers", "cookies", "popcorn", "pretzels", "nuts", "almonds", "peanuts", "pecans", "walnuts", "granola bar", "trail mix", "raisins"] },
    { label: "Beverages", keys: ["juice", "soda", "water", "sparkling water", "wine", "beer", "lemonade", "sports drink"] },
    { label: "Bread & Bakery", keys: ["bread", "buns", "hamburger buns", "hot dog buns", "rolls", "dinner rolls", "bagel", "english muffin", "croissant", "pita"] },
    { label: "Other" }
  ];

  // Order the keyword checks so specific phrases win over generic words
  // ("taco seasoning" -> International, not Spices; "tomato sauce" -> Canned).
  var SECTION_CHECK_ORDER = [
    "Frozen", "Pasta, Rice & International", "Canned Goods & Soups", "Breakfast & Coffee",
    "Condiments & Spreads", "Snacks", "Bread & Bakery", "Beverages", "Baking, Spices & Oils"
  ];

  var CATEGORY_FALLBACK_SECTION = {
    "Frozen": "Frozen",
    "Beverages": "Beverages",
    "Bakery": "Bread & Bakery",
    "Spices & Condiments": "Baking, Spices & Oils",
    "Pantry": "Other Pantry Items",
    "Other": "Other"
  };

  var sectionRegexCache = {};
  function sectionRegex(section) {
    if (!sectionRegexCache[section.label]) {
      var parts = section.keys.slice().sort(function (a, b) { return b.length - a.length; }).map(function (k) {
        return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      });
      sectionRegexCache[section.label] = new RegExp("\\b(" + parts.join("|") + ")(e?s)?\\b", "i");
    }
    return sectionRegexCache[section.label];
  }

  function sectionByLabel(label) {
    for (var i = 0; i < STORE_SECTIONS.length; i++) if (STORE_SECTIONS[i].label === label) return i;
    return STORE_SECTIONS.length - 1;
  }

  // Phrases that clearly mean a center-aisle item even when the ingredient's
  // category says Produce/Meat/Dairy (the automatic category guess files
  // "chicken broth" under Meat and "garlic powder" under Produce).
  var PANTRY_OVERRIDE = /\b(broth|stock|soup|bouillon|cream of|peanut butter|coconut milk|condensed milk|evaporated milk|powder|seasoning|tomato sauce|tomato paste|crushed tomatoes|diced tomatoes|salsa|frozen|dried|flakes|extract)\b/i;

  // Best keyword match across the center-aisle sections: the longest
  // matching phrase wins ("taco seasoning" beats "seasoning", "chocolate
  // chips" beats "chips"); ties go to SECTION_CHECK_ORDER.
  function bestKeywordSection(name) {
    var best = -1, bestLen = 0;
    for (var i = 0; i < SECTION_CHECK_ORDER.length; i++) {
      var idx = sectionByLabel(SECTION_CHECK_ORDER[i]);
      var m = sectionRegex(STORE_SECTIONS[idx]).exec(name);
      if (m && m[1].length > bestLen) { best = idx; bestLen = m[1].length; }
    }
    return best;
  }

  // Returns the index into STORE_SECTIONS for a shopping line or extra item.
  function storeSectionIndex(name, category) {
    var cat = category || "Other";
    var n = String(name || "");
    var perimeter = cat === "Produce" || cat === "Meat & Seafood" || cat === "Dairy & Eggs";
    if (perimeter && !PANTRY_OVERRIDE.test(n)) return sectionByLabel(cat);
    var kw = bestKeywordSection(n);
    if (kw !== -1) return kw;
    if (perimeter) return sectionByLabel(cat);
    return sectionByLabel(CATEGORY_FALLBACK_SECTION[cat] || "Other");
  }

  // The whole week's list in walking order: [{label, entries: [{line} | {extra}]}]
  function buildStoreWalk(weekKey) {
    var sl = ensureShoppingList(weekKey);
    var buckets = STORE_SECTIONS.map(function (s) { return { label: s.label, entries: [] }; });
    buildShoppingLines(weekKey).forEach(function (line) {
      buckets[storeSectionIndex(line.name, line.category)].entries.push({ line: line, sortName: line.name });
    });
    sl.extraItems.forEach(function (item) {
      buckets[storeSectionIndex(item.name, item.category)].entries.push({ extra: item, sortName: item.name || "" });
    });
    buckets.forEach(function (b) {
      b.entries.sort(function (a, c) { return a.sortName.localeCompare(c.sortName, undefined, { sensitivity: "base" }); });
    });
    return buckets.filter(function (b) { return b.entries.length; });
  }

  function renderShoppingList() {
    var weekKey = state.activeWeek;
    var sl = ensureShoppingList(weekKey);
    var walk = buildStoreWalk(weekKey);

    var container = document.getElementById("shopping-list");
    container.innerHTML = "";

    if (!walk.length) {
      container.innerHTML = '<p class="empty-row">No items yet — assign some meals above, or add an extra item below.</p>';
      return;
    }

    walk.forEach(function (section) {
      var group = document.createElement("div");
      group.className = "shopping-group";
      var heading = document.createElement("h3");
      heading.textContent = section.label;
      group.appendChild(heading);
      section.entries.forEach(function (entry) {
        group.appendChild(entry.line ? buildShoppingLineRow(entry.line, sl) : buildExtraItemRow(entry.extra, sl));
      });
      container.appendChild(group);
    });
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
    var texts = [];

    // Same walking order as the on-screen list (see buildStoreWalk), with
    // hand-added extra items in their aisle rather than tacked on the end.
    buildStoreWalk(weekKey).forEach(function (section) {
      section.entries.forEach(function (entry) {
        if (entry.line) {
          if (sl.checked[entry.line.key]) return;
          texts.push(formatLineText(entry.line));
        } else {
          var item = entry.extra;
          if (item.checked) return;
          var qtyUnit = ((item.quantity || "") + " " + (item.unit || "")).trim();
          texts.push((qtyUnit ? qtyUnit + " " : "") + item.name);
        }
      });
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
