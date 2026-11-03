"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let SNAP, submissions = [], cases = {}, reviewQueue = [], aiStatus = "not_configured";
let selected = null, perspective = "resident", map, layers = {}, markers = new Map(), baseLayer = null, tileErrors = 0;
const toast = (m) => { $("#toast").textContent = m; setTimeout(() => { $("#toast").textContent = ""; }, 5200); };
async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.analysis) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const caseOf = (id) => cases[id] || { status: "open", findings: [], actions: [], history: [], analysis: { status: aiStatus } };
const workSubs = (id) => submissions.filter((s) => s.workId === id);
const STATUS_EN = { "Käynnissä": ["Ongoing", "ongoing"], "Tuleva": ["Upcoming", "upcoming"] };
const statusPill = (w) => { const s = STATUS_EN[w.status]; return s ? `<span class="pill ${s[1]}">● ${s[0]}</span>` : (w.status ? `<span class="pill">● ${esc(w.status)}</span>` : ""); };
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
const period = (w) => [fmtDate(w.starts), fmtDate(w.ends)].filter(Boolean).join(" – ") || "Dates not published";

function openDetails(html) { $("#detail").innerHTML = html; const p = $("#details"); p.hidden = false; }
function closeDetails() { $("#details").hidden = true; selected = null; renderList(); }

/* ---- Basemap: City of Helsinki WMS grey base map (no credentials, CC BY 4.0).
   CARTO basemaps now require an API key, which this app does not have.
   If WMS tiles repeatedly fail, we switch to OpenStreetMap standard tiles
   (credential-free under the OSM tile usage policy) and say so on the map. ---- */
