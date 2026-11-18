"""Standalone launcher for the shared MoSite server in mosite/."""

import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("MOSITE_DATA_DIR", str(ROOT))
sys.path.insert(0, str(ROOT / "mosite"))

from mosite.server import *  # Keep the tray launcher's existing server API.

if __name__ == "__main__":
    main()
