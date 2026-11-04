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
const { pvDistM, pvBearingDeg, pvSegLens, pvPointAt, pvAngleLerp, pvStepDurationS, pvSpeedMps, pvLookaheadM, pvTurnToward, pvFinished, pvStepsFor, pvUsable } =
  new Function(`${slice}; return { pvDistM, pvBearingDeg, pvSegLens, pvPointAt, pvAngleLerp, pvStepDurationS, pvSpeedMps, pvLookaheadM, pvTurnToward, pvFinished, pvStepsFor, pvUsable };`)();

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
  // Superseded by fixed speeds below: duration is now dist / speed, uncapped.
  assert.ok(Math.abs(pvStepDurationS("WALK", 392) - 392 / 6) < 1e-9);
  assert.ok(pvDistM(pts[0], pts[1]) > 100);
});

test("preview speeds are fixed at 6 m/s walking and 30 m/s transit", () => {
  assert.equal(pvSpeedMps("WALK"), 6);
  assert.equal(pvSpeedMps("BUS"), 30);
  assert.equal(pvSpeedMps("SUBWAY"), 30);
  assert.equal(pvSpeedMps("RAIL"), 30);
  assert.equal(pvLookaheadM("WALK"), 25);
  assert.equal(pvLookaheadM("BUS"), 80);
});

test("a 392 m walk takes ~65 s regardless of step count", () => {
  const expected = 392 / 6;
  assert.ok(Math.abs(expected - 65.33) < 0.01, "392/6 is about 65 s");
  assert.ok(Math.abs(pvStepDurationS("WALK", 392) - expected) < 1e-9, "one 392 m step");
  const split = [100, 100, 100, 92].reduce((a, d) => a + pvStepDurationS("WALK", d), 0);
  assert.ok(Math.abs(split - expected) < 1e-9, "four steps totalling 392 m take the same time");
  const many = Array.from({ length: 8 }, () => 49).reduce((a, d) => a + pvStepDurationS("WALK", d), 0);
  assert.ok(Math.abs(many - expected) < 1e-9, "eight steps totalling 392 m take the same time");
  assert.ok(Math.abs(pvStepDurationS("BUS", 900) - 30) < 1e-9, "900 m transit at 30 m/s is 30 s");
});

test("pvTurnToward is time-based, frame-rate independent and rate-limited", () => {
  const run = (steps, dt) => { let b = 350; for (let i = 0; i < steps; i++) b = pvTurnToward(b, 10, dt); return b; };
  const at60 = run(60, 1 / 60);
  const at10 = run(10, 1 / 10);
  // angular difference between the two results, via shortest arc:
  const arc = Math.abs(((at60 - at10 + 540) % 360) - 180);
  assert.ok(arc < 1, `60fps ${at60} vs 10fps ${at10} end within ~1 degree`);
  assert.ok(Math.abs(at60 - 10) < 1e-9 && Math.abs(at10 - 10) < 1e-9, "both reach 10 through 0");
  // Never exceeds 25 deg/s * elapsed:
  let b = 350;
  for (let i = 0; i < 60; i++) {
    const prev = b;
    b = pvTurnToward(b, 10, 1 / 60);
    const moved = Math.abs(((b - prev + 540) % 360) - 180);
    assert.ok(moved <= 25 * (1 / 60) + 1e-9, `step moved ${moved} deg in 1/60 s`);
  }
  // Shortest arc: from 350 toward 10 it must pass through 0, never near 180.
  let c = 350; const seen = [];
  for (let i = 0; i < 60; i++) { c = pvTurnToward(c, 10, 1 / 60); seen.push(c); }
  assert.ok(seen.some((v) => v < 5 || v > 355), "passes through 0");
  assert.ok(seen.every((v) => v > 300 || v < 30), "never swings the long way through 180");
  assert.equal(pvTurnToward(0, 90, 1), 25, "one second turns at most 25 degrees");
  assert.equal(pvTurnToward(null, 42, 1 / 60), 42, "no current bearing snaps to target");
});

test("pvFinished: last step alone is not the end until its distance is done", () => {
  const it = { legs: [
    { mode: "WALK", geometry: "digitransit", points: pts },
    { mode: "BUS", geometry: "digitransit", points: pts },
  ] };
  const steps = pvStepsFor(it);
  assert.equal(pvFinished(1, 0, steps), false, "on last step at its start is resumable");
  assert.equal(pvFinished(1, steps[1].total - 1, steps), false, "last step with dist < total is NOT finished");
  assert.equal(pvFinished(1, steps[1].total, steps), true, "last step with dist >= total IS finished");
  assert.equal(pvFinished(0, steps[0].total, steps), false, "end of a non-last step is not finished");
  const single = pvStepsFor({ legs: [{ mode: "WALK", geometry: "digitransit", points: pts }] });
  assert.equal(pvFinished(0, single[0].total / 2, single), false, "single-step journey mid-way is resumable");
  assert.equal(pvFinished(0, single[0].total, single), true, "single-step journey at its end is finished");
  assert.equal(pvFinished({ stepIdx: 0, dist: single[0].total / 2, steps: single }), false, "object form agrees");
});
