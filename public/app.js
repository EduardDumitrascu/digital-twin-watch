"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let SNAP, submissions = [], cases = {}, reviewQueue = [], aiStatus = "not_configured";
let selected = null, perspective = "resident", map, layers = {}, markers = new Map();
const toast = (m) => { $("#toast").textContent = m; setTimeout(() => { $("#toast").textContent = ""; }, 5000); };
async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.analysis) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const caseOf = (workId) => cases[workId] || { status: "open", findings: [], actions: [], history: [], analysis: { status: aiStatus } };
const workSubs = (id) => submissions.filter((s) => s.workId === id);

function initMap(centre) {
  if (!window.L) { $("#map-status").textContent = "Map library unavailable. Use the list, which contains the same records."; return; }
  map = L.map("map", { keyboard: true }).setView([60.175, 24.90], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 19 }).addTo(map);
  layers.works = L.layerGroup().addTo(map);
  layers.services = L.layerGroup().addTo(map);
  layers.buildings = L.layerGroup();
  layers.routes = L.geoJSON(SNAP.accessibilityRoutes.map((r) => ({ type: "Feature", geometry: r.geometry, properties: {} })),
    { style: { color: "#7ee2a0", weight: 3 } });
  layers.buildings.addLayer(L.geoJSON(SNAP.buildings.map((b) => ({ type: "Feature", geometry: b.geometry, properties: {} })),
    { style: { color: "#8a939c", weight: 1, fillColor: "#3a4148", fillOpacity: 0.7 } }));
  drawMap();
  // Short, skippable camera transition into the demonstration area.
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
      { style: { color: "#00c2d8", weight: 2, fillColor: "#00c2d8", fillOpacity: 0.14 } });
    layer.on("click", () => selectWork(w.id, true));
    layer.bindTooltip(esc(w.kind), { sticky: true });
    layer.addTo(layers.works); markers.set(w.id, layer);
  }
  for (const s of SNAP.services) {
    const m = L.circleMarker([s.lat, s.lon], { radius: 5, color: "#bfe8c5", fillColor: "#3f7d4e", fillOpacity: 0.9 });
    m.on("click", () => selectService(s.id));
    m.bindTooltip(esc(s.name));
    m.addTo(layers.services); markers.set(s.id, m);
  }
}
function filtered() {
  const q = $("#search").value.trim().toLowerCase();
  const barriers = [...document.querySelectorAll(".barrier-filter:checked")].map((x) => x.value);
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
  $("#list-count").textContent = `${works.length} works · ${services.length} services shown (bounded snapshot sample)`;
  const li = (inner, cls, id, isService) =>
    `<li><button class="${cls}" data-select="${esc(id)}" data-service="${isService ? 1 : 0}" aria-current="${selected === id}">${inner}</button></li>`;
  $("#item-list").innerHTML =
    works.map((w) => li(`<span class="badge">${esc(w.kind)}</span><strong>${esc(w.address || w.applicationId || "Unnamed work")}</strong><br><span class="tag">${esc(w.applicationId || "")} · ${esc(w.starts || "?")} → ${esc(w.ends || "?")} · Case: ${esc(caseOf(w.id).status)}</span>`, "", w.id, false)).join("")
    + services.map((s) => li(`<span class="badge">Service</span><strong>${esc(s.name)}</strong><br><span class="tag">${esc(s.address || "")}</span>`, "service", s.id, true)).join("");
  document.querySelectorAll("[data-select]").forEach((b) => b.addEventListener("click", () =>
    b.dataset.service === "1" ? selectService(b.dataset.select) : selectWork(b.dataset.select, true)));
}
function focusMap(lat, lon) {
  if (!map) return;
  map.closePopup();
  if (reduced) map.setView([lat, lon], 17); else map.flyTo([lat, lon], 17, { duration: 1.1 });
}
async function selectService(id) {
  selected = id; renderList();
  const s = SNAP.services.find((x) => x.id === id); if (!s) return;
  focusMap(s.lat, s.lon);
  let near = [];
  try { near = (await api(`/api/services/${encodeURIComponent(id)}/nearby-works`)).works; } catch { /* panel still works */ }
  $("#detail").innerHTML = `<h2>${esc(s.name)}</h2>
    <p><span class="badge">Public service</span></p>
    <dl class="kv"><dt>Address</dt><dd>${esc(s.address || "Not available")}</dd>
    <dt>Original name (Finnish)</dt><dd>${esc(s.nameFi || "Not available")}</dd>
    <dt>Accessibility viewpoints (source codes)</dt><dd>${esc(s.accessibilityViewpoints || "Not available")}</dd>
    <dt>Accessibility details</dt><dd>${s.accessibilityWww ? `<a href="${esc(s.accessibilityWww)}">Source accessibility summary</a>` : "Not available"}</dd></dl>
    <div class="notice">Source limitation: viewpoint codes summarise surveyed features. They do not certify an accessible route, especially during nearby works.</div>
    <h3>Nearest works (deterministic, server-computed)</h3>
    ${near.length ? `<ul>${near.map((n) => `<li>${esc(n.kind)} — ${n.distanceM} m from this service point</li>`).join("")}</ul>` : "<p>Not available</p>"}
    <h3>Source</h3><p class="tag">${esc(s.source.provider)} · Source ID ${esc(s.id)} · Retrieved with snapshot ${esc(SNAP.snapshotId)} (cached, not live).</p>`;
}
async function selectWork(id, fly) {
  selected = id; renderList();
  const w = SNAP.works.find((x) => x.id === id); if (!w) return;
  if (fly) focusMap(w.centroid.lat, w.centroid.lon);
  const layer = markers.get(id);
  if (layer && layer.setStyle) layer.setStyle({ color: "#ffb020", weight: 3 });
  let near = [];
  try { near = (await api(`/api/works/${encodeURIComponent(id)}/nearby`)).services; } catch { /* ignore */ }
  renderDetail(w, near);
}
const CATS = [["step-free-access", "Step-free access blocked"], ["blocked-pavement", "Blocked pavement"],
  ["temporary-ramp", "Missing temporary ramp"], ["signage", "Poor signage / diversion"], ["other", "Other"]];
