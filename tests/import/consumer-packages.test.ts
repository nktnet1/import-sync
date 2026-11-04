import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import importSync from "#/index.ts";
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

testIsolatedConsumers(
  "preserves percent characters in import-only package targets for %s consumers",
  "import-sync-package-literal-",
  (root, extension) => {
    writeIsolatedPackage(
      root,
      "literal-package",
      {
        name: "literal-package",
        type: "module",
        exports: { import: "./entry%2520name.mjs" },
      },
      {
        "entry%20name.mjs": 'export const value = "literal";\n',
        "entry name.mjs": 'export const value = "decoded";\n',
      },
    );

    expectConsumerResult(
      root,
      extension,
      "console.log(JSON.stringify({ value: importSync('literal-package').value }));\n",
      { value: "literal" },
    );
  },
);

testIsolatedConsumers(
  "preserves import-only export URL suffixes for %s consumers",
  "import-sync-package-suffix-",
  (root, extension) => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "suffix-consumer",
        type: "module",
        imports: {
          "#query": { import: "./internal.mjs?alias=1" },
          "#fragment": { import: "./internal.mjs#alias" },
        },
        exports: { "./self": { import: "./internal.mjs?self=1" } },
      }),
    );
    writeFileSync(
      join(root, "internal.mjs"),
      "export const url = import.meta.url;\n",
    );
    writeIsolatedPackage(
      root,
      "suffix-package",
      {
        name: "suffix-package",
        type: "module",
        exports: {
          ".": { import: "./entry.mjs?version=1" },
          "./other": { import: "./entry.mjs?version=2" },
          "./fragment": { import: "./entry.mjs#section" },
          "./encoded": { import: "./entry%2520name.mjs?version=3" },
        },
      },
      {
        "entry.mjs": "export const url = import.meta.url;\n",
        "entry%20name.mjs": "export const url = import.meta.url;\n",
      },
    );
    const ids = [
      "suffix-package",
      "suffix-package/other",
      "suffix-package/fragment",
      "suffix-package/encoded",
      "#query",
      "#fragment",
      "suffix-consumer/self",
    ];
    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const ids = ${JSON.stringify(ids)};
  const imported = ids.map((id) => importSync(id).url);
  const native = await Promise.all(ids.map(async (id) => (await import(id)).url));
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  // Windows may spell the same file with different drive-letter casing or
  // short/long path aliases. Compare canonical files and exact URL suffixes.
  const matches = (actual, expected) => {
    const actualURL = new URL(actual);
    const expectedURL = new URL(expected);
    return realpathSync.native(fileURLToPath(actualURL)) === realpathSync.native(fileURLToPath(expectedURL))
      && actualURL.search === expectedURL.search
      && actualURL.hash === expectedURL.hash;
  };
  const mismatches = imported.flatMap((url, index) => matches(url, native[index])
    ? [] : [{ id: ids[index], imported: url, native: native[index] }]);
  console.log(JSON.stringify({ identical: mismatches.length === 0, suffixes: imported.map((url) => new URL(url).search + new URL(url).hash), ...(mismatches.length ? { mismatches } : {}) }));
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      {
        identical: true,
        suffixes: [
          "?version=1",
          "?version=2",
          "#section",
          "?version=3",
          "?alias=1",
          "#alias",
          "?self=1",
        ],
      },
    );
  },
);

testIsolatedConsumers(
  "honours synchronous custom resolver hooks for %s consumers",
  "import-sync-hooked-specifier-",
  (root, extension) => {
    const modulePath = join(root, "hooked.mjs");
    writeFileSync(modulePath, "export const value = 42;\n");
    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const { registerHooks } = ${extension === "mjs" ? 'await import("node:module")' : 'require("node:module")'};
  const { pathToFileURL } = ${extension === "mjs" ? 'await import("node:url")' : 'require("node:url")'};
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id === "virtual:entry") return { url: pathToFileURL(${JSON.stringify(modulePath)}).href, shortCircuit: true };
      return nextResolve(id, context);
    }
  });
  try {
    const native = await import("virtual:entry");
    const imported = importSync("virtual:entry");
    console.log(JSON.stringify({ native: native.value, imported: imported.value }));
  } finally { hook.deregister(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      { native: 42, imported: 42 },
    );
  },
);

