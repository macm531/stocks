"""Option-selling scanner: cash-secured puts and covered calls on quality stocks.

Universe: stocks in docs/scan.json that pass the fundamentals gate in config.json `options`
(debt-to-equity below the cap, positive trailing earnings and a profit in every reported year).
For each, pulls Yahoo option chains in the DTE window, solves implied volatility from the mid
price, computes delta and probability of profit, and keeps every contract inside a loose
envelope so the page can tighten the filters live. Writes docs/options.json.

IV Rank needs a year of implied-volatility history, which Yahoo doesn't provide. Each run
appends today's 30-day at-the-money IV to docs/ivhist.json; once a ticker has
`ivr.minDays` of history the true IV Rank is used. Until then the rank is estimated
against the past year's range of 30-day realized (historical) volatility, and flagged "est".

Usage: python options.py [--limit N] [--tickers AAPL,MSFT]
"""
import argparse, json, math, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import yfinance as yf

ROOT = Path(__file__).parent
DOCS = ROOT / "docs"
CFG = json.loads((DOCS / "config.json").read_text())["options"]
ENV = CFG["envelope"]          # loosest values kept in the output
WORKERS = 4                    # Yahoo throttles above this


# ---------- Black-Scholes ----------
def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_price(S, K, T, r, q, v, put):
    if v <= 0 or T <= 0:
        return max(0.0, (K - S) if put else (S - K))
    d1 = (math.log(S / K) + (r - q + v * v / 2) * T) / (v * math.sqrt(T))
    d2 = d1 - v * math.sqrt(T)
    if put:
        return K * math.exp(-r * T) * ncdf(-d2) - S * math.exp(-q * T) * ncdf(-d1)
    return S * math.exp(-q * T) * ncdf(d1) - K * math.exp(-r * T) * ncdf(d2)


def implied_vol(price, S, K, T, r, q, put):
    lo, hi = 0.01, 5.0
    if price <= bs_price(S, K, T, r, q, lo, put) or price >= bs_price(S, K, T, r, q, hi, put):
        return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if bs_price(S, K, T, r, q, mid, put) > price:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def delta(S, K, T, r, q, v, put):
    d1 = (math.log(S / K) + (r - q + v * v / 2) * T) / (v * math.sqrt(T))
    return math.exp(-q * T) * (ncdf(d1) - 1 if put else ncdf(d1))


def prob_above(S, X, T, r, q, v):
    """Risk-neutral probability the stock finishes above X."""
    if X <= 0:
        return 1.0
    d2 = (math.log(S / X) + (r - q - v * v / 2) * T) / (v * math.sqrt(T))
    return ncdf(d2)


# ---------- helpers ----------
def quality(r):
    """Fundamentals gate: low debt, profitable now and in every reported year."""
    h = r.get("h") or {}
    nm = [x for x in (h.get("nm") or []) if x is not None]
    de, pe, mc = r.get("de"), r.get("pe"), r.get("mc") or 0
    return (de is not None and 0 <= de < CFG["deMax"] and pe is not None and pe > 0
            and len(nm) >= 2 and all(x > 0 for x in nm) and mc >= CFG["minCapB"] * 1e9)


def risk_free():
    try:
        v = yf.Ticker("^IRX").history(period="5d")["Close"].dropna().iloc[-1]
        return float(v) / 100
    except Exception:
        return 0.04


def hv_series(close):
    lr = np.diff(np.log(close))
    if len(lr) < 60:
        return None
    w = 21
    return np.array([lr[i - w:i].std(ddof=1) * math.sqrt(252) for i in range(w, len(lr) + 1)])


def earnings_date(tk):
    try:
        cal = tk.calendar or {}
        ed = cal.get("Earnings Date") or []
        ed = [d for d in ed if isinstance(d, date)]
        return min(ed).isoformat() if ed else None
    except Exception:
        return None


def mid_of(row):
    b, a = float(row.bid or 0), float(row.ask or 0)
    if b <= 0 or a <= 0 or a < b:
        return None, None
    m = (a + b) / 2
    return m, (a - b) / m


