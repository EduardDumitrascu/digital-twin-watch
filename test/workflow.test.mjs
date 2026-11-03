import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RUNTIME_FILE = join(mkdtempSync(join(tmpdir(), "dtw-")), "runtime.json");
delete process.env.MODEL_API_KEY; delete process.env.META_API_KEY;
const { createAppServer, haversine } = await import("../server.mjs");
let server, base;
before(async () => {
  server = createAppServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (path, opts) => { const r = await fetch(base + path, opts); return { status: r.status, body: await r.json() }; };
const post = (obj) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

test("geospatial helpers are deterministic", () => {
  assert.equal(haversine(60.1695, 24.9385, 60.1695, 24.9385), 0);
  assert.ok(haversine(60.1695, 24.9385, 60.1795, 24.9385) > 1000);
});

test("snapshot carries provenance and bounded real records", async () => {
  const { body } = await j("/api/snapshot");
  assert.ok(body.works.length > 10 && body.services.length > 10 && body.buildings.length > 50);
  assert.ok(body.retrievedAt && body.snapshotId && body.licence === "CC BY 4.0");
  assert.ok(body.works[0].source.original, "original source values preserved");
  const near = await j(`/api/works/${encodeURIComponent(body.works[0].id)}/nearby`);
  assert.ok(near.body.services.length > 0 && near.body.services[0].distanceM >= 0);
  assert.ok(near.body.services.every((s, i, a) => i === 0 || a[i - 1].distanceM <= s.distanceM), "distances sorted");
});

test("AI without a key reports Not configured and produces no findings", async () => {
  const snap = (await j("/api/snapshot")).body;
  const workId = snap.works[0].id;
  const r = await j(`/api/cases/${encodeURIComponent(workId)}/verify`, post({}));
  assert.equal(r.body.analysis.status, "not_configured");
  assert.deepEqual(r.body.findings.filter((f) => f.id), r.body.findings); // only pre-existing, none fabricated
  const ai = await j("/api/ai/status");
  assert.equal(ai.body.status, "not_configured");
});

test("full workflow: submit -> review -> action -> human-confirmed closure; contact stays private", async () => {
  const snap = (await j("/api/snapshot")).body;
  const workId = snap.works[1].id;
  const sub = await j("/api/submissions", post({ workId, type: "report", category: "blocked-pavement",
    title: "Pavement blocked", body: "Observed today: pavement fully blocked at the work fence.", contact: "private@example.com" }));
  assert.equal(sub.status, 201);
  assert.equal(sub.body.contact, undefined, "contact must never be returned");
  let pubs = (await j("/api/submissions")).body;
  assert.ok(!pubs.some((s) => s.id === sub.body.id), "pending report must not be public");
  const queue = (await j("/api/review-queue")).body;
  assert.ok(queue.some((s) => s.id === sub.body.id));
  assert.ok(!JSON.stringify(queue).includes("private@example.com"), "contact must not leak in review queue");
  await j(`/api/submissions/${sub.body.id}/review`, post({ approve: true }));
  pubs = (await j("/api/submissions")).body;
  assert.ok(pubs.some((s) => s.id === sub.body.id), "approved report becomes public");
  const badClose = await j(`/api/cases/${encodeURIComponent(workId)}/close`, post({}));
  assert.equal(badClose.status, 400, "closure without human confirmation must fail");
  const act = await j(`/api/cases/${encodeURIComponent(workId)}/actions`, post({ title: "Install temporary ramp", owner: "Site team" }));
  assert.equal(act.status, 201);
  const closed = await j(`/api/cases/${encodeURIComponent(workId)}/close`, post({ confirm: true }));
  assert.equal(closed.body.status, "closed");
});
