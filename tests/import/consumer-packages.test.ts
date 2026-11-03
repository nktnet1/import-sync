import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

/** Test resolution from a separate application, not from the library's node_modules. */
test.each(["cjs", "mjs"])(
  "imports packages belonging to an isolated %s consumer",
  (extension) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-consumer-")),
    );
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "caller-application",
          type: "module",
          imports: { "#internal": "./internal.mjs" },
          exports: { "./self": "./internal.mjs" },
        }),
      );
      writeFileSync(
        join(root, "internal.mjs"),
        'export const value = "caller package scope";\n',
      );
      const packageRoot = join(root, "node_modules", "caller-only-package");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "caller-only-package", main: "index.cjs" }),
      );
      writeFileSync(
        join(packageRoot, "index.cjs"),
        'module.exports = { origin: "consumer", value: 42 };\n',
      );

      const scopedRoot = join(root, "node_modules", "@scope", "caller-only");
      mkdirSync(scopedRoot, { recursive: true });
      writeFileSync(
        join(scopedRoot, "package.json"),
        JSON.stringify({
          name: "@scope/caller-only",
          type: "module",
          exports: { "./feature": "./feature.mjs" },
        }),
      );
      writeFileSync(
        join(scopedRoot, "feature.mjs"),
        'export const value = "scoped feature";\n',
      );

      const consumerFile = join(root, `consumer.${extension}`);
      const loadLibrary =
        extension === "mjs"
          ? `import importSync from ${JSON.stringify(pathToFileURL(libraryPath).href)};\n`
          : `const importSync = require(${JSON.stringify(libraryPath)});\n`;
      writeFileSync(
        consumerFile,
        `${loadLibrary}const result = {
  package: importSync("caller-only-package").value,
  scoped: importSync("@scope/caller-only/feature").value,
  internal: importSync("#internal").value,
  self: importSync("caller-application/self").value,
};
console.log(JSON.stringify(result));\n`,
      );
      const child = spawnSync(process.execPath, [consumerFile], {
        cwd: root,
        encoding: "utf8",
        timeout: 8_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        package: 42,
        scoped: "scoped feature",
        internal: "caller package scope",
        self: "caller package scope",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  12_000,
);

test("prefers the application's own installed package over the library's copy", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "import-sync-shadow-")));
  try {
    const packageRoot = join(root, "node_modules", "node-fetch");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "node-fetch", main: "index.cjs" }),
    );
    writeFileSync(
      join(packageRoot, "index.cjs"),
      'module.exports = { origin: "consumer" };\n',
    );
    const consumerFile = join(root, "consumer.cjs");
    writeFileSync(
      consumerFile,
      `const importSync = require(${JSON.stringify(libraryPath)});\nconsole.log(importSync("node-fetch").origin);\n`,
    );
    const child = spawnSync(process.execPath, [consumerFile], {
      cwd: root,
      encoding: "utf8",
      timeout: 8_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("consumer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
