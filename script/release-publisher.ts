import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { styleText } from "node:util";
import { gunzipSync } from "node:zlib";
import { gitExecutable, npmCliPath } from "./command.ts";
import {
  compareReleaseVersions,
  parseReleaseVersion,
  validateReleaseManifest,
  versionFromTag,
} from "./release-policy.ts";

const tarBlockSize = 512;
const maxArchiveBytes = 256 * 1024 * 1024;
const maxManifestBytes = 1024 * 1024;

function tarString(header: Buffer, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

function tarSize(header: Buffer): number {
  const input = tarString(header, 124, 12).trim();
  if (!/^[0-7]+$/.test(input)) throw new Error("Invalid tar entry size");
  const size = Number.parseInt(input, 8);
  if (!Number.isSafeInteger(size)) throw new Error("Invalid tar entry size");
  return size;
}

function tarEntry(header: Buffer): {
  name: string;
  size: number;
  directory: boolean;
} {
  const checksumText = tarString(header, 148, 8).trim();
  const checksum = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  if (
    !/^[0-7]+$/.test(checksumText) ||
    Number.parseInt(checksumText, 8) !== checksum ||
    tarString(header, 257, 6) !== "ustar"
  )
    throw new Error("Invalid or unsupported tar archive header");

  // Refuse links and extended headers; their extraction rules differ from our reader.
  const type = header[156];
  if (type !== 0 && type !== 48 && type !== 53)
    throw new Error("Tar links and extended entries are not allowed");
  const entry = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const name = [prefix, entry].filter(Boolean).join("/").replace(/\/$/, "");
  const segments = name.split("/");
  const directory = type === 53;
  if (
    segments[0] !== "package" ||
    segments.some((segment) => ["", ".", ".."].includes(segment)) ||
    name.includes("\\") ||
    (!directory && (segments.length < 2 || entry.endsWith("/")))
  )
    throw new Error(`Unsafe tar entry path: ${name}`);
  const size = tarSize(header);
  if (directory && size !== 0) throw new Error("Invalid directory entry size");
  return { name, size, directory };
}

export interface ReleaseTarball {
  file: string;
  manifest: Record<string, unknown>;
}

function releaseManifest(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > maxManifestBytes)
    throw new Error("Oversized package manifest");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid release package manifest");
  return parsed as Record<string, unknown>;
}

function validTarFooter(archive: Buffer, offset: number): boolean {
  return (
    archive.length - offset >= 2 * tarBlockSize &&
    archive.length % tarBlockSize === 0 &&
    archive.subarray(offset).every((byte) => byte === 0)
  );
}

function requireReleaseEntries(
  entries: ReadonlyMap<string, number>,
  manifest: Record<string, unknown>,
): void {
  const required = ["package/dist/index.cjs", "package/dist/index.d.cts"];
  // An older release may be retried by today's trusted Publish workflow. Only
  // require the new ESM declarations when the tarball's manifest advertises them.
  const exportsValue = manifest.exports;
  const rootExport =
    exportsValue && typeof exportsValue === "object" && "." in exportsValue
      ? exportsValue["."]
      : undefined;
  const types =
    rootExport && typeof rootExport === "object" && "types" in rootExport
      ? rootExport.types
      : undefined;
  if (
    types &&
    typeof types === "object" &&
    "import" in types &&
    types.import === "./dist/index.d.mts"
  ) {
    required.push("package/dist/index.d.mts", "package/dist/index.d.mts.map");
  }
  for (const name of required) {
    if (!entries.has(name) || entries.get(name) === 0)
      throw new Error(`Missing or empty release tarball member: ${name}`);
  }
}

