"""52-week range for many tickers in one batched Yahoo download."""
import math
import yfinance as yf


def _frame(df, t):
    """One ticker's columns from a yf.download result, whatever its layout."""
    cols = getattr(df.columns, "levels", None)
    if cols is not None and t in df.columns.get_level_values(0):
        return df[t]
    return df


def price_ranges(tickers, chunk=200):
    out = {}
    for k in range(0, len(tickers), chunk):
        part = tickers[k:k + chunk]
        df = yf.download(part, period="1y", interval="1d", auto_adjust=False,
                         group_by="ticker", progress=False, threads=True)
        for t in part:
            try:
                d = _frame(df, t)
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
    """Long-run price behaviour from up to 10 years of weekly closes (dividend-adjusted).

    r2      steadiness: fit of log(price) to a straight line over the last 5 years
            (1.0 = perfectly steady climb; negative when the line slopes down)
    cagr5   average yearly gain over the last 5 years
    cagr10  average yearly gain over 10 years (only when 10 years of history exist)
    cagrL   average yearly gain over the longest history up to 10 years (min 5)
    yrsL    years that cagrL covers
    maxdd   worst peak-to-trough drop over the last 5 years
    spark   ~60 points over the last 5 years, first point = 100, for mini charts
    """
    import numpy as np

    out = {}
    for k in range(0, len(tickers), chunk):
        part = tickers[k:k + chunk]
        df = yf.download(part, period="10y", interval="1wk", auto_adjust=True,
                         group_by="ticker", progress=False, threads=True)
        for t in part:
            try:
                full = _frame(df, t)["Close"].dropna()
            except KeyError:
                continue
            full = full[full > 0]  # bad ticks (zero prices) would break the log fit and ratios
            if len(full) < 104:  # need 2+ years for a meaningful trend
                continue
            try:
                out[t] = _trend_row(full)
            except Exception:  # one malformed history never sinks the batch
                continue
    return out


def _trend_row(full):
    """One ticker's trend stats from its (positive) weekly closes."""
    import numpy as np

    s5 = full.iloc[-261:]
    y = np.log(s5.values)
    x = np.arange(len(y))
    b, a = np.polyfit(x, y, 1)
    ss = ((y - y.mean()) ** 2).sum()
    r2 = 1 - ((y - (a + b * x)) ** 2).sum() / ss if ss > 0 else 0
    r2 = r2 if b > 0 else -r2  # a steady *decline* should not look steady-good
    cagr = lambda s: float((s.iloc[-1] / s.iloc[0]) ** (52 / (len(s) - 1)) - 1)
    yrs_full = (len(full) - 1) / 52
    pts = s5.values[::4].tolist() + ([float(s5.values[-1])] if (len(s5) - 1) % 4 else [])
    return {
        "r2": round(float(r2), 3),
        "cagr5": round(cagr(s5), 4),
        "cagr10": round(cagr(full), 4) if yrs_full >= 9.5 else None,
        "cagrL": round(cagr(full), 4) if yrs_full >= 4.5 else None,
        "yrsL": round(yrs_full, 1),
        "maxdd": round(float((s5 / s5.cummax() - 1).min()), 3),
        "spark": [round(100 * p / pts[0], 1) for p in pts],
    }
