import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

test.each(["cjs", "mjs"])(
  "supports Node 22 without registerHooks in a %s consumer",
  (extension) => {
    withTemporaryDirectory("import-sync-pre-hooks-", (root) => {
      const packageDir = join(root, "node_modules", "import-only");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "import-only",
          type: "module",
          exports: { import: "./index.mjs" },
        }),
      );
      writeFileSync(
        join(packageDir, "index.mjs"),
        "export const value = 42;\n",
      );
      writeFileSync(join(root, "local.mjs"), "export const value = 17;\n");
      const prefix =
        extension === "cjs"
          ? `const nodeModule = require("node:module");
nodeModule.registerHooks = undefined;
nodeModule.syncBuiltinESMExports();
const importSync = require(${JSON.stringify(libraryPath)});
`
          : `import { createRequire } from "node:module";
const nodeModule = createRequire(import.meta.url)("node:module");
nodeModule.registerHooks = undefined;
nodeModule.syncBuiltinESMExports();
const { default: importSync } = await import(${JSON.stringify(pathToFileURL(libraryPath).href)});
`;
      const consumer = join(root, `consumer.${extension}`);
      writeFileSync(
        consumer,
        `${prefix}console.log(JSON.stringify({
  relative: importSync("./local").value,
  queried: importSync("./local.mjs?probe=1").value,
  package: importSync("import-only").value,
}));
`,
      );
      expect(JSON.parse(runConsumer(consumer, root))).toEqual({
        relative: 17,
        queried: 17,
        package: 42,
      });
    });
  },
  12_000,
);

test.each(["cjs", "mjs"])(
  "matches native import-only package and alias resolution without hooks for %s consumers",
  (extension) => {
    withTemporaryDirectory("import-sync-legacy-native-parity-", (root) => {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "legacy-consumer",
          type: "module",
          imports: {
            "#internal": { import: "./internal.mjs?private=1" },
            "#nested": { import: "#internal" },
            "#external": { import: "only-import" },
            "#external/*": { import: "only-import/*" },
            "#builtin": { import: "node:fs" },
            "#blocked": null,
          },
          exports: { "./self": { import: "./internal.mjs#self" } },
        }),
      );
      writeFileSync(
        join(root, "internal.mjs"),
        "export const url = import.meta.url;\n",
      );
      const packageRoot = join(root, "node_modules", "only-import");
      mkdirSync(join(packageRoot, "features"), { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "only-import",
          type: "module",
          exports: {
            ".": { import: "./entry.mjs?main=1" },
            "./features/*": { import: "./features/*.mjs" },
            "./encoded": { import: "./entry%2520name.mjs#literal" },
            "./nested": {
              import: { custom: "./custom.mjs", default: "./entry.mjs" },
            },
            "./blocked": null,
          },
        }),
      );
      for (const filename of [
        "entry.mjs",
        "features/one.mjs",
        "entry%20name.mjs",
        "custom.mjs",
      ]) {
        const target = join(packageRoot, filename);
        writeFileSync(target, "export const url = import.meta.url;\n");
      }
      const prefix =
        extension === "cjs"
          ? `const nodeModule = require("node:module");
nodeModule.registerHooks = undefined;
nodeModule.syncBuiltinESMExports();
const importSync = require(${JSON.stringify(libraryPath)});
`
          : `import { createRequire } from "node:module";
const nodeModule = createRequire(import.meta.url)("node:module");
nodeModule.registerHooks = undefined;
nodeModule.syncBuiltinESMExports();
const { default: importSync } = await import(${JSON.stringify(pathToFileURL(libraryPath).href)});
`;
      const consumer = join(root, `consumer.${extension}`);
      writeFileSync(
        consumer,
        `${prefix}
(async () => {
  const ids = ["only-import", "only-import/features/one", "only-import/encoded", "only-import/nested", "#internal", "#external", "#external/features/one", "legacy-consumer/self"];
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const normalise = (value) => {
    const url = new URL(value);
    return JSON.stringify([realpathSync(fileURLToPath(url)), url.search, url.hash]);
  };
  const mismatch = [];
  for (const id of ids) {
    try {
      const actual = importSync(id).url;
      const expected = (await import(id)).url;
      if (normalise(actual) !== normalise(expected)) mismatch.push({ id, actual, expected });
    } catch (error) { throw new Error("Failed " + id, { cause: error }); }
  }
  const errors = ["only-import/blocked", "#blocked"].map((id) => {
    try { importSync(id); return "missing"; }
    catch (error) { return error.code; }
  });
  console.log(JSON.stringify({ mismatch, errors, builtin: typeof importSync("#builtin").readFileSync }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
      );
      expect(
        JSON.parse(runConsumer(consumer, root, { flags: ["-C", "custom"] })),
      ).toEqual({
        mismatch: [],
        errors: [
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
          "ERR_PACKAGE_IMPORT_NOT_DEFINED",
        ],
        builtin: "function",
      });
    });
  },
  15_000,
);
