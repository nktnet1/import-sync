import { type ChildProcess, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runCommand, runNpm } from "./command.ts";
import { prepareReleasePackage } from "./prepare-release-package.ts";
import {
  consumerFormats,
  createRegistryReporter,
  formatName,
  moduleFormats,
} from "./registry-reporter.ts";
import { parseReleaseVersion } from "./release-policy.ts";
import { inspectReleaseTarball } from "./release-publisher.ts";

const root = await fs.realpath(path.resolve(import.meta.dirname, ".."));

export function registryReady(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Verdaccio startup timed out")),
      30_000,
    );
    function finish(error?: Error, port?: number): void {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve(`http://127.0.0.1:${port}`);
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      finish(new Error(`Verdaccio exited before startup (${signal ?? code})`));
    }
    function onMessage(message: unknown): void {
      if (
        typeof message === "object" &&
        message !== null &&
        "port" in message &&
        typeof message.port === "number" &&
        Number.isInteger(message.port) &&
        message.port > 0 &&
        message.port < 65536
      )
        finish(undefined, message.port);
    }
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

export async function stopRegistry(
  child: ChildProcess | undefined,
): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  child.kill("SIGTERM");
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

export async function runRegistryTest(
  args = process.argv.slice(2),
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      format: { type: "string", default: "both" },
      verbose: { type: "boolean", default: false },
    },
  });
  const formats = consumerFormats(values.format);
  const manifest: { name: string; version: string } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const { distTag } = parseReleaseVersion(manifest.version);
  const report = createRegistryReporter(formats, values.verbose);
  report.header(manifest.name, manifest.version);
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "import-sync-registry-")),
  );
  const registryRoot = path.join(temporary, "registry");
  const npmrc = path.join(temporary, ".npmrc");
  const globalNpmrc = path.join(temporary, "global.npmrc");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^npm_config_/i.test(key) ||
      [
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
        "NODE_PATH",
        "NODE_OPTIONS",
        "ESM_OPTIONS",
        "ESM_ENV",
        "ESM_DISABLE_CACHE",
        "ESM_SYNC_TEST_BUILD",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        "ACTIONS_ID_TOKEN_REQUEST_URL",
      ].includes(key)
    )
      Reflect.deleteProperty(env, key);
  }
  Object.assign(env, {
    NODE_ENV: "production",
    PATH:
      path.dirname(process.execPath) +
      path.delimiter +
      (process.env.PATH ?? ""),
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    NPM_CONFIG_CACHE: path.join(temporary, "npm-cache"),
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_PROVENANCE: "false",
    NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"]
      .filter(Boolean)
      .join(","),
  });
  const command = { env, cwd: temporary, inherit: values.verbose };
  let child: ChildProcess | undefined;
  let registryLog = "";
  let failure: Error | undefined;

  try {
    report.section("PACKAGE & REGISTRY", "Prepare, pack, and publish");
    // Resolve installed tooling before starting work; never download an
    // unpinned registry or fall back to an npx installation.
    const verdaccioModule = await report.stage(
      "TOOLS",
      "Locate installed Verdaccio",
      () => createRequire(import.meta.url).resolve("verdaccio"),
    );
    await fs.mkdir(registryRoot);
    await fs.writeFile(npmrc, "");
    await fs.writeFile(globalNpmrc, "");
    await report.stage(
      "BUILD",
      `Compile ${manifest.name}@${manifest.version}`,
      () => runNpm(["run", "build"], { ...command, cwd: root }),
    );
    const tarball = await report.stage(
      "PACK",
      "Stage and validate the release tarball",
      async () => {
        prepareReleasePackage({
          root,
          tag: `v${manifest.version}`,
          quiet: !values.verbose,
        });
        runNpm(
          [
            "pack",
            ".release/package",
            "--pack-destination",
            temporary,
            "--ignore-scripts",
          ],
          { ...command, cwd: root },
        );
        const tarballs = (await fs.readdir(temporary)).filter((file) =>
          file.endsWith(".tgz"),
        );
        if (tarballs.length !== 1)
          throw new Error("Expected exactly one packed release");
        const file = path.join(temporary, tarballs[0]);
        inspectReleaseTarball(file);
        return file;
      },
    );

    const registry = await report.stage(
      "REGISTRY",
      "Start temporary local registry",
      async () => {
        const configPath = path.join(registryRoot, "config.json");
        await fs.writeFile(
          configPath,
          JSON.stringify({
            storage: path.join(registryRoot, "storage"),
            auth: {
              htpasswd: {
                file: path.join(registryRoot, "htpasswd"),
                max_users: 10,
              },
            },
            uplinks: { npmjs: { url: "https://registry.npmjs.org/" } },
            packages: {
              [manifest.name]: { access: "$all", publish: "$authenticated" },
              "**": { access: "$all", proxy: "npmjs" },
            },
            log: { type: "stdout", format: "pretty", level: "warn" },
          }),
        );
        const serverPath = path.join(registryRoot, "server.cjs");
        await fs.writeFile(
          serverPath,
          `const { runServer } = require(process.argv[2]);
runServer(process.argv[3]).then((app) => {
  const server = app.listen(0, '127.0.0.1', () => {
    process.send({ port: server.address().port });
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('disconnect', shutdown);
}).catch((error) => { console.error(error); process.exit(1); });
`,
        );
        child = fork(serverPath, [verdaccioModule, configPath], {
          cwd: registryRoot,
          env,
          execPath: process.execPath,
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        for (const stream of [child.stdout, child.stderr]) {
          stream?.setEncoding("utf8").on("data", (chunk: string) => {
            registryLog = (registryLog + chunk).slice(-16_000);
            if (values.verbose) process.stderr.write(chunk);
          });
        }
        return registryReady(child);
      },
    );

    await report.stage(
      "AUTH",
      "Create temporary publisher credentials",
      async () => {
        const username = "import-sync-smoke";
        const login = await fetch(
          `${registry}/-/user/org.couchdb.user:${username}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: username,
              password: randomBytes(24).toString("base64url"),
              email: "smoke@example.invalid",
              type: "user",
              roles: [],
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const credentials: unknown = await login.json();
        if (
          !login.ok ||
          typeof credentials !== "object" ||
          credentials === null ||
          !("token" in credentials) ||
          typeof credentials.token !== "string"
        )
          throw new Error(
            `Unable to authenticate temporary Verdaccio user (${login.status})`,
          );
        await fs.writeFile(
          npmrc,
          `registry=${registry}/\n//${new URL(registry).host}/:_authToken=${credentials.token}\n`,
        );
        env.NPM_CONFIG_REGISTRY = registry;
      },
    );
    await report.stage(
      "PUBLISH",
      `Publish ${manifest.name}@${manifest.version} to Verdaccio`,
      () =>
        runNpm(
          [
            "publish",
            tarball,
            "--ignore-scripts",
            "--registry",
            registry,
            "--tag",
            distTag,
          ],
          command,
        ),
    );
    await report.stage(
      "VERIFY",
      `Check published version and ${distTag} dist-tag`,
      async () => {
        const response = await fetch(
          `${registry}/${encodeURIComponent(manifest.name)}`,
          {
            signal: AbortSignal.timeout(10_000),
          },
        );
        const metadata = (await response.json()) as {
          "dist-tags"?: Record<string, string>;
        };
        if (
          !response.ok ||
          metadata["dist-tags"]?.[distTag] !== manifest.version
        )
          throw new Error(
            `Published ${distTag} tag does not match ${manifest.version}`,
          );
      },
    );

    for (const project of formats) {
      const consumer = path.join(temporary, `consumer-${project}`);
      const label = project.toUpperCase();
      report.section(
        `${formatName(project)} PROJECT`,
        `type: "${project === "cjs" ? "commonjs" : "module"}"`,
      );
      await report.stage(
        label,
        "Create isolated consumer project",
        async () => {
          await fs.cp(path.join(root, "tests/packed"), consumer, {
            recursive: true,
          });
          await fs.writeFile(
            path.join(consumer, "package.json"),
            JSON.stringify({
              name: `import-sync-consumer-${project}`,
              private: true,
              type: project === "cjs" ? "commonjs" : "module",
            }),
          );
          // .js inherits the project's type; the two import pairs are run in
          // separate Node processes and receive separate PASS/FAIL results.
          await fs.copyFile(
            path.join(consumer, `check.${project === "cjs" ? "cjs" : "mjs"}`),
            path.join(consumer, "check.js"),
          );
        },
      );
      await report.stage(
        label,
        "Install the published package and its runtime dependencies",
        () =>
          runNpm(
            [
              "install",
              `${manifest.name}@${manifest.version}`,
              "--registry",
              registry,
              "--ignore-scripts=false",
              "--foreground-scripts",
              "--package-lock=false",
              "--no-audit",
              "--no-fund",
            ],
            { ...command, cwd: consumer },
          ),
      );
      await report.stage(
        "VERIFY",
        "Check installed release files",
        async () => {
          const installed: {
            name: string;
            version: string;
            scripts?: unknown;
          } = JSON.parse(
            await fs.readFile(
              path.join(consumer, "node_modules/import-sync/package.json"),
              "utf8",
            ),
          );
          if (
            installed.name !== manifest.name ||
            installed.version !== manifest.version ||
            installed.scripts
          )
            throw new Error(
              "Installed package does not match the staged release",
            );
          for (const file of ["dist/index.cjs", "dist/index.d.cts"]) {
            const stats = await fs.stat(
              path.join(consumer, "node_modules/import-sync", file),
            );
            if (!stats.isFile() || stats.size === 0)
              throw new Error(`Missing or empty installed file: ${file}`);
          }
        },
      );
      for (const target of moduleFormats) {
        await report.check(project, target, () =>
          report.stage(
            "TEST",
            `${formatName(project)} project importing ${formatName(target)} module`,
            () =>
              runCommand(process.execPath, ["check.js", target], {
                ...command,
                cwd: consumer,
              }),
          ),
        );
      }
      await report.check(project, "compatibility", () =>
        report.stage(
          "CHECK",
          "Extension lookup, basePath, and missing-file errors",
          () =>
            runCommand(process.execPath, ["check.js", "compatibility"], {
              ...command,
              cwd: consumer,
            }),
        ),
      );
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (registryLog)
      console.error(`Registry log (last 16 KB):\n${registryLog}`);
  } finally {
    report.section("CLEANUP", "Stop registry and remove temporary projects");
    try {
      await report.stage(
        "CLEANUP",
        "Stop Verdaccio and remove temporary workspace",
        async () => {
          try {
            await stopRegistry(child);
          } finally {
            await fs.rm(temporary, { recursive: true, force: true });
          }
        },
      );
    } catch (error) {
      const cleanupFailure =
        error instanceof Error ? error : new Error(String(error));
      failure = failure
        ? new AggregateError(
            [failure, cleanupFailure],
            "Registry test and cleanup failed",
          )
        : cleanupFailure;
    }
    report.summary(failure === undefined);
  }
  if (failure) throw failure;
}

if (import.meta.main) {
  runRegistryTest().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
