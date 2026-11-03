import { spawnSync } from "node:child_process";
import { expect } from "vitest";

export function runConsumer(
  consumerFile: string,
  root: string,
  options: { flags?: readonly string[]; nodeOptions?: string } = {},
): string {
  const child = spawnSync(
    process.execPath,
    [...(options.flags ?? []), consumerFile],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 8_000,
      ...(options.nodeOptions === undefined
        ? {}
        : { env: { ...process.env, NODE_OPTIONS: options.nodeOptions } }),
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return child.stdout.trim();
}
