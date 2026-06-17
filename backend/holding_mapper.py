from __future__ import annotations

"""
Maps portfolio holdings to market signal relevance and generates
personalized DCA notices for the Market Pulse page.

Notice order: single-stock concentration → VXN tech group → VIX individual.
"""

from dataclasses import dataclass
from typing import Optional

from backend.market_pulse import classify_signal


# holding_type strings produced by _classify_holding_type()
_VXN_TYPES = {"US Fund - Tech", "US Stock - Tech"}
_VIX_TYPES = {
    "US Fund - Broad", "US Fund - Small Cap", "US Fund - Thematic",
    "US Stock - Other", "Intl Stock", "Intl Fund",
    "US Fund - Target Date",
}
_SKIP_TYPES = {"Bond", "Bond Fund", "Cash", "Alternative", "Gold", "Crypto"}
_SINGLE_STOCK_TYPES = {"US Stock - Tech", "US Stock - Other", "Intl Stock"}

MIN_WEIGHT_PCT = 5.0
SINGLE_STOCK_THRESHOLD = 15.0   # single stock concentration alert
TECH_GROUP_MAINTAIN = 25.0      # above: downgrade opportunity → maintain
TECH_GROUP_CAUTION  = 35.0      # above: override to maintain regardless of VXN


@dataclass
class PersonalizedNotice:
    ticker: Optional[str]
    name: Optional[str]
    weight_pct: float
    signal: str
    signal_value: float
    signal_direction: str       # 'opportunity' | 'normal' | 'caution'
    message: str
    unmapped: bool = False
    guidance_bucket: str = "neutral"  # 'priority' | 'defer' | 'maintain' | 'neutral'


@dataclass
class _Exposure:
    ticker: Optional[str]
    name: Optional[str]
    holding_type: str
    weight_pct: float
    holding: object


def generate_notices(
    holdings: list,
    total_value: float,
    vix: Optional[float],
    vxn: Optional[float],
) -> list[PersonalizedNotice]:
    if total_value <= 0:
        return []

    notices: list[PersonalizedNotice] = []

    # ── Pass 1: single-stock concentration (signal-independent) ──────────────
    concentrated_stock_keys: set[str] = set()
    single_stock_exposures = _aggregate_exposures(
        holdings,
        total_value,
        lambda h: getattr(h, "holding_type", "Unknown") in _SINGLE_STOCK_TYPES,
    )
    for dedup_key, exposure in single_stock_exposures.items():
        if exposure.weight_pct < SINGLE_STOCK_THRESHOLD:
            continue
        concentrated_stock_keys.add(dedup_key)
        signal = "vxn" if exposure.holding_type == "US Stock - Tech" else "vix"
        signal_value = float((vxn if signal == "vxn" else vix) or 0.0)
        notices.append(PersonalizedNotice(
            ticker=exposure.ticker,
            name=exposure.name,
            weight_pct=round(exposure.weight_pct, 1),
            signal=signal,
            signal_value=signal_value,
            signal_direction="caution",
            message=_build_concentration_message(exposure),
            unmapped=False,
            guidance_bucket="defer",
        ))

    # ── Pass 2: VXN tech group ────────────────────────────────────────────────
    tech_by_key = _aggregate_exposures(
        holdings,
        total_value,
        lambda h: getattr(h, "holding_type", "Unknown") in _VXN_TYPES,
    )

    if tech_by_key and vxn is not None:
        total_tech_weight = sum(v.weight_pct for v in tech_by_key.values())
        if total_tech_weight >= MIN_WEIGHT_PCT:
            direction = classify_signal("vxn", vxn)
            if direction != "normal":
                if direction == "caution":
                    tech_bucket = "defer"
                elif total_tech_weight > TECH_GROUP_MAINTAIN:
                    # concentration guard fires: don't recommend adding more
                    tech_bucket = "maintain"
                else:
                    tech_bucket = "priority"
                notices.append(PersonalizedNotice(
                    ticker=None,
                    name="科技持仓",
                    weight_pct=round(total_tech_weight, 1),
                    signal="vxn",
                    signal_value=vxn,
                    signal_direction=direction,
                    message=_build_group_message(
                        tech_by_key, total_tech_weight, vxn, direction
                    ),
                    unmapped=False,
                    guidance_bucket=tech_bucket,
                ))

    # ── Pass 3: VIX individual holdings ──────────────────────────────────────
    vix_exposures = _aggregate_exposures(
        holdings,
        total_value,
        lambda h: (
            getattr(h, "holding_type", "Unknown") not in _SKIP_TYPES
            and getattr(h, "holding_type", "Unknown") not in _VXN_TYPES
        ),
    )
    for dedup_key, exposure in vix_exposures.items():
        if dedup_key in concentrated_stock_keys:
            continue
        if exposure.weight_pct < MIN_WEIGHT_PCT:
            continue
        if vix is None:
            continue
        direction = classify_signal("vix", vix)
        if direction == "normal":
            continue
        unmapped = exposure.holding_type not in _VIX_TYPES
        notices.append(PersonalizedNotice(
            ticker=exposure.ticker,
            name=exposure.name,
            weight_pct=round(exposure.weight_pct, 1),
            signal="vix",
            signal_value=vix,
            signal_direction=direction,
            message=_build_message(
                exposure.holding, exposure.weight_pct, "vix", vix, direction, unmapped
            ),
            unmapped=unmapped,
            guidance_bucket="priority" if direction == "opportunity" else "defer",
        ))

    return notices


