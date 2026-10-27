import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, it, vi } from "vitest";

const commands = vi.hoisted(() => ({ spawn: vi.fn(), delay: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: commands.spawn }));
vi.mock("node:timers/promises", () => ({ setTimeout: commands.delay }));
vi.mock("../../script/command.ts", () => ({
  npmCliPath: () => "/tooling/npm-cli.js",
  gitExecutable: () => "/tooling/git",
}));

import { publishReleasePackage } from "../../script/release-publisher.ts";

function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

async function withRelease(
  action: (root: string, integrity: string) => Promise<void>,
): Promise<void> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-publication-")),
  );
  try {
    const directory = join(root, "release-packages");
    mkdirSync(directory);
    const file = join(directory, "import-sync.tgz");
    writeFileSync(
      file,
      gzipSync(
        Buffer.concat([
          tarEntry(
            "package/package.json",
            JSON.stringify({ name: "import-sync", version: "2.2.7-beta.2" }),
          ),
          tarEntry("package/dist/index.cjs", "module.exports = {};"),
          tarEntry("package/dist/index.d.cts", "export {};"),
          Buffer.alloc(1024),
        ]),
      ),
    );
    const integrity = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
    await action(root, integrity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface Reply {
  command: "view" | "publish";
  status: number;
  value?: unknown;
  stderr?: string;
}
const missing: Reply = {
  command: "view",
  status: 1,
  value: { error: { code: "E404" } },
};
const disconnected: Reply = {
  command: "publish",
  status: 1,
  stderr: "ECONNRESET",
};

function replies(...queue: Reply[]): void {
  commands.spawn.mockImplementation((executable: string, args: string[]) => {
    const next = queue.shift();
    assert.ok(next, "Unexpected additional npm command");
    assert.equal(executable, process.execPath);
    assert.equal(args[0], "/tooling/npm-cli.js");
    assert.equal(args[1], next.command);
    if (next.command === "publish") {
      assert.equal(args[args.indexOf("--tag") + 1], "beta");
      assert.ok(args.includes("--ignore-scripts"));
    }
    return {
      status: next.status,
      stdout: next.value === undefined ? "" : JSON.stringify(next.value),
      stderr: next.stderr ?? "",
    };
  });
}

function publish(root: string): Promise<void> {
  return publishReleasePackage({
    root,
    registry: "https://registry.example.invalid",
    tag: "v2.2.7-beta.2",
  });
}

function publishCount(): number {
  return commands.spawn.mock.calls.filter(([, args]) => args[1] === "publish")
    .length;
}

beforeEach(() => {
  commands.spawn.mockReset();
  commands.delay.mockReset().mockImplementation(() => Promise.resolve());
});

describe("publication recovery", () => {
  it("skips an identical published tarball", () =>
    withRelease(async (root, integrity) => {
      replies({ command: "view", status: 0, value: integrity });
      await publish(root);
      assert.equal(publishCount(), 0);
      assert.equal(commands.delay.mock.calls.length, 0);
    }));

  it("rejects a conflicting tarball before publishing", () =>
    withRelease(async (root) => {
      replies({ command: "view", status: 0, value: "sha512-conflict" });
      await assert.rejects(publish(root), /refusing to overwrite/);
      assert.equal(publishCount(), 0);
    }));

  it.each([
    {
      description: "retries a transient preflight lookup before publishing",
      history: (): Reply[] => [
        { command: "view", status: 1, stderr: "EAI_AGAIN" },
        missing,
        { command: "publish", status: 0 },
      ],
    },
    {
      description:
        "recovers a lost response after the registry exposes the exact tarball",
      history: (integrity: string): Reply[] => [
        missing,
        disconnected,
        missing,
        { command: "view", status: 0, value: integrity },
      ],
    },
  ])("$description", ({ history }) =>
    withRelease(async (root, integrity) => {
      replies(...history(integrity));
      await publish(root);
      assert.equal(publishCount(), 1);
      assert.equal(commands.delay.mock.calls.length, 1);
    }),
  );

  it("limits transient publishing failures to three attempts", () =>
    withRelease(async (root) => {
      replies(
        missing,
        ...Array.from({ length: 3 }, () => [
          disconnected,
          missing,
          missing,
          missing,
        ]).flat(),
      );
      await assert.rejects(publish(root), /npm publish failed/);
      assert.equal(publishCount(), 3);
      assert.equal(commands.spawn.mock.calls.length, 13);
    }));

  it("does not retry a permanent publish failure", () =>
    withRelease(async (root) => {
      replies(
        missing,
        { command: "publish", status: 1, stderr: "E403" },
        missing,
        missing,
        missing,
      );
      await assert.rejects(publish(root), /E403/);
      assert.equal(publishCount(), 1);
    }));

  it("does not republish when the registry state cannot be verified", () =>
    withRelease(async (root) => {
      replies(missing, disconnected, {
        command: "view",
        status: 0,
        value: "sha512-conflict",
      });
      await assert.rejects(
        publish(root),
        /registry state could not be verified/,
      );
      assert.equal(publishCount(), 1);
    }));
});
