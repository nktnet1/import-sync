import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

const libraryImport = (extension: string): string =>
  extension === "mjs"
    ? `import importSync from ${JSON.stringify(pathToFileURL(libraryPath).href)};\n`
    : `const importSync = require(${JSON.stringify(libraryPath)});\n`;

/** Write a package into the isolated application's own node_modules. */
function writeIsolatedPackage(
  root: string,
  name: string,
  metadata: Record<string, unknown>,
  modules: Record<string, string>,
): void {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(metadata));
  for (const [filename, source] of Object.entries(modules)) {
    const modulePath = join(directory, filename);
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, source);
  }
}

/** Each consumer executes against the built package from its own directory. */
function expectConsumerResult(
  root: string,
  extension: string,
  source: string,
  expected: Record<string, unknown>,
): void {
  const consumer = join(root, `consumer.${extension}`);
  writeFileSync(consumer, `${libraryImport(extension)}${source}`);
  expect(JSON.parse(runConsumer(consumer, root))).toEqual(expected);
}

/** Run both published-package consumer formats with identical test isolation. */
function testIsolatedConsumers(
  name: string,
  directoryPrefix: string,
  verify: (root: string, extension: string) => void,
): void {
  test.each(["cjs", "mjs"])(
    name,
    (extension) =>
      withTemporaryDirectory(directoryPrefix, (root) =>
        verify(root, extension),
      ),
    12_000,
  );
}

/** Test resolution from a separate application, not from the library's node_modules. */
testIsolatedConsumers(
  "imports packages belonging to an isolated %s consumer",
  "import-sync-consumer-",
  (root, extension) => {
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
    writeIsolatedPackage(
      root,
      "caller-only-package",
      { name: "caller-only-package", main: "index.cjs" },
      {
        "index.cjs": 'module.exports = { origin: "consumer", value: 42 };\n',
      },
    );
    writeIsolatedPackage(
      root,
      "@scope/caller-only",
      {
        name: "@scope/caller-only",
        type: "module",
        exports: { "./feature": "./feature.mjs" },
      },
      { "feature.mjs": 'export const value = "scoped feature";\n' },
    );

    expectConsumerResult(
      root,
      extension,
      `const result = {
  package: importSync("caller-only-package").value,
  scoped: importSync("@scope/caller-only/feature").value,
  internal: importSync("#internal").value,
  self: importSync("caller-application/self").value,
};
console.log(JSON.stringify(result));\n`,
      {
        package: 42,
        scoped: "scoped feature",
        internal: "caller package scope",
        self: "caller package scope",
      },
    );
  },
);

testIsolatedConsumers(
  "accepts mixed-case file URL schemes in a built %s consumer",
  "import-sync-file-scheme-",
  (root, extension) => {
    const esmFile = join(root, "entry.mjs");
    const cjsFile = join(root, "entry.cjs");
    writeFileSync(esmFile, 'export const value = "esm";\n');
    writeFileSync(cjsFile, 'module.exports = { value: "cjs" };\n');
    const esmURL = pathToFileURL(esmFile).href.replace(/^file:/, "FILE:");
    const cjsURL = pathToFileURL(cjsFile).href.replace(/^file:/, "FiLe:");
    expectConsumerResult(
      root,
      extension,
      `const esm = importSync(${JSON.stringify(esmURL)});
const cjs = importSync(${JSON.stringify(cjsURL)});
console.log(JSON.stringify({ esm: esm.value, cjs: cjs.value, cached: importSync(${JSON.stringify(esmURL)}) === esm }));
`,
      {
        esm: "esm",
        cjs: "cjs",
        cached: true,
      },
    );
  },
);

test("prefers the application's own installed package over the library's copy", () => {
  withTemporaryDirectory("import-sync-shadow-", (root) => {
    writeIsolatedPackage(
      root,
      "node-fetch",
      { name: "node-fetch", main: "index.cjs" },
      { "index.cjs": 'module.exports = { origin: "consumer" };\n' },
    );
    const consumerFile = join(root, "consumer.cjs");
    writeFileSync(
      consumerFile,
      `const importSync = require(${JSON.stringify(libraryPath)});\nconsole.log(importSync("node-fetch").origin);\n`,
    );
    expect(runConsumer(consumerFile, root)).toBe("consumer");
  });
});

