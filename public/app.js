"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let SNAP, submissions = [], cases = {}, aiStatus = "not_configured", reviewerConfigured = false;
let selected = null, perspective = "resident", panelMode = null, detailTab = "overview";
let map, layers = {}, markers = new Map(), baseLayer = null, tileErrors = 0, page = 0;
let chatLog = [], lastCards = [], nearCache = [];
let journey = { from: null, to: null, when: "now", datetime: "", stepFree: true, maxWalk: "", fewerTransfers: false };
let journeyResult = null, selectedItinerary = -1, ownBarrierId = null, mobilityStatus = "not_configured";
let journeyMarkers = [];
const fmtHelsinki = (iso) => iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso)) : "—";
const fmtDur = (s) => `${Math.max(1, Math.round((s || 0) / 60))} min`;
// Safe Markdown subset: HTML is escaped first, so raw markup can never run.
// Only https links become anchors; anything else stays plain text.
function mdHtml(text) {
  const link = (label, url) => /^https:\/\/[^\s)]+$/i.test(url)
    ? `<a href="${url.replace(/"/g, "%22")}" target="_blank" rel="noopener">${label}</a>` : label;
  const inline = (t) => t
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, l, u) => link(l, u))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return esc(String(text ?? "")).split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-•]\s+/.test(l)))
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}
const PAGE_SIZE = 25;
const toast = (m) => { $("#toast").textContent = m; setTimeout(() => { $("#toast").textContent = ""; }, 5200); };
const reviewerToken = () => sessionStorage.getItem("reviewerToken") || "";
const authHeaders = () => reviewerToken() ? { Authorization: `Bearer ${reviewerToken()}` } : {};
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.analysis) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const caseOf = (id) => cases[id] || { status: "open", findings: [], actions: [], history: [], versions: [], analysis: { status: aiStatus } };
const workSubs = (id) => submissions.filter((s) => s.workId === id);
const STATUS_EN = { "Käynnissä": ["Ongoing", "ongoing"], "Tuleva": ["Upcoming", "upcoming"] };
const statusPill = (w) => { const s = STATUS_EN[w.status]; return s ? `<span class="pill ${s[1]}">● ${s[0]}</span>` : (w.status ? `<span class="pill">● ${esc(w.status)}</span>` : ""); };
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
const period = (w) => [fmtDate(w.starts), fmtDate(w.ends)].filter(Boolean).join(" – ") || "Dates not published";
const CAT_LABEL = { public_service: ["Public service", "service"], business: ["Business", "biz"], place: ["Place", ""] };
function setComposer() {
  // Exactly one composer: inside the conversation panel while chat is open,
  // otherwise the floating input. Welcome and floating input hide in chat.
  const chatOpen = panelMode === "chat" && !$("#panel").hidden;
  $("#panel-composer").hidden = !chatOpen;
  $("#chat-bar").style.display = chatOpen ? "none" : "flex";
  if (chatOpen) { const w = $("#welcome"); if (w) w.hidden = true; }
}
function openPanel(mode, html) {
  $("#layers-pop").hidden = true; $("#layers-btn").setAttribute("aria-expanded", "false");
  panelMode = mode;
  const w = $("#welcome"); if (w) w.hidden = true;
  $("#panel-content").innerHTML = html;
  $("#panel").hidden = false;
  setComposer();
}
function closePanel() { panelMode = null; $("#panel").hidden = true; setComposer(); }
// HSL tiles are native 512 px up to z19 (probed live via the backend route);
// beyond that the provider has no tiles and the map only stretches pixels.
let tileEpoch = 0, tileRetries = 0, tileLoadedOnce = false;
const tileTiles = () => [location.origin + "/api/map/{z}/{x}/{y}.png" + (tileEpoch ? `?r=${tileEpoch}` : "")];
const BASE_STYLE = { version: 8,
  sources: { hsl: { type: "raster", tiles: tileTiles(), tileSize: 512, minzoom: 10, maxzoom: 19,
    attribution: "© Digitransit / HSL — map data © OpenStreetMap contributors (ODbL)" } },
  layers: [{ id: "hsl", type: "raster", source: "hsl" }] };