def scan_one(r, rate, today, ivhist):
    t = r["t"]
    tk = yf.Ticker(t)
    exps = tk.options
    if not exps:
        return None
    hist = tk.history(period="1y", auto_adjust=True)["Close"].dropna()
    if len(hist) < 60:
        return None
    S = float(hist.iloc[-1])
    q = (r.get("dy") or 0) / 100

    wanted = [(e, (date.fromisoformat(e) - today).days) for e in exps]
    window = [(e, d) for e, d in wanted if ENV["dteMin"] <= d <= ENV["dteMax"]]
    # nearest expiry to 30 DTE for the at-the-money IV reading
    atm_exp = min(wanted, key=lambda x: abs(x[1] - 30)) if wanted else None
    fetch = {e for e, _ in window} | ({atm_exp[0]} if atm_exp and atm_exp[1] >= 7 else set())

    contracts, atm_iv = [], None
    for e in sorted(fetch):
        dte = (date.fromisoformat(e) - today).days
        T = max(dte, 1) / 365
        try:
            ch = tk.option_chain(e)
        except Exception:
            continue
        if e == atm_exp[0]:
            ivs = []
            for df, put in ((ch.calls, False), (ch.puts, True)):
                if df.empty:
                    continue
                row = df.iloc[(df.strike - S).abs().argmin()]
                m, _ = mid_of(row)
                if m:
                    v = implied_vol(m, S, float(row.strike), T, rate, q, put)
                    if v:
                        ivs.append(v)
            atm_iv = sum(ivs) / len(ivs) if ivs else None
        if not (ENV["dteMin"] <= dte <= ENV["dteMax"]):
            continue
        for df, put in ((ch.puts, True), (ch.calls, False)):
            for row in df.itertuples():
                K = float(row.strike)
                if (put and K >= S) or (not put and K <= S):
                    continue  # out-of-the-money only
                vol, oi = int(row.volume or 0) if row.volume == row.volume else 0, int(row.openInterest or 0) if row.openInterest == row.openInterest else 0
                if vol < ENV["volMin"] or oi < ENV["oiMin"]:
                    continue
                m, spr = mid_of(row)
                if not m or spr > ENV["spreadMax"] / 100:
                    continue
                iv = implied_vol(m, S, K, T, rate, q, put)
                if not iv:
                    continue
                d = delta(S, K, T, rate, q, iv, put)
                if not (ENV["deltaMin"] <= abs(d) <= ENV["deltaMax"]):
                    continue
                if put:
                    be = K - m
                    pop = prob_above(S, be, T, rate, q, iv)
                    ret = m / (K - m)          # premium over cash actually tied up
                else:
                    be = S - m
                    pop = 1 - prob_above(S, K + m, T, rate, q, iv)  # profit vs. not selling: stays below strike + premium
                    ret = m / S
                contracts.append({
                    "ty": "P" if put else "C", "k": K, "x": e, "dte": dte,
                    "bid": round(float(row.bid), 2), "ask": round(float(row.ask), 2), "mid": round(m, 2),
                    "spr": round(spr * 100, 1), "vol": vol, "oi": oi, "iv": round(iv, 4), "d": round(d, 3),
                    "pop": round(pop, 3), "be": round(be, 2), "otm": round(abs(K / S - 1), 4),
                    "ret": round(ret, 5), "ann": round(ret * 365 / max(dte, 1), 4),
                })

    # IV rank: true if enough history, else estimated from realized-vol range
    hv = hv_series(hist.values)
    ivr = ivp = None
    est = True
    if atm_iv:
        past = [v for d_, v in ivhist.get(t, []) if d_ != today.isoformat()]
        if len(past) >= CFG["ivr"]["minDays"]:
            lo, hi = min(past + [atm_iv]), max(past + [atm_iv])
            ivr = (atm_iv - lo) / (hi - lo) if hi > lo else 0.5
            ivp = sum(v < atm_iv for v in past) / len(past)
            est = False
        elif hv is not None:
            lo, hi = float(hv.min()), float(hv.max())
            ivr = min(1.0, max(0.0, (atm_iv - lo) / (hi - lo))) if hi > lo else 0.5
            ivp = float((hv < atm_iv).mean())

    ed = earnings_date(tk) if contracts else None
    return {
        "t": t, "n": r.get("n"), "sec": r.get("sec"), "px": round(S, 2), "mc": r.get("mc"),
        "de": r.get("de"), "pe": r.get("pe"), "roe": r.get("roe"), "dy": r.get("dy"),
        "iv": round(atm_iv, 4) if atm_iv else None, "hv": round(float(hv[-1]), 4) if hv is not None else None,
        "ivr": round(ivr * 100, 1) if ivr is not None else None, "ivp": round(ivp * 100, 1) if ivp is not None else None,
        "est": est, "ivn": len(ivhist.get(t, [])), "ed": ed, "c": contracts,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--tickers", default="")
    a = ap.parse_args()

    rows = json.loads((DOCS / "scan.json").read_text())["rows"]
    if a.tickers:
        want = set(a.tickers.upper().split(","))
        cands = [r for r in rows if r["t"] in want]
    else:
        cands = sorted((r for r in rows if quality(r)), key=lambda r: -(r.get("mc") or 0))
    if a.limit:
        cands = cands[:a.limit]

    hp = DOCS / "ivhist.json"
    ivhist = json.loads(hp.read_text()) if hp.exists() else {}
    today = date.today()
    rate = risk_free()
    print(f"{len(cands)} quality stocks, risk-free {rate:.2%}", flush=True)

    out, failed, t0 = [], [], time.time()
    with ThreadPoolExecutor(WORKERS) as ex:
        futs = {ex.submit(scan_one, r, rate, today, ivhist): r["t"] for r in cands}
        for i, f in enumerate(as_completed(futs), 1):
            t = futs[f]
            try:
                res = f.result()
                if res:
                    out.append(res)
            except Exception as e:
                failed.append(t)
                print(f"  {t}: {e}", file=sys.stderr)
            if i % 50 == 0:
                print(f"  {i}/{len(cands)} ({time.time() - t0:.0f}s)", flush=True)

    if len(cands) > 20 and len(out) < len(cands) * 0.5:
        sys.exit(f"Only {len(out)} of {len(cands)} stocks returned option data (throttled?); not saving.")
    if len(cands) > 20 and sum(len(s["c"]) for s in out) < len(out):
        sys.exit("Almost no quotable contracts (market closed, so bids are zero?); not saving.")

    # append today's ATM IV to the history (one reading per day, ~400 days kept)
    for s in out:
        if s["iv"]:
            h = [p for p in ivhist.get(s["t"], []) if p[0] != today.isoformat()]
            h.append([today.isoformat(), s["iv"]])
            ivhist[s["t"]] = h[-400:]
            s["ivn"] = len(ivhist[s["t"]])
    if not a.tickers and not a.limit:
        hp.write_text(json.dumps(ivhist, separators=(",", ":")))

    out.sort(key=lambda s: -(s["ivr"] or -1))
    doc = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "rate": rate,
           "scanned": len(cands), "failed": failed, "stocks": out}
    (DOCS / "options.json").write_text(json.dumps(doc, separators=(",", ":")))
    n = sum(len(s["c"]) for s in out)
    print(f"Saved {len(out)} stocks, {n} contracts in {time.time() - t0:.0f}s ({len(failed)} failed)")


if __name__ == "__main__":
    main()
