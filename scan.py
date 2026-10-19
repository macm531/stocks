"""Stock scan: every NYSE and Nasdaq common stock (see universe.py).

Incremental: each run refreshes fundamentals for the stalest tickers within a time
budget (S&P 1500 first, so they refresh daily), merges them into docs/scan.json, then
refreshes 52-week ranges and 5-year trends for everything in one batched pass.

Metrics (raw values only; the page applies thresholds so they stay adjustable):
  pe       trailing P/E
  peg      Yahoo trailing PEG (5y growth estimate); fallback P/E / earnings growth
  de       Total Debt / Stockholders' Equity (latest annual balance sheet)
  roic     EBIT * (1 - tax rate) / (Total Debt + Equity - Cash)   (latest annual)
  fcfy     trailing free cash flow / market cap

Usage:  .venv/bin/python scan.py [--budget MINUTES] [--limit N]
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

from ranges import price_ranges, trend_stats

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "scan.json"
HISTORY = ROOT / "history"
CKPT = ROOT / "scan_partial.json"
CO = ROOT / "docs" / "co"  # per-company detail files (description, headlines, SEC filings)  # progress saved during a run, so a crash never loses fetched data

UA = {"User-Agent": "Mozilla/5.0 (stock-scanner personal use)"}


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
    shares = series(inc, "Diluted Average Shares", "Basic Average Shares") or series(bs, "Ordinary Shares Number", "Share Issued")
    ebit = series(inc, "EBIT", "Operating Income")
    tax = series(inc, "Tax Rate For Calcs")
    debt = series(bs, "Total Debt")
    cash = series(bs, "Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents")

    def roic(y):
        if y not in ebit or y not in eq:
            return None
        invested = debt.get(y, 0) + eq[y] - cash.get(y, 0)
        t = min(max(tax.get(y, 0.21), 0), 0.35)
        return ebit[y] * (1 - t) / invested if invested > 0 else None

    years = sorted(set(ni) | set(fcf))
    rnd = lambda x, d=4: None if x is None else round(x, d)
    h = {
        "y": years,
        "roe": [rnd(ni[y] / eq[y]) if y in ni and eq.get(y, 0) > 0 else None for y in years],
        "roic": [rnd(roic(y)) for y in years],
        "nm": [rnd(ni[y] / rev[y]) if y in ni and rev.get(y, 0) > 0 else None for y in years],
        "rev": [rev.get(y) for y in years],
        "fcf": [fcf.get(y) for y in years],
        "sh": [shares.get(y) for y in years],
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
        # lowest yearly ROIC in the record: consistency, not one good year
        "roicmin": min(rc) if len(rc := [x for x in h.get("roic", []) if x is not None]) >= 3 else None,
        # share of years revenue grew vs the year before
        "rgc": (100 * sum(1 for a, b in zip(rv, rv[1:]) if b > a) / (len(rv) - 1)
                if len(rv := [x for x in h.get("rev", []) if x is not None]) >= 3 else None),
        # share count change per year, in % (negative = buybacks shrink the count, positive = dilution)
        "shchg": ((sh[-1] / sh[0]) ** (1 / (len(sh) - 1)) - 1) * 100
                 if len(sh := [x for x in h.get("sh", []) if x]) >= 3 and sh[0] > 0 else None,
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
    # interest coverage: operating profit / interest owed (latest year that reports interest)
    interest = row(inc, "Interest Expense", "Interest Expense Non Operating")
    if ebit is None:
        icov = None
    elif not interest:
        icov = 999.0 if ebit > 0 else None  # profitable and no interest reported: effectively no debt burden
    else:
        icov = round(ebit / abs(interest), 1)
    fcf = num(i.get("freeCashflow"))
    fcfy = fcf / mcap if fcf is not None and mcap else None

    return {
        "t": sym,
        "n": i.get("shortName") or i.get("longName") or sym,
        "idx": index,
        "sec": i.get("sector") or "Unknown",
        "ctry": i.get("country") or "",
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
        "icov": icov,
        # outlook: analyst view, expected earnings, moving averages (all from the profile already fetched)
        "rec": i.get("recommendationKey") if i.get("recommendationKey") not in (None, "none") else None,
        "recm": num(i.get("recommendationMean")),
        "nan": num(i.get("numberOfAnalystOpinions")),
        "tlo": num(i.get("targetLowPrice")), "thi": num(i.get("targetHighPrice")),
        "feps": num(i.get("forwardEps")), "teps": num(i.get("trailingEps")),
        "earn": num(i.get("earningsTimestamp")),
        "ma50": num(i.get("fiftyDayAverage")), "ma200": num(i.get("twoHundredDayAverage")),
        "_co": {  # longer text goes to docs/co/<ticker>.json, loaded only when a report opens
            "sum": i.get("longBusinessSummary") or "",
            "ceo": next((f"{o.get('name')} ({o.get('title')})" for o in (i.get("companyOfficers") or [])
                         if "CEO" in (o.get("title") or "") or "Chief Executive" in (o.get("title") or "")), None),
            "emp": num(i.get("fullTimeEmployees")),
            "web": i.get("website"),
        },
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
    add_trends(rows)


def add_trends(rows):
    tr = trend_stats([r["t"] for r in rows])
    for r in rows:
        r.update(tr.get(r["t"], {}))
    print(f"5-year trends: {len(tr)}/{len(rows)}", flush=True)


def sector_medians(rows):
    by = {}
    for r in rows:
        if r.get("pe") and r["pe"] > 0:
            by.setdefault(r["sec"], []).append(r["pe"])
    allpe = [p for v in by.values() for p in v]
    out = {s: round(statistics.median(v), 2) for s, v in by.items() if len(v) >= 3}
    out["_market"] = round(statistics.median(allpe), 2) if allpe else None
    return out


def write_co(rows):
    """Merge each fresh row's long text into docs/co/<ticker>.json, keeping headlines/filings added by details.py."""
    CO.mkdir(parents=True, exist_ok=True)
    for r in rows:
        co = r.pop("_co", None)
        if not co:
            continue
        f = CO / f"{r['t']}.json"
        try:
            cur = json.loads(f.read_text()) if f.exists() else {}
        except Exception:
            cur = {}
        cur.update(co)
        f.write_text(json.dumps(cur, separators=(",", ":")))


