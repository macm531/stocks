"""Scan universe: every common stock listed on NYSE and Nasdaq, plus S&P 1500 membership tags.

Sources (all public):
  nasdaqtrader.com symbol directory  -> Nasdaq- and NYSE-listed securities
  Wikipedia                          -> S&P 500 / 400 / 600 membership

Falls back to the last saved list (universe.json) if a source is unreachable, so a
flaky download never shrinks the scan.

Russell 2000 membership is not downloadable for free, so scan.py approximates it the
way FTSE Russell builds it: US companies ranked 1,001-3,000 by market cap.
"""
import io
import json
import re
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).parent
CACHE = ROOT / "universe.json"
UA = {"User-Agent": "Mozilla/5.0 (stock-scanner personal use)"}

SP_INDEXES = {
    "S&P 500": "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
    "S&P 400": "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies",
    "S&P 600": "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies",
}
NASDAQ_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
OTHER_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"

# Not operating companies' common stock: funds, SPACs, preferreds, debt, warrants, units, rights.
EXCLUDE = re.compile(
    r"warrant|\bunits?\b|\bright(s)?\b|preferred|depositary shares? (each )?represent|\bnotes?\b|debenture|"
    r"%|\bfund\b|\btrust\b.*\b(income|municipal|bond)\b|acquisition corp|\bspac\b|closed[- ]end|"
    r"\betn\b|exchange[- ]traded|\bbaby bond", re.I)


def sp_members():
    out = {}
    for name, url in SP_INDEXES.items():
        html = requests.get(url, headers=UA, timeout=30).text
        for table in pd.read_html(io.StringIO(html)):
            cols = [str(c) for c in table.columns]
            col = next((c for c in cols if c.lower() in ("symbol", "ticker symbol", "ticker")), None)
            if col:
                for sym in table[col].astype(str):
                    out.setdefault(sym.strip().replace(".", "-"), name)
                break
    if len(out) < 1400:
        raise RuntimeError(f"S&P lists look incomplete ({len(out)})")
    return out


def listed():
    """{ticker: exchange} for Nasdaq and NYSE common stocks."""
    out = {}
    nas = pd.read_csv(io.StringIO(requests.get(NASDAQ_URL, headers=UA, timeout=30).text), sep="|", dtype=str)
    nas = nas[(nas["ETF"] == "N") & (nas["Test Issue"] == "N")]
    for sym, name in zip(nas["Symbol"], nas["Security Name"]):
        if isinstance(sym, str) and sym.isalpha() and not EXCLUDE.search(str(name)):
            out[sym] = "Nasdaq"
    oth = pd.read_csv(io.StringIO(requests.get(OTHER_URL, headers=UA, timeout=30).text), sep="|", dtype=str)
    oth = oth[(oth["ETF"] == "N") & (oth["Test Issue"] == "N") & (oth["Exchange"] == "N")]
    for sym, name in zip(oth["ACT Symbol"], oth["Security Name"]):
        if not isinstance(sym, str) or "$" in sym or EXCLUDE.search(str(name)):
            continue
        # class shares: BRK.B -> BRK-B (Yahoo style); skip when-issued and other suffix oddities
        if re.fullmatch(r"[A-Z]+(\.[A-Z])?", sym):
            out[sym.replace(".", "-")] = "NYSE"
    if len(out) < 3000:
        raise RuntimeError(f"exchange lists look incomplete ({len(out)})")
    return out


def build():
    """{ticker: {"exch": ..., "idx": S&P index or ""}}, cached to universe.json."""
    try:
        sp, ex = sp_members(), listed()
        uni = {}
        for t, e in ex.items():
            uni[t] = {"exch": e, "idx": sp.get(t, "")}
        for t, idx in sp.items():  # S&P members always included, even if a symbol file missed them
            uni.setdefault(t, {"exch": "", "idx": idx})["idx"] = idx
        CACHE.write_text(json.dumps(uni, separators=(",", ":"), sort_keys=True))
        return uni
    except Exception as e:
        if CACHE.exists():
            print(f"universe sources failed ({e}); using cached list", flush=True)
            return json.loads(CACHE.read_text())
        raise


if __name__ == "__main__":
    u = build()
    from collections import Counter
    print(len(u), Counter(v["exch"] for v in u.values()), Counter(v["idx"] for v in u.values()))
