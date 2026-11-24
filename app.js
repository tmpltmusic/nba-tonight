// NBA Tonight: Spiele der Nacht mit Sendern, Ergebnisse von letzter Nacht mit Boxscores.
// Daten kommen von der öffentlichen ESPN-Schnittstelle (kein API-Key nötig).

const API = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
// Lieblingsteams: werden hervorgehoben und stehen oben (in dieser Reihenfolge)
const FAVS = [
  { abbr: "LAL", id: 13, name: "Lakers", cls: "lakers" },
  { abbr: "ORL", id: 19, name: "Magic", cls: "magic" },
];
const TZ = "Europe/Berlin";
const REFRESH_MS = 60_000;

let offset = 0; // Tage relativ zu heute

// --- Datum ---------------------------------------------------------------

// Heutiges Datum in deutscher Zeit als Date (12:00 UTC, damit Tagesrechnung stabil ist)
function berlinToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
}
function addDays(d, n) { return new Date(d.getTime() + n * 86_400_000); }
function ymd(d) { return d.toISOString().slice(0, 10).replaceAll("-", ""); }
function fmtDay(d) {
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}
function fmtTipDay(iso) {
  return new Date(iso).toLocaleDateString("de-DE", { weekday: "short", timeZone: TZ });
}

// --- Daten laden ---------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const scoreboard = (d) => getJSON(`${API}/scoreboard?dates=${ymd(d)}`);
const news = (team) => getJSON(`${API}/news?limit=15${team ? `&team=${team}` : ""}`);
const summary = (id) => getJSON(`${API}/summary?event=${id}`);
// Tabelle liegt unter /apis/v2 (nicht /apis/site/v2)
const standings = () => getJSON("https://site.api.espn.com/apis/v2/sports/basketball/nba/standings");

// --- Hilfsfunktionen -----------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function teams(ev) {
  const c = ev.competitions[0].competitors;
  return { away: c.find((t) => t.homeAway === "away"), home: c.find((t) => t.homeAway === "home") };
}
// Erstes Lieblingsteam, das in diesem Spiel mitspielt (oder null)
function favOf(ev) {
  const abbrs = ev.competitions[0].competitors.map((t) => t.team.abbreviation);
  return FAVS.find((f) => abbrs.includes(f.abbr)) || null;
}
function favRank(ev) {
  const f = favOf(ev);
  return f ? FAVS.indexOf(f) : FAVS.length;
}
function sortGames(events) {
  return [...events].sort((a, b) => (favRank(a) - favRank(b)) || (new Date(a.date) - new Date(b.date)));
}

// Sender sammeln, getrennt nach USA national und Regionalsendern (nur im Teamgebiet zu sehen)
function channels(ev) {
  const comp = ev.competitions[0];
  const { away, home } = teams(ev);
  const teamOf = { home: home.team.abbreviation, away: away.team.abbreviation };
  const national = new Set();
  const regional = new Map();
  for (const g of comp.geoBroadcasts || []) {
    const name = g.media?.shortName;
    if (!name) continue;
    const market = (g.market?.type || "").toLowerCase();
    if (market === "national") national.add(name);
    else regional.set(name, teamOf[market] || "");
  }
  for (const b of comp.broadcasts || []) {
    for (const name of b.names || []) {
      if (national.has(name) || regional.has(name)) continue;
      if ((b.market || "") === "national") national.add(name);
      else regional.set(name, teamOf[b.market] || "");
    }
  }
  for (const n of national) regional.delete(n);
  return {
    national: [...national],
    regional: [...regional].map(([name, team]) => ({ name, team })),
  };
}

// Die großen Sender, die Michi interessieren; alles andere landet unter "weitere Sender"
const BIG = [
  [/^nba ?tv$/i, "NBA TV"],
  [/^espn/i, "ESPN"],
  [/^abc$/i, "ABC"],
  [/^(nbc|peacock)$/i, "NBC / Peacock"],
  [/prime/i, "Prime Video"],
];
function bigChannel(name) {
  const hit = BIG.find(([re]) => re.test(name.trim()));
  return hit ? hit[1] : null;
}

