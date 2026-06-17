from __future__ import annotations

"""
Confluence engine for the Market Pulse page.

Takes today's VIX/VXN/F&G/RSI readings and produces:
  - An extreme-outlier override when panic conditions are unambiguous
  - A descriptive signal count when no override fires
  - A plain-language DCA recommendation (never a sell signal)
"""

from dataclasses import dataclass, field
from typing import Optional


# ── Signal classification ──────────────────────────────────────────────────────

# Zone boundaries from design doc
_ZONES = {
    "vix": [
        (35, float("inf"), "opportunity"),  # extreme outlier threshold (also triggers override)
        (20, 35,           "opportunity"),
        (12, 20,           "normal"),
        (float("-inf"), 12, "caution"),
    ],
    "vxn": [
        (45, float("inf"), "opportunity"),  # extreme outlier threshold
        (22, 45,           "opportunity"),
        (15, 22,           "normal"),
        (float("-inf"), 15, "caution"),
    ],
    "fg": [
        (56, float("inf"), "caution"),
        (45, 56,           "normal"),
        (float("-inf"), 45, "opportunity"),
    ],
    "rsi_sp500": [
        (70, float("inf"), "caution"),
        (50, 70,           "normal"),
        (float("-inf"), 50, "opportunity"),
    ],
}

_SIGNAL_NAMES = {
    "vix":       "VIX",
    "vxn":       "VXN",
    "fg":        "F&G",
    "rsi_sp500": "RSI",
}

_REGIME_NAMES = {
    "volatility": "波动",
    "sentiment": "情绪",
    "momentum": "动能",
}


def classify_signal(name: str, value: float) -> str:
    """Return 'opportunity', 'normal', or 'caution' for a given signal value."""
    for lo, hi, direction in _ZONES[name]:
        if lo <= value < hi:
            return direction
    return "normal"


# ── Result dataclass ───────────────────────────────────────────────────────────

@dataclass
class ConfluenceResult:
    override: bool
    recommendation: str          # DCA action label
    action: str                  # executable DCA pace copy
    summary: str                 # plain-language Chinese description
    signal_labels: dict[str, str] = field(default_factory=dict)
    regimes: dict[str, str] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)
    counterfactuals: list[dict[str, object]] = field(default_factory=list)
    # counts of active signals per direction (excludes None signals)
    opportunity_count: int = 0
    normal_count: int = 0
    caution_count: int = 0
    signal_count: int = 0        # total non-None signals evaluated


# ── Confluence logic ───────────────────────────────────────────────────────────

def compute_confluence(
    vix: Optional[float],
    vxn: Optional[float],
    fg: Optional[int],
    rsi_sp500: Optional[float],
) -> ConfluenceResult:
    """
    Step 1 — Extreme outlier override (VIX > 35 OR VXN > 45).
    Step 2 — Descriptive count: classify each signal, tally, recommend.
    """
    signals = _present_signals(vix, vxn, fg, rsi_sp500)
    labels: dict[str, str] = {name: classify_signal(name, val) for name, val in signals.items()}
    regimes = _build_regimes(vix, vxn, fg, rsi_sp500, labels)
    opp_count = sum(1 for d in labels.values() if d == "opportunity")
    normal_count = sum(1 for d in labels.values() if d == "normal")
    caution_count = sum(1 for d in labels.values() if d == "caution")

    # Step 1: panic override
    if (vix is not None and vix > 35) or (vxn is not None and vxn > 45):
        return ConfluenceResult(
            override=True,
            recommendation="加大定投",
            action="提高定投系数",
            summary="波动进入极端恐慌区间，按计划分批提高定投力度。",
            signal_labels=labels,
            regimes=regimes,
            reasons=_build_reasons(labels, regimes, fg is None, override=True),
            opportunity_count=opp_count,
            normal_count=normal_count,
            caution_count=caution_count,
            signal_count=len(signals),
        )

    recommendation = _recommend_from_regimes(regimes)
    action = _action_for(recommendation)
    reasons = _build_reasons(labels, regimes, fg is None, override=False)
    counterfactuals = _build_counterfactuals(regimes, recommendation, fg is None)
    summary = _build_summary(regimes, recommendation, fg is None)

    return ConfluenceResult(
        override=False,
        recommendation=recommendation,
        action=action,
        summary=summary,
        signal_labels=labels,
        regimes=regimes,
        reasons=reasons,
        counterfactuals=counterfactuals,
        opportunity_count=opp_count,
        normal_count=normal_count,
        caution_count=caution_count,
        signal_count=len(signals),
    )


def _present_signals(
    vix: Optional[float],
    vxn: Optional[float],
    fg: Optional[int],
    rsi_sp500: Optional[float],
) -> dict[str, float]:
    signals: dict[str, float] = {}
    if vix is not None:
        signals["vix"] = float(vix)
    if vxn is not None:
        signals["vxn"] = float(vxn)
    if fg is not None:
        signals["fg"] = float(fg)
    if rsi_sp500 is not None:
        signals["rsi_sp500"] = float(rsi_sp500)
    return signals


def _build_regimes(
    vix: Optional[float],
    vxn: Optional[float],
    fg: Optional[int],
    rsi_sp500: Optional[float],
    labels: dict[str, str],
) -> dict[str, str]:
    regimes: dict[str, str] = {}
    vol = _volatility_regime(vix, vxn, labels)
    if vol is not None:
        regimes["volatility"] = vol
    if fg is not None:
        regimes["sentiment"] = labels["fg"]
    if rsi_sp500 is not None:
        regimes["momentum"] = labels["rsi_sp500"]
    return regimes


