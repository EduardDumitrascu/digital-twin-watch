import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The journey-preview geometry helpers ship in public/app.js between
// [journey-preview] markers. Progress must run by travelled distance along
// the returned geometry (never by point count), bearings must turn along
// the shortest arc, and long legs must be compressed for a short preview.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = src.slice(src.indexOf("// [journey-preview]"), src.indexOf("// [/journey-preview]"));
assert.ok(slice.includes("function pvPointAt"), "helpers are present in the shipped file");
const { pvDistM, pvBearingDeg, pvSegLens, pvPointAt, pvAngleLerp, pvStepDurationS, pvStepsFor, pvUsable } =
  new Function(`${slice}; return { pvDistM, pvBearingDeg, pvSegLens, pvPointAt, pvAngleLerp, pvStepDurationS, pvStepsFor, pvUsable };`)();

// A right-angle path near Helsinki: 0.001 deg lat (~111 m), then 0.001 deg lon (~56 m).
const pts = [[60.17, 24.94], [60.171, 24.94], [60.171, 24.941]];
const { seg, total } = pvSegLens(pts);

test("preview progress is measured in metres along the geometry", () => {
  assert.ok(total > 150 && total < 180, `expected ~167 m, got ${total}`);
  const start = pvPointAt(pts, seg, 0);
  assert.deepEqual(start.point, pts[0]);
  const midLeg1 = pvPointAt(pts, seg, seg[0] / 2);
  assert.ok(Math.abs(midLeg1.point[0] - 60.1705) < 1e-6, "half the first leg's metres, not half its points");
  const corner = pvPointAt(pts, seg, seg[0]);
  assert.ok(Math.abs(corner.point[0] - 60.171) < 1e-9 && Math.abs(corner.point[1] - 24.94) < 1e-9);
  const end = pvPointAt(pts, seg, total + 50);
  assert.deepEqual(end.point, pts[2], "overshoot clamps to the final returned point");
});

test("bearings follow the direction of travel and turn the short way", () => {
  assert.ok(Math.abs(pvBearingDeg(pts[0], pts[1]) - 0) < 1, "northbound leg bears ~0");
  assert.ok(Math.abs(pvBearingDeg(pts[1], pts[2]) - 90) < 1, "eastbound leg bears ~90");
  const turned = pvAngleLerp(350, 10, 0.5);
  assert.ok(turned === 0 || turned === 360 || Math.abs(((turned + 180) % 360) - 180) < 1, "350 to 10 passes through 0, never backwards through 180");
  assert.ok(Math.abs(pvAngleLerp(350, 10, 1) - 10) < 1e-9);
});

test("legs without returned geometry are schematic and never animated as precise", () => {
  const it = { legs: [
    { mode: "WALK", geometry: "digitransit", points: pts },
    { mode: "RAIL", geometry: "schematic", points: [pts[0], pts[2]] },
    { mode: "WALK", geometry: "digitransit", points: [] },
  ] };
  const steps = pvStepsFor(it);
  assert.equal(pvUsable(steps[0]), true);
  assert.equal(steps[1].schematic, true, "endpoint-only links are schematic");
  assert.equal(pvUsable(steps[1]), false);
  assert.equal(pvUsable(steps[2]), false, "a leg with no points cannot be followed");
});

test("playback durations compress long legs and stay bounded", () => {
  assert.ok(pvStepDurationS("WALK", 100) >= 3 && pvStepDurationS("WALK", 100) <= 10);
  assert.equal(pvStepDurationS("WALK", 5000), 10, "long walks are capped, not real-time");
  assert.equal(pvStepDurationS("SUBWAY", 12000), 12, "long transit legs are capped");
  assert.ok(pvStepDurationS("RAIL", 3200) >= 4, "short legs keep a readable minimum");
  assert.ok(pvDistM(pts[0], pts[1]) > 100);
});
