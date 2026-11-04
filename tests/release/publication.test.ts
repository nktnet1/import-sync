import { expect, test } from "vitest";
import {
  compareReleaseVersions,
  nextBetaVersion,
} from "../../script/release-policy.ts";
import {
  assertDistTagWillNotDowngrade,
  publishedDistTagStatus,
} from "../../script/release-publisher.ts";

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

test("advances within the highest existing beta series", () => {
  expect(
    nextBetaVersion("2.2.6", ["2.2.7-beta.3"], ["v2.2.7-beta.4"], "2.2.7"),
  ).toBe("2.2.7-beta.5");
});

test.each([
  { published: ["2.3.0-beta.4"], tags: [] },
  { published: [], tags: ["v2.3.0-beta.4"] },
])(
  "rejects an older beta base after a newer prerelease ($published, $tags)",
  ({ published, tags }) => {
    expect(() => nextBetaVersion("2.2.6", published, tags, "2.2.7")).toThrow(
      /newer beta version.*already exists/,
    );
  },
);

test.each([
  { tag: "latest", version: "2.2.7", actual: undefined },
  { tag: "latest", version: "2.2.7", actual: "2.2.6" },
  { tag: "latest", version: "2.2.7", actual: "2.2.7" },
  { tag: "latest", version: "2.2.7", actual: "2.2.7-beta.2" },
  { tag: "beta", version: "2.2.7-beta.2", actual: undefined },
  { tag: "beta", version: "2.2.7-beta.2", actual: "2.2.7-beta.1" },
  { tag: "beta", version: "2.2.7-beta.2", actual: "2.2.7-beta.2" },
] as const)(
  "permits new $tag publication from $actual to $version",
  ({ tag, version, actual }) => {
    expect(() =>
      assertDistTagWillNotDowngrade(version, actual, tag),
    ).not.toThrow();
  },
);

test.each([
  { tag: "latest", version: "2.2.6", actual: "2.2.7" },
  { tag: "latest", version: "2.2.6", actual: "2.3.0-beta.1" },
  { tag: "beta", version: "2.2.7-beta.1", actual: "2.3.0-beta.4" },
  { tag: "beta", version: "2.2.7-beta.1", actual: "2.2.7" },
] as const)(
  "blocks a $tag downgrade from $actual to $version",
  ({ tag, version, actual }) => {
    expect(() => assertDistTagWillNotDowngrade(version, actual, tag)).toThrow(
      /Refusing to publish.*already points to newer/,
    );
  },
);

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
