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
let journeyMarkers = [], journeyLegHl = -1;
// [helsinki-time] A datetime-local value is Europe/Helsinki wall time, in
// summer and winter alike; the browser timezone must never change the instant.
function helsinkiOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const v = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second) - Math.floor(utcMs / 1000) * 1000;
}
function helsinkiToIso(wall) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall || "");
  if (!m) return null;
  // Date.UTC silently rolls impossible dates (30 February) into the next
  // month; reject anything whose components do not round-trip exactly.
  const check = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  if (check.getUTCFullYear() !== +m[1] || check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3]
    || check.getUTCHours() !== +m[4] || check.getUTCMinutes() !== +m[5]) return null;
  const wallAsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = wallAsUtc - helsinkiOffsetMs(wallAsUtc);
  utc = wallAsUtc - helsinkiOffsetMs(utc);
  return new Date(utc).toISOString();
}
function isoToHelsinkiLocal(iso) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
  const v = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const pad = (n) => String(n).padStart(2, "0");
  return `${v.year}-${pad(v.month)}-${pad(v.day)}T${pad(v.hour % 24)}:${pad(v.minute)}`;
}
// [/helsinki-time]
// [building-height] The snapshot carries a floor count (floors) and its
// provenance (heightSource), never a measured height in metres. Extrusion
// height is therefore always an estimate: floors × 3 m per floor, labelled
// as an estimate. Buildings without a usable floor count stay flat.
function buildingHeightProps(b) {
  const floors = b && Number.isFinite(+b.floors) && +b.floors > 0 ? +b.floors : null;
  return { h: floors != null ? floors * 3 : 0, est: floors != null, known: floors != null };
}
// [/building-height]
// [map-visuals] Building colours encode the use recorded for the building
// in the source register (Finnish type names), nothing else; unrecorded or
// unmapped uses stay neutral. Simulated traffic runs only on carriageway
// geometry from the snapshot (OpenStreetMap roads fetched via Overpass,
// ODbL). Accessibility/pedestrian lines are never traffic geometry. Flow
// classes are a deterministic function of the road's stable OSM id: they
// are demonstrative, not measured, and never feed routing or accessibility.
const CARRIAGEWAYS = ["primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "residential", "unclassified", "living_street"];
const FLOW_SPEED_MPS = { fast: 30, moderate: 16, slow: 7 };
function flowClass(id) {
  let h = 0;
  for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const r = h % 10;
  return r < 5 ? "fast" : r < 8 ? "moderate" : "slow";
}
function buildingUse(b) {
  const t = String(b?.source?.original?.tyyppi || "");
  if (/^Asuin/.test(t)) return "residential";
  if (/^(Liike|Kauppa|Toimisto)/.test(t)) return "commercial";
  if (/^(Opetus|Päiväkoti|Kirkko|Asema|Vartio)/.test(t)) return "public";
  if (/^(Talous|Varasto|Tehdas|Autotalli|Muuntamo|Huolto)/.test(t)) return "industrial";
  return "other";
}
function trafficCum(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], c = coords[i], t = Math.PI / 180;
    const x = Math.sin(((c[1] - a[1]) * t) / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(c[1] * t) * Math.sin(((c[0] - a[0]) * t) / 2) ** 2;
    cum.push(cum[i - 1] + 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
  }
  return cum;
}
function trafficPointAt(coords, cum, dist) {
  const total = cum[cum.length - 1] || 0;
  if (!coords.length) return null;
  if (total <= 0) return coords[0];
  let d = ((dist % total) + total) % total;
  for (let i = 1; i < cum.length; i++) {
    if (d <= cum[i] || i === cum.length - 1) {
      const f = cum[i] > cum[i - 1] ? (d - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
      const a = coords[i - 1], b = coords[i];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  return coords[coords.length - 1];
}
function buildTraffic(roads) {
  const paths = (roads || [])
    .filter((r) => r && CARRIAGEWAYS.includes(r.highway) && r.geometry?.type === "LineString" && r.geometry.coordinates?.length > 1)
    .map((r) => {
      const coords = r.geometry.coordinates;
      const cum = trafficCum(coords);
      return { id: r.id, coords, cum, total: cum[cum.length - 1], flow: flowClass(r.id), oneway: r.oneway === true };
    })
    .filter((p) => p.total >= 35);
  const vehicles = [];
  paths.forEach((p, i) => {
    const count = Math.min(3, Math.max(1, Math.round(p.total / 110)));
    for (let k = 0; k < count; k++) {
      let h = 0;
      for (const ch of String(p.id)) h = (h * 17 + ch.charCodeAt(0)) >>> 0;
      vehicles.push({ path: i, flow: p.flow,
        offset: ((k + 0.5) / count) * p.total + (h % 40),
        speed: FLOW_SPEED_MPS[p.flow], dir: p.oneway || (h + k) % 2 === 0 ? 1 : -1 });
    }
  });
  return { paths, vehicles };
}
function trafficPositions(traffic, elapsedS) {
  return (traffic?.vehicles || []).map((v) => {
    const p = traffic.paths[v.path];
    const point = trafficPointAt(p.coords, p.cum, v.offset + v.dir * v.speed * elapsedS);
    return point ? { point, flow: v.flow } : null;
  }).filter(Boolean);
}
// [/map-visuals]
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
function openPanel(mode, html, title = "") {
  $("#layers-pop").hidden = true; $("#layers-btn").setAttribute("aria-expanded", "false");
  panelMode = mode;
  const w = $("#welcome"); if (w) w.hidden = true;
  // The panel title lives in the fixed header, never in the scrolling area:
  // a leading <h2> in the content is lifted into the header automatically.
  const h2 = /^\s*<h2>([\s\S]*?)<\/h2>/.exec(html);
  if (h2) {
    title = h2[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    html = html.slice(h2[0].length);
  }
  $("#panel-title").textContent = title;
  $("#panel-content").innerHTML = html;
  $("#panel").hidden = false;
  const nr = $("#new-response"); if (nr && mode !== "chat") nr.hidden = true;
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
    pitch: 52, bearing: -14, minZoom: 11, maxZoom: 19, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl(), "bottom-right");
  map.on("error", onTileError);
  map.on("sourcedata", (e) => {
    if (e.sourceId === "hsl" && e.tile) { tileLoadedOnce = true; tileRetries = 0; if (!$("#tile-note").hidden) hideBaseError(); }
  });
  setTimeout(() => { if (!tileLoadedOnce) showBaseError(); }, 15000);
  map.on("load", () => {
    mapReady = true;
    map.addSource("buildings", { type: "geojson", data: { type: "FeatureCollection", features: SNAP.buildings.filter((b) => b.geometry).map((b) => ({ type: "Feature", geometry: b.geometry,
      properties: { ...buildingHeightProps(b), use: buildingUse(b) } })) } });
    map.addLayer({ id: "buildings-fill", type: "fill", source: "buildings", layout: { visibility: "none" },
      paint: { "fill-color": ["match", ["get", "use"], "residential", "#cfa06b", "commercial", "#7ea3bd", "public", "#84ad97", "industrial", "#a8adb2", "#d0c9bb"], "fill-opacity": 0.55, "fill-outline-color": "#7d8894" } });
    map.addLayer({ id: "bldg-3d", type: "fill-extrusion", source: "buildings", layout: { visibility: "none" },
      paint: { "fill-extrusion-color": ["match", ["get", "use"], "residential", "#cfa06b", "commercial", "#7ea3bd", "public", "#84ad97", "industrial", "#a8adb2", "#d0c9bb"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.84 } });
    map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: SNAP.accessibilityRoutes.filter((r) => r.geometry).map((r) => ({ type: "Feature", geometry: r.geometry, properties: { verified: r.realisedAccessibility === "Kyllä" } })) } });
    map.addLayer({ id: "routes-verified", type: "line", source: "routes", filter: ["==", ["get", "verified"], true], layout: { visibility: "none" }, paint: { "line-color": "#1f8a4c", "line-width": 3 } });
    map.addLayer({ id: "routes-unknown", type: "line", source: "routes", filter: ["!=", ["get", "verified"], true], layout: { visibility: "none" }, paint: { "line-color": "#8a94a0", "line-width": 2, "line-dasharray": [2, 2] } });
    // Simulated demo traffic on real carriageway geometry only: OpenStreetMap
    // roads from the dated snapshot (Overpass API, ODbL). Coloured segments
    // and pulses are demonstrative (deterministic per road), not live traffic,
    // and never run on accessibility or pedestrian lines.
    demoTraffic = buildTraffic(SNAP.roads || []);
    map.addSource("traffic-lines-src", { type: "geojson", data: { type: "FeatureCollection",
      features: (SNAP.roads || []).filter((r) => CARRIAGEWAYS.includes(r.highway) && r.geometry?.type === "LineString")
        .map((r) => ({ type: "Feature", geometry: r.geometry, properties: { flow: flowClass(r.id), name: r.name || "" } })) } });
    map.addLayer({ id: "traffic-lines", type: "line", source: "traffic-lines-src",
      paint: { "line-color": ["match", ["get", "flow"], "fast", FLOW_COLORS.fast, "moderate", FLOW_COLORS.moderate, FLOW_COLORS.slow],
        "line-width": 3.2, "line-opacity": 0.8 } });
    map.addSource("traffic-pulses", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "traffic-pulses", type: "circle", source: "traffic-pulses",
      paint: { "circle-color": ["match", ["get", "flow"], "fast", FLOW_COLORS.fast, "moderate", FLOW_COLORS.moderate, FLOW_COLORS.slow],
        "circle-radius": 4.2, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.4, "circle-opacity": 0.95 } });
    applyBuildingVis();
    setVis(["routes-verified", "routes-unknown"], $("#lay-routes")?.checked !== false);
    applyTrafficVis();
    map.addSource("journey", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "journey-line", type: "line", source: "journey", filter: ["all", ["!=", ["get", "unsuitable"], true], ["!=", ["get", "schematic"], true], ["!=", ["get", "mode"], "WALK"]], paint: { "line-color": "#0f62b4", "line-width": 5, "line-opacity": 0.9 } });
    map.addLayer({ id: "journey-walk", type: "line", source: "journey", filter: ["all", ["!=", ["get", "unsuitable"], true], ["!=", ["get", "schematic"], true], ["==", ["get", "mode"], "WALK"]], paint: { "line-color": "#0f62b4", "line-width": 3.5, "line-dasharray": [1.5, 1.2], "line-opacity": 0.95 } });
    map.addLayer({ id: "journey-line-bad", type: "line", source: "journey", filter: ["==", ["get", "unsuitable"], true], paint: { "line-color": "#8a94a0", "line-width": 4, "line-dasharray": [2, 2], "line-opacity": 0.9 } });
    map.addLayer({ id: "journey-schematic", type: "line", source: "journey", filter: ["==", ["get", "schematic"], true], paint: { "line-color": "#b95e00", "line-width": 3, "line-dasharray": [4, 3], "line-opacity": 0.9 } });
    map.addLayer({ id: "journey-leg-hl", type: "line", source: "journey", filter: ["==", ["get", "leg"], -1], paint: { "line-color": "#ffb020", "line-width": 9, "line-opacity": 0.55 } });
    map.addSource("works", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "works-fill", type: "fill", source: "works", paint: { "fill-color": "#38b6d3", "fill-opacity": 0.16 } });
    map.addLayer({ id: "works-line", type: "line", source: "works", paint: { "line-color": "#0e7ea6", "line-width": 2 } });
    map.addLayer({ id: "works-selected", type: "line", source: "works", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#b95e00", "line-width": 3.5 } });
    map.on("click", (e) => {
      if (!pickState) return;
      pickState.draft.candidate = { lat: e.lngLat.lat, lon: e.lngLat.lng, label: "Point chosen on the map" };
      showPickMarker(e.lngLat.lat, e.lngLat.lng);
      const render = pickState.render; render?.();
    });
    map.on("click", "works-fill", (e) => { const id = e.features?.[0]?.properties?.id; if (id) selectWork(id, false); });
    map.on("mouseenter", "works-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "works-fill", () => { map.getCanvas().style.cursor = ""; });
    drawMap();
  });
  map.on("moveend", () => { drawMap(); if (panelMode === "results") renderResults(false); });
}
let demoTraffic = null, trafficRaf = 0, trafficT0 = null, trafficDimmed = false;
const FLOW_COLORS = { fast: "#2e9e5b", moderate: "#d9930d", slow: "#c93a2e" };
function applyBuildingVis() {
  if (!map || !mapReady) return;
  const on = $("#lay-buildings")?.checked !== false;
  setVis(["bldg-3d"], on && view3d);
  setVis(["buildings-fill"], on && !view3d);
}
function trafficFrame() {
  const src = map?.getSource("traffic-pulses");
  if (!src || !demoTraffic) return;
  const elapsed = trafficT0 == null ? 0 : (performance.now() - trafficT0) / 1000;
  src.setData({ type: "FeatureCollection",
    features: trafficPositions(demoTraffic, elapsed).map(({ point, flow }) => ({ type: "Feature", geometry: { type: "Point", coordinates: point }, properties: { flow } })) });
}
function applyTrafficVis() {
  if (!map || !mapReady) return;
  const on = $("#lay-traffic")?.checked !== false;
  // Hidden entirely during journey preview; dimmed while a route is
  // selected so the journey stays dominant. The compact simulated label
  // is visible exactly while the simulated traffic is.
  const shown = on && !preview;
  setVis(["traffic-lines", "traffic-pulses"], shown);
  if (map.getLayer("traffic-lines")) {
    map.setPaintProperty("traffic-lines", "line-opacity", trafficDimmed ? 0.16 : 0.8);
    map.setPaintProperty("traffic-pulses", "circle-opacity", trafficDimmed ? 0.3 : 0.95);
  }
  const badge = $("#sim-badge"); if (badge) badge.hidden = !shown;
  cancelAnimationFrame(trafficRaf); trafficRaf = 0;
  if (!shown) return;
  trafficFrame();
  if (reduced) return; // static simulated pulses; no continuous motion
  trafficT0 = performance.now();
  const loop = () => {
    if (!map || $("#lay-traffic")?.checked === false || preview) return;
    trafficFrame();
    trafficRaf = requestAnimationFrame(loop);
  };
  trafficRaf = requestAnimationFrame(loop);
}
const ICONS = {
  // Works are dated context, not confirmed barriers: a neutral site symbol,
  // never a danger triangle.
  work: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V9l8-5 8 5v12h-5.5v-5.5h-5V21H4zm2-1.5h2V14h8v5.5h2V10L12 6.2 6 10v9.5z" fill="currentColor"/></svg>',
  service: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z" fill="currentColor"/></svg>',
  business: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16l-1.2 12.1a2 2 0 0 1-2 1.9H7.2a2 2 0 0 1-2-1.9L4 7zm4 0a4 4 0 0 1 8 0h-2a2 2 0 1 0-4 0H8z" fill="currentColor"/></svg>',
  place: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z" fill="currentColor"/></svg>',
};
function markerEl(kind, cat, label, isSel) {
  const el = document.createElement("div");
  const cls = kind === "work" ? "pm-work" : cat === "public_service" ? "pm-service" : cat === "business" ? "pm-business" : "pm-place";
  const svg = kind === "work" ? ICONS.work : cat === "public_service" ? ICONS.service : cat === "business" ? ICONS.business : ICONS.place;
  // The element stays a generous, accessible click target; only the
  // visible symbol shrinks, so small symbols never mean small targets.
  el.className = `place-marker ${cls}${isSel ? " selected" : ""}`;
  el.innerHTML = `<span class="pm-symbol">${svg}</span><span class="marker-label">${esc(label)}</span>`;
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
  // Progressive detail, shared across categories so markers of different
  // categories can never overlap: the selected item is always shown alone;
  // everything else is grouped by pixel distance, with the grouping radius
  // shrinking as the user zooms in (more individual detail at high zoom).
  const radius = zoom >= 17 ? 30 : zoom >= 16 ? 52 : zoom >= 15 ? 78 : 108;
  const groups = [];
  for (const it of items) {
    if (it.id === selected) { groups.push([it]); continue; }
    const pt = map.project([it.lon, it.lat]);
    let g = groups.find((grp) => !grp._single && Math.hypot(grp._x - pt.x, grp._y - pt.y) < radius);
    if (!g) { g = []; g._x = pt.x; g._y = pt.y; groups.push(g); }
    g.push(it);
  }
  for (const group of groups) {
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
      const kinds = [...new Set(group.map((i) => i.kind === "work" ? "works" : "places"))].join(" and ");
      const el = document.createElement("div");
      el.className = "cluster-marker";
      el.innerHTML = `<span class="cluster-count">${group.length}</span>`;
      el.setAttribute("role", "button"); el.setAttribute("aria-label", `${group.length} ${kinds}, activate to zoom in`); el.tabIndex = 0;
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
  trafficDimmed = !!itin?.geometry?.length;
  applyTrafficVis();
  if (!itin?.geometry?.length) { src.setData({ type: "FeatureCollection", features: [] }); return; }
  const coords = itin.geometry.map(([la, lo]) => [lo, la]);
  const schematic = itin.geometrySource === "schematic_endpoint_links";
  const legFeatures = (itin.legs || []).filter((l) => l.points?.length > 1).map((l, li) => ({
    type: "Feature", geometry: { type: "LineString", coordinates: l.points.map(([la, lo]) => [lo, la]) },
    properties: { unsuitable: !itin.suitable, schematic, mode: l.mode, leg: li } }));
  src.setData({ type: "FeatureCollection", features: legFeatures.length ? legFeatures
    : [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { unsuitable: !itin.suitable, schematic, mode: "WALK", leg: 0 } }] });
  if (map.getLayer("journey-leg-hl")) map.setFilter("journey-leg-hl", ["==", ["get", "leg"], journeyLegHl]);
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
// Default selection, explained on the card: earliest arrival among the
// returned options that meet the requirements (else earliest overall).
function pickDefaultItin(list) {
  if (!list.length) return -1;
  const byArrival = (pool) => pool.reduce((best, i) =>
    (Date.parse(list[i].end) < Date.parse(list[best].end)
      || (list[i].end === list[best].end && Date.parse(list[i].start) < Date.parse(list[best].start))) ? i : best, pool[0]);
  const ok = list.map((it, i) => it.suitable ? i : -1).filter((i) => i >= 0);
  return byArrival(ok.length ? ok : list.map((_, i) => i));
}
// One shared journey state for the planner form, the chat and the map.
function applyJourney(payload, fit = true) {
  if (!payload) return;
  // A newly applied journey replaces the old one completely: an in-progress
  // preview of the previous journey stops and can never move its camera.
  if (preview) stopPreview();
  journeyResult = payload;
  if (payload.from) journey.from = payload.from;
  if (payload.to) journey.to = payload.to;
  if (typeof payload.wheelchair === "boolean") journey.stepFree = payload.wheelchair;
  // A newly applied journey replaces the previous request in full: when the
  // payload carries the keys, a null limit or time clears the old one
  // instead of silently keeping it.
  if ("maxWalkM" in payload) journey.maxWalk = payload.maxWalkM != null ? String(payload.maxWalkM) : "";
  if ("dateTime" in payload) {
    if (payload.dateTime) { journey.when = payload.arriveBy ? "arrive" : "depart"; journey.datetime = isoToHelsinkiLocal(payload.dateTime); }
    else { journey.when = "now"; journey.datetime = ""; }
  }
  selectedItinerary = pickDefaultItin(payload.itineraries || []);
  drawJourney(fit);
}
// [journey-preview] Pure geometry helpers for the journey preview.
// Progress runs by travelled distance along the returned points, never by
// point count, and bearings turn along the shortest arc.
function pvDistM(a, b) {
  const t = Math.PI / 180, dLa = (b[0] - a[0]) * t, dLo = (b[1] - a[1]) * t;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function pvBearingDeg(a, b) {
  const t = Math.PI / 180, y = Math.sin((b[1] - a[1]) * t) * Math.cos(b[0] * t);
  const x = Math.cos(a[0] * t) * Math.sin(b[0] * t) - Math.sin(a[0] * t) * Math.cos(b[0] * t) * Math.cos((b[1] - a[1]) * t);
  return (Math.atan2(y, x) / t + 360) % 360;
}
function pvSegLens(pts) {
  const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = pvDistM(pts[i - 1], pts[i]); seg.push(d); total += d; }
  return { seg, total };
}
function pvPointAt(pts, seg, dist) {
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (dist <= acc + seg[i] || i === seg.length - 1) {
      const f = seg[i] > 0 ? Math.min(1, Math.max(0, (dist - acc) / seg[i])) : 0;
      const a = pts[i], b = pts[i + 1];
      return { point: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bearing: pvBearingDeg(a, b) };
    }
    acc += seg[i];
  }
  const last = pts[pts.length - 1];
  return { point: last, bearing: pvBearingDeg(pts[pts.length - 2] || last, last) };
}
function pvAngleLerp(cur, target, f) {
  let d = ((target - cur + 540) % 360) - 180;
  return (cur + d * Math.min(1, Math.max(0, f)) + 360) % 360;
}
// Playback is a sped-up orientation aid, never the real travel time: long
// legs are compressed so a full preview stays short.
function pvStepDurationS(mode, distM) {
  const d = Number.isFinite(distM) && distM > 0 ? distM : 0;
  return mode === "WALK" ? Math.min(10, Math.max(3, d / 28)) : Math.min(12, Math.max(4, d / 280));
}
// Steps come from the returned legs. A leg without returned geometry is
// marked schematic: the preview never animates it as a precise path.
function pvStepsFor(it) {
  return (it.legs || []).map((leg, idx) => {
    const pts = (leg.points || []).filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
    const { seg, total } = pvSegLens(pts);
    return { leg, idx, pts, seg, total, schematic: leg.geometry !== "digitransit" || pts.length < 2 };
  });
}
const pvUsable = (s) => !s.schematic && s.pts.length >= 2 && s.total > 0;
// [/journey-preview]

let preview = null, pvGen = 0, pvImgMarker = null;
function pvStepName(s) {
  const l = s.leg;
  return l.mode === "WALK"
    ? `Walk/wheel ${l.distanceM == null ? "" : Math.round(l.distanceM) + " m · "}${l.from?.name || ""} → ${l.to?.name || ""}`
    : `${MODE_LABEL[l.mode] || l.mode}${l.line ? " " + l.line : ""} · ${l.from?.name || ""} → ${l.to?.name || ""}`;
}
function pvSetPlaying(on) {
  const pv = preview; if (!pv) return;
  pv.playing = on; pv.lastTs = null;
  $("#pv-play").textContent = on ? "⏸ Pause" : "▶ Play";
  $("#pv-play").setAttribute("aria-label", on ? "Pause the preview" : "Play the preview");
  if (on && !reduced) { cancelAnimationFrame(pv.raf); pv.raf = requestAnimationFrame(pvLoop); }
  if (on && reduced) { cancelAnimationFrame(pv.raf); pv.raf = requestAnimationFrame(pvStepTick); }
  if (!on) cancelAnimationFrame(pv.raf);
}
function pvCameraAt(pv, instant) {
  const s = pv.steps[pv.stepIdx]; if (!s || !pvUsable(s)) return;
  const { point, bearing } = pvPointAt(s.pts, s.seg, pv.dist);
  pv.bearing = pv.bearing == null || instant ? bearing : pvAngleLerp(pv.bearing, bearing, instant ? 1 : 0.12);
  const cam = { center: [point[1], point[0]], bearing: pv.bearing, pitch: 55, zoom: s.leg.mode === "WALK" ? 16.2 : 15.2 };
  if (instant || reduced) map.jumpTo(cam); else map.jumpTo(cam);
  journeyLegHl = s.idx;
  if (map.getLayer("journey-leg-hl")) map.setFilter("journey-leg-hl", ["==", ["get", "leg"], s.idx]);
  const done = pv.steps.slice(0, pv.stepIdx).reduce((a, x) => a + (pvUsable(x) ? x.total : 0), 0) + pv.dist;
  const all = pv.steps.reduce((a, x) => a + (pvUsable(x) ? x.total : 0), 0);
  const pct = all > 0 ? Math.round((done / all) * 100) : 0;
  $("#pv-fill").style.width = pct + "%";
  $("#pv-track").setAttribute("aria-valuenow", String(pct));
}
function pvLoop(ts) {
  const pv = preview; if (!pv || !pv.playing) return;
  if (pv.lastTs == null) pv.lastTs = ts;
  const dt = Math.min(0.25, (ts - pv.lastTs) / 1000); pv.lastTs = ts;
  const s = pv.steps[pv.stepIdx];
  pv.dist += dt * (s.total / pvStepDurationS(s.leg.mode, s.total));
  if (pv.dist >= s.total) { if (!pvAdvance(1, true)) { pvSetPlaying(false); $("#pv-note").textContent = "Preview finished. Exit preview returns to your conversation."; return; } }
  else pvCameraAt(pv, false);
  pv.raf = requestAnimationFrame(pvLoop);
}
function pvStepTick() {
  // Reduced motion: no continuous camera movement — one step at a time.
  const pv = preview; if (!pv || !pv.playing) return;
  pv.timer = setTimeout(() => {
    if (!preview || preview.gen !== pv.gen || !pv.playing) return;
    if (!pvAdvance(1, true)) { pvSetPlaying(false); $("#pv-note").textContent = "Preview finished. Exit preview returns to your conversation."; return; }
    pvStepTick();
  }, 1600);
}
function pvAdvance(dir, auto = false) {
  const pv = preview; if (!pv) return false;
  let i = pv.stepIdx + dir;
  const skipped = [];
  while (i >= 0 && i < pv.steps.length && !pvUsable(pv.steps[i])) { skipped.push(pv.steps[i]); i += dir; }
  if (i < 0 || i >= pv.steps.length) { if (!auto) pvCameraAt(pv, true); return false; }
  pv.stepIdx = i; pv.dist = dir < 0 ? 0 : 0; pv.bearing = null;
  pvEnterStep(skipped);
  pvCameraAt(pv, true);
  return true;
}
function pvEnterStep(skipped = []) {
  const pv = preview; if (!pv) return;
  const s = pv.steps[pv.stepIdx];
  $("#pv-step").textContent = `Step ${pv.stepIdx + 1} of ${pv.steps.length} · ${pvStepName(s)}`;
  const notes = [];
  if (s.leg.mode === "SUBWAY") notes.push("Underground section: the camera follows the route line on the map. This is not a street-level view.");
  if (skipped.length) notes.push(skipped.map((x) => `Step ${x.idx + 1} (${pvStepName(x)}) has no precise geometry and was skipped.`).join(" "));
  notes.push("Playback is sped up; it is not the real travel time.");
  $("#pv-note").textContent = notes.join(" ");
  $("#pv-detail").textContent = "";
  $("#pv-imagery").hidden = true;
  closeImagery();
  pvFetchImagery();
}
async function pvFetchImagery() {
  const pv = preview; if (!pv) return;
  const s = pv.steps[pv.stepIdx];
  pv.stepImages = null;
  if (s.leg.mode !== "WALK") return; // imagery is checked for surface steps
  const gen = pv.gen;
  try {
    // Send the step's own returned geometry: relevance is judged against
    // the route itself (distance to it and the local direction of travel).
    const stepPts = s.pts.length > 60 ? s.pts.filter((_, i) => i % Math.ceil(s.pts.length / 60) === 0 || i === s.pts.length - 1) : s.pts;
    const r = await api("/api/mobility/street-imagery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: stepPts }) });
    if (!preview || preview.gen !== gen || preview.stepIdx !== s.idx && preview.steps[preview.stepIdx] !== s) return;
    pv.stepImages = r;
    if (pv.detailLocked) return; // a rejection notice outranks imagery status
    if (r.status === "ok" && r.images?.length) {
      const best = r.images[0];
      const btn = $("#pv-imagery");
      btn.hidden = false;
      btn.textContent = best.relevance === "route" ? "Street-level view" : "Nearby imagery";
      $("#pv-detail").textContent = best.relevance === "route"
        ? "A street-level image was found facing along this step. Open it to inspect the street before you travel."
        : "Only nearby imagery was found for this step; it does not show the route itself.";
    } else {
      $("#pv-detail").textContent = "Street-level imagery unavailable here";
    }
  } catch {
    if (preview && preview.gen === gen) $("#pv-detail").textContent = "Street-level imagery unavailable here";
  }
}
function openImagery() {
  const pv = preview; const imgs = pv?.stepImages?.images;
  if (!imgs?.length) return;
  pv.wasPlaying = pv.playing; pvSetPlaying(false);
  pv.imgIdx = 0;
  showImagery();
  $("#imagery-view").hidden = false;
}
function showImagery() {
  const pv = preview; const imgs = pv?.stepImages?.images; if (!imgs?.length) return;
  const im = imgs[Math.min(pv.imgIdx || 0, imgs.length - 1)];
  $("#imagery-img").src = im.thumbUrl;
  const when = im.capturedAt ? new Date(im.capturedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "date unknown";
  $("#imagery-caption").textContent = `${im.relevance === "route" ? "Street-level view" : "Nearby imagery"} · Mapillary · captured ${when}${im.creator ? ` · © ${im.creator}` : ""} (CC BY-SA 4.0) · ${im.distanceM} m from this step · position ${im.lat.toFixed(5)}, ${im.lon.toFixed(5)}`;
  pvImgMarker?.remove();
  if (map && window.maplibregl) pvImgMarker = new maplibregl.Marker({ color: "#0f62b4" }).setLngLat([im.lon, im.lat]).addTo(map);
}
function closeImagery() {
  const iv = $("#imagery-view"); if (iv) iv.hidden = true;
  pvImgMarker?.remove(); pvImgMarker = null;
}
function startPreview(j, itinIdx) {
  if (!map) { toast("The map is still loading. Try the preview again in a moment."); return; }
  const it = j?.itineraries?.[itinIdx];
  if (!it) return;
  const steps = pvStepsFor(it);
  if (!steps.some(pvUsable)) {
    toast("Animated preview is unavailable for this option: no returned route geometry to follow. The stops are still shown on the map and in the step list.");
    return;
  }
  if (preview) stopPreview();
  const gen = ++pvGen;
  preview = { gen, j, itinIdx, it, steps, stepIdx: steps.findIndex(pvUsable), dist: 0, playing: false,
    bearing: null, lastTs: null, raf: 0, savedScroll: chatContent()?.scrollTop || 0,
    panelWasOpen: !$("#panel").hidden, stepImages: null, imgIdx: 0 };
  journeyResult = j; selectedItinerary = itinIdx;
  if (j.from) journey.from = j.from;
  if (j.to) journey.to = j.to;
  applyTrafficVis(); // simulated traffic is hidden for the whole preview
  $("#panel").hidden = true;
  $("#chat-bar").style.display = "none";
  drawJourney(true);
  if (map.getLayer("bldg-3d")) map.setLayoutProperty("bldg-3d", "visibility", "visible");
  if (map.getLayer("buildings-fill")) map.setLayoutProperty("buildings-fill", "visibility", "none");
  $("#preview-bar").hidden = false;
  pvEnterStep();
  pvCameraAt(preview, true);
  if (!it.suitable) { preview.detailLocked = true; $("#pv-detail").textContent = "This option does not meet your requirements. The preview shows the returned route only; it is not a recommendation."; }
  pvSetPlaying(true);
  $("#pv-play").focus();
}
function stopPreview() {
  if (!preview) return;
  pvGen++;
  cancelAnimationFrame(preview.raf);
  if (preview.timer) clearTimeout(preview.timer);
  preview = null;
  closeImagery();
  $("#preview-bar").hidden = true;
  applyBuildingVis();
  applyTrafficVis(); // restore simulated traffic (dimmed: a route is selected)
  map?.easeTo({ pitch: view3d ? 52 : 0, duration: reduced ? 0 : 500 });
}
function exitPreview() {
  const pv = preview; if (!pv) return;
  const scroll = pv.savedScroll, wasOpen = pv.panelWasOpen;
  stopPreview();
  if (wasOpen) {
    $("#panel").hidden = false;
    // Unhiding lets the browser and the follow logic settle on their own
    // position first; re-apply the saved reading position until it sticks,
    // then recompute follow mode from that final position.
    const restore = () => { const c = chatContent(); if (c) c.scrollTop = scroll; };
    restore();
    let tries = 0;
    const iv = setInterval(() => {
      restore();
      if (++tries >= 10) {
        clearInterval(iv);
        const c = chatContent();
        if (c && panelMode === "chat") chatFollow = isNearBottom(c);
      }
    }, 60);
  }
  setComposer();
}
function wirePreview() {
  $("#pv-play")?.addEventListener("click", () => {
    const pv = preview; if (!pv) return;
    const s = pv.steps[pv.stepIdx];
    const atEnd = pv.stepIdx === pv.steps.length - 1 || (!pvAdvanceNeeded(pv) && pv.dist >= (s?.total || 0));
    if (!pv.playing && atEnd) { pv.stepIdx = pv.steps.findIndex(pvUsable); pv.dist = 0; pv.bearing = null; pvEnterStep(); pvCameraAt(pv, true); }
    pvSetPlaying(!pv.playing);
  });
  $("#pv-restart")?.addEventListener("click", () => {
    const pv = preview; if (!pv) return;
    pv.stepIdx = pv.steps.findIndex(pvUsable); pv.dist = 0; pv.bearing = null;
    pvEnterStep(); pvCameraAt(pv, true); pvSetPlaying(true);
  });
  $("#pv-prev")?.addEventListener("click", () => { if (preview) { pvAdvance(-1); } });
  $("#pv-next")?.addEventListener("click", () => { if (preview) { pvAdvance(1); } });
  $("#pv-exit")?.addEventListener("click", exitPreview);
  $("#pv-imagery")?.addEventListener("click", openImagery);
  $("#imagery-back")?.addEventListener("click", () => { closeImagery(); $("#pv-play")?.focus(); });
  $("#imagery-prev")?.addEventListener("click", () => { const pv = preview; if (pv?.stepImages?.images?.length) { pv.imgIdx = ((pv.imgIdx || 0) - 1 + pv.stepImages.images.length) % pv.stepImages.images.length; showImagery(); } });
  $("#imagery-next")?.addEventListener("click", () => { const pv = preview; if (pv?.stepImages?.images?.length) { pv.imgIdx = ((pv.imgIdx || 0) + 1) % pv.stepImages.images.length; showImagery(); } });
  $("#pv-check")?.addEventListener("click", async () => {
    const pv = preview; if (!pv) return;
    const s = pv.steps[pv.stepIdx], l = s.leg;
    const btn = $("#pv-check"); btn.disabled = true;
    $("#pv-detail").textContent = "Checking this step…";
    try {
      const r = await api("/api/mobility/step-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        fromLabel: pv.j.from?.label || "", toLabel: pv.j.to?.label || "",
        leg: { mode: l.mode, line: l.line || null, fromName: l.from?.name || "", toName: l.to?.name || "",
          distanceM: l.distanceM, accessibility: l.accessibility || "unknown",
          fromStopLabel: l.fromStop?.label || null, toStopLabel: l.toStop?.label || null,
          tripWheelchairAccessible: l.tripWheelchairAccessible || null,
          alerts: (l.alerts || []).map((a) => a.header).filter(Boolean) },
        imagery: pv.stepImages ? { status: pv.stepImages.status, relevance: pv.stepImages.images?.[0]?.relevance || null, capturedAt: pv.stepImages.images?.[0]?.capturedAt || null } : { status: "none" } }) });
      if (!preview || preview.gen !== pv.gen) return;
      $("#pv-detail").textContent = r.text || "No step check was produced.";
    } catch { if (preview && preview.gen === pv.gen) $("#pv-detail").textContent = "The step check could not be produced. The step details in the journey card still apply."; }
    btn.disabled = false;
  });
}
function pvAdvanceNeeded(pv) { return pv.steps.slice(pv.stepIdx + 1).some(pvUsable); }

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
  const input = $(inputId); let timer, seq = 0;
  input.addEventListener("input", () => {
    // Editing always invalidates the previous selection's coordinates, and
    // only an explicit suggestion click may set new ones. Late responses for
    // older text are ignored, so they cannot overwrite a newer selection.
    journey[key] = null;
    seq++;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim(); if (q.length < 3) { $(boxId).innerHTML = ""; return; }
      const mine = ++seq;
      try {
        const r = await api("/api/mobility/geocode?q=" + encodeURIComponent(q));
        if (mine !== seq || input.value.trim() !== q) return;
        $(boxId).innerHTML = (r.ambiguous ? '<p class="small">Several stations match. Please choose the exact one.</p>' : "")
          + (r.places || []).map((p, i) => `<button type="button" class="suggest-item" data-pick="${key}:${i}">${p.kind === "station" ? '<span class="pill type">Station</span> ' : ""}${esc(p.label)} <span class="small">· ${esc(p.source)}</span></button>`).join("");
        $(boxId).querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
          const p = r.places[+b.dataset.pick.split(":")[1]];
          journey[key] = { lat: p.lat, lon: p.lon, label: p.label, kind: p.kind }; input.value = p.label; $(boxId).innerHTML = "";
        }));
      } catch { if (mine === seq) $(boxId).innerHTML = '<p class="small">Location search unavailable.</p>'; }
    }, 350);
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
    if (journey.when !== "now" && !helsinkiToIso(journey.datetime || "")) {
      $("#journey-status").textContent = journey.when === "arrive"
        ? "Please choose the date and time you want to arrive by, or switch to Leave now."
        : "Please choose the date and time you want to depart at, or switch to Leave now.";
      $("#journey-dt")?.focus();
      return;
    }
    $("#journey-status").textContent = "Checking transport options…";
    $("#map-status").textContent = "Checking transport options";
    try {
      const payload = { from: journey.from, to: journey.to,
        requirements: { stepFree: journey.stepFree, maxWalkM: journey.maxWalk === "" ? null : +journey.maxWalk, fewerTransfers: journey.fewerTransfers },
        arriveBy: journey.when === "arrive",
        dateTime: journey.when === "now" || !journey.datetime ? null : helsinkiToIso(journey.datetime),
        ownBarrierSubmissionId: ownBarrierId || undefined };
      const r = await fetch("/api/mobility/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const plan = await r.json();
      applyJourney({ ...plan, from: journey.from, to: journey.to, wheelchair: journey.stepFree, maxWalkM: payload.requirements.maxWalkM, dateTime: payload.dateTime, arriveBy: payload.arriveBy });
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
    ${statusZoneHtml(it, r)}
    <p><span class="pill">Entrance unverified</span></p>
    <ol class="steps">${it.legs.map(legText).join("")}</ol>
    ${it.ownBarrier?.near ? `<p class="small"><strong>Your unverified report</strong> is ${it.ownBarrier.distanceM} m from this option. It is not public evidence and does not change its status.</p>` : ""}
    ${(it.nearbyWorks || []).length ? `<p class="small"><strong>Possible context (not proven barriers)</strong> — Helsinki works snapshot ${esc(SNAP.snapshotId)}:</p><ul>${it.nearbyWorks.map((w) => `<li>${esc(w.kind)} — ${w.distanceM} m away · ${esc(w.source)}</li>`).join("")}</ul>` : ""}
    ${(it.nearbyReports || []).length ? `<p class="small"><strong>Community-reported (approved)</strong>:</p><ul>${it.nearbyReports.map((x) => `<li>${esc(x.title)} — ${x.distanceM} m · ${esc(x.sourceDate)}</li>`).join("")}</ul>` : ""}
    <p class="small">${esc(it.entrance)}</p>
    <button class="btn small" data-select-itin="${i}">Show this option on the map</button>
    <button class="btn small" data-preview-itin="${i}">${it.suitable ? "Preview journey" : "Preview returned route"}</button>
    <button class="btn small" data-report-itin="${i}">Report a possible barrier</button>
    ${ownBarrierId ? `<button class="btn small" data-reassess="1">Reassess with my report</button>` : ""}
  </div>`).join("") || "<p>No itineraries were returned.</p>"}
  <button class="btn" id="back-plan">Change requirements</button>
  <button class="btn" id="ask-journey">Ask AI about these options</button>`);
  document.querySelectorAll("[data-select-itin]").forEach((b) => b.addEventListener("click", () => { selectedItinerary = +b.dataset.selectItin; renderJourneyResults(); drawJourney(); }));
  document.querySelectorAll("[data-preview-itin]").forEach((b) => b.addEventListener("click", () => startPreview(journeyResult, +b.dataset.previewItin)));
  document.querySelectorAll("[data-report-itin]").forEach((b) => b.addEventListener("click", () => openBarrierForm(+b.dataset.reportItin)));
  document.querySelectorAll("[data-reassess]").forEach((b) => b.addEventListener("click", () => { openPlanner(); toast("Reassessing with your unverified report…"); document.querySelector("#journey-form")?.requestSubmit(); }));
  $("#back-plan").addEventListener("click", openPlanner);
  $("#ask-journey")?.addEventListener("click", () => { openChat(); sendChat(`Compare my journey options from ${journey.from?.label} to ${journey.to?.label}. Step-free required: ${journey.stepFree}. What is known, what is unknown, and what should I check?`); });
}
function openBarrierForm(itinIdx) {
  // The same draft contract as in chat: editable text, no location until the
  // user chooses and confirms a point, an explicit demo flag, duplicate
  // protection, and the final state taken from the server response. A point
  // on the selected route is offered only as a candidate, never assigned.
  const it = journeyResult?.itineraries?.[itinIdx];
  const mid = it?.geometry?.length ? it.geometry[Math.floor(it.geometry.length / 2)] : null;
  const d = { title: "", body: "", category: "blocked-pavement", demo: false, lat: null, lon: null,
    locationConfirmed: false, candidate: mid ? { lat: mid[0], lon: mid[1], label: "Point on the selected route (suggestion)" } : null,
    submitting: false, submitted: null, uploadId: null };
  const render = () => {
    openPanel("details", `<h2>Report a possible barrier</h2>
  <p class="small">Your report stays <strong>private</strong> until a reviewer approves it. It will not silently change public recommendations.</p>
  <form id="barrier-form">
    <label class="field">What did you encounter?
      <textarea name="description" required maxlength="2000" placeholder="Where exactly, and what blocks step-free passage?">${esc(d.body)}</textarea></label>
    <label class="field">Photo (optional, max 5 MB) <input type="file" id="barrier-file" accept="image/png,image/jpeg,image/webp,application/pdf"></label>
    <label class="check"><input type="checkbox" id="barrier-demo" ${d.demo ? "checked" : ""}> This is a demonstration (demo data, never real evidence)</label>
    <button class="btn" type="submit">Prepare draft from my description</button>
    <p class="small" id="barrier-status" aria-live="polite"></p>
  </form>
  <div id="barrier-draft">${d.title || d.body ? draftHtml(d) : ""}</div>
  <button class="btn" id="back-results">Back to options</button>`);
    $("#back-results").addEventListener("click", renderJourneyResults);
    $("#barrier-demo")?.addEventListener("change", (e) => {
      d.body = $("#barrier-form textarea")?.value ?? d.body;
      d.demo = e.target.checked; render();
    });
    wireDraftControls(d, render, async () => {
      const s2 = await api("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "report", category: d.category, title: d.title.trim(), body: d.body.trim(),
          lat: d.lat, lon: d.lon, uploadId: d.uploadId, demo: !!d.demo }) });
      ownBarrierId = s2.id;
      return s2;
    });
    $("#barrier-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      d.body = String(fd.get("description") || "");
      $("#barrier-status").textContent = "Preparing a draft…";
      try {
        const file = $("#barrier-file").files[0];
        if (file && !d.uploadId) {
          const up = new FormData(); up.append("file", file);
          const ur = await fetch("/api/uploads", { method: "POST", body: up });
          const uj = await ur.json().catch(() => ({}));
          if (!ur.ok) throw new Error("upload");
          d.uploadId = uj.id;
        }
        const r = await api("/api/mobility/analyse-barrier", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: d.body, uploadId: d.uploadId }) });
        d.title = r.draft.title; d.body = r.draft.body; d.category = r.draft.category || d.category; d.prepared = true;
        render();
      } catch { $("#barrier-status").textContent = "The draft could not be prepared. Check your description and try again."; }
    });
  };
  render();
}
// ---------- AI chat ----------
// [autoscroll-helpers] Pure follow-scroll decisions (covered by tests).
function isNearBottom(el, threshold = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
function shouldAutoScroll(following, el) { return following || isNearBottom(el); }
// [/autoscroll-helpers]
let chatFollow = true, chatHasNew = false, chatRO = null, chatMO = null;
const chatContent = () => $("#panel-content");
function scrollChatToBottom() {
  chatHasNew = false;
  const c = chatContent(); if (!c) return;
  c.scrollTo({ top: c.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  const b = $("#new-response"); if (b) b.hidden = true;
}
function onChatContentGrew() {
  if (panelMode !== "chat" || $("#panel")?.hidden) return;
  if (shouldAutoScroll(chatFollow, chatContent())) { chatFollow = true; scrollChatToBottom(); }
  else if (chatHasNew) { const b = $("#new-response"); if (b) b.hidden = false; }
}
function attachChatObservers() {
  chatRO?.disconnect(); chatMO?.disconnect();
  const log = $("#chat-log"), live = $("#chat-live");
  if (window.ResizeObserver) { chatRO = new ResizeObserver(onChatContentGrew); if (log) chatRO.observe(log); if (live) chatRO.observe(live); }
  if (window.MutationObserver) { chatMO = new MutationObserver(onChatContentGrew); const c = chatContent(); if (c) chatMO.observe(c, { childList: true, subtree: true, characterData: true }); }
}
function openChat() {
  openPanel("chat", `<h2>Journey assistant</h2>
    <p class="small">Routes come from live Digitransit/HSL queries. Roadworks context is a dated snapshot. Unknown means unverified.</p>
    <div id="chat-log">${chatLog.map(chatMsgHtml).join("") || '<p class="small"><strong>New session.</strong> Previous conversations are not kept after a reload. Try: “Step-free journey from Central Station to Oodi, please.”</p>'}</div>
    <div id="chat-live" aria-live="polite"></div>`);
  attachChatObservers();
  if (chatFollow) scrollChatToBottom();
}
const shortPlace = (label) => String(label || "").split(",")[0].replace(/^Helsinki /, "") || "Place";
// Discreet status zone inside the white card. Symbol + text, never colour
// alone; a rejected route is named as such and drawn grey on the map.
function statusZoneHtml(it, j) {
  const st = accessStatus(it);
  if (j?.maxWalkM != null && (it.walkDistanceM || 0) > j.maxWalkM)
    return `<span class="status-zone bad"><span class="sz-title">⚠ Exceeds your distance limit</span>
      <span>Your limit: ${j.maxWalkM} m · This route: ${it.walkDistanceM} m<br>${it.walkDistanceM - j.maxWalkM} m above your limit.</span></span>`;
  if (st.startsWith("Does not meet"))
    return `<span class="status-zone bad"><span class="sz-title">⚠ ${esc(st)}</span><span>This option is not suitable for your requirements.</span></span>`;
  if (st.startsWith("Step-free recorded"))
    return `<span class="status-zone ok"><span class="sz-title">✓ ${esc(st)}</span></span>`;
  return `<span class="status-zone unknown"><span class="sz-title">ℹ Step-free access unverified</span>
    <span>Wheelchair routing was requested. Step-free access along the route and at the entrance is not confirmed.</span></span>`;
}
const fmtTime = (iso) => iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—";
const transitLegs = (it) => (it.legs || []).filter((l) => l.mode !== "WALK");
function walkSplit(it) {
  const legs = it.legs || [];
  const tIdx = legs.map((l, i) => l.mode !== "WALK" ? i : -1).filter((i) => i >= 0);
  if (!tIdx.length) return null;
  const sum = (arr) => arr.reduce((a, l) => a + (l.distanceM || 0), 0);
  return { before: sum(legs.slice(0, tIdx[0])), after: sum(legs.slice(tIdx[tIdx.length - 1] + 1)) };
}
function stepsHtml(it) {
  return `<ol class="steps compact">${(it.legs || []).map((l, li) => {
    if (l.mode === "WALK") return `<li data-leg="${li}" tabindex="0">Walk/wheel ${l.distanceM == null ? "distance unknown" : Math.round(l.distanceM) + " m"} to ${esc(l.to?.name || "destination")} <span class="small">(unverified)</span></li>`;
    const plat = l.fromStop?.platformCode ? ` · Platform ${esc(l.fromStop.platformCode)}` : "";
    return `<li data-leg="${li}" tabindex="0">${esc(MODE_LABEL[l.mode] || l.mode)}${l.line ? " " + esc(l.line) : ""}: ${esc(l.from?.name || "")} ${fmtTime(l.start)} → ${esc(l.to?.name || "")} ${fmtTime(l.end)}${plat}</li>`;
  }).join("")}</ol>`;
}
function accessSplitHtml(it) {
  const ts = transitLegs(it);
  if (!ts.length) return "";
  const wb = (v) => v === "POSSIBLE" ? "possible in source" : v === "NOT_POSSIBLE" ? "NOT possible in source" : "unknown in source";
  const reported = ts.map((l) => `${esc(l.from?.name || "Station")}: boarding ${wb(l.fromStop?.wheelchairBoarding)} · ${esc(l.to?.name || "Station")}: boarding ${wb(l.toStop?.wheelchairBoarding)} · ${esc(MODE_LABEL[l.mode] || l.mode)}${l.line ? " " + esc(l.line) : ""}: ${wb(l.tripWheelchairAccessible)}`).join("<br>");
  return `<p class="small access-split"><strong>Reported for stations and vehicle:</strong> ${reported}<br><strong>Unverified:</strong> walking/wheeling segments and the destination entrance.</p>`;
}
function otherRowLabel(it) {
  const t = transitLegs(it)[0];
  const svc = t ? `${MODE_LABEL[t.mode] || t.mode}${t.line ? " " + t.line : ""} · ` : "";
  return `${svc}${fmtTime(it.start)} → ${fmtTime(it.end)} · walking/wheeling ${it.walkDistanceM} m · ~${fmtDur(it.durationS)}`;
}
const TECH_JOURNEY = { digitransit_invalid_credentials: "Journey search is unavailable right now. Please retry.", digitransit_rate_limited: "The transport service is busy right now. Please retry shortly.", digitransit_unavailable: "The transport service could not be reached. Please retry.", not_configured: "Live routing is not configured on this server.", digitransit_invalid_response: "The transport service returned incomplete data. Please retry." };
function journeyCardHtml(m) {
  const j = m.journey; if (!j) return "";
  if (TECH_JOURNEY[j.status]) return `<div class="journey-card"><strong>Couldn’t retrieve routes</strong>
    <p class="small">${esc(TECH_JOURNEY[j.status])} No route is shown for this request.</p>
    <button class="btn small" data-retry="1">Retry</button></div>`;
  const list = j.itineraries || [];
  if (!list.length)
    return `<div class="journey-card"><strong>No returned option meets your requirements.</strong><br><span class="small">Any previous route no longer applies to these requirements. Nothing was relaxed.</span></div>`;
  const sel = Math.min(m.selectedItin ?? 0, list.length - 1);
  const it = list[sel];
  const split = walkSplit(it);
  const t0 = transitLegs(it)[0];
  const note = m.userPicked ? "You selected this departure."
    : list.some((x) => x.suitable)
      ? `Selected: earliest arrival among the ${list.length} returned option(s)${j.maxWalkM != null ? ` within your ${j.maxWalkM} m walking/wheeling limit` : ""}.`
      : "No returned option meets your requirements; showing the earliest arrival.";
  const others = list.map((x, i) => i === sel ? "" :
    `<button type="button" class="other-row" data-jcard="${i}" data-msg="${esc(m.id || "")}">${esc(otherRowLabel(x))}<span class="small">${x.suitable ? "" : " · Does not meet your requirements"}</span></button>`).join("");
  return `<div class="journey-card selected" data-journey-msg="${esc(m.id || "")}">
    <span class="t">${esc(shortPlace(j.from?.label))} → ${esc(shortPlace(j.to?.label))}</span>
    ${t0 ? `<span class="s service">${esc(MODE_LABEL[t0.mode] || t0.mode)}${t0.line ? " " + esc(t0.line) : ""} · ${esc(t0.from?.name || "")} ${fmtTime(t0.start)} → ${esc(t0.to?.name || "")} ${fmtTime(t0.end)}</span>` : ""}
    <span class="s">Depart ${fmtTime(it.start)} · Arrive ${fmtTime(it.end)} (Europe/Helsinki) · ~${esc(fmtDur(it.durationS))}</span>
    ${j.dateTime ? `<span class="s">Requested: ${j.arriveBy ? "arrive by" : "depart at"} ${esc(fmtHelsinki(j.dateTime))} (Europe/Helsinki)</span>` : ""}
    <span class="s">${split ? `Walking/wheeling ${split.before} m before · ${split.after} m after · ${it.walkDistanceM} m total` : `Walking/wheeling ${it.walkDistanceM} m`} · ${it.transfers ? `${it.transfers} transfer(s)` : "No transfers"}</span>
    ${it.geometrySource === "schematic_endpoint_links" ? '<span class="s">Schematic line: segment geometry was not returned, so the map links the returned stops directly. It is not a verified path.</span>' : ""}
    ${statusZoneHtml(it, j)}
    ${stepsHtml(it)}
    ${accessSplitHtml(it)}
    <span class="s">${esc(note)}</span>
    <button type="button" class="s action linklike" data-jcard="${sel}" data-msg="${esc(m.id || "")}">Show on the map</button>
    <button type="button" class="s action linklike" data-preview="${sel}" data-msg="${esc(m.id || "")}">${it.suitable ? "Preview journey" : "Preview returned route"}</button>
    ${list.length > 1 ? `<div class="other-deps"><button type="button" class="other-toggle" data-other-toggle aria-expanded="false">Other departures (${list.length - 1})</button><div class="other-list" hidden>${others}</div></div>` : ""}
  </div>`;
}
function detailsHtml(m) {
  const j = m.journey, prov = m.provenance || [];
  if (!j && !prov.length) return "";
  const sel = j?.itineraries?.[Math.min(m.selectedItin ?? 0, (j.itineraries?.length || 1) - 1)];
  const selIt = j?.itineraries?.[Math.min(m.selectedItin ?? 0, (j.itineraries?.length || 1) - 1)];
  return `<details class="sources"><summary>Sources and details</summary>
    ${j ? `<p class="small"><strong>What we know:</strong> ${selIt ? `${esc(j.from?.label || "Origin")} → ${esc(j.to?.label || "Destination")}, ${selIt.legs?.length || 0} returned step(s), from the live routing response.` : "No itinerary was returned."}<br>
    <strong>What is unverified:</strong> walking/wheeling segments and the destination entrance, unless a leg above says recorded in source.<br>
    <strong>Source and date:</strong> Digitransit / HSL live query${j.retrievedAt ? `, retrieved ${esc(String(j.retrievedAt).slice(0, 16).replace("T", " "))} UTC` : ""}; works context is the Helsinki snapshot ${esc(SNAP.snapshotId)} (dated).</p>` : ""}
    <dl>
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
  if (m.errorCard) return `<div class="msg ai"><div class="journey-card"><strong>${m.errorKind === "too_many_steps" || !m.transportInvolved ? "Couldn’t complete that request" : "Couldn’t retrieve routes"}</strong>
    <p class="small">${esc(m.text)}</p><button class="btn small" data-retry="1">Retry</button></div></div>`;
  return `<div class="msg ai">${journeyCardHtml(m)}<div class="msg-text">${mdHtml(m.text)}</div>${m.cards?.length ? m.cards.map(cardHtml).join("") : ""}${m.draft ? draftHtml(m.draft) : ""}${detailsHtml(m)}${m.retry ? `<button class="btn small" data-retry="1">Retry</button>` : ""}</div>`;
}
function cardHtml(c) {
  return `<button class="result-card" data-card="${esc(c.id)}" data-kind="${esc(c.cardType || "")}"><span class="t">${esc(c.title || c.id)}</span><br>
  <span class="small">${esc(c.kind || c.category || "")}${c.distanceM != null ? ` · ${c.distanceM} m` : ""}${c.starts ? ` · ${esc(c.starts)} – ${esc(c.ends || "")}` : ""}</span></button>`;
}
let pickState = null, pickMarker = null;
function wireDraftControls(d, render, onSubmit, root = document) {
  const sync = () => { const b = root.querySelector("[data-confirm-draft]"); if (b) b.disabled = !draftValid(d) || !!d.submitting; };
  root.querySelectorAll("[data-draft-title]").forEach((el) => el.addEventListener("input", () => { d.title = el.value; sync(); }));
  root.querySelectorAll("[data-draft-body]").forEach((el) => el.addEventListener("input", () => { d.body = el.value; sync(); }));
  root.querySelectorAll("[data-choose-location]").forEach((b) => b.addEventListener("click", () => {
    pickState = { draft: d, render };
    toast("Click on the map where the barrier is. You will be asked to confirm the point.");
  }));
  root.querySelectorAll("[data-addr-search]").forEach((b) => b.addEventListener("click", async () => {
    const box = root.querySelector("[data-addr-results]");
    const q = root.querySelector("[data-addr-input]")?.value.trim();
    if (!q || q.length < 3) { if (box) box.innerHTML = '<p class="field-err">Type at least 3 characters to search.</p>'; return; }
    try {
      const r = await api("/api/mobility/geocode?q=" + encodeURIComponent(q));
      const places = (r.places || []).slice(0, 5);
      if (box) box.innerHTML = places.length ? places.map((pl, i) => `<button type="button" class="suggest-item" data-addr-pick="${i}">${esc(pl.label)}</button>`).join("") : '<p class="small">No places found.</p>';
      box?.querySelectorAll("[data-addr-pick]").forEach((pb) => pb.addEventListener("click", () => {
        const pl = places[+pb.dataset.addrPick];
        d.candidate = { lat: pl.lat, lon: pl.lon, label: pl.label };
        showPickMarker(pl.lat, pl.lon); render();
      }));
    } catch { if (box) box.innerHTML = '<p class="field-err">Address search is unavailable. Choose the point on the map instead.</p>'; }
  }));
  root.querySelectorAll("[data-confirm-point]").forEach((b) => b.addEventListener("click", () => {
    if (!d.candidate) return;
    d.lat = d.candidate.lat; d.lon = d.candidate.lon; d.locationLabel = d.candidate.label;
    d.locationConfirmed = true; d.candidate = null; pickState = null; render();
  }));
  root.querySelectorAll("[data-cancel-point]").forEach((b) => b.addEventListener("click", () => {
    d.candidate = null; pickState = null; pickMarker?.remove(); pickMarker = null; render();
  }));
  root.querySelectorAll("[data-discard-draft]").forEach((b) => b.addEventListener("click", () => {
    pickState = null; pickMarker?.remove(); pickMarker = null;
    const host = root.querySelector(".draft"); if (host) host.innerHTML = "<p class=\"small\">Draft discarded.</p>";
  }));
  root.querySelectorAll("[data-confirm-draft]").forEach((b) => b.addEventListener("click", async () => {
    if (d.submitted || d.submitting || !draftValid(d)) return;
    d.submitting = true; sync();
    try {
      const saved = await onSubmit();
      d.submitting = false;
      d.submitted = { id: saved.id, reviewStatus: saved.reviewStatus || "pending" };
      render();
      toast("Report submitted privately for review.");
    } catch { d.submitting = false; sync(); toast("It could not be submitted. Check the draft and try again."); }
  }));
}
function showPickMarker(lat, lon) {
  if (!map || !window.maplibregl) return;
  pickMarker?.remove();
  const el = document.createElement("div");
  el.className = "journey-marker dest"; el.textContent = "!";
  el.setAttribute("aria-label", "Selected barrier point");
  pickMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
}
const draftHasLocation = (d) => !!d.workId || (Number.isFinite(d.lat) && Number.isFinite(d.lon) && d.locationConfirmed);
const draftValid = (d) => !!(String(d.title || "").trim() && String(d.body || "").trim() && draftHasLocation(d));
function draftHtml(d) {
  if (d.submitted) return `<div class="draft"><strong>${d.demo ? "Demo report" : "Report"} submitted</strong>
    <p>Status from the server: <strong>${esc(d.submitted.reviewStatus)}</strong> — private, waiting for review. It is not public${d.demo ? " and will not be used as real evidence" : ""}.</p>
    <p class="small">Reference: ${esc(String(d.submitted.id).slice(0, 8))}…</p></div>`;
  const loc = d.workId
    ? `<p class="small">For: ${esc(d.workTitle || "the selected project")} · Category: ${esc(d.category)}</p>`
    : d.candidate
      ? `<div class="loc-box"><p><strong>Selected point:</strong> ${esc(d.candidate.label)}<br><span class="small">${d.candidate.lat.toFixed(5)}, ${d.candidate.lon.toFixed(5)} — please check it, then confirm.</span></p>
         <button class="btn small primary" data-confirm-point="1">Confirm this point</button>
         <button class="btn small" data-cancel-point="1">Cancel</button></div>`
      : draftHasLocation(d)
        ? `<div class="loc-box"><p><strong>Location:</strong> ${esc(d.locationLabel || "Point confirmed on the map")} ✓ confirmed</p>
           <button class="btn small" data-choose-location="1">Change location</button></div>`
        : `<div class="loc-box"><p><strong>Location needed.</strong> We will not guess or use the station's coordinates. Choose the point where the barrier is.</p>
           <button class="btn small primary" data-choose-location="1">Choose location on map</button>
           <label class="field">Or search for an address
             <span class="addr-row"><input type="text" data-addr-input placeholder="Street or place…" autocomplete="off"><button class="btn small" data-addr-search="1">Search</button></span></label>
           <div data-addr-results></div>
           <p class="field-err" data-loc-err hidden>Choose a point on the map or from the address results, then confirm it.</p></div>`;
  return `<div class="draft"><strong>Report draft — not saved yet</strong>
  ${d.demo ? '<span class="pill demo">Demo scenario — not real evidence</span>' : ""}
  <label class="field">Title <input type="text" data-draft-title maxlength="200" value="${esc(d.title || "")}"></label>
  <p class="field-err" data-title-err hidden>Add a short title.</p>
  <label class="field">What did you encounter? <textarea data-draft-body maxlength="2000">${esc(d.body || "")}</textarea></label>
  <p class="field-err" data-body-err hidden>Describe what you encountered.</p>
  ${loc}
  <button class="btn primary" data-confirm-draft="1" ${draftValid(d) ? "" : "disabled"}>Confirm and submit for review</button>
  <button class="btn" data-discard-draft="1">Discard draft</button></div>`;
}
let msgSeq = 0, sendSeq = 0;
async function sendChat(text) {
  const msg = (text || "").trim(); if (!msg) return;
  const reqId = ++sendSeq;
  chatLog.push({ role: "user", text: msg });
  chatFollow = true;
  openChat();
  scrollChatToBottom();
  const live = $("#chat-live");
  live.innerHTML = `<div class="progress">Sending to the Journey assistant…</div>`;
  let draft = null, cards = [], finalText = "", failed = false, evJourney = null, provenance = [], errorKind = null;
  const stepsSeen = [];
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg,
        context: journeyResult ? { from: journeyResult.from || journey.from, to: journeyResult.to || journey.to,
          dateTime: journeyResult.dateTime || (journey.when !== "now" && journey.datetime ? helsinkiToIso(journey.datetime) : null),
          arriveBy: journeyResult.arriveBy ?? (journey.when === "arrive"),
          wheelchair: journey.stepFree, maxWalkM: journey.maxWalk === "" ? null : +journey.maxWalk } : null,
        history: chatLog.slice(0, -1).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })) }) });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "progress") {
          chatHasNew = true;
          // One live status line only, updated in place; nothing about
          // progress is kept in the finished history.
          if (!stepsSeen.includes(ev.step)) stepsSeen.push(ev.step);
          live.innerHTML = `<div class="progress">${esc(ev.step)}…</div>`;
        }
        else if (ev.type === "status") { finalText = ev.text; }
        else if (ev.type === "final") { finalText = ev.text; cards = ev.cards || []; draft = ev.draft; evJourney = ev.journey || null; provenance = ev.provenance || []; }
        else if (ev.type === "error") { failed = true; errorKind = ev.error || null; finalText = ev.text || "The request failed."; }
      }
    }
  } catch { failed = true; finalText = "The request could not be sent."; }
  if (evJourney && reqId === sendSeq) applyJourney(evJourney);
  // Coordinates suggested by the model are a candidate only: the user must
  // confirm the point before anything can be submitted with it.
  if (draft && !draft.workId && Number.isFinite(draft.lat) && Number.isFinite(draft.lon) && !draft.locationConfirmed) {
    draft.candidate = { lat: draft.lat, lon: draft.lon, label: "Point suggested from your description" };
    draft.lat = null; draft.lon = null;
  }
  const entry = { id: "m" + (++msgSeq), role: "ai", text: finalText || "No answer was returned.", cards, draft,
    journey: evJourney, provenance, selectedItin: evJourney && reqId === sendSeq && selectedItinerary >= 0 ? selectedItinerary : 0,
    errorCard: failed, transportInvolved: stepsSeen.includes("Checking transport options") || !!evJourney || !!journeyResult, errorKind, retry: failed ? msg : null };
  chatLog.push(entry);
  lastCards = cards;
  chatHasNew = true;
  const wasFollow = chatFollow, prevTop = chatContent()?.scrollTop || 0;
  openChat();
  if (wasFollow) scrollChatToBottom();
  else { const c = chatContent(); if (c) c.scrollTop = prevTop; const b = $("#new-response"); if (b && chatHasNew) b.hidden = false; }
  if (cards.length) highlightCards(cards);
  wireChatCards();
}
function highlightCards(cards) {
  for (const c of cards) { const el = markers.get(c.id); if (el) el.classList.add("selected"); }
  const first = cards.find((c) => c.lat != null);
  if (first && map) map.flyTo({ center: [first.lon, first.lat], zoom: 16, duration: reduced ? 0 : 1000 });
}
function wireChatCards() {
  document.querySelectorAll("[data-other-toggle]").forEach((b) => b.addEventListener("click", () => {
    const list = b.parentElement?.querySelector(".other-list");
    if (list) { list.hidden = !list.hidden; b.setAttribute("aria-expanded", String(!list.hidden)); }
  }));
  document.querySelectorAll("[data-leg]").forEach((el) => el.addEventListener("click", () => {
    journeyLegHl = +el.dataset.leg;
    document.querySelectorAll("[data-leg]").forEach((x) => x.classList.toggle("leg-on", x === el));
    if (map?.getLayer("journey-leg-hl")) map.setFilter("journey-leg-hl", ["==", ["get", "leg"], journeyLegHl]);
  }));
  document.querySelectorAll("[data-jcard]").forEach((b) => b.addEventListener("click", () => {
    // Each card controls its own message, journey and itinerary.
    const m = chatLog.find((x) => x.id === b.dataset.msg) || chatLog.findLast((x) => x.journey);
    if (!m?.journey) return;
    const idx = +b.dataset.jcard;
    journeyResult = m.journey;
    if (m.journey.from) journey.from = m.journey.from;
    if (m.journey.to) journey.to = m.journey.to;
    selectedItinerary = idx;
    m.selectedItin = idx; m.userPicked = true;
    drawJourney(true);
    const prevTop = chatContent()?.scrollTop || 0, wasFollow = chatFollow;
    openChat(); wireChatCards();
    if (!wasFollow && chatContent()) chatContent().scrollTop = prevTop;
  }));
  document.querySelectorAll("[data-preview]").forEach((b) => b.addEventListener("click", () => {
    // Each card previews its own message, journey and selected option —
    // including cards in older messages.
    const m = chatLog.find((x) => x.id === b.dataset.msg) || chatLog.findLast((x) => x.journey);
    if (!m?.journey) return;
    startPreview(m.journey, +b.dataset.preview);
  }));
  document.querySelectorAll("[data-retry]").forEach((b) => b.addEventListener("click", () => {
    const m = chatLog.findLast((x) => x.retry); if (m?.retry) sendChat(m.retry);
  }));
  document.querySelectorAll("[data-card]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.kind === "place") selectService(b.dataset.card); else selectWork(b.dataset.card);
  }));
  // --- barrier / report draft: editable, location required, no duplicates ---
  const draftMsg = () => chatLog.findLast((x) => x.draft && !x.draft.submitted) || chatLog.findLast((x) => x.draft);
  const draftEl = (b) => b.closest(".draft");
  const syncDraftValidity = (b) => {
    const m = draftMsg(); if (!m?.draft) return;
    const root = draftEl(b) || document.querySelector(".draft");
    const btn = root?.querySelector("[data-confirm-draft]");
    if (btn) btn.disabled = !draftValid(m.draft) || !!m.draft.submitting;
  };
  document.querySelectorAll("[data-draft-title]").forEach((el) => el.addEventListener("input", () => {
    const m = draftMsg(); if (m?.draft) { m.draft.title = el.value; const e = draftEl(el)?.querySelector("[data-title-err]"); if (e) e.hidden = !!el.value.trim(); syncDraftValidity(el); }
  }));
  document.querySelectorAll("[data-draft-body]").forEach((el) => el.addEventListener("input", () => {
    const m = draftMsg(); if (m?.draft) { m.draft.body = el.value; const e = draftEl(el)?.querySelector("[data-body-err]"); if (e) e.hidden = !!el.value.trim(); syncDraftValidity(el); }
  }));
  document.querySelectorAll("[data-choose-location]").forEach((b) => b.addEventListener("click", () => {
    const m = draftMsg(); if (!m?.draft) return;
    m.draft.candidate = null;
    pickState = { draft: m.draft, render: () => { openChat(); wireChatCards(); } };
    toast("Click on the map where the barrier is. You will be asked to confirm the point.");
  }));
  document.querySelectorAll("[data-addr-search]").forEach((b) => b.addEventListener("click", async () => {
    const m = draftMsg(); if (!m?.draft) return;
    const root = draftEl(b);
    const q = root?.querySelector("[data-addr-input]")?.value.trim();
    const box = root?.querySelector("[data-addr-results]");
    if (!q || q.length < 3) { if (box) box.innerHTML = '<p class="field-err">Type at least 3 characters to search.</p>'; return; }
    try {
      const r = await api("/api/mobility/geocode?q=" + encodeURIComponent(q));
      const places = (r.places || []).slice(0, 5);
      if (box) box.innerHTML = places.length
        ? places.map((p, i) => `<button type="button" class="suggest-item" data-addr-pick="${i}">${esc(p.label)}</button>`).join("")
        : '<p class="small">No places found. Try another name, or choose the point on the map.</p>';
      box?.querySelectorAll("[data-addr-pick]").forEach((pb) => pb.addEventListener("click", () => {
        const p = places[+pb.dataset.addrPick];
        m.draft.candidate = { lat: p.lat, lon: p.lon, label: p.label };
        showPickMarker(p.lat, p.lon);
        openChat(); wireChatCards();
      }));
    } catch { if (box) box.innerHTML = '<p class="field-err">Address search is unavailable. Choose the point on the map instead.</p>'; }
  }));
  document.querySelectorAll("[data-confirm-point]").forEach((b) => b.addEventListener("click", () => {
    const m = draftMsg(); if (!m?.draft?.candidate) return;
    m.draft.lat = m.draft.candidate.lat; m.draft.lon = m.draft.candidate.lon;
    m.draft.locationLabel = m.draft.candidate.label; m.draft.locationConfirmed = true;
    m.draft.candidate = null; pickState = null;
    openChat(); wireChatCards();
    document.querySelector("[data-confirm-draft]")?.focus();
  }));
  document.querySelectorAll("[data-cancel-point]").forEach((b) => b.addEventListener("click", () => {
    const m = draftMsg(); if (m?.draft) m.draft.candidate = null;
    pickState = null; pickMarker?.remove(); pickMarker = null;
    openChat(); wireChatCards();
  }));
  document.querySelectorAll("[data-confirm-draft]").forEach((b) => b.addEventListener("click", async () => {
    const m = draftMsg(); if (!m?.draft || m.draft.submitted || m.draft.submitting) return;
    const d = m.draft, root = draftEl(b);
    const show = (sel, on) => { const e = root?.querySelector(sel); if (e) e.hidden = !on; };
    if (!draftValid(d)) {
      show("[data-title-err]", !String(d.title || "").trim());
      show("[data-body-err]", !String(d.body || "").trim());
      show("[data-loc-err]", !draftHasLocation(d));
      toast("The draft is not ready yet. Check the notes under each field.");
      return;
    }
    d.submitting = true; syncDraftValidity(b);
    try {
      const w = d.workId ? SNAP.works.find((x) => x.id === d.workId) : null;
      const saved = await api("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: d.type || "report", category: d.category || "other", title: d.title.trim(), body: d.body.trim(),
          workId: d.workId || undefined, lat: w ? w.centroid.lat : d.lat, lon: w ? w.centroid.lon : d.lon, demo: !!d.demo }) });
      d.submitting = false;
      d.submitted = { id: saved.id, reviewStatus: saved.reviewStatus || "pending" };
      chatLog.push({ role: "ai", text: "Your report was submitted. It is now private and waiting for review — it is not public and this draft is closed." });
      await refresh(); openChat(); wireChatCards();
      toast("Report submitted privately for review.");
    } catch {
      d.submitting = false; syncDraftValidity(b);
      toast("It could not be submitted. Check the draft and try again.");
    }
  }));
  document.querySelectorAll("[data-discard-draft]").forEach((b) => b.addEventListener("click", () => {
    const m = draftMsg(); if (m) m.draft = null;
    pickState = null; pickMarker?.remove(); pickMarker = null;
    openChat(); wireChatCards();
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
  ${queue.length ? queue.map((s) => `<div class="finding"><p><strong>${esc(s.title)}</strong> ${s.demo ? '<span class="pill demo">Demo scenario</span>' : ""} <span class="pill ongoing">${esc(s.reviewStatus || "pending")}</span></p><p>${esc(s.body)}</p>
    <p class="small">${esc(s.type)} · ${esc(s.category)} · ${esc(s.createdAt.slice(0, 10))}${Number.isFinite(s.lat) ? ` · Confirmed point: ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : " · No confirmed point"}${s.uploadId ? " · Attachment uploaded (private)" : ""}</p>
    <p class="small">Approval records a review decision only. It does not verify the obstacle on the ground, certify accessibility, or remove anything.</p>
    ${Number.isFinite(s.lat) ? `<button class="btn small" data-review-map="${esc(s.id)}">Show point on map</button>` : ""}${s.uploadId ? `<button class="btn small" data-review-file="${esc(s.uploadId)}">View attachment</button>` : ""}
    <button class="btn small" data-approve="${esc(s.id)}">Approve</button> <button class="btn small warn" data-reject="${esc(s.id)}">Reject</button></div>`).join("") : "<p>The queue is empty.</p>"}
  <button class="btn" id="sign-out">Sign out reviewer</button>`);
  document.querySelectorAll("[data-review-map]").forEach((b) => b.addEventListener("click", () => {
    const s2 = queue.find((x) => x.id === b.dataset.reviewMap);
    if (!s2 || !map) return;
    closePanel();
    showPickMarker(s2.lat, s2.lon);
    map.flyTo({ center: [s2.lon, s2.lat], zoom: 17, duration: reduced ? 0 : 900 });
  }));
  document.querySelectorAll("[data-review-file]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/uploads/" + encodeURIComponent(b.dataset.reviewFile), { headers: { Authorization: "Bearer " + reviewerToken() } });
      if (!r.ok) throw new Error("file");
      const url = URL.createObjectURL(await r.blob());
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast("The attachment could not be opened."); }
  }));
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
$("#lay-buildings").addEventListener("change", () => applyBuildingVis());
let view3d = true;
$("#view-3d")?.addEventListener("click", () => {
  view3d = !view3d;
  const b = $("#view-3d");
  b.textContent = view3d ? "View: 2.5D" : "View: 2D";
  b.setAttribute("aria-pressed", String(view3d));
  if (!map) return;
  applyBuildingVis();
  map.easeTo({ pitch: view3d ? 52 : 0, bearing: view3d ? -14 : 0, duration: reduced ? 0 : 800 });
});
$("#lay-routes").addEventListener("change", (e) => setVis(["routes-verified", "routes-unknown"], e.target.checked));
$("#lay-traffic")?.addEventListener("change", () => applyTrafficVis());
$("#demo-badge").addEventListener("click", () => {
  openPanel("details", `<h2>About this demonstrator</h2><p>Independent demonstrator using Helsinki open data. Not endorsed by the City of Helsinki.</p>
  <p class="small"><strong>Who does what:</strong> Digitransit/HSL provides the transport options. Meta coordinates the tools, interprets the request and explains the evidence. This app checks the requirements and manages the state. You confirm any report. A reviewer makes the review decision; approval does not change routing automatically.</p>
  <p class="small">A pilot for inclusive mobility and a basis for an urban accessibility digital twin. It is not a complete twin. The 2.5D view uses real footprints on this map for orientation; it does not simulate slopes, kerbs or accessibility.</p>
  ${sourcesHtml({ id: "snapshot:" + SNAP.snapshotId, source: { provider: "City of Helsinki GeoServer WFS + Service Map", layer: "multiple", url: "https://kartta.hel.fi" } })}`);
});
document.querySelectorAll("[data-persp]").forEach((b) => b.addEventListener("click", () => {
  perspective = b.dataset.persp;
  const mm = $("#main-menu"); if (mm) mm.hidden = true; $("#menu-btn")?.setAttribute("aria-expanded", "false");
  document.querySelectorAll("[data-persp]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  if (perspective === "city") renderReview();
  else toast(perspective === "business" ? "Business perspective" : "Resident perspective");
}));
guardOverlayScroll();
$("#panel-content")?.addEventListener("scroll", () => {
  // While the panel is hidden (journey preview), a hidden scroller reads as
  // "at the bottom"; never let that re-enable follow mode.
  if (panelMode !== "chat" || $("#panel")?.hidden) return;
  chatFollow = isNearBottom(chatContent());
  const b = $("#new-response"); if (b && chatFollow) b.hidden = true;
}, { passive: true });
$("#new-response")?.addEventListener("click", () => { chatFollow = true; scrollChatToBottom(); });
const menuBtn = $("#menu-btn"), mainMenu = $("#main-menu");
menuBtn?.addEventListener("click", () => {
  const open = mainMenu.hidden;
  mainMenu.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (mainMenu && !mainMenu.hidden && !e.target.closest(".menu-wrap")) { mainMenu.hidden = true; menuBtn?.setAttribute("aria-expanded", "false"); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mainMenu && !mainMenu.hidden) { mainMenu.hidden = true; menuBtn?.setAttribute("aria-expanded", "false"); menuBtn?.focus(); }
});
wirePreview();
boot().catch(() => { openPanel("details", "<h2>Data unavailable</h2><p>The snapshot could not be loaded from the backend.</p>"); });