def _volatility_regime(
    vix: Optional[float],
    vxn: Optional[float],
    labels: dict[str, str],
) -> Optional[str]:
    if (vix is not None and vix > 35) or (vxn is not None and vxn > 45):
        return "panic"

    vol_labels = [labels[name] for name in ("vix", "vxn") if name in labels]
    if not vol_labels:
        return None
    if "opportunity" in vol_labels and "caution" not in vol_labels:
        return "opportunity"
    if vol_labels and all(d == "caution" for d in vol_labels):
        return "caution"
    if vol_labels and all(d == "normal" for d in vol_labels):
        return "normal"
    return "mixed"


def _recommend_from_regimes(regimes: dict[str, str]) -> str:
    volatility = regimes.get("volatility")
    sentiment = regimes.get("sentiment")
    momentum = regimes.get("momentum")

    if volatility == "panic":
        return "加大定投"
    if volatility == "opportunity":
        if sentiment != "caution" and momentum != "caution":
            return "加大定投"
        return "常规定投"
    if volatility == "caution" and (sentiment == "caution" or momentum == "caution"):
        return "谨慎追高"
    if volatility in (None, "normal", "mixed") and sentiment == "caution" and momentum == "caution":
        return "谨慎追高"
    return "常规定投"


def _action_for(recommendation: str) -> str:
    if recommendation == "加大定投":
        return "提高定投系数"
    if recommendation == "谨慎追高":
        return "降低新增资金速度"
    return "维持定投系数"


def _build_summary(regimes: dict[str, str], recommendation: str, fg_missing: bool) -> str:
    if not regimes:
        return "暂无可用市场信号，维持常规定投。"

    if regimes.get("volatility") == "panic":
        return "波动进入极端恐慌区间，按计划分批提高定投力度。"

    parts = []
    for name in ("volatility", "sentiment", "momentum"):
        direction = regimes.get(name)
        if direction is None:
            continue
        parts.append(f"{_REGIME_NAMES[name]}{_direction_phrase(direction)}")

    note = "；F&G 数据不可用" if fg_missing else ""
    body = "，".join(parts)
    bridge = "信号互相抵消" if recommendation == "常规定投" and "偏机会" in body and "偏谨慎" in body else _action_for(recommendation)
    return f"{body}{note}；{bridge}，建议：{recommendation}。"


def _build_reasons(
    labels: dict[str, str],
    regimes: dict[str, str],
    fg_missing: bool,
    override: bool,
) -> list[str]:
    reasons: list[str] = []
    if override:
        reasons.append("VIX/VXN 触发极端恐慌阈值")
    elif "volatility" in regimes:
        reasons.append(f"波动{_direction_phrase(regimes['volatility'])}")

    for name in ("fg", "rsi_sp500"):
        if name in labels:
            reasons.append(f"{_SIGNAL_NAMES[name]}{_direction_phrase(labels[name])}")

    if fg_missing:
        reasons.append("F&G 数据不可用")
    return reasons


def _build_counterfactuals(
    regimes: dict[str, str],
    recommendation: str,
    fg_missing: bool,
) -> list[dict[str, object]]:
    if recommendation != "常规定投":
        return []

    return [
        {
            "target": "加大定投",
            "missing": _missing_for_more_dca(regimes),
        },
        {
            "target": "谨慎追高",
            "missing": _missing_for_caution(regimes, fg_missing),
        },
    ]


def _missing_for_more_dca(regimes: dict[str, str]) -> list[str]:
    volatility = regimes.get("volatility")
    sentiment = regimes.get("sentiment")
    momentum = regimes.get("momentum")

    missing = ["VIX/VXN 未触发极端恐慌阈值"]
    if volatility != "opportunity":
        missing.append("波动未进入机会区间")
        return missing

    if sentiment == "caution":
        missing.append("F&G 偏谨慎，抵消波动机会")
    if momentum == "caution":
        missing.append("RSI 偏谨慎，抵消波动机会")
    return missing


def _missing_for_caution(regimes: dict[str, str], fg_missing: bool) -> list[str]:
    volatility = regimes.get("volatility")
    sentiment = regimes.get("sentiment")
    momentum = regimes.get("momentum")

    if volatility == "opportunity":
        return ["波动偏机会，不属于低波动追高环境"]

    if volatility == "caution":
        missing = []
        if sentiment != "caution":
            missing.append("F&G 未偏谨慎" if not fg_missing else "F&G 数据不可用")
        if momentum != "caution":
            missing.append("RSI 未偏谨慎")
        return missing or ["情绪/动能未配合低波动谨慎条件"]

    missing = []
    if sentiment != "caution":
        missing.append("F&G 未偏谨慎" if not fg_missing else "F&G 数据不可用")
    if momentum != "caution":
        missing.append("RSI 未偏谨慎")
    return missing or ["情绪与动能未同时偏谨慎"]


def _direction_phrase(direction: str) -> str:
    return {
        "panic": "极端恐慌",
        "opportunity": "偏机会",
        "normal": "正常",
        "caution": "偏谨慎",
        "mixed": "分歧",
    }.get(direction, direction)
