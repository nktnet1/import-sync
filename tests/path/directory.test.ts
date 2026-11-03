import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import importSync from "#/index.ts";
import {
  createPackageDirectory,
  withTemporaryDirectory,
} from "../helpers/fixtures.ts";

const createDirectoryPackage = (
  root: string,
  name: string,
  source: string,
): string => {
  return createPackageDirectory(
    root,
    name,
    "entry.mjs",
    `export const source = ${JSON.stringify(source)};\n`,
  );
};

test("loads a relative directory using its package entry point", () => {
  withTemporaryDirectory("import-sync-dir-", (root) => {
    createDirectoryPackage(root, "fixture", "directory package");

    expect(importSync("./fixture", { basePath: root }).source).toBe(
      "directory package",
    );
  });
});

test("treats an explicit trailing slash as a directory, even when a file shadows it", () => {
  withTemporaryDirectory("import-sync-dir-trailing-", (root) => {
    createDirectoryPackage(root, "fixture", "directory entry");
    writeFileSync(
      join(root, "fixture.mjs"),
      'export const source = "sibling file";\n',
    );

    expect(importSync("./fixture", { basePath: root }).source).toBe(
      "sibling file",
    );
    expect(importSync("./fixture/", { basePath: root }).source).toBe(
      "directory entry",
    );
    expect(importSync(join(root, "fixture/")).source).toBe("directory entry");
  });
});

test.each(["./entry.mjs/", "./entry/"])(
  "rejects trailing directory separators for an ordinary file: %s",
  (specifier) => {
    withTemporaryDirectory("import-sync-dir-reject-file-", (root) => {
      writeFileSync(join(root, "entry.mjs"), "export const value = 42;\n");

      expect(() => importSync(specifier, { basePath: root })).toThrow(
        /directory/i,
      );
    });
  },
);

test.each([
  { specifier: ".", nesting: false },
  { specifier: "..", nesting: true },
])(
  "resolves directory shorthand $specifier against basePath, never a sibling module",
  ({ specifier, nesting }) => {
    withTemporaryDirectory("import-sync-directory-shorthand-", (root) => {
      const directory = createDirectoryPackage(root, "fixture", "directory");
      writeFileSync(
        join(root, "fixture.mjs"),
        'export const source = "sibling";\n',
      );
      if (nesting) {
        mkdirSync(join(directory, "nested"));
      }
      const basePath = nesting ? join(directory, "nested") : directory;

      expect(importSync(specifier, { basePath }).source).toBe("directory");
    });
  },
);
