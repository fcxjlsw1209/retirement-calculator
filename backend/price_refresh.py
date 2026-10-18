"""Refresh indicative quotes without changing synced balances or performance history."""
from __future__ import annotations

import math
import re
from typing import Dict, List

import yfinance as yf
from backend import db

_SKIP_PATTERNS = [r'@', r'^[0-9]', r'^SPAXX$', r'^SPCK$']


def _should_skip(ticker: str) -> bool:
    return any(re.search(pattern, ticker) for pattern in _SKIP_PATTERNS)


def fetch_prices(tickers: List[str]) -> Dict[str, db.MarketQuote]:
    fetchable = sorted({t for t in tickers if not _should_skip(t)})
    if not fetchable:
        return {}
    # Unadjusted closes can be multiplied by current shares; adjusted history cannot.
    data = yf.download(fetchable, period="5d", auto_adjust=False, progress=False)
    if data.empty or "Close" not in data:
        return {}
    close = data["Close"]
    quotes = {}
    for ticker in fetchable:
        if close.ndim == 1:
            if len(fetchable) != 1:
                continue
            series = close
        elif ticker in close:
            series = close[ticker]
        else:
            continue
        series = series.dropna()
        if series.empty:
            continue
        price = float(series.iloc[-1])
        if math.isfinite(price) and price > 0:
            quotes[ticker] = db.MarketQuote(
                ticker=ticker, price=price, market_date=series.index[-1].date(),
            )
    return quotes


def run_price_refresh() -> dict:
    holdings = [h for h in db.get_all_holdings() if h.source == "empower"]
    if not holdings:
        return {"status": "error", "detail": "没有可刷新的持仓"}
    quotes = fetch_prices([h.ticker for h in holdings if h.ticker])
    if not quotes:
        return {"status": "error", "detail": "未获取到有效行情，请稍后重试"}
    db.save_market_quotes(list(quotes.values()))
    updated = sum(1 for h in holdings if h.ticker in quotes and h.shares is not None and h.shares > 0)
    return {
        "status": "ok", "total_holdings": len(holdings),
        "prices_updated": updated, "prices_skipped": len(holdings) - updated,
        "prices_fetched": len(quotes),
    }


if __name__ == "__main__":
    print(run_price_refresh())
