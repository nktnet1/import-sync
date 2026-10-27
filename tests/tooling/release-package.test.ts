import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, it } from "vitest";
import { prepareReleasePackage } from "../../script/prepare-release-package.ts";
import {
  inspectReleaseTarball,
  publishReleasePackage,
} from "../../script/release-publisher.ts";

const required = ["dist/index.cjs", "dist/index.d.cts"] as const;

function tempRoot(): string {
  return realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "import-sync-release-")),
  );
}

function createSource(root: string, version = "2.2.7-beta.2"): void {
  for (const name of [...required, "README.md", "LICENSE"]) {
    const filename = path.join(root, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, "fixture\n");
  }
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "import-sync",
      version,
      files: ["dist"],
      private: false,
      esm: true,
      devDependencies: { typescript: "^6.0.3" },
      scripts: {
        prepare: "node script/install-hooks.ts",
        build: "echo build",
        prepublishOnly: "echo unsafe",
      },
    }),
  );
}

// Hand-build a minimal ustar archive: the tests must not depend on npm being
// installed alongside the Node runtime on every operating system in Pipeline.
function archiveEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.fill(32, 148, 156);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

function pack(
  root: string,
  files = [...required, "README.md", "LICENSE", "package.json"],
  outputDirectory = "release-packages",
): string {
  const output = path.join(root, outputDirectory);
  mkdirSync(output);
  const archive = path.join(output, "import-sync-2.2.7-beta.2.tgz");
  const entries = files.map((filename) =>
    archiveEntry(
      `package/${filename}`,
      readFileSync(path.join(root, ".release/package", filename)),
    ),
  );
  writeFileSync(
    archive,
    gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])),
  );
  return archive;
}

function releaseMetadata(root: string, tag: string, sha: string): void {
  mkdirSync(path.join(root, "release-metadata"), { recursive: true });
  writeFileSync(path.join(root, "release-metadata/tag"), `${tag}\n`);
  writeFileSync(path.join(root, "release-metadata/sha"), `${sha}\n`);
}

