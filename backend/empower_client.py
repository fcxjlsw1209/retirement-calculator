from __future__ import annotations

"""
Empower API client.

Strategy: Playwright Chromium with persistent profile + response interception.

First run:
  - Visible Chromium opens, auto-fills credentials, user completes MFA.
  - After MFA, user lands on dashboard. We periodically try SPA hash
    navigation (#/investments). Once investments loads, the Empower app
    itself calls getHoldings — we intercept the response.
  - Profile saved to ~/.retirement-calculator/chromium-profile/ (cookies + localStorage
    = device trust persisted).

Subsequent runs:
  - Same profile → Empower recognizes trusted device → no MFA.
  - Navigate straight to investments, intercept getHoldings, done.

Key design decisions:
  - Never detect "login complete" by URL (MFA pages also lack "login" in URL).
  - Use SPA hash navigation every 5s after leaving auth pages — harmless
    on auth pages (router overrides), effective on dashboard.
  - Browser stays open until getHoldings is actually captured (≤3 min).
"""

import json
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.config import (
    EMPOWER_EMAIL,
    EMPOWER_PASSWORD,
    debug_dir,
    IS_GCP,
)

LOGIN_URL     = "https://ira.empower-retirement.com/"
DASHBOARD_URL = "https://participant.empower-retirement.com/dashboard/"
BALANCES_URL  = "https://participant.empower-retirement.com/dashboard/#/portfolio/balances"
HOLDINGS_URL  = "https://participant.empower-retirement.com/dashboard/#/portfolio/holdings"
HOLDINGS_HASH = "/portfolio/holdings"
BALANCES_HASH = "/portfolio/balances"
CHROMIUM_PROFILE = str(Path.home() / ".retirement-calculator" / "chromium-profile")

# Hash fragments that indicate we're still in the auth/MFA flow
# (checked against URL hash only — the holdings URL path contains "login" but isn't an auth page)
AUTH_HASH_HINTS = ("login", "pub", "mfa", "2fa", "otp", "verify",
                   "authenticate", "challenge", "factor", "multi", "noauth")


class EmpowerAuthError(Exception):
    pass


class EmpowerAPIError(Exception):
    pass


