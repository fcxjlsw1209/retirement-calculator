from datetime import date, datetime
from unittest.mock import patch

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import db
from backend.main import app
from backend.price_refresh import fetch_prices, run_price_refresh


def test_refresh_keeps_source_balances_timestamps_and_history():
    synced = datetime(2026, 10, 1)
    with Session(db.engine()) as session:
        session.add(db.Holding(source="empower", ticker="VOO", name="Fund", asset_class="US Equity",
                               value_usd=100, shares=2, account_name="In Multiple Accounts", synced_at=synced))
        session.add(db.Account(source="empower", user_account_id=1, name="Brokerage", firm_name="Test",
                               account_type="Investment", balance=300, synced_at=synced))
        session.add(db.Snapshot(source="empower", account_name="Brokerage", snapshot_date=date(2026, 10, 1),
                                allocation_json="{}", total_value_usd=300))
        session.commit()
    quote = db.MarketQuote(ticker="VOO", price=75, market_date=date(2026, 10, 16))
    with patch("backend.price_refresh.fetch_prices", return_value={"VOO": quote}):
        assert run_price_refresh()["prices_updated"] == 1
    with Session(db.engine()) as session:
        holding = session.exec(select(db.Holding)).one()
        account = session.exec(select(db.Account)).one()
        snapshot = session.exec(select(db.Snapshot)).one()
        assert (holding.value_usd, holding.synced_at) == (100, synced)
        assert (account.balance, account.synced_at) == (300, synced)
        assert snapshot.total_value_usd == 300
        assert session.exec(select(db.SyncLog)).all() == []
    portfolio = TestClient(app).get("/api/portfolio").json()
    assert portfolio["total_value_usd"] == 300
    assert portfolio["holdings"][0]["value_usd"] == 100
    assert portfolio["holdings"][0]["market_value_usd"] == 150
    assert portfolio["holdings"][0]["market_date"] == "2026-10-16"


def test_fetch_uses_latest_valid_unadjusted_close_per_ticker():
    frame = pd.DataFrame({("Close", "VOO"): [100.0, float('nan')],
                          ("Close", "BND"): [70.0, 72.0],
                          ("Close", "BAD"): [3.0, float('inf')]},
                         index=pd.to_datetime(["2026-10-15", "2026-10-16"]))
    with patch("backend.price_refresh.yf.download", return_value=frame) as download:
        quotes = fetch_prices(["VOO", "BND", "BAD", "SPAXX", "VOO"])
    assert download.call_args.kwargs["auto_adjust"] is False
    assert download.call_args.args[0] == ["BAD", "BND", "VOO"]
    assert quotes["VOO"].market_date == date(2026, 10, 15)
    assert quotes["VOO"].price == 100
    assert quotes["BND"].price == 72
    assert "BAD" not in quotes


@pytest.mark.parametrize("price", [0, -1, float('nan'), float('inf')])
def test_invalid_single_ticker_close_is_not_saved(price):
    frame = pd.DataFrame({"Close": [price]}, index=pd.to_datetime(["2026-10-16"]))
    with patch("backend.price_refresh.yf.download", return_value=frame):
        assert fetch_prices(["VOO"]) == {}


def test_older_quote_cannot_replace_newer_quote():
    db.save_market_quotes([db.MarketQuote(ticker="VOO", price=100, market_date=date(2026, 10, 16))])
    db.save_market_quotes([db.MarketQuote(ticker="VOO", price=99, market_date=date(2026, 10, 15))])
    assert db.get_market_quotes()["VOO"].price == 100


def test_account_balance_is_available_without_holdings():
    with Session(db.engine()) as session:
        session.add(db.Account(source="empower", user_account_id=1, name="Cash", firm_name="Test",
                               account_type="Investment", balance=300))
        session.commit()
    portfolio = TestClient(app).get("/api/portfolio").json()
    assert portfolio["total_value_usd"] == 300
    assert portfolio["holdings"] == []
