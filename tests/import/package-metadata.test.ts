import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the package exposes callable CJS and ESM type declarations", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8"),
  ) as {
    main: string;
    types: string;
    exports: Record<string, unknown>;
  };
  expect(pkg.main).toBe("./dist/index.cjs");
  expect(pkg.types).toBe("./dist/index.d.cts");
  expect(pkg.exports["."]).toEqual({
    types: {
      import: "./dist/index.d.mts",
      require: "./dist/index.d.cts",
    },
    default: "./dist/index.cjs",
  });
  for (const entry of [
    pkg.main,
    pkg.types,
    "./dist/index.d.mts",
    "./dist/index.d.mts.map",
  ]) {
    expect(existsSync(resolve(projectRoot, entry)), entry).toBe(true);
  }
});

test("the ESM declaration map includes its original source text", () => {
  const declarations = readFileSync(
    resolve(projectRoot, "dist/index.d.mts"),
    "utf8",
  );
  const reference = /^\/\/# sourceMappingURL=(.+)$/m.exec(declarations);
  expect(reference?.[1]).toBe("index.d.mts.map");
  const mapping = JSON.parse(
    readFileSync(resolve(projectRoot, "dist", reference?.[1] ?? ""), "utf8"),
  ) as {
    version: number;
    file: string;
    sources: string[];
    sourcesContent: string[];
  };
  expect(mapping).toMatchObject({ version: 3, file: "index.d.mts" });
  expect(mapping.sourcesContent).toHaveLength(mapping.sources.length);
  expect(mapping.sourcesContent.every((source) => source.length > 0)).toBe(
    true,
  );
  expect(
    readFileSync(resolve(projectRoot, "dist/index.d.cts"), "utf8"),
  ).toContain("export = importSync");
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
