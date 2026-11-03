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
import { findModuleFile, isRelativePath } from "../../src/files";

test("uses the documented extension precedence and prefers exact files", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-extensions-")),
  );
  try {
    const file = join(root, "module");
    for (const extension of [".js", ".mjs", ".cjs", ".ts"]) {
      writeFileSync(`${file}${extension}`, "");
    }
    expect(findModuleFile(root, "./module")).toBe(`${file}.js`);
    rmSync(`${file}.js`);
    expect(findModuleFile(root, "./module")).toBe(`${file}.mjs`);
    rmSync(`${file}.mjs`);
    expect(findModuleFile(root, "./module")).toBe(`${file}.cjs`);
    rmSync(`${file}.cjs`);
    expect(findModuleFile(root, "./module")).toBe(`${file}.ts`);

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
      `No such file '${join(root, "missing")}' with matching extensions [.js,.mjs,.cjs,.ts]`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
