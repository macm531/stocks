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
  };

  // 5-year mini chart (weekly closes, every 4th week). Green when the trend is steady and rising.
  function spark(r, w = 96, h = 26) {
    const p = r.spark;
    if (!p || p.length < 2) return `<span class="spark-na">—</span>`;
    const lo = Math.min(...p), hi = Math.max(...p), span = hi - lo || 1;
    const pts = p.map((v, i) => `${(i / (p.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - (v - lo) / span * (h - 4)).toFixed(1)}`).join(" ");
    const good = r.r2 != null && r.r2 >= S.r2 && r.cagr5 != null && r.cagr5 * 100 >= S.cagr;
    return `<svg class="spark ${good ? "up" : "flat"}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="5-year price chart"><polyline points="${pts}" fill="none" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  const trendTxt = r => r.r2 == null ? "No 5-year history" : `R² ${r.r2.toFixed(2)} · ${r.cagr5 >= 0 ? "+" : ""}${(r.cagr5 * 100).toFixed(0)}%/yr`;

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
  let sortK = null, sortDir = -1, shown = 60, open = new Set(), baseCount = 0;
  const KEY = () => "vqs-settings-" + PID;
  // Tests the viewer has switched on; everything that counts passes uses these.
  const on = t => !(S.off && S.off[t.k]);
  const AT = () => P.tests.filter(on);
  const NT = () => AT().length;
  const zmin = () => Math.min(CFG.minPasses, NT());
  const isStock = () => P.kind === "stock";

  // ---------- layout ----------
  function shell() {
    document.title = P.title;
    const nav = Object.entries(CFG.pages).map(([id, p]) =>
      `<a class="tab" href="${p.file}"${id === PID ? ' aria-current="page"' : ""}>${esc(p.nav)}</a>`).join("");
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
  <nav class="topnav" aria-label="Pages"><a class="brand" href="index.html">Stock Desk</a>${nav}</nav>
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
      <div class="eyebrow">Chart shape</div>
      <label class="sw"><input id="o-trend" type="checkbox"><i></i><span><b>Only steady uptrends</b><br><span style="color:var(--muted);font-weight:400">5-year charts that climb up and to the right</span></span></label>
      <div class="crit" id="crit-trend">
        <div class="crit-top"><label for="o-r2">Trend steadiness at least</label><span class="cnt" id="c-trend"></span></div>
        <div class="field"><input id="o-r2" type="number" step="0.05" min="0" max="1"><span>R² (0–1)</span></div>
        <small>How closely the 5-year price follows a straight rising line on a log scale. NVDA and CAT score about 0.88; a choppy sideways chart scores under 0.5.</small>
      </div>
      <div class="crit" id="crit-trend2">
        <label for="o-cagr">5-year price growth at least</label>
        <div class="field"><input id="o-cagr" type="number" step="1"><span>% a year</span></div>
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
        <small>Picks passing ${CFG.minPasses}+ of the tests you have on (or all of them, if fewer are on) that are in this zone show in the buy zone. Email alerts always use the default settings.</small>
      </div>
      <button class="reset" id="reset" type="button">Reset to defaults</button>
    </aside>
    <main style="min-width:0">
      <div class="summary" id="summary"></div>
      <div class="funnel"><h2>Screening funnel</h2><div id="funnel"></div></div>
      <section class="block">
        <div class="bhead"><div><h2>Buy zone</h2><p id="zone-desc">Passing ${CFG.minPasses}+ tests and in the buy zone you set on the left. These trigger email alerts.</p></div></div>
        <div class="picks" id="zone"></div>
      </section>
      <section class="block">
        <div class="bhead"><div><h2>Top picks</h2><p id="picks-desc"></p></div></div>
        <div class="picks" id="picks"></div>
      </section>
      <section class="block">
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
    const d = { off: {}, zoneOn: true, showSettings: true, low: CFG.lowPct, trendOn: CFG.trend.on, r2: CFG.trend.r2, cagr: CFG.trend.cagr, zmode: CFG.zone.mode, pull: CFG.zone.pullback, pullMax: CFG.zone.pullbackMax };
    for (const t of P.tests) d[t.k] = t.t;
    if (isStock()) Object.assign(d, { sector: !!P.sectorPE, fin: !!P.excludeFin, mcap: P.minCapB || 0, ...CFG.dcf });
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
    ["crit-trend", "crit-trend2"].forEach(id => $(id).classList.toggle("off", !S.trendOn));
    $("o-r2").disabled = $("o-cagr").disabled = !S.trendOn;
    $("desk").classList.toggle("nosettings", !S.showSettings);
    $("toggle-settings").textContent = S.showSettings ? "Hide settings" : "Show settings";
    $("toggle-settings").setAttribute("aria-expanded", S.showSettings);
    $("o-low").value = S.low; $("o-pull").value = S.pull; $("o-pullmax").value = S.pullMax; $("o-zmode").value = S.zmode;
    $("o-trend").checked = S.trendOn; $("o-r2").value = S.r2; $("o-cagr").value = S.cagr;
    $("zone-low").hidden = S.zmode !== "low"; $("zone-pull").hidden = S.zmode !== "pullback";
    if (isStock()) {
      if ($("o-sector")) $("o-sector").checked = S.sector;
      $("o-fin").checked = S.fin; $("o-mcap").value = S.mcap;
      $("o-disc").value = S.disc; $("o-term").value = S.term; $("o-gcap").value = S.gcap;
    }
  }
  function save() { try { localStorage.setItem(KEY(), JSON.stringify(S)); } catch (e) {} }

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

  const steady = r => r.r2 != null && r.r2 >= S.r2 && r.cagr5 != null && r.cagr5 * 100 >= S.cagr;
  function inUniverse(r, ignoreTrend) {
    if (S.trendOn && !ignoreTrend && !steady(r)) return false;
    if (P.universe === "bc" && !r.bc) return false;
    if (isStock() && S.fin && FIN.has(r.sec)) return false;
    if (isStock() && (r.mc || 0) < S.mcap * 1e9) return false;
    return true;
  }

  function rankAll() {
    baseCount = DATA.rows.filter(r => inUniverse(r, true)).length;
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
  const chipMuted = txt => `<span class="chip" style="background:var(--track);color:var(--muted)">${txt}</span>`;

  function renderSummary() {
    const N = NT(), all5 = ranked.filter(r => r.passes === N).length, four = ranked.filter(r => r.passes === N - 1).length;
    const zone = ranked.filter(r => r.passes >= zmin() && r.nearLow).length;
    $("summary").innerHTML = `
      <div class="stat${all5 ? " hot" : ""}"><div class="eyebrow">Pass all ${N}</div><div class="v">${all5}</div><div class="s">full matches</div></div>
      <div class="stat"><div class="eyebrow">Pass ${N - 1} of ${N}</div><div class="v">${four}</div><div class="s">near misses</div></div>
      <div class="stat${zone ? " hot" : ""}"><div class="eyebrow">In buy zone</div><div class="v">${zone}</div><div class="s">${S.zmode === "low" ? "near 52-week low" : "pulled back from high"}</div></div>
      <div class="stat"><div class="eyebrow">Screened</div><div class="v">${ranked.length.toLocaleString()}</div><div class="s">${isStock() ? (P.universe === "bc" ? "S&amp;P 100 + Dow 30" : "of " + DATA.universe.toLocaleString() + " in the S&amp;P 1500") : "equity ETFs"}</div></div>`;
  }

  function renderFunnel() {
    let set = ranked, max = baseCount || 1, html = "";
    const row = (name, n) => `<div class="frow"><span>${name}</span><div class="ftrack"><div class="fbar" style="width:${Math.max(n ? 0.6 : 0, n / max * 100)}%"></div></div><span class="num">${n}</span></div>`;
    if (S.trendOn) html += row(isStock() ? "Universe" : "All funds", baseCount);
    $("c-trend").textContent = S.trendOn ? ranked.length + " steady" : "off";
    const steps = [[S.trendOn ? "Steady uptrend" : (isStock() ? "Universe" : "All funds"), () => true], ...AT().map((t, i) => [(i ? "+ " : "") + META[t.k].title.replace(/ (below|above)$/, ""), r => r.ev[t.k].pass])];
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
        <div class="pick-top"><div><div class="tick">${esc(r.t)}</div><div class="pname">${sub(r)}</div></div>
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
        <div class="pick-top"><div><div class="tick">${esc(r.t)}</div><div class="pname">${sub(r)} · ${r.passes}/${NT()} tests</div></div>
          <div class="score">${pb ? (r.fromHigh * 100).toFixed(1) + "%<small>from high</small>" : "+" + (r.fromLow * 100).toFixed(1) + "%<small>above low</small>"}</div></div>
        <div class="sparkrow">${spark(r, 220, 40)}<span>${trendTxt(r)}</span></div>
        <div class="range"><span class="mono">$${fx(r.lo52)}</span><div class="rtrack"><i style="left:${(r.rangePos ?? 0) * 100}%"></i></div><span class="mono">$${fx(r.hi52)}</span></div>
        <div class="chips">${chipMuted(`Price $${fx(r.px)} · score ${r.score}`)}${r.warn.length ? `<span class="chip warn">Check data</span>` : ""}</div>
      </button>`).join("");
  }

  function why(r) {
    const lines = P.tests.map(t => {
      const m = META[t.k], e = r.ev[t.k];
      let txt;
      if (e.na) txt = "No data.";
      else if (m.bad && m.bad(r)) txt = m.bad(r);
      else {
        txt = `${m.show(r)} vs ${t.dir === "lt" ? "limit" : "bar"} ${S[t.k]}${["×", "%"].includes(m.sfx) ? m.sfx : " " + m.sfx}.`;
        if (t.k === "pe" && isStock()) txt += ` Sector median ${fx(e.secMed, 1)}×${S.sector && !e.underSec ? " (above it)" : ""}.`;
        if (t.k === "peg" && r.pegs === "calc") txt += " Calculated from trailing growth.";
      }
      if (!on(t)) return `<div class="na off"><b>Off · ${m.title.replace(/ (below|above)$/, "")}</b>${m.show(r)} (not counted)</div>`;
      return `<div class="${cls(e)}"><b>${e.na ? "No data" : e.pass ? "Pass" : "Fail"} · ${m.title.replace(/ (below|above)$/, "")}</b>${txt}</div>`;
    }).join("");
    const extra = isStock()
      ? `<span>${esc(r.ind)}</span><span>Price $${fx(r.px)}</span><span>Fwd P/E ${fx(r.fpe, 1)}</span>
         <span>Earnings growth ${pct(r.eg, 0)}</span><span>Revenue growth ${pct(r.rg, 0)}</span><span>ROE ${pct(r.roe, 0)}</span>
         <span>Div. yield ${r.dy == null ? "—" : r.dy.toFixed(2) + "%"}</span><span>${esc(r.idx)}</span>`
      + `<span>Analyst target ${r.up == null ? "—" : (r.up >= 0 ? "+" : "") + (r.up * 100).toFixed(0) + "%"}</span>`
      : `<span>${esc(r.fam)}</span><span>${esc(r.grp)}</span><span>Price $${fx(r.px)}</span><span>3-yr ${pct(r.r3, 1)}/yr</span>
         <span>YTD ${r.ytd == null ? "—" : r.ytd.toFixed(1) + "%"}</span><span>Beta ${fx(r.beta)}</span>`;
    const dcfTxt = !isStock() ? "" : r.iv == null || r.iv <= 0
      ? `<p class="dcf">${META.mos.bad(r) || "DCF not available (missing free cash flow or share count)."}</p>`
      : `<p class="dcf"><b>DCF intrinsic value $${fx(r.iv)}</b> a share vs price $${fx(r.px)}: ${r.mos >= 0 ? pct(r.mos, 0) + " margin of safety" : pct(-r.mos, 0) + " above value"}.
         Built from ${money(r.fcf0)} average free cash flow, growing ${pct(r.dcfg, 1)} a year for 5 years then fading to ${S.term}%, discounted at ${S.disc}%, plus ${r.netcash >= 0 ? "net cash" : "net debt of"} ${money(Math.abs(r.netcash))}.</p>`;
    const hist = !isStock() || !r.h || !r.h.y.length ? "" : `<div class="hist"><table><thead><tr><th>Year</th>${r.h.y.map(y => `<th class="r">${y}</th>`).join("")}</tr></thead><tbody>
      <tr><td>ROE</td>${r.h.roe.map(v => `<td class="n${v != null && v >= 0.15 ? " ok" : ""}">${pct(v, 0)}</td>`).join("")}</tr>
      <tr><td>Net margin</td>${r.h.nm.map(v => `<td class="n">${pct(v, 1)}</td>`).join("")}</tr>
      <tr><td>Free cash flow</td>${r.h.fcf.map(v => `<td class="n${v != null && v < 0 ? " bad" : ""}">${money(v)}</td>`).join("")}</tr>
      </tbody></table></div>`;
    const trendLine = `<p class="dcf"><b>5-year chart:</b> ${r.r2 == null ? "not enough price history." : `steadiness R² ${r.r2.toFixed(2)} (${steady(r) ? "passes" : "below"} your ${S.r2} bar), ${(r.cagr5 * 100).toFixed(1)}% a year, worst drop along the way ${(r.maxdd * 100).toFixed(0)}%. Now ${(r.fromHigh * 100).toFixed(1)}% from its 52-week high.`}</p>`;
    return `<div class="why">${lines}</div>${trendLine}${dcfTxt}${hist}
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
        <td><span class="tk">${esc(r.t)}</span> <span class="nm">${esc(r.n)}</span> ${r.isNew ? '<span class="chip new">New</span>' : ""}${r.warn.length ? ' <span class="chip warn">check</span>' : ""}</td>
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
  }

  function minpOptions() {
    const N = NT(), cur = $("minp").value;
    const opts = [["0", "All"]];
    for (let k = Math.max(1, N - 2); k < N; k++) opts.push([String(k), `${k}+ tests passed`]);
    if (N) opts.push([String(N), `All ${N} passed`]);
    $("minp").innerHTML = opts.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
  }
  function renderAll() { minpOptions(); rankAll(); renderSummary(); renderFunnel(); renderZone(); renderPicks(); renderTable(); }

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
    num("o-low", "low"); num("o-pull", "pull"); num("o-pullmax", "pullMax"); num("o-r2", "r2"); num("o-cagr", "cagr");
    $("o-trend").addEventListener("change", e => { S.trendOn = e.target.checked; save(); syncInputs(); renderAll(); });
    $("o-zmode").addEventListener("change", e => { S.zmode = e.target.value; save(); syncInputs(); renderAll(); });
    if (isStock()) {
      num("o-mcap", "mcap"); num("o-disc", "disc"); num("o-term", "term"); num("o-gcap", "gcap");
      if ($("o-sector")) $("o-sector").addEventListener("change", e => { S.sector = e.target.checked; save(); renderAll(); });
      $("o-fin").addEventListener("change", e => { S.fin = e.target.checked; save(); renderAll(); });
    }
    $("reset").addEventListener("click", () => { S = { ...DEF, off: {} }; save(); syncInputs(); renderAll(); });
    $("run").addEventListener("click", () => load(true));
    ["q", "minp", "sec"].forEach(id => $(id).addEventListener("input", () => { shown = 60; renderTable(); }));
    $("more").addEventListener("click", () => { shown += 60; renderTable(); });
    document.querySelectorAll("th[data-k]").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.k, lt = P.tests.find(t => t.k === k)?.dir === "lt";
      if (sortK === k) { if (sortDir === -1) sortDir = 1; else { sortK = null; sortDir = -1; } }
      else { sortK = k; sortDir = (["t", "grp", "fromLow"].includes(k) || lt) ? 1 : -1; }
      renderTable();
    }));
    const toggle = t => { open.has(t) ? open.delete(t) : open.add(t); renderTable(); };
    $("tb").addEventListener("click", e => { const tr = e.target.closest("tr.main"); if (tr && !e.target.closest("a")) toggle(tr.dataset.t); });
    $("tb").addEventListener("keydown", e => { const tr = e.target.closest("tr.main"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(tr.dataset.t); } });
    ["picks", "zone"].forEach(id => $(id).addEventListener("click", e => {
      const p = e.target.closest(".pick"); if (!p) return;
      const t = p.dataset.t; open.add(t); $("q").value = t; $("minp").value = "0"; $("sec").value = ""; renderTable();
      $("tb").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  async function boot() {
    try { CFG = await getJSON("config.json", true); }
    catch (e) { document.getElementById("app").innerHTML = `<div class="err">Could not load the site configuration (${esc(e.message)}).</div>`; return; }
    P = CFG.pages[PID];
    DEF = defaults();
    S = { ...DEF };
    try { Object.assign(S, JSON.parse(localStorage.getItem(KEY()) || "{}")); } catch (e) {}
    shell(); syncInputs(); wire(); load(false);
  }
  boot();
})();
