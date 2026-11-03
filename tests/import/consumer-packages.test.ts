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

const libraryImport = (extension: string): string =>
  extension === "mjs"
    ? `import importSync from ${JSON.stringify(pathToFileURL(libraryPath).href)};\n`
    : `const importSync = require(${JSON.stringify(libraryPath)});\n`;

const runConsumer = (consumerFile: string, root: string): string => {
  const child = spawnSync(process.execPath, [consumerFile], {
    cwd: root,
    encoding: "utf8",
    timeout: 8_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return child.stdout.trim();
};

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
      const loadLibrary = libraryImport(extension);
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
      expect(JSON.parse(runConsumer(consumerFile, root))).toEqual({
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
    expect(runConsumer(consumerFile, root)).toBe("consumer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["cjs", "mjs"])(
  "loads import-only conditional exports in isolated %s consumers",
  (extension) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-import-conditions-")),
    );
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "conditional-consumer",
          type: "module",
          imports: {
            "#import-only": { import: "./internal.mjs" },
            "#dual": {
              import: "./internal.mjs",
              require: "./internal.cjs",
            },
          },
          exports: { "./self": { import: "./self.mjs" } },
        }),
      );
      writeFileSync(
        join(root, "internal.mjs"),
        'export const value = "import alias";\n',
      );
      writeFileSync(
        join(root, "internal.cjs"),
        'module.exports = { value: "require alias" };\n',
      );
      writeFileSync(
        join(root, "self.mjs"),
        'export const value = "self import";\n',
      );

      const onlyImport = join(root, "node_modules", "only-import");
      mkdirSync(join(onlyImport, "features"), { recursive: true });
      writeFileSync(
        join(onlyImport, "package.json"),
        JSON.stringify({
          name: "only-import",
          type: "module",
          exports: {
            ".": { import: "./index.mjs" },
            "./features/*": { import: "./features/*.mjs" },
          },
        }),
      );
      writeFileSync(
        join(onlyImport, "index.mjs"),
        'export const value = "import only";\n',
      );
      writeFileSync(
        join(onlyImport, "features", "one.mjs"),
        'export const value = "import feature";\n',
      );

      const dual = join(root, "node_modules", "dual-conditions");
      mkdirSync(dual, { recursive: true });
      writeFileSync(
        join(dual, "package.json"),
        JSON.stringify({
          name: "dual-conditions",
          type: "module",
          exports: {
            ".": { import: "./import.mjs", require: "./require.cjs" },
          },
        }),
      );
      writeFileSync(
        join(dual, "import.mjs"),
        'export const value = "import side";\n',
      );
      writeFileSync(
        join(dual, "require.cjs"),
        'module.exports = { value: "require side" };\n',
      );

      const consumerFile = join(root, `consumer.${extension}`);
      writeFileSync(
        consumerFile,
        `${libraryImport(extension)}const result = {
  onlyImport: importSync("only-import").value,
  importSubpath: importSync("only-import/features/one").value,
  importAlias: importSync("#import-only").value,
  dualAlias: importSync("#dual").value,
  self: importSync("conditional-consumer/self").value,
  dualPackage: importSync("dual-conditions").value,
};
console.log(JSON.stringify(result));\n`,
      );

      expect(JSON.parse(runConsumer(consumerFile, root))).toEqual({
        onlyImport: "import only",
        importSubpath: "import feature",
        importAlias: "import alias",
        dualAlias: "require alias",
        self: "self import",
        dualPackage: "require side",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  12_000,
);
