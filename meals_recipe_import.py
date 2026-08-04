"""
meals_recipe_import.py - fetches a recipe URL and extracts a recipe name
plus a list of raw ingredient-line strings from it.

Three sources are supported, tried in this order:
- TheMealDB (themealdb.com) has a free, clean JSON API (test key "1", fine
  for personal/development use per their terms - see themealdb.com/api.php)
  and is by far the most reliable source: a meal page URL's numeric id is
  pulled straight out of the URL and looked up directly through the API,
  no HTML scraping involved at all.
- Most other recipe sites publish Schema.org Recipe JSON-LD - the same
  structured markup they use so Google can show rich results. Reading that
  is far more reliable than trying to scrape whatever HTML/CSS a site
  happens to use.
- RecipeDB (cosylab.iiitd.edu.in/recipedb), an academic recipe/nutrition
  database, publishes no such structured data - its recipe pages have a
  plain HTML ingredient table instead (Ingredient Name / Quantity / Unit /
  State columns), so it gets its own small table-based extractor. This one
  has proven the least reliable of the three in practice.

Either way, this module only extracts what the site already published - it
never invents anything, and it does no ingredient-text parsing itself
(turning "2 cups flour" into a name/qty/unit happens client-side in
meals/app.js, shared with the "paste ingredients" path, so there's exactly
one parser to maintain regardless of where the lines came from).

Pure standard library - no extra pip installs needed, unlike the Stock
Trader page.
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 HomeMealPlannerBot/1.0"
)


def _fetch_html(url):
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def _fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return json.loads(resp.read().decode(charset, errors="replace"))


_LD_JSON_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def _iter_ld_json_blocks(html):
    for match in _LD_JSON_RE.finditer(html):
        raw = match.group(1).strip()
        if not raw:
            continue
        try:
            yield json.loads(raw)
        except json.JSONDecodeError:
            # A handful of sites emit slightly-malformed JSON (trailing
            # commas, comments) - not worth a full recovery parser for a
            # best-effort import feature, just skip anything that doesn't
            # parse cleanly and keep looking at the other script blocks.
            continue


def _is_recipe_type(type_value):
    if isinstance(type_value, str):
        return type_value.lower() == "recipe"
    if isinstance(type_value, list):
        return any(_is_recipe_type(t) for t in type_value)
    return False


def _find_recipe_node(data):
    """JSON-LD recipe data shows up in a few shapes across sites: a single
    Recipe object, an array of objects, or an object with a "@graph" list
    (common on WordPress recipe plugins). Walk all of them looking for
    something typed Recipe."""
    if isinstance(data, dict):
        if _is_recipe_type(data.get("@type")):
            return data
        graph = data.get("@graph")
        if isinstance(graph, list):
            for node in graph:
                found = _find_recipe_node(node)
                if found:
                    return found
    elif isinstance(data, list):
        for node in data:
            found = _find_recipe_node(node)
            if found:
                return found
    return None


def _parse_yield(value):
    """recipeYield varies wildly across sites: "4", "4 servings",
    ["4 servings"], 4, "4-6 servings"... Pull the first integer found and
    default to 1 (meaning "treat these amounts as already single-serving")
    if nothing usable is there. The import review screen always shows this
    number for the user to correct before anything is saved, so a wrong
    guess here is never silently baked in."""
    if isinstance(value, list) and value:
        value = value[0]
    if isinstance(value, (int, float)):
        return max(1, int(value))
    if isinstance(value, str):
        match = re.search(r"\d+", value)
        if match:
            return max(1, int(match.group(0)))
    return 1


def _clean_text(value):
    if value is None:
        return ""
    if isinstance(value, dict):
        value = value.get("name") or value.get("text") or ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _clean_instructions(value):
    """Like _clean_text, but for step-by-step instructions - collapses
    horizontal whitespace within a line without collapsing the line breaks
    between steps, so a multi-step recipe still reads as separate steps
    instead of one run-on paragraph."""
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    lines = [line for line in lines if line]
    return "\n".join(lines)


def _extract_ld_instructions(value):
    """recipeInstructions shows up as a plain string, a list of strings, a
    list of HowToStep objects ({"@type": "HowToStep", "text": "..."}), or a
    list of HowToSection objects that each nest their own itemListElement
    of HowToSteps. Flatten whatever shape shows up into one numbered-step
    string."""
    steps = []

    def walk(node):
        if node is None:
            return
        if isinstance(node, str):
            text = _clean_text(node)
            if text:
                steps.append(text)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            item_list = node.get("itemListElement")
            if item_list:
                walk(item_list)
            else:
                text = _clean_text(node.get("text") or node.get("name"))
                if text:
                    steps.append(text)

    walk(value)
    if not steps:
        return ""
    if len(steps) == 1:
        return steps[0]
    return "\n".join(str(i + 1) + ". " + s for i, s in enumerate(steps))


# ---------- TheMealDB (themealdb.com) ----------
# The most reliable of the three sources by far, since there's no HTML to
# guess at - a meal page's numeric id is pulled straight out of the URL
# (e.g. themealdb.com/meal/52772-teriyaki-chicken-casserole -> "52772") and
# looked up directly through the free JSON API.

_THEMEALDB_ID_RE = re.compile(r"/meal/(\d+)", re.IGNORECASE)


def _is_themealdb_url(url):
    return "themealdb.com" in url.lower()


def _meal_id_from_themealdb_url(url):
    match = _THEMEALDB_ID_RE.search(url)
    return match.group(1) if match else None


def _build_themealdb_result(meal, source_url):
    """Shared shaping logic for a single TheMealDB "meal" object (as returned
    by both lookup.php and, embedded, by the bulk import below) into this
    module's common recipe-import result shape."""
    ingredient_lines = []
    for i in range(1, 21):
        name = _clean_text(meal.get("strIngredient%d" % i))
        if not name:
            continue
        measure = _clean_text(meal.get("strMeasure%d" % i))
        ingredient_lines.append((measure + " " + name).strip() if measure else name)

    return {
        "name": _clean_text(meal.get("strMeal")) or "Imported Recipe",
        # TheMealDB doesn't publish a serving count either - same honest
        # default-to-1 fallback as every other source, editable on review.
        "servings": 1,
        "ingredientLines": ingredient_lines,
        "instructions": _clean_instructions(meal.get("strInstructions")),
        "sourceUrl": source_url,
    }


