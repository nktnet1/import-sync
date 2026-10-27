import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import importSync from "import-sync";

assert.equal(typeof importSync, "function");
assert.equal(importSync("./fixture.cjs").value, 42);
assert.equal(importSync("./fixture.mjs").value, 43);
assert.equal(importSync("./fixture").value, 43);
assert.equal(
  importSync("./fixture.mjs", {
    basePath: fileURLToPath(new URL(".", import.meta.url)),
  }).add(2, 3),
  5,
);
assert.throws(() => importSync("./missing.mjs"), /No such file/);