/** Inspect an npm tarball without extracting it or executing its lifecycle scripts. */
export function inspectReleaseTarball(file: string): ReleaseTarball {
  const archive = gunzipSync(readFileSync(file), {
    maxOutputLength: maxArchiveBytes,
  });
  const entries = new Map<string, number>();
  let manifest: Record<string, unknown> | undefined;
  let footer = false;
  for (let offset = 0; offset + tarBlockSize <= archive.length; ) {
    const header = archive.subarray(offset, offset + tarBlockSize);
    if (header.every((byte) => byte === 0)) {
      footer = validTarFooter(archive, offset);
      break;
    }
    const { name, size, directory } = tarEntry(header);
    if (entries.has(name)) throw new Error(`Duplicate tar entry: ${name}`);
    entries.set(name, size);
    const start = offset + tarBlockSize;
    const end = start + size;
    const next = start + Math.ceil(size / tarBlockSize) * tarBlockSize;
    if (next > archive.length) throw new Error("Truncated release tarball");
    if (name === "package/package.json" && !directory)
      manifest = releaseManifest(archive.subarray(start, end));
    offset = next;
  }
  if (!footer) throw new Error("Missing or invalid tar footer");
  if (!manifest) throw new Error("Release tarball is missing package.json");
  requireReleaseEntries(entries, manifest);
  if (manifest.scripts !== undefined)
    throw new Error("Release tarball has unexpected lifecycle scripts");
  return { file, manifest };
}

function requireDirectory(directory: string): void {
  if (!lstatSync(directory).isDirectory())
    throw new Error(`Not a regular directory: ${directory}`);
}

function readMetadata(root: string, name: "tag" | "sha"): string {
  const file = join(root, "release-metadata", name);
  if (!lstatSync(file).isFile())
    throw new Error(`Invalid release metadata: ${name}`);
  return readFileSync(file, "utf8").trim();
}

