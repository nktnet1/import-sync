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
import { getImportConditions, resolvePackageId } from "#/resolve.ts";

test("recreates Node's built-in import conditions", () => {
  expect(getImportConditions([], "")).toEqual(
    new Set(["node", "import", "default", "module-sync", "node-addons"]),
  );
  expect(getImportConditions([], "", false)).toEqual(
    new Set(["node", "import", "default", "node-addons"]),
  );
});

test("reads user conditions from both command-line flags and NODE_OPTIONS", () => {
  expect(
    getImportConditions(
      ["--conditions=cli", "-C", "short", "--conditions", "separate"],
      '--conditions=env -C "quoted condition"',
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
