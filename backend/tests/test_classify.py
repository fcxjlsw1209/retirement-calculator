"""
Tests for _classify_holding_type() — all 8 branches.
"""

import pytest
from backend.main import _classify_holding_type


class TestClassifyHoldingType:

    # ── Branch 1: asset_class == "Cash" ───────────────────────────────────────

    def test_cash_asset_class_returns_cash(self):
        assert _classify_holding_type("WXYZ", "Cash") == "Cash"

    def test_cash_asset_class_overrides_any_ticker(self):
        # Even if ticker could map to something, Cash asset_class wins
        assert _classify_holding_type("VOO", "Cash") == "Cash"

    def test_cash_no_ticker(self):
        assert _classify_holding_type(None, "Cash") == "Cash"

    # ── Branch 2: CUSIP-like ticker → "Bond" ─────────────────────────────────

    def test_cusip_like_mostly_digits_returns_bond(self):
        # 9 chars, majority digits — looks like a CUSIP
        assert _classify_holding_type("912828ZT0", "US Equity") == "Bond"

    def test_cusip_like_8_chars_returns_bond(self):
        assert _classify_holding_type("38141GXZ2", "Bond") == "Bond"

    def test_short_ticker_not_cusip(self):
        # 4 chars — not CUSIP-like
        assert _classify_holding_type("AAPL", "US Equity") != "Bond"

    # ── Branch 3: ticker in _TICKER_MAP ──────────────────────────────────────

    def test_known_tech_stock(self):
        assert _classify_holding_type("AAPL", "US Equity") == "US Stock - Tech"

    def test_known_other_stock(self):
        assert _classify_holding_type("XOM", "US Equity") == "US Stock - Other"

    def test_known_broad_fund(self):
        assert _classify_holding_type("VOO", "US Equity") == "US Fund - Broad"

    def test_known_tech_fund(self):
        assert _classify_holding_type("QQQ", "US Equity") == "US Fund - Tech"

    def test_known_small_cap_fund(self):
        assert _classify_holding_type("IWM", "US Equity") == "US Fund - Small Cap"

    def test_known_thematic_fund(self):
        assert _classify_holding_type("VNQ", "US Equity") == "US Fund - Thematic"

    def test_known_intl_stock(self):
        assert _classify_holding_type("TSM", "International") == "Intl Stock"

    def test_known_intl_fund(self):
        assert _classify_holding_type("IEFA", "International") == "Intl Fund"

    def test_known_bond_fund(self):
        assert _classify_holding_type("AGG", "Bond") == "Bond Fund"

    def test_known_crypto(self):
        assert _classify_holding_type("BTC", "US Equity") == "Crypto"

    def test_known_gold(self):
        assert _classify_holding_type("GLD", "Alternative") == "Gold"

    def test_known_alternative(self):
        assert _classify_holding_type("GSG", "Alternative") == "Alternative"

    def test_known_cash_equivalent(self):
        # Name-based cash detection (money market / stable value funds)
        assert _classify_holding_type(None, "US Equity", "Stable Value Fund") == "Cash"

    def test_ticker_lookup_case_insensitive(self):
        # Raw ticker from DB may have mixed case or plan suffix
        assert _classify_holding_type("aapl.eso", "US Equity") == "US Stock - Tech"
        assert _classify_holding_type("aapl", "US Equity") == "US Stock - Tech"

    # ── Branch 4-7: no ticker, name-based fallback ────────────────────────────

    def test_no_ticker_target_date_name(self):
        assert _classify_holding_type(None, "US Equity", "Target Date 2055 Fund") == "US Fund - Target Date"

    def test_no_ticker_target_retire_name(self):
        assert _classify_holding_type(None, "US Equity", "Vanguard Target Retire 2060") == "US Fund - Target Date"

    def test_no_ticker_year_in_name(self):
        assert _classify_holding_type(None, "US Equity", "Freedom Index 2050 Fund") == "US Fund - Target Date"

    def test_no_ticker_bond_name(self):
        assert _classify_holding_type(None, "US Equity", "Total Bond Market Fund") == "Bond Fund"

    def test_no_ticker_bd_mkt_abbreviation(self):
        # "Inst Tot Bd Mkt Ix Tr" — abbreviation for bond market
        assert _classify_holding_type(None, "US Equity", "Inst Tot Bd Mkt Ix Tr") == "Bond Fund"

    def test_no_ticker_tot_bd_abbreviation(self):
        assert _classify_holding_type(None, "US Equity", "Inst Tot Bd Index") == "Bond Fund"

    def test_no_ticker_fixed_income_name(self):
        assert _classify_holding_type(None, "US Equity", "Fixed Income Core Fund") == "Bond Fund"

    def test_no_ticker_international_name(self):
        assert _classify_holding_type(None, "US Equity", "International Growth Fund") == "Intl Fund"

    def test_no_ticker_emerging_name(self):
        assert _classify_holding_type(None, "US Equity", "Emerging Markets Index") == "Intl Fund"

    def test_no_ticker_bond_asset_class_fallback(self):
        # No name keywords, but asset_class is Bond
        assert _classify_holding_type(None, "Bond", "Some Fund") == "Bond Fund"

    def test_no_ticker_unknown_name_falls_back_to_broad(self):
        # No keywords, no bond asset_class → US Fund - Broad
        assert _classify_holding_type(None, "US Equity", "Mystery Fund") == "US Fund - Broad"

    def test_no_ticker_no_name_falls_back_to_broad(self):
        assert _classify_holding_type(None, "US Equity") == "US Fund - Broad"

    # ── Branch 8: ticker present, asset_class == "Bond" → "Bond" ─────────────

    def test_ticker_with_bond_asset_class(self):
        # Individual bond with a ticker/CUSIP-like string — asset_class path
        assert _classify_holding_type("SOMEBOND", "Bond") == "Bond"

    # ── Branch 9: unmapped ticker → "Unknown" ─────────────────────────────────

    def test_unmapped_ticker_returns_unknown(self):
        assert _classify_holding_type("XYZNOTREAL", "US Equity") == "Unknown"

    def test_unmapped_ticker_not_bond_class(self):
        assert _classify_holding_type("NEWETF123", "Alternative") == "Unknown"
