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
  };

  let CFG, P, PID = window.PAGE_ID, DATA = null, ranked = [], S = {}, DEF = {};
  let sortK = null, sortDir = -1, shown = 60, open = new Set();
  const KEY = () => "vqs-settings-" + PID;
  const isStock = () => P.kind === "stock";

  // ---------- layout ----------
  function shell() {
    document.title = P.title;
    const nav = Object.entries(CFG.pages).map(([id, p]) =>
      `<a class="tab" href="${p.file}"${id === PID ? ' aria-current="page"' : ""}>${esc(p.nav)}</a>`).join("");
    const crit = P.tests.map(t => { const m = META[t.k]; return `
      <div class="crit">
        <div class="crit-top"><label for="t-${t.k}">${m.title}</label><span class="cnt" id="c-${t.k}"></span></div>
        <div class="field"><input id="t-${t.k}" type="number" step="${m.step}" min="0"><span>${m.sfx}</span></div>
        ${t.k === "pe" && isStock() ? `<label class="opt"><input id="o-sector" type="checkbox"> Also below its sector's median P/E</label>` : ""}
        <small>${m.hint}</small>
      </div>`; }).join("");
    const stockOpts = isStock() ? `
      <label class="opt"><input id="o-fin" type="checkbox"> Exclude financials and real estate <span style="color:var(--muted)">(D/E and ROIC don't apply to banks and REITs)</span></label>
      <div class="crit"><label for="o-mcap">Minimum market cap</label>
        <div class="field"><input id="o-mcap" type="number" step="0.5" min="0"><span>$ billion</span></div></div>` : "";
    const metricTh = P.tests.map(t => `<th data-k="${t.k}" class="r">${META[t.k].label}</th>`).join("");
    const extraTh = isStock()
      ? `<th data-k="up" class="r">To target</th><th data-k="mc" class="r">Mkt cap</th>`
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
      <button class="run" id="run" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>
        Run scan
      </button>
    </div>
  </header>
  <div class="desk">
    <aside class="rail" aria-label="Screening criteria">
      <div class="eyebrow">Criteria</div>
      ${crit}
      <hr>
      ${stockOpts}
      <div class="crit">
        <div class="crit-top"><label for="o-low">Buy zone: within</label><span class="cnt" id="c-low"></span></div>
        <div class="field"><input id="o-low" type="number" step="1" min="0"><span>% of 52-week low</span></div>
        <small>Picks passing ${CFG.minPasses}+ tests this close to their 52-week low show in the buy zone. Email alerts use the default thresholds.</small>
      </div>
      <button class="reset" id="reset" type="button">Reset to defaults</button>
    </aside>
    <main style="min-width:0">
      <div class="summary" id="summary"></div>
      <div class="funnel"><h2>Screening funnel</h2><div id="funnel"></div></div>
      <section class="block">
        <div class="bhead"><div><h2>Buy zone</h2><p>Passing ${CFG.minPasses}+ tests and trading near the 52-week low, closest first. These trigger email alerts.</p></div></div>
        <div class="picks" id="zone"></div>
      </section>
      <section class="block">
        <div class="bhead"><div><h2>Top picks</h2><p>Passing all five tests, best composite score first.</p></div></div>
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
            <th data-k="fromLow" class="r">Above 52w low</th>${extraTh}</tr></thead>
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
    const d = { low: CFG.lowPct };
    for (const t of P.tests) d[t.k] = t.t;
    if (isStock()) Object.assign(d, { sector: !!P.sectorPE, fin: !!P.excludeFin, mcap: P.minCapB || 0 });
    return d;
  }
  function syncInputs() {
    for (const t of P.tests) $("t-" + t.k).value = S[t.k];
    $("o-low").value = S.low;
    if (isStock()) { $("o-sector").checked = S.sector; $("o-fin").checked = S.fin; $("o-mcap").value = S.mcap; }
  }
  function save() { try { localStorage.setItem(KEY(), JSON.stringify(S)); } catch (e) {} }

  // ---------- scoring ----------
  function evaluate(r) {
    const ev = {};
    for (const t of P.tests) {
      const m = META[t.k], v = r[t.k], T = S[t.k];
      if (v == null) { ev[t.k] = { pass: false, s: 0, na: true }; continue; }
      if (m.valid && !m.valid(v)) { ev[t.k] = { pass: false, s: 0 }; continue; }
      const x = m.unit(v);
      let pass = t.dir === "lt" ? x < T : x > T;
      const s = t.dir === "lt" ? (x <= 0.5 * T ? 1 : clamp((1.5 * T - x) / T)) : clamp((x - T / 3) / (T * 1.67 - T / 3));
      const e = { pass, s };
      if (t.k === "pe" && isStock()) {
        e.secMed = DATA.medians[r.sec] ?? DATA.medians._market;
        e.underSec = !S.sector || e.secMed == null || v < e.secMed;
        e.pass = pass && e.underSec;
      }
      ev[t.k] = e;
    }
    const passes = P.tests.filter(t => ev[t.k].pass).length;
    const score = Math.round(P.tests.reduce((a, t) => a + ev[t.k].s, 0) / P.tests.length * 100);
    const warn = [];
    if (r.peg != null && r.peg > 0 && r.peg < 0.2) warn.push("PEG");
    if (r.fcfy != null && r.fcfy > 0.25) warn.push("FCF");
    if (r.roic != null && r.roic > 0.8) warn.push("ROIC");
    if (!isStock() && r.pe != null && r.pe > 80) warn.push("P/E");
    const fromLow = r.lo52 && r.px ? r.px / r.lo52 - 1 : null;
    return { ...r, grp: isStock() ? r.sec : (r.cat || r.grp), ev, passes, score, warn, fromLow,
      up: r.tgt && r.px ? r.tgt / r.px - 1 : null,
      rangePos: r.lo52 && r.hi52 && r.hi52 > r.lo52 && r.px ? clamp((r.px - r.lo52) / (r.hi52 - r.lo52)) : null,
      nearLow: fromLow != null && fromLow <= S.low / 100 };
  }

  function inUniverse(r) {
    if (P.universe === "bc" && !r.bc) return false;
    if (isStock() && S.fin && FIN.has(r.sec)) return false;
    if (isStock() && (r.mc || 0) < S.mcap * 1e9) return false;
    return true;
  }

  function rankAll() {
    ranked = DATA.rows.filter(inUniverse).map(evaluate).sort((a, b) => b.passes - a.passes || b.score - a.score);
    ranked.forEach((r, i) => r.rank = i + 1);
    const prevPass = new Set();
    if (DATA.prev) {
      const byT = new Map(DATA.rows.map(x => [x.t, x]));
      for (const [t, m] of Object.entries(DATA.prev.rows)) {
        const cur = byT.get(t);
        if (cur && inUniverse(cur) && evaluate({ ...cur, ...m }).passes === 5) prevPass.add(t);
      }
    }
    ranked.forEach(r => r.isNew = !!DATA.prev && r.passes === 5 && !prevPass.has(r.t));
  }

  // ---------- render ----------
  const cls = e => e.na ? "na" : e.pass ? "ok" : "bad";
  const chipMuted = txt => `<span class="chip" style="background:var(--track);color:var(--muted)">${txt}</span>`;

  function renderSummary() {
    const all5 = ranked.filter(r => r.passes === 5).length, four = ranked.filter(r => r.passes === 4).length;
    const zone = ranked.filter(r => r.passes >= CFG.minPasses && r.nearLow).length;
    $("summary").innerHTML = `
      <div class="stat${all5 ? " hot" : ""}"><div class="eyebrow">Pass all 5</div><div class="v">${all5}</div><div class="s">full matches</div></div>
      <div class="stat"><div class="eyebrow">Pass 4 of 5</div><div class="v">${four}</div><div class="s">near misses</div></div>
      <div class="stat${zone ? " hot" : ""}"><div class="eyebrow">In buy zone</div><div class="v">${zone}</div><div class="s">near 52-week low</div></div>
      <div class="stat"><div class="eyebrow">Screened</div><div class="v">${ranked.length.toLocaleString()}</div><div class="s">${isStock() ? (P.universe === "bc" ? "S&amp;P 100 + Dow 30" : "of " + DATA.universe.toLocaleString() + " in the S&amp;P 1500") : "equity ETFs"}</div></div>`;
  }

  function renderFunnel() {
    let set = ranked, max = ranked.length || 1, html = "";
    const steps = [[isStock() ? "Universe" : "All funds", () => true], ...P.tests.map((t, i) => [(i ? "+ " : "") + META[t.k].title.replace(/ (below|above)$/, ""), r => r.ev[t.k].pass])];
    for (const [name, f] of steps) {
      set = set.filter(f);
      html += `<div class="frow"><span>${name}</span><div class="ftrack"><div class="fbar" style="width:${Math.max(set.length ? 0.6 : 0, set.length / max * 100)}%"></div></div><span class="num">${set.length}</span></div>`;
    }
    $("funnel").innerHTML = html;
    for (const t of P.tests) $("c-" + t.k).textContent = ranked.filter(r => r.ev[t.k].pass).length + " pass";
    $("c-low").textContent = ranked.filter(r => r.nearLow).length + " near";
  }

  const mgrid = r => `<div class="mgrid">${P.tests.map(t => `<div class="m ${cls(r.ev[t.k])}"><b>${META[t.k].label}</b><span>${META[t.k].show(r)}</span></div>`).join("")}</div>`;
  function chips(r) {
    let h = "";
    if (r.isNew) h += `<span class="chip new">New</span>`;
    if (r.nearLow) h += `<span class="chip new">Near 52-wk low</span>`;
    if (r.warn.length) h += `<span class="chip warn">Check data: ${r.warn.join(", ")}</span>`;
    return h;
  }
  const sub = r => isStock() ? `${esc(r.n)} · ${esc(r.sec)}` : `${esc(r.n)}`;
  const extraChip = r => isStock()
    ? chipMuted(`${money(r.mc)}${r.up != null ? " · target " + (r.up >= 0 ? "+" : "") + (r.up * 100).toFixed(0) + "%" : ""}`)
    : chipMuted(`${esc(r.cat || r.grp)} · 3-yr ${pct(r.r3, 1)}`);

  function renderPicks() {
    const top = ranked.filter(r => r.passes === 5).slice(0, 9);
    const pool = top.length ? top : ranked.filter(r => r.passes === 4).slice(0, 6);
    if (!pool.length) { $("picks").innerHTML = `<div class="empty">Nothing passes four or more tests at these thresholds. Loosen a criterion on the left.</div>`; return; }
    const note = top.length ? "" : `<div class="empty" style="grid-column:1/-1">Nothing passes all five tests right now. Showing the best near misses (4 of 5).</div>`;
    $("picks").innerHTML = note + pool.map(r => `
      <button class="pick" type="button" data-t="${esc(r.t)}">
        <div class="pick-top"><div><div class="tick">${esc(r.t)}</div><div class="pname">${sub(r)}</div></div>
          <div class="score">${r.score}<small>score</small></div></div>
        ${mgrid(r)}
        <div class="chips">${chips(r)}${extraChip(r)}</div>
      </button>`).join("");
  }

  function renderZone() {
    const z = ranked.filter(r => r.passes >= CFG.minPasses && r.nearLow).sort((a, b) => a.fromLow - b.fromLow);
    if (!z.length) { $("zone").innerHTML = `<div class="empty">Nothing passing ${CFG.minPasses}+ tests is within ${S.low}% of its 52-week low right now.</div>`; return; }
    $("zone").innerHTML = z.map(r => `
      <button class="pick" type="button" data-t="${esc(r.t)}">
        <div class="pick-top"><div><div class="tick">${esc(r.t)}</div><div class="pname">${sub(r)} · ${r.passes}/5 tests</div></div>
          <div class="score">+${(r.fromLow * 100).toFixed(1)}%<small>above low</small></div></div>
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
        txt = `${m.show(r)} vs ${t.dir === "lt" ? "limit" : "bar"} ${S[t.k]}${m.sfx === "×" ? "×" : " " + m.sfx}.`;
        if (t.k === "pe" && isStock()) txt += ` Sector median ${fx(e.secMed, 1)}×${S.sector && !e.underSec ? " (above it)" : ""}.`;
        if (t.k === "peg" && r.pegs === "calc") txt += " Calculated from trailing growth.";
      }
      return `<div class="${cls(e)}"><b>${e.na ? "No data" : e.pass ? "Pass" : "Fail"} · ${m.title.replace(/ (below|above)$/, "")}</b>${txt}</div>`;
    }).join("");
    const extra = isStock()
      ? `<span>${esc(r.ind)}</span><span>Price $${fx(r.px)}</span><span>Fwd P/E ${fx(r.fpe, 1)}</span>
         <span>Earnings growth ${pct(r.eg, 0)}</span><span>Revenue growth ${pct(r.rg, 0)}</span><span>ROE ${pct(r.roe, 0)}</span>
         <span>Div. yield ${r.dy == null ? "—" : r.dy.toFixed(2) + "%"}</span><span>${esc(r.idx)}</span>`
      : `<span>${esc(r.fam)}</span><span>${esc(r.grp)}</span><span>Price $${fx(r.px)}</span><span>3-yr ${pct(r.r3, 1)}/yr</span>
         <span>YTD ${r.ytd == null ? "—" : r.ytd.toFixed(1) + "%"}</span><span>Beta ${fx(r.beta)}</span>`;
    return `<div class="why">${lines}</div>
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
    const ncol = 8 + P.tests.length;
    const extraTd = r => isStock()
      ? `<td class="n">${r.up == null ? "—" : (r.up >= 0 ? "+" : "") + (r.up * 100).toFixed(0) + "%"}</td><td class="n">${money(r.mc)}</td>`
      : `<td class="n">${pct(r.r3, 1)}</td><td class="n">${fx(r.beta)}</td>`;
    $("tb").innerHTML = rows.slice(0, shown).map(r => `<tr class="main" data-t="${esc(r.t)}" tabindex="0">
        <td class="n">${r.rank}</td>
        <td><span class="tk">${esc(r.t)}</span> <span class="nm">${esc(r.n)}</span> ${r.isNew ? '<span class="chip new">New</span>' : ""}${r.warn.length ? ' <span class="chip warn">check</span>' : ""}</td>
        <td>${esc(r.grp)}</td>
        <td class="n"><span class="dots">${P.tests.map(t => `<i class="${r.ev[t.k].pass ? "on" : ""}"></i>`).join("")}</span></td>
        <td class="n">${r.score}<span class="bar"><i style="width:${r.score}%"></i></span></td>
        ${P.tests.map(t => `<td class="n ${cls(r.ev[t.k])}">${META[t.k].show(r)}</td>`).join("")}
        <td class="n${r.nearLow ? " ok" : ""}">${r.fromLow == null ? "—" : "+" + (r.fromLow * 100).toFixed(1) + "%"}${r.rangePos == null ? "" : `<span class="bar" title="Position in 52-week range"><i style="width:${Math.max(3, r.rangePos * 100)}%"></i></span>`}</td>
        ${extraTd(r)}</tr>` + (open.has(r.t) ? `<tr class="detail"><td colspan="${ncol}">${why(r)}</td></tr>` : "")).join("")
      || `<tr><td colspan="${ncol}" style="text-align:center;color:var(--muted);padding:24px">Nothing matches these filters.</td></tr>`;
    $("more").hidden = rows.length <= shown;
    $("more").textContent = `Show more (${rows.length - shown} left)`;
  }

  function renderAll() { rankAll(); renderSummary(); renderFunnel(); renderZone(); renderPicks(); renderTable(); }

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
      const groups = [...new Set(DATA.rows.filter(inUniverse).map(r => isStock() ? r.sec : (r.cat || r.grp)))].sort();
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
    for (const t of P.tests) num("t-" + t.k, t.k);
    num("o-low", "low");
    if (isStock()) {
      num("o-mcap", "mcap");
      $("o-sector").addEventListener("change", e => { S.sector = e.target.checked; save(); renderAll(); });
      $("o-fin").addEventListener("change", e => { S.fin = e.target.checked; save(); renderAll(); });
    }
    $("reset").addEventListener("click", () => { S = { ...DEF }; save(); syncInputs(); renderAll(); });
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
