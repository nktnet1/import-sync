import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, styleText } from "node:util";
import { runCommand, runNpm, runPnpm } from "./command.ts";
import { nextBetaVersion, versionFromTag } from "./release-policy.ts";

const root = realpathSync(resolve(import.meta.dirname, ".."));
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    publish: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function git(args: string[]): string {
  return runCommand("git", args, { cwd: root }).trim();
}

function publishedVersions(): string[] {
  const response: unknown = JSON.parse(
    runNpm(
      [
        "view",
        "import-sync",
        "versions",
        "--json",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: root },
    ),
  );
  const versions = typeof response === "string" ? [response] : response;
  if (
    !Array.isArray(versions) ||
    !versions.every((version: unknown) => typeof version === "string")
  )
    throw new Error(
      "Invalid npm version list; refusing to guess the next beta",
    );
  return versions;
}

function main(): void {
  if (values.help) {
    console.log(`Usage: node script/release-beta.ts [--base <version>] [--dry-run | --publish]

By default, select the next numbered beta for the manifest's current base,
update package.json, and run release checks. Select a new stable base explicitly
with --base (for example, 2.2.7 or v2.3.0).
--dry-run reads the registry and Git tags but changes no files.
--publish also commits the version, creates an annotated v-prefixed tag, and
atomically pushes main and the tag to origin. The release CI then publishes it.

Run from a clean main checkout with dependencies and build tools available.
If a check fails, inspect the uncommitted package.json change before retrying.`);
    return;
  }
  if (values.publish && values["dry-run"])
    throw new Error("Choose either --dry-run or --publish");
  if (git(["status", "--porcelain"]))
    throw new Error(
      "Commit or stash existing changes before preparing a release",
    );
  const branch = git(["symbolic-ref", "--short", "HEAD"]);
  if (values.publish && branch !== "main")
    throw new Error("Automated beta publishing requires the main branch");
  const manifestPath = resolve(root, "package.json");
  const manifest: Record<string, unknown> = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  );
  if (manifest.name !== "import-sync" || typeof manifest.version !== "string")
    throw new Error("Unexpected package manifest");
  const remoteTags = git(["ls-remote", "--tags", "--refs", "origin"])
    .split("\n")
    .map((line) => line.split("refs/tags/")[1] ?? "");
  const version = nextBetaVersion(
    manifest.version,
    publishedVersions(),
    [...git(["tag", "--list"]).split("\n"), ...remoteTags],
    values.base,
  );
  const tag = `v${version}`;
  versionFromTag(tag);
  console.log(
    `${manifest.version} -> ${styleText("cyan", version)} (npm dist-tag: ${styleText("yellow", "beta")})`,
  );
  if (values["dry-run"]) return;

  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of ["check", "typecheck", "test", "test:verdaccio"]) {
    console.log(`Checking ${styleText("cyan", name)}...`);
    runPnpm([name], { cwd: root, inherit: true });
  }
  if (!values.publish) {
    console.log(
      `Prepared ${tag}; review package.json and tag the tested commit manually.`,
    );
    return;
  }
  // Tests may generate ignored files, but no tracked file beyond the version may change.
  const status = git(["status", "--porcelain"]);
  if (status !== " M package.json" && status !== "M package.json")
    throw new Error(
      "Unexpected worktree changes; review the release before publishing",
    );
  const checkedManifest: Record<string, unknown> = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  );
  if (checkedManifest.version !== version)
    throw new Error("Package version changed during checks");
  git(["add", "--", "package.json"]);
  git(["commit", "-m", `chore(release): ${version}`]);
  git(["tag", "-a", tag, "-m", tag]);
  runCommand(
    "git",
    ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`],
    { cwd: root, inherit: true },
  );
  console.log(
    `Pushed ${styleText("green", tag)}; Release and Publish CI will follow.`,
  );
}

main();