let mapReady = false, domMarkers = [];
function showBaseError() {
  const n = $("#tile-note");
  n.hidden = false;
  n.innerHTML = `${mobilityStatus === "configured"
    ? "The HSL base map (served through this server) could not be loaded. Journey lines are still shown on a plain background."
    : "The HSL base map needs Digitransit on the server (DIGITRANSIT_API_KEY). Journey lines, when available, are shown on a plain background until it is configured."}
    <button type="button" class="btn small" id="tile-retry">Retry base map</button>`;
  $("#map-status").textContent = "The HSL base map could not be loaded. Journey lines are still shown.";
  $("#tile-retry")?.addEventListener("click", () => retryTiles());
}
function hideBaseError() { const n = $("#tile-note"); if (n) n.hidden = true; tileErrors = 0; }
function retryTiles() {
  // Bounded refetch of the same provider tiles through the backend route.
  tileEpoch++; tileErrors = 0;
  const src = map?.getSource("hsl"); if (src?.setTiles) src.setTiles(tileTiles());
  map?.triggerRepaint();
}
function onTileError(e) {
  if (!e.tile && e.sourceId !== "hsl") return;
  const status = e.error?.status;
  const transient = status == null || status === 0 || status === 429 || status >= 500;
  if (transient && tileRetries < 2) {
    tileRetries++;
    setTimeout(() => retryTiles(), 900 * tileRetries);
    return;
  }
  tileErrors++;
  if (tileErrors >= 3) showBaseError();
}
function initMap(centre) {
  if (!window.maplibregl) { $("#map-status").textContent = "Map library unavailable."; showBaseError(); return; }
  map = new maplibregl.Map({ container: "map", style: BASE_STYLE, center: [centre.lon, centre.lat], zoom: 16,
    minZoom: 11, maxZoom: 19, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.on("error", onTileError);
  map.on("sourcedata", (e) => {
    if (e.sourceId === "hsl" && e.tile) { tileLoadedOnce = true; tileRetries = 0; if (!$("#tile-note").hidden) hideBaseError(); }
  });
  setTimeout(() => { if (!tileLoadedOnce) showBaseError(); }, 15000);
  map.on("load", () => {
    mapReady = true;
    map.addSource("buildings", { type: "geojson", data: { type: "FeatureCollection", features: SNAP.buildings.filter((b) => b.geometry).map((b) => ({ type: "Feature", geometry: b.geometry, properties: {} })) } });
    map.addLayer({ id: "buildings-fill", type: "fill", source: "buildings", layout: { visibility: "none" }, paint: { "fill-color": "#b9c2ca", "fill-opacity": 0.55, "fill-outline-color": "#7d8894" } });
    map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: SNAP.accessibilityRoutes.filter((r) => r.geometry).map((r) => ({ type: "Feature", geometry: r.geometry, properties: { verified: r.realisedAccessibility === "Kyllä" } })) } });
    map.addLayer({ id: "routes-verified", type: "line", source: "routes", filter: ["==", ["get", "verified"], true], layout: { visibility: "none" }, paint: { "line-color": "#1f8a4c", "line-width": 3 } });
    map.addLayer({ id: "routes-unknown", type: "line", source: "routes", filter: ["!=", ["get", "verified"], true], layout: { visibility: "none" }, paint: { "line-color": "#8a94a0", "line-width": 2, "line-dasharray": [2, 2] } });
    map.addSource("journey", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "journey-line", type: "line", source: "journey", filter: ["!=", ["get", "unsuitable"], true], paint: { "line-color": "#00758c", "line-width": 5, "line-opacity": 0.85 } });
    map.addLayer({ id: "journey-line-bad", type: "line", source: "journey", filter: ["==", ["get", "unsuitable"], true], paint: { "line-color": "#8a94a0", "line-width": 4, "line-dasharray": [2, 2], "line-opacity": 0.9 } });
    map.addSource("works", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "works-fill", type: "fill", source: "works", paint: { "fill-color": "#38b6d3", "fill-opacity": 0.16 } });
    map.addLayer({ id: "works-line", type: "line", source: "works", paint: { "line-color": "#0e7ea6", "line-width": 2 } });
    map.addLayer({ id: "works-selected", type: "line", source: "works", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#b95e00", "line-width": 3.5 } });
    map.on("click", "works-fill", (e) => { const id = e.features?.[0]?.properties?.id; if (id) selectWork(id, false); });
    map.on("mouseenter", "works-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "works-fill", () => { map.getCanvas().style.cursor = ""; });
    drawMap();
  });
  map.on("moveend", () => { drawMap(); if (panelMode === "results") renderResults(false); });
}
const ICONS = {
  work: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 1.8 21h20.4L12 3zm-1 7h2v5h-2V10zm0 6h2v2h-2v-2z" fill="currentColor"/></svg>',
  service: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z" fill="currentColor"/></svg>',
  business: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16l-1.2 12.1a2 2 0 0 1-2 1.9H7.2a2 2 0 0 1-2-1.9L4 7zm4 0a4 4 0 0 1 8 0h-2a2 2 0 1 0-4 0H8z" fill="currentColor"/></svg>',
  place: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z" fill="currentColor"/></svg>',
};
function markerEl(kind, cat, label, isSel) {
  const el = document.createElement("div");
  const cls = kind === "work" ? "pm-work" : cat === "public_service" ? "pm-service" : cat === "business" ? "pm-business" : "pm-place";
  const svg = kind === "work" ? ICONS.work : cat === "public_service" ? ICONS.service : cat === "business" ? ICONS.business : ICONS.place;
  el.className = `place-marker ${cls}${isSel ? " selected" : ""}`;
  el.innerHTML = `${svg}<span class="marker-label">${esc(label)}</span>`;
  el.setAttribute("role", "button"); el.setAttribute("aria-label", label); el.tabIndex = 0;
  return el;
}
const activeBarriers = () => [...document.querySelectorAll(".barrier-filter[aria-pressed='true']")].map((x) => x.dataset.value);
function filtered() {
  const q = $("#search").value.trim().toLowerCase();
  const barriers = activeBarriers();
  let works = SNAP.works, places = SNAP.services;
  if (q) {
    works = works.filter((w) => [w.title, w.address, w.applicationId, w.kind].join(" ").toLowerCase().includes(q));
    places = places.filter((s) => [s.name, s.nameFi, s.address].join(" ").toLowerCase().includes(q));
  }
  if (barriers.length) {
    const ids = new Set(submissions.filter((s) => barriers.includes(s.category)).map((s) => s.workId));
    works = works.filter((w) => ids.has(w.id));
  }
  if (!$("#lay-works").checked) works = [];
  if (!$("#lay-services").checked) places = [];
  return { works, places };
}
function drawMap() {
  if (!map || !mapReady) return;
  const src = map.getSource("works");
  const { works, places } = filtered();
  if (src) src.setData({ type: "FeatureCollection", features: works.filter((w) => w.geometry).map((w) => ({ type: "Feature", geometry: w.geometry, properties: { id: w.id } })) });
  const selLayer = map.getLayer("works-selected");
  if (selLayer) map.setFilter("works-selected", ["==", ["get", "id"], selected || ""]);
  for (const m of domMarkers) m.remove();
  domMarkers = []; markers.clear();
  const zoom = map.getZoom();
  const items = [
    ...places.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, kind: "place", cat: s.category, label: `${s.name} (${CAT_LABEL[s.category]?.[0] || "Place"})`, open: () => selectService(s.id) })),
    ...works.map((w) => ({ id: w.id, lat: w.centroid.lat, lon: w.centroid.lon, kind: "work", cat: null, label: w.address || w.kind, open: () => selectWork(w.id, false) })),
  ];
  const groups = new Map();
  for (const it of items) {
    if (zoom >= 17) { groups.set(it.id, [it]); continue; }
    const pt = map.project([it.lon, it.lat]);
    const key = `${Math.floor(pt.x / 58)}:${Math.floor(pt.y / 58)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      const it = group[0];
      const el = markerEl(it.kind, it.cat, it.label, it.id === selected);
      el.addEventListener("click", (ev) => { ev.stopPropagation(); it.open(); });
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); it.open(); } });
      const m = new maplibregl.Marker({ element: el }).setLngLat([it.lon, it.lat]).addTo(map);
      domMarkers.push(m); markers.set(it.id, el);
    } else {
      const lat = group.reduce((a, i) => a + i.lat, 0) / group.length;
      const lon = group.reduce((a, i) => a + i.lon, 0) / group.length;
      const el = document.createElement("div");
      el.className = "cluster-marker"; el.textContent = group.length;
      el.setAttribute("role", "button"); el.setAttribute("aria-label", `${group.length} items, activate to zoom in`); el.tabIndex = 0;
      const zoomIn = () => map.flyTo({ center: [lon, lat], zoom: Math.min(18, zoom + 2), duration: reduced ? 0 : 800 });
      el.addEventListener("click", (ev) => { ev.stopPropagation(); zoomIn(); });
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") zoomIn(); });
      domMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map));
    }
  }
  const rc = $("#results-count");
  if (rc) rc.textContent = `${works.length} projects · ${places.length} places match the current filters`;
}

function geomBounds(w) {
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  const walk = (c) => { if (typeof c[0] === "number") { minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]); minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]); } else c.forEach(walk); };
  if (w.geometry) walk(w.geometry.coordinates);
  return [[minLon, minLat], [maxLon, maxLat]];
}
function frameWork(w) {
  if (!map) return;
  const panelPad = panelMode && innerWidth > 760 ? 410 : 40;
  if (w.geometry) map.fitBounds(geomBounds(w), { padding: { top: 50, bottom: 90, left: 50, right: panelPad }, maxZoom: 16, duration: reduced ? 0 : 1100 });
  else map.flyTo({ center: [w.centroid.lon, w.centroid.lat], zoom: 16, duration: reduced ? 0 : 1100 });
}
function renderResults(resetPage = true) {
  if (resetPage) page = 0;
  const { works, places } = filtered();
  const inView = (lat, lon) => { if (!map) return true; try { return map.getBounds().contains([lon, lat]); } catch { return true; } };
  const wv = works.filter((w) => inView(w.centroid.lat, w.centroid.lon));
  const pv = places.filter((s) => inView(s.lat, s.lon));
  const all = [...wv.map((w) => ({ w })), ...pv.map((s) => ({ s }))];
  const shown = all.slice(0, (page + 1) * PAGE_SIZE);
  openPanel("results", `<h2>Results in view</h2>
    <p class="small">${all.length} matching objects in the current map view (${works.length} projects, ${places.length} places overall). The list and the map always use the same filters.</p>
    ${shown.map(({ w, s }) => w
      ? `<button class="card" data-work="${esc(w.id)}" aria-current="${selected === w.id}"><span class="t">${esc(w.address || w.applicationId || "Work area")}</span>
         <span class="s">${esc((w.title || "").split("\n")[0].slice(0, 90))}</span>
         <span class="m"><span class="pill type">${esc(w.kind)}</span>${statusPill(w)}<span class="pill">${esc(period(w))}</span></span></button>`
      : `<button class="card" data-place="${esc(s.id)}" aria-current="${selected === s.id}"><span class="t">${esc(s.name)}</span>
         <span class="s">${esc(s.address || "")}</span>
         <span class="m"><span class="pill ${CAT_LABEL[s.category]?.[1] || ""}">${CAT_LABEL[s.category]?.[0] || "Place"}</span>
         <span class="pill">${s.accessibilityKnown ? "Accessibility data recorded" : "Accessibility unknown in source"}</span></span></button>`).join("")}
    ${all.length > shown.length ? `<button class="btn" id="more-results">Show more (${all.length - shown.length} remaining)</button>` : ""}`);
  document.querySelectorAll("[data-work]").forEach((b) => b.addEventListener("click", () => selectWork(b.dataset.work, false)));
  document.querySelectorAll("[data-place]").forEach((b) => b.addEventListener("click", () => selectService(b.dataset.place)));
  $("#more-results")?.addEventListener("click", () => { page++; renderResults(false); });
}
function sourcesHtml(obj) {
  const src = obj.source || { provider: "City of Helsinki", layer: "multiple", url: "https://kartta.hel.fi" };
  return `<details class="sources"><summary>Sources &amp; data</summary><dl>
    <dt>Source record ID</dt><dd>${esc(obj.id)}</dd>
    <dt>Provider &amp; dataset</dt><dd>${esc(src.provider)} · ${esc(src.layer || src.url || "")}</dd>
    <dt>Data as of</dt><dd>Snapshot ${esc(SNAP.snapshotId)} · retrieved ${esc(SNAP.retrievedAt)} (cached, not live)</dd>
    <dt>Licence</dt><dd>${esc(SNAP.licence)} — ${esc(SNAP.attribution)}</dd></dl></details>`;
}
async function selectService(id) {
  selected = id; drawMap();
  const s = SNAP.services.find((x) => x.id === id); if (!s) return;
  if (map) map.flyTo({ center: [s.lon, s.lat], zoom: 16, offset: panelMode && innerWidth > 760 ? [-200, 0] : [0, 0], duration: reduced ? 0 : 1000 });
  let near = [];
  try { near = (await api(`/api/services/${encodeURIComponent(id)}/nearby-works`)).works; } catch { /* panel still works */ }
  const [lbl, cls] = CAT_LABEL[s.category] || ["Place", ""];
  openPanel("details", `<h2>${esc(s.name)}</h2>
    <p><span class="pill ${cls}">${lbl}</span><span class="pill">${s.accessibilityKnown ? "Accessibility data recorded" : "Accessibility unknown in source"}</span></p>
    <h3>Where</h3><p>${esc(s.address || "Address not available")}</p>
    <p class="small">Original Finnish name: ${esc(s.nameFi || "Not available")}</p>
    <h3>Entrances &amp; accessibility (source)</h3>
    ${s.accessibilityKnown
      ? `<p class="small">Surveyed viewpoint codes: ${esc(s.accessibilityViewpoints)}</p>${s.accessibilityWww ? `<p><a class="btn" href="${esc(s.accessibilityWww)}" target="_blank" rel="noopener">Open source accessibility summary</a></p>` : ""}`
      : `<p><strong>Unknown.</strong> The source records no surveyed accessibility values for this place. That does not mean it is accessible or inaccessible.</p>`}
    <div class="ai-note">Source values summarise surveyed features. They do not certify an accessible route, especially during nearby works.</div>
    <h3>Nearest works (possible context, not proven impact)</h3>
    ${near.length ? `<ul>${near.map((n) => `<li>${esc(n.kind)} — ${n.distanceM} m away</li>`).join("")}</ul>` : "<p>Not available</p>"}
    <button class="btn primary" id="plan-to-here">Plan an accessible journey to here</button>
    ${sourcesHtml(s)}`);
  $("#plan-to-here")?.addEventListener("click", () => {
    journey.to = { lat: s.lat, lon: s.lon, label: s.name }; openPlanner();
  });
}
async function selectWork(id, fly = true) {
  selected = id; detailTab = "overview"; drawMap();
  const w = SNAP.works.find((x) => x.id === id); if (!w) return;
  try { nearCache = (await api(`/api/works/${encodeURIComponent(id)}/nearby`)).services; } catch { nearCache = []; }
  renderDetail(w);
  if (fly) frameWork(w);
}
function tabsHtml(w) {
  return `<div class="tabs" role="tablist" aria-label="Project sections">
    ${["overview", "evidence", "actions"].map((t) => `<button role="tab" data-tab="${t}" aria-selected="${detailTab === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>`;
}
function renderDetail(w) {
  const c = caseOf(w.id), subs = workSubs(w.id);
  let body = "";
  if (detailTab === "overview") body = `
    <h3>What</h3><p>${esc(w.kind)} — published status ${esc(STATUS_EN[w.status]?.[0] || w.status || "not stated")}.</p>
    <h3>Where</h3><p>${esc(w.address || "Address not published")}${w.district ? `, ${esc(w.district)}` : ""}</p>
    <h3>When</h3><p>${esc(period(w))}</p>
    <h3>What is known about impact</h3>
    <p>Contracts, budget and progress reports: <strong>Not available — missing evidence</strong>. The permit record alone does not prove obligations, completion or impact on neighbours.</p>
    <p class="small">Published purpose (original Finnish, not translated):</p>
    <blockquote lang="fi">${esc((w.title || "Not available").slice(0, 700))}</blockquote>
    <h3>What you can do</h3>
    <button class="btn primary" id="d-nearby">View nearby services</button>
    <button class="btn" id="d-report">Report an issue</button>
    <button class="btn" id="d-ask">Ask AI about this project</button>`;
  else if (detailTab === "evidence") body = `
    <h3>Approved evidence &amp; public findings</h3>
    ${subs.length ? subs.map(subHtml).join("") : "<p>No approved submissions yet. Pending reports are never shown here.</p>"}
    ${(c.findings || []).length ? `<h3>Findings</h3>` + c.findings.map(findingHtml).join("") : ""}
    ${subs.length > 1 ? `<p class="small">Compare dated evidence: tick two entries.</p><div class="compare" id="compare"></div>` : ""}
    <h3>Add evidence or report a problem</h3>
    <form id="sub-form">
      <label class="field">Type <select name="type"><option value="report">Citizen report</option><option value="evidence">Evidence</option><option value="business">Business concern / alternative entrance</option></select></label>
      <label class="field">Category <select name="category">${CATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
      <label class="field">Title <input type="text" name="title" required maxlength="200"></label>
      <label class="field">Details <textarea name="body" required maxlength="2000" placeholder="What did you observe, where and when?"></textarea></label>
      <label class="field">Photo or PDF evidence (max 5 MB) <input type="file" id="file-input" accept="image/png,image/jpeg,image/webp,application/pdf"></label>
      <label class="field">Public document URL (HTTPS only, optional) <input type="url" name="documentUrl" maxlength="500" placeholder="https://…"></label>
      <label class="field">Contact (private, optional) <input type="text" name="contact" maxlength="120"></label>
      <button class="btn primary" type="submit">Submit for review</button>
      <p class="small">Files are stored privately on the server and are visible only to authenticated reviewers. Submissions appear publicly only after approval.</p>
    </form>`;
  else body = `
    <h3>Analysis (reviewer)</h3>
    <div id="analysis-box">${renderAnalysis(c)}</div>
    <button class="btn primary" id="btn-analyze">Analyze evidence</button>
    <p class="small">Analysis, actions and closure require the reviewer token. Perspective switching alone is not authorisation.</p>
    <h3>Actions</h3>
    <ul>${c.actions.map((x) => `<li>${esc(x.title)} — ${esc(x.owner)} <span class="pill">${esc(x.status)}</span></li>`).join("") || "<li>No actions recorded yet.</li>"}</ul>
    <form id="action-form"><label class="field">New action <input type="text" name="title" required maxlength="200"></label>
    <label class="field">Owner <input type="text" name="owner" maxlength="80" placeholder="Team or role"></label>
    <button class="btn" type="submit">Record action</button></form>
    <label class="field"><input type="checkbox" id="confirm-close"> I confirm, as a human reviewer, that this case is resolved.</label>
    <button class="btn warn" id="btn-close">Confirm closure</button>
    <h3>Timeline</h3><ol class="timeline"><li>${esc(period(w))} — published period</li>
    ${c.history.map((h) => `<li>${esc(h.at.slice(0, 10))} — ${esc(h.event)}</li>`).join("")}</ol>`;
  openPanel("details", `<h2>${esc(w.address || w.applicationId || "Work area")}</h2>
    <p><span class="pill type">${esc(w.kind)}</span>${statusPill(w)}<span class="pill">Case: ${esc(c.status)}</span>
    ${subs.some((s) => s.demo) ? '<span class="pill demo">Demo scenario</span>' : ""}</p>
    ${tabsHtml(w)}<div>${body}</div>${sourcesHtml(w)}`);
  wireDetail(w);
}
const CATS = [["step-free-access", "Step-free access blocked"], ["blocked-pavement", "Blocked pavement"],
  ["temporary-ramp", "Missing temporary ramp"], ["signage", "Poor signage / diversion"], ["other", "Other"]];
function subHtml(s) {
  return `<div class="finding"><span class="pill type">${esc(s.type)}</span><span class="pill ongoing">▲ ${esc(s.category)}</span>
  ${s.demo ? '<span class="pill demo">Demo scenario</span>' : ""}<p><strong>${esc(s.title)}</strong></p><p>${esc(s.body)}</p>
  <p class="small">${esc(s.createdAt.slice(0, 10))}${s.documentUrl ? ` · <a href="${esc(s.documentUrl)}" target="_blank" rel="noopener">Attached public document</a>` : ""}${s.uploadId ? " · File uploaded (private)" : s.fileName ? ` · File: ${esc(s.fileName)}` : ""}</p>
  <label><input type="checkbox" class="cmp" value="${esc(s.id)}"> Compare</label></div>`;
}
function findingHtml(f) {
  return `<div class="finding"><span class="pill ongoing">◆ ${esc(f.type)}</span><p><strong>${esc(f.title)}</strong></p><p>${esc(f.detail)}</p>
  <p class="small">Sources: ${esc((f.sourceRefs || []).join(", ") || "case records")} · ${esc((f.at || "").slice(0, 10))}</p></div>`;
}
function renderAnalysis(c) {
  const a = c.analysis || {};
  const versions = (c.versions || []).map((v) => `<div class="finding"><p><strong>Version ${v.n}</strong> · ${esc(v.at.slice(0, 10))} · ${esc(v.model)}</p>
    <p>${esc(v.summary || "")}</p>
    ${v.changes?.added?.length ? `<p class="small">New: ${esc(v.changes.added.join("; "))}</p>` : ""}
    ${v.changes?.removed?.length ? `<p class="small">No longer present: ${esc(v.changes.removed.join("; "))}</p>` : ""}
    ${(v.findings || []).map(findingHtml).join("")}</div>`).join("");
  if (a.status === "not_configured") return `<div class="ai-note"><strong>Meta AI is not configured.</strong> Set <code>MODEL_API_KEY</code> in the server-side .env (see README). No simulated results are shown.</div>` + versions;
  if (!a.toolActivity && !versions) return `<p class="small">No analysis has been run for this case yet. Status: ${esc(a.status || "idle")}.</p>`;
  return `${a.summary ? `<p><strong>Latest summary:</strong> ${esc(a.summary)}</p>` : ""}${versions}`;
}
function wireDetail(w) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { detailTab = b.dataset.tab; renderDetail(w); }));
  if (detailTab === "overview") {
    $("#d-nearby").addEventListener("click", () => {
      $("#lay-services").checked = true; drawMap();
      openPanel("results", `<h2>Nearby services &amp; places</h2>
        <p class="small">Nearest to ${esc(w.address || "this work")}, server-computed distances. Nearby does not mean affected.</p>
        ${nearCache.map((n) => { const s = SNAP.services.find((x) => x.id === n.id) || {}; const [lbl, cls] = CAT_LABEL[s.category] || ["Place", ""];
          return `<button class="card" data-near="${esc(n.id)}"><span class="t">${esc(n.name)}</span><span class="s">${n.distanceM} m away</span>
          <span class="m"><span class="pill ${cls}">${lbl}</span><span class="pill">${s.accessibilityKnown ? "Accessibility recorded" : "Accessibility unknown"}</span></span></button>`; }).join("") || "<p>Not available</p>"}`);
      document.querySelectorAll("[data-near]").forEach((b) => b.addEventListener("click", () => selectService(b.dataset.near)));
    });
    $("#d-report").addEventListener("click", () => { detailTab = "evidence"; renderDetail(w); });
    $("#d-ask").addEventListener("click", () => { openChat(); sendChat(`What is happening at ${w.address || w.applicationId} (${w.id})? What is known and what is missing?`); });
  }
  if (detailTab === "evidence") {
    $("#sub-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        let uploadId = null;
        const file = $("#file-input").files[0];
        if (file) {
          const up = new FormData(); up.append("file", file);
          const r = await fetch("/api/uploads", { method: "POST", body: up });
          const uj = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(uj.error || "upload_failed");
          uploadId = uj.id; toast("File uploaded to private storage.");
        }
        await api("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workId: w.id, type: fd.get("type"), category: fd.get("category"), title: fd.get("title"),
            body: fd.get("body"), documentUrl: fd.get("documentUrl") || null, contact: fd.get("contact"), uploadId,
            lat: w.centroid.lat, lon: w.centroid.lon }) });
        toast("Submitted. It becomes public only after reviewer approval.");
        await refresh();
      } catch (err) { toast(`Submission failed: ${err.message}`); }
    });
    document.querySelectorAll(".cmp").forEach((box) => box.addEventListener("change", () => {
      const picked = [...document.querySelectorAll(".cmp:checked")].map((x) => submissions.find((s) => s.id === x.value)).filter(Boolean).slice(0, 2);
      const host = $("#compare"); if (host) host.innerHTML = picked.map((s) => `<div><strong>${esc(s.createdAt.slice(0, 10))}</strong><br>${esc(s.title)}<p>${esc(s.body)}</p></div>`).join("");
    }));
  }
  if (detailTab === "actions") {
    $("#btn-analyze").addEventListener("click", async () => {
      if (!reviewerToken()) { toast("Enter the reviewer token in the City perspective first."); return; }
      if (aiStatus === "not_configured") { toast("Meta AI is not configured on this server."); return; }
      try {
        const r = await api(`/api/cases/${encodeURIComponent(w.id)}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        await refresh(); renderDetail(w);
        toast(r.duplicate ? "Evidence unchanged — same input hash, existing version kept." : "New analysis version saved.");
      } catch (err) { toast(`Analysis failed: ${err.message}`); }
    });
    $("#action-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try { await api(`/api/cases/${encodeURIComponent(w.id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: fd.get("title"), owner: fd.get("owner") }) });
        await refresh(); renderDetail(w); toast("Action recorded."); } catch (err) { toast(`Failed: ${err.message} (reviewer token required)`); }
    });
    $("#btn-close").addEventListener("click", async () => {
      if (!$("#confirm-close").checked) { toast("Tick the human confirmation first."); return; }
      try { await api(`/api/cases/${encodeURIComponent(w.id)}/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
        await refresh(); renderDetail(w); toast("Case closed by human confirmation."); } catch (err) { toast(`Failed: ${err.message} (reviewer token required)`); }
    });
  }
}
// ---------- accessible journey planner ----------
const MODE_LABEL = { WALK: "Walking", BUS: "Bus", TRAM: "Tram", SUBWAY: "Metro", RAIL: "Train", FERRY: "Ferry" };
const itinDistanceM = (it) => (it.legs || []).reduce((a, l) => a + (l.distanceM || 0), 0) || it.walkDistanceM || 0;
const itinModes = (it) => [...new Set((it.legs || []).map((l) => MODE_LABEL[l.mode] || l.mode))].join(" + ") || "—";
// One verification status for form, chat and journey card. Unknown evidence
// is never presented as verified; only recorded aspects are claimed, and the
// entrance is never certified by routing.
function accessStatus(it) {
  const legs = it.legs || [];
  if (legs.some((l) => l.accessibility === "conflict_in_source"))
    return "Does not meet your requirements — step-free conflict in source records";
  if (!it.suitable) {
    const r = (it.unsuitabilityReasons || []).join(" ");
    return /exceeds/i.test(r)
      ? "Does not meet your requirements — exceeds your maximum walking/wheeling distance"
      : "Does not meet your requirements";
  }
  const recorded = legs.length && legs.every((l) => l.accessibility === "recorded_in_source");
  return recorded ? "Step-free recorded for returned legs — entrance unverified" : "Step-free access not confirmed";
}
const accessPillClass = (it) => accessStatus(it).startsWith("Does not meet") ? "bad"
  : accessStatus(it).startsWith("Step-free recorded") ? "service" : "ongoing";
function clearJourneyMarkers() { for (const m of journeyMarkers) m.remove(); journeyMarkers = []; }
function drawJourney(fit = true) {
  if (!map || !mapReady) return;
  const src = map.getSource("journey"); if (!src) return;
  clearJourneyMarkers();
  const itin = journeyResult?.itineraries?.[selectedItinerary];
  if (!itin?.geometry?.length) { src.setData({ type: "FeatureCollection", features: [] }); return; }
  const coords = itin.geometry.map(([la, lo]) => [lo, la]);
  src.setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { unsuitable: !itin.suitable } }] });
  const ends = [[journeyResult.from, "A", "origin"], [journeyResult.to, "B", "dest"]]
    .filter(([p]) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  for (const [p, txt, cls] of ends) {
    const el = document.createElement("div");
    el.className = `journey-marker ${cls}`; el.textContent = txt;
    el.title = p.label || ""; el.setAttribute("aria-label", p.label || txt);
    journeyMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
  }
  if (fit && coords.length) {
    const b = coords.reduce((a, c) => [[Math.min(a[0][0], c[0]), Math.min(a[0][1], c[1])], [Math.max(a[1][0], c[0]), Math.max(a[1][1], c[1])]], [[180, 90], [-180, -90]]);
    const panel = $("#panel");
    const right = innerWidth > 760 && panel && !panel.hidden ? 410 : 40;
    const bottom = innerWidth <= 760 && panel && !panel.hidden ? (panel.offsetHeight || 300) + 84 : 90;
    map.fitBounds(b, { padding: { top: 60, bottom, left: 40, right }, maxZoom: 16, duration: reduced ? 0 : 900 });
  }
}
// One shared journey state for the planner form, the chat and the map.
function applyJourney(payload, fit = true) {
  if (!payload) return;
  journeyResult = payload;
  if (payload.from) journey.from = payload.from;
  if (payload.to) journey.to = payload.to;
  if (typeof payload.wheelchair === "boolean") journey.stepFree = payload.wheelchair;
  if (payload.maxWalkM != null) journey.maxWalk = String(payload.maxWalkM);
  const list = payload.itineraries || [];
  const firstOk = list.findIndex((i) => i.suitable);
  selectedItinerary = list.length ? (firstOk >= 0 ? firstOk : 0) : -1;
  drawJourney(fit);
}
const BOARD_TXT = { possible_in_source: "Wheelchair boarding possible in source", not_possible_in_source: "Wheelchair boarding NOT possible in source", unknown: "Boarding unknown in source" };
function openPlanner() {
  const opts = SNAP.services.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  openPanel("plan", `<h2>Plan an accessible journey</h2>
  <p class="small">Times use Europe/Helsinki. No medical information is requested.</p>
  ${mobilityStatus !== "configured" ? `<div class="ai-note"><strong>Live routing is not configured.</strong> Set <code>DIGITRANSIT_API_KEY</code> in the server-side .env (Digitransit API portal). No routes are simulated. You can still browse area context and submit reports.</div>` : ""}
  <form id="journey-form">
    <label class="field" for="journey-from">From
      <input id="journey-from" type="text" autocomplete="off" list="from-list" placeholder="Station, address or place…" value="${esc(journey.from?.label || "")}">
    </label><datalist id="from-list">${opts}</datalist>
    <div id="from-suggest" class="suggest" aria-live="polite"></div>
    <button class="btn small" type="button" id="use-location">Use my location</button>
    <label class="field" for="journey-to">To
      <input id="journey-to" type="text" autocomplete="off" list="to-list" placeholder="Where do you want to go?" value="${esc(journey.to?.label || "")}">
    </label><datalist id="to-list">${opts}</datalist>
    <div id="to-suggest" class="suggest" aria-live="polite"></div>
    <fieldset class="field"><legend>When</legend>
      <label><input type="radio" name="when" value="now" ${journey.when === "now" ? "checked" : ""}> Leave now</label>
      <label><input type="radio" name="when" value="depart" ${journey.when === "depart" ? "checked" : ""}> Depart at</label>
      <label><input type="radio" name="when" value="arrive" ${journey.when === "arrive" ? "checked" : ""}> Arrive by</label>
      <span id="dt-wrap" ${journey.when === "now" ? "hidden" : ""}><input type="datetime-local" id="journey-dt" value="${esc(journey.datetime || "")}" aria-label="Departure or arrival time"></span>
    </fieldset>
    <label class="check"><input type="checkbox" id="req-stepfree" ${journey.stepFree ? "checked" : ""}> Step-free access required (hard requirement)</label>
    <button class="btn primary" type="submit">Find journey options</button>
    <p class="small" id="journey-status" aria-live="polite"></p>
    <details class="more-prefs"><summary>More preferences</summary>
      <label class="field">Maximum outdoor walking / wheeling distance (m, optional)
        <input type="number" id="req-maxwalk" min="0" step="50" value="${esc(journey.maxWalk)}" placeholder="No limit"></label>
      <label class="check"><input type="checkbox" id="req-fewer" ${journey.fewerTransfers ? "checked" : ""}> Prefer fewer transfers</label>
    </details>
  </form>
  <button class="btn" id="go-chat" type="button">Journey assistant</button>`);
  wirePlanner();
}
function suggestWire(inputId, boxId, key) {
  const input = $(inputId); let timer;
  input.addEventListener("input", () => {
    journey[key] = null;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim(); if (q.length < 3) { $(boxId).innerHTML = ""; return; }
      try {
        const r = await api("/api/mobility/geocode?q=" + encodeURIComponent(q));
        $(boxId).innerHTML = (r.places || []).map((p, i) => `<button type="button" class="suggest-item" data-pick="${key}:${i}">${esc(p.label)} <span class="small">· ${esc(p.source)}</span></button>`).join("");
        $(boxId).querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
          const p = r.places[+b.dataset.pick.split(":")[1]];
          journey[key] = { lat: p.lat, lon: p.lon, label: p.label }; input.value = p.label; $(boxId).innerHTML = "";
        }));
      } catch { $(boxId).innerHTML = '<p class="small">Location search unavailable.</p>'; }
    }, 350);
  });
  input.addEventListener("change", () => {
    const svc = SNAP.services.find((s) => s.id === input.value || s.name === input.value);
    if (svc && !journey[key]) journey[key] = { lat: svc.lat, lon: svc.lon, label: svc.name };
  });
}
function wirePlanner() {
  suggestWire("#journey-from", "#from-suggest", "from");
  suggestWire("#journey-to", "#to-suggest", "to");
  const syncDt = () => { const w = document.querySelector("input[name=when]:checked")?.value || "now"; const d = $("#dt-wrap"); if (d) d.hidden = w === "now"; };
  document.querySelectorAll("input[name=when]").forEach((r) => r.addEventListener("change", syncDt));
  syncDt();
  $("#go-chat")?.addEventListener("click", () => { openChat(); $("#panel-input")?.focus(); });
  $("#use-location")?.addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Geolocation is not available in this browser."); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      journey.from = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "My location" };
      $("#journey-from").value = "My location"; toast("Location set as origin.");
    }, () => toast("Location was not shared. You can still type an origin."), { timeout: 10000 });
  });
  $("#journey-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    journey.stepFree = $("#req-stepfree").checked;
    journey.maxWalk = $("#req-maxwalk").value;
    journey.fewerTransfers = $("#req-fewer").checked;
    journey.when = document.querySelector("input[name=when]:checked")?.value || "now";
    journey.datetime = $("#journey-dt").value;
    if (!journey.from || !journey.to) { $("#journey-status").textContent = "Please choose both From and To from the suggestions."; return; }
    $("#journey-status").textContent = "Checking transport options…";
    $("#map-status").textContent = "Checking transport options";
    try {
      const payload = { from: journey.from, to: journey.to,
        requirements: { stepFree: journey.stepFree, maxWalkM: journey.maxWalk === "" ? null : +journey.maxWalk, fewerTransfers: journey.fewerTransfers },
        arriveBy: journey.when === "arrive",
        dateTime: journey.when === "now" || !journey.datetime ? null : new Date(journey.datetime).toISOString(),
        ownBarrierSubmissionId: ownBarrierId || undefined };
      const r = await fetch("/api/mobility/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const plan = await r.json();
      applyJourney({ ...plan, from: journey.from, to: journey.to, wheelchair: journey.stepFree, maxWalkM: payload.requirements.maxWalkM });
      renderJourneyResults();
    } catch { $("#journey-status").textContent = "The journey request could not be sent. No routes are shown."; }
  });
}
function legText(l) {
  const acc = l.mode === "WALK" ? (l.accessibilityScore == null ? "Accessibility unknown in source" : `Accessibility score ${l.accessibilityScore} in source`)
    : `Boarding: ${BOARD_TXT[l.fromStop?.label] || "unknown"}${l.tripWheelchairAccessible ? ` · Vehicle: ${l.tripWheelchairAccessible}` : ""}`;
  return `<li><strong>${esc(l.mode)}${l.line ? " " + esc(l.line) : ""}</strong> ${esc(l.from.name)} → ${esc(l.to.name)} · ${Math.round(l.distanceM)} m · ${fmtDur(l.durationS)}<br><span class="small">${esc(acc)}</span>
  ${(l.alerts || []).map((a) => `<br><span class="pill ongoing">Alert: ${esc(a.header)}</span> <span class="small">${esc(a.text)}</span>`).join("")}</li>`;
}
function renderJourneyResults() {
  const r = journeyResult; if (!r) return openPlanner();
  if (r.status === "not_configured") {
    openPanel("journey", `<h2>Journey options</h2><div class="ai-note"><strong>Live routing is not configured.</strong> ${esc(r.message || "")}</div>
    <p class="small">Setup: register at the Digitransit API portal, subscribe to the Routing API, then set <code>DIGITRANSIT_API_KEY</code> in the server-side .env and restart. Never paste the key into chat.</p>
    <button class="btn" id="back-plan">Back to planner</button>`);
    $("#back-plan").addEventListener("click", openPlanner); return;
  }
  const list = (r.itineraries || []).slice(0, 3);
  openPanel("journey", `<h2>Journey options</h2>
  <p class="small">${esc(journey.from?.label || "Origin")} → ${esc(journey.to?.label || "Destination")} · Source: Digitransit / HSL · Retrieved ${esc(String(r.retrievedAt || "").slice(0, 16).replace("T", " "))} UTC · ${esc(r.source?.licence || "")}</p>
  ${r.status === "no_suitable_option" ? `<div class="ai-note"><strong>No suitable option found</strong> for these requirements. Hard requirements were not relaxed.</div>` : ""}
  ${r.message && r.status !== "ok" && r.status !== "no_suitable_option" ? `<div class="ai-note">${esc(r.message)}</div>` : ""}
  ${list.map((it, i) => `<div class="finding ${i === selectedItinerary ? "selected-itin" : ""}">
    <p><strong>Option ${i + 1}</strong> · ${fmtHelsinki(it.start)} → ${fmtHelsinki(it.end)} · estimated ${fmtDur(it.durationS)} · ${it.transfers} transfer(s) · Walking/wheeling ${it.walkDistanceM} m</p>
    <p><span class="pill ${accessPillClass(it)}">${esc(accessStatus(it))}</span>
    <span class="pill">Entrance unverified</span></p>
    <ol class="steps">${it.legs.map(legText).join("")}</ol>
    ${it.ownBarrier?.near ? `<p class="small"><strong>Your unverified report</strong> is ${it.ownBarrier.distanceM} m from this option. It is not public evidence and does not change its status.</p>` : ""}
    ${(it.nearbyWorks || []).length ? `<p class="small"><strong>Possible context (not proven barriers)</strong> — Helsinki works snapshot ${esc(SNAP.snapshotId)}:</p><ul>${it.nearbyWorks.map((w) => `<li>${esc(w.kind)} — ${w.distanceM} m away · ${esc(w.source)}</li>`).join("")}</ul>` : ""}
    ${(it.nearbyReports || []).length ? `<p class="small"><strong>Community-reported (approved)</strong>:</p><ul>${it.nearbyReports.map((x) => `<li>${esc(x.title)} — ${x.distanceM} m · ${esc(x.sourceDate)}</li>`).join("")}</ul>` : ""}
    <p class="small">${esc(it.entrance)}</p>
    <button class="btn small" data-select-itin="${i}">Show this option on the map</button>
    <button class="btn small" data-report-itin="${i}">Report a possible barrier</button>
    ${ownBarrierId ? `<button class="btn small" data-reassess="1">Reassess with my report</button>` : ""}
  </div>`).join("") || "<p>No itineraries were returned.</p>"}
  <button class="btn" id="back-plan">Change requirements</button>
  <button class="btn" id="ask-journey">Ask AI about these options</button>`);
  document.querySelectorAll("[data-select-itin]").forEach((b) => b.addEventListener("click", () => { selectedItinerary = +b.dataset.selectItin; renderJourneyResults(); drawJourney(); }));
  document.querySelectorAll("[data-report-itin]").forEach((b) => b.addEventListener("click", () => openBarrierForm(+b.dataset.reportItin)));
  document.querySelectorAll("[data-reassess]").forEach((b) => b.addEventListener("click", () => { openPlanner(); toast("Reassessing with your unverified report…"); document.querySelector("#journey-form")?.requestSubmit(); }));
  $("#back-plan").addEventListener("click", openPlanner);
  $("#ask-journey")?.addEventListener("click", () => { openChat(); sendChat(`Compare my journey options from ${journey.from?.label} to ${journey.to?.label}. Step-free required: ${journey.stepFree}. What is known, what is unknown, and what should I check?`); });
}
function openBarrierForm(itinIdx) {
  const it = journeyResult?.itineraries?.[itinIdx];
  const mid = it?.geometry?.[Math.floor(it.geometry.length / 2)] || [SNAP.demoArea.centre.lat, SNAP.demoArea.centre.lon];
  openPanel("details", `<h2>Report a possible barrier</h2>
  <p class="small">Your report stays <strong>private</strong> until a reviewer approves it. It will not silently change public recommendations. A photo may show a possible obstacle only — it cannot certify accessibility.</p>
  <form id="barrier-form">
    <label class="field">What did you encounter?
      <textarea name="description" required maxlength="2000" placeholder="Where exactly, and what blocks step-free passage?"></textarea></label>
    <label class="field">Photo (optional, max 5 MB) <input type="file" id="barrier-file" accept="image/png,image/jpeg,image/webp,application/pdf"></label>
    <input type="hidden" name="lat" value="${mid[0]}"><input type="hidden" name="lon" value="${mid[1]}">
    <p class="small">Location: near the selected route (${mid[0].toFixed(5)}, ${mid[1].toFixed(5)}). Demo scenario entries, if any, are labelled and never presented as factual records.</p>
    <button class="btn primary" type="submit">Analyse and prepare my report</button>
    <p class="small" id="barrier-status" aria-live="polite"></p>
  </form>
  <div id="barrier-draft"></div>
  <button class="btn" id="back-results">Back to options</button>`);
  $("#back-results").addEventListener("click", renderJourneyResults);
  $("#barrier-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $("#barrier-status").textContent = "Analysing visible evidence…";
    try {
      let uploadId = null;
      const file = $("#barrier-file").files[0];
      if (file) {
        const up = new FormData(); up.append("file", file);
        const ur = await fetch("/api/uploads", { method: "POST", body: up });
        const uj = await ur.json().catch(() => ({}));
        if (!ur.ok) throw new Error(uj.error || "upload_failed");
        uploadId = uj.id;
      }
      const r = await api("/api/mobility/analyse-barrier", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: fd.get("description"), uploadId }) });
      const d = r.draft;
      $("#barrier-draft").innerHTML = `<div class="draft"><strong>Draft — not saved yet</strong><p>${esc(d.title)}</p><p>${esc(d.body)}</p>
      <p class="small">${esc(r.note || "")}</p>
      <button class="btn primary" id="confirm-barrier">Confirm and submit for review</button>
      <button class="btn" id="discard-barrier">Discard</button></div>`;
      $("#barrier-status").textContent = "";
      $("#confirm-barrier").addEventListener("click", async () => {
        const s = await api("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "report", category: d.category, title: d.title, body: d.body,
            lat: +fd.get("lat"), lon: +fd.get("lon"), uploadId }) });
        ownBarrierId = s.id;
        $("#barrier-draft").innerHTML = `<p><strong>Submitted privately for review.</strong> You can now reassess your journey with it as an explicitly unverified concern from the options view.</p>`;
        toast("Report submitted privately for review.");
      });
      $("#discard-barrier").addEventListener("click", () => { $("#barrier-draft").innerHTML = ""; });
    } catch (err) { $("#barrier-status").textContent = `Could not prepare the report: ${err.message}`; }
  });
}
// ---------- AI chat ----------
function openChat() {
  openPanel("chat", `<h2>Journey assistant</h2>
    <p class="small">Routes come from live Digitransit/HSL queries. Roadworks context is a dated snapshot. Unknown means unverified.</p>
    <div id="chat-log">${chatLog.map(chatMsgHtml).join("") || '<p class="small">Try: “Step-free journey from Central Station to Oodi, please.”</p>'}</div>
    <div id="chat-live" aria-live="polite"></div>`);
}
const shortPlace = (label) => String(label || "").split(",")[0].replace(/^Helsinki /, "") || "Place";
function journeyCardHtml(m) {
  const j = m.journey; if (!j) return "";
  const list = j.itineraries || [];
  if (!list.length)
    return `<div class="journey-card unsuitable"><strong>No suitable option found.</strong><br><span class="small">Any previous route no longer applies to these requirements. Nothing was relaxed.</span></div>`;
  const sel = Math.min(m.selectedItin ?? 0, list.length - 1);
  return list.map((it, i) => `<button type="button" class="journey-card ${i === sel ? "selected" : ""} ${it.suitable ? "" : "unsuitable"}" data-jcard="${i}" aria-pressed="${i === sel}">
    <span class="t">${esc(shortPlace(j.from?.label))} → ${esc(shortPlace(j.to?.label))}</span>
    <span class="s">walking/wheeling ${it.walkDistanceM} m · estimated ${fmtDur(it.durationS)} · ${it.transfers ? `${it.transfers} transfer(s)` : "no transfers"} · ${esc(itinModes(it))}</span>
    <span class="pill ${accessPillClass(it)}">${esc(accessStatus(it))}</span>
    <span class="s">${j.wheelchair ? "Requested with wheelchair routing." : ""}</span>
    <span class="s action">${i === sel ? "Shown on the map" : "Show on the map"}</span></button>`).join("");
}
function detailsHtml(m) {
  const j = m.journey, prov = m.provenance || [];
  if (!j && !prov.length) return "";
  const sel = j?.itineraries?.[Math.min(m.selectedItin ?? 0, (j.itineraries?.length || 1) - 1)];
  return `<details class="sources"><summary>Sources and details</summary><dl>
    ${prov.map((p) => `<dt>${p.type === "live" ? "Live query" : "Dated snapshot"}</dt><dd>${esc(p.service)}${p.at ? ` · ${esc(String(p.at).slice(0, 16).replace("T", " "))}` : ""}</dd>`).join("")}
    ${j ? `<dt>Journey query</dt><dd>Digitransit / HSL${j.retrievedAt ? ` · retrieved ${esc(String(j.retrievedAt).slice(0, 16).replace("T", " "))} UTC` : ""} · ${esc(j.source?.licence || "CC BY 4.0")} · Duration is an estimate, not a personalised wheelchair travel time.</dd>` : ""}
    ${sel ? `<dt>Steps</dt><dd>${(sel.legs || []).map((l) => `${esc(l.mode)}${l.line ? " " + esc(l.line) : ""}: ${esc(l.from?.name || "")} → ${esc(l.to?.name || "")}, ${Math.round(l.distanceM || 0)} m (${esc(l.accessibility || "unknown")})`).join("<br>")}</dd>
    <dt>Walking / wheeling</dt><dd>${sel.walkDistanceM} m · Entrance: ${esc(sel.entrance || "unverified")}</dd>
    ${(sel.nearbyWorks || []).length ? `<dt>Nearby works (possible context, not proven barriers)</dt><dd>${sel.nearbyWorks.map((w) => `${esc(w.kind)} — ${w.distanceM} m · ${esc(w.source)} · snapshot ${esc(w.sourceDate || "")}`).join("<br>")}</dd>` : ""}
    ${(sel.legs || []).flatMap((l) => l.alerts || []).length ? `<dt>Service alerts</dt><dd>${sel.legs.flatMap((l) => l.alerts || []).map((a) => esc(a.header)).join("; ")}</dd>` : ""}` : ""}
    </dl></details>`;
}
function chatMsgHtml(m) {
  if (m.role === "user") return `<div class="msg user">${esc(m.text)}</div>`;
  return `<div class="msg ai">${journeyCardHtml(m)}<div class="msg-text">${mdHtml(m.text)}</div>${m.activity ? `<div class="progress done">${esc(m.activity)}</div>` : ""}${m.cards?.length ? m.cards.map(cardHtml).join("") : ""}${m.draft ? draftHtml(m.draft) : ""}${detailsHtml(m)}${m.retry ? `<button class="btn small" data-retry="1">Retry</button>` : ""}</div>`;
}
function cardHtml(c) {
  return `<button class="result-card" data-card="${esc(c.id)}" data-kind="${esc(c.cardType || "")}"><span class="t">${esc(c.title || c.id)}</span><br>
  <span class="small">${esc(c.kind || c.category || "")}${c.distanceM != null ? ` · ${c.distanceM} m` : ""}${c.starts ? ` · ${esc(c.starts)} – ${esc(c.ends || "")}` : ""}</span></button>`;
}
function draftHtml(d) {
  return `<div class="draft"><strong>Report draft — not saved yet</strong><p>${esc(d.title)}</p><p>${esc(d.body)}</p>
  <p class="small">For: ${esc(d.workTitle || d.workId)} · Category: ${esc(d.category)}</p>
  <button class="btn primary" data-confirm-draft="1">Confirm and submit for review</button>
  <button class="btn" data-discard-draft="1">Discard draft</button></div>`;
}
async function sendChat(text) {
  const msg = (text || "").trim(); if (!msg) return;
  chatLog.push({ role: "user", text: msg });
  openChat();
  const live = $("#chat-live");
  live.innerHTML = `<div class="progress">Sending to the Journey assistant…</div>`;
  let draft = null, cards = [], finalText = "", failed = false, evJourney = null, provenance = [];
  const stepsSeen = [];
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, history: chatLog.slice(0, -1).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })) }) });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "progress") {
          // One live status line only; the full activity is summarised once,
          // collapsed, on the finished message.
          if (!stepsSeen.includes(ev.step)) stepsSeen.push(ev.step);
          live.innerHTML = `<div class="progress">${esc(ev.step)}…</div>`;
        }
        else if (ev.type === "status") { finalText = ev.text; }
        else if (ev.type === "final") { finalText = ev.text; cards = ev.cards || []; draft = ev.draft; evJourney = ev.journey || null; provenance = ev.provenance || []; }
        else if (ev.type === "error") { failed = true; finalText = ev.text || "The request failed."; }
      }
    }
  } catch { failed = true; finalText = "The request could not be sent."; }
  if (evJourney) applyJourney(evJourney);
  const entry = { role: "ai", text: finalText || "No answer was returned.", cards, draft,
    journey: evJourney, provenance, selectedItin: selectedItinerary >= 0 ? selectedItinerary : 0,
    activity: stepsSeen.length ? `${stepsSeen.join(" · ")} — done` : null, retry: failed ? msg : null };
  chatLog.push(entry);
  lastCards = cards;
  openChat();
  if (cards.length) highlightCards(cards);
  wireChatCards();
}
function highlightCards(cards) {
  for (const c of cards) { const el = markers.get(c.id); if (el) el.classList.add("selected"); }
  const first = cards.find((c) => c.lat != null);
  if (first && map) map.flyTo({ center: [first.lon, first.lat], zoom: 16, duration: reduced ? 0 : 1000 });
}
function wireChatCards() {
  document.querySelectorAll("[data-jcard]").forEach((b) => b.addEventListener("click", () => {
    // Highlight the chosen route on the map; the conversation stays open.
    selectedItinerary = +b.dataset.jcard;
    const m = chatLog.findLast((x) => x.journey); if (m) m.selectedItin = selectedItinerary;
    document.querySelectorAll("[data-jcard]").forEach((x) => {
      const on = +x.dataset.jcard === selectedItinerary;
      x.classList.toggle("selected", on); x.setAttribute("aria-pressed", String(on));
    });
    drawJourney(true);
  }));
  document.querySelectorAll("[data-retry]").forEach((b) => b.addEventListener("click", () => {
    const m = chatLog.findLast((x) => x.retry); if (m?.retry) sendChat(m.retry);
  }));
  document.querySelectorAll("[data-card]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.kind === "place") selectService(b.dataset.card); else selectWork(b.dataset.card);
  }));
  document.querySelectorAll("[data-confirm-draft]").forEach((b) => b.addEventListener("click", async () => {
    const m = chatLog.findLast((x) => x.draft); if (!m) return;
    try {
      const w = SNAP.works.find((x) => x.id === m.draft.workId);
      await api("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...m.draft, lat: w?.centroid.lat, lon: w?.centroid.lon }) });
      m.draft = null; chatLog.push({ role: "ai", text: "Draft submitted. It will appear publicly only after a reviewer approves it." });
      await refresh(); openChat(); wireChatCards(); toast("Report submitted for review.");
    } catch (err) { toast(`Submit failed: ${err.message}`); }
  }));
  document.querySelectorAll("[data-discard-draft]").forEach((b) => b.addEventListener("click", () => {
    const m = chatLog.findLast((x) => x.draft); if (m) m.draft = null; openChat(); wireChatCards();
  }));
}
// ---------- reviewer (City) ----------
async function renderReview() {
  if (!reviewerToken()) {
    openPanel("chat", `<h2>City reviewer sign-in</h2>
    <p>Review, analysis, actions and closure are protected on the server. Enter the reviewer token configured in the server-side .env. It is stored only in this browser tab.</p>
    ${reviewerConfigured ? "" : '<div class="ai-note">The server has no REVIEWER_TOKEN configured, so reviewer operations are disabled.</div>'}
    <form id="token-form"><label class="field">Reviewer token <input type="password" name="token" autocomplete="off"></label>
    <button class="btn primary" type="submit">Continue</button></form>`);
    $("#token-form").addEventListener("submit", async (e) => { e.preventDefault();
      sessionStorage.setItem("reviewerToken", new FormData(e.target).get("token"));
      try { await refresh(); renderReview(); } catch { toast("Token rejected by the server."); } });
    return;
  }
  let queue = [];
  try { queue = await api("/api/review-queue"); } catch { toast("Reviewer token rejected."); return; }
  openPanel("chat", `<h2>Review queue</h2><p class="small">Pending submissions are private and excluded from public chat and APIs until approved.</p>
  ${queue.length ? queue.map((s) => `<div class="finding"><p><strong>${esc(s.title)}</strong></p><p>${esc(s.body)}</p>
    <p class="small">${esc(s.type)} · ${esc(s.category)} · ${esc(s.createdAt.slice(0, 10))}${s.uploadId ? " · File uploaded (private)" : ""}</p>
    <button class="btn small" data-approve="${esc(s.id)}">Approve</button> <button class="btn small warn" data-reject="${esc(s.id)}">Reject</button></div>`).join("") : "<p>The queue is empty.</p>"}
  <button class="btn" id="sign-out">Sign out reviewer</button>`);
  document.querySelectorAll("[data-approve],[data-reject]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/submissions/${b.dataset.approve || b.dataset.reject}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve: !!b.dataset.approve }) });
    await refresh(); renderReview(); toast("Review saved.");
  }));
  $("#sign-out").addEventListener("click", () => { sessionStorage.removeItem("reviewerToken"); closePanel(); });
}
// Scrolling inside an overlay must never zoom or pan the map, including at
// scroll boundaries: contain overscroll and keep map gestures off overlays.
function guardOverlayScroll() {
  for (const sel of ["#panel", "#layers-pop", "#chat-bar"]) {
    const el = $(sel); if (!el) continue;
    el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    el.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });
    el.addEventListener("pointerenter", () => { map?.scrollZoom?.disable(); map?.touchPan?.disable(); });
    el.addEventListener("pointerleave", () => { map?.scrollZoom?.enable(); map?.touchPan?.enable(); });
  }
}
// ---------- wiring ----------
async function refresh() {
  submissions = await api("/api/submissions");
  const cs = await api("/api/cases"); cases = Object.fromEntries(cs.map((c) => [c.workId, c]));
  drawMap();
}
async function boot() {
  SNAP = await api("/api/snapshot");
  const st = await api("/api/ai/status");
  aiStatus = st.status; reviewerConfigured = st.reviewer === "configured";
  try { mobilityStatus = (await api("/api/mobility/status")).status; } catch { mobilityStatus = "not_configured"; }
  $("#snap-date").textContent = SNAP.snapshotId;
  initMap(SNAP.demoArea.centre);
  await refresh();
  openPlanner();
}
$("#chat-bar").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#chat-input").value; $("#chat-input").value = ""; sendChat(v); });
$("#panel-composer").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#panel-input").value; $("#panel-input").value = ""; sendChat(v); });
document.querySelectorAll(".starter").forEach((b) => b.addEventListener("click", () => sendChat(b.textContent.trim())));
$("#layers-btn").addEventListener("click", () => {
  const p = $("#layers-pop"); const opening = p.hidden;
  if (opening) closePanel();
  p.hidden = !opening;
  $("#layers-btn").setAttribute("aria-expanded", String(opening));
  if (opening) drawMap();
});
$("#show-results").addEventListener("click", () => { $("#layers-pop").hidden = true; renderResults(); });
$("#close-panel").addEventListener("click", closePanel);
$("#search").addEventListener("input", () => { drawMap(); if (panelMode === "results") renderResults(); });
document.querySelectorAll(".barrier-filter").forEach((x) => x.addEventListener("click", () => {
  x.setAttribute("aria-pressed", String(x.getAttribute("aria-pressed") !== "true")); drawMap(); if (panelMode === "results") renderResults();
}));
const setVis = (ids, on) => { if (!map || !mapReady) return; for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
$("#lay-works").addEventListener("change", () => { setVis(["works-fill", "works-line", "works-selected"], $("#lay-works").checked); drawMap(); });
$("#lay-services").addEventListener("change", () => drawMap());
$("#lay-buildings").addEventListener("change", (e) => setVis(["buildings-fill"], e.target.checked));
$("#lay-routes").addEventListener("change", (e) => setVis(["routes-verified", "routes-unknown"], e.target.checked));
$("#demo-badge").addEventListener("click", () => {
  openPanel("details", `<h2>About this demonstrator</h2><p>Independent demonstrator using Helsinki open data. Not endorsed by the City of Helsinki.</p>
  <p class="small">Green route segments: source records realised accessibility. Dashed grey segments: recorded, but realised accessibility is unknown in the source. Building heights are not shown in this interface; floor counts are kept in the source records. A geographic 3D view is not included (see README).</p>
  ${sourcesHtml({ id: "snapshot:" + SNAP.snapshotId, source: { provider: "City of Helsinki GeoServer WFS + Service Map", layer: "multiple", url: "https://kartta.hel.fi" } })}`);
});
document.querySelectorAll("[data-persp]").forEach((b) => b.addEventListener("click", () => {
  perspective = b.dataset.persp;
  document.querySelectorAll("[data-persp]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  if (perspective === "city") renderReview();
  else toast(perspective === "business" ? "Business perspective" : "Resident perspective");
}));
guardOverlayScroll();
boot().catch(() => { openPanel("details", "<h2>Data unavailable</h2><p>The snapshot could not be loaded from the backend.</p>"); });
