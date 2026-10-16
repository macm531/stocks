"""ETF scan: fetches fund data for a curated list of major US-listed equity ETFs.

Writes docs/etfs.json. Metrics (raw; the page applies thresholds):
  er    net expense ratio, %          aum   total assets, $
  pe    trailing P/E of holdings      r5    5-year average annual return
  r3    3-year average annual return  yld   distribution yield
  beta  3-year beta                   lo52/hi52/px  52-week range and last close
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

from ranges import price_ranges, trend_stats

OUT = Path(__file__).parent / "docs" / "etfs.json"

ETFS = {
    "Broad market": "SPY IVV VOO VTI ITOT SCHB SCHX VV IWB SPLG RSP QQQ QQQM DIA IWM IJH IJR MDY VB VO VXF",
    "Value & dividend": "VTV IWD SCHD VYM DVY SDY NOBL DGRO VIG HDV SPYD SPHD VLUE RPV IVE SPYV IUSV MGV SCHV VBR VOE IWN IWS COWZ CALF AVUV AVLV DFSV FNDX FNDA PRF DGRW VFLO",
    "Quality & low vol": "QUAL SPHQ USMV SPLV QUS JEPI JEPQ",
    "Growth & momentum": "MTUM IWF VUG SCHG RPG IVW SPYG IUSG MGK",
    "Sector": "XLK XLF XLE XLV XLI XLY XLP XLU XLB XLRE XLC VGT VFH VDE VHT VIS VCR VDC VPU VAW VNQ VOX SMH SOXX IGV IBB XBI KRE KBE ITB XHB XOP OIH GDX XME",
    "International": "VEA VWO IEFA IEMG EFA EEM VXUS IXUS SCHF ACWI VT EFV IDV VYMI DLS FNDF AVDV EWJ EWZ INDA FXI MCHI EWG EWU EWC EWT EWY",
    "Thematic": "ARKK ICLN TAN LIT BOTZ CIBR HACK PAVE",
}


def num(x):
    try:
        x = float(x)
        return None if x != x else x
    except (TypeError, ValueError):
        return None


def fetch(sym, group, tries=3):
    for attempt in range(tries):
        try:
            i = yf.Ticker(sym).info or {}
            if i.get("quoteType") != "ETF":
                return None
            return {
                "t": sym, "n": i.get("longName") or i.get("shortName") or sym, "grp": group,
                "cat": i.get("category") or "", "fam": i.get("fundFamily") or "",
                "er": num(i.get("netExpenseRatio") or i.get("annualReportExpenseRatio")),
                "aum": num(i.get("totalAssets")), "pe": num(i.get("trailingPE")),
                "r5": num(i.get("fiveYearAverageReturn")), "r3": num(i.get("threeYearAverageReturn")),
                "yld": num(i.get("yield")), "beta": num(i.get("beta3Year")),
                "ytd": num(i.get("ytdReturn")),
            }
        except Exception:
            time.sleep(2 * (attempt + 1))
    return None


def main():
    pairs = [(s, g) for g, syms in ETFS.items() for s in syms.split()]
    with ThreadPoolExecutor(3) as ex:
        got = {p[0]: r for p, r in zip(pairs, ex.map(lambda p: fetch(*p), pairs)) if r}
    # Yahoo throttles bursts; retry the misses slowly, then fall back to the last saved data.
    for rnd in range(1, 3):
        miss = [p for p in pairs if p[0] not in got]
        if not miss:
            break
        time.sleep(20 * rnd)
        for p in miss:
            r = fetch(*p)
            if r:
                got[p[0]] = r
            time.sleep(0.5)
    old = {}
    if OUT.exists():
        try:
            old = {r["t"]: r for r in json.loads(OUT.read_text())["rows"]}
        except Exception:
            pass
    kept = [t for t, _ in pairs if t not in got and t in old]
    rows = list(got.values()) + [old[t] for t in kept]
    if kept:
        print(f"kept last saved data for {len(kept)} ETFs Yahoo didn't return", flush=True)
    rng = price_ranges([r["t"] for r in rows])
    tr = trend_stats([r["t"] for r in rows])
    for r in rows:
        r.update({k: v for k, v in rng.get(r["t"], {}).items()})
        r.update(tr.get(r["t"], {}))
    rows.sort(key=lambda r: r["t"])
    OUT.write_text(json.dumps({
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe": len(pairs), "scanned": len(rows), "rows": rows,
    }, separators=(",", ":")))
    print(f"etfs: {len(rows)}/{len(pairs)} -> {OUT}")


if __name__ == "__main__":
    main()
