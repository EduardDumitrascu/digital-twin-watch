import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Building extrusions ship in public/app.js between [building-height]
// markers. The snapshot records floors + heightSource, never measured
// metres, so extrusion heights are floor-count estimates (floors x 3 m),
// labelled as estimates, and buildings without a floor count stay flat.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = src.slice(src.indexOf("// [building-height]"), src.indexOf("// [/building-height]"));
assert.ok(slice.includes("function buildingHeightProps"), "helper is present in the shipped file");
const { buildingHeightProps } = new Function(`${slice}; return { buildingHeightProps };`)();
const snap = JSON.parse(readFileSync(new URL("../data/snapshot-2026-11-03.json", import.meta.url), "utf8"));

test("building heights come from the snapshot floor counts", () => {
  assert.deepEqual(buildingHeightProps({ floors: 7, heightSource: "recorded_floors" }), { h: 21, est: true, known: true });
  assert.deepEqual(buildingHeightProps({ floors: null, heightSource: "fallback_estimate" }), { h: 0, est: false, known: false });
  assert.deepEqual(buildingHeightProps({}), { h: 0, est: false, known: false });
});

test("the committed snapshot no longer renders every building flat", () => {
  const props = snap.buildings.map(buildingHeightProps);
  assert.ok(props.some((p) => p.h > 0), "recorded floor counts must produce an extrusion height");
  assert.ok(props.filter((p) => p.known).length < props.length, "buildings without data stay flat and unknown");
  assert.ok(props.every((p) => !p.known || p.est), "every known height is labelled an estimate (floors x 3 m)");
});
