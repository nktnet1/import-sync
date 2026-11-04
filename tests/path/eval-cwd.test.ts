import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

test.each([
  { mode: "eval", beforeChdir: true },
  { mode: "eval", beforeChdir: false },
  { mode: "stdin", beforeChdir: true },
  { mode: "stdin", beforeChdir: false },
])(
  "preserves the original $mode caller directory (loaded before chdir: $beforeChdir)",
  ({ mode, beforeChdir }) => {
    withTemporaryDirectory("import-sync-cli-eval-cwd-", (root) => {
      const nested = join(root, "nested");
      mkdirSync(nested);
      writeFileSync(
        join(root, "entry.mjs"),
        'export const source = "initial working directory";\n',
      );
      writeFileSync(
        join(nested, "entry.mjs"),
        'export const source = "changed working directory";\n',
      );

      const source = beforeChdir
        ? `const importSync = require(${JSON.stringify(libraryPath)});
const initial = importSync("./entry.mjs").source;
process.chdir("nested");
const after = importSync("./entry.mjs").source;
console.log(JSON.stringify({ initial, after }));`
        : `process.chdir("nested");
const importSync = require(${JSON.stringify(libraryPath)});
console.log(JSON.stringify({ after: importSync("./entry.mjs").source }));`;
      const result = spawnSync(
        process.execPath,
        mode === "eval" ? ["-e", source] : ["-"],
        {
          cwd: root,
          encoding: "utf8",
          input: mode === "stdin" ? source : undefined,
          timeout: 8_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ...(beforeChdir ? { initial: "initial working directory" } : {}),
        after: "initial working directory",
      });
    });
  },
);
