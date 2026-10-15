"""52-week range for many tickers in one batched Yahoo download."""
import math
import yfinance as yf


def price_ranges(tickers, chunk=200):
    out = {}
    for k in range(0, len(tickers), chunk):
        part = tickers[k:k + chunk]
        df = yf.download(part, period="1y", interval="1d", auto_adjust=False,
                         group_by="ticker", progress=False, threads=True)
        for t in part:
            try:
                d = df[t] if len(part) > 1 else df
                d = d.dropna(subset=["Close"])
                if d.empty:
                    continue
                lo, hi, px = float(d["Low"].min()), float(d["High"].max()), float(d["Close"].iloc[-1])
                if any(math.isnan(x) for x in (lo, hi, px)):
                    continue
                out[t] = {"lo52": round(lo, 4), "hi52": round(hi, 4), "px": round(px, 4)}
            except (KeyError, IndexError):
                continue
    return out
