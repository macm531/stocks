// Shared screener engine. Each page sets window.PAGE_ID; settings come from config.json.
(() => {
  const $ = id => document.getElementById(id);
  const clamp = x => Math.max(0, Math.min(1, x));
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const FIN = new Set(["Financial Services", "Real Estate"]);
  const fx = (v, d = 2) => v == null ? "—" : v.toFixed(d);
  const pct = (v, d = 1) => v == null ? "—" : (v * 100).toFixed(d) + "%";
  const money = v => v == null ? "—" : v >= 1e12 ? "$" + (v / 1e12).toFixed(2) + "T" : v >= 1e9 ? "$" + (v / 1e9).toFixed(1) + "B" : "$" + (v / 1e6).toFixed(0) + "M";

  // How each metric is shown and compared. `unit(v)` converts the raw value into threshold units.
  const META = {
    peg: { label: "PEG", title: "PEG ratio below", sfx: "×", step: 0.1, unit: v => v, valid: v => v > 0, show: r => fx(r.peg),
      hint: "P/E divided by expected earnings growth. Under 1 means you are not overpaying for growth.",
      bad: r => r.peg <= 0 ? "Negative PEG (earnings shrinking)." : null },
    de: { label: "D/E", title: "Debt-to-equity below", sfx: "×", step: 0.1, unit: v => v, valid: v => v >= 0, show: r => r.de == null ? "—" : r.de < 0 ? "neg. eq." : r.de.toFixed(2),
      hint: "Total debt over shareholders' equity. Negative equity always fails.",
      bad: r => r.de < 0 ? "Negative shareholders' equity." : null },
    roic: { label: "ROIC", title: "ROIC above", sfx: "%", step: 1, unit: v => v * 100, show: r => pct(r.roic, 0),
      hint: "After-tax operating profit over debt + equity − cash. Shows how well capital is used." },
    fcfy: { label: "FCF", title: "FCF yield above", sfx: "%", step: 0.5, unit: v => v * 100, show: r => pct(r.fcfy, 1),
      hint: "Trailing free cash flow over market cap. Confirms earnings are backed by cash." },
    pe: { label: "P/E", title: "P/E below", sfx: "×", step: 1, unit: v => v, valid: v => v > 0, show: r => fx(r.pe, 1),
      hint: "Price over trailing earnings. Sets the value baseline.", bad: r => r.pe <= 0 ? "Negative earnings." : null },
    er: { label: "Fee", title: "Expense ratio below", sfx: "%", step: 0.05, unit: v => v, show: r => r.er == null ? "—" : r.er.toFixed(2) + "%",
      hint: "What the fund charges each year. Every 0.1% compounds against you." },
    aum: { label: "AUM", title: "Assets above", sfx: "$B", step: 0.5, unit: v => v / 1e9, show: r => money(r.aum),
      hint: "Fund size. Large funds trade with tight spreads and rarely close." },
    r5: { label: "5-yr", title: "5-year return above", sfx: "%/yr", step: 1, unit: v => v * 100, show: r => pct(r.r5, 1),
      hint: "Average annual total return over five years." },
    yld: { label: "Yield", title: "Yield above", sfx: "%", step: 0.25, unit: v => v * 100, show: r => pct(r.yld, 2),
      hint: "Trailing distribution yield." },
    roemin: { label: "ROE", title: "ROE every year above", sfx: "%", step: 1, unit: v => v * 100, show: r => pct(r.roemin, 0),
      hint: "Lowest annual return on equity in the record. Buffett wants 15%+ consistently, not one good year." },
    dny: { label: "Debt yrs", title: "Debt paid off within", sfx: "yrs", step: 0.5, unit: v => v, show: r => r.dny == null ? "—" : r.dny.toFixed(1) + "y",
      hint: "Total debt divided by annual net income: years of earnings needed to clear all debt. Losses fail.",
      bad: r => r.dny == null && r.roemin != null ? "No profit to pay debt from." : null },
    mgr: { label: "Margin", title: "Net margin change above", sfx: "pts", step: 0.5, unit: v => v, range: [-2, 3],
      show: r => r.mgr == null ? "—" : (r.mgr >= 0 ? "+" : "") + r.mgr.toFixed(1) + "pt",
      hint: "Latest net margin minus the average of earlier years. Rising margins signal pricing power." },
    fcfc: { label: "FCF+", title: "Years with positive FCF at least", sfx: "%", step: 25, unit: v => v, range: [50, 100],
      show: r => r.fcfc == null ? "—" : Math.round(r.fcfc) + "%",
      hint: "Share of years the business produced positive free cash flow. 100% means every year." },
    mos: { label: "Safety", title: "Margin of safety above", sfx: "%", step: 5, unit: v => v * 100, range: [0, 50],
      show: r => r.mos == null ? "—" : pct(r.mos, 0),
      hint: "How far the price sits below the DCF intrinsic value. Buffett wants 20–30%+ as a buffer.",
      bad: r => r.iv != null && r.iv <= 0 ? "DCF value is negative (debt exceeds cash-flow value)." : r.fcf0 != null && r.fcf0 <= 0 ? "Negative average free cash flow; DCF not meaningful." : null },
    roicmin: { label: "ROIC min", title: "ROIC every year above", sfx: "%", step: 1, unit: v => v * 100, show: r => pct(r.roicmin, 0),
      hint: "Lowest yearly return on invested capital in the record. Consistently high ROIC is the clearest sign of a moat." },
    icov: { label: "Int. cover", title: "Interest coverage above", sfx: "×", step: 1, unit: v => v, range: [1, 15],
      show: r => r.icov == null ? "—" : r.icov >= 999 ? "no debt" : r.icov.toFixed(1) + "×",
      hint: "Operating profit divided by interest owed. Under 3× means a bad year could make the debt hard to carry." },
    shchg: { label: "Shares", title: "Share count change below", sfx: "%/yr", step: 0.5, unit: v => v, range: [3, -3],
      show: r => r.shchg == null ? "—" : (r.shchg > 0 ? "+" : "") + r.shchg.toFixed(1) + "%",
      hint: "Yearly change in shares outstanding. Negative means buybacks grow your slice; positive means you're being diluted." },
    rgc: { label: "Rev. up", title: "Revenue grew in at least", sfx: "% of years", step: 10, unit: v => v, range: [33, 100],
      show: r => r.rgc == null ? "—" : Math.round(r.rgc) + "%",
      hint: "Share of years revenue was higher than the year before. Steady growers rarely go backwards." },
  };

  // Average yearly gain (dividends included) for the chosen period.
  const RET_PERIODS = { long: "over 10 years (5 if newer)", y10: "over 10 years only", y5: "over 5 years", both: "over both 5 and 10 years" };
  function retFor(r, period = S.period) {
    if (period === "y5") return r.cagr5;
    if (period === "y10") return r.cagr10;
    if (period === "both") return r.cagr5 == null || r.cagrL == null ? null : Math.min(r.cagr5, r.cagr10 ?? r.cagrL);
    return r.cagrL ?? r.cagr5;
  }
  const retYears = r => S.period === "y5" ? 5 : S.period === "y10" ? 10 : S.period === "both" ? "5 & 10" : (r.cagr10 != null ? 10 : r.yrsL ? Math.floor(r.yrsL) : 5);
  const beats = r => { const v = retFor(r); return v != null && v * 100 >= S.retMin; };

  // 5-year mini chart (weekly closes, every 4th week). Green when the trend is steady and rising.
  function spark(r, w = 96, h = 26) {
    const p = r.spark;
    if (!p || p.length < 2) return `<span class="spark-na">—</span>`;
    const lo = Math.min(...p), hi = Math.max(...p), span = hi - lo || 1;
    const pts = p.map((v, i) => `${(i / (p.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - (v - lo) / span * (h - 4)).toFixed(1)}`).join(" ");
    const good = steady(r) && beats(r);
    return `<svg class="spark ${good ? "up" : "flat"}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="5-year price chart"><polyline points="${pts}" fill="none" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  const trendTxt = r => {
    if (r.r2 == null) return "No 5-year history";
    const v = retFor(r);
    return `R² ${r.r2.toFixed(2)} · ${v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(0) + "%/yr"} (${retYears(r)}y)`;
  };

  // Two-stage DCF on average free cash flow. Growth = historical FCF growth, capped; fades to terminal over years 6–10.
  function dcf(r) {
    const d = S.disc / 100, tg = S.term / 100, cap = S.gcap / 100;
    if (!r.fcf0 || r.fcf0 <= 0 || !r.sh || d <= tg) return null;
    let g = r.fcfg != null ? r.fcfg : (r.eg > 0 ? r.eg : 0.03);
    g = Math.max(0, Math.min(cap, g));
    let f = r.fcf0, pv = 0;
    for (let y = 1; y <= 10; y++) {
      const gy = y <= 5 ? g : g + (tg - g) * (y - 5) / 5;
      f *= 1 + gy;
      pv += f / Math.pow(1 + d, y);
    }
    const tv = f * (1 + tg) / (d - tg) / Math.pow(1 + d, 10);
    const iv = (pv + tv + (r.netcash || 0)) / r.sh;
    return { iv, g, mos: iv > 0 && r.px ? 1 - r.px / iv : null };
  }

  let CFG, P, PID = window.PAGE_ID, DATA = null, ranked = [], S = {}, DEF = {};
  let sortK = null, sortDir = -1, shown = 60, open = new Set(), baseCount = 0, steadyCount = 0, beatsCount = 0, nearOpen = false, nearFilter = null;
  const KEY = () => "vqs-settings-" + PID;
  // Tests the viewer has switched on; everything that counts passes uses these.
  const on = t => !(S.off && S.off[t.k]);
  const AT = () => P.tests.filter(on);
  const NT = () => AT().length;
  const zmin = () => Math.max(1, NT() - 1);  // shortlist = every test you have on but one
  const isStock = () => P.kind === "stock";

  // ---------- layout ----------
  function topbar() {
    const nav = Object.entries(CFG.pages).map(([id, p]) =>
      `<a class="tab" href="${p.file}"${id === PID ? ' aria-current="page"' : ""}>${esc(p.nav)}</a>`).join("");
    return `  <nav class="topnav" aria-label="Pages"><a class="brand" href="index.html" aria-label="MacStocks home"><img src="logo.svg" alt="" width="30" height="30">MacStocks</a>${nav}
    <form class="lookup" id="lookup" role="search" autocomplete="off">
      <input id="lk" list="lk-list" placeholder="Analyze a ticker" aria-label="Ticker to analyze" spellcheck="false" autocapitalize="characters">
      <button type="submit">Analyze</button>
      <button type="button" class="listen listen-top" id="listen-page" data-listen title="Read this page aloud (or select text first)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg><span>Listen</span></button>
      <datalist id="lk-list"></datalist>
    </form>
  </nav>
  <dialog id="an" aria-labelledby="an-title"><div class="an-inner" id="an-body"></div></dialog>`;
  }

  function shell() {
    document.title = `${P.title} · MacStocks`;
    const crit = P.tests.map(t => { const m = META[t.k]; return `
      <div class="crit" id="crit-${t.k}">
        <div class="crit-top"><label class="sw"><input type="checkbox" id="on-${t.k}" aria-label="Use ${m.title}"><i></i><span>${m.title}</span></label><span class="cnt" id="c-${t.k}"></span></div>
        <div class="field"><input id="t-${t.k}" type="number" step="${m.step}" min="0"><span>${m.sfx}</span></div>
        ${t.k === "pe" && isStock() ? `<label class="opt"><input id="o-sector" type="checkbox"> Also below its sector's median P/E</label>` : ""}
        <small>${m.hint}</small>
      </div>`; }).join("");
    const stockOpts = isStock() ? `
      <label class="opt"><input id="o-fin" type="checkbox"> Exclude financials and real estate <span style="color:var(--muted)">(D/E and ROIC don't apply to banks and REITs)</span></label>
      <div class="crit"><label for="o-mcap">Minimum market cap</label>
        <div class="field"><input id="o-mcap" type="number" step="0.5" min="0"><span>$ billion</span></div></div>
      <hr>
      <div class="eyebrow">DCF assumptions</div>
      <div class="crit"><label for="o-disc">Discount rate</label>
        <div class="field"><input id="o-disc" type="number" step="0.5" min="1"><span>% a year (your required return)</span></div></div>
      <div class="crit"><label for="o-term">Terminal growth</label>
        <div class="field"><input id="o-term" type="number" step="0.5" min="0"><span>% a year after year 10</span></div></div>
      <div class="crit"><label for="o-gcap">Growth cap</label>
        <div class="field"><input id="o-gcap" type="number" step="1" min="0"><span>% a year, years 1–5</span></div>
        <small>Each company grows at its own past free-cash-flow growth, limited to this cap, then fades to the terminal rate.</small></div>` : "";
    const metricTh = P.tests.map(t => `<th data-k="${t.k}" class="r">${META[t.k].label}</th>`).join("");
    const extraTh = isStock()
      ? `${P.tests.some(t => t.k === "mos") ? "" : `<th data-k="mos" class="r">Safety</th>`}<th data-k="iv" class="r">DCF value</th><th data-k="mc" class="r">Mkt cap</th>`
      : `<th data-k="r3" class="r">3-yr</th><th data-k="beta" class="r">Beta</th>`;
    document.getElementById("app").innerHTML = `
${topbar()}
  <header>
    <div>
      <div class="eyebrow">${esc(P.eyebrow)}</div>
      <h1>${esc(P.title)}</h1>
      <p>${esc(P.intro)}</p>
    </div>
    <div class="runbox">
      <div class="stamp" id="stamp">Loading latest scan…</div>
      <button class="ghost" id="toggle-settings" type="button" aria-controls="rail"></button>
      <button class="run" id="run" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>
        Run scan
      </button>
    </div>
  </header>
  <div class="desk" id="desk">
    <aside class="rail" id="rail" aria-label="Screening settings">
      ${isStock() && P.universe !== "bc" ? `<div class="crit"><label for="o-uni" class="eyebrow">Stocks to include</label>
        <select id="o-uni" class="zsel">${Object.entries(CFG.universes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></div><hr>` : ""}
      <div class="eyebrow">Chart shape</div>
      <label class="sw"><input id="o-trend" type="checkbox"><i></i><span><b>Only steady uptrends</b><br><span style="color:var(--muted);font-weight:400">5-year charts that climb up and to the right</span></span></label>
      <div class="crit" id="crit-trend">
        <div class="crit-top"><label for="o-r2">Trend steadiness at least</label><span class="cnt" id="c-trend"></span></div>
        <div class="field"><input id="o-r2" type="number" step="0.05" min="0" max="1"><span>R² (0–1)</span></div>
        <small>How closely the 5-year price follows a straight rising line on a log scale. NVDA and CAT score about 0.88; a choppy sideways chart scores under 0.5.</small>
      </div>
      <div class="crit" id="crit-ret">
        <div class="crit-top"><label class="sw"><input type="checkbox" id="o-ret"><i></i><span>Beats the market</span></label><span class="cnt" id="c-ret"></span></div>
        <div class="field"><span>Average gain of at least</span><input id="o-retmin" type="number" step="1"><span>% a year</span></div>
        <select id="o-period" class="zsel" aria-label="Period for average yearly gain">${Object.entries(RET_PERIODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <small>Average yearly total return, dividends included. The stock market has averaged about 10% a year, so 10% means keeping pace with it or better.</small>
      </div>
      <hr>
      <div class="eyebrow">Criteria</div>
      ${crit}
      <hr>
      ${stockOpts}
      <div class="crit" id="crit-zone">
        <div class="crit-top"><label class="sw"><input type="checkbox" id="o-zone" aria-label="Use buy zone"><i></i><span>Buy zone</span></label><span class="cnt" id="c-low"></span></div>
        <select id="o-zmode" class="zsel"><option value="pullback">Pullback from 52-week high</option><option value="low">Near 52-week low</option></select>
        <div class="field" id="zone-pull"><input id="o-pull" type="number" step="1" min="0"><span>to</span><input id="o-pullmax" type="number" step="5" min="0"><span>% below the high</span></div>
        <div class="field" id="zone-low"><input id="o-low" type="number" step="1" min="0"><span>% or less above the low</span></div>
        <small>Picks passing every test you have on but one, that are in this zone, show in the buy zone. Email alerts always use the default settings.</small>
      </div>
      <button class="reset" id="reset" type="button">Reset to defaults</button>
    </aside>
    <main style="min-width:0">
      <div class="summary" id="summary"></div>
      <section class="near" id="near-block" hidden>
        <div class="bhead"><div><h2 id="near-title">Near misses</h2><p>Each stock passes every test you have on except one. The red tag shows which one, and by how much. Click a stock for its full breakdown.</p></div>
          <button type="button" class="reset" id="near-close">Close</button></div>
        <div class="fchips" id="near-filters"></div>
        <div class="nlist" id="near-list"></div>
      </section>
      <div class="funnel"><h2>Screening funnel</h2><div id="funnel"></div></div>
      <section class="block" id="zone-block">
        <div class="bhead"><div><h2>Buy zone</h2><p id="zone-desc">Passing all but at most one test and in the buy zone you set on the left. These trigger email alerts.</p></div></div>
        <div class="picks" id="zone"></div>
      </section>
      <section class="block" id="picks-block">
        <div class="bhead"><div><h2>Top picks</h2><p id="picks-desc"></p></div></div>
        <div class="picks" id="picks"></div>
      </section>
      <section class="block" id="table-block">
        <div class="bhead">
          <div><h2>Full ranking</h2><p>Sorted by tests passed, then composite score. Click a row for the breakdown.</p></div>
          <div class="tools">
            <input id="q" type="search" placeholder="Search ticker or name" aria-label="Search ticker or name">
            <select id="minp" aria-label="Minimum tests passed">
              <option value="0">All</option><option value="3">3+ tests passed</option>
              <option value="4">4+ tests passed</option><option value="5">All 5 passed</option>
            </select>
            <select id="sec" aria-label="Group"></select>
          </div>
        </div>
        <div class="tablebox"><table>
          <thead><tr><th>#</th><th data-k="t">${isStock() ? "Stock" : "Fund"}</th><th data-k="grp">${isStock() ? "Sector" : "Category"}</th>
            <th data-k="passes" class="r">Tests</th><th data-k="score" class="r">Score</th>${metricTh}
            <th data-k="r2">5-yr chart</th><th data-k="fromLow" class="r">Above 52w low</th>${extraTh}</tr></thead>
          <tbody id="tb"></tbody>
        </table></div>
        <div class="more"><button class="reset" id="more" type="button" hidden>Show more</button></div>
      </section>
      <div class="notes">
        <div><h3>How the score works</h3><p>Each test scores 0–1 by how far it clears the threshold: a "below" test earns full marks at half the limit and zero at 1.5×; an "above" test earns zero at a third of the bar and full marks at 1.67×. The composite is the average × 100. Ranking is by tests passed first.</p></div>
        <div><h3>Where the numbers come from</h3><p>Fund and company data from Yahoo Finance, refreshed every weekday morning. Prices and 52-week ranges refresh every 30 minutes while the market is open.${isStock() ? " ROIC and D/E come from the latest annual statements." : " ETF P/E is the weighted P/E of the fund's holdings."}</p></div>
        <div><h3>Before you buy</h3><p>A screen finds candidates, not answers. Outlier values are flagged "check data". This is a research tool, not personalized investment advice.</p></div>
      </div>
    </main>
  </div>`;
  }

  // ---------- settings ----------
  function defaults() {
    const d = { off: Object.fromEntries((P.tests || []).filter(t => t.on === false).map(t => [t.k, true])), zoneOn: true, showSettings: true, low: CFG.lowPct, trendOn: CFG.trend.on, r2: CFG.trend.r2, retOn: CFG.returns.on, retMin: CFG.returns.min, period: CFG.returns.period, zmode: CFG.zone.mode, pull: CFG.zone.pullback, pullMax: CFG.zone.pullbackMax };
    for (const t of P.tests) d[t.k] = t.t;
    if (isStock()) Object.assign(d, { uni: P.universe === "bc" ? "all" : P.universe, sector: !!P.sectorPE, fin: !!P.excludeFin, mcap: P.minCapB || 0, ...CFG.dcf });
    return d;
  }
  function syncInputs() {
    for (const t of P.tests) {
      $("t-" + t.k).value = S[t.k];
      $("on-" + t.k).checked = on(t);
      $("t-" + t.k).disabled = !on(t);
      $("crit-" + t.k).classList.toggle("off", !on(t));
    }
    $("o-zone").checked = S.zoneOn;
    $("crit-zone").classList.toggle("off", !S.zoneOn);
    $("crit-trend").classList.toggle("off", !S.trendOn);
    $("o-r2").disabled = !S.trendOn;
    $("crit-ret").classList.toggle("off", !S.retOn);
    $("o-retmin").disabled = $("o-period").disabled = !S.retOn;
    $("o-ret").checked = S.retOn; $("o-retmin").value = S.retMin; $("o-period").value = S.period;
    $("desk").classList.toggle("nosettings", !S.showSettings);
    $("toggle-settings").textContent = S.showSettings ? "Hide settings" : "Show settings";
    $("toggle-settings").setAttribute("aria-expanded", S.showSettings);
    $("o-low").value = S.low; $("o-pull").value = S.pull; $("o-pullmax").value = S.pullMax; $("o-zmode").value = S.zmode;
    $("o-trend").checked = S.trendOn; $("o-r2").value = S.r2;
    $("zone-low").hidden = S.zmode !== "low"; $("zone-pull").hidden = S.zmode !== "pullback";
    if (isStock()) {
      if ($("o-sector")) $("o-sector").checked = S.sector;
      $("o-fin").checked = S.fin; $("o-mcap").value = S.mcap;
      if ($("o-uni")) $("o-uni").value = S.uni;
      $("o-disc").value = S.disc; $("o-term").value = S.term; $("o-gcap").value = S.gcap;
    }
  }
  // Screening changes last only while the page is open; every visit starts from the defaults.
  // Only the show/hide-settings preference is remembered.
  function save() { try { localStorage.setItem(KEY(), JSON.stringify({ showSettings: S.showSettings })); } catch (e) {} }

  // ---------- scoring ----------
  function evaluate(r) {
    const ev = {};
    if (isStock()) { const v = dcf(r); r = { ...r, iv: v ? v.iv : null, dcfg: v ? v.g : null, mos: v ? v.mos : null }; }
    for (const t of P.tests) {
      const m = META[t.k], v = r[t.k], T = S[t.k];
      if (v == null) { ev[t.k] = { pass: false, s: 0, na: true }; continue; }
      if (m.valid && !m.valid(v)) { ev[t.k] = { pass: false, s: 0 }; continue; }
      const x = m.unit(v);
      let pass = t.dir === "lt" ? x < T : t.dir === "ge" ? x >= T : x > T;
      const s = m.range ? clamp((x - m.range[0]) / (m.range[1] - m.range[0]))
        : t.dir === "lt" ? (x <= 0.5 * T ? 1 : clamp((1.5 * T - x) / T)) : clamp((x - T / 3) / (T * 1.67 - T / 3));
      const e = { pass, s };
      if (t.k === "pe" && isStock()) {
        e.secMed = DATA.medians[r.sec] ?? DATA.medians._market;
        e.underSec = !S.sector || e.secMed == null || v < e.secMed;
        e.pass = pass && e.underSec;
      }
      ev[t.k] = e;
    }
    const act = AT();
    const passes = act.filter(t => ev[t.k].pass).length;
    const score = act.length ? Math.round(act.reduce((a, t) => a + ev[t.k].s, 0) / act.length * 100) : 0;
    const warn = [];
    if (r.peg != null && r.peg > 0 && r.peg < 0.2) warn.push("PEG");
    if (r.fcfy != null && r.fcfy > 0.25) warn.push("FCF");
    if (r.roic != null && r.roic > 0.8) warn.push("ROIC");
    if (!isStock() && r.pe != null && r.pe > 80) warn.push("P/E");
    const fromLow = r.lo52 && r.px ? r.px / r.lo52 - 1 : null;
    const fromHigh = r.hi52 && r.px ? r.px / r.hi52 - 1 : null;
    return { ...r, grp: isStock() ? r.sec : (r.cat || r.grp), ev, passes, score, warn, fromLow,
      up: r.tgt && r.px ? r.tgt / r.px - 1 : null,
      rangePos: r.lo52 && r.hi52 && r.hi52 > r.lo52 && r.px ? clamp((r.px - r.lo52) / (r.hi52 - r.lo52)) : null,
      fromHigh,
      nearLow: !S.zoneOn ? false : S.zmode === "low" ? fromLow != null && fromLow <= S.low / 100 : fromHigh != null && fromHigh <= -S.pull / 100 && fromHigh >= -S.pullMax / 100 };
  }

  const steady = r => r.r2 != null && r.r2 >= S.r2;
  const UNI_TEST = {
    all: () => true, sp1500: r => !!r.idx, sp500: r => r.idx === "S&P 500", r2k: r => !!r.r2k,
    nyse: r => r.exch === "NYSE", nasdaq: r => r.exch === "Nasdaq",
  };
  const uniLabel = () => P.universe === "bc" ? "S&P 100 + Dow 30" : CFG.universes[S.uni] || "All";
  function inUniverse(r, ignoreTrend) {
    if (S.trendOn && !ignoreTrend && !steady(r)) return false;
    if (S.retOn && !ignoreTrend && !beats(r)) return false;
    if (P.universe === "bc" && !r.bc) return false;
    if (isStock() && P.universe !== "bc" && !(UNI_TEST[S.uni] || UNI_TEST.all)(r)) return false;
    if (isStock() && S.fin && FIN.has(r.sec)) return false;
    if (isStock() && (r.mc || 0) < S.mcap * 1e9) return false;
    return true;
  }

  function rankAll() {
    const base = DATA.rows.filter(r => inUniverse(r, true));
    baseCount = base.length;
    steadyCount = base.filter(steady).length;
    beatsCount = base.filter(r => (!S.trendOn || steady(r)) && beats(r)).length;
    ranked = DATA.rows.filter(r => inUniverse(r)).map(evaluate).sort((a, b) => b.passes - a.passes || b.score - a.score);
    ranked.forEach((r, i) => r.rank = i + 1);
    const prevPass = new Set();
    if (DATA.prev) {
      const byT = new Map(DATA.rows.map(x => [x.t, x]));
      for (const [t, m] of Object.entries(DATA.prev.rows)) {
        const cur = byT.get(t);
        // older scans may lack newer fields; only override what the previous scan actually had
        const old = Object.fromEntries(Object.entries(m).filter(([, v]) => v != null));
        if (cur && inUniverse(cur) && evaluate({ ...cur, ...old }).passes === NT()) prevPass.add(t);
      }
    }
    ranked.forEach(r => r.isNew = !!DATA.prev && NT() > 0 && r.passes === NT() && !prevPass.has(r.t));
  }

  // ---------- render ----------
  const cls = e => e.na ? "na" : e.pass ? "ok" : "bad";
  const priceTag = r => r.px == null ? "" : `<span class="px">$${r.px >= 1000 ? r.px.toFixed(0) : r.px.toFixed(2)}</span>`;
  const chipMuted = txt => `<span class="chip" style="background:var(--track);color:var(--muted)">${txt}</span>`;

  function renderSummary() {
    const N = NT(), all5 = ranked.filter(r => r.passes === N).length, four = ranked.filter(r => r.passes === N - 1).length;
    const zone = ranked.filter(r => r.passes >= zmin() && r.nearLow).length;
    $("summary").innerHTML = `
      <button type="button" class="stat${all5 ? " hot" : ""}" data-go="picks-block"><div class="eyebrow">Pass all ${N}</div><div class="v">${all5}</div><div class="s">full matches · view</div></button>
      <button type="button" class="stat${nearOpen ? " active" : ""}" data-go="near" aria-expanded="${nearOpen}" aria-controls="near-block"><div class="eyebrow">Pass ${N - 1} of ${N}</div><div class="v">${four}</div><div class="s">near misses · ${nearOpen ? "hide" : "see what each missed"}</div></button>
      <button type="button" class="stat${zone ? " hot" : ""}" data-go="zone-block"><div class="eyebrow">In buy zone</div><div class="v">${zone}</div><div class="s">${S.zmode === "low" ? "near 52-week low" : "pulled back from high"} · view</div></button>
      <button type="button" class="stat" data-go="table-block"><div class="eyebrow">Screened</div><div class="v">${ranked.length.toLocaleString()}</div><div class="s">${isStock() ? esc(uniLabel()) + (P.universe === "bc" ? "" : ` · ${DATA.scanned.toLocaleString()} stocks over $50M`) : "equity ETFs"}</div></button>`;
  }

  const missDetail = (r, t) => t.k === "mos" && r.mos != null && r.mos < 0
    ? `price is ${pct(-r.mos, 0)} above DCF value $${fx(r.iv)}, ${needTxt(t).replace("over", "at least")} below`
    : t.k === "mos" && r.mos != null ? `price is ${pct(r.mos, 0)} below DCF value $${fx(r.iv)}, ${needTxt(t)}`
    : `${META[t.k].show(r)}, ${needTxt(t)}`;

  // Stocks one test short of a full match, with the test they missed.
  function renderNear() {
    const blk = $("near-block");
    blk.hidden = !nearOpen;
    if (!nearOpen) return;
    const N = NT();
    const rows = ranked.filter(r => N > 1 && r.passes === N - 1).map(r => ({ r, miss: AT().find(t => !r.ev[t.k].pass) }));
    const counts = {};
    rows.forEach(x => counts[x.miss.k] = (counts[x.miss.k] || 0) + 1);
    if (nearFilter && !counts[nearFilter]) nearFilter = null;
    $("near-title").textContent = `Near misses: passing ${N - 1} of ${N}`;
    $("near-filters").innerHTML = `<button type="button" class="fchip${nearFilter ? "" : " on"}" data-miss="">All ${rows.length}</button>` +
      AT().filter(t => counts[t.k]).sort((a, b) => counts[b.k] - counts[a.k]).map(t =>
        `<button type="button" class="fchip${nearFilter === t.k ? " on" : ""}" data-miss="${t.k}">Missed ${esc(testName(t))} · ${counts[t.k]}</button>`).join("");
    const list = rows.filter(x => !nearFilter || x.miss.k === nearFilter);
    $("near-list").innerHTML = !list.length ? `<div class="empty">No near misses with these settings.</div>` : list.map(({ r, miss }) => `
      <button type="button" class="nrow" data-t="${esc(r.t)}">
        <span class="nname"><span class="tk">${esc(r.t)}</span> ${priceTag(r)} <span class="nm">${esc(r.n)}</span></span>
        <span class="nspark">${spark(r, 84, 24)}</span>
        <span class="nmiss"><span class="chip miss">Missed: ${esc(testName(miss))}</span>
          <span class="ntxt">${esc(META[miss.k].bad && META[miss.k].bad(r) ? META[miss.k].bad(r) : r.ev[miss.k].na ? "No data for this test" : missDetail(r, miss))}</span></span>
        <span class="nscore">${r.score}<small>score</small></span>
        <span class="nzone">${r.nearLow ? `<span class="chip new">In buy zone</span>` : ""}</span>
      </button>`).join("");
  }

  function renderFunnel() {
    let set = ranked, max = baseCount || 1, html = "";
    const row = (name, n) => `<div class="frow"><span>${name}</span><div class="ftrack"><div class="fbar" style="width:${Math.max(n ? 0.6 : 0, n / max * 100)}%"></div></div><span class="num">${n}</span></div>`;
    const uniName = isStock() ? "Universe" : "All funds";
    if (S.trendOn || S.retOn) html += row(uniName, baseCount);
    if (S.trendOn && S.retOn) html += row("Steady uptrend", steadyCount);
    $("c-trend").textContent = S.trendOn ? steadyCount + " steady" : "off";
    $("c-ret").textContent = S.retOn ? beatsCount + " beat it" : "off";
    const first = S.retOn ? `${S.trendOn ? "+ " : ""}Beats ${S.retMin}%/yr` : S.trendOn ? "Steady uptrend" : uniName;
    const steps = [[first, () => true], ...AT().map((t, i) => [(i ? "+ " : "") + META[t.k].title.replace(/ (below|above)$/, ""), r => r.ev[t.k].pass])];
    for (const [name, f] of steps) {
      set = set.filter(f);
      html += row(name, set.length);
    }
    $("funnel").innerHTML = html;
    for (const t of P.tests) $("c-" + t.k).textContent = on(t) ? ranked.filter(r => r.ev[t.k].pass).length + " pass" : "off";
    $("c-low").textContent = ranked.filter(r => r.nearLow).length + " near";
  }

  const mgrid = r => `<div class="mgrid">${P.tests.map(t => `<div class="m ${on(t) ? cls(r.ev[t.k]) : "na off"}"><b>${META[t.k].label}</b><span>${META[t.k].show(r)}</span></div>`).join("")}</div>`;
  function chips(r) {
    let h = "";
    if (r.isNew) h += `<span class="chip new">New</span>`;
    if (r.nearLow) h += `<span class="chip new">${S.zmode === "low" ? "Near 52-wk low" : "Pulled back " + Math.round(-r.fromHigh * 100) + "%"}</span>`;
    if (r.mos != null && r.mos >= 0.25 && !P.tests.some(t => t.k === "mos")) h += `<span class="chip">${pct(r.mos, 0)} below DCF value</span>`;
    if (r.warn.length) h += `<span class="chip warn">Check data: ${r.warn.join(", ")}</span>`;
    return h;
  }
  const sub = r => isStock() ? `${esc(r.n)} · ${esc(r.sec)}` : `${esc(r.n)}`;
  const extraChip = r => isStock()
    ? chipMuted(`${money(r.mc)}${r.up != null ? " · target " + (r.up >= 0 ? "+" : "") + (r.up * 100).toFixed(0) + "%" : ""}`)
    : chipMuted(`${esc(r.cat || r.grp)} · 3-yr ${pct(r.r3, 1)}`);

  function renderPicks() {
    const N = NT();
    $("picks-desc").textContent = N ? `Passing all ${N} tests you have on, best composite score first.` : "Every test is off. Switch at least one on in the settings.";
    if (!N) { $("picks").innerHTML = ""; return; }
    const top = ranked.filter(r => r.passes === N).slice(0, 9);
    const pool = top.length ? top : ranked.filter(r => r.passes === N - 1).slice(0, 6);
    if (!pool.length) { $("picks").innerHTML = `<div class="empty">Nothing passes four or more tests at these thresholds. Loosen a criterion on the left.</div>`; return; }
    const note = top.length ? "" : `<div class="empty" style="grid-column:1/-1">Nothing passes all ${N} tests right now. Showing the best near misses (${N - 1} of ${N}).</div>`;
    $("picks").innerHTML = note + pool.map(r => `
      <button class="pick" type="button" data-t="${esc(r.t)}">
        <div class="pick-top"><div><div class="tick">${esc(r.t)} ${priceTag(r)}</div><div class="pname">${sub(r)}</div></div>
          <div class="score">${r.score}<small>score</small></div></div>
        ${mgrid(r)}
        <div class="sparkrow">${spark(r, 220, 40)}<span>${trendTxt(r)}</span></div>
        <div class="chips">${chips(r)}${extraChip(r)}</div>
      </button>`).join("");
  }

  function renderZone() {
    const pb = S.zmode === "pullback";
    if (!S.zoneOn) { $("zone").innerHTML = `<div class="empty">The buy zone is off. Switch it on in the settings.</div>`; return; }
    const z = ranked.filter(r => r.passes >= zmin() && r.nearLow).sort((a, b) => pb ? b.score - a.score : a.fromLow - b.fromLow);
    if (!z.length) { $("zone").innerHTML = `<div class="empty">Nothing passing ${zmin()}+ tests is ${pb ? `${S.pull}–${S.pullMax}% below its 52-week high` : `within ${S.low}% of its 52-week low`} right now.</div>`; return; }
    $("zone").innerHTML = z.map(r => `
      <button class="pick" type="button" data-t="${esc(r.t)}">
        <div class="pick-top"><div><div class="tick">${esc(r.t)} ${priceTag(r)}</div><div class="pname">${sub(r)} · ${r.passes}/${NT()} tests</div></div>
          <div class="score">${pb ? (r.fromHigh * 100).toFixed(1) + "%<small>from high</small>" : "+" + (r.fromLow * 100).toFixed(1) + "%<small>above low</small>"}</div></div>
        <div class="sparkrow">${spark(r, 220, 40)}<span>${trendTxt(r)}</span></div>
        <div class="range"><span class="mono">$${fx(r.lo52)}</span><div class="rtrack"><i style="left:${(r.rangePos ?? 0) * 100}%"></i></div><span class="mono">$${fx(r.hi52)}</span></div>
        <div class="chips">${chipMuted(`Price $${fx(r.px)} · score ${r.score}`)}${r.warn.length ? `<span class="chip warn">Check data</span>` : ""}</div>
      </button>`).join("");
  }

  const unitTxt = (t, v) => `${v}${["×", "%"].includes(META[t.k].sfx) ? META[t.k].sfx : " " + META[t.k].sfx}`;
  const testName = t => META[t.k].title.replace(/ (below|above|at least|within)$/, "");
  function testTxt(r, t) {
    const m = META[t.k], e = r.ev[t.k];
    if (e.na) return "No data.";
    if (m.bad && m.bad(r)) return m.bad(r);
    let txt = `${m.show(r)} vs ${t.dir === "lt" ? "limit" : "bar"} ${unitTxt(t, S[t.k])}.`;
    if (t.k === "pe" && isStock()) txt += ` Sector median ${fx(e.secMed, 1)}×${S.sector && !e.underSec ? " (above it)" : ""}.`;
    if (t.k === "peg" && r.pegs === "calc") txt += " Calculated from trailing growth.";
    return txt;
  }
  const needTxt = t => `needs ${t.dir === "lt" ? "under" : t.dir === "ge" ? "at least" : "over"} ${unitTxt(t, S[t.k])}`;

  function why(r) {
    const lines = P.tests.map(t => {
      const m = META[t.k], e = r.ev[t.k], txt = testTxt(r, t);
      if (!on(t)) return `<div class="na off"><b>Off · ${m.title.replace(/ (below|above)$/, "")}</b>${m.show(r)} (not counted)</div>`;
      return `<div class="${cls(e)}"><b>${e.na ? "No data" : e.pass ? "Pass" : "Fail"} · ${m.title.replace(/ (below|above)$/, "")}</b>${txt}</div>`;
    }).join("");
    const extra = isStock()
      ? `<span>${esc(r.ind)}</span><span>Price $${fx(r.px)}</span><span>Fwd P/E ${fx(r.fpe, 1)}</span>
         <span>Earnings growth ${pct(r.eg, 0)}</span><span>Revenue growth ${pct(r.rg, 0)}</span><span>ROE ${pct(r.roe, 0)}</span>
         <span>Div. yield ${r.dy == null ? "—" : r.dy.toFixed(2) + "%"}</span><span>${esc([r.exch, r.idx, r.r2k ? "Russell 2000 (approx.)" : ""].filter(Boolean).join(" · "))}</span>`
      + `<span>Analyst target ${r.up == null ? "—" : (r.up >= 0 ? "+" : "") + (r.up * 100).toFixed(0) + "%"}</span>`
      : `<span>${esc(r.fam)}</span><span>${esc(r.grp)}</span><span>Price $${fx(r.px)}</span><span>3-yr ${pct(r.r3, 1)}/yr</span>
         <span>YTD ${r.ytd == null ? "—" : r.ytd.toFixed(1) + "%"}</span><span>Beta ${fx(r.beta)}</span>`;
    const dcfTxt = !isStock() ? "" : r.iv == null || r.iv <= 0
      ? `<p class="dcf">${META.mos.bad(r) || "DCF not available (missing free cash flow or share count)."}</p>`
      : `<p class="dcf"><b>DCF intrinsic value $${fx(r.iv)}</b> a share vs price $${fx(r.px)}: ${r.mos >= 0 ? pct(r.mos, 0) + " margin of safety" : pct(-r.mos, 0) + " above value"}.
         Built from ${money(r.fcf0)} average free cash flow, growing ${pct(r.dcfg, 1)} a year for 5 years then fading to ${S.term}%, discounted at ${S.disc}%, plus ${r.netcash >= 0 ? "net cash" : "net debt of"} ${money(Math.abs(r.netcash))}.</p>`;
    const hist = !isStock() || !r.h || !r.h.y.length ? "" : `<div class="hist"><table><thead><tr><th>Year</th>${r.h.y.map(y => `<th class="r">${y}</th>`).join("")}</tr></thead><tbody>
      <tr><td>ROE</td>${r.h.roe.map(v => `<td class="n${v != null && v >= 0.15 ? " ok" : ""}">${pct(v, 0)}</td>`).join("")}</tr>
      ${r.h.roic ? `<tr><td>ROIC</td>${r.h.roic.map(v => `<td class="n${v != null && v >= 0.12 ? " ok" : ""}">${pct(v, 0)}</td>`).join("")}</tr>` : ""}
      <tr><td>Net margin</td>${r.h.nm.map(v => `<td class="n">${pct(v, 1)}</td>`).join("")}</tr>
      ${r.h.rev ? `<tr><td>Revenue</td>${r.h.rev.map(v => `<td class="n">${money(v)}</td>`).join("")}</tr>` : ""}
      ${r.h.sh ? `<tr><td>Shares</td>${r.h.sh.map(v => `<td class="n">${v == null ? "—" : (v / 1e6).toFixed(0) + "M"}</td>`).join("")}</tr>` : ""}
      <tr><td>Free cash flow</td>${r.h.fcf.map(v => `<td class="n${v != null && v < 0 ? " bad" : ""}">${money(v)}</td>`).join("")}</tr>
      </tbody></table></div>`;
    const trendLine = `<p class="dcf"><b>5-year chart:</b> ${r.r2 == null ? "not enough price history." : `steadiness R² ${r.r2.toFixed(2)} (${steady(r) ? "passes" : "below"} your ${S.r2} bar), ${(r.cagr5 * 100).toFixed(1)}% a year over 5 years${r.cagr10 != null ? `, ${(r.cagr10 * 100).toFixed(1)}% over 10` : ""} (${beats(r) ? "beats" : "below"} your ${S.retMin}% bar), worst drop along the way ${(r.maxdd * 100).toFixed(0)}%. Now ${(r.fromHigh * 100).toFixed(1)}% from its 52-week high.`}</p>`;
    const etfHold = isStock() ? "" : `<h4 class="hold-h">Top 10 holdings on your stock screens</h4><div class="etf-hold" data-etf="${esc(r.t)}"><p class="muted">Scoring holdings…</p></div>`;
    return `<p class="why-actions"><button type="button" class="reset" data-analyze="${esc(r.t)}">Open full report: outlook, annual meeting, headlines</button></p><div class="why">${lines}</div>${trendLine}${dcfTxt}${hist}${etfHold}
      <div class="extra">${extra}<span>52-wk range $${fx(r.lo52)}–$${fx(r.hi52)}</span>
        <a href="https://finance.yahoo.com/quote/${encodeURIComponent(r.t)}" target="_blank" rel="noopener">Yahoo Finance ↗</a></div>`;
  }

  function renderTable() {
    const q = $("q").value.trim().toLowerCase(), minp = +$("minp").value, g = $("sec").value;
    let rows = ranked.filter(r => r.passes >= minp && (!g || r.grp === g) && (!q || r.t.toLowerCase().includes(q) || (r.n || "").toLowerCase().includes(q)));
    if (sortK) rows = rows.slice().sort((a, b) => {
      const x = a[sortK], y = b[sortK];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir;
    });
    document.querySelectorAll("th[data-k]").forEach(th => th.classList.toggle("sorted", th.dataset.k === sortK));
    const ncol = 8 + P.tests.length + (isStock() ? (P.tests.some(t => t.k === "mos") ? 2 : 3) : 2);
    const extraTd = r => isStock()
      ? `${P.tests.some(t => t.k === "mos") ? "" : `<td class="n${r.mos >= 0.25 ? " ok" : ""}">${META.mos.show(r)}</td>`}<td class="n">${r.iv == null ? "—" : "$" + fx(r.iv)}</td><td class="n">${money(r.mc)}</td>`
      : `<td class="n">${pct(r.r3, 1)}</td><td class="n">${fx(r.beta)}</td>`;
    $("tb").innerHTML = rows.slice(0, shown).map(r => `<tr class="main" data-t="${esc(r.t)}" tabindex="0">
        <td class="n">${r.rank}</td>
        <td><span class="tk">${esc(r.t)}</span> ${priceTag(r)} <span class="nm">${esc(r.n)}</span> ${r.isNew ? '<span class="chip new">New</span>' : ""}${r.warn.length ? ' <span class="chip warn">check</span>' : ""}</td>
        <td>${esc(r.grp)}</td>
        <td class="n"><span class="dots">${AT().map(t => `<i class="${r.ev[t.k].pass ? "on" : ""}"></i>`).join("")}</span></td>
        <td class="n">${r.score}<span class="bar"><i style="width:${r.score}%"></i></span></td>
        ${P.tests.map(t => `<td class="n ${on(t) ? cls(r.ev[t.k]) : "na"}">${META[t.k].show(r)}</td>`).join("")}
        <td class="trendcell">${spark(r)}<small>${trendTxt(r)}</small></td>
        <td class="n${r.nearLow ? " ok" : ""}">${r.fromLow == null ? "—" : "+" + (r.fromLow * 100).toFixed(1) + "%"}${r.rangePos == null ? "" : `<span class="bar" title="Position in 52-week range"><i style="width:${Math.max(3, r.rangePos * 100)}%"></i></span>`}</td>
        ${extraTd(r)}</tr>` + (open.has(r.t) ? `<tr class="detail"><td colspan="${ncol}">${why(r)}</td></tr>` : "")).join("")
      || `<tr><td colspan="${ncol}" style="text-align:center;color:var(--muted);padding:24px">Nothing matches these filters.</td></tr>`;
    $("more").hidden = rows.length <= shown;
    $("more").textContent = `Show more (${rows.length - shown} left)`;
    if (!isStock()) fillHoldings();
  }

  function minpOptions() {
    const N = NT(), cur = $("minp").value;
    const opts = [["0", "All"]];
    for (let k = Math.max(1, N - 2); k < N; k++) opts.push([String(k), `${k}+ tests passed`]);
    if (N) opts.push([String(N), `All ${N} passed`]);
    $("minp").innerHTML = opts.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
  }
  function renderAll() { minpOptions(); rankAll(); renderSummary(); renderNear(); renderFunnel(); renderZone(); renderPicks(); renderTable(); }

  function stamp() {
    const fmt = x => new Date(x).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const ageH = (Date.now() - new Date(DATA.at)) / 36e5;
    const age = ageH < 1 ? "under an hour ago" : ageH < 48 ? Math.round(ageH) + " hours ago" : Math.round(ageH / 24) + " days ago";
    $("stamp").innerHTML = `Fundamentals <b>${fmt(DATA.at)}</b> (${age})<br>` + (DATA.live ? `Prices <b>${fmt(DATA.live)}</b> · ` : "") + `${DATA.scanned.toLocaleString()} ${isStock() ? "stocks" : "funds"}`;
  }

  async function getJSON(name, fresh) {
    const res = await fetch(name + (fresh ? "?t=" + Date.now() : ""), { cache: fresh ? "no-store" : "default" });
    if (!res.ok) throw new Error(name + ": HTTP " + res.status);
    return res.json();
  }

  async function load(fresh) {
    const btn = $("run"); btn.classList.add("spin"); btn.disabled = true;
    try {
      DATA = await getJSON(P.data, fresh);
      DATA.live = null;
      try {
        const L = await getJSON("live.json", fresh);
        for (const r of DATA.rows) { const q = L.q[r.t]; if (q) { r.px = q[0]; r.lo52 = q[1]; r.hi52 = q[2]; } }
        DATA.live = L.at;
      } catch (e) {}
      const groups = [...new Set(DATA.rows.filter(r => inUniverse(r, true)).map(r => isStock() ? r.sec : (r.cat || r.grp)))].sort();
      const cur = $("sec").value;
      $("sec").innerHTML = `<option value="">${isStock() ? "All sectors" : "All categories"}</option>` + groups.map(s => `<option${s === cur ? " selected" : ""}>${esc(s)}</option>`).join("");
      stamp(); renderAll();
    } catch (e) {
      $("stamp").textContent = "Could not load scan data.";
      document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="err">The scan data did not load (${esc(e.message)}). Reload the page; if it persists, the scanner needs to be re-run.</div>`);
    } finally {
      setTimeout(() => { btn.classList.remove("spin"); btn.disabled = false; }, 350);
    }
  }

  function wire() {
    const num = (id, k) => $(id).addEventListener("input", e => { const v = parseFloat(e.target.value); if (isNaN(v)) return; S[k] = v; save(); if (DATA) renderAll(); });
    for (const t of P.tests) {
      num("t-" + t.k, t.k);
      $("on-" + t.k).addEventListener("change", e => { S.off = { ...S.off, [t.k]: !e.target.checked }; save(); syncInputs(); renderAll(); });
    }
    $("o-zone").addEventListener("change", e => { S.zoneOn = e.target.checked; save(); syncInputs(); renderAll(); });
    $("toggle-settings").addEventListener("click", () => { S.showSettings = !S.showSettings; save(); syncInputs(); });
    num("o-low", "low"); num("o-pull", "pull"); num("o-pullmax", "pullMax"); num("o-r2", "r2"); num("o-retmin", "retMin");
    $("o-ret").addEventListener("change", e => { S.retOn = e.target.checked; syncInputs(); renderAll(); });
    $("o-period").addEventListener("change", e => { S.period = e.target.value; renderAll(); });
    $("o-trend").addEventListener("change", e => { S.trendOn = e.target.checked; save(); syncInputs(); renderAll(); });
    $("o-zmode").addEventListener("change", e => { S.zmode = e.target.value; save(); syncInputs(); renderAll(); });
    if (isStock()) {
      num("o-mcap", "mcap");
      if ($("o-uni")) $("o-uni").addEventListener("change", e => { S.uni = e.target.value; shown = 60; renderAll(); }); num("o-disc", "disc"); num("o-term", "term"); num("o-gcap", "gcap");
      if ($("o-sector")) $("o-sector").addEventListener("change", e => { S.sector = e.target.checked; save(); renderAll(); });
      $("o-fin").addEventListener("change", e => { S.fin = e.target.checked; save(); renderAll(); });
    }
    $("reset").addEventListener("click", () => { S = { ...DEF, off: { ...DEF.off } }; save(); syncInputs(); renderAll(); });
    $("run").addEventListener("click", () => load(true));
    ["q", "minp", "sec"].forEach(id => $(id).addEventListener("input", () => { shown = 60; renderTable(); }));
    $("more").addEventListener("click", () => { shown += 60; renderTable(); });
    document.querySelectorAll("th[data-k]").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.k, lt = P.tests.find(t => t.k === k)?.dir === "lt";
      if (sortK === k) { if (sortDir === -1) sortDir = 1; else { sortK = null; sortDir = -1; } }
      else { sortK = k; sortDir = (["t", "grp", "fromLow"].includes(k) || lt) ? 1 : -1; }
      renderTable();
    }));
    $("summary").addEventListener("click", e => {
      const b = e.target.closest(".stat"); if (!b) return;
      if (b.dataset.go === "near") { nearOpen = !nearOpen; renderSummary(); renderNear(); if (nearOpen) $("near-block").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      $(b.dataset.go).scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("near-close").addEventListener("click", () => { nearOpen = false; renderSummary(); renderNear(); });
    $("near-filters").addEventListener("click", e => { const c = e.target.closest(".fchip"); if (!c) return; nearFilter = c.dataset.miss || null; renderNear(); });
    $("near-list").addEventListener("click", e => {
      const p = e.target.closest(".nrow"); if (p) analyze(p.dataset.t);
    });
    const toggle = t => { open.has(t) ? open.delete(t) : open.add(t); renderTable(); };
    $("tb").addEventListener("click", e => {
      const h = e.target.closest("[data-analyze]"); if (h) { analyze(h.dataset.analyze); return; }
      const tr = e.target.closest("tr.main"); if (tr && !e.target.closest("a")) toggle(tr.dataset.t);
    });
    $("tb").addEventListener("keydown", e => { const tr = e.target.closest("tr.main"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(tr.dataset.t); } });
    // cards open the full report; "Show in this page's ranking" inside it jumps to the table
    ["picks", "zone"].forEach(id => $(id).addEventListener("click", e => {
      const p = e.target.closest(".pick"); if (p) analyze(p.dataset.t);
    }));
  }


  // ---------- single-ticker analysis ----------
  const DATASETS = {};
  let LIVE = null;
  async function dataset(name) {
    if (DATA && P.data === name) return DATA;
    if (DATASETS[name]) return DATASETS[name];
    const d = await getJSON(name);
    try {
      LIVE = LIVE || await getJSON("live.json");
      for (const r of d.rows) { const q = LIVE.q[r.t]; if (q) { r.px = q[0]; r.lo52 = q[1]; r.hi52 = q[2]; } }
    } catch (e) {}
    return DATASETS[name] = d;
  }

  // Run fn as if we were on page `pid`: the current page keeps the viewer's live settings, others use defaults.
  function withPage(pid, data, fn) {
    const saved = [P, S, DATA, PID];
    try {
      if (pid !== saved[3]) { PID = pid; P = CFG.pages[pid]; S = defaults(); }
      DATA = data;
      return fn();
    } finally { [P, S, DATA, PID] = saved; }
  }

  function exclusion(r) {
    const out = [];
    if (P.universe === "bc" && !r.bc) out.push("not in the S&P 100 or Dow 30");
    if (isStock() && P.universe !== "bc" && !(UNI_TEST[S.uni] || UNI_TEST.all)(r)) out.push(`outside "${uniLabel()}"`);
    if (isStock() && S.fin && FIN.has(r.sec)) out.push("financials and real estate are excluded");
    if (isStock() && (r.mc || 0) < S.mcap * 1e9) out.push(`below the $${S.mcap}B minimum size`);
    if (S.trendOn && !steady(r)) out.push("not a steady 5-year uptrend");
    return out;
  }

  function strengthsWeaknesses(e, kind) {
    const S_ = [], W = [];
    const add = (cond, list, txt) => { if (cond) list.push(txt); };
    const r = e;
    if (kind === "stock") {
      const med = e._med;
      const nF = r.h ? r.h.fcf.filter(v => v != null).length : 0;
      add(r.roemin != null && r.roemin >= 0.15, S_, `ROE above 15% every year (lowest ${pct(r.roemin, 0)}, average ${pct(r.roeavg, 0)})`);
      add(r.roemin != null && r.roemin < 0.10, W, r.roemin < 0 ? `Lost money in at least one year (ROE ${pct(r.roemin, 0)})` : `ROE dropped to ${pct(r.roemin, 0)} in at least one year`);
      add(r.roic != null && r.roic >= 0.15, S_, `High return on invested capital: ${pct(r.roic, 0)}`);
      add(r.roic != null && r.roic < 0.08, W, `Low return on invested capital: ${pct(r.roic, 0)}`);
      add(r.de != null && r.de >= 0 && r.de < 0.5, S_, `Low leverage: debt-to-equity ${fx(r.de)}`);
      add(r.de != null && r.de < 0, W, "Negative shareholders' equity");
      add(r.de != null && r.de > 1, W, `High leverage: debt-to-equity ${fx(r.de)}`);
      add(r.dny != null && r.dny < 2, S_, `Could repay all debt with ${fx(r.dny, 1)} years of profit`);
      add(r.dny != null && r.dny > 4, W, `Debt equals ${fx(r.dny, 1)} years of profit`);
      add(r.fcfc === 100, S_, `Positive free cash flow in every year on record (${nF})`);
      add(r.fcfc != null && r.fcfc < 100, W, `Free cash flow was negative in ${Math.round((100 - r.fcfc) / 100 * nF)} of ${nF} years`);
      add(r.fcfy != null && r.fcfy >= 0.05, S_, `Strong free-cash-flow yield: ${pct(r.fcfy)}`);
      add(r.fcfy != null && r.fcfy < 0.02, W, `Thin free-cash-flow yield: ${pct(r.fcfy)}`);
      add(r.mgr != null && r.mgr > 1, S_, `Net margin expanding: +${fx(r.mgr, 1)} pts vs earlier years`);
      add(r.mgr != null && r.mgr < -1, W, `Net margin shrinking: ${fx(r.mgr, 1)} pts vs earlier years`);
      add(r.peg != null && r.peg > 0 && r.peg < 1, S_, `PEG ${fx(r.peg)}: growth at a reasonable price`);
      add(r.peg != null && r.peg > 2, W, `Expensive for its growth: PEG ${fx(r.peg)}`);
      add(r.peg != null && r.peg <= 0, W, "Earnings expected to shrink (negative PEG)");
      add(r.pe != null && r.pe > 0 && med && r.pe < med, S_, `P/E ${fx(r.pe, 1)} is below its sector median of ${fx(med, 1)}`);
      add(r.pe != null && r.pe <= 0, W, "Losing money on a trailing basis (negative P/E)");
      add(r.pe != null && med && r.pe > med * 1.25, W, `P/E ${fx(r.pe, 1)} is well above its sector median of ${fx(med, 1)}`);
      add(r.mos != null && r.mos >= 0.25, S_, `Trades ${pct(r.mos, 0)} below its DCF value of $${fx(r.iv)}`);
      add(r.mos != null && r.mos < 0, W, `Price is ${pct(-r.mos, 0)} above its DCF value of $${fx(r.iv)}`);
      add(r.iv != null && r.iv <= 0, W, "DCF value is negative: debt outweighs projected cash flow");
      add(r.eg != null && r.eg >= 0.15, S_, `Earnings growing ${pct(r.eg, 0)} year over year`);
      add(r.rg != null && r.rg >= 0.10, S_, `Revenue growing ${pct(r.rg, 0)} year over year`);
      add(r.rg != null && r.rg < 0, W, `Revenue shrinking: ${pct(r.rg, 0)} year over year`);
      add(r.up != null && r.up >= 0.15, S_, `Analysts' average target is ${pct(r.up, 0)} above the price`);
      add(r.roicmin != null && r.roicmin >= 0.15, S_, `ROIC stayed above 15% every year (lowest ${pct(r.roicmin, 0)})`);
      add(r.roicmin != null && r.roicmin < 0.06, W, `ROIC fell to ${pct(r.roicmin, 0)} in at least one year`);
      add(r.icov != null && r.icov >= 15, S_, r.icov >= 999 ? "No meaningful interest costs" : `Covers its interest ${fx(r.icov, 0)}× over`);
      add(r.icov != null && r.icov < 3, W, r.icov < 0 ? "Operating losses: can't cover interest from profit" : `Thin interest coverage: only ${fx(r.icov, 1)}×`);
      add(r.shchg != null && r.shchg <= -1, S_, `Buying back shares: count shrinking ${fx(-r.shchg, 1)}% a year`);
      add(r.shchg != null && r.shchg >= 3, W, `Diluting shareholders: share count growing ${fx(r.shchg, 1)}% a year`);
      add(r.rgc === 100, S_, "Revenue grew every year on record");
      add(r.rgc != null && r.rgc < 50, W, `Revenue fell in more years than it grew (${Math.round(100 - r.rgc)}% of years down)`);
    } else {
      add(r.er != null && r.er <= 0.10, S_, `Very low cost: ${r.er.toFixed(2)}% a year`);
      add(r.er != null && r.er > 0.40, W, `Expensive to own: ${r.er.toFixed(2)}% a year`);
      add(r.aum != null && r.aum >= 10e9, S_, `Large, liquid fund: ${money(r.aum)} in assets`);
      add(r.aum != null && r.aum < 1e9, W, `Small fund: ${money(r.aum)} in assets`);
      add(r.pe != null && r.pe > 0 && r.pe < 20, S_, `Holdings valued at ${fx(r.pe, 1)}× earnings`);
      add(r.pe != null && r.pe > 28, W, `Holdings are pricey at ${fx(r.pe, 1)}× earnings`);
      add(r.r5 != null && r.r5 >= 0.10, S_, `Returned ${pct(r.r5, 1)} a year over 5 years`);
      add(r.r5 != null && r.r5 < 0.05, W, `Returned only ${pct(r.r5, 1)} a year over 5 years`);
      add(r.yld != null && r.yld >= 0.02, S_, `Pays a ${pct(r.yld, 2)} yield`);
      add(r.beta != null && r.beta < 0.9, S_, `Less volatile than the market (beta ${fx(r.beta)})`);
      add(r.beta != null && r.beta > 1.2, W, `More volatile than the market (beta ${fx(r.beta)})`);
    }
    add(r.r2 != null && r.r2 >= 0.75, S_, `Steady 5-year uptrend (steadiness R² ${fx(r.r2)})`);
    const lr = r.cagrL ?? r.cagr5, ly = r.cagr10 != null ? 10 : Math.floor(r.yrsL || 5);
    add(lr != null && lr >= 0.10, S_, `Beat the market: ${pct(lr, 1)} a year over ${ly} years, dividends included`);
    add(lr != null && lr >= 0 && lr < 0.07, W, `Lagged the market: only ${pct(lr, 1)} a year over ${ly} years`);
    add(r.r2 != null && r.r2 < 0.5, W, `Choppy 5-year chart: steadiness R² ${fx(r.r2)}`);
    add(r.cagr5 != null && r.cagr5 < 0, W, `Price down ${pct(-r.cagr5, 0)} a year over 5 years`);
    add(r.maxdd != null && r.maxdd < -0.5, W, `Fell ${pct(-r.maxdd, 0)} from peak to trough in the last 5 years`);
    add(r.warn && r.warn.length, W, `Unusual values (${r.warn.join(", ")}): double-check the underlying data`);
    return [S_, W];
  }

  async function analyze(raw) {
    const t = raw.trim().toUpperCase().replace(/\./g, "-");
    const dlg = $("an"), body = $("an-body");
    if (!t) return;
    body.innerHTML = `<p class="an-loading">Analyzing ${esc(t)}…</p>`;
    if (!dlg.open) dlg.showModal();
    let found = null;
    for (const name of ["scan.json", "etfs.json"]) {
      const d = await dataset(name);
      const r = d.rows.find(x => x.t === t);
      if (r) { found = { r, name, d }; break; }
    }
    if (!found) {
      body.innerHTML = `<div class="an-head"><div><h2 id="an-title">${esc(t)}</h2><p class="muted">Not in the scan.</p></div><button type="button" class="ghost" data-close>Close</button></div>
        <p>The scanner covers every NYSE and Nasdaq common stock worth over $50 million, plus 139 major ETFs. ${esc(t)} isn't one of them (it may be an OTC stock, a fund, a preferred share, or too small), so there's no data to score it with.</p>
        <p><a href="https://finance.yahoo.com/quote/${encodeURIComponent(t)}" target="_blank" rel="noopener">Look up ${esc(t)} on Yahoo Finance ↗</a></p>`;
      return;
    }
    const { r, name, d } = found;
    const kind = name === "scan.json" ? "stock" : "etf";
    const pids = Object.keys(CFG.pages).filter(id => CFG.pages[id].data === name);
    const homePid = pids.includes(PID) ? PID : pids[0];
    const results = pids.map(pid => withPage(pid, d, () => {
      const e = evaluate(r);
      return { pid, nav: P.nav, file: P.file, N: NT(), passes: e.passes, excl: exclusion(r),
        tests: AT().map(tt => ({ name: testName(tt), pass: e.ev[tt.k].pass, na: e.ev[tt.k].na, txt: testTxt(e, tt) })) };
    }));
    const e = withPage(homePid, d, () => ({ ...evaluate(r), _med: kind === "stock" ? (d.medians[r.sec] ?? d.medians._market) : null, _zmode: S.zmode, _pull: S.pull, _pullMax: S.pullMax, _low: S.low, _zoneOn: S.zoneOn }));
    const [good, bad] = strengthsWeaknesses(e, kind);

    const best = results.slice().sort((a, b) => b.passes / b.N - a.passes / a.N)[0];
    const fit = results.filter(x => x.passes === x.N && !x.excl.length);
    const near = results.filter(x => x.passes === x.N - 1);
    let verdict, tone;
    if (fit.length) { verdict = `Fits your ${fit.map(x => x.nav).join(" and ")} criteria`; tone = "ok"; }
    else if (results.some(x => x.passes === x.N)) { verdict = `Passes every ${best.nav} test, but is filtered off that page (${best.excl.join("; ")})`; tone = "warn"; }
    else if (near.length) { const x = near[0]; verdict = `Near miss on ${x.nav}: missed ${x.tests.find(q => !q.pass).name.toLowerCase()}`; tone = "warn"; }
    else { verdict = `Doesn't fit your criteria. Best match: ${best.nav}, ${best.passes} of ${best.N} tests`; tone = "bad"; }

    const zoneTxt = !e._zoneOn ? "Buy zone is switched off." : e.nearLow
      ? (e._zmode === "low" ? `In the buy zone: ${pct(e.fromLow, 1)} above its 52-week low.` : `In the buy zone: ${pct(-e.fromHigh, 1)} below its 52-week high.`)
      : (e._zmode === "low" ? `Not in the buy zone: ${pct(e.fromLow, 1)} above its 52-week low (zone is within ${e._low}%).` : `Not in the buy zone: ${pct(-e.fromHigh, 1)} below its 52-week high (zone is ${e._pull}–${e._pullMax}%).`);

    const pageCards = results.map(x => `
      <div class="an-page">
        <div class="an-page-top"><a href="${x.file}">${esc(x.nav)}</a><span class="an-score ${x.passes === x.N ? "ok" : x.passes === x.N - 1 ? "warn" : ""}">${x.passes}/${x.N}</span></div>
        <ul>${x.tests.map(q => `<li class="${q.na ? "na" : q.pass ? "ok" : "bad"}"><b>${q.na ? "–" : q.pass ? "✓" : "✕"} ${esc(q.name)}</b><span>${esc(q.txt)}</span></li>`).join("")}</ul>
        ${x.excl.length ? `<p class="an-excl">Not shown on this page: ${esc(x.excl.join("; "))}.</p>` : ""}
      </div>`).join("");

    const facts = kind === "stock" ? [
      ["Price", `$${fx(r.px)}`], ["DCF value", e.iv == null ? "—" : `$${fx(e.iv)}`],
      ["Margin of safety", e.mos == null ? "—" : pct(e.mos, 0)], ["Market cap", money(r.mc)],
      ["P/E · forward", `${fx(r.pe, 1)} · ${fx(r.fpe, 1)}`], ["Dividend yield", r.dy == null ? "—" : r.dy.toFixed(2) + "%"],
    ] : [
      ["Price", `$${fx(r.px)}`], ["Expense ratio", r.er == null ? "—" : r.er.toFixed(2) + "%"], ["Assets", money(r.aum)],
      ["P/E of holdings", fx(r.pe, 1)], ["3-yr · 5-yr return", `${pct(r.r3, 1)} · ${pct(r.r5, 1)}`], ["Yield", pct(r.yld, 2)],
    ];

    body.innerHTML = `
      <div class="an-head">
        <div><div class="eyebrow">${esc(kind === "stock" ? [r.sec, r.ind, r.exch, r.idx, r.r2k ? "Russell 2000 (approx.)" : ""].filter(Boolean).join(" · ") : r.cat || r.grp)}</div>
          <h2 id="an-title">${esc(r.t)} ${priceTag(r)} <span class="muted">${esc(r.n)}</span></h2></div>
        <div class="an-headbtns">${readBtn("Listen to report")}<button type="button" class="ghost" data-close>Close</button></div>
      </div>
      <div class="an-verdict ${tone}">${esc(verdict)}</div>
      <div class="an-chart">${spark(e, 640, 90)}<div class="an-chart-cap"><span>5-year price · ${esc(trendTxt(e))}</span><span>${esc(zoneTxt)}</span></div>
        <div class="range"><span class="mono">$${fx(r.lo52)}</span><div class="rtrack"><i style="left:${(e.rangePos ?? 0) * 100}%"></i></div><span class="mono">$${fx(r.hi52)}</span></div></div>
      <div class="an-facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
      ${await outlookHTML(r, e, kind)}
      <div class="an-sw" data-read>
        <div class="an-col good"><h3>Strengths</h3>${good.length ? `<ul>${good.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">None stand out.</p>`}</div>
        <div class="an-col weak"><h3>Weaknesses</h3>${bad.length ? `<ul>${bad.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">None stand out.</p>`}</div>
      </div>
      <h3 class="an-sub">How it scores on your screens</h3>
      <p class="muted an-note">${pids.includes(PID) ? `${esc(CFG.pages[PID].nav)} uses your current settings on this page; the others use their default settings.` : "Scored with each screen's default settings."}</p>
      <div class="an-pages">${pageCards}</div>
      ${kind === "stock" && e.iv != null && e.iv > 0 ? `<p class="an-note">DCF: ${money(r.fcf0)} average free cash flow growing ${pct(e.dcfg, 1)} a year for 5 years, fading to ${CFG.dcf.term}%, discounted at ${CFG.dcf.disc}%, plus ${r.netcash >= 0 ? "net cash" : "net debt of"} ${money(Math.abs(r.netcash))}.</p>` : ""}
      ${kind === "etf" ? `<h3 class="an-sub">Top 10 holdings on your stock screens</h3><div class="etf-hold" data-etf="${esc(r.t)}">${await holdingsHTML(r)}</div>` : ""}
      <form class="an-own" data-own="${esc(r.t)}">
        <b>${myHoldings().some(h => h.t === r.t) ? "In My stocks · update" : "Own it? Add to My stocks"}</b>
        <label>Bought at $<input name="buy" type="number" step="0.01" min="0" value="${r.px ? r.px.toFixed(2) : ""}"></label>
        <label>Judge it on <select name="pid">${pids.map(id => `<option value="${id}"${id === (kind === "etf" ? "etf" : "buffett") ? " selected" : ""}>${esc(CFG.pages[id].nav)}</option>`).join("")}</select></label>
        <button type="submit" class="reset">${myHoldings().some(h => h.t === r.t) ? "Update" : "Add"}</button>
      </form>
      <div class="an-actions">
        ${P.data === name ? `<button type="button" class="reset" data-show="${esc(r.t)}">Show in this page's ranking</button>` : ""}
        <a href="https://finance.yahoo.com/quote/${encodeURIComponent(r.t)}" target="_blank" rel="noopener">Open on Yahoo Finance ↗</a>
      </div>`;
  }

  async function fillLookupList() {
    try {
      const opts = [];
      for (const name of ["scan.json", "etfs.json"]) {
        const d = await dataset(name);
        for (const r of d.rows) opts.push(`<option value="${esc(r.t)}">${esc(r.n)}</option>`);
      }
      $("lk-list").innerHTML = opts.join("");
    } catch (e) {}
  }

  function wireLookup() {
    $("lookup").addEventListener("submit", e => { e.preventDefault(); analyze($("lk").value); });
    $("an").addEventListener("submit", e => {
      const f = e.target.closest("form.an-own"); if (!f) return;
      e.preventDefault();
      upsertHolding({ t: f.dataset.own, buy: parseFloat(f.buy.value) || null, pid: f.pid.value });
      f.querySelector("b").textContent = "Saved to My stocks";
      if (P.kind === "mine") renderMine();
    });
    $("an").addEventListener("click", e => {
      if (e.target === $("an") || e.target.closest("[data-close]")) { $("an").close(); stopVoice(); return; }
      const hl = e.target.closest("[data-analyze]");
      if (hl) { analyze(hl.dataset.analyze); return; }
      const b = e.target.closest("[data-show]");
      if (b) {
        $("an").close();
        const t = b.dataset.show; open.add(t); $("q").value = t; $("minp").value = "0"; $("sec").value = ""; renderTable();
        $("table-block").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }


  // ---------- scoring helpers shared by My stocks, Track record and ETF holdings ----------
  function scoreOn(pid, d, r) {
    return withPage(pid, d, () => {
      const e = evaluate(r);
      return { e, N: NT(), passes: e.passes, fails: AT().filter(t => !e.ev[t.k].pass).map(testName), excl: exclusion(r) };
    });
  }
  let scanMap = null;
  async function scanIndex() {
    if (scanMap) return scanMap;
    const d = await dataset("scan.json");
    scanMap = { d, by: new Map(d.rows.map(r => [r.t, r])) };
    return scanMap;
  }
  const firstWord = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ")[0];
  function resolveHolding(sym, name, by) {
    const t = String(sym).toUpperCase().replace(/\./g, "-");
    if (by.has(t)) return by.get(t);
    const base = String(sym).split(".")[0].toUpperCase();
    const r = by.get(base);  // foreign listing (ASML.AS) -> US listing, only when the names agree
    return r && firstWord(r.n) === firstWord(name) ? r : null;
  }

  // ---------- ETF: rank the fund's top 10 holdings on the stock screens ----------

  // ---------- company outlook, direction signals, annual meeting, headlines (free data) ----------
  async function companyFile(t) {
    try { return await getJSON(`co/${encodeURIComponent(t)}.json`); } catch (e) { return {}; }
  }
  const dateTxt = d => { if (!d) return ""; const x = typeof d === "number" ? new Date(d * 1000) : new Date(d + (String(d).length === 10 ? "T12:00:00" : "")); return x.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); };
  const REC = { strong_buy: "Strong buy", buy: "Buy", hold: "Hold", underperform: "Underperform", sell: "Sell", strong_sell: "Strong sell" };

  function outlookText(r, e, co, kind) {
    const bits = [];
    if (kind === "stock") {
      const who = [r.sec, co.emp ? `${Math.round(co.emp).toLocaleString()} employees` : "", co.ceo ? `CEO ${co.ceo.split(" (")[0].replace(/^(Mr\.|Ms\.|Mrs\.|Dr\.)\s*/, "")}` : ""].filter(Boolean).join(", ");
      bits.push(`${r.n} (${who}).`);
      if (r.rec && r.nan) {
        const up = r.tgt && r.px ? r.tgt / r.px - 1 : null;
        bits.push(`${Math.round(r.nan)} analyst${r.nan > 1 ? "s" : ""} rate it ${REC[r.rec] || r.rec} on average${r.tgt ? `, with a mean price target of $${fx(r.tgt)} (${up >= 0 ? "+" : ""}${pct(up, 0)} from here; range $${fx(r.tlo)}–$${fx(r.thi)})` : ""}.`);
      } else bits.push("rec" in r ? "No analyst coverage on record." : "Analyst ratings for this company arrive with its next scheduled scan (within two days).");
      if (r.feps && r.teps && r.teps > 0) {
        const g = r.feps / r.teps - 1;
        bits.push(`Earnings per share are expected to ${g >= 0 ? "grow" : "fall"} ${pct(Math.abs(g), 0)} over the next year ($${fx(r.teps)} → $${fx(r.feps)}).`);
      }
      if (r.rg != null) bits.push(`Revenue ${r.rg >= 0 ? "grew" : "fell"} ${pct(Math.abs(r.rg), 0)} in the latest year${r.rgc != null ? `, and has risen in ${Math.round(r.rgc)}% of recorded years` : ""}.`);
      if (e.mos != null) bits.push(e.mos >= 0 ? `It trades ${pct(e.mos, 0)} below the DCF estimate of $${fx(e.iv)} a share.` : `It trades ${pct(-e.mos, 0)} above the DCF estimate of $${fx(e.iv)} a share, so the price assumes faster growth than its record.`);
      if (r.earn && r.earn * 1000 > Date.now() - 864e5) bits.push(`Next earnings report: ${dateTxt(r.earn)}.`);
    } else {
      bits.push(`${r.n} (${[r.cat, r.fam].filter(Boolean).join(", ")}): ${money(r.aum)} in assets at ${r.er != null ? r.er.toFixed(2) + "%" : "an unknown"} a year.`);
      if (r.r5 != null) bits.push(`It returned ${pct(r.r5, 1)} a year over 5 years${r.r3 != null ? ` and ${pct(r.r3, 1)} over 3` : ""}, with holdings valued at ${fx(r.pe, 1)}× earnings.`);
    }
    return bits.join(" ");
  }

  // Rule-based signals about where the price has been heading and what analysts expect. Not a forecast.
  function directionSignals(r, e, kind) {
    const out = [], add = (good, label, txt) => { if (good !== undefined) out.push({ good, label, txt }); };
    if (r.ma200 && r.px) add(r.px > r.ma200, "Long-term trend", `Price $${fx(r.px)} is ${r.px > r.ma200 ? "above" : "below"} its 200-day average ($${fx(r.ma200)})`);
    if (r.ma50 && r.ma200) add(r.ma50 > r.ma200, "Medium-term trend", `50-day average is ${r.ma50 > r.ma200 ? "above" : "below"} the 200-day (${r.ma50 > r.ma200 ? "rising" : "weakening"} trend)`);
    if (r.r2 != null && r.cagr5 != null) add(r.r2 >= 0.6 && r.cagr5 > 0, "5-year chart", `${r.cagr5 > 0 && r.r2 >= 0.6 ? "Steady climb" : r.cagr5 <= 0 ? "Falling" : "Choppy"}: R² ${fx(r.r2)}, ${pct(r.cagr5, 0)} a year`);
    if (e.fromHigh != null) add(e.fromHigh > -0.2, "Recent move", `${pct(-e.fromHigh, 0)} below its 52-week high`);
    if (kind === "stock") {
      if (r.recm) add(r.recm <= 2.3 ? true : r.recm >= 3 ? false : undefined, "Analyst rating", `${REC[r.rec] || "—"} (average score ${fx(r.recm, 1)} on a 1 = strong buy to 5 = sell scale)`);
      const up = r.tgt && r.px ? r.tgt / r.px - 1 : null;
      if (up != null) add(up >= 0.1 ? true : up <= -0.05 ? false : undefined, "Price target", `Analysts' mean target is ${up >= 0 ? "+" : ""}${pct(up, 0)} from the price`);
      if (r.feps && r.teps && r.teps > 0) { const g = r.feps / r.teps - 1; add(g >= 0.08 ? true : g < 0 ? false : undefined, "Earnings outlook", `Next-year EPS expected ${g >= 0 ? "+" : ""}${pct(g, 0)}`); }
      if (r.rg != null) add(r.rg >= 0.05 ? true : r.rg < 0 ? false : undefined, "Sales momentum", `Revenue ${r.rg >= 0 ? "+" : ""}${pct(r.rg, 0)} in the latest year`);
    }
    const up = out.filter(x => x.good).length, down = out.filter(x => !x.good).length;
    const lean = up - down >= 3 ? "up" : down - up >= 2 ? "down" : "mixed";
    return { list: out, lean, up, down };
  }

  async function outlookHTML(r, e, kind) {
    const co = await companyFile(r.t);
    const dir = directionSignals(r, e, kind);
    const leanTxt = { up: "Signals lean up", down: "Signals lean down", mixed: "Mixed signals" }[dir.lean];
    const sum = co.sum || "";
    const sec = co.sec || {}, v = sec.vote;
    const edgar = co.cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${co.cik}&type=&dateb=&owner=include&count=40` : null;
    const meeting = kind !== "stock" ? "" : `
      <section class="an-sec" data-read>
        <h3 class="an-sub">Annual meeting ${readBtn()}</h3>
        ${v ? `<p><b>${dateTxt(v.meeting)}</b> · shareholder voting results filed ${dateTxt(v.d)}.</p>
          ${v.text ? `<blockquote class="an-quote">${esc(v.text.length > 900 ? v.text.slice(0, 900).replace(/\s\S*$/, "") + "…" : v.text)}</blockquote>
          ${v.text.length > 900 ? `<details><summary>Full voting results</summary><blockquote class="an-quote">${esc(v.text)}</blockquote></details>` : ""}
          <p class="muted an-note">Quoted from the company's 8-K filing (Item 5.07), not a summary written by MacStocks.</p>` : ""}`
        : `<p class="muted">${co.cik ? "No annual-meeting results on file yet for this company in the saved data." : "This company doesn't file with the SEC under this ticker (often a foreign company)."}</p>`}
        <p class="an-links">${[v ? `<a href="${esc(v.u)}" target="_blank" rel="noopener">Voting results ↗</a>` : "", sec.proxy ? `<a href="${esc(sec.proxy.u)}" target="_blank" rel="noopener">Proxy statement (${dateTxt(sec.proxy.d)}) ↗</a>` : "", sec.annual ? `<a href="${esc(sec.annual.u)}" target="_blank" rel="noopener">Annual report ${esc(sec.annual.form)} (${dateTxt(sec.annual.d)}) ↗</a>` : "", edgar ? `<a href="${edgar}" target="_blank" rel="noopener">All SEC filings ↗</a>` : ""].filter(Boolean).join("")}</p>
      </section>`;
    const news = (co.news || []).length ? `<ul class="an-news">${co.news.map(n => `<li><a href="${esc(n.u)}" target="_blank" rel="noopener">${esc(n.t)}</a> <span class="muted">${esc(n.p)}${n.d ? " · " + dateTxt(n.d) : ""}</span></li>`).join("")}</ul>`
      : `<p class="muted">No saved headlines for this one. <a href="https://finance.yahoo.com/quote/${encodeURIComponent(r.t)}/news" target="_blank" rel="noopener">Latest news on Yahoo Finance ↗</a></p>`;
    return `
      <section class="an-sec" data-read>
        <h3 class="an-sub">Company outlook ${readBtn()}</h3>
        <p>${esc(outlookText(r, e, co, kind))}</p>
        ${sum ? `<details class="an-about"><summary>What the ${kind === "stock" ? "company" : "fund"} does</summary><p>${esc(sum)}</p>${co.web ? `<p><a href="${esc(co.web)}" target="_blank" rel="noopener">${esc(co.web.replace(/^https?:\/\//, ""))} ↗</a></p>` : ""}</details>` : ""}
      </section>
      <section class="an-sec" data-read>
        <h3 class="an-sub">Which way it's heading ${readBtn()}</h3>
        <p><span class="pill ${dir.lean === "up" ? "hold" : dir.lean === "down" ? "sell" : "review"}">${leanTxt}</span> <span class="muted">${dir.up} pointing up, ${dir.down} pointing down</span></p>
        <ul class="an-dir">${dir.list.map(x => `<li class="${x.good ? "ok" : "bad"}"><b>${x.good ? "▲" : "▼"} ${esc(x.label)}</b> ${esc(x.txt)}</li>`).join("")}</ul>
        <p class="muted an-note">Built from trend, analyst and earnings data. These describe momentum and expectations; nobody can reliably predict where a stock goes next.</p>
      </section>
      ${meeting}
      <section class="an-sec" data-read>
        <h3 class="an-sub">Recent headlines ${readBtn()}</h3>
        ${news}
      </section>`;
  }

  // ---------- voice reader (built into the browser, free) ----------
  const VKEY = "macstocks-voice-rate";
  const readBtn = (label = "Listen") => `<button type="button" class="listen" data-listen aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg><span>${label}</span></button>`;
  function speakableText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll("svg, button, input, select, textarea, [data-noread], .listen, .spark, .rtrack, .bar, .dots").forEach(x => x.remove());
    c.querySelectorAll("details").forEach(d => { if (!d.open) d.querySelectorAll(":scope > :not(summary)").forEach(x => x.remove()); });
    let t = c.innerText || c.textContent || "";
    return t.replace(/R²/g, "R squared").replace(/×/g, " times").replace(/·/g, ", ").replace(/↗/g, "").replace(/▲|▼|✓|✕/g, "")
      .replace(/\s+–\s+|–/g, " to ").replace(/−/g, "minus ").replace(/%\/yr/g, " percent a year").replace(/\/yr/g, " a year")
      .replace(/(\d)pt\b/g, "$1 points").replace(/\bpts\b/g, "points").replace(/\bD\/E\b/g, "debt to equity").replace(/\bP\/E\b/g, "P E")
      .replace(/\bFCF\b/g, "free cash flow").replace(/\bROIC\b/g, "R O I C").replace(/\bROE\b/g, "R O E").replace(/\bDCF\b/g, "D C F")
      .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, ".\n").replace(/\n/g, ". ").replace(/\.\s*\./g, ".").trim();
  }
  let voiceQueue = [], voiceOn = false;
  function pickVoice() {
    const vs = speechSynthesis.getVoices().filter(v => /^en(-|_)?US/i.test(v.lang) || /^en/i.test(v.lang));
    return vs.find(v => /Samantha|Ava|Allison|Google US English|Jenny|Aria/i.test(v.name)) || vs[0] || null;
  }
  function stopVoice() { voiceOn = false; voiceQueue = []; try { speechSynthesis.cancel(); } catch (e) {} updateVoiceUI(); }
  function speak(text) {
    if (!("speechSynthesis" in window)) { alertVoice("This browser can't read text aloud."); return; }
    stopVoice();
    const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    voiceQueue = []; let buf = "";
    for (const c of chunks) { if ((buf + c).length > 220) { if (buf) voiceQueue.push(buf); buf = c; } else buf += c; }
    if (buf.trim()) voiceQueue.push(buf);
    voiceOn = true; updateVoiceUI();
    const rate = (() => { try { return parseFloat(localStorage.getItem(VKEY)) || 1; } catch (e) { return 1; } })();
    const next = () => {
      if (!voiceOn || !voiceQueue.length) { voiceOn = false; updateVoiceUI(); return; }
      const u = new SpeechSynthesisUtterance(voiceQueue.shift());
      const v = pickVoice(); if (v) u.voice = v;
      u.rate = rate; u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    };
    next();
  }
  function alertVoice(msg) { const b = $("voice-bar"); if (b) { b.hidden = false; $("voice-status").textContent = msg; } }
  function updateVoiceUI() {
    const b = $("voice-bar"); if (!b) return;
    b.hidden = !voiceOn;
    $("voice-status").textContent = voiceOn ? "Reading aloud…" : "";
    $("voice-pause").textContent = speechSynthesis.paused ? "Resume" : "Pause";
  }
  function readPage() {
    const sel = String(window.getSelection ? window.getSelection() : "").trim();
    if (sel) return speak(sel);
    if ($("an").open) return speak(speakableText($("an-body")));
    const parts = [...document.querySelectorAll("#app header, #app .summary, #app #near-block:not([hidden]), #app #zone-block, #app #picks-block, #app .special, #app .notes")];
    speak(parts.map(speakableText).filter(Boolean).join(". "));
  }
  function wireVoice() {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="voice-bar" id="voice-bar" hidden role="status">
        <span id="voice-status"></span>
        <button type="button" id="voice-pause">Pause</button>
        <label>Speed <select id="voice-rate"><option value="0.8">0.8×</option><option value="1">1×</option><option value="1.2">1.2×</option><option value="1.5">1.5×</option></select></label>
        <button type="button" id="voice-stop">Stop</button>
      </div>
      <button type="button" class="sel-read" id="sel-read" hidden>${readBtn("Read this")}</button>`);
    try { $("voice-rate").value = localStorage.getItem(VKEY) || "1"; } catch (e) {}
    $("voice-rate").addEventListener("change", e => { try { localStorage.setItem(VKEY, e.target.value); } catch (err) {} });
    $("voice-stop").addEventListener("click", stopVoice);
    $("voice-pause").addEventListener("click", () => { speechSynthesis.paused ? speechSynthesis.resume() : speechSynthesis.pause(); updateVoiceUI(); });
    document.addEventListener("click", e => {
      const b = e.target.closest("[data-listen]");
      if (!b || b.closest("#sel-read")) return;
      e.preventDefault(); e.stopPropagation();
      if (b.id === "listen-page") return voiceOn ? stopVoice() : readPage();
      const sec = b.closest("[data-read], section, .stat, .pick, .an-inner, header");
      speak(speakableText(sec || document.body));
    }, true);
    // select any text, then tap "Read this"
    const sr = $("sel-read");
    document.addEventListener("selectionchange", () => {
      const s = window.getSelection(), txt = String(s || "").trim();
      if (!txt || txt.length < 3 || !s.rangeCount) { sr.hidden = true; return; }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      sr.hidden = false;
      sr.style.top = `${Math.max(8, rect.top + window.scrollY - 40)}px`;
      sr.style.left = `${Math.min(window.innerWidth - 120, Math.max(8, rect.left + window.scrollX))}px`;
    });
    sr.addEventListener("mousedown", e => e.preventDefault());
    sr.addEventListener("click", () => { const t = String(window.getSelection()).trim(); sr.hidden = true; if (t) speak(t); });
    window.addEventListener("pagehide", stopVoice);
  }

  async function holdingsHTML(etf) {
    if (!etf.top || !etf.top.length) return `<p class="muted">Yahoo doesn't list holdings for this fund yet (they arrive with the next weekday scan).</p>`;
    const { d, by } = await scanIndex();
    const rows = etf.top.map(([sym, name, w]) => {
      const r = resolveHolding(sym, name, by);
      if (!r) return { sym, name, w, r: null };
      const v = scoreOn("value", d, r), b = scoreOn("buffett", d, r);
      return { sym, name, w, r, v, b, key: b.passes / b.N + v.passes / v.N, score: (b.e.score + v.e.score) / 2 };
    });
    const scored = rows.filter(x => x.r).sort((a, b) => b.key - a.key || b.score - a.score);
    const missing = rows.filter(x => !x.r);
    const covered = scored.reduce((a, x) => a + x.w, 0), total = rows.reduce((a, x) => a + x.w, 0);
    const strongW = scored.filter(x => x.b.passes >= x.b.N - 1 || x.v.passes >= x.v.N - 1).reduce((a, x) => a + x.w, 0);
    const cell = (s, N) => `<span class="an-score ${s === N ? "ok" : s === N - 1 ? "warn" : ""}">${s}/${N}</span>`;
    return `
      <p class="hold-sum">${pct(strongW, 1)} of the fund sits in top-10 holdings that pass all but at most one test on your Value or Buffett screen.
        ${missing.length ? `${missing.length} holding${missing.length > 1 ? "s are" : " is"} listed outside the US and not in the scan.` : ""}</p>
      <div class="hold-wrap"><table class="hold">
        <thead><tr><th>#</th><th>Holding</th><th class="r">Weight</th><th class="r">Value</th><th class="r">Buffett</th><th class="r">Score</th><th>5-yr chart</th></tr></thead>
        <tbody>${scored.map((x, i) => `<tr data-analyze="${esc(x.r.t)}" title="Analyze ${esc(x.r.t)}">
          <td class="n">${i + 1}</td>
          <td><span class="tk">${esc(x.r.t)}</span> ${priceTag(x.r)} <span class="nm">${esc(x.r.n)}</span></td>
          <td class="n">${pct(x.w, 1)}</td><td class="n">${cell(x.v.passes, x.v.N)}</td><td class="n">${cell(x.b.passes, x.b.N)}</td>
          <td class="n">${Math.round(x.score)}</td><td>${spark(x.b.e, 84, 22)}</td></tr>`).join("")}
        ${missing.map(x => `<tr class="na"><td class="n">–</td><td><span class="tk">${esc(x.sym)}</span> <span class="nm">${esc(x.name)}</span></td><td class="n">${pct(x.w, 1)}</td><td colspan="4" class="muted">Not in the US scan</td></tr>`).join("")}
        </tbody></table></div>
      <p class="muted an-note">Ranked by how many tests each holding passes on the Value and Buffett screens (default settings), then score. Top 10 = ${pct(total, 0)} of the fund.</p>`;
  }
  async function fillHoldings() {
    for (const el of document.querySelectorAll(".etf-hold:not(.done)")) {
      el.classList.add("done");
      const r = DATA.rows.find(x => x.t === el.dataset.etf);
      try { el.innerHTML = await holdingsHTML(r); } catch (e) { el.innerHTML = `<p class="muted">Couldn't load holdings (${esc(e.message)}).</p>`; }
    }
  }

  // ---------- My stocks: holdings kept in this browser, with sell signals ----------
  const HKEY = "macstocks-holdings";
  function myHoldings() { try { return JSON.parse(localStorage.getItem(HKEY) || "[]"); } catch (e) { return []; } }
  function saveHoldings(list) { try { localStorage.setItem(HKEY, JSON.stringify(list)); } catch (e) {} }
  function upsertHolding(h) {
    const list = myHoldings(), i = list.findIndex(x => x.t === h.t);
    if (i >= 0) list[i] = { ...list[i], ...h };
    else list.push({ ...h, d: new Date().toISOString().slice(0, 10) });
    saveHoldings(list);
  }

  function sellCheck(h, d) {
    const r = d.rows.find(x => x.t === h.t);
    if (!r) return { h, r: null };
    const sc = scoreOn(h.pid, d, r), e = sc.e, rule = CFG.sell, sig = [];
    const failing = sc.N - sc.passes >= rule.failTests;
    const today = new Date().toISOString().slice(0, 10);
    if (failing && !h.failSince) h.failSince = today;
    if (!failing) h.failSince = null;
    const days = h.failSince ? Math.round((Date.now() - new Date(h.failSince)) / 864e5) : 0;
    if (failing) sig.push({ key: "fail", txt: `Fails ${sc.N - sc.passes} of ${sc.N} tests: ${sc.fails.join(", ")}${days ? ` (since ${h.failSince})` : ""}` });
    if (e.mos != null && e.mos <= -rule.overDcf / 100) sig.push({ key: "dcf", txt: `Price is ${pct(-e.mos, 0)} above its DCF value ($${fx(e.iv)})` });
    if (e.fromHigh != null && e.fromHigh <= -rule.drawdown / 100) sig.push({ key: "trend", txt: `${pct(-e.fromHigh, 0)} below its 52-week high: the uptrend may be broken` });
    const gain = h.buy && r.px ? r.px / h.buy - 1 : null;
    if (gain != null && gain <= -rule.stop / 100) sig.push({ key: "stop", txt: `Down ${pct(-gain, 0)} from your buy price` });
    if (r.r2 != null && r.r2 < rule.choppy) sig.push({ key: "chop", txt: `Chart has turned choppy (steadiness R² ${fx(r.r2)})` });
    const persisted = failing && days >= rule.persistDays;
    const status = sig.length >= 2 || persisted ? "sell" : sig.length === 1 ? "review" : "hold";
    return { h, r, sc, e, sig, gain, status };
  }

  async function renderMine() {
    const data = { "scan.json": await dataset("scan.json"), "etfs.json": await dataset("etfs.json") };
    const list = myHoldings();  // read after loading, so stocks added meanwhile aren't missed
    const checks = list.map(h => sellCheck({ ...h }, data[CFG.pages[h.pid]?.data || "scan.json"]));
    // record when each started failing, merging into whatever is stored now
    const stored = myHoldings();
    for (const c of checks) { const x = stored.find(h => h.t === c.h.t); if (x) x.failSince = c.h.failSince; }
    saveHoldings(stored);
    const n = s => checks.filter(c => c.status === s).length;
    const gains = checks.filter(c => c.gain != null).map(c => c.gain);
    $("mine-summary").innerHTML = `
      <div class="stat"><div class="eyebrow">Holdings</div><div class="v">${list.length}</div><div class="s">saved in this browser</div></div>
      <div class="stat${n("sell") ? " bad" : ""}"><div class="eyebrow">Sell signals</div><div class="v">${n("sell")}</div><div class="s">2+ warnings, or failing for ${CFG.sell.persistDays}+ days</div></div>
      <div class="stat${n("review") ? " warnc" : ""}"><div class="eyebrow">Review</div><div class="v">${n("review")}</div><div class="s">one warning</div></div>
      <div class="stat${n("hold") ? " hot" : ""}"><div class="eyebrow">Hold</div><div class="v">${n("hold")}</div><div class="s">${gains.length ? `average gain ${pct(gains.reduce((a, b) => a + b, 0) / gains.length, 1)}` : "no warnings"}</div></div>`;
    const label = { sell: "Sell signal", review: "Review", hold: "Hold" };
    $("mine-list").innerHTML = !checks.length
      ? `<div class="empty">No stocks yet. Add one above, or open any stock with Analyze and choose "Add to My stocks".</div>`
      : checks.sort((a, b) => ["sell", "review", "hold"].indexOf(a.status) - ["sell", "review", "hold"].indexOf(b.status)).map(c => !c.r
        ? `<div class="mrow"><div class="mname"><span class="tk">${esc(c.h.t)}</span> <span class="muted">no longer in the scan</span></div><button type="button" class="reset" data-del="${esc(c.h.t)}">Remove</button></div>`
        : `<div class="mrow ${c.status}">
          <div class="mname" data-analyze="${esc(c.r.t)}"><span class="tk">${esc(c.r.t)}</span> ${priceTag(c.r)}<div class="nm">${esc(c.r.n)}</div></div>
          <div class="mspark">${spark(c.e, 110, 30)}</div>
          <div class="mfacts"><span>Judged on <b>${esc(CFG.pages[c.h.pid].nav)}</b>: ${c.sc.passes}/${c.sc.N} tests</span>
            <span>${c.h.buy ? `Bought at $${fx(c.h.buy)} · <b class="${c.gain >= 0 ? "ok" : "bad"}">${c.gain >= 0 ? "+" : ""}${pct(c.gain, 1)}</b>` : "No buy price"} · since ${esc(c.h.d || "")}</span></div>
          <div class="msig">${c.sig.length ? `<ul>${c.sig.map(x => `<li>${esc(x.txt)}</li>`).join("")}</ul>` : `<span class="muted">No warnings</span>`}</div>
          <div class="mstat"><span class="pill ${c.status}">${label[c.status]}</span><button type="button" class="linkbtn" data-del="${esc(c.r.t)}">Remove</button></div>
        </div>`).join("");
  }

  function mineShell() {
    const sr = CFG.sell;
    return `
      <header><div><div class="eyebrow">Your holdings · sell signals</div><h1>My Stocks</h1>
        <p>Stocks you own, re-checked against the screen you picked every time you open this page. Saved in this browser only: your list stays on this device until you remove it.</p></div></header>
      <form class="mine-add" id="mine-add" autocomplete="off">
        <input id="mine-t" list="lk-list" placeholder="Ticker" aria-label="Ticker" required>
        <input id="mine-buy" type="number" step="0.01" min="0" placeholder="Bought at $ (optional)" aria-label="Buy price">
        <select id="mine-pid" aria-label="Screen to judge it on">${Object.entries(CFG.pages).filter(([, p]) => p.kind === "stock" || p.kind === "etf").map(([id, p]) => `<option value="${id}"${id === "buffett" ? " selected" : ""}>Judge on ${esc(p.nav)}</option>`).join("")}</select>
        <button type="submit" class="run">Add stock</button>
      </form>
      <p class="err" id="mine-err" hidden></p>
      <div class="summary" id="mine-summary"></div>
      <div class="mlist" id="mine-list"><p class="muted">Loading…</p></div>
      <section class="notes">
        <div><h3>When a warning appears</h3><p>Fails ${sr.failTests}+ of its screen's tests · price ${sr.overDcf}%+ above its DCF value · ${sr.drawdown}%+ below its 52-week high · down ${sr.stop}%+ from your buy price · chart steadiness under ${sr.choppy}.</p></div>
        <div><h3>Review vs sell signal</h3><p>One warning means look again. Two or more at once, or failing the tests for ${sr.persistDays}+ days in a row, is a sell signal. That's roughly "two bad quarters", tracked from the first day this page saw it fail.</p></div>
        <div><h3>Moving devices</h3><p><button type="button" class="reset" id="mine-copy">Copy my list</button> then paste it on the other device: <button type="button" class="reset" id="mine-paste">Paste a list</button></p><textarea id="mine-io" rows="3" hidden placeholder="Paste your list here, then press Paste a list again"></textarea></div>
      </section>`;
  }
  function wireMine() {
    $("mine-add").addEventListener("submit", async e => {
      e.preventDefault();
      const t = $("mine-t").value.trim().toUpperCase().replace(/\./g, "-"), pid = $("mine-pid").value;
      const d = await dataset(CFG.pages[pid].data);
      if (!d.rows.some(r => r.t === t)) { $("mine-err").hidden = false; $("mine-err").textContent = `${t} isn't on the ${CFG.pages[pid].nav} data. Stocks go on a stock screen, funds on ETFs.`; return; }
      $("mine-err").hidden = true;
      const r = d.rows.find(x => x.t === t);
      upsertHolding({ t, pid, buy: parseFloat($("mine-buy").value) || r.px || null });
      $("mine-t").value = ""; $("mine-buy").value = "";
      renderMine();
    });
    $("mine-list").addEventListener("click", e => {
      const del = e.target.closest("[data-del]");
      if (del) { saveHoldings(myHoldings().filter(h => h.t !== del.dataset.del)); renderMine(); return; }
      const a = e.target.closest("[data-analyze]");
      if (a) analyze(a.dataset.analyze);
    });
    $("mine-copy").addEventListener("click", () => {
      const txt = JSON.stringify(myHoldings());
      const io = $("mine-io"); io.hidden = false; io.value = txt; io.select();
      navigator.clipboard?.writeText(txt).catch(() => {});
    });
    $("mine-paste").addEventListener("click", () => {
      const io = $("mine-io");
      if (io.hidden || !io.value.trim()) { io.hidden = false; io.value = ""; io.focus(); return; }
      try {
        const list = JSON.parse(io.value);
        if (!Array.isArray(list)) throw new Error("not a list");
        list.forEach(h => h && h.t && h.pid && upsertHolding(h));
        io.value = ""; io.hidden = true; renderMine();
      } catch (err) { $("mine-err").hidden = false; $("mine-err").textContent = "That doesn't look like a copied list. Copy it again on the other device."; }
    });
  }

  // ---------- Track record: weekly picks vs SPY since they were picked ----------
  async function renderTrack() {
    let T, L = {};
    try { T = await getJSON("track.json", true); } catch (e) {
      $("track-body").innerHTML = `<div class="empty">The first weekly snapshot hasn't been recorded yet. It's taken during the next morning scan.</div>`; return;
    }
    try { L = (await getJSON("live.json", true)).q || {}; } catch (e) {}
    const now = t => (L[t] && L[t][0]) || T.last[t];
    const spyNow = now("SPY");
    const snaps = T.snaps.map(s => {
      const rets = s.picks.map(([t, p]) => ({ t, p, now: now(t), ret: now(t) ? now(t) / p - 1 : null })).filter(x => x.ret != null);
      const avg = rets.length ? rets.reduce((a, x) => a + x.ret, 0) / rets.length : null;
      const spy = spyNow && s.spy ? spyNow / s.spy - 1 : null;
      return { ...s, rets, avg, spy, ex: avg != null && spy != null ? avg - spy : null };
    });
    const first = snaps.length ? snaps[0].d : null;
    const days = first ? Math.round((Date.now() - new Date(first)) / 864e5) : 0;
    const pages = Object.entries(CFG.pages).filter(([, p]) => p.kind === "stock" || p.kind === "etf");
    const sum = pages.map(([pid, p]) => {
      const ss = snaps.filter(s => s.page === pid && s.ex != null);
      const avg = k => ss.length ? ss.reduce((a, s) => a + s[k], 0) / ss.length : null;
      return { pid, p, n: ss.length, avg: avg("avg"), spy: avg("spy"), ex: avg("ex"), beat: ss.filter(s => s.ex > 0).length };
    });
    const sign = v => v == null ? "—" : (v >= 0 ? "+" : "") + pct(v, 1);
    $("track-body").innerHTML = `
      <p class="track-note">${first ? `Tracking since <b>${esc(first)}</b> (${days} day${days === 1 ? "" : "s"}).` : ""} ${days < 180 ? "Results this early are mostly noise; judge the screens after 6–12 months of weekly snapshots." : ""}</p>
      <div class="tsum">${sum.map(x => `
        <div class="stat${x.ex > 0 ? " hot" : x.ex < 0 ? " bad" : ""}">
          <div class="eyebrow">${esc(x.p.nav)}</div>
          <div class="v">${sign(x.ex)}</div>
          <div class="s">${x.n ? `vs SPY on average · picks ${sign(x.avg)}, SPY ${sign(x.spy)} · beat SPY in ${x.beat} of ${x.n} snapshots` : "no snapshots yet"}</div>
        </div>`).join("")}</div>
      ${pages.map(([pid, p]) => {
        const ss = snaps.filter(s => s.page === pid).slice().reverse();
        if (!ss.length) return "";
        return `<section class="block"><h2>${esc(p.nav)}</h2><div class="tablebox"><table class="ttab">
          <thead><tr><th>Picked on</th><th class="r">Picks</th><th class="r">Picks since</th><th class="r">SPY since</th><th class="r">Difference</th><th>Picks</th></tr></thead>
          <tbody>${ss.map(s => `<tr>
            <td>${esc(s.d)}</td><td class="n">${s.picks.length}</td><td class="n">${sign(s.avg)}</td><td class="n">${sign(s.spy)}</td>
            <td class="n ${s.ex > 0 ? "ok" : s.ex < 0 ? "bad" : ""}">${sign(s.ex)}</td>
            <td class="tpicks">${s.rets.length ? s.rets.sort((a, b) => b.ret - a.ret).map(x => `<span data-analyze="${esc(x.t)}" class="${x.ret >= 0 ? "ok" : "bad"}">${esc(x.t)} ${sign(x.ret)}</span>`).join("") : `<span class="muted">No stock passed every test that week</span>`}</td></tr>`).join("")}
          </tbody></table></div></section>`;
      }).join("")}
      <section class="notes">
        <div><h3>How it's measured</h3><p>Every week each screen's full matches (default settings, every test passed) are recorded with that day's price. "Picks since" is their equal-weight average price change from then to now; "SPY since" is the S&amp;P 500 ETF over the same span.</p></div>
        <div><h3>Why forward, not a backtest</h3><p>Free data only shows companies as they look today, so testing the screen on past years would quietly use information nobody had then. Recording picks as they happen can't cheat that way.</p></div>
        <div><h3>What's left out</h3><p>Prices only: dividends, trading costs and taxes aren't counted, for the picks or SPY. Stocks that drop out of the scan keep their last recorded price.</p></div>
      </section>`;
  }
  function trackShell() {
    return `<header><div><div class="eyebrow">Forward test · screen picks vs the S&amp;P 500</div><h1>Track Record</h1>
      <p>Does screening actually beat just owning the market? Each week the robot records what every screen picks, then this page tracks those picks against SPY.</p></div></header>
      <div id="track-body"><p class="muted">Loading…</p></div>`;
  }

  // ---------- option income page ----------
  const OKEY = "opt-settings-v1";
  let OD = null, OS = null, OSORT = { k: "ann", dir: -1 }, OSHOW = 40;
  const OF = [  // filters in funnel order; each tests one contract `c` on stock `s`
    { k: "ivr", name: "IV Rank", test: (s, c) => s.ivr != null && s.ivr >= OS.ivrMin, miss: s => `IV Rank ${s.ivr == null ? "n/a" : Math.round(s.ivr)}` },
    { k: "dte", name: "30–45 days out", test: (s, c) => c.dte >= OS.dteMin && c.dte <= OS.dteMax, miss: (s, c) => `${c.dte} DTE` },
    { k: "delta", name: "Delta", test: (s, c) => Math.abs(c.d) >= OS.deltaMin && Math.abs(c.d) <= OS.deltaMax, miss: (s, c) => `delta ${Math.abs(c.d).toFixed(2)}` },
    { k: "vol", name: "Volume", test: (s, c) => c.vol >= OS.volMin, miss: (s, c) => `volume ${c.vol.toLocaleString()}` },
    { k: "oi", name: "Open interest", test: (s, c) => c.oi >= OS.oiMin, miss: (s, c) => `OI ${c.oi.toLocaleString()}` },
    { k: "spr", name: "Bid-ask spread", test: (s, c) => c.spr <= OS.spreadMax, miss: (s, c) => `spread ${c.spr}%` },
    { k: "de", name: "Debt-to-equity", test: (s, c) => s.de != null && s.de < OS.deMax, miss: s => `D/E ${fx(s.de)}` },
    { k: "earn", name: "No earnings first", test: (s, c) => OS.earnings !== "avoid" || !earnBefore(s, c), miss: s => `earnings ${shortDate(s.ed)}` },
  ];
  const earnBefore = (s, c) => s.ed && s.ed >= new Date().toISOString().slice(0, 10) && s.ed <= c.x;
  const shortDate = d => d ? new Date(d + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" }) : "—";
  const usd = v => v == null ? "—" : "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function optShell() {
    const D = CFG.options.defaults;
    const num = (id, label, sfx, step, hint) => `
      <div class="crit"><div class="crit-top"><label for="${id}">${label}</label><span class="cnt" id="c-${id}"></span></div>
        <div class="field"><input id="${id}" type="number" step="${step}" min="0"><span>${sfx}</span></div>${hint ? `<small>${hint}</small>` : ""}</div>`;
    const pair = (a, b, label, sfx, step, hint) => `
      <div class="crit"><div class="crit-top"><label for="${a}">${label}</label><span class="cnt" id="c-${a}"></span></div>
        <div class="field"><input id="${a}" type="number" step="${step}" min="0" aria-label="${label} minimum"><span>to</span><input id="${b}" type="number" step="${step}" min="0" aria-label="${label} maximum"><span>${sfx}</span></div>${hint ? `<small>${hint}</small>` : ""}</div>`;
    return `
      <header><div><div class="eyebrow">Cash-secured puts &amp; covered calls · quality stocks only</div><h1>Option Income Finder</h1>
        <p>Finds options worth selling for monthly income: rich premiums (high IV Rank), liquid contracts with tight spreads, 30–45 days out at 0.20–0.30 delta, on low-debt companies that have made money every year, so being assigned leaves you owning a business you'd want anyway.</p></div>
        <div class="runbox"><div class="stamp" id="stamp">Loading…</div></div></header>
      <div class="desk" id="desk">
        <aside class="rail" aria-label="Filters">
          <div class="crit"><label for="o-type">Strategy</label>
            <select class="zsel" id="o-type"><option value="P">Cash-secured puts</option><option value="C">Covered calls</option><option value="B">Both</option></select></div>
          <hr>
          ${num("o-ivr", "IV Rank at least", "", 5, "Where today's implied volatility sits in its 1-year range. Above 50 means premiums are rich; above 70 is ideal.")}
          ${pair("o-dte1", "o-dte2", "Days to expiration", "days", 1, "Where time decay speeds up, before gamma risk near expiry.")}
          ${pair("o-d1", "o-d2", "Delta", "", 0.01, "0.20–0.30 delta ≈ 70–80% chance of expiring worthless.")}
          <hr>
          ${num("o-vol", "Volume at least", "contracts", 50, "Contracts traded today.")}
          ${num("o-oi", "Open interest at least", "contracts", 100)}
          ${num("o-spr", "Bid-ask spread under", "% of mid", 1, "Keeps you from losing the edge to slippage.")}
          <hr>
          ${num("o-de", "Debt-to-equity below", "×", 0.1, `Every stock scanned already has a profit in every reported year and positive trailing earnings, and is worth over $${CFG.options.minCapB}B.`)}
          <div class="crit"><label for="o-earn">Earnings before expiry</label>
            <select class="zsel" id="o-earn"><option value="avoid">Skip these trades</option><option value="flag">Show, with a warning</option></select>
            <small>High IV right before earnings is the market pricing a big move, not free premium.</small></div>
          <button type="button" class="reset" id="o-reset">Reset to the rules</button>
        </aside>
        <main>
          <div class="summary" id="o-summary"></div>
          <div class="funnel" id="o-funnel"></div>
          <section class="block"><div class="bhead"><div><h2>Best trade on each stock</h2><p id="o-picks-sub"></p></div></div><div class="picks" id="o-picks"></div></section>
          <section class="near" id="o-near" hidden></section>
          <section class="block"><div class="bhead"><div><h2>Every matching contract</h2><p>Click a column to sort. Click a ticker for its company report.</p></div>
            <div class="tools"><input type="search" id="o-q" placeholder="Filter ticker" aria-label="Filter by ticker"></div></div>
            <div class="tablebox" id="o-table"></div><div class="more" id="o-more"></div></section>
          <section class="notes">
            <div><h3>IV Rank</h3><p>Yahoo doesn't publish past implied volatility, so the scanner records each stock's 30-day at-the-money IV every trading day. Until a stock has ${CFG.options.ivr.minDays} days of readings, its rank is an estimate (marked “est.”) comparing today's IV with the past year's range of 30-day realized volatility. IV usually runs above realized volatility, so estimates lean high.</p></div>
            <div><h3>The numbers</h3><p>Implied volatility, delta and probability of profit are worked out from each contract's bid-ask midpoint with Black-Scholes. Return is the midpoint premium over the cash tied up (strike minus premium for a put, share price for a covered call), and annualized assumes you could repeat it all year. Probability of profit is the market-implied chance the trade makes money at expiry, not a forecast.</p></div>
            <div><h3>What can go wrong</h3><p>A put can be assigned at the strike after a crash, leaving you with a paper loss on shares below your breakeven; a covered call caps your upside if the stock rallies. Quotes are delayed and update once a day after the scan, so check the live price with your broker before placing an order. Not financial advice.</p></div>
          </section>
        </main>
      </div>`;
  }

  function optLoadSettings() {
    OS = { ...CFG.options.defaults };
    try { Object.assign(OS, JSON.parse(localStorage.getItem(OKEY) || "{}")); } catch (e) {}
  }
  function optSave() { try { localStorage.setItem(OKEY, JSON.stringify(OS)); } catch (e) {} }
  const OIN = { "o-ivr": "ivrMin", "o-dte1": "dteMin", "o-dte2": "dteMax", "o-d1": "deltaMin", "o-d2": "deltaMax", "o-vol": "volMin", "o-oi": "oiMin", "o-spr": "spreadMax", "o-de": "deMax" };
  function optSync() {
    for (const [id, k] of Object.entries(OIN)) $(id).value = OS[k];
    $("o-type").value = OS.type; $("o-earn").value = OS.earnings;
  }

  // Every contract on the board, with which filters it fails.
  function optEval() {
    const out = [];
    for (const s of OD.stocks) for (const c of s.c) {
      if (OS.type !== "B" && c.ty !== OS.type) continue;
      const fails = OF.filter(f => !f.test(s, c)).map(f => f.k);
      out.push({ s, c, fails, earn: earnBefore(s, c) });
    }
    return out;
  }

  function optRender() {
    const all = optEval();
    const pass = all.filter(x => !x.fails.length);
    const stocksHot = OD.stocks.filter(s => s.ivr != null && s.ivr >= OS.ivrMin).length;
    const best = {};
    for (const x of pass) if (!best[x.s.t] || x.c.ann > best[x.s.t].c.ann) best[x.s.t] = x;
    const picks = Object.values(best).sort((a, b) => b.c.ann - a.c.ann);
    const med = a => { if (!a.length) return null; const v = a.slice().sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };

    $("o-summary").innerHTML = `
      <div class="stat"><div class="eyebrow">Quality stocks</div><div class="v">${OD.stocks.length}</div><div class="s">with listed options, D/E under ${CFG.options.deMax}, profitable every year</div></div>
      <div class="stat"><div class="eyebrow">Rich premiums</div><div class="v">${stocksHot}</div><div class="s">with IV Rank ${OS.ivrMin}+</div></div>
      <div class="stat${pass.length ? " hot" : ""}"><div class="eyebrow">Trades that pass</div><div class="v">${pass.length}</div><div class="s">contracts on ${picks.length} stock${picks.length === 1 ? "" : "s"}</div></div>
      <div class="stat"><div class="eyebrow">Typical income</div><div class="v">${pass.length ? pct(med(pass.map(x => x.c.ret)), 2) : "—"}</div><div class="s">${pass.length ? `per trade (${pct(med(pass.map(x => x.c.ann)), 0)} a year), ${pct(med(pass.map(x => x.c.pop)), 0)} chance of profit` : "median premium per trade"}</div></div>`;

    // funnel: contracts surviving each filter in turn
    let left = all;
    const rows = [["Contracts scanned", all.length]];
    for (const f of OF) { left = left.filter(x => !x.fails.includes(f.k)); rows.push([f.name, left.length]); }
    const top = Math.max(1, all.length);
    $("o-funnel").innerHTML = `<h2>How the ${OS.type === "P" ? "puts" : OS.type === "C" ? "calls" : "contracts"} narrow down</h2>` + rows.map(([n, v]) =>
      `<div class="frow"><span>${esc(n)}</span><div class="ftrack"><div class="fbar" style="width:${(v / top * 100).toFixed(1)}%"></div></div><span class="num">${v.toLocaleString()}</span></div>`).join("");
    for (const [id, k] of Object.entries({ "o-ivr": "ivr", "o-dte1": "dte", "o-d1": "delta", "o-vol": "vol", "o-oi": "oi", "o-spr": "spr", "o-de": "de" }))
      $("c-" + id).textContent = all.filter(x => !x.fails.includes(k)).length.toLocaleString() + " pass";

    $("o-picks-sub").textContent = picks.length ? "Highest annualized income per stock among contracts that pass every filter." : "";
    $("o-picks").innerHTML = picks.length ? picks.slice(0, 12).map(x => optCard(x)).join("") :
      `<div class="empty">No contract passes every filter right now. The closest ones are below; loosen whichever filter they miss, or check back after the next scan.</div>`;

    // near misses: contracts failing exactly one filter (best per stock)
    const nearBy = {};
    for (const x of all) if (x.fails.length === 1 && (!nearBy[x.s.t] || x.c.ann > nearBy[x.s.t].c.ann)) nearBy[x.s.t] = x;
    const near = Object.values(nearBy).sort((a, b) => b.c.ann - a.c.ann).slice(0, 10);
    $("o-near").hidden = !near.length;
    $("o-near").innerHTML = `<div class="bhead"><div><h2>Almost</h2><p>Miss one filter. Best contract per stock.</p></div></div><div class="nlist">${near.map(x => {
      const f = OF.find(f => f.k === x.fails[0]);
      return `<button type="button" class="nrow onrow" data-analyze="${esc(x.s.t)}"><span class="nname"><span class="tk">${esc(x.s.t)}</span> <span class="ntxt">${optLabel(x.c)}</span></span>
        <span class="nmiss"><span class="chip miss">${esc(f.miss(x.s, x.c))}</span><span class="ntxt">${pct(x.c.ann, 0)}/yr · POP ${pct(x.c.pop, 0)}</span></span></button>`;
    }).join("")}</div>`;

    optTable(pass);
  }

  const optLabel = c => `${shortDate(c.x)} ${c.k % 1 ? c.k.toFixed(2) : c.k} ${c.ty === "P" ? "put" : "call"}`;
  function optCard({ s, c, earn }) {
    const cash = c.ty === "P" ? c.k * 100 : s.px * 100;
    return `<button type="button" class="pick" data-analyze="${esc(s.t)}">
      <div class="pick-top"><div><div class="tick">${esc(s.t)}</div><div class="pname">${esc(s.n)}</div></div>
        <div class="score">${pct(c.ann, 0)}<small>a year</small></div></div>
      <div class="opt-trade">Sell the <b>${optLabel(c)}</b> for <b>${usd(c.mid)}</b></div>
      <div class="mgrid">
        <div class="m ok"><b>Collect</b><span>$${Math.round(c.mid * 100).toLocaleString()}</span></div>
        <div class="m ok"><b>POP</b><span>${pct(c.pop, 0)}</span></div>
        <div class="m ok"><b>Delta</b><span>${Math.abs(c.d).toFixed(2)}</span></div>
        <div class="m ok"><b>IVR</b><span>${Math.round(s.ivr)}${s.est ? "*" : ""}</span></div>
        <div class="m ok"><b>DTE</b><span>${c.dte}</span></div>
      </div>
      <div class="opt-facts">Stock ${usd(s.px)} · strike ${pct(c.otm, 1)} ${c.ty === "P" ? "below" : "above"} · breakeven ${usd(c.be)}<br>
        ${c.ty === "P" ? `Secures ${usd(cash)} cash` : `Needs 100 shares (${usd(cash)})`} · ${pct(c.ret, 2)} in ${c.dte} days</div>
      <div class="chips"><span class="chip">vol ${c.vol.toLocaleString()}</span><span class="chip">OI ${c.oi.toLocaleString()}</span><span class="chip">spread ${c.spr}%</span>${earn ? `<span class="chip warn">earnings ${shortDate(s.ed)}</span>` : ""}${s.est ? `<span class="chip warn" title="IV Rank estimated from realized volatility until enough IV history is recorded">IVR est.</span>` : ""}</div>
    </button>`;
  }

  const OCOLS = [
    ["t", "Ticker", x => x.s.t], ["ty", "Type", x => x.c.ty], ["k", "Strike", x => x.c.k], ["x", "Expires", x => x.c.x], ["dte", "DTE", x => x.c.dte],
    ["d", "Delta", x => Math.abs(x.c.d)], ["pop", "POP", x => x.c.pop], ["mid", "Premium", x => x.c.mid], ["spr", "Spread", x => x.c.spr],
    ["vol", "Volume", x => x.c.vol], ["oi", "Open int.", x => x.c.oi], ["iv", "IV", x => x.c.iv], ["ivr", "IVR", x => x.s.ivr],
    ["otm", "OTM", x => x.c.otm], ["be", "Breakeven", x => x.c.be], ["ret", "Return", x => x.c.ret], ["ann", "Annual", x => x.c.ann], ["ed", "Earnings", x => x.s.ed || "9999"],
  ];
  function optTable(pass) {
    const q = $("o-q").value.trim().toUpperCase();
    const col = OCOLS.find(c => c[0] === OSORT.k);
    const rows = pass.filter(x => !q || x.s.t.startsWith(q)).sort((a, b) => { const p = col[2](a), r = col[2](b); return (p > r ? 1 : p < r ? -1 : 0) * OSORT.dir; });
    if (!rows.length) { $("o-table").innerHTML = `<div class="empty">No contracts match.</div>`; $("o-more").innerHTML = ""; return; }
    $("o-table").innerHTML = `<table class="otab"><thead><tr>${OCOLS.map(([k, n]) => `<th data-k="${k}" class="${k === "t" || k === "ty" || k === "x" || k === "ed" ? "" : "r"}${k === OSORT.k ? " sorted" : ""}">${n}${k === OSORT.k ? (OSORT.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.slice(0, OSHOW).map(({ s, c, earn }) => `<tr>
        <td><a href="#" class="tk" data-analyze="${esc(s.t)}">${esc(s.t)}</a></td><td>${c.ty === "P" ? "Put" : "Call"}</td><td class="n">${c.k}</td><td>${shortDate(c.x)}</td><td class="n">${c.dte}</td>
        <td class="n">${Math.abs(c.d).toFixed(2)}</td><td class="n">${pct(c.pop, 0)}</td><td class="n">${usd(c.mid)}</td><td class="n">${c.spr}%</td>
        <td class="n">${c.vol.toLocaleString()}</td><td class="n">${c.oi.toLocaleString()}</td><td class="n">${pct(c.iv, 0)}</td><td class="n">${Math.round(s.ivr)}${s.est ? "*" : ""}</td>
        <td class="n">${pct(c.otm, 1)}</td><td class="n">${usd(c.be)}</td><td class="n">${pct(c.ret, 2)}</td><td class="n ok">${pct(c.ann, 0)}</td>
        <td class="${earn ? "bad" : "na"}">${s.ed ? shortDate(s.ed) : "—"}</td></tr>`).join("")}</tbody></table>`;
    $("o-more").innerHTML = rows.length > OSHOW ? `<button type="button" class="ghost" id="o-showmore">Show ${Math.min(40, rows.length - OSHOW)} more of ${rows.length - OSHOW}</button>` : "";
  }

  function optWire() {
    for (const [id, k] of Object.entries(OIN)) $(id).addEventListener("input", e => { const v = parseFloat(e.target.value); if (isNaN(v)) return; OS[k] = v; optSave(); optRender(); });
    $("o-type").addEventListener("change", e => { OS.type = e.target.value; optSave(); optRender(); });
    $("o-earn").addEventListener("change", e => { OS.earnings = e.target.value; optSave(); optRender(); });
    $("o-reset").addEventListener("click", () => { OS = { ...CFG.options.defaults }; optSave(); optSync(); optRender(); });
    $("o-q").addEventListener("input", () => { OSHOW = 40; optRender(); });
    $("app").addEventListener("click", e => {
      const th = e.target.closest(".otab th[data-k]");
      if (th) { const k = th.dataset.k; OSORT = { k, dir: OSORT.k === k ? -OSORT.dir : (k === "t" || k === "x" || k === "ed" || k === "spr" || k === "dte" ? 1 : -1) }; optRender(); return; }
      if (e.target.id === "o-showmore") { OSHOW += 40; optRender(); return; }
      const a = e.target.closest("[data-analyze]"); if (a) { e.preventDefault(); analyze(a.dataset.analyze); }
    });
  }

  async function optBoot() {
    $("app").innerHTML = topbar() + optShell();
    wireLookup(); wireVoice(); optLoadSettings(); optSync(); optWire();
    try {
      OD = await getJSON("options.json", true);
      const at = new Date(OD.at), ageH = (Date.now() - at) / 36e5;
      $("stamp").innerHTML = `Option chains <b>${at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</b> (${ageH < 1 ? "under an hour ago" : ageH < 48 ? Math.round(ageH) + " hours ago" : Math.round(ageH / 24) + " days ago"})<br>${OD.stocks.length} stocks · ${OD.stocks.reduce((a, s) => a + s.c.length, 0).toLocaleString()} contracts`;
      optRender();
    } catch (e) {
      $("stamp").textContent = "Could not load option data.";
      document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="err">The option scan hasn't loaded (${esc(e.message)}). It runs each weekday afternoon while the market is open.</div>`);
    }
    fillLookupList();
  }

  async function specialBoot() {
    document.title = `${P.title} · MacStocks`;
    $("app").innerHTML = topbar() + `<div class="special">${P.kind === "mine" ? mineShell() : trackShell()}</div>`;
    wireLookup(); wireVoice();
    if (P.kind === "mine") { wireMine(); renderMine(); } else renderTrack();
    $("app").addEventListener("click", e => {
      const a = e.target.closest(".tpicks [data-analyze]"); if (a) analyze(a.dataset.analyze);
    });
    fillLookupList();
  }

  async function boot() {
    try { CFG = await getJSON("config.json", true); }
    catch (e) { document.getElementById("app").innerHTML = `<div class="err">Could not load the site configuration (${esc(e.message)}).</div>`; return; }
    P = CFG.pages[PID];
    if (P.kind === "mine" || P.kind === "track") return specialBoot();
    if (P.kind === "options") { document.title = `${P.title} · MacStocks`; return optBoot(); }
    DEF = defaults();
    S = { ...DEF };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY()) || "{}");
      if (typeof saved.showSettings === "boolean") S.showSettings = saved.showSettings;
      save();  // drops any screening settings stored by older versions
    } catch (e) {}
    shell(); syncInputs(); wire(); wireLookup(); wireVoice();
    await load(false);
    fillLookupList();
  }
  boot();
})();