function renderDetail(w, near) {
  const c = caseOf(w.id), subs = workSubs(w.id);
  const a = c.analysis || { status: aiStatus };
  $("#detail").innerHTML = `
  <h2>${esc(w.address || w.applicationId || "Work record")}</h2>
  <p><span class="badge">${esc(w.kind)}</span><span class="badge ${c.status === "closed" ? "closed" : "issue"}">● Case: ${esc(c.status)}</span>
  ${subs.some((s) => s.demo) ? '<span class="badge demo">Demo scenario present</span>' : ""}</p>
  <dl class="kv">
    <dt>Source ID</dt><dd>${esc(w.id)}</dd>
    <dt>Application ID</dt><dd>${esc(w.applicationId || "Not available")}</dd>
    <dt>Published status (source)</dt><dd>${esc(w.status || "Not available")}</dd>
    <dt>Published period (source)</dt><dd>${esc(w.starts || "?")} → ${esc(w.ends || "?")}</dd>
    <dt>District</dt><dd>${esc(w.district || "Not available")}</dd>
    <dt>Contracts / budget / progress report</dt><dd>Not available — Missing evidence. Permit records alone do not establish contractual obligations or completion percentages.</dd>
    <dt>Source</dt><dd>${esc(w.source.provider)} · layer ${esc(w.source.layer)} · Retrieved ${esc(SNAP.retrievedAt)} (cached snapshot, not live) · Licence ${esc(SNAP.licence)}</dd>
  </dl>
  <h3>Original source text</h3><blockquote lang="fi">${esc(w.title || "Not available")}</blockquote>
  <h3>Project timeline</h3>
  <ol class="timeline">
    <li>${esc(w.starts || "Date not available")} — published start (source record)</li>
    <li>${esc(w.ends || "Date not available")} — published end (source record)</li>
    ${c.history.map((h) => `<li>${esc(h.at.slice(0, 10))} — ${esc(h.event)}</li>`).join("")}
  </ol>
  <h3>Nearby public services (deterministic distances)</h3>
  ${near.length ? `<ul>${near.map((n) => `<li>${esc(n.name)} — ${n.distanceM} m (point-to-work-area)${n.accessibilityViewpoints ? ` · accessibility codes: ${esc(n.accessibilityViewpoints)}` : ""}</li>`).join("")}</ul>` : "<p>Not available</p>"}
  <p class="tag">Nearby does not mean affected. Distances are computed server-side; the model never invents them.</p>

  <h3>Meta AI verification</h3>
  <p>AI status: <strong>${a.status === "not_configured" ? "Not configured" : esc(a.status)}</strong>${a.model ? ` · Model: ${esc(a.model)}` : ""}</p>
  ${a.status === "not_configured" ? '<div class="notice">Not configured: no Meta API key is set on the server. Browsing and reporting work; no simulated AI results are shown.</div>' : ""}
  <button class="btn primary" id="btn-verify">Run Meta AI verification</button>
  <button class="btn" id="btn-reassess">Reassess with current evidence</button>
  <div id="analysis">${renderAnalysis(c)}</div>

  <h3>Evidence and reports (approved, public view)</h3>
  <div id="subs">${subs.length ? subs.map(subHtml).join("") : "<p>No approved submissions yet. New submissions appear here only after review.</p>"}</div>
  ${subs.length > 1 ? `<p class="tag">Compare dated evidence: tick two entries.</p><div class="compare" id="compare"></div>` : ""}

  <h3>${perspective === "business" ? "Record a business concern or alternative entrance" : "Submit a report or evidence"}</h3>
  <form id="sub-form">
    <label>Type <select name="type"><option value="report">Citizen report</option><option value="evidence">Evidence</option><option value="business">Business concern / alternative entrance</option></select></label>
    <label>Category <select name="category">${CATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    <label>Title <input type="text" name="title" required maxlength="200"></label>
    <label>Details <textarea name="body" required maxlength="2000" placeholder="What did you observe, where and when?"></textarea></label>
    <label>Public document URL (optional) <input type="text" name="documentUrl" maxlength="500" placeholder="https://…"></label>
    <label>Evidence file (optional, name recorded only) <input type="file" id="file-input"></label>
    <label>Contact (private, optional — never shown publicly) <input type="text" name="contact" maxlength="120"></label>
    <p class="tag">Location uses this work's published area centre (${w.centroid.lat}, ${w.centroid.lon}). Submissions are reviewed before appearing in the public view.</p>
    <button class="btn primary" type="submit">Submit for review</button>
  </form>

  <h3>Actions</h3>
  <ul>${c.actions.map((x) => `<li>${esc(x.title)} — ${esc(x.owner)} <span class="badge">${esc(x.status)}</span></li>`).join("") || "<li>No actions recorded.</li>"}</ul>
  <form id="action-form"><label>New action <input type="text" name="title" required maxlength="200"></label>
  <label>Owner <input type="text" name="owner" maxlength="80" placeholder="Team or role"></label>
  <button class="btn" type="submit">Record action</button></form>
  <h3>Confirm resolution</h3>
  <label><input type="checkbox" id="confirm-close"> I confirm, as a human reviewer, that this case is resolved.</label>
  <button class="btn warn" id="btn-close">Confirm closure</button>`;
  wireDetail(w);
}
function subHtml(s) {
  return `<div class="finding"><span class="badge">${esc(s.type)}</span><span class="badge issue">▲ ${esc(s.category)}</span>
  ${s.demo ? '<span class="badge demo">Demo scenario</span>' : ""}
  <strong>${esc(s.title)}</strong><p>${esc(s.body)}</p>
  <p class="tag">${esc(s.createdAt.slice(0, 10))}${s.documentUrl ? ` · <a href="${esc(s.documentUrl)}">Attached public document</a>` : ""}${s.fileName ? ` · File: ${esc(s.fileName)} (name recorded)` : ""}</p>
  <label><input type="checkbox" class="cmp" value="${esc(s.id)}"> Compare</label></div>`;
}
function renderAnalysis(c) {
  const a = c.analysis || {};
  if (!a.toolActivity) return "";
  return `${a.summary ? `<p><strong>Plain-English summary:</strong> ${esc(a.summary)}</p>` : ""}
  <h4>Tool activity (actual steps)</h4><ol class="timeline">${a.toolActivity.map((t) => `<li><strong>${esc(t.step)}:</strong> ${esc(t.result)}</li>`).join("")}</ol>
  ${a.error ? `<div class="notice">${esc(a.error)}</div>` : ""}
  ${(c.findings || []).map((f) => `<div class="finding"><span class="badge issue">◆ ${esc(f.type)}</span><strong>${esc(f.title)}</strong>
    <p>${esc(f.detail)}</p><p class="tag">Sources: ${esc((f.sourceRefs || []).join(", ") || "case records")} · ${esc(f.at.slice(0, 10))}</p></div>`).join("")}`;
}
function wireDetail(w) {
  const run = async () => {
    toast("Running verification…");
    const r = await api(`/api/cases/${encodeURIComponent(w.id)}/verify`, { method: "POST" });
    await refresh(); selectWork(w.id, false); toast(r.duplicate ? "Evidence unchanged — existing findings kept (duplicate avoided)." : "Verification finished.");
  };
  $("#btn-verify").addEventListener("click", run);
  $("#btn-reassess").addEventListener("click", run);
  $("#sub-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: w.id, type: fd.get("type"), category: fd.get("category"), title: fd.get("title"),
        body: fd.get("body"), documentUrl: fd.get("documentUrl"), contact: fd.get("contact"),
        lat: w.centroid.lat, lon: w.centroid.lon, fileName: $("#file-input").files[0]?.name || null }) });
    toast("Submitted. It will appear in the public view only after review (City perspective).");
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
    $("#compare").innerHTML = picked.map((s) => `<div><strong>${esc(s.createdAt.slice(0, 10))}</strong><br>${esc(s.title)}<p>${esc(s.body)}</p></div>`).join("");
  }));
}
async function refresh() {
  submissions = await api("/api/submissions");
  const cs = await api("/api/cases"); cases = Object.fromEntries(cs.map((c) => [c.workId, c]));
  reviewQueue = await api("/api/review-queue").catch(() => []);
  renderList(); renderReview();
}
function renderReview() {
  if (perspective !== "city") return;
  const host = $("#detail");
  if (selected) return;
  host.innerHTML = `<h2>City perspective — review queue</h2>
  <p>Submitted reports stay out of the public view until approved here. Contact details are never exposed.</p>
  ${reviewQueue.length ? reviewQueue.map((s) => `<div class="finding"><strong>${esc(s.title)}</strong><p>${esc(s.body)}</p>
    <p class="tag">${esc(s.type)} · ${esc(s.category)} · ${esc(s.createdAt.slice(0, 10))}</p>
    <button class="btn primary" data-approve="${esc(s.id)}">Approve</button><button class="btn warn" data-reject="${esc(s.id)}">Reject</button></div>`).join("") : "<p>Queue is empty.</p>"}`;
  host.querySelectorAll("[data-approve],[data-reject]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/submissions/${b.dataset.approve || b.dataset.reject}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve: !!b.dataset.approve }) });
    await refresh(); toast("Review saved.");
  }));
}
// ---- 3D buildings: real footprints extruded by recorded floor count ----
let three3d = null;
async function toggle3D(on) {
  $("#view3d").hidden = !on; if (map) $("#map").style.visibility = on ? "hidden" : "visible";
  if (!on || three3d) return;
  try {
    const THREE = await import("three");
    const el = $("#view3d");
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x23282d);
    const cam = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 1, 5000);
    const c0 = SNAP.demoArea.centre, kx = 111320 * Math.cos(c0.lat * Math.PI / 180), ky = 110540;
    const proj = (lon, lat) => [(lon - c0.lon) * kx, (lat - c0.lat) * ky];
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(el.clientWidth, el.clientHeight); el.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xdfe8ee, 0x1c2126, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(300, 400, 200); scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1700, 1700), new THREE.MeshStandardMaterial({ color: 0x2a3036 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.85 });
    for (const b of SNAP.buildings.slice(0, 450)) {
      const ring0 = b.geometry?.type === "Polygon" ? b.geometry.coordinates[0] : b.geometry?.coordinates?.[0]?.[0];
      if (!ring0 || ring0.length < 4) continue;
      const shape = new THREE.Shape(ring0.map(([lon, lat]) => { const [x, y] = proj(lon, lat); return new THREE.Vector2(x, y); }));
      const height = Math.max(3, (Number(b.floors) || 3) * 3.1); // estimated from recorded floor count
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      scene.add(new THREE.Mesh(geo, mat));
    }
    const sel = SNAP.works.find((w) => w.id === selected) || SNAP.works[0];
    const ring0 = sel.geometry?.type === "Polygon" ? sel.geometry.coordinates[0] : sel.geometry?.coordinates?.[0]?.[0];
    if (ring0) {
      const pts = ring0.map(([lon, lat]) => { const [x, y] = proj(lon, lat); return new THREE.Vector3(x, 3, -y); });
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x00c2d8 })));
    }
    let az = 0.7, pol = 0.9, rad = 700, drag = null;
    const place = () => { cam.position.set(rad * Math.sin(pol) * Math.cos(az), rad * Math.cos(pol), rad * Math.sin(pol) * Math.sin(az)); cam.lookAt(0, 0, 0); };
    el.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; });
    el.addEventListener("pointermove", (e) => { if (!drag) return; az -= (e.clientX - drag[0]) * 0.005; pol = Math.max(0.15, Math.min(1.4, pol - (e.clientY - drag[1]) * 0.005)); drag = [e.clientX, e.clientY]; place(); });
    el.addEventListener("pointerup", () => { drag = null; });
    el.setAttribute("aria-label", "3D view: building footprints extruded by recorded floor count (estimated heights, simplified geometry). Drag to orbit.");
    place(); renderer.render(scene, cam);
    three3d = { render: () => renderer.render(scene, cam) };
    el.addEventListener("pointermove", () => three3d.render());
  } catch { $("#view3d").innerHTML = "<p style='color:#fff;padding:12px'>3D view unavailable (library failed to load). The 2D map and list remain fully usable.</p>"; }
}
async function boot() {
  SNAP = await api("/api/snapshot");
  aiStatus = (await api("/api/ai/status")).status;
  $("#snap-label").textContent = `Snapshot ${SNAP.snapshotId}, retrieved ${SNAP.retrievedAt.slice(0, 10)} (cached, not live) · ${SNAP.attribution}`;
  if (SNAP.failures?.length) toast(`Some sources failed at import: ${SNAP.failures.map((f) => f.name).join(", ")}. Verified sources are shown.`);
  initMap(SNAP.demoArea.centre);
  await refresh();
  const demo = submissions.find((s) => s.demo);
  if (demo) selectWork(demo.workId, false);
}
["search"].forEach((id) => $("#" + id).addEventListener("input", renderList));
document.querySelectorAll(".barrier-filter").forEach((x) => x.addEventListener("change", renderList));
$("#lay-works").addEventListener("change", (e) => { renderList(); if (map) e.target.checked ? layers.works.addTo(map) : map.removeLayer(layers.works); });
$("#lay-services").addEventListener("change", (e) => { renderList(); if (map) e.target.checked ? layers.services.addTo(map) : map.removeLayer(layers.services); });
$("#lay-buildings").addEventListener("change", (e) => { if (map) e.target.checked ? layers.buildings.addTo(map) : map.removeLayer(layers.buildings); });
$("#lay-routes").addEventListener("change", (e) => { if (map) e.target.checked ? layers.routes.addTo(map) : map.removeLayer(layers.routes); });
$("#lay-3d").addEventListener("change", (e) => toggle3D(e.target.checked));
document.querySelectorAll("[data-persp]").forEach((b) => b.addEventListener("click", () => {
  perspective = b.dataset.persp;
  document.querySelectorAll("[data-persp]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  selected = null; renderReview();
  if (perspective !== "city") $("#detail").innerHTML = `<p>${perspective === "business" ? "Business perspective: select a work to record a business concern or an alternative entrance." : "Resident perspective: select a work to report an accessibility barrier or attach evidence."} The underlying records are the same in every perspective.</p>`;
  renderList();
}));
boot().catch(() => { $("#detail").innerHTML = "<p>Failed to load snapshot data from the backend.</p>"; });
