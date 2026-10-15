"""Value + quality stock scan.

Pulls the S&P 1500 (large, mid, small cap) from Wikipedia, fetches fundamentals
from Yahoo Finance, and writes docs/scan.json for the scanner page to score.

Metrics (raw values only; the page applies thresholds so they stay adjustable):
  pe       trailing P/E
  peg      Yahoo trailing PEG (5y growth estimate); fallback P/E / earnings growth
  de       Total Debt / Stockholders' Equity (latest annual balance sheet)
  roic     EBIT * (1 - tax rate) / (Total Debt + Equity - Cash)   (latest annual)
  fcfy     trailing free cash flow / market cap

Usage:  .venv/bin/python scan.py [--limit N]
"""
import argparse
import io
import json
import math
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

from ranges import price_ranges

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "scan.json"
HISTORY = ROOT / "history"

INDEXES = {
    "S&P 500": ("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", "Symbol"),
    "S&P 400": ("https://en.wikipedia.org/wiki/List_of_S%26P_400_companies", "Symbol"),
    "S&P 600": ("https://en.wikipedia.org/wiki/List_of_S%26P_600_companies", "Symbol"),
}
UA = {"User-Agent": "Mozilla/5.0 (stock-scanner personal use)"}


def universe():
    tickers = {}
    for name, (url, col) in INDEXES.items():
        html = requests.get(url, headers=UA, timeout=30).text
        for table in pd.read_html(io.StringIO(html)):
            cols = [str(c) for c in table.columns]
            match = next((c for c in cols if c.lower() in (col.lower(), "ticker symbol", "ticker")), None)
            if match:
                for sym in table[match].astype(str):
                    tickers.setdefault(sym.strip().replace(".", "-"), name)
                break
    return tickers


BLUECHIP_LISTS = [
    ("https://en.wikipedia.org/wiki/S%26P_100", "Symbol"),
    ("https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average", "Symbol"),
]


def bluechips():
    """S&P 100 + Dow 30 tickers."""
    out = set()
    for url, col in BLUECHIP_LISTS:
        html = requests.get(url, headers=UA, timeout=30).text
        for table in pd.read_html(io.StringIO(html)):
            if col in [str(c) for c in table.columns] and len(table) >= 25:
                out |= {str(x).strip().replace(".", "-") for x in table[col]}
                break
    return out


def tag_bluechips(rows):
    bc = bluechips()
    for r in rows:
        r["bc"] = r["t"] in bc
    print(f"blue chips tagged: {sum(r['bc'] for r in rows)}", flush=True)


def num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else x


def row(df, *names):
    if df is None or df.empty:
        return None
    for n in names:
        if n in df.index:
            s = df.loc[n].dropna()
            if len(s):
                return num(s.iloc[0])
    return None


def series(df, *names):
    """{year: value} for the first matching row, skipping blanks."""
    if df is None or df.empty:
        return {}
    for n in names:
        if n in df.index:
            out = {}
            for col, v in df.loc[n].items():
                v = num(v)
                if v is not None:
                    out[col.year] = v
            if out:
                return out
    return {}


def history(inc, bs, cf):
    """Multi-year record for Buffett-style tests (Yahoo provides ~4 annual years)."""
    ni = series(inc, "Net Income Common Stockholders", "Net Income")
    rev = series(inc, "Total Revenue")
    eq = series(bs, "Stockholders Equity", "Common Stock Equity")
    fcf = series(cf, "Free Cash Flow")
    if not fcf:
        ocf, capex = series(cf, "Operating Cash Flow"), series(cf, "Capital Expenditure")
        fcf = {y: ocf[y] + capex.get(y, 0) for y in ocf}
    years = sorted(set(ni) | set(fcf))
    rnd = lambda x, d=4: None if x is None else round(x, d)
    h = {
        "y": years,
        "roe": [rnd(ni[y] / eq[y]) if y in ni and eq.get(y, 0) > 0 else None for y in years],
        "nm": [rnd(ni[y] / rev[y]) if y in ni and rev.get(y, 0) > 0 else None for y in years],
        "fcf": [fcf.get(y) for y in years],
    }
    return h


def derived(h, debt, cash, ni_latest):
    """Summary stats the tests use, plus DCF inputs (the DCF itself runs on the page)."""
    roe = [x for x in h["roe"] if x is not None]
    nm = [x for x in h["nm"] if x is not None]
    fcf = [x for x in h["fcf"] if x is not None]
    out = {
        "roemin": min(roe) if len(roe) >= 3 else None,
        "roeavg": sum(roe) / len(roe) if len(roe) >= 3 else None,
        # latest net margin vs the average of earlier years, in percentage points
        "mgr": (nm[-1] - sum(nm[:-1]) / len(nm[:-1])) * 100 if len(nm) >= 3 else None,
        "fcfc": 100 * sum(1 for x in fcf if x > 0) / len(fcf) if len(fcf) >= 3 else None,
        "dny": (debt or 0) / ni_latest if ni_latest and ni_latest > 0 else None,
        "fcf0": sum(fcf[-3:]) / len(fcf[-3:]) if fcf else None,
        "netcash": (cash or 0) - (debt or 0),
    }
    # FCF growth: CAGR from first to last positive year; the page caps it
    if len(fcf) >= 3 and fcf[0] > 0 and fcf[-1] > 0:
        out["fcfg"] = (fcf[-1] / fcf[0]) ** (1 / (len(fcf) - 1)) - 1
    else:
        out["fcfg"] = None
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in out.items()}


def fetch(sym, index, tries=3):
    for attempt in range(tries):
        try:
            return _fetch(sym, index)
        except Exception as e:  # Yahoo throttles in bursts; back off and retry
            err = e
            time.sleep(2 * (attempt + 1))
    return {"t": sym, "err": str(err)[:120]}


