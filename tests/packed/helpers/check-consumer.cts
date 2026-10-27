/* biome-ignore-all lint/style/noCommonJs: shared CommonJS fixture for CJS and ESM consumers */
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

function checkConsumer(
  load: typeof import("../../../src/index.ts").default,
  basePath: string,
  target = process.argv[2] ?? "both",
): void {
  assert.ok(
    ["both", "cjs", "esm", "compatibility"].includes(target),
    "Unknown consumer check",
  );
  if (target === "both" || target === "cjs") {
    assert.equal(load("./fixture.cjs").value, 42);
  }
  if (target === "both" || target === "esm") {
    assert.equal(load("./fixture.mjs").value, 43);
    assert.equal(load("./fixture.mjs").add(2, 3), 5);
  }
  if (target === "both" || target === "compatibility") {
    assert.equal(load("./fixture").value, 43);
    assert.equal(load("./fixture.mjs", { basePath }).add(2, 3), 5);
    assert.throws(() => load("./missing.mjs"), /No such file/);
  }
}

module.exports = checkConsumer;