def _holding_key(h) -> Optional[str]:
    ticker = getattr(h, "ticker", None) or ""
    name = getattr(h, "name", None) or ""
    return ticker or name or None


def _aggregate_exposures(holdings: list, total_value: float, include) -> dict[str, _Exposure]:
    exposures: dict[str, _Exposure] = {}
    for h in holdings:
        if not include(h):
            continue
        key = _holding_key(h)
        if not key:
            continue
        weight_pct = (getattr(h, "value_usd", 0) / total_value) * 100
        if key in exposures:
            exposures[key].weight_pct += weight_pct
        else:
            exposures[key] = _Exposure(
                ticker=(getattr(h, "ticker", None) or None),
                name=getattr(h, "name", None),
                holding_type=getattr(h, "holding_type", "Unknown"),
                weight_pct=weight_pct,
                holding=h,
            )
    return exposures


def _build_concentration_message(exposure: _Exposure) -> str:
    ticker = exposure.ticker or exposure.name or "该持仓"
    return (
        f"你持有 {ticker}（{exposure.weight_pct:.0f}%），单股集中度偏高。"
        f"新增资金建议优先配置其他资产，以降低个股风险暴露。"
    )


def _build_group_message(
    tech_by_key: dict[str, _Exposure],
    total_weight: float,
    vxn: float,
    direction: str,
) -> str:
    sorted_items = sorted(tech_by_key.values(), key=lambda x: x.weight_pct, reverse=True)
    top = sorted_items[:3]
    rest_count = len(sorted_items) - 3
    parts = [
        f"{item.ticker or item.name or '未知'} {item.weight_pct:.1f}%"
        for item in top
    ]
    breakdown = " · ".join(parts)
    if rest_count > 0:
        breakdown += f"，等 {rest_count} 个持仓"

    if total_weight > TECH_GROUP_CAUTION:
        if direction == "opportunity":
            action = "科技仓位已达较高比例，即便 VXN 处于机会区间，建议维持现有节奏，不宜继续集中加仓。"
        else:
            action = "科技仓位偏重且市场处于低波动区间，新增资金建议优先配置其他资产类别。"
    elif total_weight > TECH_GROUP_MAINTAIN and direction == "opportunity":
        action = "科技暴露已较高，建议维持现有定投节奏，不急于加仓。"
    elif direction == "opportunity":
        action = "当前为加仓机会区间，可适当加大科技类定投力度。"
    else:
        action = "处于偏高区间，新增资金建议优先配置宽基或非科技资产以分散风险。"

    return (
        f"你的科技类持仓（{breakdown}）合计 {total_weight:.1f}%，"
        f"VXN 当前 {vxn:.1f}，{action}"
    )


def _build_message(
    h,
    weight_pct: float,
    signal: str,
    value: float,
    direction: str,
    unmapped: bool,
) -> str:
    ticker = getattr(h, "ticker", None) or getattr(h, "name", "该持仓") or "该持仓"
    signal_label = "VXN" if signal == "vxn" else "VIX"
    unmapped_note = "（未分类，使用 VIX 作为参考）" if unmapped else ""

    if direction == "opportunity":
        action = "当前为加仓机会区间，可适当加大定投力度。"
    else:
        action = "处于偏高区间，新增资金建议优先配置其他资产以分散风险。"

    return (
        f"你持有 {ticker}（{weight_pct:.0f}%）{unmapped_note}，"
        f"{signal_label} 当前 {value:.1f}，{action}"
    )
