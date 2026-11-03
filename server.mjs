// Digital Twin Watch — Helsinki Demonstrator backend (zero dependencies).
// Secrets are read only from environment variables and never logged or sent
// to the frontend. Without a Meta key, AI endpoints report "not_configured"
// and never fabricate findings.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const META_KEY = process.env.MODEL_API_KEY || process.env.META_API_KEY || "";
const META_MODEL = process.env.META_MODEL || "muse-spark-1.2";
const META_URL = process.env.META_API_URL || "https://api.meta.ai/v1/chat/completions";
const MAX_BODY = 2_000_000;

// ---------- snapshot (dated, cached; never described as live) ----------
const snapFile = (await import("node:fs")).readdirSync(join(ROOT, "data"))
  .filter((f) => f.startsWith("snapshot-")).sort().at(-1);
const SNAP = JSON.parse(readFileSync(join(ROOT, "data", snapFile), "utf8"));

// ---------- deterministic geospatial helpers ----------
const R = Math.PI / 180;
export function haversine(lat1, lon1, lat2, lon2) {
  const h = Math.sin((lat2 - lat1) * R / 2) ** 2
    + Math.cos(lat1 * R) * Math.cos(lat2 * R) * Math.sin((lon2 - lon1) * R / 2) ** 2;
  return Math.round(12742000 * Math.asin(Math.sqrt(h)));
}
function rings(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
}
export function distanceToWorkM(work, lat, lon) {
  let best = haversine(work.centroid.lat, work.centroid.lon, lat, lon);
  const kx = 111320 * Math.cos(lat * R), ky = 110540;
  const px = (lon - work.centroid.lon) * kx, py = (lat - work.centroid.lat) * ky;
  for (const ring of rings(work.geometry)) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = (ring[i][0] - work.centroid.lon) * kx, ay = (ring[i][1] - work.centroid.lat) * ky;
      const bx = (ring[i + 1][0] - work.centroid.lon) * kx, by = (ring[i + 1][1] - work.centroid.lat) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      best = Math.min(best, Math.round(Math.hypot(px - (ax + t * dx), py - (ay + t * dy))));
    }
  }
  return best;
}
function nearestServices(work, limit = 10) {
  return SNAP.services
    .map((s) => ({ id: s.id, name: s.name, address: s.address, distanceM: distanceToWorkM(work, s.lat, s.lon),
                   accessibilityViewpoints: s.accessibilityViewpoints }))
    .sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
}

// ---------- persistent runtime store ----------
const DATA_DIR = join(ROOT, "data");
const RUNTIME = process.env.RUNTIME_FILE || join(DATA_DIR, "runtime.json");
function loadStore() {
  if (existsSync(RUNTIME)) return JSON.parse(readFileSync(RUNTIME, "utf8"));
  return { submissions: [], cases: {}, seeded: false };
}
const store = loadStore();
function save() { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(RUNTIME, JSON.stringify(store, null, 1)); }
function getCase(workId) {
  if (!store.cases[workId]) store.cases[workId] = {
    workId, status: "open", findings: [], actions: [],
    analysis: { status: META_KEY ? "idle" : "not_configured", hash: null, updatedAt: null, model: null, toolActivity: [] },
    history: [{ at: new Date().toISOString(), event: "Case opened" }],
  };
  return store.cases[workId];
}
// Demo scenario: one staged submission on a real work record, clearly labelled.
if (!store.seeded && SNAP.works.length) {
  const work = SNAP.works.find((w) => w.kind === "Excavation notice") || SNAP.works[0];
  store.submissions.push({
    id: randomUUID(), type: "evidence", workId: work.id, demo: true,
    title: "Demo scenario: staged photo note (not a real observation)",
    body: "Demo scenario evidence, staged for the demonstrator walkthrough. It makes no factual claim about this real project.",
    category: "other", lat: work.centroid.lat, lon: work.centroid.lon,
    reviewStatus: "approved", createdAt: new Date().toISOString(), fileName: null,
  });
  getCase(work.id).history.push({ at: new Date().toISOString(), event: "Demo scenario evidence attached (labelled, staged)" });
  store.seeded = true; save();
}

const pub = (s) => { const { contact, ...rest } = s; return rest; }; // contact stays private

