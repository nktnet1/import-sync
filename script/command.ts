import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

// Invoke npm through Node, including on Windows where npm.cmd cannot be spawned
// directly. Use the npm shipped with this runtime, rather than a PATH shim.
export function npmCliPath(): string {
  const bin = dirname(realpathSync(process.execPath));
  for (const candidate of [
    resolve(bin, "..", "lib/node_modules/npm/bin/npm-cli.js"),
    resolve(bin, "node_modules/npm/bin/npm-cli.js"),
    resolve(bin, "..", "node_modules/npm/bin/npm-cli.js"),
  ]) {
    try {
      const file = realpathSync(candidate);
      if (lstatSync(file).isFile()) return file;
    } catch {
      // Try another supported Node.js installation layout.
    }
  }
  throw new Error("Unable to find npm-cli.js belonging to the running Node.js");
}

export function runNpm(
  args: readonly string[],
  options?: CommandOptions,
): string {
  return runCommand(process.execPath, [npmCliPath(), ...args], options);
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
