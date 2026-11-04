import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The follow-scroll decisions are pure functions in public/app.js, delimited
// by [autoscroll-helpers] markers. Evaluate that exact shipped source
// against fake scroll containers (no DOM, no browser needed).
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const slice = src.slice(src.indexOf("// [autoscroll-helpers]"), src.indexOf("// [/autoscroll-helpers]"));
assert.ok(slice.includes("function isNearBottom"), "helpers are present in the shipped file");
const { isNearBottom, shouldAutoScroll } = new Function(
  `${slice}; return { isNearBottom, shouldAutoScroll };`)();

const el = (scrollTop, scrollHeight = 1000, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight });

test("autoscroll: at the bottom counts as following", () => {
  assert.equal(isNearBottom(el(600)), true, "exactly at bottom");
  assert.equal(isNearBottom(el(540)), true, "within the 80px threshold");
  assert.equal(shouldAutoScroll(false, el(600)), true, "reaching the bottom resumes following");
});

test("autoscroll: scrolled up stops following and must not be overridden", () => {
  assert.equal(isNearBottom(el(100)), false);
  assert.equal(shouldAutoScroll(false, el(100)), false, "new content must not yank a reading user down");
});

test("autoscroll: an actively following view keeps following new content", () => {
  assert.equal(shouldAutoScroll(true, el(100)), true);
  assert.equal(shouldAutoScroll(true, el(0)), true);
});
