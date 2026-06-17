"""
Tests for checks.py (sync sanity checks) and db.get_sync_warnings().
"""

import json
import pytest
from datetime import date, datetime, timedelta
from unittest.mock import patch, MagicMock

from backend.checks import check_holdings_count_drop, run_checks


# ── check_holdings_count_drop ──────────────────────────────────────────────────

class TestHoldingsCountDrop:

    def _mock_session(self, prev_snapshot):
        """Build a context-manager-compatible mock Session that returns prev_snapshot."""
        mock_session = MagicMock()
        mock_session.exec.return_value.first.return_value = prev_snapshot
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=mock_session)
        ctx.__exit__ = MagicMock(return_value=False)
        return ctx

    def test_no_prior_snapshot_returns_empty(self):
        """No history to compare against — no warning."""
        with patch("backend.checks.Session", return_value=self._mock_session(None)):
            result = check_holdings_count_drop("empower", 10)
        assert result == []

    def test_prior_snapshot_no_holdings_count_returns_empty(self):
        """Prior snapshot exists but holdings_count is None — no warning."""
        prev = MagicMock()
        prev.holdings_count = None
        with patch("backend.checks.Session", return_value=self._mock_session(prev)):
            result = check_holdings_count_drop("empower", 10)
        assert result == []

    def test_prior_snapshot_zero_count_returns_empty(self):
        """Prior snapshot has 0 holdings — avoid divide-by-zero, no warning."""
        prev = MagicMock()
        prev.holdings_count = 0
        with patch("backend.checks.Session", return_value=self._mock_session(prev)):
            result = check_holdings_count_drop("empower", 5)
        assert result == []

    def test_drop_over_50_pct_returns_warning(self):
        """Holdings dropped from 20 to 5 (75% drop) — should warn."""
        prev = MagicMock()
        prev.holdings_count = 20
        with patch("backend.checks.Session", return_value=self._mock_session(prev)):
            result = check_holdings_count_drop("empower", 5)
        assert len(result) == 1
        assert "empower" in result[0]
        assert "5" in result[0]
        assert "20" in result[0]

    def test_drop_exactly_50_pct_no_warning(self):
        """Exactly 50% drop — threshold is >50%, so no warning."""
        prev = MagicMock()
        prev.holdings_count = 10
        with patch("backend.checks.Session", return_value=self._mock_session(prev)):
            result = check_holdings_count_drop("empower", 5)
        assert result == []

    def test_drop_51_pct_returns_warning(self):
        """51% drop triggers warning."""
        prev = MagicMock()
        prev.holdings_count = 100
        with patch("backend.checks.Session", return_value=self._mock_session(prev)):
            result = check_holdings_count_drop("empower", 49)
        assert len(result) == 1

    def test_increase_returns_empty(self):
        """Holdings increased — never a warning."""
        prev = MagicMock()
        prev.holdings_count = 10
        with patch("backend.checks.Session", return_value=self._mock_session(prev)):
            result = check_holdings_count_drop("empower", 20)
        assert result == []

    def test_same_count_returns_empty(self):
        """Same count as before — no warning."""
        prev = MagicMock()
        prev.holdings_count = 15
        with patch("backend.checks.Session", return_value=self._mock_session(prev)):
            result = check_holdings_count_drop("empower", 15)
        assert result == []


# ── run_checks ─────────────────────────────────────────────────────────────────

class TestRunChecks:

    def test_run_checks_aggregates_warnings(self):
        """run_checks delegates to check_holdings_count_drop and returns results."""
        with patch("backend.checks.check_holdings_count_drop", return_value=["test warning"]) as mock_check:
            result = run_checks("empower", 5)
        mock_check.assert_called_once_with("empower", 5)
        assert result == ["test warning"]

    def test_run_checks_no_issues(self):
        with patch("backend.checks.check_holdings_count_drop", return_value=[]):
            result = run_checks("empower", 23)
        assert result == []


# ── GET /api/sync-logs ─────────────────────────────────────────────────────────

class TestSyncLogsEndpoint:

    def test_sync_logs_empty(self):
        """Returns empty list when no SyncLog entries exist."""
        from backend.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        with patch("backend.main.db.get_sync_logs", return_value=[]):
            r = client.get("/api/sync-logs")
        assert r.status_code == 200
        assert r.json() == []

    def test_sync_logs_shape(self):
        """Returns correct shape with warnings parsed from JSON."""
        from backend.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)

        fake_log = MagicMock()
        fake_log.id = 1
        fake_log.synced_at = datetime(2026, 4, 2, 10, 0, 0)
        fake_log.source = "empower"
        fake_log.holdings_count = 42
        fake_log.total_value_usd = 500_000.0
        fake_log.status = "ok"
        fake_log.warnings_json = "[]"

        with patch("backend.main.db.get_sync_logs", return_value=[fake_log]):
            r = client.get("/api/sync-logs")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 1
        assert data[0]["source"] == "empower"
        assert data[0]["holdings_count"] == 42
        assert data[0]["status"] == "ok"
        assert data[0]["warnings"] == []

    def test_sync_logs_with_warnings(self):
        """warnings_json is parsed into a list."""
        from backend.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)

        fake_log = MagicMock()
        fake_log.id = 2
        fake_log.synced_at = datetime(2026, 4, 1, 8, 0, 0)
        fake_log.source = "empower"
        fake_log.holdings_count = 3
        fake_log.total_value_usd = 10_000.0
        fake_log.status = "warning"
        fake_log.warnings_json = json.dumps(["empower 本次同步只有 3 条持仓（上次 23 条），请检查"])

        with patch("backend.main.db.get_sync_logs", return_value=[fake_log]):
            r = client.get("/api/sync-logs")
        data = r.json()
        assert data[0]["status"] == "warning"
        assert len(data[0]["warnings"]) == 1
        assert "empower" in data[0]["warnings"][0]


# ── PortfolioResponse.warnings ─────────────────────────────────────────────────

class TestPortfolioWarnings:

    def test_portfolio_includes_warnings_field(self):
        """warnings field is present in portfolio response (defaults to [])."""
        from backend.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)

        with patch("backend.main.db.get_all_holdings", return_value=[]):
            with patch("backend.main.db.get_sync_warnings", return_value=[]):
                r = client.get("/api/portfolio")
        assert r.status_code == 200
        assert "warnings" in r.json()
        assert r.json()["warnings"] == []

    def test_portfolio_propagates_warnings(self):
        """get_sync_warnings() result surfaces in portfolio response even with no holdings."""
        from backend.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)

        warning_msg = "数据不完整：empower（2026-03-31）落后于最新同步日期 2026-04-02"
        # Empty holdings triggers the early-return path — warnings must still appear
        with patch("backend.main.db.get_all_holdings", return_value=[]):
            with patch("backend.main.db.get_sync_warnings", return_value=[warning_msg]):
                r = client.get("/api/portfolio")
        data = r.json()
        assert data["warnings"] == [warning_msg]
