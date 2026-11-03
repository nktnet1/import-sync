import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import importSync from "../../src";

test("does not run a successfully imported module with no exports twice", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-empty-esm-")),
  );
  try {
    const marker = join(root, "executions.txt");
    const fixture = join(root, "no-exports.mjs");
    writeFileSync(
      fixture,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\n`,
    );

    const result = importSync(fixture);

    expect(Object.keys(result)).toEqual([]);
    expect(importSync(fixture)).toBe(result);
    expect(readFileSync(marker, "utf8")).toBe("x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
