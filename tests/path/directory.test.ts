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

const createDirectoryPackage = (
  root: string,
  name: string,
  source: string,
): string => {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ main: "./entry.mjs" }),
  );
  writeFileSync(
    join(directory, "entry.mjs"),
    `export const source = ${JSON.stringify(source)};\n`,
  );
  return directory;
};

test("loads a relative directory using its package entry point", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "import-sync-dir-")));
  try {
    createDirectoryPackage(root, "fixture", "directory package");

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

test.each([
  { specifier: ".", nesting: false },
  { specifier: "..", nesting: true },
])(
  "resolves directory shorthand $specifier against basePath, never a sibling module",
  ({ specifier, nesting }) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-directory-shorthand-")),
    );
    try {
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
