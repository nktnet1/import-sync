import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findModuleFile } from "../../src/files";

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
