/* biome-ignore-all assist/source/organizeImports: load the typed fixture before esm-sync replaces the CommonJS loader */
import checkConsumer from "./helpers/check-consumer.cts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import importSync from "import-sync";

assert.equal(typeof importSync, "function");
// Keep the import call here so caller-based resolution exercises ESM.
checkConsumer(
  (...args) => importSync(...args),
  fileURLToPath(new URL(".", import.meta.url)),
);
