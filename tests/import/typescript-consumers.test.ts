import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { prepareReleasePackage } from "../../script/prepare-release-package.ts";
import { runConsumer } from "../helpers/consumer.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

const projectRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const require = createRequire(import.meta.url);
const tsc = resolve(
  dirname(require.resolve("typescript/package.json")),
  "bin/tsc",
);
const esmSync = realpathSync(dirname(require.resolve("esm-sync/package.json")));

test("the staged npm package typechecks for ESM and CommonJS TypeScript consumers", () => {
  withTemporaryDirectory("import-sync-types-", (root) => {
    const stagedRoot = join(root, "staged");
    const consumer = join(root, "consumer");
    mkdirSync(stagedRoot);
    for (const file of ["LICENSE", "README.md", "package.json"]) {
      copyFileSync(join(projectRoot, file), join(stagedRoot, file));
    }
    cpSync(join(projectRoot, "dist"), join(stagedRoot, "dist"), {
      recursive: true,
    });
    const pkg = JSON.parse(
      readFileSync(join(stagedRoot, "package.json"), "utf8"),
    ) as {
      version: string;
    };
    prepareReleasePackage({
      root: stagedRoot,
      tag: `v${pkg.version}`,
      quiet: true,
    });

    const modules = join(consumer, "node_modules");
    mkdirSync(modules, { recursive: true });
    cpSync(join(stagedRoot, ".release/package"), join(modules, "import-sync"), {
      recursive: true,
    });
    // Use the attached dependency rather than installing anything.
    symlinkSync(
      esmSync,
      join(modules, "esm-sync"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(
      join(consumer, "esm.mts"),
      `import importSync, { type Options, type ESMOptions } from "import-sync";
import * as namespace from "import-sync";
const opts: Options = { basePath: "." };
const esmOptions: ESMOptions = undefined;
importSync("node:fs", opts);
namespace.default("node:fs", { esmOptions });
`,
    );
    writeFileSync(
      join(consumer, "cjs.cts"),
      `import importSync = require("import-sync");
import importSyncDefault from "import-sync";
import type { Options } from "import-sync";
const opts: Options = { basePath: "." };
const qualified: importSync.Options = opts;
importSync("node:fs", qualified);
importSyncDefault("node:fs", opts);
`,
    );

    writeFileSync(
      join(consumer, "bundler.ts"),
      `import importSync from "import-sync";
importSync("node:fs");
`,
    );

    writeFileSync(
      join(consumer, "runtime.mjs"),
      `import importSync from "import-sync";
console.log(typeof importSync === "function");
`,
    );
    writeFileSync(
      join(consumer, "runtime.cjs"),
      `const importSync = require("import-sync");
console.log(typeof importSync === "function");
`,
    );
    for (const extension of ["mjs", "cjs"]) {
      expect(
        runConsumer(join(consumer, `runtime.${extension}`), consumer),
      ).toBe("true");
    }

    const result = spawnSync(
      process.execPath,
      [
        tsc,
        "--ignoreConfig",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--noEmit",
        "--strict",
        // esm-sync's declaration expects @types/node; this is not a test of it.
        "--skipLibCheck",
        join(consumer, "esm.mts"),
        join(consumer, "cjs.cts"),
      ],
      { cwd: consumer, encoding: "utf8", timeout: 15_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout || result.stderr).toBe(0);

    const bundler = spawnSync(
      process.execPath,
      [
        tsc,
        "--ignoreConfig",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        join(consumer, "bundler.ts"),
      ],
      { cwd: consumer, encoding: "utf8", timeout: 15_000 },
    );
    expect(bundler.error).toBeUndefined();
    expect(bundler.status, bundler.stdout || bundler.stderr).toBe(0);
  });
}, 25_000);
