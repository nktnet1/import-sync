import { type ChildProcess, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, styleText } from "node:util";
import { runCommand, runNpm } from "./command.ts";
import { prepareReleasePackage } from "./prepare-release-package.ts";
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
  if (!["both", "cjs", "esm"].includes(values.format))
    throw new Error("--format must be both, cjs or esm");
  const formats = values.format === "both" ? ["cjs", "esm"] : [values.format];
  // Verdaccio is a pinned development dependency: running this test never
  // downloads tooling or falls back to an unpinned npx installation.
  const verdaccioModule = createRequire(import.meta.url).resolve("verdaccio");
  const manifest: { name: string; version: string } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const { distTag } = parseReleaseVersion(manifest.version);
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
      delete env[key];
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
  let activeStage = "initialisation";

  function stage<T>(name: string, action: () => T): T {
    activeStage = name;
    console.log(`Checking ${styleText("cyan", name)}...`);
    return action();
  }

  try {
    await fs.mkdir(registryRoot);
    await fs.writeFile(npmrc, "");
    await fs.writeFile(globalNpmrc, "");
    stage("build", () => runNpm(["run", "build"], { ...command, cwd: root }));
    stage("package", () => {
      prepareReleasePackage({ root, tag: `v${manifest.version}` });
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
    });
    const tarballs = (await fs.readdir(temporary)).filter((file) =>
      file.endsWith(".tgz"),
    );
    if (tarballs.length !== 1)
      throw new Error("Expected exactly one packed release");
    const tarball = path.join(temporary, tarballs[0]);
    inspectReleaseTarball(tarball);

    activeStage = "registry startup";
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
    const registry = await registryReady(child);
    console.log(`Started ${styleText("cyan", "Verdaccio")} at ${registry}`);

    activeStage = "authentication";
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
    stage("publish", () =>
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

    activeStage = "published metadata";
    const response = await fetch(
      `${registry}/${encodeURIComponent(manifest.name)}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    const metadata = (await response.json()) as {
      "dist-tags"?: Record<string, string>;
    };
    if (!response.ok || metadata["dist-tags"]?.[distTag] !== manifest.version)
      throw new Error(
        `Published ${distTag} tag does not match ${manifest.version}`,
      );

    for (const format of formats) {
      const consumer = path.join(temporary, `consumer-${format}`);
      await fs.cp(path.join(root, "tests/packed"), consumer, {
        recursive: true,
      });
      await fs.writeFile(
        path.join(consumer, "package.json"),
        JSON.stringify({
          name: `import-sync-consumer-${format}`,
          private: true,
          type: format === "cjs" ? "commonjs" : "module",
        }),
      );
      stage(`${format.toUpperCase()} install`, () =>
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
      const installed: { name: string; version: string; scripts?: unknown } =
        JSON.parse(
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
        throw new Error("Installed package does not match the staged release");
      // .js inherits the consumer's type, exercising both actual project modes.
      await fs.copyFile(
        path.join(consumer, `check.${format === "cjs" ? "cjs" : "mjs"}`),
        path.join(consumer, "check.js"),
      );
      stage(`${format.toUpperCase()} imports`, () =>
        runCommand(process.execPath, ["check.js"], {
          ...command,
          cwd: consumer,
        }),
      );
    }
    console.log(
      `${styleText("green", "PASS")} published package verified in ${formats.length} isolated consumers`,
    );
  } catch (error) {
    console.error(`${styleText("red", "FAIL")} during ${activeStage}`);
    if (registryLog)
      console.error(`Registry log (last 16 KB):\n${registryLog}`);
    throw error;
  } finally {
    try {
      await stopRegistry(child);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  runRegistryTest().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
