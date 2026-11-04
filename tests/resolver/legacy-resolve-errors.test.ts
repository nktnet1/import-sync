import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { resolveLegacyImport } from "#/legacy-resolve.ts";
import { withTemporaryDirectory } from "../helpers/fixtures.ts";

vi.mock("node:module", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:module")>();
  return {
    ...native,
    createRequire: (filename: string | URL) => {
      const resolver = native.createRequire(filename);
      const original = resolver.resolve;
      resolver.resolve = Object.assign(
        (specifier: string, options?: NodeJS.RequireResolveOptions) => {
          if (specifier === "blocked-package") {
            throw Object.assign(new Error("resolver rejected the lookup"), {
              code: "ERR_ACCESS_DENIED",
            });
          }
          return original(specifier, options);
        },
        {
          paths: (name: string) =>
            name === "null-paths" ? null : original.paths(name),
        },
      );
      return resolver;
    },
  };
});

test("does not hide non-missing resolver errors in the no-manifest fallback", () => {
  withTemporaryDirectory("import-sync-legacy-errors-", (root) => {
    expect(() =>
      resolveLegacyImport(
        "blocked-package",
        join(root, "consumer.cjs"),
        new Set(["import", "node", "default"]),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "ERR_ACCESS_DENIED",
        message: "resolver rejected the lookup",
      }),
    );
  });
});

test("handles a resolver with no package lookup paths", () => {
  withTemporaryDirectory("import-sync-legacy-null-paths-", (root) => {
    expect(() =>
      resolveLegacyImport(
        "null-paths",
        join(root, "consumer.cjs"),
        new Set(["import", "node", "default"]),
      ),
    ).toThrowError(expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }));
  });
});
