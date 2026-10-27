import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compareReleaseBases,
  nextBetaVersion,
  parseReleaseVersion,
  validateReleaseManifest,
  versionFromTag,
} from "../../script/release-policy.ts";

describe("npm release version policy", () => {
  it.each([
    ["2.2.7", "latest"],
    ["2.2.7-beta.1", "beta"],
    ["2.2.7-beta.100", "beta"],
  ])("maps %s to the %s dist-tag", (version, distTag) => {
    assert.equal(parseReleaseVersion(version).distTag, distTag);
    assert.equal(versionFromTag(`v${version}`).version, version);
  });

  it.each([
    "2.2.7-rc.1",
    "2.2.7-beta.01",
    "02.2.7",
    "3x3x8",
    "2.2.7+metadata",
    "2.2.7\n",
    "2.2.7-beta.1.extra",
  ])("rejects unsupported release version %s", (version) => {
    assert.throws(() => parseReleaseVersion(version));
  });

  it("requires an exact v-prefixed tag and manifest version", () => {
    assert.throws(() => versionFromTag("2.2.7"));
    assert.equal(
      validateReleaseManifest(
        { name: "import-sync", version: "2.2.7" },
        "v2.2.7",
      ),
      "2.2.7",
    );
    assert.throws(() =>
      validateReleaseManifest(
        { name: "import-sync", version: "2.2.6" },
        "v2.2.7",
      ),
    );
    assert.throws(() =>
      validateReleaseManifest({ name: "wrong", version: "2.2.7" }, "v2.2.7"),
    );
  });

  it("compares stable versions numerically, including large integer components", () => {
    assert.equal(compareReleaseBases("3.10.0", "3.9.99"), 1);
    assert.equal(compareReleaseBases("2.2.7-beta.1", "2.2.7"), 0);
    assert.equal(compareReleaseBases("2.2.7", "4.0.0"), -1);
    assert.equal(compareReleaseBases("2.2.7", "2.2.7"), 0);
  });
});

describe("next numbered beta", () => {
  it.each([
    ["2.2.7", [], [], undefined, "2.2.7-beta.1"],
    ["2.2.7-beta.3", [], [], undefined, "2.2.7-beta.4"],
    [
      "2.2.7",
      ["2.2.7-beta.9", "2.3.0-beta.99"],
      ["v2.2.7-beta.12"],
      undefined,
      "2.2.7-beta.13",
    ],
    [
      "2.2.7",
      [],
      ["v2.2.7-beta.9007199254740992"],
      undefined,
      "2.2.7-beta.9007199254740993",
    ],
    ["2.2.6", ["2.2.6"], [], "2.2.7", "2.2.7-beta.1"],
    [
      "2.2.6",
      ["2.2.6", "2.3.0-beta.2"],
      ["v2.3.0-beta.4"],
      "v2.3.0",
      "2.3.0-beta.5",
    ],
  ] as const)(
    "chooses next beta for %s with base %s",
    (current, published, tags, base, expected) => {
      assert.equal(nextBetaVersion(current, published, tags, base), expected);
    },
  );

  it("requires an explicit new base after the stable release was published", () => {
    assert.throws(() => nextBetaVersion("2.2.6", ["2.2.6"], []), /--base/);
    assert.throws(() => nextBetaVersion("2.2.6", [], ["v2.2.6"]), /--base/);
  });

  it("refuses an older, already released, or superseded base", () => {
    assert.throws(
      () => nextBetaVersion("2.3.0-beta.2", [], [], "2.2.7"),
      /earlier/,
    );
    assert.throws(
      () => nextBetaVersion("2.2.6", ["2.2.7"], [], "2.2.7"),
      /released/,
    );
    assert.throws(
      () => nextBetaVersion("2.2.6", ["2.3.0"], [], "2.2.7"),
      /newer/,
    );
    assert.throws(
      () => nextBetaVersion("2.2.6", [], [], "2.2.7-beta.1"),
      /stable/,
    );
  });
});
