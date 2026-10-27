import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "vitest";
import {
  consumerFormats,
  createRegistryReporter,
  moduleFormats,
} from "../../script/registry-reporter.ts";

describe("registry test reporting", () => {
  it("reports each CJS/ESM pair and compatibility result separately", async () => {
    let output = "";
    const report = createRegistryReporter(
      consumerFormats("both"),
      false,
      (text) => {
        output += text;
      },
    );
    report.header("import-sync", "2.2.7-beta.1");
    for (const project of moduleFormats) {
      for (const target of moduleFormats) {
        await report.check(project, target, () =>
          report.stage("TEST", `${project} to ${target}`, () => undefined),
        );
      }
      await report.check(project, "compatibility", () => undefined);
    }
    report.summary(true);
    const text = stripVTControlCharacters(output);
    for (const project of ["CJS", "ESM"]) {
      for (const target of ["CJS", "ESM"]) {
        assert.match(
          text,
          new RegExp(`${project} project importing ${target} module\\s+PASS`),
        );
      }
    }
    assert.match(text, /4\/4 import pairs\s+\|\s+2\/2 compatibility checks/);
    assert.match(text, /\[01\/20\].*TEST.*PASS\s+\d+\.\d+s/);
  });

  it("distinguishes failed pairs from checks that never ran", async () => {
    let output = "";
    const report = createRegistryReporter(moduleFormats, false, (text) => {
      output += text;
    });
    await report.check("cjs", "cjs", () => undefined);
    await assert.rejects(
      report.check("cjs", "esm", () =>
        report.stage("TEST", "CJS to ESM", () => {
          throw new Error("consumer failed");
        }),
      ),
      /consumer failed/,
    );
    await report.stage("CLEANUP", "remove projects", () => undefined);
    report.summary(false);
    const text = stripVTControlCharacters(output);
    assert.match(text, /CJS project importing CJS module\s+PASS/);
    assert.match(text, /CJS project importing ESM module\s+FAIL/);
    assert.match(text, /ESM project importing CJS module\s+NOT RUN/);
    assert.match(text, /ESM project importing ESM module\s+NOT RUN/);
    assert.match(text, /FAIL\s+1\/4 import pairs/);
    assert.match(text, /Stopped at TEST: CJS to ESM/);
  });

  it("keeps verbose subprocess output on its own lines", async () => {
    let output = "";
    const report = createRegistryReporter(["esm"], true, (text) => {
      output += text;
    });
    await report.stage("BUILD", "compile package", () => {
      output += "child output\n";
    });
    assert.match(
      stripVTControlCharacters(output),
      /compile package\nchild output\n\s+PASS/,
    );
  });

  it("uses the selected project scope in result totals", async () => {
    let output = "";
    const report = createRegistryReporter(
      consumerFormats("esm"),
      false,
      (text) => {
        output += text;
      },
    );
    for (const target of moduleFormats)
      await report.check("esm", target, () => undefined);
    await report.check("esm", "compatibility", () => undefined);
    report.summary(true);
    const text = stripVTControlCharacters(output);
    assert.match(text, /2\/2 import pairs\s+\|\s+1\/1 compatibility checks/);
    assert.doesNotMatch(text, /CJS project/);
  });

  it("rejects unsupported format selections", () => {
    assert.throws(() => consumerFormats("commonjs"), /--format must be/);
  });
});
