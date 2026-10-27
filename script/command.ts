import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
}

export function runCommand(
  command: string,
  args: readonly string[],
  { cwd, env, inherit = false }: CommandOptions = {},
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args[0] ?? ""} failed (${result.signal ?? result.status}): ${result.stderr ?? ""}${result.stdout ?? ""}`,
    );
  return result.stdout ?? "";
}

function npmLocations(bin: string): string[] {
  return [
    resolve(bin, "..", "lib/node_modules/npm/bin/npm-cli.js"),
    resolve(bin, "node_modules/npm/bin/npm-cli.js"),
    resolve(bin, "..", "node_modules/npm/bin/npm-cli.js"),
  ];
}

function installedNpmCli(candidate: string): string | undefined {
  try {
    const file = realpathSync(candidate);
    if (basename(file) !== "npm-cli.js" || !lstatSync(file).isFile())
      return undefined;
    const manifest: { name?: unknown; bin?: { npm?: unknown } } = JSON.parse(
      readFileSync(resolve(dirname(file), "../package.json"), "utf8"),
    );
    if (
      manifest.name === "npm" &&
      typeof manifest.bin?.npm === "string" &&
      realpathSync(resolve(dirname(file), "..", manifest.bin.npm)) === file
    )
      return file;
  } catch {
    // Ignore missing installations, wrappers and unrelated executables.
  }
  return undefined;
}

// Invoke the actual npm CLI with the current Node, never a shell or npm.cmd.
// pnpm-managed runtimes omit npm, so also support a separate npm installation.
export function npmCliPath({
  execPath = process.execPath,
  env = process.env,
}: {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const bin = dirname(realpathSync(execPath));
  const hint = env.npm_execpath;
  const search = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(isAbsolute);
  const candidates = [
    ...npmLocations(bin),
    ...(hint && isAbsolute(hint) ? [hint] : []),
    ...search.flatMap((directory) => [
      resolve(directory, "npm"),
      ...npmLocations(directory),
    ]),
  ];
  for (const candidate of candidates) {
    const file = installedNpmCli(candidate);
    if (file) return file;
  }
  throw new Error(
    "Unable to find npm-cli.js; install Node.js with npm (CI uses actions/setup-node)",
  );
}

// Git is an OS tool, not a project dependency. Do not search PATH, which npm
// and pnpm prepend with project-writable node_modules/.bin directories.
export function gitExecutable(): string {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.ProgramW6432,
          process.env.ProgramFiles,
          process.env["ProgramFiles(x86)"],
        ]
          .filter(
            (directory): directory is string =>
              typeof directory === "string" && isAbsolute(directory),
          )
          .flatMap((directory) => [
            resolve(directory, "Git/cmd/git.exe"),
            resolve(directory, "Git/bin/git.exe"),
          ])
      : [
          "/usr/bin/git",
          "/bin/git",
          "/usr/local/bin/git",
          "/opt/homebrew/bin/git",
          "/opt/local/bin/git",
        ];
  for (const candidate of candidates) {
    try {
      const file = realpathSync(candidate);
      if (!lstatSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Try another standard OS installation directory.
    }
  }
  throw new Error("Unable to find Git in a standard OS installation directory");
}

export function runNpm(
  args: readonly string[],
  options?: CommandOptions,
): string {
  return runCommand(
    process.execPath,
    [npmCliPath({ env: options?.env }), ...args],
    options,
  );
}

export function runPnpm(
  args: readonly string[],
  options?: CommandOptions,
): string {
  const cli = process.env.npm_execpath;
  if (cli && /(?:^|[/\\])pnpm(?:\.(?:cjs|mjs|js|exe))?$/.test(cli)) {
    return /\.(?:cjs|mjs|js)$/.test(cli)
      ? runCommand(process.execPath, [cli, ...args], options)
      : runCommand(cli, args, options);
  }
  return runCommand("pnpm", args, options);
}