class EmpowerClient:

    async def fetch_holdings(self) -> Tuple[List[dict], List[dict]]:
        """Returns (holdings, accounts).

        Attaches to your real Chrome via CDP (port 9222).
        Start Chrome first with:
          /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222
        """
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            try:
                browser = await pw.chromium.connect_over_cdp("http://127.0.0.1:9222")
            except Exception as e:
                raise EmpowerAPIError(
                    "Could not connect to Chrome on 127.0.0.1:9222. "
                    "Start Chrome with:\n"
                    '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n'
                    f"Error: {e}"
                )
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            # Find the Empower tab if open, otherwise use the first page
            page = None
            for p in context.pages:
                if "empower-retirement.com" in p.url:
                    page = p
                    print(f"Empower: found tab at {p.url}")
                    break
            if page is None:
                page = context.pages[0] if context.pages else await context.new_page()
                print(f"Empower: no Empower tab found, using {page.url}")
            try:
                return await self._do_fetch_holdings(page)
            finally:
                await browser.close()

    async def _do_fetch_holdings(self, page) -> List[dict]:
        # Set up interceptors before any navigation
        captured: dict = {}        # getHoldings response
        captured_balances: dict = {}  # account-level balances response

        async def on_response(response):
            url = response.url
            # Log all non-static API calls to help identify endpoint names
            if ("empower" in url.lower() or "/api/" in url) and not any(
                url.endswith(ext) for ext in (".js", ".css", ".png", ".woff2", ".svg", ".ico")
            ):
                print(f"[intercept] {url}")

            if "getHoldings" in url and not captured:
                try:
                    captured["data"] = await response.json()
                except Exception:
                    pass

            # Log all Empower REST API JSON responses to find the accounts endpoint
            if "empower" in url.lower() and ("/rest/" in url or "/api/" in url) and not captured_balances:
                try:
                    body = await response.json()
                    if isinstance(body, dict):
                        sp = body.get("spData", {})
                        keys = list(sp.keys()) if isinstance(sp, dict) else []
                        print(f"[api-json] {url.split('?')[0].split('/')[-1]} keys={keys}")
                        if "accounts" in keys:
                            print(f"[balances] captured from: {url}")
                            captured_balances["data"] = body
                            captured_balances["url"] = url
                except Exception:
                    pass

        page.on("response", on_response)

        # Check current page before navigating anywhere
        url = page.url.lower()
        fragment = url.split("#")[1] if "#" in url else ""
        already_logged_in = "participant.empower-retirement.com/dashboard" in url and not any(h in fragment for h in AUTH_HASH_HINTS)

        if already_logged_in:
            # Hard reload so the SPA re-initializes and fires all initial API calls
            print("Empower: reloading page to trigger fresh API calls...")
            await page.reload(wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(12000)  # wait for all initial API calls to complete
        else:
            # Navigate to login page to initiate auth
            print(f"Empower: not on dashboard (url={page.url}), navigating to login...")
            await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2000)
            await self._fill_login(page)

        # Main loop: wait for MFA to complete, then navigate to balances
        # then holdings (both trigger their respective API calls).
        prev_url = ""
        stable_ticks = 0
        navigated_to_balances = False
        navigated_to_holdings = False

        for tick in range(180):
            await page.wait_for_timeout(1000)

            if captured:
                break

            url = page.url.lower()
            fragment = url.split("#")[1] if "#" in url else ""
            on_auth = any(h in fragment for h in AUTH_HASH_HINTS)

            if on_auth:
                stable_ticks = 0
                prev_url = url
                navigated_to_balances = False
                navigated_to_holdings = False
                continue

            if url == prev_url:
                stable_ticks += 1
            else:
                stable_ticks = 0
                prev_url = url

            if stable_ticks >= 10 and not navigated_to_balances and "dashboard" in url:
                print("Empower: auth complete, navigating to balances...")
                await page.goto(BALANCES_URL, wait_until="domcontentloaded", timeout=30000)
                navigated_to_balances = True
                stable_ticks = 0

            elif navigated_to_balances and not navigated_to_holdings and stable_ticks >= 5:
                print("Empower: navigating to holdings...")
                await page.goto(HOLDINGS_URL, wait_until="domcontentloaded", timeout=30000)
                navigated_to_holdings = True
                stable_ticks = 0

        if not captured:
            _log_debug("empower_timeout", {"url": page.url})
            raise EmpowerAPIError("getHoldings not captured within 3 minutes")

        resp = captured["data"]
        _log_debug("empower_holdings_resp", {
            "authLevel": resp.get("spHeader", {}).get("authLevel"),
            "success":   resp.get("spHeader", {}).get("success"),
            "errors":    resp.get("spHeader", {}).get("errors"),
        })
        self._check_response(resp, "empower_holdings")

        raw = resp.get("spData", {}).get("holdings", [])
        if not isinstance(raw, list):
            _log_debug("empower_holdings_unexpected", resp)
            raise EmpowerAPIError("Unexpected getHoldings response structure")

        if raw:
            _log_debug("empower_holdings_sample", raw[0])

        # Parse accounts from getAccounts2
        accounts: List[dict] = []
        account_lookup: Dict[int, dict] = {}
        if captured_balances:
            bal_resp = captured_balances["data"]
            try:
                self._check_response(bal_resp, "empower_accounts")
                _log_debug("empower_accounts_raw", bal_resp.get("spData", {}).get("accounts", []))
                accounts = _parse_accounts(bal_resp.get("spData", {}))
                account_lookup = {a["user_account_id"]: a for a in accounts}
                print(f"Empower: captured {len(accounts)} investment accounts")
            except Exception as e:
                print(f"Empower: could not parse accounts: {e}")
                # Log first account to understand structure
                raw_accounts = bal_resp.get("spData", {}).get("accounts", [])
                if raw_accounts:
                    print(f"Empower: account keys = {list(raw_accounts[0].keys())}")
        else:
            print("Empower: balances endpoint not captured — check [intercept] logs for URL")

        holdings = [_normalize_holding(h, account_lookup) for h in raw]
        return holdings, accounts

    async def _fill_login(self, page) -> None:
        """Session not active — prompt user to log in manually in Chrome."""
        print("Empower: not logged in — please log in at https://ira.empower-retirement.com in your Chrome window.")
        print("Empower: waiting up to 3 minutes for you to complete login...")

    async def start_auth(self) -> str:
        """Trigger auth flow (used by /api/auth/start endpoint)."""
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            context = await self._make_context(pw)
            page = context.pages[0] if context.pages else await context.new_page()
            try:
                await self._do_fetch_holdings(page)
                return "complete"
            except EmpowerAPIError:
                return "error"
            except EmpowerAuthError:
                return "error"
            finally:
                await context.close()

    def finish_auth(self, otp: str) -> bool:
        return False

    def _check_response(self, resp: dict, label: str) -> None:
        sp = resp.get("spHeader", {})
        errors = sp.get("errors", [])
        auth_level = sp.get("authLevel", "")
        if auth_level in ("NONE", "NONE_NEW") or any(
            e.get("code") in (201, 202) for e in errors
        ):
            raise EmpowerAuthError(
                f"{label}: insufficient auth level ({auth_level})"
            )
        if not sp.get("success"):
            _log_debug(label, resp)
            raise EmpowerAPIError(f"{label}: success=false, errors={errors}")


