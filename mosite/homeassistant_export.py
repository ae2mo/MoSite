"""
homeassistant_export.py - sends Meal Planner shopping list items straight
into a Home Assistant To-do list (e.g. the built-in "Shopping List"
integration, or any todo.* entity) via Home Assistant's REST API.

Needs a Home Assistant Long-Lived Access Token (Home Assistant -> your
profile -> Security tab -> Long-Lived Access Tokens -> Create Token) and the
entity id of the to-do list to fill in (usually todo.shopping_list - check
Settings -> Devices & Services -> Entities in Home Assistant if unsure).

Pure standard library (urllib) - no extra pip installs, same approach as
meals_recipe_import.py. Config (URL/token/entity) is stored locally in
homeassistant_config.json, same pattern as stocks_config.json for the Stock
Trader page: the token is never sent back to the browser, only a short
preview and whether one is set.
"""

import json
import os
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("MOSITE_DATA_DIR") or BASE_DIR  # see server.py
CONFIG_FILE = os.path.join(DATA_DIR, "homeassistant_config.json")


# ---------- config (base URL / token - never hardcoded, never committed) ----------

def load_config():
    if not os.path.exists(CONFIG_FILE):
        raise ValueError(
            "Home Assistant isn't set up yet - click the gear next to "
            "“Send to Home Assistant” and fill in your URL, token, and "
            "shopping list entity."
        )
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    for field in ("baseUrl", "token", "todoEntity"):
        if not cfg.get(field):
            raise ValueError("Home Assistant settings are incomplete - open the settings gear and fill in the missing field(s).")
    return cfg


def get_config_public():
    """Safe-to-return view of the config file: never sends the actual token
    back to the browser, only whether one is set and a short preview."""
    if not os.path.exists(CONFIG_FILE):
        return {"baseUrl": "", "todoEntity": "", "hasToken": False, "tokenPreview": None}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"baseUrl": "", "todoEntity": "", "hasToken": False, "tokenPreview": None}

    token = cfg.get("token", "") or ""
    preview = (token[:4] + "…" + token[-4:]) if len(token) > 8 else (token if token else None)
    return {
        "baseUrl": cfg.get("baseUrl", "") or "",
        "todoEntity": cfg.get("todoEntity", "") or "",
        "hasToken": bool(token),
        "tokenPreview": preview,
    }


def _save_config_file(cfg):
    tmp_path = CONFIG_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp_path, CONFIG_FILE)


def save_config(payload):
    """Writes homeassistant_config.json from the settings modal. Tests the
    connection before saving anything, so a typo'd URL/token/entity is
    caught immediately instead of silently failing the next time you try
    to send a list. A blank token field means "keep the current one" (same
    convention as the Stock Trader settings), so you can fix the URL or
    entity id without retyping the token."""
    cfg = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, OSError):
            cfg = {}

    base_url = (payload.get("baseUrl") or "").strip()
    todo_entity = (payload.get("todoEntity") or "").strip()
    token = (payload.get("token") or "").strip()

    if base_url:
        cfg["baseUrl"] = base_url
    if todo_entity:
        cfg["todoEntity"] = todo_entity
    if token:
        cfg["token"] = token

    if not cfg.get("baseUrl") or not cfg.get("token") or not cfg.get("todoEntity"):
        raise ValueError("Fill in the Home Assistant URL, access token, and shopping list entity before saving.")

    result = test_connection(cfg["baseUrl"], cfg["token"], cfg["todoEntity"])
    _save_config_file(cfg)
    result.update(get_config_public())
    return result


# ---------- Home Assistant REST API ----------

def _request(base_url, token, method, path, body=None):
    url = base_url.rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        return json.loads(raw.decode("utf-8")) if raw else None


def test_connection(base_url, token, todo_entity):
    """Confirms the URL/token are valid and the given entity exists and
    looks like a to-do list, by asking Home Assistant for its current
    state. Raises ValueError with a specific, actionable message on any
    failure - never a raw traceback."""
    if not base_url or not token or not todo_entity:
        raise ValueError("Fill in the Home Assistant URL, access token, and shopping list entity.")
    try:
        state = _request(base_url, token, "GET", "/api/states/" + todo_entity)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError("Home Assistant rejected that token (401 Unauthorized) - check it was copied correctly and hasn't been revoked.")
        if e.code == 404:
            raise ValueError("Home Assistant has no entity called '%s'. Check Settings > Devices & Services > Entities for the right id." % todo_entity)
        raise ValueError("Home Assistant returned an error (HTTP %s)." % e.code)
    except urllib.error.URLError as e:
        raise ValueError("Couldn't reach Home Assistant at that URL: %s" % e.reason)
    except Exception as e:
        raise ValueError("Couldn't read Home Assistant's response: %s" % e)

    if not state or not str(state.get("entity_id", "")).startswith("todo."):
        raise ValueError("'%s' doesn't look like a to-do list entity (its id should start with 'todo.')." % todo_entity)

    friendly_name = (state.get("attributes") or {}).get("friendly_name") or todo_entity
    return {"ok": True, "friendlyName": friendly_name}


def send_items(items):
    """Adds each item as a new to-do via the todo.add_item service, using
    the saved config. Best-effort per item - one item Home Assistant
    rejects doesn't abort the rest of the list."""
    cfg = load_config()
    base_url = cfg["baseUrl"]
    token = cfg["token"]
    todo_entity = cfg["todoEntity"]

    added = 0
    failed = []
    for item in items:
        text = (item or "").strip()
        if not text:
            continue
        try:
            _request(base_url, token, "POST", "/api/services/todo/add_item", {
                "entity_id": todo_entity,
                "item": text
            })
            added += 1
        except Exception:
            failed.append(text)

    return {"added": added, "failed": failed}
