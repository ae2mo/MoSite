"""
ha_start.py - entry point when MoSite runs as a Home Assistant add-on.

The add-on keeps your data in /config (shown on the Samba share as
addon_configs\\local_mosite), which survives rebuilds and is included in
Home Assistant backups. On the very first start, any data files that were
copied over along with the code (data.json, meals_data.json, ...) are moved
into /config so you pick up exactly where you left off. After that, /config
is the only copy the add-on reads or writes - files in the code folder are
never used again, so a later re-copy of the code can't overwrite your data.
"""

import os
import runpy
import shutil

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("MOSITE_DATA_DIR") or "/config"

SEED_FILES = [
    "data.json",
    "meals_data.json",
    "maintenance_data.json",
    "stocks_data.json",
    "stocks_config.json",
    "homeassistant_config.json",
]

os.makedirs(DATA_DIR, exist_ok=True)
for name in SEED_FILES:
    src = os.path.join(APP_DIR, name)
    dest = os.path.join(DATA_DIR, name)
    if os.path.isfile(src) and not os.path.exists(dest):
        shutil.copy2(src, dest)
        print("MoSite: copied %s into %s" % (name, DATA_DIR))

src_backups = os.path.join(APP_DIR, "backups")
dest_backups = os.path.join(DATA_DIR, "backups")
if os.path.isdir(src_backups) and not os.path.exists(dest_backups):
    shutil.copytree(src_backups, dest_backups)

runpy.run_path(os.path.join(APP_DIR, "server.py"), run_name="__main__")
