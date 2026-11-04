import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpServer } from "node:http";

// --- Mocked Meta endpoint (automated test double, NOT a live Meta call) ---
// Started at module level so META_API_URL is set before the app imports it.
const mockMeta = httpServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const payload = JSON.parse(raw || "{}");
    const msgs = payload.messages || [];
    const sys = msgs[0]?.content || "";
    const hasToolResult = msgs.some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "application/json" });
    if (String(sys).includes("verification agent")) {
      const last = msgs.at(-1)?.content;
      const text = typeof last === "string" ? last : (last?.[0]?.text || "");
      const workId = text.match(/"sourceId":"([^"]+)"/)?.[1] || "unknown";
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: "Mocked summary for automated tests.",
        findings: [{ type: "observation", title: "Mock finding", detail: "From mocked Meta.", sourceRefs: [workId, "bogus:ref:999"] }],
      }) } }] }));
    }
    if (payload.tools && !hasToolResult) {
      return res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "c1", type: "function",
        function: { name: "search_works_and_places", arguments: JSON.stringify({ query: "Simonkatu" }) } }] } }] }));
    }
    return res.end(JSON.stringify({ choices: [{ message: { content: "Mocked grounded answer based on retrieved records." } }] }));
  });
await new Promise((r) => mockMeta.listen(0, "127.0.0.1", r));
process.env.META_API_URL = `http://127.0.0.1:${mockMeta.address().port}/v1/chat/completions`;
after(() => mockMeta?.close());

