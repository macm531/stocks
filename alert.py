"""52-week-low alerts for the scanner's shortlist.

Watchlist = names passing 4+ of the 5 tests on any site page (thresholds from docs/config.json).
Pulls fresh daily bars, and when a stock trades within LOW_PCT of its 52-week
low, emails ALERT_TO and posts a Mac notification. Each ticker alerts at most
once per day (state in alerts_state.json).

Email uses Gmail SMTP with an app password kept in the macOS Keychain:
  security add-generic-password -s stock-scanner-gmail -a macm53@gmail.com -w
(paste the 16-character app password when prompted)

Usage:  .venv/bin/python alert.py [--force] [--dry] [--test-email]
  --force       ignore market hours and the once-per-day limit
  --dry         print what would be sent, send nothing
  --test-email   send one test email and exit
  --prices-only  refresh docs/live.json, no alerts
"""
import argparse
import json
import os
import smtplib
import subprocess
import sys
from datetime import datetime
from email.message import EmailMessage
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

from ranges import price_ranges

ROOT = Path(__file__).parent
SCAN = ROOT / "docs" / "scan.json"
LIVE = ROOT / "docs" / "live.json"
STATE = ROOT / "alerts_state.json"
LOG = ROOT / "alerts.log"

ALERT_TO = "macm53@gmail.com"
SMTP_USER = "macm53@gmail.com"
KEYCHAIN_SERVICE = "stock-scanner-gmail"
PAGE_URL = os.environ.get("SITE_URL", "https://macm531.github.io/stocks/")

CONFIG = json.loads((ROOT / "docs" / "config.json").read_text())  # same thresholds as the site
LOW_PCT = CONFIG["lowPct"] / 100
MIN_PASSES = CONFIG["minPasses"]
EXCLUDE_SECTORS = {"Financial Services", "Real Estate"}
ET = ZoneInfo("America/New_York")

# Raw value -> threshold units, and which values count as invalid (always fail). Mirrors META in docs/app.js.
UNIT = {"roic": 100, "fcfy": 100, "r5": 100, "yld": 100, "aum": 1e-9}
VALID = {"peg": lambda v: v > 0, "pe": lambda v: v > 0, "de": lambda v: v >= 0}


def log(msg):
    line = f"{datetime.now(ET):%Y-%m-%d %H:%M} ET  {msg}"
    print(line)
    with LOG.open("a") as f:
        f.write(line + "\n")


def passes(r, page, medians):
    n = 0
    for t in page["tests"]:
        v = r.get(t["k"])
        if v is None or not VALID.get(t["k"], lambda _: True)(v):
            continue
        x = v * UNIT.get(t["k"], 1)
        ok = x < t["t"] if t["dir"] == "lt" else x > t["t"]
        if ok and t["k"] == "pe" and page.get("sectorPE"):
            med = medians.get(r.get("sec"), medians.get("_market"))
            ok = med is None or v < med
        n += ok
    return n


def watchlist():
    """Every shortlisted name across the site's pages, tagged with the page it qualifies on."""
    data, out = {}, {}
    for pid, page in CONFIG["pages"].items():
        d = data.setdefault(page["data"], json.loads((ROOT / "docs" / page["data"]).read_text()))
        for r in d["rows"]:
            if page["universe"] == "bc" and not r.get("bc"):
                continue
            if page["kind"] == "stock" and (
                    (page.get("excludeFin") and r["sec"] in EXCLUDE_SECTORS)
                    or (r.get("mc") or 0) < page.get("minCapB", 0) * 1e9):
                continue
            n = passes(r, page, d.get("medians", {}))
            if n >= MIN_PASSES and r["t"] not in out:
                out[r["t"]] = {**r, "passes": n, "page": page["nav"], "kind": page["kind"], "url_file": page["file"]}
    return list(out.values())


def market_open(now):
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return 9 * 60 + 30 <= minutes <= 16 * 60 + 5


def keychain_password():
    if os.environ.get("GMAIL_APP_PASSWORD"):  # GitHub Actions secret
        return os.environ["GMAIL_APP_PASSWORD"].replace(" ", "")
    if sys.platform != "darwin":
        return None
    try:
        return subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", SMTP_USER, "-w"],
            capture_output=True, text=True, check=True).stdout.strip()
    except subprocess.CalledProcessError:
        return None


def send_email(subject, text, html):
    pw = keychain_password()
    if not pw:
        raise RuntimeError(f"no Gmail app password in Keychain (service '{KEYCHAIN_SERVICE}')")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = SMTP_USER, ALERT_TO, subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
        s.login(SMTP_USER, pw)
        s.send_message(msg)


def notify(title, body):
    if sys.platform != "darwin":
        return
    script = f'display notification {json.dumps(body)} with title {json.dumps(title)} sound name "Glass"'
    subprocess.run(["osascript", "-e", script], capture_output=True)


def pct(x):
    return "—" if x is None else f"{x * 100:.1f}%"


