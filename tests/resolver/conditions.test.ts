import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  deriveImportConditions,
  getImportConditions,
  getStartupRequireConditions,
  resolvePackageId,
} from "#/resolve.ts";

test.each([
  {
    name: "the default native require conditions",
    native: ["require", "node", "node-addons", "module-sync"],
    explicitRequire: false,
  },
  {
    name: "an explicit --conditions=require startup flag",
    native: ["require", "node", "node-addons", "require", "module-sync"],
    explicitRequire: true,
  },
])("converts $name to import conditions", ({ native, explicitRequire }) => {
  expect(deriveImportConditions(native)).toEqual(
    new Set([
      "node",
      "import",
      "default",
      "module-sync",
      "node-addons",
      ...(explicitRequire ? ["require"] : []),
    ]),
  );
});

test("recreates Node's built-in import conditions", () => {
  expect(getImportConditions([], "")).toEqual(
    new Set(["node", "import", "default", "module-sync", "node-addons"]),
  );
  expect(getImportConditions([], "", false)).toEqual(
    new Set(["node", "import", "default", "node-addons"]),
  );
});

test("defaults to process flags and ignores unrelated CLI arguments", () => {
  expect(getImportConditions().has("node")).toBe(true);
  expect(getImportConditions(["--trace-warnings"], "")).toEqual(
    new Set(["node", "import", "default", "module-sync", "node-addons"]),
  );
});

test("reads user conditions from both command-line flags and NODE_OPTIONS", () => {
  expect(
    getImportConditions(
      ["--conditions=cli", "-C", "short", "--conditions", "separate"],
      '  --conditions=env   -C "quoted condition"  ',
    ),
  ).toEqual(
    new Set([
      "node",
      "import",
      "default",
      "module-sync",
      "node-addons",
      "env",
      "quoted condition",
      "cli",
      "short",
      "separate",
    ]),
  );
  expect(
    getImportConditions([], '"--conditions=whole-argument"').has(
      "whole-argument",
    ),
  ).toBe(true);
});

test("preserves literal quotes in CLI conditions but tokenizes NODE_OPTIONS double quotes", () => {
  const conditions = getImportConditions(
    ['--conditions="quoted cli"', "-C", "'single cli'"],
    `--conditions='literal' --conditions="grouped condition" -C "'also literal'"`,
  );

  for (const value of [
    '"quoted cli"',
    "'single cli'",
    "'literal'",
    "grouped condition",
    "'also literal'",
  ]) {
    expect(conditions.has(value)).toBe(true);
  }
  expect(conditions.has("literal")).toBe(false);
  expect(conditions.has("quoted cli")).toBe(false);
});

test("matches NODE_OPTIONS escaping within double-quoted conditions", () => {
  const conditions = getImportConditions(
    [],
    String.raw`--conditions="a\"b" --conditions="a\\b" --conditions="a\ b" --conditions="a\qb" --conditions=a\qb --conditions="a""b"`,
  );
  for (const value of [
    'a"b',
    String.raw`a\b`,
    "a b",
    "aqb",
    String.raw`a\qb`,
    "ab",
  ]) {
    expect(conditions.has(value), value).toBe(true);
  }
  expect(conditions.has(String.raw`a\"b`)).toBe(false);
  expect(conditions.has(String.raw`a\ b`)).toBe(false);
  // Invalid NODE_OPTIONS never reaches Node user code, but this direct parser
  // call should still preserve a trailing backslash rather than append undefined.
  expect(
    getImportConditions([], '--conditions="unfinished\\').has("unfinished\\"),
  ).toBe(true);
});

test("respects the native addon toggle and ignores empty condition values", () => {
  const withoutAddons = getImportConditions(
    ["--conditions=", "-C", "", "--addons", "--no-addons"],
    "",
  );
  expect(withoutAddons.has("node-addons")).toBe(false);
  expect(withoutAddons.has("")).toBe(false);
  expect(
    getImportConditions(["--no-addons", "--addons"], "").has("node-addons"),
  ).toBe(true);
});

test("preserves the CommonJS resolution branch when it exists", () => {
  const resolve = vi.fn().mockReturnValue("/package/require.cjs");

  expect(resolvePackageId("dual-package", resolve)).toBe(
    "/package/require.cjs",
  );
  expect(resolve).toHaveBeenCalledExactlyOnceWith("dual-package");
});

