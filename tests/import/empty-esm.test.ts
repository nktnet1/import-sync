import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import importSync from "#/index.ts";

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

      const result = importSync(id);

      expect(Object.keys(result)).toEqual([]);
      expect(importSync(id)).toBe(result);
      expect(readFileSync(marker, "utf8")).toBe("x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
