import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { gitExecutable } from "../../script/command.ts";
import { installHooks } from "../../script/install-hooks.ts";

afterEach(() => vi.unstubAllEnvs());

function fixture(): {
  root: string;
  marker: string;
  git: (args: string[]) => string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "import-sync-hooks-")));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const marker = join(root, "installed");
  const runner = join(root, "node_modules/lefthook/bin/index.js");
  mkdirSync(dirname(runner), { recursive: true });
  writeFileSync(
    runner,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'installed');\n`,
  );
  writeFileSync(
    join(root, "node_modules/lefthook/package.json"),
    '{"name":"lefthook","type":"commonjs"}',
  );
  // Project-writable PATH entries must never supply Git or Lefthook.
  for (const command of ["git", "lefthook"]) {
    const executable = join(bin, command);
    writeFileSync(executable, "#!/bin/sh\nexit 91\n");
    chmodSync(executable, 0o755);
    writeFileSync(`${executable}.cmd`, "@echo off\r\nexit /b 91\r\n");
  }
  const global = join(root, "global.gitconfig");
  writeFileSync(global, "");
  vi.stubEnv("CI", "");
  vi.stubEnv("LEFTHOOK", "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", global);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv(
    "PATH",
    [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
  );
  const git = (args: string[]): string => {
    const result = spawnSync(gitExecutable(), args, {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  return { root, marker, git };
}

describe("Lefthook installation", () => {
  it("installs hooks for a repository with no custom hooks path", () => {
    const { root, marker } = fixture();
    try {
      installHooks(root);
      assert.ok(existsSync(marker));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a custom local hook path and skips automatic installation", () => {
    const { root, marker, git } = fixture();
    try {
      git(["config", "--local", "core.hooksPath", "custom-hooks"]);
      installHooks(root);
      assert.equal(
        git(["config", "--local", "--get", "core.hooksPath"]),
        "custom-hooks",
      );
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips installation in CI", () => {
    const { root, marker } = fixture();
    try {
      vi.stubEnv("CI", "true");
      installHooks(root);
      const configured = spawnSync(
        gitExecutable(),
        ["config", "--local", "--get", "core.hooksPath"],
        { cwd: root },
      );
      assert.equal(configured.status, 1);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
