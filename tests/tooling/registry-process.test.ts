import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  registryReady,
  spawnRegistry,
  stopRegistry,
} from "../../script/test-verdaccio.ts";

describe("registry process lifecycle", () => {
  it("starts the installed Verdaccio with the generated YAML configuration", async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "import-sync-verdaccio-config-")),
    );
    let child: ChildProcess | undefined;
    let output = "";
    try {
      child = await spawnRegistry({
        directory,
        name: "import-sync",
        verdaccioModule: createRequire(import.meta.url).resolve("verdaccio"),
        env: process.env,
        onOutput(chunk) {
          output = (output + chunk).slice(-16_000);
        },
      });
      const registry = await registryReady(child);
      const response = await fetch(`${registry}/-/ping`, {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200, output);
    } finally {
      await stopRegistry(child);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

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
