"""Headlines and SEC filings for the companies most likely to be looked at.

Adds to docs/co/<ticker>.json:
  news   up to 6 recent headlines [{t: title, p: publisher, u: link, d: unix time}]  (daily)
  cik    SEC company id, for filing links on every page
  sec    latest annual report (10-K), proxy statement (DEF 14A) and annual-meeting
         voting results (8-K Item 5.07) with dates, links and the voting-results text
         straight from the filing (weekly)

Who gets it: S&P 500, everything on a screen's shortlist, every past Track record pick,
and all ETFs (headlines only). Other companies still get description and analyst data
from scan.py, plus a link to their SEC filings page.

SEC asks automated tools to identify themselves with a contact address (fair-access policy).
"""
import html
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import yfinance as yf

from alert import CONFIG, eligible, load_data, min_passes, passes

ROOT = Path(__file__).parent
CO = ROOT / "docs" / "co"
SEC_UA = {"User-Agent": "MacStocks personal research macm53@gmail.com", "Accept-Encoding": "gzip, deflate"}
NEWS_HOURS, SEC_DAYS = 20, 6


def load_co(t):
    f = CO / f"{t}.json"
    try:
        return json.loads(f.read_text()) if f.exists() else {}
    except Exception:
        return {}


def save_co(t, co):
    CO.mkdir(parents=True, exist_ok=True)
    (CO / f"{t}.json").write_text(json.dumps(co, separators=(",", ":")))


def age_hours(ts):
    if not ts:
        return 1e9
    return (datetime.now(timezone.utc) - datetime.fromisoformat(ts)).total_seconds() / 3600


def targets():
    """Tickers worth the extra requests, most important first."""
    data = load_data()
    scan, etfs = data["scan.json"], data["etfs.json"]
    picked = set()
    for pid, page in CONFIG["pages"].items():
        if page["kind"] not in ("stock", "etf"):
            continue
        d = data[page["data"]]
        for r in d["rows"]:
            if eligible(r, page) and passes(r, page, d.get("medians", {})) >= min_passes(page):
                picked.add(r["t"])
    try:
        track = json.loads((ROOT / "docs" / "track.json").read_text())
        picked |= {p[0] for s in track["snaps"] for p in s["picks"]}
    except Exception:
        pass
    sp500 = {r["t"] for r in scan["rows"] if r.get("idx") == "S&P 500"}
    stocks = sorted(picked & {r["t"] for r in scan["rows"]}) + sorted(sp500 - picked)
    return stocks, [r["t"] for r in etfs["rows"]], {r["t"] for r in scan["rows"]}


def news_for(t):
    items = yf.Search(t, news_count=8).news or []
    out = []
    for n in items:
        if not n.get("title") or not n.get("link"):
            continue
        out.append({"t": n["title"], "p": n.get("publisher") or "", "u": n["link"], "d": n.get("providerPublishTime")})
    return out[:6]


def cik_map():
    j = requests.get("https://www.sec.gov/files/company_tickers.json", headers=SEC_UA, timeout=30).json()
    return {v["ticker"].upper().replace(".", "-"): v["cik_str"] for v in j.values()}


def doc_url(cik, acc, doc):
    return f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}"


def text_of(url):
    raw = requests.get(url, headers=SEC_UA, timeout=30).text
    raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", raw)
    txt = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    return re.sub(r"[ \t ]+", " ", re.sub(r"\n\s*\n+", "\n", txt)).strip()


def voting_excerpt(txt):
    """The Item 5.07 section of an 8-K: what shareholders voted on and the results."""
    m = re.search(r"Item\s*5\.07[^\n]*", txt, re.I)
    if not m:
        return ""
    body = txt[m.end():]
    end = re.search(r"Item\s*\d\.\d\d|SIGNATURES?\b", body, re.I)
    body = body[:end.start()] if end else body
    return re.sub(r"\n+", "\n", body).strip()[:2500]


def sec_for(cik):
    j = requests.get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", headers=SEC_UA, timeout=30).json()
    r = j["filings"]["recent"]
    out = {}
    for form, fdate, rdate, items, acc, doc in zip(r["form"], r["filingDate"], r["reportDate"], r["items"],
                                                    r["accessionNumber"], r["primaryDocument"]):
        if form in ("10-K", "20-F") and "annual" not in out:
            out["annual"] = {"form": form, "d": fdate, "u": doc_url(cik, acc, doc)}
        elif form == "DEF 14A" and "proxy" not in out:
            out["proxy"] = {"d": fdate, "u": doc_url(cik, acc, doc)}
        elif form == "8-K" and "5.07" in (items or "") and "vote" not in out:
            out["vote"] = {"d": fdate, "meeting": rdate or fdate, "u": doc_url(cik, acc, doc)}
        if len(out) == 3:
            break
    if "vote" in out:
        try:
            time.sleep(0.15)
            out["vote"]["text"] = voting_excerpt(text_of(out["vote"]["u"]))
        except Exception:
            pass
    return out


def main(budget_min=12):
    t0 = time.time()
    stocks, etfs, all_stocks = targets()
    print(f"details: {len(stocks)} stocks, {len(etfs)} ETFs", flush=True)

    # SEC company ids for every stock, so even uncovered companies get a filings link
    try:
        ciks = cik_map()
    except Exception as e:
        ciks = {}
        print(f"SEC ticker map failed: {e}", flush=True)
    for t in all_stocks:
        if t in ciks:
            co = load_co(t)
            if co.get("cik") != ciks[t]:
                co["cik"] = ciks[t]
                save_co(t, co)

    n_news = n_sec = 0
    for t in stocks + etfs:
        if time.time() - t0 > budget_min * 60:
            print("details: time budget reached", flush=True)
            break
        co, changed = load_co(t), False
        if age_hours(co.get("news_ts")) >= NEWS_HOURS:
            try:
                co["news"], co["news_ts"] = news_for(t), datetime.now(timezone.utc).isoformat(timespec="seconds")
                changed, n_news = True, n_news + 1
            except Exception:
                pass
            time.sleep(0.3)
        if t in ciks and age_hours(co.get("sec_ts")) >= SEC_DAYS * 24:
            try:
                co["sec"], co["sec_ts"] = sec_for(ciks[t]), datetime.now(timezone.utc).isoformat(timespec="seconds")
                changed, n_sec = True, n_sec + 1
            except Exception:
                pass
            time.sleep(0.15)  # SEC fair access: under 10 requests a second
        if changed:
            save_co(t, co)
    print(f"details: {n_news} headline sets, {n_sec} SEC records, {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
