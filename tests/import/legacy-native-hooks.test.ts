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
