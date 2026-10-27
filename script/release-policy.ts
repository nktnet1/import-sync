const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

export type ReleaseVersion = {
  version: string;
  base: string;
  beta: string | undefined;
  distTag: "latest" | "beta";
};

export function parseReleaseVersion(version: string): ReleaseVersion {
  const match = versionPattern.exec(version);
  if (match?.[0] !== version)
    throw new Error(`Unsupported release version: ${version}`);
  return {
    version,
    base: `${match[1]}.${match[2]}.${match[3]}`,
    beta: match[4],
    distTag: match[4] === undefined ? "latest" : "beta",
  };
}

export function versionFromTag(tag: string): ReleaseVersion {
  if (!tag.startsWith("v"))
    throw new Error(`Release tag must start with v: ${tag}`);
  return parseReleaseVersion(tag.slice(1));
}

export function compareReleaseBases(left: string, right: string): number {
  const leftParts = parseReleaseVersion(left).base.split(".").map(BigInt);
  const rightParts = parseReleaseVersion(right).base.split(".").map(BigInt);
  for (const [index, leftPart] of leftParts.entries()) {
    const rightPart = rightParts[index];
    if (rightPart === undefined)
      throw new Error("Invalid release base components");
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function knownReleases(versions: readonly string[]): ReleaseVersion[] {
  return versions.flatMap((version) => {
    try {
      return [parseReleaseVersion(version)];
    } catch {
      return [];
    }
  });
}

function requireUnreleasedBase(
  base: string,
  existing: readonly ReleaseVersion[],
): void {
  for (const candidate of existing) {
    if (candidate.beta !== undefined) continue;
    if (compareReleaseBases(candidate.base, base) > 0)
      throw new Error(
        `A newer stable version (${candidate.base}) is already released`,
      );
    if (candidate.base === base)
      throw new Error(
        `${base} is already released; choose a new base explicitly with --base <version>`,
      );
  }
}

export function nextBetaVersion(
  current: string,
  published: readonly string[],
  tags: readonly string[],
  requestedBase?: string,
): string {
  const currentRelease = parseReleaseVersion(current);
  const base = requestedBase
    ? parseReleaseVersion(requestedBase.replace(/^v/, ""))
    : parseReleaseVersion(currentRelease.base);
  if (base.beta !== undefined)
    throw new Error("--base must be a stable version");
  if (compareReleaseBases(base.base, currentRelease.base) < 0)
    throw new Error(
      "--base cannot be earlier than the current package version",
    );

  const existing = knownReleases([
    ...published,
    ...tags.map((tag) => tag.replace(/^v/, "")),
  ]);
  requireUnreleasedBase(base.base, existing);

  let highest = 0n;
  for (const candidate of [currentRelease, ...existing]) {
    if (candidate.base === base.base && candidate.beta !== undefined) {
      const number = BigInt(candidate.beta);
      if (number > highest) highest = number;
    }
  }
  return `${base.base}-beta.${highest + 1n}`;
}

export function validateReleaseManifest(
  manifest: Record<string, unknown>,
  tag: string,
): string {
  const { version } = versionFromTag(tag);
  if (manifest.name !== "import-sync" || manifest.version !== version)
    throw new Error(
      `Expected import-sync@${version} in the release package manifest`,
    );
  return version;
}
