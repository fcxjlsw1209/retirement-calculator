"""Tests for holding_mapper.py — personalized DCA notice generation."""

from unittest.mock import MagicMock
from backend.holding_mapper import generate_notices


def make_holding(ticker=None, name=None, holding_type="US Fund - Broad", value_usd=10_000):
    h = MagicMock()
    h.ticker = ticker
    h.name = name
    h.holding_type = holding_type
    h.value_usd = value_usd
    return h


class TestGenerateNotices:
    def test_empty_holdings(self):
        assert generate_notices([], 100_000, vix=25, vxn=30) == []

    def test_zero_total_value(self):
        h = make_holding(ticker="VOO", value_usd=10_000)
        assert generate_notices([h], 0, vix=25, vxn=30) == []

    def test_skip_types_produce_no_notice(self):
        total = 100_000
        for htype in ("Bond", "Bond Fund", "Cash", "Alternative", "Gold", "Crypto"):
            h = make_holding(ticker="X", holding_type=htype, value_usd=total)
            assert generate_notices([h], total, vix=25, vxn=30) == [], f"{htype} should be skipped"

    def test_below_min_weight_no_notice(self):
        total = 100_000
        h = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=4_000)
        assert generate_notices([h], total, vix=25, vxn=30) == []

    def test_normal_signal_no_notice(self):
        total = 100_000
        h = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=20_000)
        assert generate_notices([h], total, vix=15, vxn=18) == []

    # ── VXN tech group ────────────────────────────────────────────────────────

    def test_vxn_type_generates_group_notice(self):
        total = 100_000
        h = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=20_000)
        result = generate_notices([h], total, vix=15, vxn=30)
        assert len(result) == 1
        n = result[0]
        assert n.signal == "vxn"
        assert n.signal_value == 30
        assert n.ticker is None       # group notice has no single ticker
        assert n.name == "科技持仓"
        assert "QQQ" in n.message

    def test_tech_group_aggregates_multiple_tickers(self):
        total = 100_000
        # QQQ 3% + VGT 3% = 6% — each below 5% threshold, group above it
        h1 = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=3_000)
        h2 = make_holding(ticker="VGT", holding_type="US Fund - Tech", value_usd=3_000)
        result = generate_notices([h1, h2], total, vix=15, vxn=30)
        assert len(result) == 1
        n = result[0]
        assert abs(n.weight_pct - 6.0) < 0.1
        assert "QQQ" in n.message
        assert "VGT" in n.message

    def test_tech_group_below_threshold_no_notice(self):
        total = 100_000
        h1 = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=2_000)
        h2 = make_holding(ticker="VGT", holding_type="US Fund - Tech", value_usd=2_000)
        assert generate_notices([h1, h2], total, vix=15, vxn=30) == []

    def test_tech_group_deduplicates_across_accounts(self):
        total = 100_000
        h1 = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=10_000)
        h2 = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=10_000)
        result = generate_notices([h1, h2], total, vix=15, vxn=30)
        assert len(result) == 1
        assert abs(result[0].weight_pct - 20.0) < 0.1

    def test_tech_group_message_folds_beyond_top3(self):
        total = 100_000
        tickers = ["QQQ", "VGT", "SCHG", "ARKK", "META"]
        holdings = [
            make_holding(ticker=t, holding_type="US Fund - Tech", value_usd=4_000)
            for t in tickers
        ]
        result = generate_notices(holdings, total, vix=15, vxn=30)
        assert len(result) == 1
        assert "等 2 个持仓" in result[0].message

    # ── Concentration guard ───────────────────────────────────────────────────

    def test_tech_group_concentration_guard_high(self):
        # tech weight = 40% > TECH_GROUP_CAUTION (35%) + VXN opportunity → maintain message
        total = 100_000
        h = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=40_000)
        result = generate_notices([h], total, vix=15, vxn=25)
        assert len(result) == 1
        assert "维持" in result[0].message
        assert "加大" not in result[0].message

    def test_tech_group_concentration_guard_medium(self):
        # tech weight = 30%, between MAINTAIN (25%) and CAUTION (35%), VXN opportunity → maintain
        total = 100_000
        h = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=30_000)
        result = generate_notices([h], total, vix=15, vxn=25)
        assert len(result) == 1
        assert "维持" in result[0].message
        assert "加大" not in result[0].message

    def test_tech_group_below_maintain_threshold_normal_action(self):
        # tech weight = 20% < MAINTAIN (25%), VXN opportunity → 加大定投
        total = 100_000
        h = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=20_000)
        result = generate_notices([h], total, vix=15, vxn=25)
        assert len(result) == 1
        assert "加大" in result[0].message

    # ── Single-stock concentration ────────────────────────────────────────────

    def test_single_stock_concentration_fires_regardless_of_signal(self):
        # GOOG 20%, VXN normal (18) — still triggers concentration notice
        total = 100_000
        h = make_holding(ticker="GOOG", holding_type="US Stock - Tech", value_usd=20_000)
        result = generate_notices([h], total, vix=15, vxn=18)
        concentration_notices = [n for n in result if n.signal_direction == "caution" and n.ticker == "GOOG"]
        assert len(concentration_notices) == 1
        assert "集中度" in concentration_notices[0].message

    def test_single_stock_below_threshold_no_concentration_notice(self):
        # GOOG 10% < SINGLE_STOCK_THRESHOLD (15%) + VXN normal → no notice
        total = 100_000
        h = make_holding(ticker="GOOG", holding_type="US Stock - Tech", value_usd=10_000)
        assert generate_notices([h], total, vix=15, vxn=18) == []

    def test_single_stock_concentration_aggregates_across_accounts(self):
        # GOOG 8% + GOOG 8% = 16% — concentration should use total exposure
        total = 100_000
        h1 = make_holding(ticker="GOOG", holding_type="US Stock - Tech", value_usd=8_000)
        h2 = make_holding(ticker="GOOG", holding_type="US Stock - Tech", value_usd=8_000)
        result = generate_notices([h1, h2], total, vix=15, vxn=18)
        assert len(result) == 1
        assert result[0].ticker == "GOOG"
        assert result[0].weight_pct == 16.0
        assert "16%" in result[0].message

    def test_single_stock_concentration_appears_before_group(self):
        # GOOG (single stock 20%) + QQQ (fund 10%) — concentration notice comes first
        total = 100_000
        h_goog = make_holding(ticker="GOOG", holding_type="US Stock - Tech", value_usd=20_000)
        h_qqq = make_holding(ticker="QQQ",  holding_type="US Fund - Tech",  value_usd=10_000)
        result = generate_notices([h_goog, h_qqq], total, vix=15, vxn=25)
        assert result[0].ticker == "GOOG"   # concentration first
        assert result[0].signal_direction == "caution"

    def test_intl_stock_uses_vix_for_concentration(self):
        total = 100_000
        h = make_holding(ticker="BABA", holding_type="Intl Stock", value_usd=20_000)
        result = generate_notices([h], total, vix=15, vxn=18)
        assert len(result) == 1
        assert result[0].signal == "vix"
        assert result[0].signal_direction == "caution"

    def test_concentrated_single_stock_does_not_emit_duplicate_vix_notice(self):
        total = 100_000
        h = make_holding(ticker="BABA", holding_type="Intl Stock", value_usd=20_000)
        result = generate_notices([h], total, vix=25, vxn=18)
        assert len(result) == 1
        assert result[0].ticker == "BABA"
        assert "集中度" in result[0].message

    # ── VIX individual holdings ───────────────────────────────────────────────

    def test_vix_type_uses_vix_signal(self):
        total = 100_000
        h = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=20_000)
        result = generate_notices([h], total, vix=25, vxn=18)
        assert len(result) == 1
        assert result[0].signal == "vix"
        assert result[0].signal_direction == "opportunity"

    def test_caution_signal_generates_notice(self):
        total = 100_000
        h = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=20_000)
        result = generate_notices([h], total, vix=10, vxn=18)
        assert len(result) == 1
        assert result[0].signal_direction == "caution"

    def test_unknown_type_falls_back_to_vix_unmapped(self):
        total = 100_000
        h = make_holding(ticker="UNKNOWN", holding_type="Unknown", value_usd=20_000)
        result = generate_notices([h], total, vix=25, vxn=18)
        assert len(result) == 1
        assert result[0].signal == "vix"
        assert result[0].unmapped is True

    def test_weight_pct_computed_correctly(self):
        total = 100_000
        h = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=30_000)
        result = generate_notices([h], total, vix=25, vxn=18)
        assert len(result) == 1
        assert abs(result[0].weight_pct - 30.0) < 0.1

    def test_vix_notice_aggregates_same_ticker_across_accounts(self):
        total = 100_000
        h1 = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=3_000)
        h2 = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=3_000)
        result = generate_notices([h1, h2], total, vix=25, vxn=18)
        assert len(result) == 1
        assert result[0].ticker == "VOO"
        assert result[0].weight_pct == 6.0

    def test_none_vxn_skips_tech_group(self):
        total = 100_000
        h = make_holding(ticker="QQQ", holding_type="US Fund - Tech", value_usd=30_000)
        assert generate_notices([h], total, vix=25, vxn=None) == []

    def test_message_contains_ticker_vix(self):
        total = 100_000
        h = make_holding(ticker="VOO", holding_type="US Fund - Broad", value_usd=30_000)
        result = generate_notices([h], total, vix=25, vxn=18)
        assert len(result) == 1
        assert "VOO" in result[0].message
