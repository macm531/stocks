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

## Quality metrics (added 2026-10-19)
`scan.py` also records yearly ROIC, revenue and share counts: `roicmin` (lowest yearly ROIC), `rgc` (% of years revenue grew), `shchg` (share count change %/yr; negative = buybacks), `icov` (EBIT / interest; 999 = profitable with no interest reported). Buffett page tests them by default; Value and Blue chips have them as optional tests (`"on": false` in config).

## My stocks (`mine.html`) and sell signals
Holdings live in the viewer's browser (localStorage `macstocks-holdings`); "Copy my list" moves them between devices. Each holding is judged on a chosen screen with default settings. Warnings (`config.json` → `sell`): fails 2+ tests, price 100%+ above DCF value, 30%+ below 52-week high, down 25%+ from buy price, chart R² under 0.5. One warning = Review; two, or failing for 90+ days, = Sell signal.

## Track record (`track.html`, `track.py`)
Weekly snapshot per screen of every full match (default settings) with its price and SPY's, in `docs/track.json` on the data branch. The page compares equal-weight pick returns with SPY since each snapshot. Forward-only, so no look-ahead bias; price returns only.

## ETF holdings
`etf.py` stores each fund's top 10 holdings; the ETF page and Analyze report score them on the Value and Buffett screens (foreign listings map to US listings only when names match).

## Company reports (free data)
Clicking any stock or ETF opens the Analyze report. Besides scores it shows:
- **Company outlook**: generated from Yahoo profile data captured by `scan.py` (analyst rating/targets, expected EPS growth, revenue trend, DCF gap, next earnings date) plus the business description in `docs/co/<ticker>.json`.
- **Which way it's heading**: rule-based signals (price vs 200-day, 50 vs 200-day, 5-year trend, distance from high, analyst rating and target, EPS outlook, sales momentum). Describes momentum and expectations; not a forecast.
- **Annual meeting**: `details.py` reads SEC EDGAR (contact address in the User-Agent per SEC fair-access policy) for the latest 8-K Item 5.07 (voting results, quoted from the filing), proxy statement and 10-K, weekly, for S&P 500 + shortlists + past picks.
- **Recent headlines**: Yahoo search news, daily for the same set plus all ETFs.
`docs/co/` lives on the data branch with the other data files.

## Voice reader
Browser speech synthesis (free, no service): "Listen" in the top bar reads the page or any selected text; every report section has its own Listen button; selecting text shows "Read this". Speed is remembered per browser.

## Option income (`options.html`, `options.py`)
Finds cash-secured puts and covered calls to sell. Universe: stocks in `scan.json` with D/E under `options.deMax`, positive trailing P/E, a profit every reported year and market cap over `options.minCapB`. For each, pulls Yahoo chains in the `options.envelope` window, solves IV from the bid-ask mid (Black-Scholes, ^IRX rate, dividend yield), and stores delta, probability of profit, breakeven, spread, volume and open interest in `docs/options.json`. The page applies the user's rules live (`options.defaults`: IV Rank 50+, volume 500+, OI 1,000+, spread under 10%, 30–45 DTE, 0.20–0.30 delta, skip trades with earnings before expiry). IV Rank: each run appends 30-day ATM IV to `docs/ivhist.json`; after `options.ivr.minDays` readings it's a true IV Rank, before that an estimate against the 1-year range of 21-day realized volatility (flagged "est."). Runs once a day inside the first price run after 18:00 UTC (2pm EDT), or by hand with mode `options`; takes about a minute.
