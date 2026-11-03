import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import importSync from "#/index.ts";
import {
  createPackageDirectory,
  withTemporaryDirectory,
} from "../helpers/fixtures.ts";

function expectOnlyOneExecution(specifier: string, marker: string): void {
  const result = importSync(specifier);

  expect(Object.keys(result)).toEqual([]);
  expect(importSync(specifier)).toBe(result);
  expect(readFileSync(marker, "utf8")).toBe("x");
}

test("does not run a successfully imported module with no exports twice", () => {
  withTemporaryDirectory("import-sync-empty-esm-", (root) => {
    const marker = join(root, "executions.txt");
    const fixture = join(root, "no-exports.mjs");
    writeFileSync(
      fixture,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\n`,
    );

    expectOnlyOneExecution(fixture, marker);
  });
});

test.each([
  { specifier: "path", exportValue: "const direct = {};" },
  { specifier: "file URL", exportValue: "const direct = {};" },
  { specifier: "file URL with query", exportValue: "const direct = {};" },
  {
    specifier: "path with a Proxy export",
    exportValue:
      'const direct = new Proxy({}, { isExtensible() { throw new Error("unexpected Proxy inspection"); } });',
  },
])(
  'does not execute an ESM "module.exports" empty object twice via $specifier',
  ({ specifier, exportValue }) => {
    withTemporaryDirectory("import-sync-empty-direct-esm-", (root) => {
      const marker = join(root, "executions.txt");
      const fixture = join(root, "empty direct #%.mjs");
      writeFileSync(
        fixture,
        `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\n${exportValue}\nexport { direct as "module.exports" };\n`,
      );
      let id = specifier.startsWith("file URL")
        ? pathToFileURL(fixture).href
        : fixture;
      if (specifier === "file URL with query") {
        id += "?v=1";
      }

      expectOnlyOneExecution(id, marker);
    });
  },
);

// On Windows, creating symlinks requires privileges that CI runners may not have.
test.skipIf(process.platform === "win32").each(["", ".cjs", ".js"])(
  "does not execute an ESM module twice through a symlink with suffix %s",
  (suffix) => {
    withTemporaryDirectory("import-sync-symlink-esm-", (root) => {
      const marker = join(root, "executions.txt");
      const source = join(root, "source.mjs");
      const alias = join(root, `alias${suffix}`);
      writeFileSync(
        source,
        `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nconst value = {}; export { value as "module.exports" };\n`,
      );
      symlinkSync(source, alias, "file");

      expectOnlyOneExecution(alias, marker);
    });
  },
);

test("does not execute an ESM directory package main twice", () => {
  withTemporaryDirectory("import-sync-directory-esm-", (root) => {
    const marker = join(root, "executions.txt");
    const directory = createPackageDirectory(
      root,
      "package",
      "entry.mjs",
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nconst value = {}; export { value as "module.exports" };\n`,
    );

    expectOnlyOneExecution(directory, marker);
  });
});
