import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Map-visual helpers ship in public/app.js between [map-visuals] markers:
// building colours encode only the use recorded in the source register,
// and simulated traffic positions are computed by distance along a line.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = src.slice(src.indexOf("// [map-visuals]"), src.indexOf("// [/map-visuals]"));
assert.ok(slice.includes("function buildingUse"), "helpers are present in the shipped file");
const { buildingUse, trafficCum, trafficPointAt, buildTraffic, trafficPositions } =
  new Function(`${slice}; return { buildingUse, trafficCum, trafficPointAt, buildTraffic, trafficPositions };`)();

test("building colours encode the recorded source use", () => {
  const b = (tyyppi) => ({ source: { original: { tyyppi } } });
  assert.equal(buildingUse(b("Asuinrakennus")), "residential");
  assert.equal(buildingUse(b("Asuin- ja liikerakennus")), "residential");
  assert.equal(buildingUse(b("Liikerakennus")), "commercial");
  assert.equal(buildingUse(b("Toimistorakennus")), "commercial");
  assert.equal(buildingUse(b("Asemarakennus")), "public");
  assert.equal(buildingUse(b("Opetusrakennus")), "public");
  assert.equal(buildingUse(b("Varastorakennus")), "industrial");
  assert.equal(buildingUse(b("Muu rakennus")), "other");
  assert.equal(buildingUse({}), "other", "no recorded use stays other, never invented");
  assert.equal(buildingUse(null), "other");
});

test("simulated traffic moves by distance along the line and wraps", () => {
  // ~111 m north, then ~56 m east near Helsinki.
  const coords = [[24.94, 60.17], [24.94, 60.171], [24.941, 60.171]];
  const cum = trafficCum(coords);
  assert.ok(cum[1] > 100 && cum[1] < 125, `first leg ~111 m, got ${cum[1]}`);
  assert.deepEqual(trafficPointAt(coords, cum, 0), coords[0]);
  const mid = trafficPointAt(coords, cum, cum[1] / 2);
  assert.ok(Math.abs(mid[1] - 60.1705) < 1e-6, "half the metres, not half the points");
  const wrapped = trafficPointAt(coords, cum, cum[2] + 5);
  const at5 = trafficPointAt(coords, cum, 5);
  assert.ok(Math.abs(wrapped[0] - at5[0]) < 1e-9 && Math.abs(wrapped[1] - at5[1]) < 1e-9, "distance wraps along the line");
});

test("demo traffic is built only from returned lines and moves over time", () => {
  const lines = [
    [[24.94, 60.17], [24.94, 60.172]],           // ~222 m
    [[24.95, 60.17], [24.95, 60.1705]],          // ~56 m
    [[24.96, 60.17]],                            // not a line
    [[24.97, 60.17], [24.97, 60.1701]],          // too short, dropped
  ];
  const traffic = buildTraffic(lines);
  assert.equal(traffic.paths.length, 2, "only usable returned lines become paths");
  assert.ok(traffic.vehicles.length >= 3, "longer paths carry two simulated dots");
  const at0 = trafficPositions(traffic, 0);
  const at10 = trafficPositions(traffic, 10);
  assert.equal(at0.length, traffic.vehicles.length);
  assert.notDeepEqual(at10, at0, "positions advance with elapsed time (simulated motion)");
  for (const p of [...at0, ...at10]) {
    assert.ok(p[0] >= 24.94 && p[0] <= 24.95 && p[1] >= 60.17 && p[1] <= 60.172, "dots stay on their line bounds");
  }
});
