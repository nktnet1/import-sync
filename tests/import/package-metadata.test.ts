import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("every declared package entry points to a built file", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8"),
  ) as {
    main: string;
    module?: string;
    types: string;
    exports: Record<string, string>;
  };

  for (const entry of [pkg.main, pkg.module, pkg.types, pkg.exports["."]]) {
    if (entry) {
      expect(existsSync(resolve(projectRoot, entry)), entry).toBe(true);
    }
  }
});
