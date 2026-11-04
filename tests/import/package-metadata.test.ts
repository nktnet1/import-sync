import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("every declared package entry points to a built file", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8"),
  ) as {
    main: string;
    module?: string;
    types: string;
    exports: Record<string, string>;
  };

  for (const entry of [pkg.main, pkg.module, pkg.types, pkg.exports["."]]) {
    if (entry) {
      expect(existsSync(resolve(projectRoot, entry)), entry).toBe(true);
    }
  }
});

test("the generated declaration references a source map that is packaged", () => {
  const declarations = readFileSync(
    resolve(projectRoot, "dist/index.d.cts"),
    "utf8",
  );
  const reference = /^\/\/# sourceMappingURL=(.+)$/m.exec(declarations);
  expect(reference?.[1]).toBe("index.d.cts.map");
  const mapping = JSON.parse(
    readFileSync(resolve(projectRoot, "dist", reference?.[1] ?? ""), "utf8"),
  ) as { version: number; file: string };
  expect(mapping).toMatchObject({ version: 3, file: "index.d.cts" });
});

test("maps private #/ specifiers to source files", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8"),
  ) as { imports: Record<string, string> };
  expect(pkg.imports).toEqual({ "#/*": "./src/*" });
});

// Node 22 rejects #/ specifiers; the published CommonJS bundle does not use
// these source-only imports and remains compatible with Node 22.
test.skipIf(Number(process.versions.node.split(".")[0]) < 24)(
  "natively resolves and loads #/ imports inside the package",
  () => {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { VALID_FILE_EXTENSIONS } from "#/config.ts"; console.log(JSON.stringify({ source: import.meta.resolve("#/config.ts"), extensions: VALID_FILE_EXTENSIONS }));',
      ],
      { cwd: projectRoot, encoding: "utf8", timeout: 8_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim()) as {
      source: string;
      extensions: string[];
    };
    expect(realpathSync(fileURLToPath(result.source))).toBe(
      realpathSync(resolve(projectRoot, "src/config.ts")),
    );
    expect(result.extensions).toEqual([
      ".js",
      ".mjs",
      ".cjs",
      ".ts",
      ".mts",
      ".cts",
    ]);
  },
);
