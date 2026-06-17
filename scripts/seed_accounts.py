"""One-time script to manually seed the account table from Empower web UI data."""
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.config import db_path as _db_path
DB_PATH = _db_path()
import sqlite3

ACCOUNTS = [
    ("Interactive Brokers",            "Zhe Wang - Ending in 0893",                              "Individual",   752915.34),
    ("Merrill Lynch Merrill Edge",     "Cma Edge 8t - Ending in 8t77",                           "CMA",          596111.42),
    ("Manual Investment Holdings",     "questrade-shiwei",                                        "Individual",   488256.22),
    ("Fidelity Investments",           "Roth Ira - Ending in 3218",                               "Roth IRA",     190545.27),
    ("Fidelity NetBenefits",           "Doordash 401(k) Plan - Ending in 9429",                   "401K",         158617.34),
    ("Fidelity NetBenefits",           "Roth Ira - Ending in 3238",                               "Roth IRA",     134765.50),
    ("Charles Schwab",                 "Pcra Trust - Ending in 680",                              "401K",         132712.62),
    ("E*TRADE from Morgan Stanley",    "Securities - Ending in 6670",                             "Individual",   117719.41),
    ("Fidelity Investments",           "Roku, Inc 401(k) Plan - Ending in 0330",                  "401K",         107734.92),
    ("E*TRADE - Employee Stock Plans", "Stock Plan (roku) - Ending in 6670",                      "Stock Plan",    98694.42),
    ("E*TRADE - Employee Stock Plans", "Stock Plan (dash) - Ending in 4236",                      "Stock Plan",    72880.72),
    ("Charles Schwab",                 "Pcra Trust - Ending in 623",                              "401K",          56170.04),
    ("Fidelity NetBenefits",           "Rollover Ira - Ending in 0764",                           "IRA",           43069.38),
    ("Charles Schwab",                 "Roth Contributory Ira - Ending in 653",                   "Roth IRA",      22568.02),
    ("Charles Schwab",                 "Roth Contributory Ira - Ending in 506",                   "Roth IRA",      10821.41),
    ("Charles Schwab",                 "Custodial - Ending in 232",                               "Custodial",      7340.74),
    ("Fidelity Investments",           "Health Savings Account - Ending in 3235",                 "HSA",            4023.04),
    ("Fidelity Investments",           "Cash Management (individual Tod) - Ending in 9594",       "CMA",            3333.53),
    ("E*TRADE - Employee Stock Plans", "Stock Plan (cof) - Ending in 9730",                       "Stock Plan",      920.88),
    ("Fidelity NetBenefits",           "Individual Tod - Ending in 6322",                         "Individual",       11.88),
    ("Fidelity Investments",           "Individual Tod - Ending in 6322",                         "Individual",       11.85),
    ("Charles Schwab",                 "Contributory - Ending in 864",                            "Individual",        0.53),
    ("Charles Schwab",                 "Individual - Ending in 007",                              "Individual",        0.28),
    ("Charles Schwab",                 "Designated Beneficiary In - Ending in 485",               "Individual",        0.27),
    ("Charles Schwab",                 "Contributory - Ending in 113",                            "Individual",        0.05),
]

now = datetime.utcnow().isoformat()
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

cur.execute("DELETE FROM account")

for i, (firm, name, acct_type, balance) in enumerate(ACCOUNTS, start=1001):
    cur.execute("""
        INSERT INTO account (source, user_account_id, firm_name, name, account_type, balance, last_refreshed, closed_date, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    """, ("empower", i, firm, name, acct_type, balance, now))

conn.commit()
conn.close()
print(f"Inserted {len(ACCOUNTS)} accounts.")