process.env.RUNTIME_FILE = join(mkdtempSync(join(tmpdir(), "dtw-")), "runtime.json");
process.env.UPLOAD_DIR = join(mkdtempSync(join(tmpdir(), "dtw-up-")), "uploads");
process.env.MODEL_API_KEY = "test-key-not-real";
process.env.REVIEWER_TOKEN = "test-reviewer-token";
const { createAppServer, haversine } = await import("../server.mjs");
let server, base;
const AUTH = { Authorization: "Bearer test-reviewer-token" };
before(async () => {
  server = createAppServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (path, opts) => { const r = await fetch(base + path, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = (obj, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(obj) });

test("basemap is the authenticated HSL map served through the backend, not the blocked OSM tile server", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const srv = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(!js.includes("tile.openstreetmap.org"), "blocked OSM raster endpoint must not be used");
  assert.ok(!js.includes("basemaps.cartocdn.com"), "key-gated CARTO endpoint must not be used");
  assert.ok(!js.includes("cdn.digitransit.fi"), "frontend must never call Digitransit tiles directly with a key");
  assert.ok(js.includes("/api/map/{z}/{x}/{y}.png"), "frontend must load HSL tiles through the validated backend route");
  assert.ok(srv.includes("hsl-map-en"), "backend must use the English HSL basemap");
  assert.ok(srv.includes("digitransit-subscription-key"), "backend must authenticate upstream with the subscription header");
  assert.ok(html.includes("maplibre-gl"), "MapLibre GL must render the basemap");
  assert.ok(js.includes("tile-note"), "provider failure message element must be wired");
});

test("geospatial helpers are deterministic", () => {
  assert.equal(haversine(60.1695, 24.9385, 60.1695, 24.9385), 0);
  assert.ok(haversine(60.1695, 24.9385, 60.1795, 24.9385) > 1000);
});

test("snapshot: classification, accessibility and height provenance", async () => {
  const { body } = await j("/api/snapshot");
  assert.ok(body.works.length > 10 && body.services.length > 10);
  assert.ok(body.services.some((s) => s.category === "business") && body.services.some((s) => s.category === "public_service"));
  assert.ok(body.services.every((s) => typeof s.accessibilityKnown === "boolean"));
  assert.ok(body.buildings.every((b) => ["recorded_floors", "fallback_estimate"].includes(b.heightSource)));
  assert.ok(body.accessibilityRoutes.every((r) => "realisedAccessibility" in r));
});

test("reviewer endpoints reject unauthorised requests", async () => {
  const snap = (await j("/api/snapshot")).body;
  const workId = snap.works[0].id;
  assert.equal((await j("/api/review-queue")).status, 401);
  assert.equal((await j(`/api/cases/${encodeURIComponent(workId)}/actions`, post({ title: "x" }))).status, 401);
  assert.equal((await j(`/api/cases/${encodeURIComponent(workId)}/verify`, post({}))).status, 401);
  assert.equal((await j(`/api/cases/${encodeURIComponent(workId)}/close`, post({ confirm: true }))).status, 401);
});

test("SSRF guard rejects private and non-HTTPS document URLs", async () => {
  const snap = (await j("/api/snapshot")).body;
  const bad1 = await j("/api/submissions", post({ workId: snap.works[0].id, title: "t", body: "b", documentUrl: "https://127.0.0.1:9/x" }));
  assert.equal(bad1.status, 400); assert.match(bad1.body.error, /document_url_rejected/);
  const bad2 = await j("/api/submissions", post({ workId: snap.works[0].id, title: "t", body: "b", documentUrl: "http://example.com/x" }));
  assert.equal(bad2.status, 400);
});

test("real upload reaches private storage and the mocked analysis path; pending stays private", async () => {
  const snap = (await j("/api/snapshot")).body;
  const workId = snap.works[0].id;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");
  const boundary = "----dtwtest";
  const mp = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="barrier.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const upRes = await fetch(base + "/api/uploads", { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: mp });
  const up = await upRes.json();
  assert.equal(upRes.status, 201); assert.equal(up.mime, "image/png");
  assert.equal((await j(`/api/uploads/${up.id}`)).status, 401, "upload retrieval requires reviewer auth");
  assert.equal((await fetch(base + `/api/uploads/${up.id}`, { headers: AUTH })).status, 200);
  const txtRes = await fetch(base + "/api/uploads", { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\n`), Buffer.from("hi"), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
  assert.equal(txtRes.status, 415);
  const sub = await j("/api/submissions", post({ workId, type: "evidence", category: "blocked-pavement",
    title: "Blocked pavement (photo)", body: "Photo evidence of a blocked pavement.", uploadId: up.id, contact: "private@example.com" }));
  assert.equal(sub.status, 201);
  assert.ok(!(await j("/api/submissions")).body.some((s) => s.id === sub.body.id), "pending must not be public");
  const queue = await j("/api/review-queue", { headers: AUTH });
  assert.ok(queue.body.some((s) => s.id === sub.body.id));
  assert.ok(!JSON.stringify(queue.body).includes("private@example.com"));
  await j(`/api/submissions/${sub.body.id}/review`, post({ approve: true }, AUTH));
  assert.ok((await j("/api/submissions")).body.some((s) => s.id === sub.body.id));
  // Mocked Meta analysis: versioned, references validated, duplicate hash reused.
  const v1 = await j(`/api/cases/${encodeURIComponent(workId)}/verify`, post({}, AUTH));
  assert.equal(v1.status, 200);
  assert.equal(v1.body.versions.length, 1);
  assert.ok(v1.body.findings.every((f) => !f.sourceRefs.includes("bogus:ref:999")), "invalid source refs must be dropped");
  const v2 = await j(`/api/cases/${encodeURIComponent(workId)}/verify`, post({}, AUTH));
  assert.equal(v2.body.duplicate, true);
  assert.equal(v2.body.versions.length, 1, "unchanged inputs must not create a new version");
});

test("chat uses allowlisted tools against mocked Meta and returns cards", async () => {
  const r = await fetch(base + "/api/chat", post({ message: "What works are happening on Simonkatu?" }));
  const text = await r.text();
  assert.match(text, /"type":"final"/);
  assert.match(text, /Mocked grounded answer/);
  assert.match(text, /Searching records/);
});

test("reviewer workflow: action and human-confirmed closure with auth", async () => {
  const snap = (await j("/api/snapshot")).body;
  const workId = snap.works[1].id;
  assert.equal((await j(`/api/cases/${encodeURIComponent(workId)}/close`, post({ confirm: true }, AUTH))).status, 200);
  const act = await j(`/api/cases/${encodeURIComponent(workId)}/actions`, post({ title: "Install temporary ramp", owner: "Site team" }, AUTH));
  assert.equal(act.status, 201);
});
