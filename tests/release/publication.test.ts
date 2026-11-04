import { expect, test } from "vitest";
import { compareReleaseVersions } from "../../script/release-policy.ts";
import { publishedDistTagStatus } from "../../script/release-publisher.ts";

test.each([
  ["2.2.6", "2.2.6", 0],
  ["2.2.7", "2.2.6", 1],
  ["2.2.6", "2.2.7", -1],
  ["2.2.7-beta.1", "2.2.7-beta.2", -1],
  ["2.2.7-beta.2", "2.2.7-beta.1", 1],
  ["2.2.7", "2.2.7-beta.999", 1],
  ["2.2.7-beta.999", "2.2.7", -1],
  ["2.2.7-beta.123456789123456789", "2.2.7-beta.123456789123456788", 1],
] as const)("compares %s against %s", (left, right, expected) => {
  expect(compareReleaseVersions(left, right)).toBe(expected);
});

test.each([
  { tag: "latest", version: "2.2.6", actual: "2.2.6", status: "current" },
  { tag: "latest", version: "2.2.6", actual: "2.2.7", status: "superseded" },
  {
    tag: "beta",
    version: "2.2.7-beta.2",
    actual: "2.2.7-beta.3",
    status: "superseded",
  },
] as const)(
  "allows the $tag tag to be $status",
  ({ tag, version, actual, status }) => {
    expect(publishedDistTagStatus(version, actual, tag)).toBe(status);
  },
);

test.each([
  { tag: "latest", version: "2.2.6", actual: undefined },
  { tag: "latest", version: "2.2.6", actual: "2.2.5" },
  { tag: "latest", version: "2.2.6", actual: "2.2.6-beta.9" },
  { tag: "latest", version: "2.2.6", actual: "2.2.7-beta.1" },
  { tag: "beta", version: "2.2.7-beta.2", actual: "2.2.7-beta.1" },
  { tag: "beta", version: "2.2.7-beta.2", actual: "2.2.7" },
  { tag: "beta", version: "2.2.7-beta.2", actual: "2.2.8" },
] as const)(
  "rejects a missing or stale $tag tag ($actual)",
  ({ tag, version, actual }) => {
    expect(() => publishedDistTagStatus(version, actual, tag)).toThrow(
      /dist-tag points to/,
    );
  },
);
