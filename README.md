# MacStocks

Personal stock screener: ranks every NYSE and Nasdaq stock (5,000+) on PEG, debt-to-equity, ROIC, free-cash-flow yield and P/E, and emails when a shortlisted stock nears its 52-week low.

## How it runs
- **Site**: `docs/` is published with GitHub Pages. `docs/index.html` scores and ranks in the browser; thresholds are editable on the page.
- **Pages**: Value screen (`index.html`), Buffett (`buffett.html`: ROE every year, debt-years, margin trend, FCF consistency, DCF margin of safety), Blue chips (`bluechips.html`, S&P 100 + Dow 30), ETFs (`etfs.html`). All share `app.js`/`app.css`; thresholds live in `docs/config.json`, which the alert job reads too.
- **Universe**: `universe.py` builds the list from the nasdaqtrader.com symbol directory (Nasdaq + NYSE common stocks) with S&P 500/400/600 tags from Wikipedia; cached in `universe.json`. Russell 2000 is approximated in `scan.py` as US companies ranked 1,001-3,000 by market cap.
- **Fundamentals**: `scan.py` is incremental: each run refreshes the stalest tickers within `--budget` minutes (S&P 1500 first, daily), merges into `docs/scan.json`, then batch-refreshes 52-week ranges and 5-year trends for all. `etf.py` → `docs/etfs.json`. GitHub Actions runs two passes a day.
- **Data branch**: data files are not on `main`; the workflow loads them from the `data` branch and force-pushes a single fresh commit there each run, so history doesn't grow.
- **Prices + alerts**: `alert.py` → `docs/live.json`, every 15 min in market hours. Stocks passing 4+ tests and within 5% of their 52-week low get emailed to macm53@gmail.com, once per stock per day.
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

## Chart shape + buy zone
`ranges.trend_stats` fits log(weekly close) over 5 years: `r2` (steadiness, negative when falling), `cagr5`, `maxdd`, `spark` (mini chart). `config.json` → `trend` filters every page to steady uptrends (default R² ≥ 0.75, ≥ 10%/yr); `zone` picks the buy zone: `pullback` (10–30% below the 52-week high, default) or `low` (within `lowPct` of the 52-week low). Alerts use the same settings.
