// NBA Tonight: Spiele der Nacht mit Sendern, Ergebnisse von letzter Nacht mit Boxscores.
// Daten kommen von der öffentlichen ESPN-Schnittstelle (kein API-Key nötig).

const API = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const FAV = "LAL"; // Lakers immer oben
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
const summary = (id) => getJSON(`${API}/summary?event=${id}`);

// --- Hilfsfunktionen -----------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function teams(ev) {
  const c = ev.competitions[0].competitors;
  return { away: c.find((t) => t.homeAway === "away"), home: c.find((t) => t.homeAway === "home") };
}
function isFav(ev) {
  return ev.competitions[0].competitors.some((t) => t.team.abbreviation === FAV);
}
function sortGames(events) {
  return [...events].sort((a, b) => (isFav(b) - isFav(a)) || (new Date(a.date) - new Date(b.date)));
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
  const fav = isFav(ev);
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
    <article class="game${fav ? " lakers" : ""}" id="g${esc(ev.id)}">
      <div class="game-head">
        <span class="time">${fmtTipDay(ev.date)} ${fmtTime(ev.date)} Uhr</span>
        ${fav ? `<span class="badge">LAKERS</span>` : ""}
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

load();
