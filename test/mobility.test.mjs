import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpServer } from "node:http";

// --- Mocked Digitransit + Meta endpoints (test doubles, NOT live calls) ---
function encodePolyline(points) {
  let out = "", plat = 0, plon = 0;
  const enc = (v) => { let s = ""; v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lon] of points) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    out += enc(la - plat) + enc(lo - plon); plat = la; plon = lo;
  }
  return out;
}
let lastQuery = "";
let digiMode = "ok"; // ok | denied
const geo = encodePolyline([[60.1695, 24.9385], [60.17, 24.94]]);
const mockDigi = httpServer(async (req, res) => {
  if (req.url.includes("/geocoding/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ features: [{ properties: { gid: "mock:1", label: "Kamppi, Helsinki", name: "Kamppi" }, geometry: { coordinates: [24.931, 60.169] } }] }));
  }
  let raw = ""; for await (const c of req) raw += c;
  const payload = JSON.parse(raw || "{}");
  lastQuery = payload.query || "";
  if (digiMode === "denied") { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "denied" })); }
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ data: { planConnection: { edges: [{ node: {
    start: "2026-11-04T09:00:00+02:00", end: "2026-11-04T09:20:00+02:00", duration: 1200, walkDistance: 320,
    legs: [
      { mode: "WALK", distance: 200, duration: 300, accessibilityScore: null,
        legGeometry: { length: 2, points: geo },
        from: { name: "Origin", lat: 60.1695, lon: 24.9385, stop: null },
        to: { name: "Kamppi", lat: 60.17, lon: 24.94, stop: { gtfsId: "HSL:1040129", wheelchairBoarding: "POSSIBLE" } },
        trip: null, route: null, start: { scheduledTime: "2026-11-04T09:00:00+02:00" }, end: { scheduledTime: "2026-11-04T09:05:00+02:00" }, alerts: [] },
      { mode: "BUS", distance: 2000, duration: 600, accessibilityScore: 0.9,
        legGeometry: { length: 2, points: geo },
        from: { name: "Kamppi", lat: 60.17, lon: 24.94, stop: { gtfsId: "HSL:1040129", wheelchairBoarding: "NO_INFORMATION" } },
        to: { name: "Destination", lat: 60.171, lon: 24.941, stop: { gtfsId: "HSL:1040130", wheelchairBoarding: "POSSIBLE" } },
        trip: { gtfsId: "HSL:trip1", wheelchairAccessible: "POSSIBLE" }, route: { shortName: "14", longName: "Kamppi" },
        start: { scheduledTime: "2026-11-04T09:06:00+02:00" }, end: { scheduledTime: "2026-11-04T09:16:00+02:00" },
        alerts: [{ alertHeaderText: "Mock alert", alertDescriptionText: "Mock disruption" }] },
    ],
  } }] } } }));
});
await new Promise((r) => mockDigi.listen(0, "127.0.0.1", r));
process.env.DIGITRANSIT_API_URL = `http://127.0.0.1:${mockDigi.address().port}/routing/v2/hsl/gtfs/v1`;
process.env.DIGITRANSIT_GEO_URL = `http://127.0.0.1:${mockDigi.address().port}/geocoding/v1`;
after(() => mockDigi?.close());

const mockMeta = httpServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const payload = JSON.parse(raw || "{}");
  const sys = payload.messages?.[0]?.content || "";
  res.writeHead(200, { "Content-Type": "application/json" });
  if (String(sys).includes("prepare barrier reports")) {
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "Mocked possible obstacle", category: "blocked-pavement",
      detail: "The image visibly shows a possible obstacle (mocked).", limitations: "Cannot certify accessibility or measurements." }) } }] }));
  }
  const hasToolResult = (payload.messages || []).some((m) => m.role === "tool");
  if (payload.tools && !hasToolResult) {
    return res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "j1", type: "function",
      function: { name: "plan_journey", arguments: JSON.stringify({ fromLat: 60.1695, fromLon: 24.9385, fromLabel: "Kamppi", toLat: 60.171, toLon: 24.941, toLabel: "Kluuvi", wheelchair: true }) } }] } }] }));
  }
  if (payload.tools && hasToolResult) {
    return res.end(JSON.stringify({ choices: [{ message: { content: "Mocked grounded journey answer based on the returned itinerary." } }] }));
  }
  return res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
});
await new Promise((r) => mockMeta.listen(0, "127.0.0.1", r));
process.env.META_API_URL = `http://127.0.0.1:${mockMeta.address().port}/v1/chat/completions`;
after(() => mockMeta?.close());

