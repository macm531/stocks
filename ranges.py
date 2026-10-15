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


def trend_stats(tickers, chunk=200):
    """5-year weekly trend: how steadily the price climbs.

    r2     fit of log(price) to a straight line (1.0 = perfectly steady climb)
    cagr5  annualised price return over the window
    maxdd  worst peak-to-trough drop
    spark  ~60 points (every 4th week), scaled so the first point is 100, for mini charts
    """
    import numpy as np

    out = {}
    for k in range(0, len(tickers), chunk):
        part = tickers[k:k + chunk]
        df = yf.download(part, period="5y", interval="1wk", auto_adjust=True,
                         group_by="ticker", progress=False, threads=True)
        for t in part:
            try:
                s = (df[t] if len(part) > 1 else df)["Close"].dropna()
            except KeyError:
                continue
            if len(s) < 104:  # need 2+ years for a meaningful trend
                continue
            y = np.log(s.values)
            x = np.arange(len(y))
            b, a = np.polyfit(x, y, 1)
            ss = ((y - y.mean()) ** 2).sum()
            r2 = 1 - ((y - (a + b * x)) ** 2).sum() / ss if ss > 0 else 0
            r2 = r2 if b > 0 else -r2  # a steady *decline* should not look steady-good
            years = len(s) / 52
            pts = s.values[::4].tolist() + ([float(s.values[-1])] if (len(s) - 1) % 4 else [])
            out[t] = {
                "r2": round(float(r2), 3),
                "cagr5": round(float((s.iloc[-1] / s.iloc[0]) ** (1 / years) - 1), 4),
                "maxdd": round(float((s / s.cummax() - 1).min()), 3),
                "spark": [round(100 * p / pts[0], 1) for p in pts],
            }
    return out
