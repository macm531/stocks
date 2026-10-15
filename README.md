# Value Quality Scanner

Personal stock screener: ranks the S&P 1500 on PEG, debt-to-equity, ROIC, free-cash-flow yield and P/E, and emails when a shortlisted stock nears its 52-week low.

## How it runs
- **Site**: `docs/` is published with GitHub Pages. `docs/index.html` scores and ranks in the browser; thresholds are editable on the page.
- **Fundamentals**: `scan.py` → `docs/scan.json`. GitHub Actions runs it weekdays ~7am ET.
- **Prices + alerts**: `alert.py` → `docs/live.json`, every 30 min in market hours. Stocks passing 4+ tests and within 5% of their 52-week low get emailed to macm53@gmail.com, once per stock per day.
- Workflow: `.github/workflows/update.yml`. Run it by hand from the repo's Actions tab ("Update site" → Run workflow).

## Email
Repo secret `GMAIL_APP_PASSWORD` = a Gmail app password (myaccount.google.com/apppasswords).

## Local use
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scan.py          # ~17 min
.venv/bin/python alert.py --force --dry
```
