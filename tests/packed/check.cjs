/* biome-ignore-all lint/style/noCommonJs: exercise an installed CommonJS consumer */
const assert = require("node:assert/strict");
const importSync = require("import-sync");

assert.equal(typeof importSync, "function");
const target = process.argv[2] ?? "both";
assert.ok(
  ["both", "cjs", "esm", "compatibility"].includes(target),
  "Unknown consumer check",
);
if (target === "both" || target === "cjs") {
  assert.equal(importSync("./fixture.cjs").value, 42);
}
if (target === "both" || target === "esm") {
  assert.equal(importSync("./fixture.mjs").value, 43);
  assert.equal(importSync("./fixture.mjs").add(2, 3), 5);
}
if (target === "both" || target === "compatibility") {
  assert.equal(importSync("./fixture").value, 43);
  assert.equal(
    importSync("./fixture.mjs", { basePath: __dirname }).add(2, 3),
    5,
  );
  assert.throws(() => importSync("./missing.mjs"), /No such file/);
}