testIsolatedConsumers(
  "loads import-only conditional exports in isolated %s consumers",
  "import-sync-import-conditions-",
  (root, extension) => {
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

    writeIsolatedPackage(
      root,
      "only-import",
      {
        name: "only-import",
        type: "module",
        exports: {
          ".": { import: "./index.mjs" },
          "./features/*": { import: "./features/*.mjs" },
        },
      },
      {
        "index.mjs": 'export const value = "import only";\n',
        "features/one.mjs": 'export const value = "import feature";\n',
      },
    );
    writeIsolatedPackage(
      root,
      "dual-conditions",
      {
        name: "dual-conditions",
        type: "module",
        exports: {
          ".": { import: "./import.mjs", require: "./require.cjs" },
        },
      },
      {
        "import.mjs": 'export const value = "import side";\n',
        "require.cjs": 'module.exports = { value: "require side" };\n',
      },
    );

    expectConsumerResult(
      root,
      extension,
      `const result = {
  onlyImport: importSync("only-import").value,
  importSubpath: importSync("only-import/features/one").value,
  importAlias: importSync("#import-only").value,
  dualAlias: importSync("#dual").value,
  self: importSync("conditional-consumer/self").value,
  dualPackage: importSync("dual-conditions").value,
};
console.log(JSON.stringify(result));\n`,
      {
        onlyImport: "import only",
        importSubpath: "import feature",
        importAlias: "import alias",
        dualAlias: "require alias",
        self: "self import",
        dualPackage: "require side",
      },
    );
  },
);

