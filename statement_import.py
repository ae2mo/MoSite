"""
statement_import.py - parses a bank/credit-card "Transaction List" PDF
statement into a flat list of transactions, for the Budget page's
"Import Statement" feature (Dashboard > Log a Receipt > Import Statement).

This module only extracts facts from the PDF (date, description, the
bank's own category label, amount, credit-or-debit). It has no opinion
about which of *your* budget categories/items each transaction belongs
to, or which ones you've already logged by hand - that review-and-decide
step happens client-side in app.js, same as everywhere else in this app
(the server has no opinion on budget schema).

Needs pdfplumber - the standard library has no PDF support:
    pip install -r requirements-statement-import.txt
Start Budget Site.bat installs this automatically.

Built against a real First Horizon "Transaction List" PDF export: a
bordered table with columns Date | Account | Description | Check # |
Category | Credit | Debit, one row per transaction, a header row repeated
on every page, and (usually) a "Totals: N items  <credit total>
<debit total>" line after the table. Column lookup is by header text
rather than a fixed position, and a trailing totals line is optional, so
minor variations in a similarly-laid-out statement shouldn't break this
outright - but a very differently structured statement (no grid lines,
scanned image, etc.) may not parse at all.
"""

import io
import re

_DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
_MONEY_RE = re.compile(r"-?\$?[\d,]+\.\d{2}")
_TOTALS_RE = re.compile(
    r"totals?:?\s*(\d+)\s*items?.*?\$?([\d,]+\.\d{2}).*?-?\$?([\d,]+\.\d{2})",
    re.IGNORECASE | re.DOTALL,
)


def _clean_cell(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", value.replace("\n", " ")).strip()


def _parse_money(text):
    if not text:
        return None
    text = text.strip()
    if not text:
        return None
    m = _MONEY_RE.search(text)
    if not m:
        return None
    raw = m.group(0)
    negative = raw.strip().startswith("-")
    amount = float(raw.replace("$", "").replace(",", "").lstrip("-"))
    return -amount if negative else amount


def _find_column_indexes(header_row):
    """Maps lowercased header text -> column index, so the parser isn't
    locked to one exact column order."""
    indexes = {}
    for i, raw_cell in enumerate(header_row):
        text = _clean_cell(raw_cell).lower()
        if text:
            indexes[text] = i
    return indexes


def _try_parse_totals_line(text):
    m = _TOTALS_RE.search(text)
    if not m:
        return None, None, None
    try:
        count = int(m.group(1))
        credit = float(m.group(2).replace(",", ""))
        debit = float(m.group(3).replace(",", ""))
        return count, credit, debit
    except ValueError:
        return None, None, None


def parse_statement_pdf(file_bytes):
    try:
        import pdfplumber
    except ImportError:
        raise ValueError(
            "Statement import needs the pdfplumber package. Install it with: "
            "pip install -r requirements-statement-import.txt "
            "(or just rerun Start Budget Site.bat, which does this automatically)."
        )

    transactions = []
    all_text_parts = []

    try:
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            col = None
            for page in pdf.pages:
                page_text = page.extract_text() or ""
                if page_text:
                    all_text_parts.append(page_text)

                for table in page.extract_tables() or []:
                    if not table:
                        continue
                    for row in table:
                        if not row:
                            continue
                        first_cell = _clean_cell(row[0])
                        if not first_cell:
                            continue

                        # Header row (repeated on every page) - (re)learn the
                        # column layout from it instead of assuming a fixed
                        # position, and skip it as data.
                        if first_cell.lower() == "date":
                            col = _find_column_indexes(row)
                            continue

                        # A totals/summary row sometimes ends up inside the
                        # last table too, depending on the PDF - skip it here,
                        # it's picked up from the plain text pass below.
                        if first_cell.lower().startswith("total"):
                            continue

                        if not _DATE_RE.match(first_cell):
                            continue  # not a row we recognize

                        if col is None:
                            continue  # never saw a header row - can't map columns safely

                        def cell(name):
                            idx = col.get(name)
                            return _clean_cell(row[idx]) if idx is not None and idx < len(row) else ""

                        description = cell("description")
                        bank_category = cell("category") or "Uncategorized"
                        credit_amount = _parse_money(cell("credit"))
                        debit_amount = _parse_money(cell("debit"))

                        if debit_amount:
                            amount, direction = abs(debit_amount), "debit"
                        elif credit_amount:
                            amount, direction = abs(credit_amount), "credit"
                        else:
                            continue  # no usable amount on this row

                        month, day, year = first_cell.split("/")
                        transactions.append({
                            "date": "%s-%s-%s" % (year, month, day),
                            "description": description,
                            "bankCategory": bank_category,
                            "amount": round(amount, 2),
                            "direction": direction,
                        })
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("Couldn't read that PDF: %s" % e)

    if not transactions:
        raise ValueError(
            "Couldn't find any transactions in that PDF. It may be a scanned "
            "image rather than a text-based statement, or laid out "
            "differently than what this was built against."
        )

    stated_count, stated_credit, stated_debit = _try_parse_totals_line("\n".join(all_text_parts))

    summary = {
        "count": len(transactions),
        "totalCredit": round(sum(t["amount"] for t in transactions if t["direction"] == "credit"), 2),
        "totalDebit": round(sum(t["amount"] for t in transactions if t["direction"] == "debit"), 2),
        "statedItemCount": stated_count,
        "statedTotalCredit": stated_credit,
        "statedTotalDebit": stated_debit,
    }

    return {"transactions": transactions, "summary": summary}
