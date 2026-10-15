# Value Quality Scanner

Personal stock screener: ranks the S&P 1500 on PEG, debt-to-equity, ROIC, free-cash-flow yield and P/E, and emails when a shortlisted stock nears its 52-week low.

## How it runs
- **Site**: `docs/` is published with GitHub Pages. `docs/index.html` scores and ranks in the browser; thresholds are editable on the page.
- **Pages**: Value screen (`index.html`), Buffett (`buffett.html`: ROE every year, debt-years, margin trend, FCF consistency, DCF margin of safety), Blue chips (`bluechips.html`, S&P 100 + Dow 30), ETFs (`etfs.html`). All share `app.js`/`app.css`; thresholds live in `docs/config.json`, which the alert job reads too.
- **Fundamentals**: `scan.py` → `docs/scan.json`, `etf.py` → `docs/etfs.json`. GitHub Actions runs them weekdays ~7am ET.
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

## DCF
Two-stage model in `docs/app.js` (`dcf`) and mirrored in `alert.py`: average of the last 3 years' free cash flow, grown at the company's own historical FCF growth (capped, default 15%) for 5 years, fading to terminal growth (2.5%) over years 6-10, discounted at 10%, plus net cash, divided by shares. Defaults in `docs/config.json` → `dcf`; adjustable on each stock page. History is the ~4 annual years Yahoo provides.
