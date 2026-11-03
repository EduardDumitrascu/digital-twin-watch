"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let SNAP, submissions = [], cases = {}, aiStatus = "not_configured", reviewerConfigured = false;
let selected = null, perspective = "resident", panelMode = null, detailTab = "overview";
let map, layers = {}, markers = new Map(), baseLayer = null, tileErrors = 0, page = 0;
let chatLog = [], lastCards = [], nearCache = [], three3d = null, sel3d = null, THREEref = null;
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
function openPanel(mode, html) {
  panelMode = mode;
  const w = $("#welcome"); if (w) w.hidden = true;
  $("#panel-content").innerHTML = html;
  $("#panel").hidden = false;
}
function closePanel() { panelMode = null; $("#panel").hidden = true; }
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
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "Base map © OpenStreetMap contributors · Demonstrator data: City of Helsinki (CC BY 4.0), Service Map",
  });
}
function initMap(centre) {
  if (!window.L) { $("#map-status").textContent = "Map library unavailable."; return; }
  map = L.map("map", { keyboard: true, zoomControl: false }).setView([centre.lat, centre.lon], 15);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  baseLayer = helsinkiBase().addTo(map);
  baseLayer.on("tileerror", () => { tileErrors++; if (tileErrors >= 6 && baseLayer) { map.removeLayer(baseLayer); baseLayer = osmFallback().addTo(map); } });
  layers.works = L.layerGroup().addTo(map);
  layers.services = L.layerGroup().addTo(map);
  layers.buildings = L.geoJSON(SNAP.buildings.map((b) => ({ type: "Feature", geometry: b.geometry, properties: {} })),
    { style: { color: "#7d8894", weight: 1, fillColor: "#aeb8c0", fillOpacity: 0.55 } });
  layers.routes = L.layerGroup();
  for (const r of SNAP.accessibilityRoutes) {
    if (!r.geometry) continue;
    const verified = r.realisedAccessibility === "Kyllä";
    L.geoJSON({ type: "Feature", geometry: r.geometry, properties: {} },
      { style: verified ? { color: "#1f8a4c", weight: 3 } : { color: "#8a94a0", weight: 2, dashArray: "5 5" } }).addTo(layers.routes);
  }
  drawMap();
  map.on("moveend", () => { if (panelMode === "results") renderResults(false); });
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
  if (!map) return;
  layers.works.clearLayers(); layers.services.clearLayers(); markers.clear();
  const { works, places } = filtered();
  for (const w of works) {
    if (!w.geometry) continue;
    const isSel = w.id === selected;
    const layer = L.geoJSON({ type: "Feature", geometry: w.geometry },
      { style: isSel ? { color: "#e07b00", weight: 3.5, fillColor: "#ffb020", fillOpacity: 0.3 }
                     : { color: "#0e7ea6", weight: 2, fillColor: "#38b6d3", fillOpacity: 0.18 } });
    layer.on("click", () => selectWork(w.id, false));
    layer.bindTooltip(esc(w.address || w.kind), { sticky: true });
    layer.addTo(layers.works); markers.set(w.id, layer);
  }
  const iconFor = (cat) => L.divIcon({ className: "", html: `<div class="place-marker pm-${cat === "public_service" ? "service" : cat === "business" ? "business" : "place"}" aria-hidden="true">${cat === "public_service" ? "S" : cat === "business" ? "B" : "•"}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  for (const s of places) {
    const m = L.marker([s.lat, s.lon], { icon: iconFor(s.category), keyboard: true, title: s.name });
    m.on("click", () => selectService(s.id));
    m.bindTooltip(`${esc(s.name)} (${CAT_LABEL[s.category]?.[0] || "Place"})`);
    m.addTo(layers.services); markers.set(s.id, m);
  }
  const rc = $("#results-count");
  if (rc) rc.textContent = `${works.length} projects · ${places.length} places match the current filters`;
}
function frameWork(w) {
  if (!map) return;
  const panelPad = panelMode && innerWidth > 760 ? 400 : 30;
  if (w.geometry) {
    const b = L.geoJSON({ type: "Feature", geometry: w.geometry }).getBounds();
    if (reduced) map.fitBounds(b, { paddingTopLeft: [30, 30], paddingBottomRight: [panelPad, 30] });
    else map.flyToBounds(b, { paddingTopLeft: [30, 30], paddingBottomRight: [panelPad, 30], duration: 1.1, maxZoom: 17 });
  } else if (reduced) map.setView([w.centroid.lat, w.centroid.lon], 16);
  else map.flyTo([w.centroid.lat, w.centroid.lon], 16, { duration: 1.1 });
}
function renderResults(resetPage = true) {
  if (resetPage) page = 0;
  const { works, places } = filtered();
  const inView = (lat, lon) => !map || map.getBounds().pad(-0.02).contains([lat, lon]);
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
  if (map) { const cb = panelMode && innerWidth > 760 ? [190, 0] : [0, 0]; if (reduced) map.setView([s.lat, s.lon], 16); else map.flyTo([s.lat, s.lon], 16, { duration: 1 }); if (cb[0]) setTimeout(() => map.panBy(cb, { animate: !reduced }), reduced ? 0 : 1050); }
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
    ${sourcesHtml(s)}`);
  update3DSelection();
}
async function selectWork(id, fly = true) {
  selected = id; detailTab = "overview"; drawMap();
  const w = SNAP.works.find((x) => x.id === id); if (!w) return;
  try { nearCache = (await api(`/api/works/${encodeURIComponent(id)}/nearby`)).services; } catch { nearCache = []; }
  renderDetail(w);
  if (fly) frameWork(w);
  update3DSelection();
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
      $("#lay-services").checked = true; if (map && !map.hasLayer(layers.services)) layers.services.addTo(map);
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
// ---------- AI chat ----------
function openChat() {
  openPanel("chat", `<h2>Ask about this area</h2>
    <p class="small">Answers use published Helsinki records from snapshot ${esc(SNAP.snapshotId)}. Published facts, citizen reports and possibilities are kept separate.</p>
    <div id="chat-log">${chatLog.map(chatMsgHtml).join("") || '<p class="small">Try: “What works are happening in this area?”</p>'}</div>
    <div id="chat-live"></div>`);
}
function chatMsgHtml(m) {
  if (m.role === "user") return `<div class="msg user">${esc(m.text)}</div>`;
  return `<div class="msg ai">${esc(m.text)}${m.cards?.length ? m.cards.map(cardHtml).join("") : ""}${m.draft ? draftHtml(m.draft) : ""}${m.sourceDate ? `<div class="src">Sources: Helsinki snapshot ${esc(m.sourceDate)} · retrieved ${esc(SNAP.retrievedAt || "")}</div>` : ""}</div>`;
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
  live.innerHTML = `<div class="progress">Sending to the Meta assistant…</div>`;
  let draft = null, cards = [], finalText = "", failed = false;
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
        if (ev.type === "progress") live.innerHTML += `<div class="progress">${esc(ev.step)} — ${esc(ev.result)}</div>`;
        else if (ev.type === "status") { finalText = ev.text; }
        else if (ev.type === "final") { finalText = ev.text; cards = ev.cards || []; draft = ev.draft; }
        else if (ev.type === "error") { failed = true; finalText = ev.text || "The request failed."; live.innerHTML += `<button class="btn" id="chat-retry">Retry</button>`; $("#chat-retry")?.addEventListener("click", () => sendChat(msg)); }
      }
    }
  } catch { failed = true; finalText = "The request could not be sent."; }
  if (finalText) chatLog.push({ role: "ai", text: finalText, cards, draft, sourceDate: failed ? null : SNAP.snapshotId });
  lastCards = cards;
  openChat();
  if (cards.length) highlightCards(cards);
  wireChatCards();
}
function highlightCards(cards) {
  for (const c of cards) {
    const layer = markers.get(c.id);
    if (layer && layer.setStyle) layer.setStyle({ color: "#e07b00", weight: 3.5, fillOpacity: 0.3 });
    else if (layer && layer.setIcon && c.lat != null) layer.setIcon(L.divIcon({ className: "", html: `<div class="place-marker" style="background:#e07b00">!</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }));
  }
  const first = cards.find((c) => c.lat != null);
  if (first && map) { if (reduced) map.setView([first.lat, first.lon], 16); else map.flyTo([first.lat, first.lon], 16, { duration: 1 }); }
}
function wireChatCards() {
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
// ---------- 3D ----------
async function setMode(is3d) {
  $("#mode-2d").setAttribute("aria-pressed", String(!is3d));
  $("#mode-3d").setAttribute("aria-pressed", String(is3d));
  $("#view3d").hidden = !is3d; if (map) $("#map").style.visibility = is3d ? "hidden" : "visible";
  if (!is3d || three3d) { if (three3d && is3d) three3d.render(); return; }
  try {
    const THREE = await import("three"); THREEref = THREE;
    const el = $("#view3d");
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe8edf0);
    const cam = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 1, 6000);
    const c0 = SNAP.demoArea.centre, kx = 111320 * Math.cos(c0.lat * Math.PI / 180), ky = 110540;
    const proj = (lon, lat) => [(lon - c0.lon) * kx, (lat - c0.lat) * ky];
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(el.clientWidth, el.clientHeight); el.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a97a3, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(300, 420, 200); scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), new THREE.MeshStandardMaterial({ color: 0xc7cfd6 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    const matRecorded = new THREE.MeshStandardMaterial({ color: 0x8d99a6, roughness: 0.85 });
    const matFallback = new THREE.MeshStandardMaterial({ color: 0xc3a06a, roughness: 0.9 });
    for (const b of SNAP.buildings.slice(0, 450)) {
      const ring0 = b.geometry?.type === "Polygon" ? b.geometry.coordinates[0] : b.geometry?.coordinates?.[0]?.[0];
      if (!ring0 || ring0.length < 4) continue;
      const shape = new THREE.Shape(ring0.map(([lon, lat]) => { const [x, y] = proj(lon, lat); return new THREE.Vector2(x, y); }));
      const recorded = b.heightSource === "recorded_floors";
      const height = recorded ? Math.max(3, Number(b.floors) * 3.1) : 9.3;
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); scene.add(new THREE.Mesh(geo, recorded ? matRecorded : matFallback));
    }
    let az = 0.7, pol = 0.9, rad = 720, drag = null;
    const place = () => { cam.position.set(rad * Math.sin(pol) * Math.cos(az), rad * Math.cos(pol), rad * Math.sin(pol) * Math.sin(az)); cam.lookAt(0, 0, 0); renderer.render(scene, cam); };
    el.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; });
    el.addEventListener("pointermove", (e) => { if (!drag) return; az -= (e.clientX - drag[0]) * 0.005; pol = Math.max(0.15, Math.min(1.4, pol - (e.clientY - drag[1]) * 0.005)); drag = [e.clientX, e.clientY]; place(); });
    el.addEventListener("pointerup", () => { drag = null; });
    addEventListener("resize", () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; cam.aspect = w / h; cam.updateProjectionMatrix(); renderer.setSize(w, h); place(); });
    three3d = { render: place, scene, proj };
    update3DSelection(); place();
    toast("3D: grey = height from recorded floors; tan = fallback estimate (3 floors). Geometry is simplified.");
  } catch { $("#view3d").innerHTML = "<p style='padding:14px'>3D could not load. The 2D map remains fully usable.</p>"; }
}
function update3DSelection() {
  if (!three3d || !THREEref) return;
  if (sel3d) { three3d.scene.remove(sel3d); sel3d = null; }
  const w = SNAP.works.find((x) => x.id === selected); if (!w) return;
  const ring0 = w.geometry?.type === "Polygon" ? w.geometry.coordinates[0] : w.geometry?.coordinates?.[0]?.[0];
  if (!ring0) return;
  const pts = ring0.map(([lon, lat]) => { const [x, y] = three3d.proj(lon, lat); return new THREEref.Vector3(x, 3, -y); });
  sel3d = new THREEref.Line(new THREEref.BufferGeometry().setFromPoints(pts), new THREEref.LineBasicMaterial({ color: 0xe07b00 }));
  three3d.scene.add(sel3d); three3d.render();
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
  $("#snap-date").textContent = SNAP.snapshotId;
  initMap(SNAP.demoArea.centre);
  await refresh();
  if (sessionStorage.getItem("welcomeDismissed")) $("#welcome").hidden = true;
}
$("#chat-bar").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#chat-input").value; $("#chat-input").value = ""; sendChat(v); });
document.querySelectorAll(".starter").forEach((b) => b.addEventListener("click", () => sendChat(b.textContent.trim())));
$("#welcome-close").addEventListener("click", () => { $("#welcome").hidden = true; sessionStorage.setItem("welcomeDismissed", "1"); });
$("#layers-btn").addEventListener("click", () => {
  const p = $("#layers-pop"); p.hidden = !p.hidden;
  $("#layers-btn").setAttribute("aria-expanded", String(!p.hidden));
  if (!p.hidden) drawMap();
});
$("#show-results").addEventListener("click", () => { $("#layers-pop").hidden = true; renderResults(); });
$("#close-panel").addEventListener("click", closePanel);
$("#search").addEventListener("input", () => { drawMap(); if (panelMode === "results") renderResults(); });
document.querySelectorAll(".barrier-filter").forEach((x) => x.addEventListener("click", () => {
  x.setAttribute("aria-pressed", String(x.getAttribute("aria-pressed") !== "true")); drawMap(); if (panelMode === "results") renderResults();
}));
$("#lay-works").addEventListener("change", (e) => { drawMap(); if (map) e.target.checked ? layers.works.addTo(map) : map.removeLayer(layers.works); });
$("#lay-services").addEventListener("change", (e) => { drawMap(); if (map) e.target.checked ? layers.services.addTo(map) : map.removeLayer(layers.services); });
$("#lay-buildings").addEventListener("change", (e) => { if (map) e.target.checked ? layers.buildings.addTo(map) : map.removeLayer(layers.buildings); });
$("#lay-routes").addEventListener("change", (e) => { if (map) e.target.checked ? layers.routes.addTo(map) : map.removeLayer(layers.routes); });
$("#mode-2d").addEventListener("click", () => setMode(false));
$("#mode-3d").addEventListener("click", () => setMode(true));
$("#demo-badge").addEventListener("click", () => {
  openPanel("details", `<h2>About this demonstrator</h2><p>Independent demonstrator using Helsinki open data. Not endorsed by the City of Helsinki.</p>
  <p class="small">Green route segments: source records realised accessibility. Dashed grey segments: recorded, but realised accessibility is unknown in the source. Building heights in 3D come from recorded floor counts where available; tan buildings use a fallback estimate.</p>
  ${sourcesHtml({ id: "snapshot:" + SNAP.snapshotId, source: { provider: "City of Helsinki GeoServer WFS + Service Map", layer: "multiple", url: "https://kartta.hel.fi" } })}`);
});
document.querySelectorAll("[data-persp]").forEach((b) => b.addEventListener("click", () => {
  perspective = b.dataset.persp;
  document.querySelectorAll("[data-persp]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  if (perspective === "city") renderReview();
  else toast(perspective === "business" ? "Business view: open a project and use the Evidence tab to record a business concern or alternative entrance." : "Resident view: ask a question below, or open a project to report an issue.");
}));
boot().catch(() => { openPanel("details", "<h2>Data unavailable</h2><p>The snapshot could not be loaded from the backend.</p>"); });
