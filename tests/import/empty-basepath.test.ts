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
  "treats an empty basePath as the working directory for a %s consumer",
  (extension) => {
    withTemporaryDirectory("import-sync-empty-basepath-", (root) => {
      const callerDirectory = join(root, "nested");
      mkdirSync(callerDirectory);
      writeFileSync(
        join(root, "entry.mjs"),
        'export const source = "working directory";\n',
      );
      writeFileSync(
        join(callerDirectory, "entry.mjs"),
        'export const source = "caller directory";\n',
      );
      const consumer = join(callerDirectory, `consumer.${extension}`);
      const libraryImport =
        extension === "mjs"
          ? `import importSync from ${JSON.stringify(pathToFileURL(libraryPath).href)};`
          : `const importSync = require(${JSON.stringify(libraryPath)});`;
      writeFileSync(
        consumer,
        `${libraryImport}\nconsole.log(JSON.stringify({
  empty: importSync("./entry.mjs", { basePath: "" }).source,
  dot: importSync("./entry.mjs", { basePath: "." }).source,
  omitted: importSync("./entry.mjs").source,
}));\n`,
      );
      expect(JSON.parse(runConsumer(consumer, root))).toEqual({
        empty: "working directory",
        dot: "working directory",
        omitted: "caller directory",
      });
    });
  },
);