# ── Normalizers ────────────────────────────────────────────────────────────────

def _normalize_holding(raw: dict, account_lookup: Dict[int, dict] = {}) -> dict:
    user_account_id = raw.get("userAccountId")
    account = account_lookup.get(user_account_id, {})
    asset_class = _map_asset_class(raw.get("assetClass", ""))
    if asset_class == "Unknown":
        asset_class = _holding_type_to_asset_class(raw.get("holdingType", ""))
    return {
        "ticker":       raw.get("ticker") or raw.get("cusip"),
        "asset_class":  asset_class,
        "name":         raw.get("description") or raw.get("name"),
        "value_usd":    float(raw.get("value", 0) or 0),
        "shares":       float(raw.get("quantity", 0) or 0) or None,
        "cost_basis":   float(raw.get("costBasis", 0) or 0) or None,
        "account_name": raw.get("accountName") or account.get("name") or None,
        "account_type": account.get("account_type") or None,
    }


def _holding_type_to_asset_class(holding_type: str) -> str:
    return {
        "Stock":      "US Equity",
        "ETF":        "US Equity",
        "Fund":       "US Equity",
        "Bond":       "Bond",
        "CD":         "Bond",
        "Cash":       "Cash",
        "Currency":   "Cash",
        "Annuity":    "Alternative",
        "Insurance":  "Alternative",
    }.get(holding_type, "Unknown")


def _parse_accounts(spdata: dict) -> List[dict]:
    """Extract investment accounts from getAccounts2 spData."""
    INVESTMENT_GROUPS = {"INVESTMENT", "IRA", "401K", "403B", "457", "ESOP", "HSA", "PENSION"}
    result = []
    for a in spdata.get("accounts", []):
        if a.get("isLiability"):
            continue
        group = a.get("accountTypeGroup", "")
        product = a.get("productType", "")
        if group not in INVESTMENT_GROUPS and product != "INVESTMENT":
            continue
        user_account_id = a.get("userAccountId")
        if not user_account_id:
            continue
        raw_ts = a.get("lastRefreshed")
        last_refreshed = (
            datetime.utcfromtimestamp(raw_ts / 1000) if raw_ts else None
        )
        raw_closed = a.get("closedDate", "")
        try:
            closed_date = date.fromisoformat(raw_closed) if raw_closed else None
        except ValueError:
            closed_date = None
        result.append({
            "user_account_id": user_account_id,
            "firm_name":       a.get("firmName", ""),
            "name":            a.get("name", "") or a.get("accountName", ""),
            "account_type":    a.get("accountType", "") or a.get("accountTypeGroup", ""),
            "balance":         float(a.get("balance", 0) or 0),
            "last_refreshed":  last_refreshed,
            "closed_date":     closed_date,
        })
    return result


def _map_asset_class(empower_class: str) -> str:
    return {
        "US_STOCKS":    "US Equity",
        "INTL_STOCKS":  "International",
        "US_BONDS":     "Bond",
        "INTL_BONDS":   "Bond",
        "ALTERNATIVES": "Alternative",
        "CASH":         "Cash",
        "UNCLASSIFIED": "Unknown",
    }.get(empower_class.upper(), empower_class or "Unknown")


def _log_debug(label: str, data: Any) -> None:
    path = debug_dir() / f"{label}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    try:
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"Debug log: {path}")
    except Exception as e:
        print(f"Could not write debug log: {e}")


# ── Singleton ──────────────────────────────────────────────────────────────────

_client: Optional[EmpowerClient] = None


def get_client() -> EmpowerClient:
    global _client
    if _client is None:
        _client = EmpowerClient()
    return _client
