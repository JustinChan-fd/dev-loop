import { test } from "node:test";
import assert from "node:assert/strict";
import { trimDashes } from "../lib/slug.js";

test("trimDashes drops leading and trailing dashes", () => {
  assert.equal(trimDashes("--a-b--"), "a-b");
  assert.equal(trimDashes("a"), "a");
});
