"""
maintenance_recalls.py - NHTSA recall + VIN lookups for the Cars tab.

Uses NHTSA's free public APIs (no key needed), via the standard library:
  - vPIC VIN decoder   https://vpic.nhtsa.dot.gov/api/
  - Recalls by vehicle https://api.nhtsa.gov/recalls/recallsByVehicle

Note: the recalls API lists campaigns issued for a make / model / model year.
It can't say whether YOUR specific vehicle was already repaired - that needs
the VIN check on nhtsa.gov/recalls, which the UI points the user to.
"""

import json
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 HomeBudgetMaintenance/1.0"}


def _get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", errors="replace").strip()
    return json.loads(raw) if raw else {}


def decode_vin(vin):
    """Returns {year, make, model} for a 17-character VIN, or None."""
    vin = (vin or "").strip().upper()[:17]
    if len(vin) != 17:
        return None
    data = _get_json("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/%s?format=json" % urllib.parse.quote(vin))
    row = (data.get("Results") or [{}])[0]
    if not row.get("Make") or not row.get("Model") or not row.get("ModelYear"):
        return None
    return {"year": row["ModelYear"], "make": row["Make"], "model": row["Model"]}


def recalls_for(year, make, model):
    if not (year and make and model):
        raise ValueError("Need a year, make, and model to check recalls.")
    url = "https://api.nhtsa.gov/recalls/recallsByVehicle?" + urllib.parse.urlencode(
        {"make": make, "model": model, "modelYear": year}
    )
    data = _get_json(url)
    out = []
    for r in data.get("results") or []:
        out.append({
            "campaign": r.get("NHTSACampaignNumber", ""),
            "component": r.get("Component", ""),
            "summary": r.get("Summary", ""),
            "consequence": r.get("Consequence", ""),
            "remedy": r.get("Remedy", ""),
            "reported": r.get("ReportReceivedDate", ""),
            "parkIt": bool(r.get("parkIt")),
        })
    return out


def check(vin="", year="", make="", model=""):
    """Prefers the VIN decode (exact year/make/model); falls back to the
    year/make/model passed in. Returns {vehicle: {...}, recalls: [...]}."""
    vehicle = None
    try:
        vehicle = decode_vin(vin)
    except Exception:
        vehicle = None
    if not vehicle:
        vehicle = {"year": str(year or ""), "make": make or "", "model": model or ""}
    return {"vehicle": vehicle, "recalls": recalls_for(vehicle["year"], vehicle["make"], vehicle["model"])}
