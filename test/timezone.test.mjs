import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The Helsinki wall-time conversion ships in public/app.js between
// [helsinki-time] markers. Evaluate that exact source: the same wall time
// must produce the same instant whatever the browser timezone is, because
// the conversion names Europe/Helsinki explicitly (incl. summer time).
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = src.slice(src.indexOf("// [helsinki-time]"), src.indexOf("// [/helsinki-time]"));
assert.ok(slice.includes("function helsinkiToIso"), "helpers are present in the shipped file");
const { helsinkiToIso, isoToHelsinkiLocal } = new Function(
  `${slice}; return { helsinkiToIso, isoToHelsinkiLocal };`)();

test("helsinki wall time converts with the correct seasonal offset", () => {
  assert.equal(helsinkiToIso("2026-11-04T10:00"), "2026-11-04T08:00:00.000Z", "winter EET (UTC+2)");
  assert.equal(helsinkiToIso("2026-07-04T10:00"), "2026-07-04T07:00:00.000Z", "summer EEST (UTC+3)");
  assert.equal(helsinkiToIso(""), null);
  assert.equal(helsinkiToIso("not-a-time"), null);
});

test("helsinki conversion round-trips for display in the form", () => {
  assert.equal(isoToHelsinkiLocal(helsinkiToIso("2026-11-04T10:00")), "2026-11-04T10:00");
  assert.equal(isoToHelsinkiLocal(helsinkiToIso("2026-07-04T23:30")), "2026-07-04T23:30");
});
