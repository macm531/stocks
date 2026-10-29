"""Forward-tracking log: does the screen actually beat just owning the S&P 500?

Once a week (per screen) it records the stocks that pass every default test, with
their price that day and SPY's price. The Track record page then compares how those
picks have done since against SPY. Unlike a backtest, nothing here can peek at the
future: each snapshot only uses what was known on its date.

Writes docs/track.json:
  snaps  [{d, page, b, n, picks: [[ticker, price], ...], spy}]
         b = "full" (passes every default test) or "zone" (passes all but at most one,
         and sits in that screen's buy zone that day); older snapshots without b are "full"
  last   {ticker: latest price} for every ticker ever picked (covers delistings)

Usage:  python track.py              add this week's snapshots (if due) + refresh prices
        python track.py --prices     only refresh the latest prices
"""
import argparse
import json
from datetime import date, datetime
from pathlib import Path

from alert import CONFIG, LOW_PCT, active, eligible, load_data, min_passes, passes, settings

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "track.json"
LIVE = ROOT / "docs" / "live.json"
EVERY_DAYS = 6  # one snapshot per screen per week


def live_quotes():
    """{ticker: [price, 52w low, 52w high]} from the latest price run."""
    try:
        return {t: q for t, q in json.loads(LIVE.read_text())["q"].items() if q and q[0]}
    except Exception:
        return {}


def in_zone(r, q, page):
    """Same buy-zone rule as the site and alert.py, using that day's price and 52-week range."""
    px, lo, hi = (q or [r.get("px"), r.get("lo52"), r.get("hi52")])[:3]
    if not px or not lo or not hi:
        return False
    z = settings(page, "zone")
    if z["mode"] == "pullback":
        return -z["pullbackMax"] / 100 <= px / hi - 1 <= -z["pullback"] / 100
    return px / lo - 1 <= LOW_PCT


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", action="store_true")
    args = ap.parse_args()

    track = json.loads(OUT.read_text()) if OUT.exists() else {"snaps": [], "last": {}}
    quotes = live_quotes()
    prices = {t: q[0] for t, q in quotes.items()}

    if not args.prices:
        data, today = load_data(), date.today()
        spy = prices.get("SPY")
        for pid, page in CONFIG["pages"].items():
            if page["kind"] not in ("stock", "etf") or not spy:
                continue
            d = data[page["data"]]
            n, need = len(active(page)), min_passes(page)
            med = d.get("medians", {})
            def due(basket):
                mine = [s for s in track["snaps"] if s["page"] == pid and s.get("b", "full") == basket]
                return not mine or (today - date.fromisoformat(mine[-1]["d"])).days >= EVERY_DAYS
            full_due = due("full")
            for basket in ("full", "zone"):
                # the buy-zone basket is recorded on the same day as the full one, so the two compare week for week
                if not (full_due if basket == "full" else full_due or due("zone") and not any(
                        s["page"] == pid and s.get("b") == "zone" for s in track["snaps"])):
                    continue
                if basket == "full":
                    keep = lambda r: passes(r, page, med) == n
                else:
                    keep = lambda r: passes(r, page, med) >= need and in_zone(r, quotes.get(r["t"]), page)
                picks = [[r["t"], prices.get(r["t"]) or r.get("px")] for r in d["rows"] if eligible(r, page) and keep(r)]
                picks = [p for p in picks if p[1]]
                track["snaps"].append({"d": today.isoformat(), "page": pid, "b": basket, "n": n, "picks": picks, "spy": spy})
                print(f"snapshot {pid}/{basket}: {len(picks)} picks, SPY {spy}")

    tickers = {p[0] for s in track["snaps"] for p in s["picks"]} | {"SPY"}
    for t in tickers:
        if prices.get(t):
            track["last"][t] = prices[t]
    track["at"] = datetime.now().isoformat(timespec="seconds")
    OUT.write_text(json.dumps(track, separators=(",", ":")))
    print(f"track: {len(track['snaps'])} snapshots, {len(tickers)} tickers priced")


if __name__ == "__main__":
    main()
