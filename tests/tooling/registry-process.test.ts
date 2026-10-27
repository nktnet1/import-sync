import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { registryReady, stopRegistry } from "../../script/test-verdaccio.ts";

describe("registry process lifecycle", () => {
  it("ignores malformed IPC messages and stops a ready registry", async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-registry-process-")),
    );
    const filename = join(directory, "server.cjs");
    writeFileSync(
      filename,
      `
process.send({ port: '1234' });
process.send({ port: 0 });
process.send({ port: 65536 });
process.send({ port: 12345 });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    const child = fork(filename, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      assert.equal(await registryReady(child), "http://127.0.0.1:12345");
      await stopRegistry(child);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    } finally {
      await stopRegistry(child);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an early registry exit instead of waiting for startup to time out", async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-registry-process-")),
    );
    const filename = join(directory, "server.cjs");
    writeFileSync(filename, "process.exit(7);\n");
    const child = fork(filename, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await assert.rejects(
        registryReady(child),
        /Verdaccio exited before startup \(7\)/,
      );
    } finally {
      await stopRegistry(child);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
