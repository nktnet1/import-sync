import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "vitest";
import { npmCliPath } from "../../script/command.ts";

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "import-sync-command-")),
  );
  const bin = join(root, "runtime/bin");
  mkdirSync(bin, { recursive: true });
  const execPath = join(bin, "node");
  writeFileSync(execPath, "runtime fixture");
  return { root, bin, execPath };
}

function npmInstallation(directory: string, name = "npm"): string {
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, bin: { npm: "bin/npm-cli.js" } }),
  );
  const cli = join(directory, "bin/npm-cli.js");
  writeFileSync(cli, "throw new Error('Discovery must not execute npm');\n");
  return realpathSync(cli);
}

describe("npm CLI discovery", () => {
  it.each([
    "../lib/node_modules/npm",
    "node_modules/npm",
    "../node_modules/npm",
  ])("supports the bundled layout %s", (layout) => {
    const { root, bin, execPath } = fixture();
    try {
      const cli = npmInstallation(resolve(bin, layout));
      assert.equal(npmCliPath({ execPath, env: { PATH: "" } }), cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds separate npm when a pnpm-managed runtime has none", () => {
    const { root, execPath } = fixture();
    try {
      const npmBin = join(root, "node-with-npm/bin");
      mkdirSync(npmBin, { recursive: true });
      const cli = npmInstallation(resolve(npmBin, "../lib/node_modules/npm"));
      assert.equal(
        npmCliPath({
          execPath,
          env: {
            npm_execpath: join(root, "pnpm.cjs"),
            PATH: npmBin,
          },
        }),
        cli,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a separate npm symlink to its canonical CLI", () => {
    const { root, execPath } = fixture();
    try {
      const cli = npmInstallation(join(root, "separate/npm"));
      const npmBin = join(root, "shims");
      mkdirSync(npmBin);
      symlinkSync(cli, join(npmBin, "npm"));
      assert.equal(npmCliPath({ execPath, env: { PATH: npmBin } }), cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an absolute npm lifecycle CLI hint", () => {
    const { root, execPath } = fixture();
    try {
      const cli = npmInstallation(join(root, "separate/npm"));
      assert.equal(
        npmCliPath({ execPath, env: { PATH: "", npm_execpath: cli } }),
        cli,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unrelated wrappers and relative or empty search entries", () => {
    const { root, execPath } = fixture();
    try {
      const fakeCli = npmInstallation(
        join(root, "fake/node_modules/npm"),
        "unrelated",
      );
      assert.throws(
        () =>
          npmCliPath({
            execPath,
            env: {
              PATH: ["", ".", "node_modules/.bin", dirname(fakeCli)].join(
                delimiter,
              ),
              npm_execpath: fakeCli,
            },
          }),
        /Unable to find npm-cli.js/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
