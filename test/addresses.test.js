import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAddress, validAddress, ADDRESS_RE } from "../src/addresses.js";

describe("normalizeAddress", () => {
  it("appends @relay to a bare name", () => {
    assert.equal(normalizeAddress("scout"), "scout@relay");
  });
  it("leaves a full address unchanged", () => {
    assert.equal(normalizeAddress("scout@relay"), "scout@relay");
  });
  it("trims whitespace and lowercases", () => {
    assert.equal(normalizeAddress("  Scout  "), "scout@relay");
    assert.equal(normalizeAddress("Ops@Relay"), "ops@relay");
  });
  it("passes empty/blank through for the validator to reject", () => {
    assert.equal(normalizeAddress(""), "");
    assert.equal(normalizeAddress("   "), "");
    assert.equal(normalizeAddress(null), "");
    assert.equal(normalizeAddress(undefined), "");
  });
  it("does not double-append when @ is present", () => {
    assert.equal(normalizeAddress("a@b"), "a@b");
  });
});

describe("validAddress", () => {
  it("accepts normalized bare names", () => {
    assert.ok(validAddress(normalizeAddress("scout")));
    assert.ok(validAddress(normalizeAddress("ops-2_x")));
  });
  it("rejects bad input", () => {
    assert.ok(!validAddress(""));
    assert.ok(!validAddress("a@relay")); // too short
    assert.ok(!validAddress("Scout@relay")); // uppercase
    assert.ok(!validAddress("scout")); // bare, un-normalized
    assert.ok(!validAddress("scout@other"));
    assert.ok(!validAddress(null));
  });
  it("ADDRESS_RE matches the documented rule", () => {
    assert.equal(ADDRESS_RE.source, "^[a-z0-9][a-z0-9\\-_]{1,31}@relay$");
  });
});
