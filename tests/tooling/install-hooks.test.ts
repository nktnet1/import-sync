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
  const runner = join(bin, "lefthook.cjs");
  writeFileSync(
    runner,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'installed');\n`,
  );
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "lefthook.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0lefthook.cjs"\r\n`,
    );
  } else {
    const executable = join(bin, "lefthook");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nrequire(${JSON.stringify(runner)});\n`,
    );
    chmodSync(executable, 0o755);
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
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  return { root, marker, git };
}

describe("Husky to Lefthook migration", () => {
  it.each([".husky", ".husky/_"])(
    "removes the local %s setting before installing hooks",
    (hooksPath) => {
      const { root, marker, git } = fixture();
      try {
        git(["config", "--local", "core.hooksPath", hooksPath]);
        installHooks(root);
        const configured = spawnSync(
          "git",
          ["config", "--local", "--get", "core.hooksPath"],
          { cwd: root },
        );
        assert.equal(configured.status, 1);
        assert.ok(existsSync(marker));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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

  it("preserves global hooks when migrating a local Husky setting", () => {
    const { root, marker, git } = fixture();
    try {
      git(["config", "--global", "core.hooksPath", "global-hooks"]);
      git(["config", "--local", "core.hooksPath", ".husky/_"]);
      installHooks(root);
      assert.equal(git(["config", "--get", "core.hooksPath"]), "global-hooks");
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not change Git configuration in CI", () => {
    const { root, marker, git } = fixture();
    try {
      git(["config", "--local", "core.hooksPath", ".husky/_"]);
      vi.stubEnv("CI", "true");
      installHooks(root);
      assert.equal(
        git(["config", "--local", "--get", "core.hooksPath"]),
        ".husky/_",
      );
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