function highlightUrl(ev) {
  // ESPN-Video, falls vorhanden, sonst YouTube-Suche nach den offiziellen NBA-Highlights
  for (const h of ev.competitions[0].headlines || []) {
    for (const v of h.video || []) {
      const href = v.links?.web?.href;
      if (href) return href;
    }
  }
  const { away, home } = teams(ev);
  const date = new Date(ev.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const q = `${away.team.shortDisplayName} vs ${home.team.shortDisplayName} full game highlights ${date}`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

// --- Darstellung ---------------------------------------------------------

function teamRow(t, state) {
  const rec = t.records?.[0]?.summary;
  const showScore = state !== "pre";
  const loser = state === "post" && t.winner === false;
  return `
    <div class="team${loser ? " loser" : ""}">
      ${t.team.logo ? `<img src="${esc(t.team.logo)}" alt="" loading="lazy">` : ""}
      <span class="name">${esc(t.team.displayName)}${rec ? `<span class="rec">(${esc(rec)})</span>` : ""}</span>
      ${showScore ? `<span class="score">${esc(t.score)}</span>` : ""}
    </div>`;
}

function statusHtml(ev) {
  const st = ev.status.type;
  if (st.state === "in") return `<span class="status live">${esc(st.shortDetail)}</span>`;
  if (st.state === "post") return `<span class="status">${esc(st.shortDetail)}</span>`;
  return `<span class="status">${esc(st.shortDetail === "TBD" ? "Zeit offen" : "")}</span>`;
}

function gameCard(ev, { withBox }) {
  const { away, home } = teams(ev);
  const state = ev.status.type.state;
  const fav = favOf(ev);
  const tv = channels(ev);
  const all = [...tv.national.map((name) => ({ name, team: "" })), ...tv.regional];
  const big = [...new Set(all.map((c) => bigChannel(c.name)).filter(Boolean))];
  const other = all.filter((c) => !bigChannel(c.name));
  const tvHtml = `
    <div class="tv-row">${
      big.length ? big.map((n) => `<span class="chip national">📺 ${esc(n)}</span>`).join("") : `<span class="none">Kein großer Sender, nur im League Pass</span>`
    }</div>
    ${other.length ? `<details class="more"><summary>weitere Sender (${other.length})</summary><div class="tv-row">${
      other.map((c) => `<span class="chip">${esc(c.name)}${c.team ? `<small>${esc(c.team)}</small>` : ""}</span>`).join("")
    }</div></details>` : ""}`;

  const actions = [];
  if (state === "post") actions.push(`<a class="hl" href="${esc(highlightUrl(ev))}" target="_blank" rel="noopener">▶ Highlights</a>`);
  if (withBox && state !== "pre") actions.push(`<button data-box="${esc(ev.id)}">📊 Boxscore</button>`);

  return `
    <article class="game${fav ? ` fav ${fav.cls}` : ""}" id="g${esc(ev.id)}">
      <div class="game-head">
        <span class="time">${fmtTipDay(ev.date)} ${fmtTime(ev.date)} Uhr</span>
        ${fav ? `<span class="badge ${fav.cls}">${esc(fav.name.toUpperCase())}</span>` : ""}
        ${statusHtml(ev)}
      </div>
      ${teamRow(away, state)}
      ${teamRow(home, state)}
      <div class="tv">${tvHtml}</div>
      ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
      <div class="box" hidden></div>
    </article>`;
}

function renderList(el, events, opts) {
  el.innerHTML = events.length
    ? sortGames(events).map((ev) => gameCard(ev, opts)).join("")
    : `<p class="empty">Keine Spiele an diesem Tag.</p>`;
}

// Boxscore: Tabelle pro Team mit den wichtigsten Werten
const BOX_COLS = ["MIN", "PTS", "REB", "AST", "STL", "BLK", "FG", "3PT", "FT", "TO", "+/-"];

function boxTable(teamBlock) {
  const s = teamBlock.statistics?.[0];
  if (!s) return "";
  const labels = s.labels || s.names || [];
  const idx = BOX_COLS.map((c) => labels.indexOf(c));
  const rows = (s.athletes || [])
    .filter((a) => !a.didNotPlay && a.stats?.length)
    .map((a) => {
      const cells = idx.map((i, k) => `<td class="${BOX_COLS[k] === "PTS" ? "pts" : ""}">${i >= 0 ? esc(a.stats[i]) : ""}</td>`).join("");
      return `<tr class="${a.starter ? "" : "bench"}"><td>${esc(a.athlete.shortName || a.athlete.displayName)}</td>${cells}</tr>`;
    }).join("");
  return `
    <h4>${esc(teamBlock.team.displayName)}</h4>
    <table>
      <thead><tr><th>Spieler</th>${BOX_COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function toggleBox(btn) {
  const box = btn.closest(".game").querySelector(".box");
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  if (box.dataset.loaded) return;
  box.innerHTML = `<p class="loading">Lade Boxscore …</p>`;
  try {
    const data = await summary(btn.dataset.box);
    const players = data.boxscore?.players || [];
    box.innerHTML = players.length ? players.map(boxTable).join("") : `<p class="empty">Noch kein Boxscore verfügbar.</p>`;
    box.dataset.loaded = "1";
  } catch (e) {
    box.innerHTML = `<p class="empty">Boxscore konnte nicht geladen werden.</p>`;
  }
}

// --- Ablauf --------------------------------------------------------------

async function load() {
  const tonight = addDays(berlinToday(), offset);
  const last = addDays(tonight, -1);
  document.getElementById("day-label").textContent = fmtDay(tonight);
  document.getElementById("tonight-title").textContent = offset === 0 ? "Heute Nacht" : `Nacht vom ${fmtDay(tonight)}`;
  document.getElementById("last-title").textContent = offset === 0 ? "Letzte Nacht" : `Nacht vom ${fmtDay(last)}`;

  const [tn, ln] = await Promise.allSettled([scoreboard(tonight), scoreboard(last)]);
  const tEl = document.getElementById("tonight");
  const lEl = document.getElementById("last");
  if (tn.status === "fulfilled") renderList(tEl, tn.value.events || [], { withBox: true });
  else tEl.innerHTML = `<p class="empty">Spiele konnten nicht geladen werden.</p>`;
  if (ln.status === "fulfilled") renderList(lEl, ln.value.events || [], { withBox: true });
  else lEl.innerHTML = `<p class="empty">Ergebnisse konnten nicht geladen werden.</p>`;

  document.getElementById("updated").textContent =
    "Stand " + new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

// --- Tabelle -------------------------------------------------------------

function stat(entry, ...keys) {
  return (entry.stats || []).find((s) => keys.includes(s.name) || keys.includes(s.type));
}
const num = (entry, ...keys) => Number(stat(entry, ...keys)?.value ?? NaN);
const shown = (entry, ...keys) => {
  const s = stat(entry, ...keys);
  return s ? (s.displayValue ?? s.summary ?? String(s.value ?? "")) : "";
};

function confTable(conf) {
  const entries = [...(conf.standings?.entries || [])].sort((a, b) =>
    (num(a, "playoffSeed") - num(b, "playoffSeed")) ||
    (num(b, "winPercent") - num(a, "winPercent")));
  const rows = entries.map((e, i) => {
    const seed = num(e, "playoffSeed") || i + 1;
    const t = e.team || {};
    const fav = FAVS.find((f) => f.abbr === t.abbreviation || String(f.id) === String(t.id));
    const zone = seed <= 6 ? "po" : seed <= 10 ? "pi" : "";
    const logo = t.logos?.[0]?.href;
    let pct = shown(e, "winPercent");
    if (pct.startsWith("0.")) pct = pct.slice(1);
    const gb = shown(e, "gamesBehind");
    return `
      <tr class="${zone}${fav ? ` fav ${fav.cls}` : ""}${seed === 10 ? " cut" : ""}${seed === 6 ? " cut6" : ""}">
        <td class="seed">${seed}</td>
        <td class="tm">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : ""}<span class="full">${esc(t.shortDisplayName || t.displayName)}</span><span class="abbr">${esc(t.abbreviation)}</span></td>
        <td>${esc(shown(e, "wins"))}</td>
        <td>${esc(shown(e, "losses"))}</td>
        <td>${esc(pct)}</td>
        <td>${esc(gb === "0" ? "–" : gb)}</td>
        <td class="opt">${esc(shown(e, "lasttengames", "Last Ten Games"))}</td>
        <td class="opt">${esc(shown(e, "streak"))}</td>
      </tr>`;
  }).join("");
  const title = /east/i.test(conf.name || conf.abbreviation) ? "Eastern Conference" : /west/i.test(conf.name || conf.abbreviation) ? "Western Conference" : conf.name;
  return `
    <div class="conf">
      <h3>${esc(title)}</h3>
      <table>
        <thead><tr><th>#</th><th class="tm">Team</th><th title="Siege">S</th><th title="Niederlagen">N</th><th title="Siegquote">%</th><th title="Rückstand auf Platz 1">GB</th><th class="opt" title="Letzte 10 Spiele">L10</th><th class="opt" title="Serie">Serie</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function loadStandings() {
  const el = document.getElementById("standings-list");
  try {
    const data = await standings();
    const confs = (data.children || []).filter((c) => c.standings?.entries?.length);
    // Osten zuerst, dann Westen
    confs.sort((a, b) => (/west/i.test(a.name) ? 1 : 0) - (/west/i.test(b.name) ? 1 : 0));
    el.innerHTML = confs.length ? confs.map(confTable).join("") : `<p class="empty">Keine Tabelle verfügbar.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="empty">Tabelle konnte nicht geladen werden.</p>`;
  }
}

// --- Luka Dončić ---------------------------------------------------------

const LUKA_ID = 3945274;
const ATHLETE_PATH = `/apis/common/v3/sports/basketball/nba/athletes/${LUKA_ID}`;
// Gleicher Pfad auf zwei ESPN-Hosts; der zweite ist Reserve, falls der erste ausfällt
async function athlete(part) {
  let err;
  for (const host of ["https://site.web.api.espn.com", "https://site.api.espn.com"]) {
    try { return await getJSON(`${host}${ATHLETE_PATH}/${part}`); } catch (e) { err = e; }
  }
  throw err;
}

// Wert aus einer Statistikzeile über name oder label holen
function pick(block, row, ...keys) {
  const names = block.names || [];
  const labels = block.labels || [];
  for (const k of keys) {
    let i = names.indexOf(k);
    if (i < 0) i = labels.indexOf(k);
    if (i >= 0 && row?.[i] != null && row[i] !== "") return String(row[i]);
  }
  return "";
}

// Saisonschnitt aus /overview (statistics.splits)
function seasonAverages(ov) {
  const st = ov?.statistics;
  const splits = st?.splits || [];
  const split = splits.find((s) => /regular|season|postseason/i.test(s.displayName || "") && !/career/i.test(s.displayName || "")) || splits[0];
  if (!split?.stats) return null;
  const g = (...k) => pick(st, split.stats, ...k);
  return {
    title: split.displayName || "Saison",
    gp: g("gamesPlayed", "GP"),
    min: g("avgMinutes", "MIN"),
    pts: g("avgPoints", "PTS"),
    reb: g("avgRebounds", "REB"),
    ast: g("avgAssists", "AST"),
    stl: g("avgSteals", "STL"),
    blk: g("avgBlocks", "BLK"),
    to: g("avgTurnovers", "TO"),
    fg: g("fieldGoalPct", "FG%"),
    tp: g("threePointPct", "3P%"),
    ft: g("freeThrowPct", "FT%"),
  };
}

// Letztes Spiel aus einem Spielprotokoll suchen (overview.gameLog oder /gamelog)
function lastGame(log) {
  if (!log) return null;
  const meta = log.events || {};
  const rows = [];
  const collect = (block, fallback) => {
    for (const r of block?.events || []) if (r?.eventId && r.stats) rows.push({ id: String(r.eventId), stats: r.stats, block: block.names ? block : fallback });
  };
  for (const b of log.statistics || []) collect(b, log);
  for (const t of log.seasonTypes || []) for (const c of t.categories || []) collect(c, log);
  const dated = rows.filter((r) => meta[r.id]).sort((a, b) => new Date(meta[b.id].gameDate) - new Date(meta[a.id].gameDate));
  const r = dated[0];
  if (!r) return null;
  const m = meta[r.id];
  const g = (...k) => pick(r.block, r.stats, ...k);
  return {
    id: r.id,
    date: m.gameDate,
    atVs: m.atVs || "",
    opp: m.opponent?.abbreviation || m.opponent?.displayName || "",
    oppLogo: m.opponent?.logo || "",
    result: m.gameResult || "",
    score: m.score || "",
    min: g("minutes", "MIN"),
    pts: g("points", "PTS"),
    reb: g("totalRebounds", "rebounds", "REB"),
    ast: g("assists", "AST"),
    stl: g("steals", "STL"),
    blk: g("blocks", "BLK"),
    to: g("turnovers", "TO"),
    fg: g("fieldGoalsMade-fieldGoalsAttempted", "FG"),
    tp: g("threePointFieldGoalsMade-threePointFieldGoalsAttempted", "3PT"),
    ft: g("freeThrowsMade-freeThrowsAttempted", "FT"),
  };
}

const tile = (val, label, big) => val ? `<div class="tile${big ? " big" : ""}"><b>${esc(val)}</b><span>${esc(label)}</span></div>` : "";
const pct = (v) => v ? `${v.replace(/%$/, "")}%` : "";

function lukaHtml(avg, last) {
  const head = `
    <div class="player-head">
      <img src="https://a.espncdn.com/i/headshots/nba/players/full/${LUKA_ID}.png" alt="" loading="lazy">
      <div>
        <strong>Luka Dončić</strong>
        <span>Los Angeles Lakers · #77 · Guard</span>
      </div>
      <a class="more-link" href="https://www.espn.com/nba/player/_/id/${LUKA_ID}/luka-doncic" target="_blank" rel="noopener">ESPN ›</a>
    </div>`;
  const avgHtml = avg ? `
    <h3>${esc(/regular/i.test(avg.title) ? "Saisonschnitt" : /post/i.test(avg.title) ? "Playoff-Schnitt" : avg.title)}${avg.gp ? ` <small>${esc(avg.gp)} Spiele</small>` : ""}</h3>
    <div class="tiles">
      ${tile(avg.pts, "Punkte", true)}${tile(avg.reb, "Rebounds", true)}${tile(avg.ast, "Assists", true)}
      ${tile(pct(avg.fg), "FG%")}${tile(pct(avg.tp), "3P%")}${tile(pct(avg.ft), "FT%")}
      ${tile(avg.min, "Minuten")}${tile(avg.stl, "Steals")}${tile(avg.blk, "Blocks")}${tile(avg.to, "Ballverluste")}
    </div>` : `<p class="empty">Saisonschnitt gerade nicht verfügbar.</p>`;
  let lastHtml = "";
  if (last) {
    const day = new Date(last.date).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });
    const res = last.result ? `<span class="res ${last.result === "W" ? "w" : "l"}">${last.result === "W" ? "S" : "N"}</span>` : "";
    lastHtml = `
      <h3>Letztes Spiel <small>${esc(day)} ${esc(last.atVs)} ${esc(last.opp)} ${res} ${esc(last.score)}</small></h3>
      <div class="tiles">
        ${tile(last.pts, "Punkte", true)}${tile(last.reb, "Rebounds", true)}${tile(last.ast, "Assists", true)}
        ${tile(last.fg, "FG")}${tile(last.tp, "3PT")}${tile(last.ft, "FT")}
        ${tile(last.min, "Minuten")}${tile(last.stl, "Steals")}${tile(last.blk, "Blocks")}${tile(last.to, "Ballverluste")}
      </div>`;
  }
  return head + avgHtml + lastHtml;
}