def metrics_line(h):
    if h["kind"] == "etf":
        er = "—" if h.get("er") is None else f"{h['er']:.2f}%"
        return f"Fee {er} · P/E {h.get('pe') or 0:.1f} · 5-yr {pct(h.get('r5'))} · Yield {pct(h.get('yld'))}"
    return (f"PEG {h.get('peg') or 0:.2f} · D/E {h.get('de') or 0:.2f} · ROIC {pct(h.get('roic'))} · "
            f"FCF {pct(h.get('fcfy'))} · P/E {h.get('pe') or 0:.1f}")


def build_email(hits):
    lines, rows = [], []
    for h in hits:
        lines.append(f"[{h['page']}] {h['t']} {h['n']}: ${h['px']:.2f}, {h['from_low'] * 100:.1f}% above 52-wk low "
                     f"${h['lo52']:.2f} | {h['passes']}/5 tests | {metrics_line(h)}")
        rows.append(
            f"<tr><td><b><a href='https://finance.yahoo.com/quote/{escape(h['t'])}'>{escape(h['t'])}</a></b><br>"
            f"<span style='color:#5d6b7a'>{escape(h['n'])}</span></td>"
            f"<td><a href='{PAGE_URL}{h['url_file']}'>{escape(h['page'])}</a></td>"
            f"<td>${h['px']:.2f}</td><td>${h['lo52']:.2f}</td><td><b>+{h['from_low'] * 100:.1f}%</b></td>"
            f"<td>{h['passes']}/5</td><td style='color:#5d6b7a'>{escape(metrics_line(h))}</td></tr>")
    subject = "52-week low alert: " + ", ".join(h["t"] for h in hits)
    text = "Shortlisted names near their 52-week low:\n\n" + "\n".join(lines) + f"\n\nOpen the site: {PAGE_URL}\n"
    th = "".join(f"<th align='left' style='padding:6px 10px;border-bottom:1px solid #dde3ea'>{c}</th>" for c in
                 ["Name", "Page", "Price", "52w low", "Above low", "Tests", "Metrics"])
    html = (f"<div style='font-family:-apple-system,Segoe UI,sans-serif;color:#15202b'>"
            f"<h2 style='margin:0 0 6px'>Buy-zone alert</h2>"
            f"<p style='margin:0 0 14px;color:#5d6b7a'>These pass {MIN_PASSES}+ of the 5 tests on their page and trade within "
            f"{LOW_PCT * 100:.0f}% of their 52-week low.</p>"
            f"<table cellspacing='0' style='border-collapse:collapse;font-size:14px'><tr>{th}</tr>"
            + "".join(rows).replace("<td>", "<td style='padding:6px 10px;border-bottom:1px solid #eef1f4'>")
            + f"</table><p><a href='{PAGE_URL}'>Open the site</a></p>"
            f"<p style='color:#93a2b2;font-size:12px'>Fundamentals from the latest scan; prices from Yahoo Finance. Not investment advice.</p></div>")
    return subject, text, html


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--test-email", action="store_true")
    ap.add_argument("--prices-only", action="store_true")
    args = ap.parse_args()

    if args.test_email:
        send_email("Stock scanner: test email", "Email alerts are working.",
                   f"<p>Email alerts are working. <a href='{PAGE_URL}'>Open the scanner</a></p>")
        log("test email sent")
        return

    now = datetime.now(ET)
    if not args.force and not market_open(now):
        return

    # Fresh prices + 52-week ranges for the whole universe; the site reads live.json.
    all_t = [r["t"] for f in ("scan.json", "etfs.json") for r in json.loads((ROOT / "docs" / f).read_text())["rows"]]
    rng = price_ranges(all_t)
    LIVE.write_text(json.dumps({
        "at": datetime.now(ET).isoformat(timespec="seconds"),
        "q": {t: [g["px"], g["lo52"], g["hi52"]] for t, g in rng.items()},
    }, separators=(",", ":")))
    if args.prices_only:
        log(f"prices updated for {len(rng)} tickers")
        return

    wl = watchlist()
    today = now.date().isoformat()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}

    hits = []
    for r in wl:
        g = rng.get(r["t"])
        if not g or not g["lo52"]:
            continue
        from_low = g["px"] / g["lo52"] - 1
        if from_low <= LOW_PCT and (args.force or state.get(r["t"]) != today):
            hits.append({**r, **g, "from_low": from_low})
    hits.sort(key=lambda h: h["from_low"])
    log(f"checked {len(wl)} shortlisted, {len(hits)} new in buy zone")
    if not hits:
        return

    subject, text, html = build_email(hits)
    if args.dry:
        print(subject + "\n" + text)
        return
    notify("52-week low alert", ", ".join(f"{h['t']} +{h['from_low'] * 100:.1f}%" for h in hits))
    try:
        send_email(subject, text, html)
        log(f"emailed {ALERT_TO}: {subject}")
    except Exception as e:  # leave state alone so the next run retries the email
        log(f"EMAIL FAILED: {e}")
        notify("Stock alert email failed", str(e)[:120])
        return
    for h in hits:
        state[h["t"]] = today
    STATE.write_text(json.dumps(state, indent=1))


if __name__ == "__main__":
    main()