// ---------- Meta AI verification (backend only) ----------
async function callMeta(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(META_URL, {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${META_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: META_MODEL, temperature: 0.2,
        messages: [{ role: "system", content: "You are a verification agent. Return only JSON." },
                   { role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Meta API HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } finally { clearTimeout(timer); }
}
async function verifyCase(workId) {
  const work = SNAP.works.find((w) => w.id === workId);
  if (!work) return { error: "work_not_found", status: 404 };
  const c = getCase(workId);
  if (!META_KEY) {
    c.analysis = { ...c.analysis, status: "not_configured", updatedAt: new Date().toISOString(), model: null,
      toolActivity: [{ step: "Configuration check", result: "No Meta API key configured on the server. No analysis was run and no findings were produced." }] };
    save();
    return { analysis: c.analysis, findings: c.findings, status: 200 };
  }
  const evidence = store.submissions.filter((s) => s.workId === workId && s.reviewStatus !== "rejected");
  const hash = createHash("sha256").update(JSON.stringify({
    w: [work.status, work.starts, work.ends], e: evidence.map((e) => [e.id, e.body]),
    f: c.findings.length, a: c.actions.length })).digest("hex").slice(0, 16);
  if (c.analysis.hash === hash && c.analysis.status === "complete") {
    return { analysis: c.analysis, findings: c.findings, duplicate: true, status: 200 };
  }
  const near = nearestServices(work);
  const activity = [
    { step: "Retrieved source record", result: `${work.kind} ${work.applicationId || work.id} from ${work.source.provider}` },
    { step: "Computed deterministic distances", result: `${near.length} nearby services measured in metres (server-side geometry, not model output)` },
    { step: "Retrieved case evidence", result: `${evidence.length} submission(s) attached to this case` },
  ];
  const trunc = (t, n = 1200) => String(t || "").slice(0, n);
  const prompt = [
    "Compare the published permit record below with the attached evidence.",
    "Rules: nearby does not mean affected; a photograph/note does not prove whole-project completion or wrongdoing;",
    "if contracts, budgets or progress reports are absent, say evidence is missing; never infer completion percentages.",
    'Return JSON only: {"summary":"plain English summary","findings":[{"type":"discrepancy|missing_evidence|observation","title":"...","detail":"...","sourceRefs":["..."]}]}',
    "WORK:", JSON.stringify({ kind: work.kind, status: work.status, address: work.address,
      starts: work.starts, ends: work.ends, purposeOriginal: trunc(work.title), sourceId: work.id }),
    "NEARBY SERVICES (deterministic distances in metres):", JSON.stringify(near),
    "EVIDENCE:", JSON.stringify(evidence.map((e) => ({ type: e.type, category: e.category,
      title: trunc(e.title, 200), body: trunc(e.body), demo: !!e.demo, at: e.createdAt }))),
    "Contracts/budgets/progress reports: Not available in the source data.",
  ].join("\n");
  c.analysis = { status: "running", hash, updatedAt: new Date().toISOString(), model: META_MODEL, toolActivity: activity };
  save();
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callMeta(prompt.slice(0, 12000));
      activity.push({ step: `Meta model call (attempt ${attempt})`, result: `Model ${META_MODEL} responded` });
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      c.findings = (parsed.findings || []).slice(0, 12).map((f) => ({
        id: randomUUID(), type: f.type || "observation", title: String(f.title || "Finding").slice(0, 200),
        detail: String(f.detail || "").slice(0, 1200), sourceRefs: f.sourceRefs || [], at: new Date().toISOString() }));
      c.analysis = { status: "complete", hash, updatedAt: new Date().toISOString(), model: META_MODEL,
        summary: String(parsed.summary || "").slice(0, 1500), toolActivity: activity };
      c.history.push({ at: new Date().toISOString(), event: `Meta verification completed (${c.findings.length} findings)` });
      save();
      return { analysis: c.analysis, findings: c.findings, status: 200 };
    } catch (e) { lastErr = e; activity.push({ step: `Meta model call (attempt ${attempt})`, result: `Failed: ${String(e.message || e).slice(0, 120)}` }); }
  }
  c.analysis = { status: "failed", hash, updatedAt: new Date().toISOString(), model: META_MODEL,
    toolActivity: activity, error: "Meta request failed after retry. No findings were produced." };
  save();
  return { analysis: c.analysis, findings: c.findings, status: 502 };
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
function send(res, code, obj, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const ch of req) { size += ch.length; if (size > MAX_BODY) throw new Error("too_large"); chunks.push(ch); }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
const needStr = (v, max = 2000) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;
    try {
      if (p === "/api/health") return send(res, 200, { ok: true, snapshot: SNAP.snapshotId, ai: META_KEY ? "configured" : "not_configured" });
      if (p === "/api/snapshot") return send(res, 200, { ...SNAP, buildings: SNAP.buildings });
      if (p === "/api/ai/status") return send(res, 200, { status: META_KEY ? "configured" : "not_configured", model: META_KEY ? META_MODEL : null });
      if (p === "/api/submissions" && req.method === "GET")
        return send(res, 200, store.submissions.filter((s) => s.reviewStatus === "approved").map(pub));
      if (p === "/api/review-queue" && req.method === "GET")
        return send(res, 200, store.submissions.filter((s) => s.reviewStatus === "pending").map(pub));
      if (p === "/api/cases" && req.method === "GET")
        return send(res, 200, Object.values(store.cases));
      if (p === "/api/submissions" && req.method === "POST") {
        const b = await body(req);
        if (!needStr(b.title, 200) || !needStr(b.body) || !SNAP.works.some((w) => w.id === b.workId))
          return send(res, 400, { error: "title, body and a valid workId are required" });
        const s = { id: randomUUID(), type: ["report", "evidence", "business"].includes(b.type) ? b.type : "report",
          workId: b.workId, demo: false, title: b.title.trim(), body: b.body.trim(),
          category: String(b.category || "other").slice(0, 40),
          lat: Number.isFinite(+b.lat) ? +b.lat : null, lon: Number.isFinite(+b.lon) ? +b.lon : null,
          contact: b.contact ? String(b.contact).slice(0, 120) : null, // stored, never returned
          documentUrl: b.documentUrl ? String(b.documentUrl).slice(0, 500) : null,
          fileName: b.fileName ? String(b.fileName).slice(0, 120) : null,
          reviewStatus: "pending", createdAt: new Date().toISOString() };
        store.submissions.push(s);
        getCase(b.workId).history.push({ at: s.createdAt, event: `New ${s.type} submitted (pending review)` });
        save();
        return send(res, 201, pub(s));
      }
      const nearW = p.match(/^\/api\/works\/([^/]+)\/nearby$/);
      if (nearW && req.method === "GET") {
        const w = SNAP.works.find((x) => x.id === decodeURIComponent(nearW[1]));
        if (!w) return send(res, 404, { error: "work_not_found" });
        return send(res, 200, { services: nearestServices(w) });
      }
      const nearS = p.match(/^\/api\/services\/([^/]+)\/nearby-works$/);
      if (nearS && req.method === "GET") {
        const s = SNAP.services.find((x) => x.id === decodeURIComponent(nearS[1]));
        if (!s) return send(res, 404, { error: "service_not_found" });
        const works = SNAP.works.map((w) => ({ id: w.id, kind: w.kind, distanceM: distanceToWorkM(w, s.lat, s.lon) }))
          .sort((a, b) => a.distanceM - b.distanceM).slice(0, 8);
        return send(res, 200, { works });
      }
      const review = p.match(/^\/api\/submissions\/([\w-]+)\/review$/);
      if (review && req.method === "POST") {
        const b = await body(req);
        const s = store.submissions.find((x) => x.id === review[1]);
        if (!s) return send(res, 404, { error: "not_found" });
        s.reviewStatus = b.approve ? "approved" : "rejected";
        getCase(s.workId).history.push({ at: new Date().toISOString(), event: `Submission ${s.reviewStatus} after review` });
        save();
        return send(res, 200, pub(s));
      }
      const act = p.match(/^\/api\/cases\/([^/]+)\/(verify|actions|close)$/);
      if (act && req.method === "POST") {
        const workId = decodeURIComponent(act[1]);
        if (!SNAP.works.some((w) => w.id === workId)) return send(res, 404, { error: "work_not_found" });
        const c = getCase(workId);
        if (act[2] === "verify") { const r = await verifyCase(workId); return send(res, r.status, r); }
        if (act[2] === "actions") {
          const b = await body(req);
          if (!needStr(b.title, 200)) return send(res, 400, { error: "action title required" });
          const a = { id: randomUUID(), title: b.title.trim(), owner: String(b.owner || "Unassigned").slice(0, 80),
            status: "open", at: new Date().toISOString() };
          c.actions.push(a); c.status = "in_progress";
          c.history.push({ at: a.at, event: `Action recorded: ${a.title}` });
          save();
          return send(res, 201, a);
        }
        // close: human-confirmed only
        const b = await body(req);
        if (b.confirm !== true) return send(res, 400, { error: "Human confirmation (confirm:true) is required to close a case" });
        c.status = "closed";
        c.history.push({ at: new Date().toISOString(), event: "Resolution confirmed by a human reviewer" });
        save();
        return send(res, 200, c);
      }
      if (p.startsWith("/api/")) return send(res, 404, { error: "not_found" });
      const file = p === "/" ? "/index.html" : p;
      const full = join(ROOT, "public", file);
      if (!full.startsWith(join(ROOT, "public")) || !existsSync(full)) return send(res, 404, "Not found", "text/plain");
      return send(res, 200, readFileSync(full, "utf8"), MIME[extname(full)] || "text/plain");
    } catch (e) {
      return send(res, e.message === "too_large" ? 413 : 500, { error: "request_failed" });
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createAppServer().listen(PORT, () => console.log(`Digital Twin Watch listening on http://localhost:${PORT} (AI: ${META_KEY ? META_MODEL : "not configured"})`));
}
