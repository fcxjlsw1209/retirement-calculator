from __future__ import annotations

"""
Portfolio attribution.

Approach: simplified (not full Brinson — Brinson breaks with RSU vests/cash flows).

Algorithm:
  1. For each asset class: gain = value_t1 - value_t0
     If gain > 20% of value_t0 in any class → mark possible_vest=True
     (This flags RSU vests rather than treating them as investment return)
  2. Portfolio approximate return = total_gain_excl_flagged_vests / total_value_t0
  3. Benchmark return = weighted average of SPY/AGG returns for the same period
  4. Feed structured data + caveats to Claude → Chinese explanation

The output is honest about the math's limitations. Claude is told explicitly which
numbers might include RSU vests so it can caveat the explanation appropriately.
"""

from datetime import date, timedelta
from typing import Optional
import json

import anthropic
import yfinance as yf

from backend import db
from backend.config import ANTHROPIC_API_KEY, BENCHMARK_TICKERS

# Threshold: >20% gain in a single asset class in one period → flag as possible vest
VEST_THRESHOLD = 0.20


class AttributionResult:
    def __init__(
        self,
        period_start: Optional[date],
        period_end: date,
        asset_class_data: list[dict],
        portfolio_return: Optional[float],
        benchmark_return: Optional[float],
    ):
        self.period_start = period_start
        self.period_end = period_end
        self.asset_class_data = asset_class_data
        self.portfolio_return = portfolio_return
        self.benchmark_return = benchmark_return


def compute_attribution(holdings: list, today: date = None) -> Optional[AttributionResult]:
    """
    Compute attribution from current holdings vs. prior snapshot.

    Returns None if no prior snapshot exists (first sync).
    """
    today = today or date.today()

    # Aggregate current holdings by asset class
    current_by_class: dict[str, float] = {}
    for h in holdings:
        current_by_class[h.asset_class] = current_by_class.get(h.asset_class, 0) + h.value_usd
    total_current = sum(current_by_class.values())

    # Find prior snapshot (most recent snapshot before today across all sources)
    # Use 'empower' as the primary snapshot since it covers 90% of the portfolio
    prior_snap = db.get_latest_snapshot_before("empower", today)
    if prior_snap is None:
        return None  # No prior data — skip attribution

    prior_allocation = json.loads(prior_snap.allocation_json)
    total_prior = prior_snap.total_value_usd
    period_start = prior_snap.snapshot_date

    if total_prior == 0:
        return None

    # Build per-asset-class data
    all_classes = set(current_by_class.keys()) | set(prior_allocation.keys())
    asset_class_data = []
    total_gain_excl_vests = 0.0
    total_prior_excl_vests = 0.0

    for cls in sorted(all_classes):
        value_t0 = prior_allocation.get(cls, 0) * total_prior
        value_t1 = current_by_class.get(cls, 0)
        gain = value_t1 - value_t0

        possible_vest = (
            value_t0 > 0
            and gain > 0
            and (gain / value_t0) > VEST_THRESHOLD
        )

        asset_class_data.append({
            "asset_class": cls,
            "value_t0": value_t0,
            "value_t1": value_t1,
            "gain": gain,
            "possible_vest": possible_vest,
        })

        if not possible_vest:
            total_gain_excl_vests += gain
            total_prior_excl_vests += value_t0

    portfolio_return = (
        total_gain_excl_vests / total_prior_excl_vests
        if total_prior_excl_vests > 0
        else None
    )

    benchmark_return = _get_benchmark_return(period_start, today)

    return AttributionResult(
        period_start=period_start,
        period_end=today,
        asset_class_data=asset_class_data,
        portfolio_return=portfolio_return,
        benchmark_return=benchmark_return,
    )


def _get_benchmark_return(start: date, end: date) -> Optional[float]:
    """
    Weighted benchmark return for the period.
    Caches daily data in SQLite to avoid hammering Yahoo Finance.
    """
    # Check cache first
    cached = db.get_benchmark_cache(end)
    if cached and cached.spy_return is not None:
        spy = cached.spy_return
        agg = cached.agg_return
    else:
        spy, agg = _fetch_returns_from_yfinance(start, end)
        db.save_benchmark_cache(end, spy, agg)

    if spy is None:
        return None

    # Weighted average: default 60% SPY / 40% AGG
    spy_weight = BENCHMARK_TICKERS.get("SPY", 0.6)
    agg_weight = BENCHMARK_TICKERS.get("AGG", 0.4)
    agg_val = agg if agg is not None else 0.0
    return spy * spy_weight + agg_val * agg_weight


def _fetch_returns_from_yfinance(start: date, end: date) -> tuple[Optional[float], Optional[float]]:
    """Fetch period returns for SPY and AGG from Yahoo Finance."""
    try:
        # Add one day buffer on each end for data availability
        t_start = start - timedelta(days=3)
        t_end = end + timedelta(days=1)

        data = yf.download(
            ["SPY", "AGG"],
            start=t_start.isoformat(),
            end=t_end.isoformat(),
            progress=False,
            auto_adjust=True,
        )

        def period_return(ticker: str) -> Optional[float]:
            if ticker not in data["Close"].columns:
                return None
            prices = data["Close"][ticker].dropna()
            if len(prices) < 2:
                return None
            return float((prices.iloc[-1] - prices.iloc[0]) / prices.iloc[0])

        return period_return("SPY"), period_return("AGG")

    except Exception as e:
        print(f"Warning: could not fetch benchmark returns: {e}")
        return None, None


# ── Claude explanation ─────────────────────────────────────────────────────────

def generate_explanation(result: AttributionResult) -> str:
    """
    Generate a plain-language Chinese explanation of portfolio performance.
    Saves result to attribution_cache table.
    """
    prompt = _build_prompt(result)

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )

    text = message.content[0].text.strip()
    db.save_attribution(text, result.period_start, result.period_end)
    return text


def _build_prompt(result: AttributionResult) -> str:
    # Format asset class table
    rows = []
    for d in result.asset_class_data:
        vest_flag = "⚠️ (可能含RSU归属)" if d["possible_vest"] else ""
        rows.append(
            f"  {d['asset_class']:<20} "
            f"t0: ${d['value_t0']:>10,.0f}  "
            f"t1: ${d['value_t1']:>10,.0f}  "
            f"变化: ${d['gain']:>+10,.0f}  {vest_flag}"
        )
    table = "\n".join(rows)

    benchmark_str = (
        f"{result.benchmark_return:.1%}" if result.benchmark_return is not None
        else "无法获取（Yahoo Finance 不可用）"
    )
    portfolio_str = (
        f"{result.portfolio_return:.1%}" if result.portfolio_return is not None
        else "无法计算（存在 RSU 归属影响）"
    )

    return f"""你是一位个人理财顾问。请分析以下投资组合数据并用中文解释表现原因。

期间：{result.period_start} → {result.period_end}

各资产类别变化：
{table}

参考基准（60% SPY / 40% AGG）期间收益：{benchmark_str}
投资组合期间收益（排除可能的 RSU 归属）：{portfolio_str}

说明：标记"⚠️ (可能含RSU归属)"的资产类别涨幅超过20%，可能包含新增股权收益而非纯投资回报，数字仅供参考。

请用3-4句话解释这段时间投资组合的表现原因。要求：
- 语言简洁直白，无需专业术语
- 如有数据不确定性，如实说明
- 不需要给出操作建议
- 直接输出解释，不要加标题或前缀"""