function helsinkiBase() {
  return L.tileLayer.wms("https://kartta.hel.fi/ws/geoserver/avoindata/wms", {
    layers: "avoindata:Kantakartta_harmaa", format: "image/png", transparent: false, version: "1.1.1",
    attribution: "Base map: City of Helsinki (CC BY 4.0) · Demonstrator data: City of Helsinki, Service Map",
  });
}
function osmFallback() {
  const note = $("#tile-note");
  note.hidden = false;
  note.textContent = "Helsinki base map tiles failed to load, so the map switched to OpenStreetMap tiles. Project data is unchanged.";
  $("#map-status").textContent = note.textContent;
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "Base map © OpenStreetMap contributors · Demonstrator data: City of Helsinki (CC BY 4.0), Service Map",
  });
}
function initMap(centre) {
  if (!window.L) { $("#map-status").textContent = "Map library unavailable. Use the list, which contains the same records."; return; }
  map = L.map("map", { keyboard: true, zoomControl: false }).setView([60.175, 24.90], 12);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  baseLayer = helsinkiBase().addTo(map);
  baseLayer.on("tileerror", () => { tileErrors++; if (tileErrors >= 6 && baseLayer) { map.removeLayer(baseLayer); baseLayer = osmFallback().addTo(map); } });
  layers.works = L.layerGroup().addTo(map);
  layers.services = L.layerGroup().addTo(map);
  layers.buildings = L.geoJSON(SNAP.buildings.map((b) => ({ type: "Feature", geometry: b.geometry, properties: {} })),
    { style: { color: "#a7b3bc", weight: 1, fillColor: "#454f58", fillOpacity: 0.75 } });
  layers.routes = L.geoJSON(SNAP.accessibilityRoutes.map((r) => ({ type: "Feature", geometry: r.geometry, properties: {} })),
    { style: { color: "#7ee2a0", weight: 3 } });
  drawMap();
  const done = () => { $("#intro").hidden = true; map.off("mousedown wheel zoomstart", done); };
  $("#skip-intro").addEventListener("click", () => { done(); map.setView([centre.lat, centre.lon], 16); });
  map.on("mousedown wheel zoomstart", done);
  if (reduced) { map.setView([centre.lat, centre.lon], 16); done(); }
  else setTimeout(() => { if (!$("#intro").hidden) { map.flyTo([centre.lat, centre.lon], 16, { duration: 2.2 }); setTimeout(done, 2400); } }, 350);
}
function drawMap() {
  if (!map) return;
  layers.works.clearLayers(); layers.services.clearLayers(); markers.clear();
  for (const w of SNAP.works) {
    if (!w.geometry) continue;
    const layer = L.geoJSON({ type: "Feature", geometry: w.geometry },
      { style: { color: "#22d3ee", weight: 2, fillColor: "#22d3ee", fillOpacity: 0.15 } });
    layer.on("click", () => selectWork(w.id, true));
    layer.bindTooltip(esc(w.address || w.kind), { sticky: true });
    layer.addTo(layers.works); markers.set(w.id, layer);
  }
  for (const s of SNAP.services) {
    const m = L.circleMarker([s.lat, s.lon], { radius: 5, color: "#d9f2df", fillColor: "#2e7d46", fillOpacity: 0.95 });
    m.on("click", () => selectService(s.id));
    m.bindTooltip(esc(s.name));
    m.addTo(layers.services); markers.set(s.id, m);
  }
}
function activeBarriers() { return [...document.querySelectorAll(".barrier-filter[aria-pressed='true']")].map((x) => x.dataset.value); }
function filtered() {
  const q = $("#search").value.trim().toLowerCase();
  const barriers = activeBarriers();
  let works = SNAP.works, services = SNAP.services;
  if (q) {
    works = works.filter((w) => [w.title, w.address, w.applicationId, w.kind].join(" ").toLowerCase().includes(q));
    services = services.filter((s) => [s.name, s.nameFi, s.address].join(" ").toLowerCase().includes(q));
  }
  if (barriers.length) {
    const ids = new Set(submissions.filter((s) => barriers.includes(s.category)).map((s) => s.workId));
    works = works.filter((w) => ids.has(w.id));
  }
  if (!$("#lay-works").checked) works = [];
  if (!$("#lay-services").checked) services = [];
  return { works: works.slice(0, 60), services: services.slice(0, 60) };
}
function renderList() {
  const { works, services } = filtered();
  $("#list-count").textContent = `${works.length} projects · ${services.length} services in this area`;
  const workCard = (w) => `<li><button class="card" data-select="${esc(w.id)}" data-service="0" aria-current="${selected === w.id}">
    <span class="card-title">${esc(w.address || w.applicationId || "Work area")}</span>
    <span class="card-sub">${esc((w.title || "").split("\n")[0].slice(0, 90))}</span>
    <span class="card-meta"><span class="pill type">${esc(w.kind)}</span>${statusPill(w)}<span class="pill">${esc(period(w))}</span>
    ${workSubs(w.id).some((s) => s.demo) ? '<span class="pill demo">Demo scenario</span>' : ""}</span></button></li>`;
  const svcCard = (s) => `<li><button class="card" data-select="${esc(s.id)}" data-service="1" aria-current="${selected === s.id}">
    <span class="card-title">${esc(s.name)}</span><span class="card-sub">${esc(s.address || "")}</span>
    <span class="card-meta"><span class="pill service">Public service</span></span></button></li>`;
  $("#item-list").innerHTML = works.map(workCard).join("") + services.map(svcCard).join("");
  document.querySelectorAll("[data-select]").forEach((b) => b.addEventListener("click", () =>
    b.dataset.service === "1" ? selectService(b.dataset.select) : selectWork(b.dataset.select, true)));
}
function focusMap(lat, lon) { if (!map) return; if (reduced) map.setView([lat, lon], 17); else map.flyTo([lat, lon], 17, { duration: 1.1 }); }
function sourcesHtml(w) {
  return `<details class="sources" id="sources-data"><summary>Sources &amp; data</summary><dl>
    <dt>Source record ID</dt><dd>${esc(w.id)}</dd>
    <dt>Provider &amp; layer</dt><dd>${esc(w.source.provider)} · ${esc(w.source.layer)}</dd>
    <dt>Source endpoint</dt><dd>${esc(w.source.url)}</dd>
    <dt>Data as of</dt><dd>Snapshot ${esc(SNAP.snapshotId)} · retrieved ${esc(SNAP.retrievedAt)} (cached, not live)</dd>
    <dt>Licence</dt><dd>${esc(SNAP.licence)} — ${esc(SNAP.attribution)}</dd>
    <dt>Historical views</dt><dd>Only snapshots actually stored are shown. Stored: ${esc(SNAP.snapshotId)}.</dd></dl></details>`;
}
async function selectService(id) {
  selected = id; renderList();
  const s = SNAP.services.find((x) => x.id === id); if (!s) return;
  focusMap(s.lat, s.lon);
  let near = [];
  try { near = (await api(`/api/services/${encodeURIComponent(id)}/nearby-works`)).works; } catch { /* panel still works */ }
  openDetails(`<h2>${esc(s.name)}</h2>
    <p><span class="pill service">Public service</span></p>
    <h3>Location</h3><p>${esc(s.address || "Address not available")}</p>
    <p class="small">Original Finnish name: ${esc(s.nameFi || "Not available")}</p>
    <h3>Entrances &amp; accessibility (source)</h3>
    <p class="small">Surveyed viewpoint codes from the Service Map: ${esc(s.accessibilityViewpoints || "Not available")}</p>
    ${s.accessibilityWww ? `<p><a class="btn secondary" href="${esc(s.accessibilityWww)}" target="_blank" rel="noopener">Open source accessibility summary</a></p>` : ""}
    <div class="ai-note">These codes summarise surveyed features. They do not certify an accessible route, especially during nearby works.</div>
    <h3>Nearest works</h3>
    ${near.length ? `<ul>${near.map((n) => `<li>${esc(n.kind)} — ${n.distanceM} m from this service</li>`).join("")}</ul>` : "<p>Not available</p>"}
    <p class="small">Distances are computed on the server. Nearby does not mean affected.</p>
    ${sourcesHtml({ id: s.id, source: s.source })}`);
}
async function selectWork(id, fly) {
  selected = id; renderList();
  const w = SNAP.works.find((x) => x.id === id); if (!w) return;
  if (innerWidth <= 900) document.getElementById("map-wrap").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  if (fly) focusMap(w.centroid.lat, w.centroid.lon);
  const layer = markers.get(id);
  if (layer && layer.setStyle) layer.setStyle({ color: "#ffb020", weight: 3.5, fillOpacity: 0.3 });
  let near = [];
  try { near = (await api(`/api/works/${encodeURIComponent(id)}/nearby`)).services; } catch { /* ignore */ }
  renderDetail(w, near);
}
const CATS = [["step-free-access", "Step-free access blocked"], ["blocked-pavement", "Blocked pavement"],
  ["temporary-ramp", "Missing temporary ramp"], ["signage", "Poor signage / diversion"], ["other", "Other"]];
