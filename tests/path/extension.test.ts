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
import {
  findModuleFile,
  isRelativePath,
  toESMRelativeSpecifier,
} from "#/files.ts";
import importSync from "#/index.ts";

test("uses the documented extension precedence and prefers exact files", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-extensions-")),
  );
  try {
    const file = join(root, "module");
    const extensions = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
    for (const extension of extensions) {
      writeFileSync(`${file}${extension}`, "");
    }
    for (const extension of extensions) {
      expect(findModuleFile(root, "./module")).toBe(`${file}${extension}`);
      rmSync(`${file}${extension}`);
    }

    writeFileSync(file, "");
    expect(findModuleFile(root, "./module")).toBe(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports the attempted path and extensions when nothing matches", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-missing-")),
  );
  try {
    expect(() => findModuleFile(root, "./missing")).toThrow(
      `No such file '${join(root, "missing")}' with matching extensions [.js,.mjs,.cjs,.ts,.mts,.cts]`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  { extension: ".ts", source: "export const value = 42;" },
  { extension: ".mts", source: "export const value = 42;" },
  { extension: ".cts", source: "module.exports = { value: 42 };" },
])(
  "loads JavaScript-syntax $extension files without an explicit extension",
  ({ extension, source }) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-ts-ext-")),
    );
    try {
      writeFileSync(join(root, `entry${extension}`), source);

      expect(importSync("./entry", { basePath: root })).toMatchObject({
        value: 42,
      });
      expect(importSync(join(root, "entry"))).toMatchObject({ value: 42 });
      expect(
        importSync(`./entry${extension}`, { basePath: root }),
      ).toMatchObject({ value: 42 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("ignores directories that look like extension matches", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-extension-directory-")),
  );
  try {
    const file = join(root, "module");
    mkdirSync(`${file}.js`);
    writeFileSync(`${file}.mjs`, "");

    expect(findModuleFile(root, "./module")).toBe(`${file}.mjs`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers an extension-bearing file over an equally named directory", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-file-before-directory-")),
  );
  try {
    mkdirSync(join(root, "module"));
    writeFileSync(join(root, "module.mjs"), "");

    expect(findModuleFile(root, "./module")).toBe(join(root, "module.mjs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("still accepts an existing directory when no file matches", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-directory-")),
  );
  try {
    mkdirSync(join(root, "directory"));

    expect(findModuleFile(root, "./directory")).toBe(join(root, "directory"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  { id: ".", separator: "/", expected: true },
  { id: "..", separator: "/", expected: true },
  { id: ".", separator: "\\", expected: true },
  { id: "..", separator: "\\", expected: true },
  { id: "./fixture", separator: "/", expected: true },
  { id: "../fixture", separator: "/", expected: true },
  { id: String.raw`.\fixture`, separator: "/", expected: false },
  { id: String.raw`..\fixture`, separator: "/", expected: false },
  { id: String.raw`.\fixture`, separator: "\\", expected: true },
  { id: String.raw`..\fixture`, separator: "\\", expected: true },
  { id: "fixture", separator: "\\", expected: false },
  { id: "./fixture", separator: "\\", expected: true },
])(
  "identifies relative $id paths with separator $separator",
  ({ id, separator, expected }) => {
    expect(isRelativePath(id, separator)).toBe(expected);
  },
);

// Node's ESM resolver accepts slash-delimited URL specifiers, while Windows
// callers may pass filesystem-style backslashes. Keep the conversion separate
// from filesystem lookup so both forms continue to resolve the same file.
test.each([
  { id: String.raw`.\basic`, separator: "\\", expected: "./basic" },
  {
    id: String.raw`..\folder\basic`,
    separator: "\\",
    expected: "../folder/basic",
  },
  {
    id: String.raw`./folder\basic`,
    separator: "\\",
    expected: "./folder/basic",
  },
  { id: "./basic", separator: "\\", expected: "./basic" },
  { id: String.raw`.\basic`, separator: "/", expected: String.raw`.\basic` },
  { id: "./basic", separator: "/", expected: "./basic" },
])(
  "uses ESM separators for $id on $separator",
  ({ id, separator, expected }) => {
    expect(toESMRelativeSpecifier(id, separator)).toBe(expected);
  },
);
