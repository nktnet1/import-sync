import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { styleText } from "node:util";
import { gitExecutable } from "./command.ts";

export function installHooks(root: string): void {
  if (process.env.CI || process.env.LEFTHOOK === "0") return;
  const git = gitExecutable();
  const inside = spawnSync(git, ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return;
  const configured = spawnSync(
    git,
    ["config", "--local", "--get", "core.hooksPath"],
    { cwd: root, encoding: "utf8" },
  );
  if (configured.error) throw configured.error;
  if (configured.status !== 0 && configured.status !== 1)
    throw new Error(
      `Unable to read Git hooks configuration: ${configured.stderr}`,
    );
  // Husky leaves this setting behind in existing clones. Migrate its local
  // setting only; keep any custom or global hooks configuration under user control.
  if (
    [".husky", ".husky/_"].includes(
      configured.stdout.trim().replaceAll("\\", "/"),
    )
  ) {
    const unset = spawnSync(
      git,
      ["config", "--local", "--unset-all", "core.hooksPath"],
      { cwd: root, encoding: "utf8" },
    );
    if (unset.error) throw unset.error;
    if (unset.status !== 0)
      throw new Error(`Unable to migrate Husky hooks: ${unset.stderr}`);
    console.log(`Migrated ${styleText("cyan", "Husky")} hooks to Lefthook`);
  }
  const effective = spawnSync(git, ["config", "--get", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
  });
  if (effective.error) throw effective.error;
  if (effective.status === 0) {
    console.log(
      `Skipped ${styleText("cyan", "Lefthook")} installation: custom core.hooksPath is configured`,
    );
    return;
  }
  if (effective.status !== 1)
    throw new Error(
      `Unable to read Git hooks configuration: ${effective.stderr}`,
    );
  const lefthook = realpathSync(
    createRequire(resolve(root, "package.json")).resolve(
      "lefthook/bin/index.js",
    ),
  );
  const result = spawnSync(process.execPath, [lefthook, "install"], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Lefthook installation failed (${result.status})`);
}

if (import.meta.main) installHooks(resolve(import.meta.dirname, ".."));