test("matches native ESM import conditions, including custom flags and built-ins", () => {
  withTemporaryDirectory("import-sync-native-conditions-", (root) => {
    const packageRoot = join(root, "node_modules", "conditional-library");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "conditional-library",
        type: "module",
        exports: {
          "./environment": {
            import: {
              '"development"': "./double-quote.mjs",
              "'development'": "./single-quote.mjs",
              'a"b': "./escaped-quote.mjs",
              "a\\b": "./escaped-backslash.mjs",
              "a b": "./escaped-space.mjs",
              aqb: "./escaped-letter.mjs",
              "a\\qb": "./literal-backslash.mjs",
              ab: "./joined-quote.mjs",
              development: "./development.mjs",
              default: "./default.mjs",
            },
          },
          "./addon": {
            import: { "node-addons": "./addon.mjs", default: "./default.mjs" },
          },
          "./sync": {
            import: { "module-sync": "./sync.mjs", default: "./default.mjs" },
          },
        },
      }),
    );
    for (const name of [
      "development",
      "default",
      "addon",
      "sync",
      "double-quote",
      "single-quote",
      "escaped-quote",
      "escaped-backslash",
      "escaped-space",
      "escaped-letter",
      "literal-backslash",
      "joined-quote",
    ]) {
      writeFileSync(
        join(packageRoot, `${name}.mjs`),
        `export const value = ${JSON.stringify(name)};\n`,
      );
    }

    const consumerFile = join(root, "consumer.cjs");
    writeFileSync(
      consumerFile,
      `${libraryImport("cjs")}(async () => {
  const ids = ["environment", "addon", "sync"].map((name) => "conditional-library/" + name);
  const native = await Promise.all(ids.map(async (id) => (await import(id)).value));
  const actual = ids.map((id) => importSync(id).value);
  console.log(JSON.stringify({ native, actual }));
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
    );

    const cases = [
      { flags: [], nodeOptions: "", expected: ["default", "addon", "sync"] },
      {
        flags: ["--conditions=development"],
        nodeOptions: "",
        expected: ["development", "addon", "sync"],
      },
      {
        flags: ["-C", "development"],
        nodeOptions: "",
        expected: ["development", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: "--conditions=development",
        expected: ["development", "addon", "sync"],
      },
      {
        flags: ['--conditions="development"'],
        nodeOptions: "",
        expected: ["double-quote", "addon", "sync"],
      },
      {
        flags: ["--conditions='development'"],
        nodeOptions: "",
        expected: ["single-quote", "addon", "sync"],
      },
      {
        flags: ["--conditions", '"development"'],
        nodeOptions: "",
        expected: ["double-quote", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: "--conditions='development'",
        expected: ["single-quote", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: '--conditions="development"',
        expected: ["development", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: String.raw`--conditions="a\"b"`,
        expected: ["escaped-quote", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: String.raw`--conditions="a\\b"`,
        expected: ["escaped-backslash", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: String.raw`--conditions="a\ b"`,
        expected: ["escaped-space", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: String.raw`--conditions="a\qb"`,
        expected: ["escaped-letter", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: String.raw`--conditions=a\qb`,
        expected: ["literal-backslash", "addon", "sync"],
      },
      {
        flags: [],
        nodeOptions: String.raw`--conditions="a""b"`,
        expected: ["joined-quote", "addon", "sync"],
      },
      {
        flags: ["--no-addons"],
        nodeOptions: "",
        expected: ["default", "default", "sync"],
      },
      {
        flags: ["--no-experimental-require-module"],
        nodeOptions: "",
        expected: ["default", "addon", "default"],
      },
    ];

    for (const { flags, nodeOptions, expected } of cases) {
      expect(
        JSON.parse(runConsumer(consumerFile, root, { flags, nodeOptions })),
      ).toEqual({
        native: expected,
        actual: expected,
      });
    }
  });
}, 45_000);

testIsolatedConsumers(
  "keeps the startup import conditions after %s consumers mutate process flags",
  "import-sync-startup-conditions-",
  (root, extension) => {
    writeIsolatedPackage(
      root,
      "startup-conditions",
      {
        name: "startup-conditions",
        type: "module",
        exports: {
          import: {
            startup: "./startup.mjs",
            runtime: "./runtime.mjs",
            default: "./default.mjs",
          },
        },
      },
      {
        "startup.mjs": 'export const value = "startup";\n',
        "runtime.mjs": 'export const value = "runtime";\n',
        "default.mjs": 'export const value = "default";\n',
      },
    );
    const consumer = join(root, `consumer.${extension}`);
    writeFileSync(
      consumer,
      `${libraryImport(extension)}
(async () => {
  // Neither change affects Node's native import conditions in this process.
  process.env.NODE_OPTIONS = "--conditions=runtime";
  process.execArgv.length = 0;
  process.execArgv.push("--conditions=runtime");
  const native = (await import("startup-conditions")).value;
  const wrapper = importSync("startup-conditions").value;
  console.log(JSON.stringify({ native, wrapper }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
    );

    for (const { name, flags, nodeOptions, expected } of [
      { name: "default", flags: [], nodeOptions: "", expected: "default" },
      {
        name: "NODE_OPTIONS",
        flags: [],
        nodeOptions: "--conditions=startup",
        expected: "startup",
      },
      {
        name: "CLI",
        flags: ["--conditions=startup"],
        nodeOptions: "",
        expected: "startup",
      },
    ]) {
      expect(
        JSON.parse(runConsumer(consumer, root, { flags, nodeOptions })),
        name,
      ).toEqual({ native: expected, wrapper: expected });
    }
  },
);

testIsolatedConsumers(
  "resolves . and .. from actual %s consumer directories",
  "import-sync-dir-consumer-",
  (root, extension) => {
    const project = join(root, "project");
    const nested = join(project, "nested");
    mkdirSync(nested, { recursive: true });
    for (const [directory, source] of [
      [project, "parent"],
      [nested, "current"],
    ] as const) {
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ type: "module", main: "./entry.mjs" }),
      );
      writeFileSync(
        join(directory, "entry.mjs"),
        `export const source = ${JSON.stringify(source)};\n`,
      );
    }
    writeFileSync(
      join(project, "nested.mjs"),
      'export const source = "wrong sibling";\n',
    );
    const consumer = join(nested, `consumer.${extension}`);
    writeFileSync(
      consumer,
      `${libraryImport(extension)}const result = {
  current: importSync(".").source,
  parent: importSync("..").source,
  explicit: importSync(".", { basePath: ${JSON.stringify(project)} }).source,
};
console.log(JSON.stringify(result));\n`,
    );
    expect(JSON.parse(runConsumer(consumer, root))).toEqual({
      current: "current",
      parent: "parent",
      explicit: "parent",
    });
  },
);
