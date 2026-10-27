import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { styleText } from "node:util";
import { validateReleaseManifest } from "./release-policy.ts";

export interface PrepareReleaseOptions {
  root: string;
  tag: string;
  expectedSha?: string;
  quiet?: boolean;
}

export function prepareReleasePackage({
  root,
  tag,
  expectedSha,
  quiet = false,
}: PrepareReleaseOptions): void {
  const canonicalRoot = realpathSync(root);
  const manifest: Record<string, unknown> = JSON.parse(
    readFileSync(join(canonicalRoot, "package.json"), "utf8"),
  );
  const version = validateReleaseManifest(manifest, tag);
  if (expectedSha && !/^[a-f0-9]{40}$/.test(expectedSha))
    throw new Error("Invalid expected Git commit SHA");
  // import-sync publishes a single dist directory. Refuse unexpected manifests
  // rather than accidentally packaging source, hooks or release credentials.
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1 ||
    manifest.files[0] !== "dist"
  )
    throw new Error('Expected package.json files to contain only "dist"');

  const requiredFiles = ["dist/index.cjs", "dist/index.d.cts"];
  for (const name of requiredFiles) {
    const source = join(canonicalRoot, name);
    const stats = lstatSync(source, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink())
      throw new Error(
        `Release input must be a regular file in the repository: ${name}`,
      );
    if (!stats?.isFile() || stats.size === 0)
      throw new Error(`Missing or empty release output: ${name}`);
  }

  const directory = join(canonicalRoot, ".release/package");
  rmSync(join(canonicalRoot, ".release"), { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  function copyInput(name: string): void {
    const source = join(canonicalRoot, name);
    const location = relative(canonicalRoot, realpathSync(source));
    const stats = lstatSync(source);
    if (
      location === ".." ||
      location.startsWith(`..${sep}`) ||
      isAbsolute(location) ||
      stats.isSymbolicLink()
    )
      throw new Error(
        `Release input must be a regular file in the repository: ${name}`,
      );
    if (stats.isDirectory()) {
      for (const entry of readdirSync(source)) copyInput(join(name, entry));
    } else if (stats.isFile()) {
      const output = join(directory, name);
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(source, output);
    } else {
      throw new Error(`Unsupported release input: ${name}`);
    }
  }

  for (const name of ["LICENSE", "README.md", "dist"]) copyInput(name);
  // Consumers need no development lifecycle hooks. In particular, preparing an
  // installed package must not install Lefthook or attempt to build from source.
  for (const name of [
    "devDependencies",
    "private",
    "scripts",
    "packageManager",
  ])
    Reflect.deleteProperty(manifest, name);
  // tsdown currently emits CommonJS only; do not advertise a nonexistent .mjs.
  Reflect.deleteProperty(manifest, "module");
  manifest.main = "./dist/index.cjs";
  manifest.types = "./dist/index.d.cts";
  manifest.exports = {
    ".": { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
    "./package.json": "./package.json",
  };
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (!quiet) {
    const label = styleText("green", `import-sync@${version}`);
    console.log(`Prepared ${label} in .release/package`);
  }
}

if (import.meta.main) {
  const tag = process.env.GITHUB_REF_NAME;
  const sha = process.env.GITHUB_SHA;
  if (!tag || !sha)
    throw new Error("GITHUB_REF_NAME and GITHUB_SHA are required");
  prepareReleasePackage({
    root: resolve(import.meta.dirname, ".."),
    tag,
    expectedSha: sha,
  });
}
