import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

test.each(["?caller=1", "#caller-fragment"])(
  "preserves the ESM caller's %s in native resolver-hook parent URLs",
  (suffix) => {
    withTemporaryDirectory("import-sync-query-parent-", (root) => {
      const packageDir = join(root, "node_modules", "import-only");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "consumer-package",
          type: "module",
          imports: {
            "#alias": { import: "./entry.mjs" },
            "#dual": { import: "./dual.mjs", require: "./dual.cjs" },
          },
        }),
      );
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "import-only",
          type: "module",
          exports: { import: "./index.mjs" },
        }),
      );
      writeFileSync(
        join(packageDir, "index.mjs"),
        'export const value = "original package";\n',
      );
      const dualDir = join(root, "node_modules", "dual-package");
      mkdirSync(dualDir);
      writeFileSync(
        join(dualDir, "package.json"),
        JSON.stringify({
          name: "dual-package",
          type: "module",
          exports: { import: "./entry.mjs", require: "./entry.cjs" },
        }),
      );
      writeFileSync(
        join(dualDir, "entry.mjs"),
        'export const value = "import path";\n',
      );
      writeFileSync(
        join(dualDir, "entry.cjs"),
        'module.exports = { value: "require path" };\n',
      );
      const legacyDir = join(root, "node_modules", "legacy-directory");
      mkdirSync(join(legacyDir, "lib"), { recursive: true });
      writeFileSync(
        join(legacyDir, "package.json"),
        JSON.stringify({ name: "legacy-directory", main: "./lib" }),
      );
      writeFileSync(
        join(legacyDir, "lib", "index.js"),
        'module.exports = { value: "legacy directory" };\n',
      );
      writeFileSync(
        join(root, "entry.mjs"),
        'export const value = "original relative";\n',
      );
      writeFileSync(
        join(root, "redirect.mjs"),
        'export const value = "redirected";\n',
      );
      writeFileSync(
        join(root, "dual.mjs"),
        'export const value = "import path";\n',
      );
      writeFileSync(
        join(root, "dual.cjs"),
        'module.exports = { value: "require path" };\n',
      );
      writeFileSync(
        join(root, "consumer.mjs"),
        `import { createRequire, registerHooks } from "node:module";
const require = createRequire(import.meta.url);
const importSync = require(${JSON.stringify(libraryPath)});
const observedParents = [];
const hook = registerHooks({
  resolve(id, context, nextResolve) {
    if (["./entry.mjs", "import-only", "#alias"].includes(id)) {
      observedParents.push(context.parentURL);
      if (id === "./entry.mjs" && context.parentURL.endsWith("/__import_sync__.cjs")) {
        return nextResolve(id, context);
      }
      if (context.parentURL === import.meta.url) {
        return { url: new URL("./redirect.mjs", import.meta.url).href, shortCircuit: true };
      }
      throw new Error("Unexpected stripped parent URL: " + context.parentURL);
    }
    return nextResolve(id, context);
  },
});
try {
  const native = [
    (await import("./entry.mjs")).value,
    (await import("import-only")).value,
    (await import("#alias")).value,
  ];
  const synced = [
    importSync("./entry.mjs").value,
    importSync("import-only").value,
    importSync("#alias").value,
  ];
  const fromEval = eval('importSync("./entry.mjs")').value;
  const fromNestedEval = eval('eval(' + JSON.stringify('importSync("./entry.mjs")') + ')').value;
  const requireFirst = [importSync("#dual").value, importSync("dual-package").value];
  const legacy = importSync("legacy-directory").value;
  const explicitBasePath = importSync("./entry.mjs", { basePath: ${JSON.stringify(root)} }).value;
  console.log(JSON.stringify({ native, synced, fromEval, fromNestedEval, requireFirst, legacy, explicitBasePath, observedParents }));
} finally {
  hook.deregister();
}
`,
      );
      const runner = join(root, "runner.mjs");
      writeFileSync(
        runner,
        `await import(${JSON.stringify(`./consumer.mjs${suffix}`)});\n`,
      );
      const result = JSON.parse(runConsumer(runner, root));
      expect(result.native).toEqual(["redirected", "redirected", "redirected"]);
      expect(result.synced).toEqual(result.native);
      expect(result.fromEval).toBe("redirected");
      expect(result.fromNestedEval).toBe("redirected");
      expect(result.requireFirst).toEqual(["require path", "require path"]);
      expect(result.legacy).toBe("legacy directory");
      expect(result.explicitBasePath).toBe("original relative");
      expect(result.observedParents).toContain(
        `${pathToFileURL(join(root, "consumer.mjs")).href}${suffix}`,
      );
    });
  },
  12_000,
);
