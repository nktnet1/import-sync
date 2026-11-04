import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { resolveLegacyImport } from "#/legacy-resolve.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const importConditions = new Set([
  "node",
  "import",
  "default",
  "node-addons",
  "custom",
]);

const write = (filename: string, data: string): void => {
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, data);
};

const createPackage = (
  directory: string,
  manifest: Record<string, unknown>,
  files: readonly string[],
): void => {
  write(join(directory, "package.json"), JSON.stringify(manifest));
  for (const file of files) {
    write(join(directory, file), "export const value = 1;\n");
  }
};

const expectFile = (actual: string, expected: string, suffix = ""): void => {
  const url = new URL(
    actual.startsWith("file:") ? actual : pathToFileURL(actual).href,
  );
  expect(realpathSync(fileURLToPath(url))).toBe(realpathSync(expected));
  expect(`${url.search}${url.hash}`).toBe(suffix);
};

const expectCode = (action: () => unknown, code: string): void => {
  expect(action).toThrowError(expect.objectContaining({ code }));
};

test("resolves import-only conditional exports, nested conditions, subpaths, arrays and patterns", () => {
  withTemporaryDirectory("import-sync-legacy-resolver-", (root) => {
    const packageRoot = join(root, "node_modules", "import-only");
    createPackage(
      packageRoot,
      {
        name: "import-only",
        type: "module",
        exports: {
          ".": { import: "./entry.mjs" },
          "./feature/*": { import: "./features/*.mjs" },
          "./feature/a*": { import: "./priority/*.mjs" },
          "./ordered/a*": { import: "./priority/*.mjs" },
          "./ordered/*": { import: "./features/*.mjs" },
          "./trailer/*e": { import: "./priority/*.mjs" },
          "./trailer/*": { import: "./features/*.mjs" },
          "./feature/*/nested": { import: "./nested/*.mjs" },
          "./nested": {
            node: { custom: "./custom.mjs", import: "./entry.mjs" },
          },
          "./array": { import: ["../invalid", "./entry.mjs"] },
          "./empty-array": { import: [] },
          "./blocked": null,
          "./require-only": { require: "./entry.mjs" },
          "./unknown-conditions": { browser: "./entry.mjs" },
          "./path": "./entry%2520name.mjs?rev=1#marker",
          "./invalid-target": "../outside.mjs",
          "./invalid-path": "./node_modules/entry.mjs",
          "./invalid-percent": "./entry%XX.mjs",
          "./numeric-conditions": { 0: "./entry.mjs" },
          "./invalid-type": 12,
          "./invalid-array": ["../bad", "../../bad"],
          "./array-configuration": [{ 0: "./entry.mjs" }, "./entry.mjs"],
          "./null-array": [null],
          "./literal": "./entry.mjs",
          "./double*star*": "./entry.mjs",
        },
      },
      [
        "entry.mjs",
        "features/one.mjs",
        "features/able.mjs",
        "priority/ble.mjs",
        "priority/abl.mjs",
        "nested/one.mjs",
        "custom.mjs",
        "entry%20name.mjs",
      ],
    );
    const conditionalPackage = join(root, "node_modules", "condition-only");
    createPackage(
      conditionalPackage,
      { name: "condition-only", exports: { import: "./entry.mjs" } },
      ["entry.mjs"],
    );
    const consumer = join(root, "consumer.cjs");
    const resolve = (specifier: string, conditions = importConditions) =>
      resolveLegacyImport(specifier, consumer, conditions);

    for (const [id, file, suffix] of [
      ["import-only", "entry.mjs", ""],
      ["import-only/feature/one", "features/one.mjs", ""],
      ["import-only/feature/able", "priority/ble.mjs", ""],
      ["import-only/ordered/able", "priority/ble.mjs", ""],
      ["import-only/trailer/able", "priority/abl.mjs", ""],
      ["import-only/feature/one/nested", "nested/one.mjs", ""],
      ["import-only/nested", "custom.mjs", ""],
      ["import-only/array", "entry.mjs", ""],
      ["import-only/path", "entry%20name.mjs", "?rev=1#marker"],
      ["import-only/literal", "entry.mjs", ""],
    ]) {
      expectFile(resolve(id), join(packageRoot, file), suffix);
    }
    expectFile(
      resolve("condition-only"),
      join(conditionalPackage, "entry.mjs"),
    );
    expectFile(
      resolve("import-only/nested", new Set(["node", "import", "default"])),
      join(packageRoot, "entry.mjs"),
    );
    for (const id of [
      "import-only/blocked",
      "import-only/unknown-conditions",
      "import-only/require-only",
      "import-only/private",
      "import-only/empty-array",
      "import-only/null-array",
      "import-only/doubleXstarY",
    ]) {
      expectCode(() => resolve(id), "ERR_PACKAGE_PATH_NOT_EXPORTED");
    }
    for (const id of [
      "import-only/invalid-target",
      "import-only/invalid-path",
      "import-only/invalid-percent",
      "import-only/invalid-array",
      "import-only/invalid-type",
    ]) {
      expectCode(() => resolve(id), "ERR_INVALID_PACKAGE_TARGET");
    }
    expectCode(
      () => resolve("import-only/array-configuration"),
      "ERR_INVALID_PACKAGE_CONFIG",
    );
    expectCode(
      () => resolve("import-only/numeric-conditions"),
      "ERR_INVALID_PACKAGE_CONFIG",
    );
    expectCode(
      () => resolve("import-only/feature/../escape"),
      "ERR_INVALID_PACKAGE_TARGET",
    );
    expectCode(
      () => resolve("import-only/feature/%2F"),
      "ERR_INVALID_MODULE_SPECIFIER",
    );
  });
});

