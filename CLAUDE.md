# Retirement Calculator — Project Instructions

## Session Start

**Reference documents:**
- `DESIGN.md` — visual/UI design system (colors, typography, spacing, layout)

## Dev Commands

```bash
# Backend (FastAPI, port 8000)
cd <repo-root>
source .venv/bin/activate
uvicorn backend.main:app --reload --host 0.0.0.0

# Frontend (React/Vite, port 5175)
cd frontend && npm run dev

# Tests
pytest backend/tests/
cd frontend && npm test   # vitest (twr.ts unit tests)
```

## Architecture

- **Backend**: FastAPI + SQLite (SQLModel, WAL mode). DB at `~/.retirement-calculator/retirement-calculator.db`
- **Frontend**: React + TypeScript (Vite). Proxied to backend via Vite config.
- **Data sources**: Empower (Playwright + response interception)

## Key Design Decisions

- **Raw data stored in DB, display cleaning happens in `main.py`** at API response time (not at sync time). Never store cleaned data.
- **`holding_type`** (e.g. "US Equity Fund", "Individual Stock") is computed in `_classify_holding_type()` in `main.py` — NOT stored in DB. Changing classification rules only requires server restart, no re-sync.
- **`asset_class`** (e.g. "US Equity", "Bond", "Cash") IS stored in the `holding` table. Comes from Empower raw data.
- **Account totals** come from the `Account` table (populated from Empower `getAccounts2` API), not by summing holdings.
- **Snapshots**: one row per (source, account_name, date). Same-day syncs overwrite. Used for period returns.
- **Performance (TWR) calculated entirely in frontend** (`twr.ts`): `GET /api/portfolio/history` returns raw snapshots + cash flows; browser computes True TWR via sub-period chaining. Account toggle is instant (no API call). `api.portfolio.get()` for the main portfolio, `api.portfolio.history()` for history.

## Market Pulse

- **`backend/market_fetcher.py`**: Production cron job (weekdays 12:00 UTC, before US market open) runs inside the Docker Compose backend service. Pulls SP500/NDX prices via yfinance, VIX/VXN via yfinance, RSI(14) computed locally, F&G from CNN unofficial endpoint (graceful degradation). On first run: auto-backfills 5Y of price history when `pricehistory` table has <30 rows.
- **`backend/market_pulse.py`**: Confluence engine. `classify_signal(signal, value)` → "opportunity"/"normal"/"caution". `compute_confluence(vix, vxn, fg, rsi)` → recommendation (加大定投/常规定投/谨慎追高). Panic override fires when VIX>35 OR VXN>45 regardless of other signals.
- **`backend/holding_mapper.py`**: `generate_notices(holdings, total_value, vix, vxn)` — routes each holding to VIX or VXN signal based on `holding_type`; generates a personalized DCA notice when signal ≠ "normal" and weight ≥ 5%. Deduplicates by ticker across accounts.
- **Signal zones**: VIX <12=caution, 12–20=normal, >20=opp, >35=override. VXN <15=caution, 15–22=normal, >22=opp, >45=override. F&G <45=opp, 45–55=normal, >55=caution. RSI <50=opp, 50–70=normal, >70=caution.
- **`GET /api/market-pulse`**: Returns signals (with 7-day delta), price_history, confluence, notices, stale flag (>36h). Calls `get_portfolio()` directly to reuse dedup logic.
- **DB tables**: `pricehistory` (SP500/NDX daily closes, 5Y), `marketsignals` (daily VIX/VXN/F&G/RSI).

## Empower Sync

- Uses Playwright persistent Chromium profile at `~/.retirement-calculator/chromium-profile/`
- Intercepts two API calls in one browser session:
  - `getHoldings` → holdings data
  - `getAccounts2` → accurate per-account balances
- Navigation sequence: login → wait for dashboard → `/portfolio/balances` → `/portfolio/holdings`

## Language

- User communicates in Chinese. Code, comments, and file names are in English.
- UI labels are in Chinese (Simplified).

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Work Principles

- **复杂逻辑，确认之后再改**：对于涉及核心算法、业务规则、计算公式等较复杂或存在设计歧义的修改，必须先与用户进行讨论确认，明确设计意图并获得许可后再修改代码，避免自作聪明或盲目替用户做决策。
