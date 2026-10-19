"""Forward-tracking log: does the screen actually beat just owning the S&P 500?

Once a week (per screen) it records the stocks that pass every default test, with
their price that day and SPY's price. The Track record page then compares how those
picks have done since against SPY. Unlike a backtest, nothing here can peek at the
future: each snapshot only uses what was known on its date.

Writes docs/track.json:
  snaps  [{d, page, n, picks: [[ticker, price], ...], spy}]
  last   {ticker: latest price} for every ticker ever picked (covers delistings)

Usage:  python track.py              add this week's snapshots (if due) + refresh prices
        python track.py --prices     only refresh the latest prices
"""
import argparse
import json
from datetime import date, datetime
from pathlib import Path

from alert import CONFIG, active, eligible, load_data, passes

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "track.json"
LIVE = ROOT / "docs" / "live.json"
EVERY_DAYS = 6  # one snapshot per screen per week


def live_prices():
    try:
        return {t: q[0] for t, q in json.loads(LIVE.read_text())["q"].items() if q and q[0]}
    except Exception:
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", action="store_true")
    args = ap.parse_args()

    track = json.loads(OUT.read_text()) if OUT.exists() else {"snaps": [], "last": {}}
    prices = live_prices()

    if not args.prices:
        data, today = load_data(), date.today()
        spy = prices.get("SPY")
        for pid, page in CONFIG["pages"].items():
            if page["kind"] not in ("stock", "etf") or not spy:
                continue
            mine = [s for s in track["snaps"] if s["page"] == pid]
            if mine and (today - date.fromisoformat(mine[-1]["d"])).days < EVERY_DAYS:
                continue
            d = data[page["data"]]
            n = len(active(page))
            picks = [[r["t"], prices.get(r["t"]) or r.get("px")] for r in d["rows"]
                     if eligible(r, page) and passes(r, page, d.get("medians", {})) == n]
            picks = [p for p in picks if p[1]]
            track["snaps"].append({"d": today.isoformat(), "page": pid, "n": n, "picks": picks, "spy": spy})
            print(f"snapshot {pid}: {len(picks)} picks, SPY {spy}")

    tickers = {p[0] for s in track["snaps"] for p in s["picks"]} | {"SPY"}
    for t in tickers:
        if prices.get(t):
            track["last"][t] = prices[t]
    track["at"] = datetime.now().isoformat(timespec="seconds")
    OUT.write_text(json.dumps(track, separators=(",", ":")))
    print(f"track: {len(track['snaps'])} snapshots, {len(tickers)} tickers priced")


if __name__ == "__main__":
    main()