def _import_from_themealdb(url):
    meal_id = _meal_id_from_themealdb_url(url)
    if not meal_id:
        raise ValueError(
            "That looks like a TheMealDB page without a specific meal (a search, browse, "
            "or category page). Open a specific meal, then paste that page's URL here - it "
            "looks like themealdb.com/meal/52772-some-recipe-name."
        )

    api_url = "https://www.themealdb.com/api/json/v1/1/lookup.php?i=" + meal_id
    try:
        data = _fetch_json(api_url)
    except urllib.error.HTTPError as e:
        raise ValueError("TheMealDB returned an error (HTTP %s)." % e.code)
    except urllib.error.URLError as e:
        raise ValueError("Couldn't reach TheMealDB: %s" % e.reason)
    except Exception as e:
        raise ValueError("Couldn't read TheMealDB's response: %s" % e)

    meals = (data or {}).get("meals") or []
    if not meals:
        raise ValueError("TheMealDB doesn't have a meal with that id.")
    return _build_themealdb_result(meals[0], url)


# ---------- TheMealDB bulk import ("import everything") ----------
# TheMealDB doesn't offer a single "list every meal" endpoint, so this walks
# categories.php for the full category list, then filter.php?c=<category>
# for each category to collect every meal id (deduped, since a couple of
# meals show up filed under more than one category), then does one
# lookup.php call per id to get full ingredients/instructions - the same
# call _import_from_themealdb makes for a single recipe. For ~300+ meals
# this is a lot of small sequential requests, so it's meant to be called
# from a background thread, not inline in a request handler (see server.py).

def _themealdb_get(path_and_query):
    try:
        return _fetch_json("https://www.themealdb.com/api/json/v1/1/" + path_and_query)
    except urllib.error.HTTPError as e:
        raise ValueError("TheMealDB returned an error (HTTP %s)." % e.code)
    except urllib.error.URLError as e:
        raise ValueError("Couldn't reach TheMealDB: %s" % e.reason)
    except Exception as e:
        raise ValueError("Couldn't read TheMealDB's response: %s" % e)


def list_themealdb_categories():
    data = _themealdb_get("categories.php")
    cats = (data or {}).get("categories") or []
    return [c.get("strCategory") for c in cats if c.get("strCategory")]