def approx_russell2000(rows):
    """Russell 2000 approximation: US companies ranked 1,001-3,000 by market cap (FTSE Russell's rule)."""
    us = sorted((r for r in rows if r.get("ctry") == "United States" and r.get("mc")), key=lambda r: -r["mc"])
    members = {r["t"] for r in us[1000:3000]}
    for r in rows:
        r["r2k"] = r["t"] in members
    print(f"Russell 2000 (approx.) tagged: {len(members)}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--budget", type=float, default=70, help="minutes to spend fetching fundamentals")
    ap.add_argument("--stale-hours", type=float, default=20, help="refresh anything older than this")
    ap.add_argument("--limit", type=int, default=0, help="cap tickers fetched this run (testing)")
    args = ap.parse_args()

    from universe import build
    uni = build()
    old = {}
    if OUT.exists():
        try:
            old_data = json.loads(OUT.read_text())
            old = {r["t"]: r for r in old_data["rows"]}
            # tickers dropped for being too small still count as checked, so they aren't refetched every run
            for t, ts in old_data.get("skipped", {}).items():
                old.setdefault(t, {"t": t, "ts": ts, "_skip": True})
        except Exception:
            old_data = None
    else:
        old_data = None

    # Resume: rows fetched by an interrupted run count as fresh cache.
    if CKPT.exists():
        try:
            part = json.loads(CKPT.read_text())
            old.update(part)
            print(f"resuming: {len(part)} rows from an interrupted run", flush=True)
        except Exception:
            pass

    # Oldest data first; S&P 1500 members jump the queue so they refresh every day.
    now = datetime.now(timezone.utc)
    def age_h(t):
        ts = old.get(t, {}).get("ts")
        return 1e9 if not ts else (now - datetime.fromisoformat(ts)).total_seconds() / 3600
    stale = [t for t in uni if age_h(t) >= args.stale_hours]
    stale.sort(key=lambda t: (uni[t]["idx"] == "", -age_h(t)))
    if args.limit:
        stale = stale[:args.limit]
    print(f"universe: {len(uni)} tickers, {len(old)} cached, {len(stale)} due for refresh", flush=True)

    t0, fresh, failed = time.time(), {}, []
    deadline = t0 + args.budget * 60
    def run(batch, workers):
        with ThreadPoolExecutor(workers) as ex:
            for r in ex.map(lambda t: fetch(t, uni[t]["idx"]), batch):
                if "err" in r:
                    failed.append(r["t"])
                else:
                    r["ts"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    fresh[r["t"]] = r
    for k in range(0, len(stale), 100):
        if time.time() > deadline:
            print(f"time budget reached after {k} tickers; the rest wait for the next run", flush=True)
            break
        run(stale[k:k + 100], args.workers)
        if (k // 100) % 5 == 4:
            CKPT.write_text(json.dumps(fresh, separators=(",", ":")))
        print(f"  {min(k + 100, len(stale))}/{len(stale)}  {time.time() - t0:.0f}s  ({len(failed)} failed)", flush=True)

    # Yahoo rate-limits bursts ("Invalid Crumb" / 429). Retry stragglers slowly while time allows.
    for rnd in range(1, 4):
        if not failed or time.time() > deadline + 600:
            break
        time.sleep(30 * rnd)
        retry, failed[:] = list(failed), []
        print(f"retry round {rnd}: {len(retry)} tickers", flush=True)
        run(retry, 2)

    # Merge: fresh rows win, cached rows fill in, delisted tickers drop out.
    rows = []
    for t, info in uni.items():
        r = fresh.get(t) or old.get(t)
        if not r or r.get("_skip"):
            continue
        r["idx"], r["exch"] = info["idx"], info["exch"]
        rows.append(r)
    rows.sort(key=lambda r: r["t"])
    write_co(fresh.values())
    CKPT.write_text(json.dumps(fresh, separators=(",", ":")))
    try:
        add_ranges(rows)
    except Exception as e:  # never lose fundamentals over a price-history hiccup
        print(f"price/trend refresh failed: {e}", flush=True)
    # drop shells: no price, or under $50M (micro-caps too thin to score); remember when they were checked
    keep = [r for r in rows if r.get("px") and (r.get("mc") or 0) >= 50e6]
    kept = {r["t"] for r in keep}
    skipped = {t: r["ts"] for t, r in old.items() if r.get("_skip") and t in uni and t not in fresh}
    skipped.update({r["t"]: r.get("ts") for r in rows if r["t"] not in kept and r.get("ts")})
    rows = keep
    tag_bluechips(rows)
    approx_russell2000(rows)
    meds = sector_medians(rows)

    # Previous scan, so the page can flag stocks that are new to the shortlist.
    prev = None
    if old_data:
        keep = ("pe", "peg", "de", "roic", "fcfy", "roemin", "dny", "mgr", "fcfc", "fcf0", "fcfg", "netcash", "sh")
        prev = {"at": old_data["at"], "rows": {r["t"]: {k: r.get(k) for k in keep} for r in old_data["rows"]}}

    data = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe": len(uni),
        "scanned": len(rows),
        "refreshed": len(fresh),
        "failed": failed,
        "skipped": skipped,
        "medians": meds,
        "rows": rows,
        "prev": prev,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    CKPT.unlink(missing_ok=True)
    print(f"done: {len(fresh)} refreshed, {len(failed)} failed, {len(rows)} in file, "
          f"{time.time() - t0:.0f}s -> {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
