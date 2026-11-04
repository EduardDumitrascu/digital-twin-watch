import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Map-visual helpers ship in public/app.js between [map-visuals] markers:
// building colours encode only the use recorded in the source register,
// and simulated traffic runs only on real carriageway geometry from the
// snapshot (OpenStreetMap roads), never on accessibility/pedestrian lines.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = src.slice(src.indexOf("// [map-visuals]"), src.indexOf("// [/map-visuals]"));
assert.ok(slice.includes("function buildingUse"), "helpers are present in the shipped file");
const { buildingUse, trafficCum, trafficPointAt, buildTraffic, trafficPositions, flowClass } =
  new Function(`${slice}; return { buildingUse, trafficCum, trafficPointAt, buildTraffic, trafficPositions, flowClass };`)();

test("building colours encode the recorded source use", () => {
  const b = (tyyppi) => ({ source: { original: { tyyppi } } });
  assert.equal(buildingUse(b("Asuinrakennus")), "residential");
  assert.equal(buildingUse(b("Asuin- ja liikerakennus")), "residential");
  assert.equal(buildingUse(b("Liikerakennus")), "commercial");
  assert.equal(buildingUse(b("Toimistorakennus")), "commercial");
  assert.equal(buildingUse(b("Asemarakennus")), "public");
  assert.equal(buildingUse(b("Opetusrakennus")), "public");
  assert.equal(buildingUse(b("Varastorakennus")), "industrial");
  assert.equal(buildingUse(b("Muu rakennus")), "other", "unmapped recorded use stays neutral other");
  assert.equal(buildingUse({}), "other", "no recorded use stays neutral, never invented");
  assert.equal(buildingUse(null), "other");
});

const road = (id, highway, coords, oneway = false) => ({ id, highway, oneway, geometry: { type: "LineString", coordinates: coords } });
// ~222 m north-south carriageway segments near Helsinki.
const line = (lon) => [[lon, 60.17], [lon, 60.172]];

test("simulated flow classes are deterministic and cover fast, moderate and slow", () => {
  assert.equal(flowClass("osm:way/4236349"), flowClass("osm:way/4236349"), "same road, same class on every load");
  const classes = new Set(Array.from({ length: 60 }, (_, i) => flowClass(`osm:way/${1000 + i}`)));
  assert.deepEqual([...classes].sort(), ["fast", "moderate", "slow"], "all three simulated states occur");
});

test("traffic and journey layers are drawn under the buildings, never over them", () => {
  // Layer order in the shipped map setup is the draw order: ground-level
  // movement (simulated traffic and the journey route itself) must be
  // occluded by buildings and objects, like a real street passing behind
  // them, and never painted over rooftops.
  const trafficLines = src.indexOf('id: "traffic-lines"');
  const trafficPulses = src.indexOf('id: "traffic-pulses"');
  const buildings = src.indexOf('id: "buildings-fill"');
  const journey = src.indexOf('id: "journey-line"');
  assert.ok(trafficLines > -1 && trafficPulses > -1 && buildings > -1 && journey > -1);
  assert.ok(trafficLines < buildings && trafficPulses < buildings, "traffic renders below building extrusions");
  assert.ok(journey < buildings, "the journey route renders below building extrusions, not over rooftops");
});

test("demo traffic uses only carriageway roads, never pedestrian or accessibility lines", () => {
  const roads = [
    road("osm:way/1", "residential", line(24.94)),
    road("osm:way/2", "primary", line(24.95)),
    road("osm:way/3", "footway", line(24.96)),
    road("osm:way/4", "path", line(24.97)),
    road("osm:way/5", "pedestrian", line(24.98)),
    road("osm:way/6", "cycleway", line(24.99)),
    road("osm:way/7", "secondary", [[24.93, 60.17]]), // not a line
  ];
  const traffic = buildTraffic(roads);
  assert.equal(traffic.paths.length, 2, "only carriageway LineStrings become traffic paths");
  assert.ok(traffic.vehicles.length >= 2);
  assert.ok(traffic.vehicles.every((v) => ["fast", "moderate", "slow"].includes(v.flow)), "every pulse carries its simulated flow class");
});

test("pulses move by distance along the road, faster on fast segments", () => {
  const coords = [[24.94, 60.17], [24.94, 60.171], [24.941, 60.171]];
  const cum = trafficCum(coords);
  assert.deepEqual(trafficPointAt(coords, cum, 0), coords[0]);
  const mid = trafficPointAt(coords, cum, cum[1] / 2);
  assert.ok(Math.abs(mid[1] - 60.1705) < 1e-6, "half the metres, not half the points");
  // ~1.1 km roads: no pulse wraps within the measured 10 s window.
  const roads = Array.from({ length: 60 }, (_, i) => road(`osm:way/${2000 + i}`, "tertiary", [[24.90 + i * 0.001, 60.17], [24.90 + i * 0.001, 60.18]]));
  const traffic = buildTraffic(roads);
  const at0 = trafficPositions(traffic, 0);
  const at10 = trafficPositions(traffic, 10);
  assert.equal(at0.length, traffic.vehicles.length);
  const moved = traffic.vehicles.map((v, i) => {
    const a = at0[i].point, b = at10[i].point;
    return { flow: v.flow, d: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  const avg = (f) => { const m = moved.filter((x) => x.flow === f); return m.reduce((s, x) => s + x.d, 0) / m.length; };
  assert.ok(avg("fast") > avg("moderate") && avg("moderate") > avg("slow"),
    "simulated pulse speed follows its class: fast > moderate > slow");
  for (const p of [...at0, ...at10]) {
    assert.ok(p.point[1] >= 60.17 && p.point[1] <= 60.18, "pulses stay on their road line");
  }
});