def _fetch(sym, index):
    t = yf.Ticker(sym)
    i = t.info or {}
    price = num(i.get("currentPrice") or i.get("regularMarketPrice"))
    mcap = num(i.get("marketCap"))
    pe = num(i.get("trailingPE"))
    growth = num(i.get("earningsGrowth"))

    peg, peg_src = num(i.get("trailingPegRatio")), "yahoo"
    if peg is None:
        peg, peg_src = num(i.get("pegRatio")), "yahoo"
    if peg is None and pe and growth and growth > 0:
        peg, peg_src = pe / (growth * 100), "calc"

    inc, bs, cf = t.income_stmt, t.balance_sheet, t.cashflow
    debt = row(bs, "Total Debt")
    equity = row(bs, "Stockholders Equity", "Common Stock Equity")
    cash = row(bs, "Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents") or 0
    ebit = row(inc, "EBIT", "Operating Income")
    tax = row(inc, "Tax Rate For Calcs")
    tax = 0.21 if tax is None else min(max(tax, 0), 0.35)

    de = None
    if equity and equity > 0:
        de = (debt or 0) / equity
    elif equity is not None and equity <= 0:
        de = -1  # negative equity: flagged, never passes

    roic = None
    if ebit is not None and equity is not None:
        invested = (debt or 0) + equity - cash
        if invested > 0:
            roic = ebit * (1 - tax) / invested

    h = history(inc, bs, cf)
    ni_latest = row(inc, "Net Income Common Stockholders", "Net Income")
    fcf = num(i.get("freeCashflow"))
    fcfy = fcf / mcap if fcf is not None and mcap else None

    return {
        "t": sym,
        "n": i.get("shortName") or i.get("longName") or sym,
        "idx": index,
        "sec": i.get("sector") or "Unknown",
        "ind": i.get("industry") or "",
        "px": price,
        "mc": mcap,
        "pe": pe,
        "fpe": num(i.get("forwardPE")),
        "peg": peg,
        "pegs": peg_src,
        "de": de,
        "roic": roic,
        "fcfy": fcfy,
        "roe": num(i.get("returnOnEquity")),
        "eg": growth,
        "rg": num(i.get("revenueGrowth")),
        "dy": num(i.get("dividendYield")),
        "tgt": num(i.get("targetMeanPrice")),
        "chg52": num(i.get("52WeekChange")),
        "sh": num(i.get("sharesOutstanding") or i.get("impliedSharesOutstanding")),
        "h": h,
        **derived(h, debt, cash, ni_latest),
    }


def add_ranges(rows):
    """Attach 52-week low/high (and a same-source last close) to each row."""
    rng = price_ranges([r["t"] for r in rows])
    for r in rows:
        g = rng.get(r["t"])
        if g:
            r.update(lo52=g["lo52"], hi52=g["hi52"])
            r["px"] = r["px"] or g["px"]
    print(f"52-week ranges: {len(rng)}/{len(rows)}", flush=True)


def sector_medians(rows):
    by = {}
    for r in rows:
        if r.get("pe") and r["pe"] > 0:
            by.setdefault(r["sec"], []).append(r["pe"])
    allpe = [p for v in by.values() for p in v]
    out = {s: round(statistics.median(v), 2) for s, v in by.items() if len(v) >= 3}
    out["_market"] = round(statistics.median(allpe), 2) if allpe else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    uni = universe()
    syms = list(uni.items())[: args.limit or None]
    print(f"universe: {len(uni)} tickers, scanning {len(syms)}", flush=True)

    t0, rows, failed = time.time(), [], []
    with ThreadPoolExecutor(args.workers) as ex:
        futs = [ex.submit(fetch, s, idx) for s, idx in syms]
        for k, f in enumerate(as_completed(futs), 1):
            r = f.result()
            (failed if "err" in r else rows).append(r)
            if k % 100 == 0:
                print(f"  {k}/{len(syms)}  {time.time() - t0:.0f}s", flush=True)

    # Yahoo rate-limits bursts ("Invalid Crumb" / 429). Retry stragglers slowly.
    for rnd in range(1, 4):
        if not failed:
            break
        time.sleep(30 * rnd)
        print(f"retry round {rnd}: {len(failed)} tickers", flush=True)
        retry, failed = failed, []
        with ThreadPoolExecutor(2) as ex:
            for r in ex.map(lambda f: fetch(f["t"], uni[f["t"]]), retry):
                (failed if "err" in r else rows).append(r)
                time.sleep(0.3)

    rows.sort(key=lambda r: r["t"])
    add_ranges(rows)
    tag_bluechips(rows)
    meds = sector_medians(rows)

    # Previous scan, so the page can flag stocks that are new to the shortlist.
    prev = None
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text())
            keep = ("pe", "peg", "de", "roic", "fcfy", "roemin", "dny", "mgr", "fcfc", "fcf0", "fcfg", "netcash", "sh")
            prev = {"at": old["at"], "rows": {r["t"]: {k: r.get(k) for k in keep} for r in old["rows"]}}
        except Exception:
            prev = None

    data = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe": len(uni),
        "scanned": len(rows),
        "failed": [f["t"] for f in failed],
        "medians": meds,
        "rows": rows,
        "prev": prev,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    HISTORY.mkdir(exist_ok=True)
    (HISTORY / f"scan-{data['at'][:10]}.json").write_text(json.dumps(data, separators=(",", ":")))
    print(f"done: {len(rows)} ok, {len(failed)} failed, {time.time() - t0:.0f}s -> {OUT}")


if __name__ == "__main__":
    main()
