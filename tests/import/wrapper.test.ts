import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  factory: vi.fn(),
  load: vi.fn(),
}));
vi.mock("esm-sync", () => ({ default: mocks.factory }));

import importSync from "../../src/import";

beforeEach(() => {
  mocks.load.mockReset();
  mocks.factory.mockReset().mockReturnValue(mocks.load);
});

test("forwards bare package IDs and ESM options without rewriting them", () => {
  const esmOptions = { mode: "strict" } as const;
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync("example-package", { esmOptions })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith("example-package");
  expect(mocks.factory).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    esmOptions,
  );
});

test.each([
  { description: "a package ID", id: "example-package" },
  {
    description: "an absolute path",
    id: join(realpathSync(tmpdir()), "example-module.mjs"),
  },
])("ignores basePath for $description", ({ id }) => {
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync(id, { basePath: "/ignored" })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(id);
});

test("resolves extensionless paths against an explicit basePath", () => {
  const basePath = realpathSync(
    fileURLToPath(new URL("../basic/", import.meta.url)),
  );
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync("./basic", { basePath })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    join(basePath, "basic.mjs"),
  );
});

test.each([
  { description: "null", value: null },
  { description: "undefined", value: undefined },
  { description: "zero", value: 0 },
  { description: "false", value: false },
  { description: "an empty string", value: "" },
  { description: "a function", value: () => "hello" },
])("preserves $description returned by the loader", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("example-package")).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith("example-package");
});

test.each([
  { description: "an empty array", value: [] },
  { description: "a Date instance", value: new Date(0) },
])("preserves $description instead of falling back to require", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
});

test("falls back to native require only for empty objects", () => {
  mocks.load.mockReturnValue({});
  const nativeFs = createRequire(import.meta.url)("node:fs");

  expect(importSync("node:fs")).toBe(nativeFs);
});

test.each([
  { name: "null", source: "module.exports = null;" },
  { name: "undefined", source: "module.exports = undefined;" },
  { name: "an empty array", source: "module.exports = [];" },
  { name: "a function", source: "module.exports = () => 42;" },
])("preserves $name from the native CommonJS fallback", ({ source }) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-fallback-")),
  );
  try {
    const fixture = join(root, "fixture.cjs");
    writeFileSync(fixture, source);
    const nativeResult = createRequire(import.meta.url)(fixture);
    mocks.load.mockReturnValue({});

    expect(importSync(fixture)).toBe(nativeResult);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the original namespace if the native fallback is also empty", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-fallback-empty-")),
  );
  try {
    const fixture = join(root, "fixture.cjs");
    writeFileSync(fixture, "module.exports = {};");
    const namespace = {};
    mocks.load.mockReturnValue(namespace);

    expect(importSync(fixture)).toBe(namespace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns the original empty result if the CommonJS fallback fails", () => {
  const value = {};
  mocks.load.mockReturnValue(value);

  expect(importSync("package-that-does-not-exist")).toBe(value);
});

test("adds the requested module and options to loader errors", () => {
  mocks.load.mockImplementation(() => {
    throw new Error("controlled failure");
  });
  const options = { basePath: "/unused" };

  expect(() => importSync("example-package", options)).toThrow(
    /Failed to import from:\s+example-package[\s\S]*Options:[\s\S]*"basePath":"\/unused"[\s\S]*Require error message:[\s\S]*controlled failure/,
  );
});

test("reports loader initialisation failures with the same context", () => {
  mocks.factory.mockImplementation(() => {
    throw new Error("factory failure");
  });

  expect(() => importSync("example-package")).toThrow(
    /Failed to import from:[\s\S]*example-package[\s\S]*factory failure/,
  );
});

test("wraps non-Error loader failures", () => {
  mocks.load.mockImplementation(() => {
    throw "non-Error failure";
  });

  expect(() => importSync("example-package")).toThrow(
    /Failed to import from:[\s\S]*non-Error failure/,
  );
});
