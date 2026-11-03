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

test("treats an explicit trailing slash as a directory, even when a file shadows it", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-dir-trailing-")),
  );
  try {
    const directory = join(root, "fixture");
    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ main: "./entry.mjs" }),
    );
    writeFileSync(
      join(directory, "entry.mjs"),
      'export const source = "directory entry";\n',
    );
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["./entry.mjs/", "./entry/"])(
  "rejects trailing directory separators for an ordinary file: %s",
  (specifier) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-dir-reject-file-")),
    );
    try {
      writeFileSync(join(root, "entry.mjs"), "export const value = 42;\n");

      expect(() => importSync(specifier, { basePath: root })).toThrow(
        /directory/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