/** Ensure the tag still resolves to exactly the commit from the successful CI run. */
function verifyRemoteTag(root: string, tag: string, sha: string): void {
  // Validate at the process boundary, even when the caller already checked the
  // metadata. Only stable or numbered beta versions may become Git ref arguments.
  const { version } = versionFromTag(tag);
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid expected build SHA");
  const ref = `refs/tags/v${version}`;
  const refs = [ref, `${ref}^{}`];
  const result = spawnSync(
    gitExecutable(),
    ["ls-remote", "--tags", "--", "origin", ...refs],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Unable to verify the remote release tag: ${result.stderr}`,
    );
  const remote = new Map(
    result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, ref] = line.split("\t");
        return [ref, hash];
      }),
  );
  const actual = remote.get(refs[1]) ?? remote.get(refs[0]);
  if (actual !== sha)
    throw new Error(`Remote ${tag} does not point to the release commit`);
}

const transientError =
  /\b(?:E408|E429|E500|E502|E503|E504|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE)\b/;
const retryDelay = (attempt: number): number => attempt * 2_000;

interface RegistryContext {
  npmCli: string;
  registry: string;
  version: string;
}

function npmErrorCode(output: string): string | undefined {
  try {
    const message: unknown = JSON.parse(output);
    if (message && typeof message === "object" && "error" in message) {
      const error: unknown = message.error;
      if (error && typeof error === "object" && "code" in error)
        return typeof error.code === "string" ? error.code : undefined;
    }
  } catch {
    // Unknown registry failures must not be mistaken for a missing package.
  }
  return undefined;
}

/** Keep npm view flags and execution errors consistent for registry lookups. */
function npmView(
  context: RegistryContext,
  packageName: string,
  field: "dist.integrity" | "dist-tags",
) {
  const result = spawnSync(
    process.execPath,
    [
      context.npmCli,
      "view",
      packageName,
      field,
      "--json",
      "--prefer-online",
      "--fetch-retries=0",
      "--registry",
      context.registry,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return result;
}

function alreadyPublished(
  context: RegistryContext,
  artifact: ReleaseTarball,
): boolean {
  const result = npmView(
    context,
    `import-sync@${context.version}`,
    "dist.integrity",
  );
  if (result.status !== 0) {
    if (npmErrorCode(result.stdout || result.stderr) === "E404") return false;
    throw new Error(`npm view failed: ${result.stderr || result.stdout}`);
  }
  const integrity: unknown = JSON.parse(result.stdout);
  const expected = `sha512-${createHash("sha512").update(readFileSync(artifact.file)).digest("base64")}`;
  if (
    typeof integrity !== "string" ||
    !integrity.split(/\s+/).includes(expected)
  )
    throw new Error(
      `Published tarball differs from ${artifact.file}; refusing to overwrite`,
    );
  return true;
}

async function checkPublished(
  context: RegistryContext,
  artifact: ReleaseTarball,
  attempt = 1,
): Promise<boolean> {
  try {
    return alreadyPublished(context, artifact);
  } catch (error) {
    if (attempt >= 3 || !transientError.test(String(error))) throw error;
    console.warn(
      `${styleText("yellow", "RETRY")} npm registry lookup (${attempt}/3)`,
    );
    await setTimeout(retryDelay(attempt));
    return checkPublished(context, artifact, attempt + 1);
  }
}

/** A prior release must never move a newer dist-tag backwards. */
class StaleDistTagError extends Error {}

export function publishedDistTagStatus(
  expected: string,
  actual: string | undefined,
  distTag: "latest" | "beta",
): "current" | "superseded" {
  if (actual === expected) return "current";
  if (
    actual &&
    parseReleaseVersion(actual).distTag === distTag &&
    compareReleaseVersions(actual, expected) > 0
  )
    return "superseded";
  throw new StaleDistTagError(
    `npm ${distTag} dist-tag points to ${actual ?? "<missing>"}, not import-sync@${expected}; repair the dist-tag explicitly`,
  );
}

/** Do not let a new publication move an existing dist-tag backwards. */
export function assertDistTagWillNotDowngrade(
  expected: string,
  actual: string | undefined,
  distTag: "latest" | "beta",
): void {
  if (actual && compareReleaseVersions(actual, expected) > 0)
    throw new Error(
      `Refusing to publish import-sync@${expected}: npm ${distTag} already points to newer ${actual}`,
    );
}

function readPublishedDistTag(
  context: RegistryContext,
  distTag: "latest" | "beta",
): string | undefined {
  const result = npmView(context, "import-sync", "dist-tags");
  // E404 means the package has never been published. Other errors fail closed.
  if (result.status !== 0) {
    if (npmErrorCode(result.stdout || result.stderr) === "E404")
      return undefined;
    throw new Error(
      `npm dist-tag lookup failed: ${result.stderr || result.stdout}`,
    );
  }
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid npm dist-tags response");
  const tag: unknown = (value as Record<string, unknown>)[distTag];
  if (tag !== undefined && typeof tag !== "string")
    throw new Error(`Invalid npm ${distTag} dist-tag`);
  return tag;
}

async function verifyPrepublicationDistTag(
  context: RegistryContext,
  distTag: "latest" | "beta",
  attempt = 1,
): Promise<void> {
  try {
    assertDistTagWillNotDowngrade(
      context.version,
      readPublishedDistTag(context, distTag),
      distTag,
    );
  } catch (error) {
    if (attempt >= 3 || !transientError.test(String(error))) throw error;
    console.warn(
      `${styleText("yellow", "RETRY")} npm dist-tag lookup (${attempt}/3)`,
    );
    await setTimeout(retryDelay(attempt));
    await verifyPrepublicationDistTag(context, distTag, attempt + 1);
  }
}

/** Allow time for registry metadata to catch up with an accepted publish. */
async function verifyPublishedDistTag(
  context: RegistryContext,
  distTag: "latest" | "beta",
  attempt = 1,
): Promise<"current" | "superseded"> {
  try {
    return publishedDistTagStatus(
      context.version,
      readPublishedDistTag(context, distTag),
      distTag,
    );
  } catch (error) {
    const stale = error instanceof StaleDistTagError;
    if (attempt === 3 || (!stale && !transientError.test(String(error))))
      throw error;
    await setTimeout(retryDelay(attempt));
    return verifyPublishedDistTag(context, distTag, attempt + 1);
  }
}

async function confirmPublication(
  context: RegistryContext,
  artifact: ReleaseTarball,
  attempt = 1,
): Promise<boolean> {
  if (await checkPublished(context, artifact)) return true;
  if (attempt >= 3) return false;
  await setTimeout(retryDelay(attempt));
  return confirmPublication(context, artifact, attempt + 1);
}

function attemptPublish(
  context: RegistryContext,
  artifact: ReleaseTarball,
  distTag: string,
): {
  success: boolean;
  transient: boolean;
  error: Error | undefined;
} {
  const capture = !process.stdin.isTTY;
  const result = spawnSync(
    process.execPath,
    [
      context.npmCli,
      "publish",
      artifact.file,
      "--registry",
      context.registry,
      "--access",
      "public",
      "--ignore-scripts",
      "--tag",
      distTag,
      "--fetch-retries=0",
    ],
    {
      encoding: "utf8",
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status === 0)
    return { success: true, transient: false, error: undefined };
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    success: false,
    transient: transientError.test(details),
    error: new Error(
      `npm publish failed (${result.status ?? "signal"}): ${details}`,
    ),
  };
}

async function publishWithRecovery(
  context: RegistryContext,
  artifact: ReleaseTarball,
  distTag: string,
  attempt = 1,
): Promise<void> {
  const result = attemptPublish(context, artifact, distTag);
  if (result.success) return;
  let published: boolean;
  try {
    published = await confirmPublication(context, artifact);
  } catch (error) {
    throw new Error(
      "Publish failed and registry state could not be verified; do not retry blindly",
      { cause: error },
    );
  }
  if (published) {
    console.log(
      `${styleText("green", "RECOVERED")} registry accepted the exact tarball`,
    );
    return;
  }
  if (!result.transient || attempt === 3) throw result.error;
  console.warn(`${styleText("yellow", "RETRY")} npm publish (${attempt}/3)`);
  await setTimeout(retryDelay(attempt));
  await publishWithRecovery(context, artifact, distTag, attempt + 1);
}

export interface PublishOptions {
  root: string;
  registry: string;
  tag?: string;
  expectedSha?: string;
  dryRun?: boolean;
}

/** Select a requested release tag, verifying CI metadata when supplied. */
function releaseTagFromMetadata(
  root: string,
  tag: string | undefined,
  expectedSha: string | undefined,
): string {
  if (expectedSha) {
    if (!/^[a-f0-9]{40}$/.test(expectedSha))
      throw new Error("Invalid expected build SHA");
    requireDirectory(join(root, "release-metadata"));
    if (readMetadata(root, "sha") !== expectedSha)
      throw new Error(
        "Release metadata does not match the successful build SHA",
      );
    const releaseTag = readMetadata(root, "tag");
    if (!releaseTag) throw new Error("Provide --tag or --expected-sha");
    return releaseTag;
  }
  if (!tag) throw new Error("Provide --tag or --expected-sha");
  return tag;
}

export async function publishReleasePackage({
  root,
  registry,
  tag,
  expectedSha,
  dryRun = false,
}: PublishOptions): Promise<void> {
  const registryUrl = new URL(registry);
  if (
    !["https:", "http:"].includes(registryUrl.protocol) ||
    registryUrl.username ||
    registryUrl.password
  )
    throw new Error(
      "Registry must be an HTTP(S) URL without embedded credentials",
    );
  if (tag && expectedSha)
    throw new Error("Use --tag or --expected-sha, not both");

  const canonicalRoot = realpathSync(root);
  const releaseTag = releaseTagFromMetadata(canonicalRoot, tag, expectedSha);
  const { version, distTag } = versionFromTag(releaseTag);
  parseReleaseVersion(version);
  if (expectedSha) verifyRemoteTag(canonicalRoot, releaseTag, expectedSha);

  const directory = join(canonicalRoot, "release-packages");
  requireDirectory(directory);
  const files = readdirSync(directory);
  const [filename] = files;
  if (
    files.length !== 1 ||
    filename === undefined ||
    !filename.endsWith(".tgz")
  )
    throw new Error("Expected exactly one npm release tarball");
  const file = join(directory, filename);
  if (!lstatSync(file).isFile())
    throw new Error("Release tarball must be a regular file");
  const artifact = inspectReleaseTarball(file);
  validateReleaseManifest(artifact.manifest, releaseTag);
  if (dryRun) {
    const label = styleText("cyan", `import-sync@${version}`);
    console.log(`Would publish ${label} --tag ${distTag}`);
    return;
  }

  const context = { npmCli: npmCliPath(), registry, version };
  if (await checkPublished(context, artifact)) {
    const status = await verifyPublishedDistTag(context, distTag);
    const suffix =
      status === "superseded"
        ? ` (npm ${distTag} already points to a newer version)`
        : "";
    console.log(
      `${styleText("green", "SKIPPED")} identical import-sync@${version} already published${suffix}`,
    );
    return;
  }
  await verifyPrepublicationDistTag(context, distTag);
  await publishWithRecovery(context, artifact, distTag);
  await verifyPublishedDistTag(context, distTag);
  console.log(
    `${styleText("green", "PUBLISHED")} import-sync@${version} (${distTag})`,
  );
}
