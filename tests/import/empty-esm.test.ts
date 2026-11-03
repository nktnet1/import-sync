import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import importSync from "#/index.ts";

function expectOnlyOneExecution(specifier: string, marker: string): void {
  const result = importSync(specifier);

  expect(Object.keys(result)).toEqual([]);
  expect(importSync(specifier)).toBe(result);
  expect(readFileSync(marker, "utf8")).toBe("x");
}

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

    expectOnlyOneExecution(fixture, marker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-empty-direct-esm-")),
    );
    try {
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// On Windows, creating symlinks requires privileges that CI runners may not have.
test.skipIf(process.platform === "win32").each(["", ".cjs", ".js"])(
  "does not execute an ESM module twice through a symlink with suffix %s",
  (suffix) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-symlink-esm-")),
    );
    try {
      const marker = join(root, "executions.txt");
      const source = join(root, "source.mjs");
      const alias = join(root, `alias${suffix}`);
      writeFileSync(
        source,
        `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nconst value = {}; export { value as "module.exports" };\n`,
      );
      symlinkSync(source, alias, "file");

      expectOnlyOneExecution(alias, marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("does not execute an ESM directory package main twice", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-directory-esm-")),
  );
  try {
    const marker = join(root, "executions.txt");
    const directory = join(root, "package");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ main: "./entry.mjs" }),
    );
    writeFileSync(
      join(directory, "entry.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nconst value = {}; export { value as "module.exports" };\n`,
    );

    expectOnlyOneExecution(directory, marker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
