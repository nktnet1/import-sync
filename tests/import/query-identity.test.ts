import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

test.each([
  { extension: "cjs", syntax: "cjs", suffix: "?v=1", relative: false },
  { extension: "cjs", syntax: "cjs", suffix: "#fragment", relative: false },
  { extension: "cjs", syntax: "cjs", suffix: "?v=1", relative: true },
  { extension: "js", syntax: "esm", suffix: "?v=1", relative: false },
  { extension: "js", syntax: "esm", suffix: "#fragment", relative: true },
])(
  "does not re-execute $syntax through a $extension URL with $suffix (relative: $relative)",
  ({ extension, syntax, suffix, relative }) => {
    withTemporaryDirectory("import-sync-query-identity-", (root) => {
      if (syntax === "esm") {
        writeFileSync(join(root, "package.json"), '{"type":"module"}');
      }
      const marker = join(root, "executions.txt");
      const filename = join(root, `entry.${extension}`);
      writeFileSync(
        filename,
        syntax === "cjs"
          ? `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"); module.exports = {};\n`
          : `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "x"); const empty = {}; export { empty as "module.exports" };\n`,
      );
      const id = relative
        ? `./entry.${extension}${suffix}`
        : `${pathToFileURL(filename).href}${suffix}`;
      const consumer = join(root, "consumer.cjs");
      writeFileSync(
        consumer,
        `const { readFileSync } = require("node:fs");
const importSync = require(${JSON.stringify(libraryPath)});
const first = importSync(${JSON.stringify(id)});
const second = importSync(${JSON.stringify(id)});
console.log(JSON.stringify({ count: readFileSync(${JSON.stringify(marker)}, "utf8"), cached: first === second, keys: Reflect.ownKeys(first) }));
`,
      );
      expect(JSON.parse(runConsumer(consumer, root))).toEqual({
        count: "x",
        cached: true,
        keys: [],
      });
    });
  },
  12_000,
);
