import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import importSync from "#/index.ts";

test("loads a relative directory using its package entry point", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "import-sync-dir-")));
  try {
    const directory = join(root, "fixture");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ main: "./entry.mjs" }),
    );
    writeFileSync(
      join(directory, "entry.mjs"),
      'export const source = "directory package";\n',
    );

    expect(importSync("./fixture", { basePath: root }).source).toBe(
      "directory package",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