test.each(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_IMPORT_NOT_DEFINED"])(
  "resolves %s using import conditions if require conditions are unavailable",
  (code) => {
    const error = Object.assign(new Error("missing require branch"), { code });
    const resolve = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockReturnValueOnce("/package/import.mjs");

    expect(resolvePackageId("conditional-package", resolve)).toBe(
      "/package/import.mjs",
    );
    expect(resolve).toHaveBeenNthCalledWith(1, "conditional-package");
    expect(resolve).toHaveBeenCalledTimes(2);

    const conditions = resolve.mock.calls[1]?.[1]?.conditions as Set<string>;
    expect(conditions).toBeInstanceOf(Set);
    expect(conditions.has("node")).toBe(true);
    expect(conditions.has("import")).toBe(true);
    expect(conditions.has("default")).toBe(true);
    expect(conditions.has("module-sync")).toBe(true);
    expect(conditions.has("node-addons")).toBe(true);
    expect(conditions.has("require")).toBe(false);
  },
);

test.each([
  Object.assign(new Error("missing module"), { code: "MODULE_NOT_FOUND" }),
  Object.assign(new Error("invalid exports target"), {
    code: "ERR_INVALID_PACKAGE_TARGET",
  }),
  new Error("unexpected resolver failure"),
  null,
])("does not hide unrelated resolver errors (%s)", (error) => {
  const resolve = vi.fn().mockImplementation(() => {
    throw error;
  });

  expect(() => resolvePackageId("broken-package", resolve)).toThrowError();
  expect(resolve).toHaveBeenCalledExactlyOnceWith("broken-package");
});

test("resolves a hook-only ESM specifier when CommonJS resolution misses it", () => {
  const missing = Object.assign(new Error("missing CommonJS module"), {
    code: "MODULE_NOT_FOUND",
  });
  const resolve = vi.fn(() => {
    throw missing;
  });
  const resolveImport = vi.fn(() => "file:///virtual/module.mjs");
  expect(resolvePackageId("virtual:module", resolve, resolveImport)).toBe(
    "file:///virtual/module.mjs",
  );
  expect(resolveImport).toHaveBeenCalledOnce();

  const importMissing = vi.fn(() => {
    throw Object.assign(new Error("no ESM module"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  });
  expect(() => resolvePackageId("missing", resolve, importMissing)).toThrow(
    missing,
  );
  expect(importMissing).toHaveBeenCalledOnce();
});

test.each([
  new Error("resolver hook rejected the import"),
  Object.assign(new Error("import denied by a policy hook"), {
    code: "ERR_ACCESS_DENIED",
  }),
  Object.assign(new Error("custom error with CommonJS-style missing code"), {
    code: "MODULE_NOT_FOUND",
  }),
])(
  "preserves explicit ESM resolver failures when CommonJS lookup misses (%s)",
  (failure) => {
    const commonJsMissing = Object.assign(
      new Error("missing CommonJS module"),
      {
        code: "MODULE_NOT_FOUND",
      },
    );
    const resolve = vi.fn(() => {
      throw commonJsMissing;
    });
    const resolveImport = vi.fn(() => {
      throw failure;
    });
    expect(() =>
      resolvePackageId("hook-protected-package", resolve, resolveImport),
    ).toThrow(failure);
    expect(resolveImport).toHaveBeenCalledExactlyOnceWith();
  },
);

test("uses Node's native matching for import-only exports, subpaths, and aliases", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-conditions-")),
  );
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "conditional-app",
        imports: { "#internal": { import: "./internal.mjs" } },
        exports: { "./self": { import: "./internal.mjs" } },
      }),
    );
    writeFileSync(join(root, "internal.mjs"), "export const value = 1;\n");

    const packageRoot = join(root, "node_modules", "only-import");
    mkdirSync(join(packageRoot, "features"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "only-import",
        type: "module",
        exports: {
          ".": { import: "./entry.mjs" },
          "./features/*": { import: "./features/*.mjs" },
        },
      }),
    );
    writeFileSync(join(packageRoot, "entry.mjs"), "export const value = 2;\n");
    writeFileSync(
      join(packageRoot, "features", "one.mjs"),
      "export const value = 3;\n",
    );

    const resolve = createRequire(join(root, "consumer.cjs")).resolve;
    for (const [id, expected] of [
      ["only-import", join(packageRoot, "entry.mjs")],
      ["only-import/features/one", join(packageRoot, "features", "one.mjs")],
      ["#internal", join(root, "internal.mjs")],
      ["conditional-app/self", join(root, "internal.mjs")],
    ]) {
      expect(realpathSync(resolvePackageId(id, resolve))).toBe(
        realpathSync(expected),
      );
    }
    expect(() => resolvePackageId("only-import/hidden", resolve)).toThrowError(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exposes native require conditions captured at startup", () => {
  const conditions = getStartupRequireConditions();
  expect(conditions).toContain("require");
  expect(conditions).toContain("node");
  expect(conditions).toContain("module-sync");
});