function renderDetail(w, near) {
  const c = caseOf(w.id), subs = workSubs(w.id), a = c.analysis || { status: aiStatus };
  openDetails(`
  <h2>${esc(w.address || w.applicationId || "Work area")}</h2>
  <p><span class="pill type">${esc(w.kind)}</span> ${statusPill(w)} <span class="pill">Case: ${esc(c.status)}</span>
  ${subs.some((s) => s.demo) ? '<span class="pill demo">Demo scenario</span>' : ""}</p>
  <div class="actions">
    <button class="btn primary" id="btn-verify">Analyze evidence</button>
    <button class="btn secondary" id="btn-report">Report an issue</button>
    <button class="btn secondary" id="btn-nearby">View nearby services</button>
  </div>
  <div id="ai-slot">${a.status === "not_configured" ? "" : renderAnalysis(c)}</div>
  <h3>What is happening</h3>
  <p>${esc(w.kind)} in ${esc(w.district || "central Helsinki")}, published period ${esc(period(w))}.</p>
  <p class="small">Published purpose, original Finnish text (not translated):</p>
  <blockquote lang="fi">${esc(w.title || "Not available")}</blockquote>
  <h3>Impact information available</h3>
  <p>Contracts, budget and progress reports: <strong>Not available — missing evidence</strong>. Permit records alone do not establish obligations or completion percentages.</p>
  <h3>Timeline</h3>
  <ol class="timeline"><li>${esc(period(w))} — published period</li>
  ${c.history.map((h) => `<li>${esc(h.at.slice(0, 10))} — ${esc(h.event)}</li>`).join("")}</ol>
  <h3>Nearby public services</h3><div id="nearby">
  ${near.length ? `<ul>${near.slice(0, 5).map((n) => `<li>${esc(n.name)} — ${n.distanceM} m</li>`).join("")}</ul>` : "<p>Not available</p>"}
  <p class="small">Server-computed point-to-area distances. Nearby does not mean affected.</p></div>
  <h3>Evidence &amp; reports</h3><div id="subs">
  ${subs.length ? subs.map(subHtml).join("") : "<p>No approved submissions yet. New reports appear here after City review.</p>"}</div>
  ${subs.length > 1 ? `<p class="small">Compare dated evidence: tick two entries.</p><div class="compare" id="compare"></div>` : ""}
  <h3 id="report-h">${perspective === "business" ? "Business concern or alternative entrance" : "Report an issue"}</h3>
  <form id="sub-form">
    <label class="field">Type <select name="type"><option value="report">Citizen report</option><option value="evidence">Evidence</option><option value="business">Business concern / alternative entrance</option></select></label>
    <label class="field">Category <select name="category">${CATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    <label class="field">Title <input type="text" name="title" required maxlength="200"></label>
    <label class="field">Details <textarea name="body" required maxlength="2000" placeholder="What did you observe, where and when?"></textarea></label>
    <label class="field">Public document URL (optional) <input type="url" name="documentUrl" maxlength="500" placeholder="https://…"></label>
    <label class="field">Evidence file (optional — file name recorded only) <input type="file" id="file-input"></label>
    <label class="field">Contact (private, optional — never shown publicly) <input type="text" name="contact" maxlength="120"></label>
    <p class="small">Location: this work's published area. Submissions are reviewed before entering the public view.</p>
    <button class="btn primary" type="submit">Submit for review</button>
  </form>
  <h3>Next actions</h3>
  <ul>${c.actions.map((x) => `<li>${esc(x.title)} — ${esc(x.owner)} <span class="pill">${esc(x.status)}</span></li>`).join("") || "<li>No actions recorded yet.</li>"}</ul>
  <form id="action-form"><label class="field">New action <input type="text" name="title" required maxlength="200"></label>
  <label class="field">Owner <input type="text" name="owner" maxlength="80" placeholder="Team or role"></label>
  <button class="btn secondary" type="submit">Record action</button></form>
  <label class="field"><input type="checkbox" id="confirm-close"> I confirm, as a human reviewer, that this case is resolved.</label>
  <button class="btn warn" id="btn-close">Confirm closure</button>
  <button class="btn secondary" id="btn-reassess">Reassess with current evidence</button>
  ${sourcesHtml(w)}`);
  wireDetail(w, near);
}
function subHtml(s) {
  return `<div class="finding"><span class="pill type">${esc(s.type)}</span> <span class="pill ongoing">▲ ${esc(s.category)}</span>
  ${s.demo ? '<span class="pill demo">Demo scenario</span>' : ""}
  <p><strong>${esc(s.title)}</strong></p><p>${esc(s.body)}</p>
  <p class="small">${esc(s.createdAt.slice(0, 10))}${s.documentUrl ? ` · <a href="${esc(s.documentUrl)}">Attached public document</a>` : ""}${s.fileName ? ` · File: ${esc(s.fileName)} (name recorded)` : ""}</p>
  <label><input type="checkbox" class="cmp" value="${esc(s.id)}"> Compare</label></div>`;
}
function renderAnalysis(c) {
  const a = c.analysis || {};
  if (a.status === "not_configured") return `<div class="ai-note"><strong>Meta AI is not configured on this server.</strong>
    Add a Meta API key in the server-side <code>.env</code> file (see README) to run evidence analysis. Browsing and reporting work normally, and no simulated results are shown.</div>`;
  if (!a.toolActivity) return "";
  return `${a.summary ? `<p><strong>Summary (plain English):</strong> ${esc(a.summary)}</p>` : ""}
  <p class="small">Analysis status: ${esc(a.status)}${a.model ? ` · Model ${esc(a.model)}` : ""} · ${esc((a.updatedAt || "").slice(0, 10))}</p>
  <ol class="timeline">${a.toolActivity.map((t) => `<li><strong>${esc(t.step)}:</strong> ${esc(t.result)}</li>`).join("")}</ol>
  ${a.error ? `<div class="ai-note">${esc(a.error)}</div>` : ""}
  ${(c.findings || []).map((f) => `<div class="finding"><span class="pill ongoing">◆ ${esc(f.type)}</span><p><strong>${esc(f.title)}</strong></p><p>${esc(f.detail)}</p><p class="small">Sources: ${esc((f.sourceRefs || []).join(", ") || "case records")} · ${esc(f.at.slice(0, 10))}</p></div>`).join("")}`;
}
function wireDetail(w, near) {
  $("#btn-verify").addEventListener("click", async () => {
    if (aiStatus === "not_configured") { $("#ai-slot").innerHTML = renderAnalysis({ analysis: { status: "not_configured" }, findings: [] }); $("#ai-slot").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" }); return; }
    toast("Running verification…");
    const r = await api(`/api/cases/${encodeURIComponent(w.id)}/verify`, { method: "POST" });
    await refresh(); selectWork(w.id, false);
    toast(r.duplicate ? "Evidence unchanged — existing findings kept." : "Verification finished.");
  });
  $("#btn-reassess").addEventListener("click", async () => { $("#btn-verify").click(); });
  $("#btn-report").addEventListener("click", () => { $("#report-h").scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); document.querySelector("#sub-form [name=title]")?.focus({ preventScroll: true }); });
  $("#btn-nearby").addEventListener("click", () => {
    document.querySelectorAll(".barrier-filter").forEach((x) => x.setAttribute("aria-pressed", "false"));
    $("#lay-services").checked = true;
    if (map && !map.hasLayer(layers.services)) layers.services.addTo(map);
    $("#search").value = ""; renderList();
    toast(`${near.length} nearest services are listed in the project list on the left.`);
    document.getElementById("nearby")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  });
  $("#sub-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: w.id, type: fd.get("type"), category: fd.get("category"), title: fd.get("title"),
        body: fd.get("body"), documentUrl: fd.get("documentUrl"), contact: fd.get("contact"),
        lat: w.centroid.lat, lon: w.centroid.lon, fileName: $("#file-input").files[0]?.name || null }) });
    toast("Submitted. It appears in the public view only after review (City perspective).");
    await refresh(); selectWork(w.id, false);
  });
  $("#action-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api(`/api/cases/${encodeURIComponent(w.id)}/actions`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: fd.get("title"), owner: fd.get("owner") }) });
    await refresh(); selectWork(w.id, false); toast("Action recorded.");
  });
  $("#btn-close").addEventListener("click", async () => {
    if (!$("#confirm-close").checked) { toast("Tick the human confirmation first."); return; }
    await api(`/api/cases/${encodeURIComponent(w.id)}/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    await refresh(); selectWork(w.id, false); toast("Case closed by human confirmation.");
  });
  document.querySelectorAll(".cmp").forEach((box) => box.addEventListener("change", () => {
    const picked = [...document.querySelectorAll(".cmp:checked")].map((x) => submissions.find((s) => s.id === x.value)).filter(Boolean).slice(0, 2);
    const host = $("#compare"); if (host) host.innerHTML = picked.map((s) => `<div><strong>${esc(s.createdAt.slice(0, 10))}</strong><br>${esc(s.title)}<p>${esc(s.body)}</p></div>`).join("");
  }));
}
async function refresh() {
  submissions = await api("/api/submissions");
  const cs = await api("/api/cases"); cases = Object.fromEntries(cs.map((c) => [c.workId, c]));
  reviewQueue = await api("/api/review-queue").catch(() => []);
  renderList(); renderReview();
}
function renderReview() {
  if (perspective !== "city" || selected) return;
  openDetails(`<h2>Review queue</h2>
  <p>Reports stay out of the public view until approved here. Contact details are never exposed.</p>
  ${reviewQueue.length ? reviewQueue.map((s) => `<div class="finding"><p><strong>${esc(s.title)}</strong></p><p>${esc(s.body)}</p>
    <p class="small">${esc(s.type)} · ${esc(s.category)} · ${esc(s.createdAt.slice(0, 10))}</p>
    <button class="btn small" data-approve="${esc(s.id)}">Approve</button> <button class="btn small warn" data-reject="${esc(s.id)}">Reject</button></div>`).join("") : "<p>The queue is empty. New submissions will appear here for review.</p>"}`);
  document.querySelectorAll("[data-approve],[data-reject]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/submissions/${b.dataset.approve || b.dataset.reject}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve: !!b.dataset.approve }) });
    selected = null; await refresh(); toast("Review saved.");
  }));
}
/* ---- 3D: real footprints extruded; height estimated from recorded floors ---- */
let three3d = null;
async function setMode(is3d) {
  $("#mode-2d").setAttribute("aria-pressed", String(!is3d));
  $("#mode-3d").setAttribute("aria-pressed", String(is3d));
  $("#view3d").hidden = !is3d; if (map) $("#map").style.visibility = is3d ? "hidden" : "visible";
  if (!is3d || three3d) { if (three3d && is3d) three3d.render(); return; }
  try {
    const THREE = await import("three");
    const el = $("#view3d");
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x262c33);
    const cam = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 1, 6000);
    const c0 = SNAP.demoArea.centre, kx = 111320 * Math.cos(c0.lat * Math.PI / 180), ky = 110540;
    const proj = (lon, lat) => [(lon - c0.lon) * kx, (lat - c0.lat) * ky];
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(el.clientWidth, el.clientHeight); el.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xdfe8ee, 0x20262c, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(300, 420, 200); scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), new THREE.MeshStandardMaterial({ color: 0x2e353d }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    const mat = new THREE.MeshStandardMaterial({ color: 0xa7b1ba, roughness: 0.85 });
    for (const b of SNAP.buildings.slice(0, 450)) {
      const ring0 = b.geometry?.type === "Polygon" ? b.geometry.coordinates[0] : b.geometry?.coordinates?.[0]?.[0];
      if (!ring0 || ring0.length < 4) continue;
      const shape = new THREE.Shape(ring0.map(([lon, lat]) => { const [x, y] = proj(lon, lat); return new THREE.Vector2(x, y); }));
      const height = Math.max(3, (Number(b.floors) || 3) * 3.1);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); scene.add(new THREE.Mesh(geo, mat));
    }
    const sel = SNAP.works.find((w) => w.id === selected) || SNAP.works[0];
    const ring0 = sel.geometry?.type === "Polygon" ? sel.geometry.coordinates[0] : sel.geometry?.coordinates?.[0]?.[0];
    if (ring0) {
      const pts = ring0.map(([lon, lat]) => { const [x, y] = proj(lon, lat); return new THREE.Vector3(x, 3, -y); });
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x22d3ee })));
    }
    let az = 0.7, pol = 0.9, rad = 720, drag = null;
    const place = () => { cam.position.set(rad * Math.sin(pol) * Math.cos(az), rad * Math.cos(pol), rad * Math.sin(pol) * Math.sin(az)); cam.lookAt(0, 0, 0); renderer.render(scene, cam); };
    el.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; });
    el.addEventListener("pointermove", (e) => { if (!drag) return; az -= (e.clientX - drag[0]) * 0.005; pol = Math.max(0.15, Math.min(1.4, pol - (e.clientY - drag[1]) * 0.005)); drag = [e.clientX, e.clientY]; place(); });
    el.addEventListener("pointerup", () => { drag = null; });
    three3d = { render: place }; place();
  } catch { $("#view3d").innerHTML = "<p style='color:#fff;padding:14px'>3D view could not load. The 2D map and list remain fully usable.</p>"; }
}
async function boot() {
  SNAP = await api("/api/snapshot");
  aiStatus = (await api("/api/ai/status")).status;
  $("#snap-date").textContent = SNAP.snapshotId;
  initMap(SNAP.demoArea.centre);
  await refresh();
  const demo = submissions.find((s) => s.demo);
  if (demo && innerWidth > 900) selectWork(demo.workId, false);
  else if (demo) { selected = demo.workId; renderList(); }
}
$("#search").addEventListener("input", renderList);
document.querySelectorAll(".barrier-filter").forEach((x) => x.addEventListener("click", () => {
  x.setAttribute("aria-pressed", String(x.getAttribute("aria-pressed") !== "true")); renderList();
}));
$("#lay-works").addEventListener("change", (e) => { renderList(); if (map) e.target.checked ? layers.works.addTo(map) : map.removeLayer(layers.works); });
$("#lay-services").addEventListener("change", (e) => { renderList(); if (map) e.target.checked ? layers.services.addTo(map) : map.removeLayer(layers.services); });
$("#lay-buildings").addEventListener("change", (e) => { if (map) e.target.checked ? layers.buildings.addTo(map) : map.removeLayer(layers.buildings); });
$("#lay-routes").addEventListener("change", (e) => { if (map) e.target.checked ? layers.routes.addTo(map) : map.removeLayer(layers.routes); });
$("#mode-2d").addEventListener("click", () => setMode(false));
$("#mode-3d").addEventListener("click", () => setMode(true));
$("#close-details").addEventListener("click", closeDetails);
$("#demo-badge").addEventListener("click", () => {
  if (selected) { document.getElementById("sources-data")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); document.querySelector("#sources-data summary")?.focus(); }
  else openDetails(`<h2>About this demonstrator</h2><p>Independent demonstrator. Not endorsed by the City of Helsinki.</p>${sourcesHtml(SNAP.works[0] || { id: "—", source: { provider: "City of Helsinki", layer: "multiple", url: "https://kartta.hel.fi" } })}`);
});
document.querySelectorAll("[data-persp]").forEach((b) => b.addEventListener("click", () => {
  perspective = b.dataset.persp;
  document.querySelectorAll("[data-persp]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  if (perspective === "city") { selected = null; renderReview(); }
  else if (!selected) closeDetails();
  renderList();
}));
boot().catch(() => { openDetails("<h2>Data unavailable</h2><p>The snapshot could not be loaded from the backend.</p>"); });
