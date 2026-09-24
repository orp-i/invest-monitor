"""Offline, reproducible price comparisons; no orders, no forecast scoring or report writes."""
import csv
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/daily-review-20260912"
OUT = ROOT / "docs/daily-review-20260818-0911"
OUT.mkdir(parents=True, exist_ok=True)
CUTOFF = "2026-09-11"
plan = json.loads((OUT / "metadata-plan.json").read_text())
prices, sources = {}, []
for file in sorted(DATA.glob("market-*.json")):
    obj = json.loads(file.read_text())
    if "series" not in obj and "candles" not in obj:
        continue
    key = file.stem.removeprefix("market-")
    series = obj.get("series", obj)
    bars = series.get("bars", obj.get("candles", []))
    rows = {}
    for bar in bars:
        day = bar.get("date", bar.get("openTime", "")[:10])
        if day <= CUTOFF:
            assert day not in rows, (key, "duplicate", day)
            rows[day] = {k: float(bar[k]) for k in ["open", "high", "low", "close"] if bar.get(k) is not None}
    assert rows, key
    prices[key] = dict(sorted(rows.items()))
    sources.append({"id": key, "file": str(file.relative_to(ROOT)), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "through": max(rows), "capturedAt": series.get("fetchedAt", obj.get("receivedAt")), "warnings": series.get("warnings", obj.get("warnings", []))})

sessions = sorted(prices["SPY"])
def change(start, end):
    return (end / start - 1) * 100

def window(key, date, length):
    days = [day for day in sessions if day >= date][:length]
    start, end = days[0], days[-1]
    field = "open" if key.isupper() else "close"
    available = [d for d in days if d in prices[key]]
    full = len(days) == length and len(available) == length
    first = prices[key].get(start, {}).get(field)
    last = prices[key].get(end, {}).get("close")
    # Missing yield endpoints stay missing: never carry forward FRED as same-day data.
    unit = "bp" if key in ["us10y", "us2y"] else "%"
    value = ((last - first) * 100 if unit == "bp" else change(first, last)) if full and first and last is not None else None
    return {"reportDate": date, "asset": key, "sessions": length, "start": start, "targetEnd": end if len(days) == length else None, "availableThrough": available[-1] if available else None, "observedSessions": len(available), "complete": full, "basis": "regular-open_to_Nth-close" if field == "open" else "report-session-close_to_Nth-close", "startPrice": first, "endPrice": last if full else None, "change": value, "unit": unit}

windows = [window(key, report["date"], n) for report in plan["reports"] for key in prices for n in [5, 10]]
with (OUT / "forward-windows.csv").open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=list(windows[0])); writer.writeheader(); writer.writerows(windows)
with (OUT / "daily-prices.csv").open("w", newline="") as f:
    writer = csv.writer(f); writer.writerow(["asset", "date", "open", "high", "low", "close", "usEquitySession"])
    for key, bars in prices.items():
        for day, bar in bars.items():
            if day >= "2026-08-17":
                writer.writerow([key, day, *[bar.get(k, "") for k in ["open", "high", "low", "close"]], day in sessions])

mas = {}
for date in ["2026-08-28", "2026-08-31", "2026-09-10", CUTOFF]:
    mas[date] = {}
    for key in ["sp500", "SPY"]:
        values = [bar["close"] for day, bar in prices[key].items() if day <= date]
        assert len(values) >= 200
        mas[date][key] = {str(n): sum(values[-n:]) / n for n in [50, 200]}

triggers = {}
for key, level in [("SPY", 760.4), ("QQQ", 703)]:
    bars = {d: b for d, b in prices[key].items() if d >= "2026-09-01"}
    triggers[key] = {"level": level, "minimumLow": min(b["low"] for b in bars.values()), "intradayBreaks": [{"date": d, **b} for d, b in bars.items() if b["low"] < level], "closeBreaks": [d for d, b in bars.items() if b["close"] < level]}

periods = []
for start in ["2026-08-17", "2026-08-31"]:
    for key, bars in prices.items():
        end = max(d for d in bars if d in sessions)
        a, b = bars[start]["close"], bars[end]["close"]
        unit = "bp" if key in ["us10y", "us2y"] else "%"
        periods.append({"asset": key, "from": start, "to": end, "start": a, "end": b, "change": (b - a) * 100 if unit == "bp" else change(a, b), "unit": unit})

def fmt(value):
    return "待满观察期／缺数" if value is None else f"{value:+.2f}%"

