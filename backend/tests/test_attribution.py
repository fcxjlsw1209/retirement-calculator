"""
Tests for attribution.py — pure math, no external calls.
"""

import pytest
from datetime import date
from unittest.mock import patch, MagicMock

from backend.attribution import (
    compute_attribution,
    _build_prompt,
    _get_benchmark_return,
    VEST_THRESHOLD,
    AttributionResult,
)
from backend.db import Holding


# ── Fixtures ──────────────────────────────────────────────────────────────────

def make_holding(asset_class: str, value: float, source: str = "empower") -> Holding:
    h = Holding(source=source, asset_class=asset_class, value_usd=value)
    return h


def make_snapshot(allocation: dict, total: float, snap_date: date):
    import json
    snap = MagicMock()
    snap.allocation_json = json.dumps(allocation)
    snap.total_value_usd = total
    snap.snapshot_date = snap_date
    return snap


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestComputeAttribution:
    def test_returns_none_when_no_prior_snapshot(self):
        holdings = [make_holding("US Equity", 100_000)]
        with patch("backend.attribution.db.get_latest_snapshot_before", return_value=None):
            with patch("backend.attribution.db.get_benchmark_cache", return_value=None):
                result = compute_attribution(holdings, today=date(2026, 3, 28))
        assert result is None

    def test_normal_period_computes_gains(self):
        holdings = [
            make_holding("US Equity", 110_000),
            make_holding("Bond", 100_000),
        ]
        prior = make_snapshot(
            {"US Equity": 0.5, "Bond": 0.5},
            total=200_000,
            snap_date=date(2026, 2, 28),
        )
        with patch("backend.attribution.db.get_latest_snapshot_before", return_value=prior):
            with patch("backend.attribution._get_benchmark_return", return_value=0.023):
                result = compute_attribution(holdings, today=date(2026, 3, 28))

        assert result is not None
        assert result.period_start == date(2026, 2, 28)

        us_equity = next(d for d in result.asset_class_data if d["asset_class"] == "US Equity")
        bond = next(d for d in result.asset_class_data if d["asset_class"] == "Bond")

        assert us_equity["gain"] == pytest.approx(10_000)
        assert us_equity["possible_vest"] is False  # 10% gain, under 20% threshold
        assert bond["gain"] == pytest.approx(0)
        assert bond["possible_vest"] is False

    def test_large_jump_flags_possible_vest(self):
        """A >20% gain in a single asset class is flagged as possible RSU vest."""
        holdings = [make_holding("US Equity", 150_000)]  # +50% gain
        prior = make_snapshot(
            {"US Equity": 1.0},
            total=100_000,
            snap_date=date(2026, 2, 28),
        )
        with patch("backend.attribution.db.get_latest_snapshot_before", return_value=prior):
            with patch("backend.attribution._get_benchmark_return", return_value=0.02):
                result = compute_attribution(holdings, today=date(2026, 3, 28))

        assert result is not None
        us_equity = next(d for d in result.asset_class_data if d["asset_class"] == "US Equity")
        assert us_equity["possible_vest"] is True

    def test_vest_threshold_boundary(self):
        """Exactly at threshold (20%) is NOT flagged; just above IS flagged."""
        prior = make_snapshot({"US Equity": 1.0}, total=100_000, snap_date=date(2026, 2, 28))

        # Exactly 20% gain — NOT flagged
        holdings_20 = [make_holding("US Equity", 120_000)]
        with patch("backend.attribution.db.get_latest_snapshot_before", return_value=prior):
            with patch("backend.attribution._get_benchmark_return", return_value=0.0):
                result = compute_attribution(holdings_20, today=date(2026, 3, 28))
        us = next(d for d in result.asset_class_data if d["asset_class"] == "US Equity")
        assert us["possible_vest"] is False  # 20% == threshold, not strictly greater

        # 20.1% gain — IS flagged
        holdings_201 = [make_holding("US Equity", 120_100)]
        with patch("backend.attribution.db.get_latest_snapshot_before", return_value=prior):
            with patch("backend.attribution._get_benchmark_return", return_value=0.0):
                result = compute_attribution(holdings_201, today=date(2026, 3, 28))
        us = next(d for d in result.asset_class_data if d["asset_class"] == "US Equity")
        assert us["possible_vest"] is True

    def test_portfolio_return_excludes_vest_classes(self):
        """Portfolio return should exclude flagged (possible vest) asset classes."""
        holdings = [
            make_holding("US Equity", 200_000),  # +100% — flagged as vest
            make_holding("Bond", 105_000),        # +5% — not flagged
        ]
        prior = make_snapshot(
            {"US Equity": 0.5, "Bond": 0.5},
            total=200_000,
            snap_date=date(2026, 2, 28),
        )
        with patch("backend.attribution.db.get_latest_snapshot_before", return_value=prior):
            with patch("backend.attribution._get_benchmark_return", return_value=0.02):
                result = compute_attribution(holdings, today=date(2026, 3, 28))

        # Bond: value_t0 = 100_000, gain = 5_000 → return = 5%
        # US Equity is excluded (possible vest)
        assert result.portfolio_return == pytest.approx(0.05)

    def test_benchmark_none_when_fetch_fails(self):
        holdings = [make_holding("US Equity", 100_000)]
        prior = make_snapshot({"US Equity": 1.0}, total=100_000, snap_date=date(2026, 2, 28))
        with patch("backend.attribution.db.get_latest_snapshot_before", return_value=prior):
            with patch("backend.attribution._get_benchmark_return", return_value=None):
                result = compute_attribution(holdings, today=date(2026, 3, 28))
        assert result.benchmark_return is None


class TestBuildPrompt:
    def test_prompt_contains_period_dates(self):
        result = AttributionResult(
            period_start=date(2026, 2, 28),
            period_end=date(2026, 3, 28),
            asset_class_data=[
                {"asset_class": "US Equity", "value_t0": 100_000, "value_t1": 110_000,
                 "gain": 10_000, "possible_vest": False},
            ],
            portfolio_return=0.10,
            benchmark_return=0.023,
        )
        prompt = _build_prompt(result)
        assert "2026-02-28" in prompt
        assert "2026-03-28" in prompt

    def test_prompt_marks_vest_with_warning(self):
        result = AttributionResult(
            period_start=date(2026, 2, 28),
            period_end=date(2026, 3, 28),
            asset_class_data=[
                {"asset_class": "US Equity", "value_t0": 100_000, "value_t1": 150_000,
                 "gain": 50_000, "possible_vest": True},
            ],
            portfolio_return=None,
            benchmark_return=0.02,
        )
        prompt = _build_prompt(result)
        assert "RSU" in prompt
        assert "⚠️" in prompt

    def test_prompt_handles_none_benchmark(self):
        result = AttributionResult(
            period_start=date(2026, 2, 28),
            period_end=date(2026, 3, 28),
            asset_class_data=[],
            portfolio_return=0.05,
            benchmark_return=None,
        )
        prompt = _build_prompt(result)
        assert "无法获取" in prompt