test("uses native import resolution when the test module is the caller", () => {
  const packageName = "import-sync-native-resolve-fixture";
  const moduleDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    "node_modules",
    packageName,
  );
  mkdirSync(moduleDirectory, { recursive: true });
  try {
    writeFileSync(
      join(moduleDirectory, "package.json"),
      JSON.stringify({
        name: packageName,
        type: "module",
        exports: {
          ".": { import: "./entry.mjs?direct=1" },
          "./plain": { import: "./entry.mjs" },
        },
      }),
    );
    writeFileSync(
      join(moduleDirectory, "entry.mjs"),
      "export const url = import.meta.url;\n",
    );
    expect(importSync(packageName).url).toMatch(/\/entry\.mjs\?direct=1$/);
    const requireModule = vi
      .spyOn(process.features, "require_module", "get")
      .mockReturnValue(false);
    try {
      expect(importSync(`${packageName}/plain`).url).toMatch(/\/entry\.mjs$/);
    } finally {
      requireModule.mockRestore();
    }
  } finally {
    rmSync(moduleDirectory, { force: true, recursive: true });
  }
});

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

testIsolatedConsumers(
  "preserves real startup conditions when a %s consumer changes flags before loading the library",
  "import-sync-late-startup-conditions-",
  (root, extension) => {
    writeIsolatedPackage(
      root,
      "late-startup-conditions",
      {
        name: "late-startup-conditions",
        type: "module",
        exports: {
          import: {
            require: "./require.mjs",
            startup: "./startup.mjs",
            runtime: "./runtime.mjs",
            default: "./default.mjs",
          },
        },
      },
      {
        "require.mjs": 'export const value = "require";\n',
        "startup.mjs": 'export const value = "startup";\n',
        "runtime.mjs": 'export const value = "runtime";\n',
        "default.mjs": 'export const value = "default";\n',
      },
    );

    const consumer = join(root, `consumer.${extension}`);
    const loadLibrary =
      extension === "mjs"
        ? `const { default: importSync } = await import(${JSON.stringify(pathToFileURL(libraryPath).href)});`
        : `const importSync = require(${JSON.stringify(libraryPath)});`;
    writeFileSync(
      consumer,
      `(async () => {
  // Change both public flag carriers before importing import-sync itself.
  process.env.NODE_OPTIONS = "--conditions=runtime";
  process.execArgv.splice(0, process.execArgv.length, "--conditions=runtime");
  ${loadLibrary}
  const native = (await import("late-startup-conditions")).value;
  const wrapper = importSync("late-startup-conditions").value;
  console.log(JSON.stringify({ native, wrapper }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
    );

    for (const { flags, nodeOptions, expected } of [
      { flags: [], nodeOptions: "", expected: "default" },
      {
        flags: ["--conditions=startup"],
        nodeOptions: "",
        expected: "startup",
      },
      {
        flags: [],
        nodeOptions: "--conditions=startup",
        expected: "startup",
      },
      {
        flags: ["--conditions=require"],
        nodeOptions: "",
        expected: "require",
      },
      {
        flags: [],
        nodeOptions: "--conditions=require",
        expected: "require",
      },
    ]) {
      expect(
        JSON.parse(runConsumer(consumer, root, { flags, nodeOptions })),
      ).toEqual({ native: expected, wrapper: expected });
    }
  },
);

testIsolatedConsumers(
  "honours relative resolver-hook redirects for existing and virtual paths in %s consumers",
  "import-sync-hooked-relative-",
  (root, extension) => {
    writeFileSync(
      join(root, "existing.mjs"),
      'export const value = "existing";\n',
    );
    writeFileSync(
      join(root, "replacement.mjs"),
      'export const value = "redirected";\n',
    );
    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const { registerHooks } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id === "./existing.mjs" || id === "./virtual.mjs") {
        return { url: pathToFileURL(${JSON.stringify(join(root, "replacement.mjs"))}).href, shortCircuit: true };
      }
      return nextResolve(id, context);
    },
  });
  try {
    const imported = [importSync("./existing.mjs"), importSync("./virtual.mjs")];
    const native = await Promise.all([import("./existing.mjs"), import("./virtual.mjs")]);
    console.log(JSON.stringify({ values: imported.map((mod) => mod.value), identical: imported[0] === imported[1], native: native.map((mod) => mod.value) }));
  } finally { hook.deregister(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      {
        values: ["redirected", "redirected"],
        identical: true,
        native: ["redirected", "redirected"],
      },
    );
  },
);

testIsolatedConsumers(
  "honours resolver-hook redirects for installed dual-export packages in %s consumers",
  "import-sync-hooked-package-",
  (root, extension) => {
    writeIsolatedPackage(
      root,
      "hooked-package",
      {
        name: "hooked-package",
        exports: { require: "./entry.cjs", import: "./entry.mjs" },
      },
      {
        "entry.cjs": 'module.exports = { value: "require" };\n',
        "entry.mjs": 'export const value = "import";\n',
      },
    );
    writeFileSync(
      join(root, "replacement.mjs"),
      'export const value = "redirected";\n',
    );
    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const { registerHooks } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const baseline = importSync("hooked-package").value;
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      if (id === "hooked-package") {
        return { url: pathToFileURL(${JSON.stringify(join(root, "replacement.mjs"))}).href, shortCircuit: true };
      }
      return nextResolve(id, context);
    },
  });
  try {
    const imported = importSync("hooked-package");
    const native = await import("hooked-package");
    console.log(JSON.stringify({ baseline, imported: imported.value, native: native.value }));
  } finally { hook.deregister(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      { baseline: "require", imported: "redirected", native: "redirected" },
    );
  },
);

testIsolatedConsumers(
  "does not bypass blocked relative imports from %s consumers",
  "import-sync-hook-block-",
  (root, extension) => {
    writeFileSync(
      join(root, "blocked.mjs"),
      'export const value = "unsafe";\n',
    );
    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const { registerHooks } = await import("node:module");
  const hook = registerHooks({ resolve(id, context, nextResolve) {
    if (id === "./blocked.mjs") {
      const error = new Error("blocked by module policy");
      error.code = "ERR_BLOCKED_BY_HOOK";
      throw error;
    }
    return nextResolve(id, context);
  }});
  try {
    let imported;
    try { importSync("./blocked.mjs"); imported = "unblocked"; }
    catch (error) { imported = error.code; }
    let native;
    try { await import("./blocked.mjs"); native = "unblocked"; }
    catch (error) { native = error.code; }
    console.log(JSON.stringify({ imported, native }));
  } finally { hook.deregister(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      { imported: "ERR_BLOCKED_BY_HOOK", native: "ERR_BLOCKED_BY_HOOK" },
    );
  },
);

testIsolatedConsumers(
  "does not bypass a resolver-hook rejection of an installed package from %s consumers",
  "import-sync-hook-block-package-",
  (root, extension) => {
    writeIsolatedPackage(
      root,
      "blocked-package",
      { name: "blocked-package", main: "./index.cjs" },
      { "index.cjs": 'module.exports = { value: "unsafe" };\n' },
    );
    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const { registerHooks } = await import("node:module");
  const hook = registerHooks({ resolve(id, context, nextResolve) {
    if (id === "blocked-package") {
      const error = new Error("package blocked by module policy");
      error.code = "ERR_BLOCKED_BY_HOOK";
      throw error;
    }
    return nextResolve(id, context);
  }});
  try {
    let imported;
    try { importSync("blocked-package"); imported = "unblocked"; }
    catch (error) { imported = error.code; }
    let native;
    try { await import("blocked-package"); native = "unblocked"; }
    catch (error) { native = error.code; }
    console.log(JSON.stringify({ imported, native }));
  } finally { hook.deregister(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      { imported: "ERR_BLOCKED_BY_HOOK", native: "ERR_BLOCKED_BY_HOOK" },
    );
  },
);

testIsolatedConsumers(
  "uses the real %s consumer as a resolver-hook parent",
  "import-sync-hook-parent-",
  (root, extension) => {
    const consumer = join(root, `consumer.${extension}`);
    const replacement = join(root, "redirected.mjs");
    writeFileSync(
      join(root, "original.mjs"),
      'export const value = "original";\n',
    );
    writeFileSync(replacement, 'export const value = "redirected";\n');
    writeIsolatedPackage(
      root,
      "parent-hook-package",
      { name: "parent-hook-package", type: "module", main: "entry.mjs" },
      { "entry.mjs": 'export const value = "original package";\n' },
    );

    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const { registerHooks } = await import("node:module");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const { realpathSync } = await import("node:fs");
  const consumerFile = ${JSON.stringify(consumer)};
  const isRealParent = (url) => {
    try {
      return realpathSync.native(fileURLToPath(url)) === realpathSync.native(consumerFile);
    } catch { return false; }
  };
  const replacementURL = pathToFileURL(${JSON.stringify(replacement)}).href;
  const observed = [];
  const hook = registerHooks({ resolve(id, context, nextResolve) {
    if (id === "./original.mjs" || id === "parent-hook-package") {
      observed.push(context.parentURL);
      if (isRealParent(context.parentURL)) {
        return { url: replacementURL, shortCircuit: true };
      }
    }
    return nextResolve(id, context);
  }});
  try {
    const nativeRelative = await import("./original.mjs");
    const nativePackage = await import("parent-hook-package");
    const relative = importSync("./original.mjs");
    const packageValue = importSync("parent-hook-package");
    console.log(JSON.stringify({
      native: [nativeRelative.value, nativePackage.value],
      wrapper: [relative.value, packageValue.value],
      correctParents: observed.length >= 4 && observed.every(isRealParent),
    }));
  } finally { hook.deregister(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      {
        native: ["redirected", "redirected"],
        wrapper: ["redirected", "redirected"],
        correctParents: true,
      },
    );
  },
);

testIsolatedConsumers(
  "preserves same-file resolver-hook queries and fragments for %s consumers",
  "import-sync-hook-suffix-",
  (root, extension) => {
    const filename = join(
      root,
      "node_modules",
      "suffix-hook-package",
      "entry.mjs",
    );
    writeIsolatedPackage(
      root,
      "suffix-hook-package",
      {
        name: "suffix-hook-package",
        type: "module",
        exports: {
          ".": { require: "./entry.mjs", import: "./entry.mjs" },
          "./fragment": { require: "./entry.mjs", import: "./entry.mjs" },
        },
      },
      { "entry.mjs": "export const url = import.meta.url;\n" },
    );
    expectConsumerResult(
      root,
      extension,
      `(async () => {
  const { registerHooks } = await import("node:module");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const { realpathSync } = await import("node:fs");
  const ids = ["suffix-hook-package", "suffix-hook-package/fragment"];
  const filename = ${JSON.stringify(filename)};
  const hook = registerHooks({ resolve(id, context, nextResolve) {
    if (ids.includes(id)) {
      const suffix = id === ids[0] ? "?hook=1" : "#hook";
      return { url: pathToFileURL(filename).href + suffix, shortCircuit: true };
    }
    return nextResolve(id, context);
  }});
  try {
    const native = await Promise.all(ids.map((id) => import(id)));
    const wrapped = ids.map((id) => importSync(id));
    const suffix = (url) => new URL(url).search + new URL(url).hash;
    console.log(JSON.stringify({
      nativeSuffixes: native.map((item) => suffix(item.url)),
      wrapperSuffixes: wrapped.map((item) => suffix(item.url)),
      sameFiles: wrapped.every((item) => realpathSync.native(fileURLToPath(item.url)) === realpathSync.native(filename)),
      distinct: wrapped[0] !== wrapped[1],
      cached: importSync(ids[0]) === wrapped[0],
    }));
  } finally { hook.deregister(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });\n`,
      {
        nativeSuffixes: ["?hook=1", "#hook"],
        wrapperSuffixes: ["?hook=1", "#hook"],
        sameFiles: true,
        distinct: true,
        cached: true,
      },
    );
  },
);
