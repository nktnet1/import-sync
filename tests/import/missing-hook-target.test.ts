import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const libraryPath = realpathSync(
  fileURLToPath(new URL("../../dist/index.cjs", import.meta.url)),
);

const consumerPrefix = (extension: string): string =>
  extension === "cjs"
    ? `const importSync = require(${JSON.stringify(libraryPath)});
const { registerHooks } = require("node:module");`
    : `import importSync from ${JSON.stringify(pathToFileURL(libraryPath).href)};
import { registerHooks } from "node:module";`;

const runHookedConsumer = (
  root: string,
  extension: string,
  hookBody: string,
  assertions: string,
): unknown => {
  const consumer = join(root, `consumer.${extension}`);
  writeFileSync(
    consumer,
    `${consumerPrefix(extension)}
const hook = registerHooks({
  resolve(id, context, nextResolve) {
    ${hookBody}
    return nextResolve(id, context);
  },
});
(async () => {
  try {
    ${assertions}
  } finally {
    hook.deregister();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
  );
  return JSON.parse(runConsumer(consumer, root));
};

test.each(["cjs", "mjs"])(
  "preserves redirects to missing targets in %s consumers",
  (extension) => {
    withTemporaryDirectory("import-sync-hook-missing-target-", (root) => {
      writeFileSync(
        join(root, "original.mjs"),
        'globalThis.__originalLoaded = true; export const value = "original";\n',
      );
      const missingTarget = pathToFileURL(
        join(root, "redirected-missing.mjs"),
      ).href;
      const result = runHookedConsumer(
        root,
        extension,
        `if (id === "./original.mjs" || id === "./original") {
      return { url: ${JSON.stringify(missingTarget)}, shortCircuit: true };
    }`,
        `const result = [];
  for (const id of ["./original.mjs", "./original"]) {
    let nativeRejected = false;
    try { await import(id); } catch { nativeRejected = true; }
    let wrapperRejected = false;
    try { importSync(id); } catch { wrapperRejected = true; }
    result.push({ nativeRejected, wrapperRejected, originalLoaded: Boolean(globalThis.__originalLoaded) });
  }
  console.log(JSON.stringify(result));`,
      );
      expect(result).toEqual([
        { nativeRejected: true, wrapperRejected: true, originalLoaded: false },
        { nativeRejected: true, wrapperRejected: true, originalLoaded: false },
      ]);
    });
  },
  12_000,
);

test.each(["cjs", "mjs"])(
  "preserves hook redirects to directory URLs in %s consumers",
  (extension) => {
    withTemporaryDirectory("import-sync-hook-directory-target-", (root) => {
      writeFileSync(
        join(root, "original.mjs"),
        'export const value = "original";\n',
      );
      const redirectDirectory = join(root, "redirect-directory");
      mkdirSync(redirectDirectory);
      writeFileSync(
        join(redirectDirectory, "index.mjs"),
        'export const value = "redirect";\n',
      );
      expect(
        runHookedConsumer(
          root,
          extension,
          `if (id === "./original.mjs") {
      return { url: ${JSON.stringify(pathToFileURL(redirectDirectory).href)}, shortCircuit: true };
    }`,
          `let loadedOriginal = false;
    try { loadedOriginal = importSync("./original.mjs").value === "original"; } catch { /* loader may reject a directory URL */ }
    console.log(JSON.stringify({ loadedOriginal }));`,
        ),
      ).toEqual({ loadedOriginal: false });
    });
  },
  12_000,
);

test.each(
  ["cjs", "mjs"].flatMap((extension) =>
    ["ERR_ACCESS_DENIED", "MODULE_NOT_FOUND"].map((code) => ({
      extension,
      code,
    })),
  ),
)(
  "preserves explicit $code hook errors for missing bare specifiers in $extension consumers",
  ({ extension, code }) => {
    withTemporaryDirectory("import-sync-hook-deny-package-", (root) => {
      const result = runHookedConsumer(
        root,
        extension,
        `if (id === "missing-policy-package") {
      throw Object.assign(new Error("explicit policy rejection"), { code: ${JSON.stringify(code)} });
    }`,
        `let nativeError;
  try { await import("missing-policy-package"); }
  catch (error) { nativeError = { message: error.message, code: error.code }; }
  let wrapperError;
  try { importSync("missing-policy-package"); }
  catch (error) { wrapperError = { message: error.message, code: error.code }; }
  console.log(JSON.stringify({ nativeError, wrapperError }));`,
      );
      expect(result).toEqual({
        nativeError: {
          message: "explicit policy rejection",
          code,
        },
        wrapperError: {
          message: "explicit policy rejection",
          code,
        },
      });
    });
  },
  12_000,
);