labels = {"risk-off": "风险偏好下降", "mixed": "分化", "neutral": "中性"}
lines = ["# 逐日报基准对照", "", "ETF 为报告日常规开盘到第 5 / 10 个交易日收盘；数字是标的价格变化，不是策略收益。缺少完整未来窗口时留空。8/18 等盘后回顾、盘中补充不参与盘前预测评价。", "", "| 日报 | 宏观判断 | 第5日 | SPY 5日 | QQQ 5日 | 第10日 | SPY 10日 | QQQ 10日 |", "| --- | --- | --- | ---: | ---: | --- | ---: | ---: |"]
for report in plan["reports"]:
    d = report["date"]
    s5, q5, s10, q10 = [window(k, d, n) for k, n in [("SPY", 5), ("QQQ", 5), ("SPY", 10), ("QQQ", 10)]]
    lines.append(f"| {d[5:]} | {labels[report['stance']]} | {s5['targetEnd'] or '未到期'} | {fmt(s5['change'])} | {fmt(q5['change'])} | {s10['targetEnd'] or '未到期'} | {fmt(s10['change'])} | {fmt(q10['change'])} |")
(OUT / "forward-windows.md").write_text("\n".join(lines) + "\n")
result = {"schemaVersion": 1, "cutoff": CUTOFF, "method": "SPY observed sessions; N includes report session; futures use same-session close (4/9 close intervals), not premarket executable entry; source price return, not total return or option P&L", "sources": sources, "movingAverages": mas, "triggers": triggers, "periods": periods, "windows": windows}
(OUT / "analysis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

os.environ.setdefault("MPLCONFIGDIR", "/tmp/invest-mpl")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.rcParams.update({"font.family": "DejaVu Sans", "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.alpha": .15, "font.size": 10, "savefig.facecolor": "#f8fafc"})
days = [d for d in sessions if d >= "2026-08-17"]
x = list(range(len(days)))
fig, axes = plt.subplots(3, 2, figsize=(14, 11), facecolor="#f8fafc", layout="constrained")
colors = ["#2563eb", "#d97706", "#7c3aed", "#059669"]
def draw(ax, keys, title, ylabel, mode="price"):
    for color, key in zip(colors, keys):
        valid = [(i, d) for i, d in enumerate(days) if d in prices[key]]
        baseline = prices[key][days[0]]["close"]
        vals = [prices[key][d]["close"] for _, d in valid]
        if mode == "index": vals = [v / baseline * 100 for v in vals]
        if mode == "bp": vals = [(v - baseline) * 100 for v in vals]
        ax.plot([i for i, _ in valid], vals, label=key, color=color, linewidth=1.8, marker=".", markersize=4)
    ax.set_title(title, loc="left", fontweight="bold"); ax.set_ylabel(ylabel)
    ax.set_xticks([0, 5, 10, 14, 18], [days[i][5:] for i in [0, 5, 10, 14, 18]])
    ax.legend(loc="best", frameon=False, fontsize=8)
draw(axes[0, 0], ["SPY"], "SPY: macro risk versus a support trigger", "USD / share")
for level in [760.4, 750]:
    axes[0, 0].axhline(level, ls="--", lw=1, color="#be123c", alpha=.7)
    axes[0, 0].text(.1, level + .8, str(level), color="#be123c", fontsize=9)
draw(axes[0, 1], ["SPY", "QQQ", "es-futures", "nq-futures"], "Equity ETFs and near-month futures", "Aug 17 close = 100", "index")
draw(axes[1, 0], ["wti-futures", "brent-futures"], "Oil strengthened; equity repricing was smaller", "USD / barrel")
draw(axes[1, 1], ["gold-futures", "silver-futures", "SIL"], "Metals and silver miners have different paths", "Aug 17 close = 100", "index")
draw(axes[2, 0], ["us10y", "us2y"], "Treasury yields (latest published: Sep 10)", "Change from Aug 17, bp", "bp")
draw(axes[2, 1], ["vix"], "VIX: risk concern rose, then partly eased", "Index points")
fig.suptitle("Daily report validation | Aug 18 - Sep 11, 2026", fontsize=18, fontweight="bold")
fig.supxlabel("US equity sessions only. Sources: captured Tradier / Yahoo / FRED daily history. Price comparisons, not executable strategy returns.", fontsize=9)
for suffix in ["png", "svg"]:
    fig.savefig(OUT / f"market-validation.{suffix}", dpi=160)
plt.close(fig)
print(json.dumps({"assets": len(prices), "reports": len(plan["reports"]), "comparisons": len(windows), "movingAverages": mas, "triggers": triggers}, indent=2))
