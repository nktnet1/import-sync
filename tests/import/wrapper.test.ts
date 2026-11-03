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

import importSync from "#/import.ts";

const basicDirectory = realpathSync(
  fileURLToPath(new URL("../basic/", import.meta.url)),
);

beforeEach(() => {
  mocks.load.mockReset();
  mocks.factory.mockReset().mockReturnValue(mocks.load);
});

function expectBasicModuleResolution(id: string): void {
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync(id, { basePath: basicDirectory })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    join(basicDirectory, "basic.mjs"),
  );
}

test("resolves bare package IDs from the caller and forwards ESM options", () => {
  const esmOptions = { mode: "strict" } as const;
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync("node-fetch", { esmOptions })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    createRequire(import.meta.url).resolve("node-fetch"),
  );
  expect(mocks.factory).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    esmOptions,
  );
});

test("ignores basePath when resolving a package ID", () => {
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync("node-fetch", { basePath: "/ignored" })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    createRequire(import.meta.url).resolve("node-fetch"),
  );
});

test("ignores basePath for absolute paths", () => {
  const id = join(realpathSync(tmpdir()), "example-module.mjs");
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  expect(importSync(id, { basePath: "/ignored" })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(id);
});

test.each([
  { description: "a built-in package ID", id: "node:fs" },
  { description: "a bare built-in package ID", id: "fs" },
  {
    description: "an absolute path",
    id: join(realpathSync(tmpdir()), "fixture.mjs"),
  },
  {
    description: "a file URL",
    id: new URL("../basic/basic.mjs", import.meta.url).href,
  },
])("does not capture a caller stack for $description", ({ id }) => {
  const originalCaptureStackTrace = Error.captureStackTrace;
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);

  try {
    Error.captureStackTrace = () => {
      throw new Error("Unnecessary caller stack capture");
    };
    expect(importSync(id)).toBe(value);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(id);
  } finally {
    Error.captureStackTrace = originalCaptureStackTrace;
  }
});

test("resolves extensionless paths against an explicit basePath", () => {
  expectBasicModuleResolution("./basic");
});

test("resolves relative basePath values from the working directory", () => {
  const value = { sentinel: true };
  mocks.load.mockReturnValue(value);
  const basePath = "tests/basic";
  const expectedRoot = realpathSync(process.cwd());

  expect(importSync("./basic", { basePath })).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
    realpathSync(join(expectedRoot, basePath, "basic.mjs")),
  );
});

test.skipIf(process.platform !== "win32")(
  "recognises backslash-prefixed relative paths on Windows",
  () => {
    expectBasicModuleResolution(String.raw`.\basic`);
  },
);

test.each([
  { description: "null", value: null },
  { description: "undefined", value: undefined },
  { description: "zero", value: 0 },
  { description: "false", value: false },
  { description: "an empty string", value: "" },
  { description: "a function", value: () => "hello" },
])("preserves $description returned by the loader", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith("node:fs");
});

test.each([
  { description: "an empty array", value: [] },
  { description: "a Date instance", value: new Date(0) },
  { description: "a frozen empty object", value: Object.freeze({}) },
  {
    description: "a frozen null-prototype object",
    value: Object.freeze(Object.create(null)),
  },
])("preserves $description instead of falling back to require", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
});

test.each([
  {
    description: "symbol-only exports",
    value: { [Symbol.for("fixture")]: 42 },
  },
  {
    description: "non-enumerable exports",
    value: Object.defineProperty({}, "hidden", { value: 42 }),
  },
])("preserves $description without a native require fallback", ({ value }) => {
  mocks.load.mockReturnValue(value);

  expect(importSync("node:fs")).toBe(value);
});

test("does not introspect a Proxy returned by the loader", () => {
  const value = new Proxy(
    {},
    {
      isExtensible: () => {
        throw new Error("must not inspect an exported Proxy");
      },
    },
  );
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

  expect(importSync(join(realpathSync(tmpdir()), "missing-fallback.cjs"))).toBe(
    value,
  );
});

test("adds the requested module and options to loader errors", () => {
  mocks.load.mockImplementation(() => {
    throw new Error("controlled failure");
  });
  const options = { basePath: "/unused" };

  expect(() => importSync("node:fs", options)).toThrow(
    /Failed to import from:\s+node:fs[\s\S]*Options:[\s\S]*"basePath":"\/unused"[\s\S]*Require error message:[\s\S]*controlled failure/,
  );
});

test("preserves the original loader error as the cause", () => {
  const cause = Object.assign(new Error("controlled failure"), {
    code: "MODULE_NOT_FOUND",
  });
  mocks.load.mockImplementation(() => {
    throw cause;
  });

  expect(() => importSync("node:fs")).toThrow(
    expect.objectContaining({ cause }),
  );
});

test("reports loader initialisation failures with the same context", () => {
  mocks.factory.mockImplementation(() => {
    throw new Error("factory failure");
  });

  expect(() => importSync("node:fs")).toThrow(
    /Failed to import from:[\s\S]*node:fs[\s\S]*factory failure/,
  );
});

test("wraps non-Error loader failures", () => {
  mocks.load.mockImplementation(() => {
    throw "non-Error failure";
  });

  expect(() => importSync("node:fs")).toThrow(
    /Failed to import from:[\s\S]*non-Error failure/,
  );
});

test("preserves import diagnostics even when options cannot be JSON serialized", () => {
  const options: { basePath: string; circular?: unknown } = {
    basePath: "/unused",
  };
  options.circular = options;
  mocks.load.mockImplementation(() => {
    throw new Error("original loader failure");
  });

  expect(() => importSync("node:fs", options)).toThrow(
    /Failed to import from:[\s\S]*node:fs[\s\S]*\[unserializable options\][\s\S]*original loader failure/,
  );
});