test("resolves caller-scoped #imports, package self-references, external mappings, built-ins and no-exports packages", () => {
  withTemporaryDirectory("import-sync-legacy-imports-", (root) => {
    createPackage(
      root,
      {
        name: "application",
        exports: {
          "./self": { import: "./internal.mjs?self=1" },
          "./blocked": null,
        },
        imports: {
          "#internal": { import: "./internal.mjs#internal" },
          "#pattern/*": { import: "./private/*.mjs" },
          "#external": { import: "external/feature" },
          "#external/*": { import: "external/*" },
          "#self": { import: "application/self" },
          "#same": { import: "#internal" },
          "#builtin": { import: "node:fs" },
          "#plain": { import: "plain" },
          "#no-manifest": { import: "no-manifest" },
          "#blocked": null,
          "#require-only": { require: "./internal.mjs" },
          "#invalid": { import: "../outside.mjs" },
          "#bad-path": { import: "./private/%2f.mjs" },
          "#loop-a": { import: "#loop-b" },
          "#loop-b": { import: "#loop-a" },
          "#array": { import: [null, "./internal.mjs"] },
          "#bad-array": { import: ["../../bad", "./internal.mjs"] },
          "#primitive-array": { import: [12, "./internal.mjs"] },
          "#custom": { custom: "./internal.mjs" },
          "#numeric": { 0: "./internal.mjs" },
        },
      },
      ["internal.mjs", "private/entry.mjs"],
    );
    const external = join(root, "node_modules", "external");
    createPackage(
      external,
      { name: "external", exports: { "./feature": { import: "./index.mjs" } } },
      ["index.mjs"],
    );
    const plain = join(root, "node_modules", "plain");
    createPackage(plain, { name: "plain", main: "./index.js" }, ["index.js"]);
    const noManifest = join(root, "node_modules", "no-manifest", "index.js");
    write(noManifest, "exports.value = 1;\n");
    const consumer = join(root, "consumer.cjs");
    const resolve = (id: string) =>
      resolveLegacyImport(id, consumer, importConditions);
    for (const [id, file, suffix] of [
      ["#internal", join(root, "internal.mjs"), "#internal"],
      ["#pattern/entry", join(root, "private/entry.mjs"), ""],
      ["#external", join(external, "index.mjs"), ""],
      ["#external/feature", join(external, "index.mjs"), ""],
      ["#self", join(root, "internal.mjs"), "?self=1"],
      ["application/self", join(root, "internal.mjs"), "?self=1"],
      ["#plain", join(plain, "index.js"), ""],
      ["#no-manifest", noManifest, ""],
      ["#array", join(root, "internal.mjs"), ""],
      ["#bad-array", join(root, "internal.mjs"), ""],
      ["#primitive-array", join(root, "internal.mjs"), ""],
      ["#custom", join(root, "internal.mjs"), ""],
    ]) {
      expectFile(resolve(id), file, suffix);
    }
    expect(resolve("#builtin")).toBe("node:fs");
    for (const id of ["#blocked", "#require-only", "#missing"]) {
      expectCode(() => resolve(id), "ERR_PACKAGE_IMPORT_NOT_DEFINED");
    }
    expectCode(() => resolve("#loop-a"), "ERR_MODULE_NOT_FOUND");
    expectCode(() => resolve("#same"), "ERR_MODULE_NOT_FOUND");
    expectCode(
      () => resolve("application/blocked"),
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
    expectCode(() => resolve("#invalid"), "ERR_INVALID_PACKAGE_TARGET");
    expectCode(() => resolve("#bad-path"), "ERR_INVALID_MODULE_SPECIFIER");
    expectCode(() => resolve("#numeric"), "ERR_INVALID_PACKAGE_CONFIG");
    expectCode(() => resolve("invalid/missing"), "ERR_MODULE_NOT_FOUND");
    expectCode(() => resolve("/not-a-package"), "ERR_INVALID_MODULE_SPECIFIER");
    const anonymousConsumer = join(
      root,
      "node_modules",
      "anonymous",
      "consumer.cjs",
    );
    expectCode(
      () =>
        resolveLegacyImport("#internal", anonymousConsumer, importConditions),
      "ERR_PACKAGE_IMPORT_NOT_DEFINED",
    );
    expectCode(
      () =>
        resolveLegacyImport(
          "missing-package",
          anonymousConsumer,
          importConditions,
        ),
      "ERR_MODULE_NOT_FOUND",
    );
  });
});

test("rejects invalid package maps and paths without exposing non-exported files", () => {
  withTemporaryDirectory("import-sync-legacy-invalid-", (root) => {
    const consumer = join(root, "consumer.cjs");
    const resolve = (id: string) =>
      resolveLegacyImport(id, consumer, importConditions);
    createPackage(
      root,
      {
        name: "app",
        imports: null,
        exports: { ".": "./index.mjs", import: "./index.mjs" },
      },
      ["index.mjs"],
    );
    expectCode(() => resolve("app"), "ERR_INVALID_PACKAGE_CONFIG");
    expectCode(() => resolve("#undefined"), "ERR_PACKAGE_IMPORT_NOT_DEFINED");

    const other = join(root, "node_modules", "other");
    createPackage(other, { name: "other", exports: [null, "./entry.mjs"] }, [
      "entry.mjs",
    ]);
    expectFile(resolve("other"), join(other, "entry.mjs"));

    const noPackage = join(root, "node_modules", "no-package", "sub.cjs");
    expectCode(
      () => resolveLegacyImport("#unknown", noPackage, importConditions),
      "ERR_PACKAGE_IMPORT_NOT_DEFINED",
    );
  });
});