def list_themealdb_meal_ids():
    """Every distinct meal id on TheMealDB, gathered by walking every
    category's filter listing (there's no bulk "list everything" endpoint)."""
    categories = list_themealdb_categories()
    if not categories:
        raise ValueError("Couldn't reach TheMealDB's category list.")

    seen = set()
    ids = []
    for category in categories:
        data = _themealdb_get("filter.php?c=" + urllib.parse.quote(category))
        for m in (data or {}).get("meals") or []:
            mid = m.get("idMeal")
            if mid and mid not in seen:
                seen.add(mid)
                ids.append(mid)
    return ids


def fetch_themealdb_meal_by_id(meal_id):
    """One lookup.php call, shaped into this module's common result dict.
    Returns None (rather than raising) on a missing/unreadable id, so a
    single bad id during a bulk import doesn't abort the whole batch."""
    try:
        data = _fetch_json("https://www.themealdb.com/api/json/v1/1/lookup.php?i=" + str(meal_id))
    except Exception:
        return None
    meals = (data or {}).get("meals") or []
    if not meals:
        return None
    meal = meals[0]
    source_url = "https://www.themealdb.com/meal/" + str(meal_id)
    return _build_themealdb_result(meal, source_url)


def import_all_themealdb():
    """Fetches every recipe TheMealDB has: every category, every meal id in
    each category, then full ingredients/instructions for each id. A small
    delay between lookups keeps this from hammering their free API. Skips
    (rather than aborting on) any single id that fails to fetch or parse -
    a partial result set beats an all-or-nothing failure three-quarters of
    the way through ~300 requests."""
    ids = list_themealdb_meal_ids()
    results = []
    for meal_id in ids:
        recipe = fetch_themealdb_meal_by_id(meal_id)
        if recipe:
            results.append(recipe)
        time.sleep(0.05)
    if not results:
        raise ValueError("Couldn't fetch any recipes from TheMealDB.")
    return results


def _import_from_ld_json(url, html):
    recipe = None
    for block in _iter_ld_json_blocks(html):
        recipe = _find_recipe_node(block)
        if recipe:
            break

    if not recipe:
        raise ValueError(
            "Couldn't find recipe data on that page. Some sites don't publish it in a "
            "format this can read - try pasting the ingredient list instead."
        )

    name = _clean_text(recipe.get("name"))
    servings = _parse_yield(recipe.get("recipeYield"))

    raw_ingredients = recipe.get("recipeIngredient") or recipe.get("ingredients") or []
    if isinstance(raw_ingredients, str):
        raw_ingredients = [raw_ingredients]
    ingredient_lines = [_clean_text(line) for line in raw_ingredients]
    ingredient_lines = [line for line in ingredient_lines if line]

    instructions = _extract_ld_instructions(recipe.get("recipeInstructions"))

    return {
        "name": name or "Imported Recipe",
        "servings": servings,
        "ingredientLines": ingredient_lines,
        "instructions": instructions,
        "sourceUrl": url,
    }


# ---------- RecipeDB (cosylab.iiitd.edu.in/recipedb) ----------
# No Schema.org markup here - individual recipe pages
# (.../recipedb/search_recipeInfo/<id>) instead render a plain HTML table
# titled "Estimated Nutritional Profile for Ingredients" with Ingredient
# Name / Quantity / Unit / State columns. We find that table by its header
# text (not a fixed position, in case the site ever reorders columns) and
# reconstruct one text line per ingredient ("3/4 ounce irish whiskey"),
# then hand those lines to the exact same client-side parser as every
# other import path.

class _TableExtractor(HTMLParser):
    """Collects every <table> on the page as a list of rows, each row a
    list of cell text strings - just enough structure to find "the table
    with an Ingredient/Quantity/Unit header" without a third-party HTML
    library. Doesn't handle tables nested inside other tables' cells."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._table_depth = 0
        self._in_row = False
        self._in_cell = False
        self._current_table = None
        self._current_row = None
        self._current_cell_text = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._table_depth += 1
            if self._table_depth == 1:
                self._current_table = []
        elif tag == "tr" and self._table_depth == 1:
            self._in_row = True
            self._current_row = []
        elif tag in ("td", "th") and self._in_row:
            self._in_cell = True
            self._current_cell_text = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._in_cell:
            text = " ".join("".join(self._current_cell_text).split())
            self._current_row.append(text)
            self._in_cell = False
        elif tag == "tr" and self._in_row:
            self._current_table.append(self._current_row)
            self._in_row = False
            self._current_row = None
        elif tag == "table" and self._table_depth:
            self._table_depth -= 1
            if self._table_depth == 0 and self._current_table is not None:
                self.tables.append(self._current_table)
                self._current_table = None

    def handle_data(self, data):
        if self._in_cell:
            self._current_cell_text.append(data)


class _HeadingExtractor(HTMLParser):
    """Collects the text of every h1-h4 on the page, in order, so we can
    pick out the recipe title without knowing the exact class names a
    given page uses."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.headings = []
        self._in_heading = False
        self._current = None

    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "h2", "h3", "h4"):
            self._in_heading = True
            self._current = []

    def handle_endtag(self, tag):
        if tag in ("h1", "h2", "h3", "h4") and self._in_heading:
            text = " ".join("".join(self._current).split())
            if text:
                self.headings.append(text)
            self._in_heading = False

    def handle_data(self, data):
        if self._in_heading:
            self._current.append(data)


