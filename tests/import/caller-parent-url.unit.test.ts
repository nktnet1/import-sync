import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  factory: vi.fn(),
  load: vi.fn(),
}));

vi.mock("#/files.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/files.ts")>()),
  getCallerLocation: mocks.caller,
}));
vi.mock("esm-sync", () => ({ default: mocks.factory }));

import importSync from "#/import.ts";

test("resolves a package with native require conditions when the ESM caller has a URL suffix", () => {
  const filename = realpathSync(fileURLToPath(import.meta.url));
  mocks.caller.mockReturnValue({
    filename,
    parentURL: `${pathToFileURL(filename).href}?caller=1`,
  });
  const value = { from: "loader" };
  mocks.load.mockReturnValue(value);
  mocks.factory.mockReturnValue(mocks.load);

  expect(importSync("node-fetch")).toBe(value);
  expect(mocks.caller).toHaveBeenCalledOnce();
  expect(mocks.load).toHaveBeenCalledOnce();
});
