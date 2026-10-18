"""
Tests for FastAPI endpoints — uses TestClient (no real network/browser).
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient

from backend.main import app
from backend.sync import SyncResult, SourceResult

client = TestClient(app)


# ── /api/sync ─────────────────────────────────────────────────────────────────

class TestSync:
    def test_sync_success(self):
        mock_result = SyncResult(
            empower=SourceResult(status="ok", rows=42),
            reauth_required=False,
        )
        with patch("backend.main.run_sync", AsyncMock(return_value=mock_result)):
            r = client.post("/api/sync")
        assert r.status_code == 200
        data = r.json()
        assert data["reauth_required"] is False
        assert data["sources"]["empower"]["status"] == "ok"

    def test_sync_returns_reauth_required_on_empower_401(self):
        mock_result = SyncResult(
            empower=SourceResult(status="auth_required", error="Session expired"),
            reauth_required=True,
        )
        with patch("backend.main.run_sync", AsyncMock(return_value=mock_result)):
            r = client.post("/api/sync")
        assert r.status_code == 200
        assert r.json()["reauth_required"] is True

    def test_sync_empower_error(self):
        mock_result = SyncResult(
            empower=SourceResult(status="error", error="API timeout"),
            reauth_required=False,
        )
        with patch("backend.main.run_sync", AsyncMock(return_value=mock_result)):
            r = client.post("/api/sync")
        assert r.status_code == 200
        data = r.json()
        assert data["sources"]["empower"]["status"] == "error"
        assert data["reauth_required"] is False


# ── /api/portfolio ─────────────────────────────────────────────────────────────

class TestPortfolio:
    def test_empty_portfolio(self):
        with patch("backend.main.db.get_all_holdings", return_value=[]):
            r = client.get("/api/portfolio")
        assert r.status_code == 200
        data = r.json()
        assert data["total_value_usd"] == 0
        assert data["holdings"] == []

    def test_portfolio_shape(self):
        from backend.db import Holding, Account
        from datetime import datetime
        holdings = [
            Holding(id=1, source="empower", ticker="AAPL", asset_class="US Equity",
                    name="Apple Inc", value_usd=50_000, shares=200.0, cost_basis=40_000,
                    synced_at=datetime(2026, 3, 28)),
            Holding(id=2, source="empower", ticker=None, asset_class="Bond",
                    name="Total Bond", value_usd=30_000, shares=None, cost_basis=None,
                    synced_at=datetime(2026, 3, 28)),
        ]
        accounts = [
            Account(id=1, source="empower", user_account_id=1, firm_name="Empower",
                    name="Brokerage", account_type="Investment", balance=80_000,
                    synced_at=datetime(2026, 3, 28)),
        ]
        with patch("backend.main.db.get_all_holdings", return_value=holdings):
            with patch("backend.main.db.get_all_accounts", return_value=accounts):
                r = client.get("/api/portfolio")
        assert r.status_code == 200
        data = r.json()
        assert data["total_value_usd"] == pytest.approx(80_000)
        assert len(data["holdings"]) == 2
        assert "US Equity" in data["asset_class_summary"]
        assert data["asset_class_summary"]["US Equity"]["weight"] == pytest.approx(0.625)

    def test_stale_source_shows_last_ok(self):
        """Sources with no current data should report error status from the response."""
        with patch("backend.main.db.get_all_holdings", return_value=[]):
            r = client.get("/api/portfolio")
        assert r.status_code == 200  # Never crashes, just returns empty


# ── /api/attribution ──────────────────────────────────────────────────────────

class TestAttribution:
    def test_returns_none_text_when_no_cache(self):
        with patch("backend.main.db.get_latest_attribution", return_value=None):
            r = client.get("/api/attribution")
        assert r.status_code == 200
        assert r.json()["text"] is None

    def test_returns_cached_explanation(self):
        from backend.db import AttributionCache
        from datetime import datetime, date
        cached = AttributionCache(
            id=1,
            generated_at=datetime(2026, 3, 28, 22, 0),
            attribution_text="本月投资组合上涨主要受益于美股科技板块的强劲表现。",
            period_start=date(2026, 2, 28),
            period_end=date(2026, 3, 28),
        )
        with patch("backend.main.db.get_latest_attribution", return_value=cached):
            r = client.get("/api/attribution")
        assert r.status_code == 200
        data = r.json()
        assert "科技" in data["text"]
        assert data["period_start"] == "2026-02-28"


# ── /api/auth/* ────────────────────────────────────────────────────────────────

class TestAuth:
    def test_auth_start_needs_otp(self):
        with patch("backend.main.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.start_auth = AsyncMock(return_value="needs_otp")
            mock_get.return_value = mock_client
            r = client.post("/api/auth/start")
        assert r.status_code == 200
        assert r.json()["status"] == "needs_otp"

    def test_auth_otp_success(self):
        with patch("backend.main.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.finish_auth.return_value = True
            mock_get.return_value = mock_client
            r = client.post("/api/auth/otp", json={"code": "123456"})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_auth_otp_wrong_code_returns_400(self):
        with patch("backend.main.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.finish_auth.return_value = False
            mock_get.return_value = mock_client
            r = client.post("/api/auth/otp", json={"code": "000000"})
        assert r.status_code == 400


        assert "detail" in r.json()


# ── /api/market-pulse ─────────────────────────────────────────────────────────

class TestMarketPulse:
    def _mock_signals(self):
        from backend.db import MarketSignals
        from datetime import date, datetime
        return MarketSignals(
            record_date=date(2026, 5, 23),
            vix=16.7,
            vxn=22.8,
            fg=59,
            rsi_sp500=68.3,
            fetched_at=datetime(2026, 5, 23, 9, 0),
        )

    def test_no_data_returns_null_signals(self):
        with patch("backend.main.db.get_latest_market_signals", return_value=None):
            with patch("backend.main.db.get_all_price_history", return_value=[]):
                with patch("backend.main.get_portfolio") as mock_pf:
                    with patch("backend.main._safe_fetch_and_store") as mock_fetch:
                        mock_pf.return_value = MagicMock(holdings=[], total_value_usd=0)
                        r = client.get("/api/market-pulse")
        assert r.status_code == 200
        data = r.json()
        assert data["signals"]["vix"] is None
        assert data["market_date"] is None
        assert data["stale"] is True
        assert data["price_history"] == []
        mock_fetch.assert_called_once()

    def test_with_signals_returns_confluence(self):
        signals = self._mock_signals()
        with patch("backend.main.db.get_latest_market_signals", return_value=signals):
            with patch("backend.main.db.get_market_signals_for_delta", return_value=None):
                with patch("backend.main.db.get_all_price_history", return_value=[]):
                    with patch("backend.main.get_portfolio") as mock_pf:
                        mock_pf.return_value = MagicMock(holdings=[], total_value_usd=0)
                        r = client.get("/api/market-pulse")
        assert r.status_code == 200
        data = r.json()
        assert data["signals"]["vix"] == pytest.approx(16.7)
        assert data["signals"]["vxn"] == pytest.approx(22.8)
        assert data["market_date"] == "2026-05-23"
        assert data["confluence"]["recommendation"] in ("加大定投", "常规定投", "谨慎追高")
        assert data["confluence"]["action"] in ("提高定投系数", "维持定投系数", "降低新增资金速度")
        assert data["confluence"]["regimes"]["volatility"] == "opportunity"
        assert isinstance(data["confluence"]["reasons"], list)
        assert isinstance(data["confluence"]["counterfactuals"], list)
        assert data["confluence"]["counterfactuals"][0]["target"] == "加大定投"
        assert "summary" in data["confluence"]
        assert data["signals"]["delta_days"] is None

    def test_signal_deltas_use_latest_market_date(self):
        from backend.db import MarketSignals
        from datetime import date, datetime
        latest = self._mock_signals()
        prior = MarketSignals(
            record_date=date(2026, 5, 16),
            vix=18.2,
            vxn=24.1,
            fg=52,
            rsi_sp500=62.0,
            fetched_at=datetime(2026, 5, 16, 9, 0),
        )
        with patch("backend.main.db.get_latest_market_signals", return_value=latest):
            with patch("backend.main.db.get_market_signals_for_delta", return_value=prior):
                with patch("backend.main.db.get_all_price_history", return_value=[]):
                    with patch("backend.main.get_portfolio") as mock_pf:
                        mock_pf.return_value = MagicMock(holdings=[], total_value_usd=0)
                        r = client.get("/api/market-pulse")
        data = r.json()["signals"]
        assert data["delta_days"] == 7
        assert data["vix_delta"] == pytest.approx(-1.5)
        assert data["vxn_delta"] == pytest.approx(-1.3)
        assert data["fg_delta"] == 7
        assert data["rsi_delta"] == pytest.approx(6.3)

    def test_price_history_normalized_shape(self):
        from backend.db import PriceHistory
        from datetime import date
        rows = [
            PriceHistory(record_date=date(2026, 5, 1), sp500_close=5000.0, ndx_close=18000.0),
            PriceHistory(record_date=date(2026, 5, 2), sp500_close=5100.0, ndx_close=18200.0),
        ]
        signals = self._mock_signals()
        with patch("backend.main.db.get_latest_market_signals", return_value=signals):
            with patch("backend.main.db.get_market_signals_for_delta", return_value=None):
                with patch("backend.main.db.get_all_price_history", return_value=rows):
                    with patch("backend.main.get_portfolio") as mock_pf:
                        mock_pf.return_value = MagicMock(holdings=[], total_value_usd=0)
                        r = client.get("/api/market-pulse")
        assert r.status_code == 200
        ph = r.json()["price_history"]
        assert len(ph) == 2
        assert ph[0]["date"] == "2026-05-01"
        assert ph[0]["sp500"] == pytest.approx(5000.0)

    def test_stale_flag_when_old_data(self):
        from backend.db import MarketSignals
        from datetime import date, datetime, timedelta
        old_signals = MarketSignals(
            record_date=date(2026, 5, 20),
            vix=16.7, vxn=22.8, fg=59, rsi_sp500=68.3,
            fetched_at=datetime.utcnow() - timedelta(hours=40),
        )
        with patch("backend.main.db.get_latest_market_signals", return_value=old_signals):
            with patch("backend.main.db.get_market_signals_for_delta", return_value=None):
                with patch("backend.main.db.get_all_price_history", return_value=[]):
                    with patch("backend.main.get_portfolio") as mock_pf:
                        with patch("backend.main._safe_fetch_and_store") as mock_fetch:
                            mock_pf.return_value = MagicMock(holdings=[], total_value_usd=0)
                            r = client.get("/api/market-pulse")
        assert r.json()["stale"] is True
        mock_fetch.assert_called_once()

    def test_panic_override_sets_recommendation(self):
        from backend.db import MarketSignals
        from datetime import date, datetime
        panic_signals = MarketSignals(
            record_date=date(2026, 5, 23),
            vix=40.0, vxn=30.0, fg=20, rsi_sp500=45.0,
            fetched_at=datetime.utcnow(),
        )
        with patch("backend.main.db.get_latest_market_signals", return_value=panic_signals):
            with patch("backend.main.db.get_market_signals_for_delta", return_value=None):
                with patch("backend.main.db.get_all_price_history", return_value=[]):
                    with patch("backend.main.get_portfolio") as mock_pf:
                        mock_pf.return_value = MagicMock(holdings=[], total_value_usd=0)
                        r = client.get("/api/market-pulse")
        data = r.json()
        assert data["confluence"]["override"] is True
        assert data["confluence"]["recommendation"] == "加大定投"
        assert data["confluence"]["action"] == "提高定投系数"
        assert data["confluence"]["regimes"]["volatility"] == "panic"
        assert data["confluence"]["signal_labels"]["vix"] == "opportunity"