function taggedCommit(root: string, tag: string): string {
  const hooks = path.join(root, "hooks");
  mkdirSync(hooks);
  function git(args: string[]): string {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Release test",
        "-c",
        "user.email=release-test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        `core.hooksPath=${hooks}`,
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--quiet"]);
  git(["commit", "--allow-empty", "--message", "fixture"]);
  git(["tag", "--annotate", tag, "--message", tag]);
  // A local origin exercises ls-remote and annotated-tag peeling without
  // contacting any external server or publishing a package.
  git(["remote", "add", "origin", "."]);
  return git(["rev-parse", "HEAD"]);
}

describe("release artifact packaging", () => {
  it("stages only published files without development hooks", async () => {
    const root = tempRoot();
    try {
      createSource(root);
      prepareReleasePackage({ root, tag: "v2.2.7-beta.2" });
      const manifest: Record<string, unknown> = JSON.parse(
        readFileSync(path.join(root, ".release/package/package.json"), "utf8"),
      );
      assert.equal(manifest.version, "2.2.7-beta.2");
      assert.ok(!Object.hasOwn(manifest, "scripts"));
      assert.ok(!Object.hasOwn(manifest, "devDependencies"));
      const archive = pack(root);
      assert.equal(
        inspectReleaseTarball(archive).manifest.version,
        "2.2.7-beta.2",
      );
      await publishReleasePackage({
        root,
        tag: "v2.2.7-beta.2",
        registry: "https://registry.npmjs.org",
        dryRun: true,
      });
      await assert.rejects(
        publishReleasePackage({
          root,
          tag: "v2.2.7-beta.3",
          registry: "https://registry.npmjs.org",
          dryRun: true,
        }),
        /Expected import-sync@2\.2\.7-beta\.3/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "LF", newline: "\n" },
    { label: "CRLF", newline: "\r\n" },
  ])(
    "validates the beta tarball in the directory produced by the release workflow ($label)",
    async ({ newline }) => {
      const root = tempRoot();
      try {
        const release = readFileSync(
          new URL("../../.github/workflows/release.yaml", import.meta.url),
          "utf8",
        ).replace(/\r?\n/g, newline);
        const outputDirectory =
          /npm pack \.release\/package --pack-destination (\S+)/.exec(
            release,
          )?.[1];
        assert.ok(
          outputDirectory,
          "Release workflow must specify its npm pack destination",
        );

        createSource(root, "2.3.0-beta.1");
        prepareReleasePackage({ root, tag: "v2.3.0-beta.1" });
        pack(root, undefined, outputDirectory);

        await publishReleasePackage({
          root,
          tag: "v2.3.0-beta.1",
          registry: "https://registry.npmjs.org",
          dryRun: true,
        });
        assert.ok(
          release
            .split(/\r?\n/)
            .some((line) => line.trim() === `path: ${outputDirectory}/*.tgz`),
          "Release upload path must match the pack destination",
        );
        const publish = readFileSync(
          new URL("../../.github/workflows/publish.yaml", import.meta.url),
          "utf8",
        ).replace(/\r?\n/g, newline);
        assert.ok(
          publish
            .split(/\r?\n/)
            .some((line) => line.trim() === `path: ${outputDirectory}`),
          "Publish download path must match the pack destination",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts stable tags for the latest distribution channel", async () => {
    const root = tempRoot();
    try {
      createSource(root, "2.2.7");
      prepareReleasePackage({ root, tag: "v2.2.7" });
      const archive = pack(root);
      assert.equal(inspectReleaseTarball(archive).manifest.version, "2.2.7");
      await publishReleasePackage({
        root,
        tag: "v2.2.7",
        registry: "https://registry.npmjs.org",
        dryRun: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects inconsistent source versions and missing declarations", () => {
    const root = tempRoot();
    try {
      createSource(root);
      assert.throws(
        () => prepareReleasePackage({ root, tag: "v2.2.7" }),
        /Expected/,
      );
      rmSync(path.join(root, required[1]), { force: true });
      assert.throws(
        () => prepareReleasePackage({ root, tag: "v2.2.7-beta.2" }),
        /Missing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mismatched build metadata before opening the registry", async () => {
    const root = tempRoot();
    try {
      createSource(root);
      prepareReleasePackage({ root, tag: "v2.2.7-beta.2" });
      pack(root);
      mkdirSync(path.join(root, "release-metadata"));
      writeFileSync(path.join(root, "release-metadata/tag"), "v2.2.7-beta.2\n");
      writeFileSync(
        path.join(root, "release-metadata/sha"),
        `${"a".repeat(40)}\n`,
      );
      await assert.rejects(
        publishReleasePackage({
          root,
          expectedSha: "b".repeat(40),
          registry: "https://registry.npmjs.org",
          dryRun: true,
        }),
        /does not match the successful build SHA/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies the annotated origin tag against the successful build commit", async () => {
    const root = tempRoot();
    try {
      const tag = "v2.2.7-beta.2";
      createSource(root);
      prepareReleasePackage({ root, tag });
      pack(root);
      const sha = taggedCommit(root, tag);
      releaseMetadata(root, tag, sha);
      await publishReleasePackage({
        root,
        expectedSha: sha,
        registry: "https://registry.npmjs.org",
        dryRun: true,
      });

      const otherSha = "f".repeat(40);
      releaseMetadata(root, tag, otherSha);
      await assert.rejects(
        publishReleasePackage({
          root,
          expectedSha: otherSha,
          registry: "https://registry.npmjs.org",
          dryRun: true,
        }),
        /does not point to the release commit/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "--upload-pack=unexpected",
    "v2.2.7-beta.2 --upload-pack=unexpected",
    "v2.2.7-beta.2\n--upload-pack=unexpected",
    "v2.2.7-beta.2;echo unexpected",
  ])(
    "rejects unsafe release tag metadata %j before invoking Git",
    async (tag) => {
      const root = tempRoot();
      try {
        const sha = "a".repeat(40);
        releaseMetadata(root, tag, sha);
        await assert.rejects(
          publishReleasePackage({
            root,
            expectedSha: sha,
            registry: "https://registry.npmjs.org",
            dryRun: true,
          }),
          /Release tag must start with v|Unsupported release version/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects option-like build SHAs before reading metadata or invoking Git", async () => {
    const root = tempRoot();
    try {
      await assert.rejects(
        publishReleasePackage({
          root,
          expectedSha: "--upload-pack=unexpected",
          registry: "https://registry.npmjs.org",
          dryRun: true,
        }),
        /Invalid expected build SHA/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects archives missing a required public entry", () => {
    const root = tempRoot();
    try {
      createSource(root);
      prepareReleasePackage({ root, tag: "v2.2.7-beta.2" });
      const archive = pack(root, [
        ...required.filter((name) => name !== "dist/index.cjs"),
        "README.md",
        "LICENSE",
        "package.json",
      ]);
      assert.throws(() => inspectReleaseTarball(archive), /dist\/index\.cjs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked release inputs", () => {
    const root = tempRoot();
    try {
      createSource(root);
      const declarations = path.join(root, required[1]);
      rmSync(declarations);
      symlinkSync(path.join(root, "README.md"), declarations);
      assert.throws(
        () => prepareReleasePackage({ root, tag: "v2.2.7-beta.2" }),
        /regular file/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tampered package archives", () => {
    const root = tempRoot();
    try {
      createSource(root);
      prepareReleasePackage({ root, tag: "v2.2.7-beta.2" });
      const archive = pack(root);
      const bytes = readFileSync(archive);
      const offset = bytes.length - 10;
      bytes.writeUInt8(bytes.readUInt8(offset) ^ 0xff, offset);
      writeFileSync(archive, bytes);
      assert.throws(() => inspectReleaseTarball(archive));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