process.env.RUNTIME_FILE = join(mkdtempSync(join(tmpdir(), "dtw-mob-")), "runtime.json");
process.env.UPLOAD_DIR = join(mkdtempSync(join(tmpdir(), "dtw-mob-up-")), "uploads");
process.env.MODEL_API_KEY = "test-key-not-real";
process.env.REVIEWER_TOKEN = "test-reviewer-token";
process.env.DIGITRANSIT_API_KEY = "test-digi-key-not-real";
const { createAppServer, dedupeItineraries } = await import("../server.mjs");
let server, base;
const AUTH = { Authorization: "Bearer " + process.env.REVIEWER_TOKEN };
before(async () => {
  server = createAppServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const j = async (path, opts) => { const r = await fetch(base + path, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = (obj, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(obj) });
const HKI = { from: { lat: 60.1695, lon: 24.9385, label: "Kamppi" }, to: { lat: 60.171, lon: 24.941, label: "Kluuvi" } };

test("mobility status is configured with a backend key (mocked endpoint)", async () => {
  const { body } = await j("/api/mobility/status");
  assert.equal(body.status, "configured");
  assert.ok(!JSON.stringify(body).includes("test-digi-key-not-real"), "key must never be returned");
});

test("geocode merges snapshot places with mocked Digitransit results", async () => {
  const r = await j("/api/mobility/geocode?q=" + encodeURIComponent("kamppi"));
  assert.equal(r.status, 200);
  assert.ok(r.body.places.length >= 1);
  assert.ok(r.body.places.every((p) => p.source && p.lat), "every suggestion needs a source and coordinates");
});

test("accessible plan preserves unknowns, geometry, alerts and hard max-walk rule", async () => {
  const r = await j("/api/mobility/plan", post({ ...HKI, requirements: { stepFree: true, maxWalkM: 500 } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  assert.equal(r.body.source.provider, "Digitransit / HSL");
  assert.ok(r.body.retrievedAt, "retrieval time must be recorded for CC BY attribution");
  const itin = r.body.itineraries[0];
  assert.ok(itin.geometry.length >= 2, "real geometry points must be returned");
  assert.equal(itin.legs[0].accessibilityScore, null, "null score must stay null (unknown)");
  assert.equal(itin.legs[0].accessibility, "unknown");
  assert.equal(itin.legs[1].fromStop.wheelchairBoarding, "NO_INFORMATION");
  assert.equal(itin.legs[1].accessibility, "partial_information");
  assert.equal(itin.legs[1].line, "14");
  assert.equal(itin.legs[1].alerts[0].header, "Mock alert");
  assert.match(lastQuery, /wheelchair/, "wheelchair preference must reach Digitransit");
  assert.ok(Array.isArray(itin.nearbyWorks));
  assert.ok(itin.nearbyWorks.every((w) => w.note === "possible_context_not_proven_barrier"));
  assert.ok(!JSON.stringify(r.body).includes("test-digi-key-not-real"));

  const hard = await j("/api/mobility/plan", post({ ...HKI, requirements: { stepFree: true, maxWalkM: 100 } }));
  assert.equal(hard.body.status, "no_suitable_option", "hard max-walk must not be silently relaxed");
  assert.equal(hard.body.itineraries[0].suitable, false);
  assert.ok(hard.body.itineraries[0].unsuitabilityReasons.join(" ").includes("exceeds"));
});

test("a requested departure time reaches Digitransit and bounds the result", async () => {
  const r = await j("/api/mobility/plan", post({ ...HKI, requirements: { stepFree: true }, dateTime: "2026-11-04T10:00:00+02:00", arriveBy: false }));
  assert.equal(r.status, 200);
  assert.match(lastQuery, /earliestDeparture/, "depart-at must be sent as earliestDeparture");
  assert.match(lastQuery, /2026-11-04T10:00:00\+02:00/, "the requested Helsinki time must reach Digitransit unchanged");
  // The mocked upstream is time-blind, so the no-earlier-start bound itself
  // is verified live, not here.
});

test("invalid upstream credentials are distinguished, not shown as routes", async () => {
  digiMode = "denied";
  const r = await j("/api/mobility/plan", post({ ...HKI, requirements: { stepFree: true } }));
  digiMode = "ok";
  assert.equal(r.body.status, "digitransit_invalid_credentials");
  assert.equal(r.body.itineraries.length, 0);
});

test("plan validates coordinates", async () => {
  assert.equal((await j("/api/mobility/plan", post({ from: { lat: 1, lon: 1 }, to: HKI.to }))).status, 200);
  const bad = await j("/api/mobility/plan", post({ from: { lat: 1, lon: 1 }, to: HKI.to }));
  assert.equal(bad.body.status, "invalid_location");
  assert.equal((await j("/api/mobility/plan", post({}))).status, 400);
});

test("barrier report stays private until approved; own report reassesses as unverified", async () => {
  const draft = await j("/api/mobility/analyse-barrier", post({ description: "Scaffold blocks the pavement.", uploadId: null }));
  assert.equal(draft.body.status, "ok");
  assert.match(draft.body.draft.body, /possible obstacle/);
  const sub = await j("/api/submissions", post({ type: "report", category: "blocked-pavement",
    title: draft.body.draft.title, body: draft.body.draft.body, lat: 60.1696, lon: 24.9386 }));
  assert.equal(sub.status, 201);
  assert.ok(!(await j("/api/submissions")).body.some((s) => s.id === sub.body.id), "pending barrier must not be public");
  const queue = await j("/api/review-queue", { headers: AUTH });
  assert.ok(queue.body.some((s) => s.id === sub.body.id));
  // Reassess with own pending report: flagged as unverified, public status unchanged.
  const re = await j("/api/mobility/plan", post({ ...HKI, requirements: { stepFree: true }, ownBarrierSubmissionId: sub.body.id }));
  assert.ok(re.body.itineraries[0].ownBarrier, "own barrier context must be returned");
  assert.equal(re.body.itineraries[0].suitable, true, "unverified own report must not change public suitability");
  // After approval it becomes community-reported context.
  await j(`/api/submissions/${sub.body.id}/review`, post({ approve: true }, AUTH));
  const re2 = await j("/api/mobility/plan", post({ ...HKI, requirements: { stepFree: true } }));
  assert.ok(re2.body.itineraries[0].nearbyReports.some((x) => x.id === sub.body.id), "approved report must be considered on recheck");
});

test("chat plans a journey through the mocked Meta tool loop", async () => {
  const r = await fetch(base + "/api/chat", post({ message: "I use a wheelchair. Help me get from Kamppi to Kluuvi with step-free access." }));
  const text = await r.text();
  assert.match(text, /Checking transport options/);
  assert.match(text, /Mocked grounded journey answer/);
  assert.match(lastQuery, /wheelchair/);
  // The map needs the actual returned geometry, not only model prose.
  const final = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .find((e) => e && e.type === "final");
  assert.ok(final, "a final event is emitted");
  assert.ok(final.journey?.itineraries?.[0]?.geometry?.length >= 2, "final event carries the returned itinerary geometry for the map");
  assert.equal(final.journey.from.label, "Kamppi");
  assert.equal(final.journey.to.label, "Kluuvi");
  assert.ok((final.provenance || []).some((p) => p.type === "live" && /routing/i.test(p.service)),
    "provenance marks the journey as a live routing query, not the dated snapshot");
});

test("only true duplicate itineraries collapse; different departures stay", () => {
  const legs = [{ mode: "RAIL", line: "R", from: { name: "Helsinki" }, to: { name: "Pasila" }, distanceM: 3019, durationS: 240 }];
  const base = { start: "2026-11-04T10:06:00+02:00", end: "2026-11-04T10:10:00+02:00", walkDistanceM: 407, legs, geometry: [[60.17, 24.94], [60.19, 24.93]] };
  const dup = { ...base, id: "other-id" };
  const later = { ...base, start: "2026-11-04T10:08:00+02:00", end: "2026-11-04T10:12:00+02:00" };
  const otherLine = { ...base, legs: [{ ...legs[0], line: "P" }] };
  const out = dedupeItineraries([base, dup, later, otherLine]);
  assert.equal(out.length, 3, "exact duplicate removed, distinct departures and lines kept");
  assert.ok(out.includes(later) && out.includes(otherLine));
});

test("map tile route validates coordinates and never needs a frontend key", async () => {
  assert.equal((await fetch(base + "/api/map/99/0/0.png")).status, 400);
  // Provider tiles are native only to z19 (probed live); beyond that is invalid.
  assert.equal((await fetch(base + "/api/map/20/0/0.png")).status, 400);
  const ok = await fetch(base + "/api/map/16/37313/18958.png");
  // Mock upstream only handles routing/geocoding paths; tile fetch returns mocked JSON 200 or 404 upstream shape.
  assert.ok([200, 502].includes(ok.status));
});
