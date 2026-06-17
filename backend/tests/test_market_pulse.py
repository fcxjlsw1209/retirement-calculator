"""Tests for market_pulse.py — confluence engine."""

import pytest
from backend.market_pulse import classify_signal, compute_confluence


class TestClassifySignal:
    def test_vix_opportunity(self):
        assert classify_signal("vix", 25) == "opportunity"
        assert classify_signal("vix", 35) == "opportunity"  # boundary: 35 inclusive
        assert classify_signal("vix", 50) == "opportunity"

    def test_vix_normal(self):
        assert classify_signal("vix", 12) == "normal"
        assert classify_signal("vix", 15) == "normal"
        assert classify_signal("vix", 19.9) == "normal"

    def test_vix_caution(self):
        assert classify_signal("vix", 11) == "caution"
        assert classify_signal("vix", 5) == "caution"

    def test_vxn_opportunity(self):
        assert classify_signal("vxn", 30) == "opportunity"
        assert classify_signal("vxn", 60) == "opportunity"

    def test_vxn_normal(self):
        assert classify_signal("vxn", 15) == "normal"
        assert classify_signal("vxn", 20) == "normal"

    def test_vxn_caution(self):
        assert classify_signal("vxn", 10) == "caution"

    def test_fg_opportunity(self):
        assert classify_signal("fg", 30) == "opportunity"
        assert classify_signal("fg", 44) == "opportunity"

    def test_fg_normal(self):
        assert classify_signal("fg", 45) == "normal"
        assert classify_signal("fg", 55) == "normal"

    def test_fg_caution(self):
        assert classify_signal("fg", 56) == "caution"
        assert classify_signal("fg", 80) == "caution"

    def test_rsi_opportunity(self):
        assert classify_signal("rsi_sp500", 40) == "opportunity"
        assert classify_signal("rsi_sp500", 30) == "opportunity"

    def test_rsi_normal(self):
        assert classify_signal("rsi_sp500", 50) == "normal"
        assert classify_signal("rsi_sp500", 65) == "normal"

    def test_rsi_caution(self):
        assert classify_signal("rsi_sp500", 70) == "caution"
        assert classify_signal("rsi_sp500", 85) == "caution"


class TestComputeConfluence:
    def test_panic_override_vix(self):
        result = compute_confluence(vix=40, vxn=20, fg=50, rsi_sp500=55)
        assert result.override is True
        assert result.recommendation == "加大定投"
        assert result.action == "提高定投系数"
        assert result.regimes["volatility"] == "panic"
        assert result.reasons[0] == "VIX/VXN 触发极端恐慌阈值"
        assert result.signal_labels["vix"] == "opportunity"
        assert result.signal_count == 4

    def test_panic_override_vxn(self):
        result = compute_confluence(vix=20, vxn=50, fg=50, rsi_sp500=55)
        assert result.override is True
        assert result.signal_labels["vxn"] == "opportunity"

    def test_panic_override_boundary_vix_35(self):
        # 35 is not > 35, so no override
        result = compute_confluence(vix=35, vxn=20, fg=50, rsi_sp500=55)
        assert result.override is False

    def test_panic_override_boundary_vxn_45(self):
        result = compute_confluence(vix=20, vxn=45, fg=50, rsi_sp500=55)
        assert result.override is False

    def test_majority_caution(self):
        # VIX=15 (normal), VXN=10 (caution), F&G=80 (caution), RSI=75 (caution)
        result = compute_confluence(vix=15, vxn=10, fg=80, rsi_sp500=75)
        assert result.override is False
        assert result.recommendation == "谨慎追高"
        assert result.caution_count == 3

    def test_majority_opportunity(self):
        # VIX=25 (opp), VXN=30 (opp), F&G=30 (opp), RSI=45 (opp)
        result = compute_confluence(vix=25, vxn=30, fg=30, rsi_sp500=45)
        assert result.recommendation == "加大定投"
        assert result.regimes == {
            "volatility": "opportunity",
            "sentiment": "opportunity",
            "momentum": "opportunity",
        }
        assert result.opportunity_count == 4

    def test_volatility_opportunity_offsets_sentiment_caution(self):
        result = compute_confluence(vix=25, vxn=30, fg=80, rsi_sp500=60)
        assert result.recommendation == "常规定投"
        assert result.action == "维持定投系数"
        assert result.regimes["volatility"] == "opportunity"
        assert result.regimes["sentiment"] == "caution"
        assert "信号互相抵消" in result.summary
        more_dca = result.counterfactuals[0]
        chase_caution = result.counterfactuals[1]
        assert more_dca["target"] == "加大定投"
        assert "F&G 偏谨慎，抵消波动机会" in more_dca["missing"]
        assert chase_caution["target"] == "谨慎追高"
        assert chase_caution["missing"] == ["波动偏机会，不属于低波动追高环境"]

    def test_vix_vxn_are_combined_not_double_counted(self):
        result = compute_confluence(vix=25, vxn=30, fg=80, rsi_sp500=75)
        assert result.opportunity_count == 2  # raw signal labels are still exposed
        assert result.regimes["volatility"] == "opportunity"
        assert result.regimes["sentiment"] == "caution"
        assert result.regimes["momentum"] == "caution"
        assert result.recommendation == "常规定投"

    def test_mixed_normal(self):
        # VIX=15 (normal), VXN=18 (normal), F&G=50 (normal), RSI=60 (normal)
        result = compute_confluence(vix=15, vxn=18, fg=50, rsi_sp500=60)
        assert result.recommendation == "常规定投"
        assert result.action == "维持定投系数"
        assert result.regimes["volatility"] == "normal"
        assert result.normal_count == 4
        assert result.signal_count == 4
        assert result.counterfactuals == [
            {
                "target": "加大定投",
                "missing": ["VIX/VXN 未触发极端恐慌阈值", "波动未进入机会区间"],
            },
            {
                "target": "谨慎追高",
                "missing": ["F&G 未偏谨慎", "RSI 未偏谨慎"],
            },
        ]

    def test_none_signals_excluded(self):
        result = compute_confluence(vix=15, vxn=None, fg=None, rsi_sp500=60)
        assert result.signal_count == 2
        assert "vxn" not in result.signal_labels
        assert "fg" not in result.signal_labels

    def test_all_none_signals(self):
        result = compute_confluence(vix=None, vxn=None, fg=None, rsi_sp500=None)
        assert result.override is False
        assert result.signal_count == 0
        assert result.recommendation == "常规定投"

    def test_fg_missing_note_in_summary(self):
        result = compute_confluence(vix=15, vxn=18, fg=None, rsi_sp500=60)
        assert "F&G" in result.summary or "f&g" in result.summary.lower() or "3" in result.summary

    def test_summary_contains_recommendation(self):
        result = compute_confluence(vix=15, vxn=18, fg=50, rsi_sp500=60)
        assert result.recommendation in result.summary

    def test_non_normal_recommendations_have_no_counterfactuals(self):
        result = compute_confluence(vix=25, vxn=30, fg=30, rsi_sp500=45)
        assert result.recommendation == "加大定投"
        assert result.counterfactuals == []

    def test_signal_labels_correct(self):
        result = compute_confluence(vix=25, vxn=18, fg=80, rsi_sp500=60)
        assert result.signal_labels["vix"] == "opportunity"
        assert result.signal_labels["fg"] == "caution"