def _find_ingredient_table(tables):
    for table in tables:
        if not table:
            continue
        header = [c.lower() for c in table[0]]
        if any("ingredient" in c for c in header) and any("quantity" in c for c in header):
            return table
    return None


def _column_index(header, keyword):
    for i, c in enumerate(header):
        if keyword in c:
            return i
    return None


def _extract_recipedb_ingredients(table):
    header = [c.lower() for c in table[0]]
    name_idx = _column_index(header, "ingredient")
    qty_idx = _column_index(header, "quantity")
    unit_idx = _column_index(header, "unit")
    state_idx = _column_index(header, "state")

    def cell(row, idx):
        return row[idx].strip() if idx is not None and idx < len(row) else ""

    lines = []
    for row in table[1:]:
        name = cell(row, name_idx)
        if not name:
            continue
        qty = cell(row, qty_idx)
        unit = cell(row, unit_idx)
        state = cell(row, state_idx)

        parts = [p for p in (qty, unit, name) if p]
        line = " ".join(parts)
        if state:
            line += " (" + state + ")"
        lines.append(line)
    return lines


def _guess_recipedb_name(html):
    extractor = _HeadingExtractor()
    extractor.feed(html)
    for heading in extractor.headings:
        lower = heading.strip().lower()
        if not lower or "cooking in progress" in lower or lower == "recipedb":
            continue
        return heading.strip()
    return None


def _is_recipedb_url(url):
    lower = url.lower()
    return "cosylab.iiitd.edu.in" in lower and "/recipedb" in lower


def _import_from_recipedb(url, html):
    if "/search_recipeinfo/" not in url.lower():
        raise ValueError(
            "That looks like a RecipeDB search or listing page, not a specific recipe. "
            "Search for a recipe on RecipeDB, open it, then paste that recipe's own page "
            "URL here (it looks like .../recipedb/search_recipeInfo/<number>)."
        )

    extractor = _TableExtractor()
    extractor.feed(html)
    table = _find_ingredient_table(extractor.tables)
    if not table or len(table) < 2:
        raise ValueError("Couldn't find an ingredient table on that RecipeDB page.")

    ingredient_lines = _extract_recipedb_ingredients(table)
    if not ingredient_lines:
        raise ValueError("Found an ingredient table on that RecipeDB page, but couldn't read any rows from it.")

    return {
        "name": _guess_recipedb_name(html) or "Imported Recipe",
        # RecipeDB doesn't publish a serving count on these pages, so this
        # defaults to 1 (amounts used as-is) - same honest fallback as
        # every other source, and it's editable in the review step.
        "servings": 1,
        "ingredientLines": ingredient_lines,
        # RecipeDB's pages don't publish step-by-step instructions either
        # (they're a nutrition/ingredient database, not a recipe blog) -
        # left blank here, same as every other field this source can't
        # provide; the review screen makes it obvious and editable.
        "instructions": "",
        "sourceUrl": url,
    }


def import_recipe(url):
    if not url or not str(url).strip():
        raise ValueError("No URL given.")
    url = str(url).strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError("That doesn't look like a valid URL - it should start with http:// or https://.")

    # TheMealDB is looked up straight through its JSON API - no page fetch
    # needed at all, so it's handled before the generic HTML fetch below.
    if _is_themealdb_url(url):
        return _import_from_themealdb(url)

    try:
        html = _fetch_html(url)
    except urllib.error.HTTPError as e:
        raise ValueError("The site returned an error (HTTP %s) - it may be blocking automated requests." % e.code)
    except urllib.error.URLError as e:
        raise ValueError("Couldn't reach that URL: %s" % e.reason)
    except Exception as e:
        raise ValueError("Couldn't fetch that page: %s" % e)

    if _is_recipedb_url(url):
        return _import_from_recipedb(url, html)

    return _import_from_ld_json(url, html)
