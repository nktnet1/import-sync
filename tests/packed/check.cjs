/* biome-ignore-all lint/style/noCommonJs: exercise an installed CommonJS consumer */
const assert = require("node:assert/strict");
// Load the typed fixture before esm-sync replaces the CommonJS loader.
const checkConsumer = require("./helpers/check-consumer.cts");
const importSync = require("import-sync");

assert.equal(typeof importSync, "function");
// Keep the import call here so caller-based resolution exercises CommonJS.
checkConsumer((...args) => importSync(...args), __dirname);
