import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

test.each(["cjs", "mjs"])(
  "initialises for %s consumers when an unrelated built-in is blocked by a resolver hook",
  (extension) => {
    withTemporaryDirectory("import-sync-startup-hook-", (root) => {
      writeFileSync(join(root, "entry.mjs"), "export const value = 42;\n");
      const consumer = join(root, `consumer.${extension}`);
      const source =
        extension === "mjs"
          ? `import { registerHooks } from "node:module";
const hook = registerHooks({ resolve(id, context, nextResolve) {
  if (id === "node:os") throw new Error("blocked unrelated node:os");
  return nextResolve(id, context);
}});
try {
  const { default: importSync } = await import(${JSON.stringify(pathToFileURL(libraryPath).href)});
  console.log(importSync("./entry.mjs").value);
} finally { hook.deregister(); }
`
          : `const { registerHooks } = require("node:module");
const hook = registerHooks({ resolve(id, context, nextResolve) {
  if (id === "node:os") throw new Error("blocked unrelated node:os");
  return nextResolve(id, context);
}});
try {
  const importSync = require(${JSON.stringify(libraryPath)});
  console.log(importSync("./entry.mjs").value);
} finally { hook.deregister(); }
`;
      writeFileSync(consumer, source);
      expect(runConsumer(consumer, root)).toBe("42");
    });
  },
);