async function loadLuka() {
  const el = document.getElementById("luka-card");
  let ov = null, log = null;
  try { ov = await athlete("overview"); } catch (e) { /* unten Ersatz */ }
  let avg = seasonAverages(ov);
  let last = lastGame(ov?.gameLog);
  if (!last) {
    try { log = await athlete("gamelog"); last = lastGame(log); } catch (e) { /* bleibt leer */ }
  }
  if (!avg && !last) {
    el.innerHTML = `<p class="empty">Stats konnten nicht geladen werden. <a href="https://www.espn.com/nba/player/_/id/${LUKA_ID}/luka-doncic" target="_blank" rel="noopener">Bei ESPN ansehen</a></p>`;
    return;
  }
  el.innerHTML = lukaHtml(avg, last);
}

// --- News ----------------------------------------------------------------

let newsTab = "nba";

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60_000);
  if (min < 60) return `vor ${Math.max(min, 1)} Min.`;
  if (min < 1440) return `vor ${Math.round(min / 60)} Std.`;
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: TZ });
}

async function loadNews() {
  const el = document.getElementById("news-list");
  try {
    const data = await news(FAVS.find((f) => f.cls === newsTab)?.id ?? null);
    const items = (data.articles || []).filter((a) => a.links?.web?.href);
    el.innerHTML = items.length ? items.map((a) => `
      <a class="news-item" href="${esc(a.links.web.href)}" target="_blank" rel="noopener">
        ${a.images?.[0]?.url ? `<img src="${esc(a.images[0].url)}" alt="" loading="lazy">` : ""}
        <div><strong>${esc(a.headline)}</strong><span>${a.published ? ago(a.published) : ""}</span></div>
      </a>`).join("") : `<p class="empty">Keine News gefunden.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="empty">News konnten nicht geladen werden.</p>`;
  }
}

document.querySelectorAll("[data-news]").forEach((btn) => {
  btn.onclick = () => {
    newsTab = btn.dataset.news;
    document.querySelectorAll("[data-news]").forEach((b) => b.classList.toggle("active", b === btn));
    loadNews();
  };
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-box]");
  if (btn) toggleBox(btn);
});
document.getElementById("prev").onclick = () => { offset--; load(); };
document.getElementById("next").onclick = () => { offset++; load(); };
document.getElementById("today").onclick = () => { offset = 0; load(); };

// Nur neu laden, wenn kein Boxscore offen ist (sonst klappt er zu)
setInterval(() => {
  if (document.visibilityState === "visible" && !document.querySelector(".box:not([hidden])")) load();
}, REFRESH_MS);
setInterval(() => { if (document.visibilityState === "visible") loadNews(); }, 10 * REFRESH_MS);

setInterval(() => { if (document.visibilityState === "visible") loadStandings(); }, 10 * REFRESH_MS);

setInterval(() => { if (document.visibilityState === "visible") loadLuka(); }, 10 * REFRESH_MS);

load();
loadNews();
loadStandings();
loadLuka();
